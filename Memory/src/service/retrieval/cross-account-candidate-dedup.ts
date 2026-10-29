import type { SeededChannelScores } from "../../algorithm/plugin-algorithms.js";
import type { Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { createHash } from "node:crypto";
import { isRecord } from "../../utils/json.js";

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
}): CrossAccountCandidateDedupResult {
  const groups = new Map<string, { firstIndex: number; memories: MemoryRow[] }>();
  const groupKeyByMemoryId = new Map<string, string>();
  input.memories.forEach((memory, index) => {
    const key = recallSourceKey(memory, input.repos);
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
  const internal = memory.properties.internal_info;
  if (memory.memoryLayer !== "L1" || (internal.memory_kind ?? "trace") !== "trace") return undefined;
  const trace = isRecord(internal.trace) ? internal.trace : undefined;
  const turnId = text(memory.info.turn_id) ?? text(trace?.turn_id);
  if (!turnId) return undefined;
  let origin: unknown = memory.info.native_origin_v1;
  const rawId = text(memory.info.raw_turn_id) ?? text(trace?.raw_turn_id);
  if (!Object.hasOwn(memory.info, "native_origin_v1") && rawId) {
    const raw = repos.db.prepare("SELECT message_payload_json FROM raw_turns WHERE id=? AND user_id=?")
      .get(rawId, memory.userId) as {message_payload_json: string} | undefined;
    if (raw) origin = (JSON.parse(raw.message_payload_json) as Record<string, unknown>).native_origin_v1;
  }
  let source: unknown;
  if (isRecord(origin)) {
    if (origin.version !== 1 || !text(origin.source) || !text(origin.profileId) || !text(origin.conversationId)) return undefined;
    for (const key of ["projectId", "workspaceId", "tenantId", "namespaceKey"]) {
      if (origin[key] !== null && typeof origin[key] !== "string") return undefined;
    }
    source = {source: origin.source, profileId: origin.profileId, conversationId: origin.conversationId,
      scope: {projectId: origin.projectId, workspaceId: origin.workspaceId, tenantId: origin.tenantId, namespaceKey: origin.namespaceKey}};
  } else {
    if (Object.hasOwn(memory.info, "native_origin_v1")) return undefined;
    // Capture must durably refer to this exact memory/raw turn, under its original owner.
    const captures = repos.db.prepare(`SELECT DISTINCT source,profile_id,conversation_id,namespace_key
      FROM source_turn_captures WHERE user_id=? AND turn_id=? AND
      ((? IS NOT NULL AND raw_turn_id=?) OR json_extract(response_json,'$.legacyImportMemoryId')=?
       OR EXISTS(SELECT 1 FROM json_each(response_json,'$.result.l1MemoryIds') WHERE value=?)) LIMIT 2`)
      .all(memory.userId, turnId, rawId ?? null, rawId ?? null, memory.id, memory.id) as
      Array<{source: string; profile_id: string; conversation_id: string; namespace_key: string}>;
    if (captures.length !== 1) return undefined;
    const row = captures[0]!;
    source = {source: row.source, profileId: row.profile_id, conversationId: row.conversation_id, scope: row.namespace_key};
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
