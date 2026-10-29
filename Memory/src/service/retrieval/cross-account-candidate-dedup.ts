import type { SeededChannelScores } from "../../algorithm/plugin-algorithms.js";
import type { Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { createHash } from "node:crypto";
import { isRecord } from "../../utils/json.js";
import { stableHash } from "../../utils/id.js";
import { isLocalWorkspaceUri, sha256Hex } from "../../contracts/index.js";

export type RecallSourceResolver = (memory: MemoryRow) => string | undefined;

/** Request-local, verified aliases only. Sessions alone never establish a memory's origin. */
export function createRecallSourceResolver(repos: Repositories): RecallSourceResolver {
  const scopes = new Map<string, Map<string, string | undefined>>();
  const canonicalScope = (source: string, profile: string, namespace: string, tenantId: string | null): string => {
    const key = JSON.stringify([source, profile, tenantId]);
    if (!scopes.has(key)) {
      const aliases = new Map<string, string | undefined>();
      const rows = repos.db.prepare(`SELECT user_id,project_id,workspace_id,meta_json FROM sessions
        WHERE source=? AND profile_id=? ORDER BY id LIMIT 2049`).all(source, profile) as
        Array<{user_id: string; project_id: string | null; workspace_id: string | null; meta_json: string}>;
      // Incomplete evidence must not turn an ambiguous historical scope into a proven alias.
      if (rows.length <= 2048) for (const row of rows) {
        const meta: unknown = JSON.parse(row.meta_json);
        if (!isRecord(meta) || typeof meta.workspace_uri !== "string") continue;
        const uri = meta.workspace_uri;
        const local = isLocalWorkspaceUri(uri);
        if (local && typeof meta.workspace_host_id !== "string") continue;
        const identity = local ? `local\0${meta.workspace_host_id}\0${uri}` : `remote\0${uri}`;
        const hashes = [sha256Hex(`${row.user_id}\0${identity}`), sha256Hex(identity)];
        if (!hashes.some(hash => row.project_id === `ws_${hash}` && row.workspace_id === hash)) continue;
        // A tenant hint is useful only if its complete namespace hash also matches.
        const old = stableHash({tenantId, projectId: row.project_id, workspaceId: row.workspace_id});
        const canonical = JSON.stringify({workspace: identity, tenantId});
        if (!aliases.has(old)) aliases.set(old, canonical);
        else if (aliases.get(old) !== canonical) aliases.set(old, undefined);
      }
      scopes.set(key, aliases);
    }
    return scopes.get(key)!.get(namespace) ?? namespace;
  };
  return memory => sourceKey(memory, repos, canonicalScope);
}

export interface CrossAccountCandidateDedupResult {
  memories: MemoryRow[];
  channelScoresByMemory: ReadonlyMap<string, SeededChannelScores>;
  memoryIdByMemoryId: ReadonlyMap<string, string>;
  groupKeyByMemoryId: ReadonlyMap<string, string>;
}

/**
 * Collapse copies of the same locally sourced memory before ranking. Account IDs
 * identify the write owner, but the same native source turn can have been written
 * under more than one account before cross-account capture deduplication existed.
 */
export function deduplicateCrossAccountMemoryCandidates(input: {
  memories: readonly MemoryRow[];
  repos: Repositories;
  /** Compatibility argument only. Account preference never selects a recall representative. */
  preferredUserId?: string | null;
  channelScoresByMemory?: ReadonlyMap<string, SeededChannelScores>;
  resolveSourceKey?: RecallSourceResolver;
}): CrossAccountCandidateDedupResult {
  const groups = new Map<string, { firstIndex: number; memories: MemoryRow[] }>();
  const groupKeyByMemoryId = new Map<string, string>();
  const resolve = input.resolveSourceKey ?? createRecallSourceResolver(input.repos);
  input.memories.forEach((memory, index) => {
    const key = resolve(memory);
    groupKeyByMemoryId.set(memory.id, key ?? `id:${memory.id}`);
    if (!key) {
      const idKey = `id:${memory.id}`;
      if (!groups.has(idKey)) groups.set(idKey, { firstIndex: index, memories: [memory] });
      return;
    }
    const group = groups.get(key);
    if (group) group.memories.push(memory);
    else groups.set(key, { firstIndex: index, memories: [memory] });
  });

  const selected = [...groups.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((group) => {
      const representative = [...group.memories].sort((left, right) =>
        candidateScore(right, input.channelScoresByMemory) - candidateScore(left, input.channelScoresByMemory) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      )[0]!;
      return { representative, members: group.memories };
    });

  const channelScoresByMemory = new Map<string, SeededChannelScores>();
  const memoryIdByMemoryId = new Map<string, string>();
  for (const group of selected) {
    if (group.members.length === 1) {
      const memory = group.representative;
      memoryIdByMemoryId.set(memory.id, memory.id);
      const scores = input.channelScoresByMemory?.get(memory.id);
      if (scores) channelScoresByMemory.set(memory.id, scores);
      continue;
    }

    const merged: SeededChannelScores = {};
    for (const memory of group.members) {
      memoryIdByMemoryId.set(memory.id, group.representative.id);
      // A hit for a different body/version cannot supply evidence for this representative.
      if (!sameRecallContent(memory, group.representative)) continue;
      // Keep each row's own vector/model provenance; only verified channel evidence is merged.
      for (const [channel, score] of Object.entries(input.channelScoresByMemory?.get(memory.id) ?? {})) {
        const key = channel as keyof SeededChannelScores;
        const current = merged[key];
        if (typeof score === "number" && (current === undefined || score > current)) {
          merged[key] = score;
        }
      }
    }
    if (Object.keys(merged).length > 0) channelScoresByMemory.set(group.representative.id, merged);
  }

  return {
    memories: selected.map((group) => group.representative),
    channelScoresByMemory,
    memoryIdByMemoryId,
    groupKeyByMemoryId
  };
}

/** Read-only provenance: never reconstruct an old origin from mutable Session scope. */
export function recallSourceKey(memory: MemoryRow, repos: Repositories): string | undefined {
  return createRecallSourceResolver(repos)(memory);
}

function sourceKey(memory: MemoryRow, repos: Repositories,
  canonicalScope: (source: string, profile: string, namespace: string, tenantId: string | null) => string): string | undefined {
  const internal = memory.properties.internal_info;
  if (memory.memoryLayer !== "L1" || (internal.memory_kind ?? "trace") !== "trace") return undefined;
  const trace = isRecord(internal.trace) ? internal.trace : undefined;
  const turnId = text(memory.info.turn_id) ?? text(trace?.turn_id);
  if (!turnId) return undefined;
  let origin: unknown = memory.info.native_origin_v1;
  const rawId = text(memory.info.raw_turn_id) ?? text(trace?.raw_turn_id);
  if (!Object.hasOwn(memory.info, "native_origin_v1") && rawId) {
    const raw = repos.db.prepare("SELECT message_payload_json FROM raw_turns WHERE id=? AND turn_id=? AND deleted_at IS NULL")
      .get(rawId, turnId) as {message_payload_json: string} | undefined;
    if (raw) {
      const payload: unknown = JSON.parse(raw.message_payload_json);
      if (isRecord(payload)) origin = payload.native_origin_v1;
    }
  }
  let source: unknown;
  if (isRecord(origin)) {
    if (origin.version !== 1 || !text(origin.source) || !text(origin.profileId) || !text(origin.conversationId)) return undefined;
    for (const key of ["projectId", "workspaceId", "tenantId", "namespaceKey"]) {
      if (origin[key] !== null && typeof origin[key] !== "string") return undefined;
    }
    const namespace = stableHash({tenantId: origin.tenantId, projectId: origin.projectId, workspaceId: origin.workspaceId});
    if (origin.namespaceKey !== null && origin.namespaceKey !== namespace) return undefined;
    const canonical = canonicalScope(origin.source as string, origin.profileId as string, namespace, origin.tenantId as string | null);
    source = {source: origin.source, profileId: origin.profileId, conversationId: origin.conversationId,
      scope: canonical};
  } else {
    if (Object.hasOwn(memory.info, "native_origin_v1")) return undefined;
    // UID is provenance, not a read boundary. Require an exact durable memory/raw link.
    const captures = repos.db.prepare(`SELECT DISTINCT source,profile_id,conversation_id,namespace_key
      FROM source_turn_captures WHERE turn_id=? AND
      ((? IS NOT NULL AND raw_turn_id=?) OR json_extract(response_json,'$.legacyImportMemoryId')=?
       OR EXISTS(SELECT 1 FROM json_each(response_json,'$.result.l1MemoryIds') WHERE value=?)) LIMIT 65`)
      .all(turnId, rawId ?? null, rawId ?? null, memory.id, memory.id) as
      Array<{source: string; profile_id: string; conversation_id: string; namespace_key: string}>;
    if (captures.length === 0 || captures.length > 64) return undefined;
    const identities = new Map(captures.map(row => {
      const tenant = text(memory.info.tenant_id) ?? text(memory.info.tenantId) ?? null;
      const value = {source: row.source, profileId: row.profile_id, conversationId: row.conversation_id,
        scope: canonicalScope(row.source, row.profile_id, row.namespace_key, tenant)};
      return [JSON.stringify(value), value];
    }));
    if (identities.size !== 1) return undefined;
    source = [...identities.values()][0];
  }
  const step = typeof trace?.step_index === "number" && Number.isInteger(trace.step_index) && trace.step_index >= 0
    ? trace.step_index : {body: memory.memoryValue, hash: memory.contentHash ?? null};
  return `recall:${createHash("sha256").update(JSON.stringify({source, turnId, step,
    kind: internal.memory_kind ?? "trace", unitVersion: trace?.unit_version ?? null,
    subStepTotal: trace?.sub_step_total ?? null})).digest("hex")}`;
}

export function sameRecallContent(left: MemoryRow, right: MemoryRow): boolean {
  const relevant = (memory: MemoryRow) => {
    const rawTrace = memory.properties.internal_info.trace;
    const trace = isRecord(rawTrace) ? rawTrace : undefined;
    return [memory.memoryValue, memory.contentHash ?? null, memory.tags,
      trace?.summary, trace?.userText, trace?.agentText, trace?.tool_calls, trace?.reflection,
      trace?.error_signatures, memory.info.summary, memory.info.tags, memory.properties.tags];
  };
  return JSON.stringify(relevant(left)) === JSON.stringify(relevant(right));
}

function candidateScore(memory: MemoryRow, scores?: ReadonlyMap<string, SeededChannelScores>): number {
  return Math.max(0, ...Object.values(scores?.get(memory.id) ?? {}).filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value)
  ));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
