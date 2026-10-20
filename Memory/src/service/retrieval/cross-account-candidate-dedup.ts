import { canonicalNamespaceKey } from "../../storage/device-scope.js";
import type { SeededChannelScores } from "../../algorithm/plugin-algorithms.js";
import type { Repositories } from "../../storage/repositories.js";
import { attachMemoryVector, memoryVector, memoryVectorEntries } from "../../storage/memory-vector-state.js";
import type { MemoryRow } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";

export interface CrossAccountCandidateDedupResult {
  memories: MemoryRow[];
  channelScoresByMemory: ReadonlyMap<string, SeededChannelScores>;
  memoryIdByMemoryId: ReadonlyMap<string, string>;
}

/**
 * Collapse copies of the same locally sourced memory before ranking. Account IDs
 * are retained only on historical rows; the same native source turn may exist
 * under more than one account before cross-account capture deduplication existed.
 */
export function deduplicateCrossAccountMemoryCandidates(input: {
  memories: readonly MemoryRow[];
  repos: Repositories;
  preferredUserId: string | null;
  channelScoresByMemory?: ReadonlyMap<string, SeededChannelScores>;
}): CrossAccountCandidateDedupResult {
  const groups = new Map<string, { firstIndex: number; memories: MemoryRow[] }>();
  const nativeConversationBySessionId = new Map<string, string | undefined>();
  input.memories.forEach((memory, index) => {
    const groupState = input.repos.memories.nativeDuplicates(memory);
    if (groupState.deleted) return;
    const key = groupState.ids.length > 1 ? `native:${groupState.ids[0]}` : duplicateKey(memory, input.repos, nativeConversationBySessionId);
    if (!key) {
      groups.set(`unique:${index}:${memory.id}`, { firstIndex: index, memories: [memory] });
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
      for (const vector of memoryVectorEntries(memory)) {
        if (!memoryVector(group.representative, vector.vectorField)) {
          attachMemoryVector(group.representative, vector);
        }
      }
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
    memoryIdByMemoryId
  };
}

function duplicateKey(
  memory: MemoryRow,
  repos: Repositories,
  nativeConversationBySessionId: Map<string, string | undefined>
): string | undefined {
  if (memory.memoryLayer !== "L1" || memory.properties.internal_info.memory_kind === "work_memory") {
    return undefined;
  }
  const nativeConversation = nativeConversationKey(memory, repos, nativeConversationBySessionId);
  if (!nativeConversation) return undefined;
  const internal = memory.properties.internal_info;
  const trace = isRecord(internal.trace)
    ? internal.trace
    : isRecord(memory.info.trace)
      ? memory.info.trace
      : undefined;
  const turnId = text(memory.info.turn_id) ?? text(trace?.turn_id);
  if (!turnId) return undefined;
  const stepIndex = typeof trace?.step_index === "number" && Number.isFinite(trace.step_index)
    ? trace.step_index
    : memory.contentHash ?? stableHash(memory.memoryValue);
  return `native-turn:${stableHash({ nativeConversation, turnId, stepIndex })}`;
}

function nativeConversationKey(
  memory: MemoryRow,
  repos: Repositories,
  cache: Map<string, string | undefined>
): string | undefined {
  if (!memory.sessionId) return undefined;
  if (cache.has(memory.sessionId)) return cache.get(memory.sessionId);
  const session = repos.runtime.getSession(memory.sessionId);
  if (!session) {
    cache.set(memory.sessionId, undefined);
    return undefined;
  }
  const conversationId = session.conversationId?.trim() || memory.conversationId?.trim();
  const source = session.source.trim();
  const profileId = session.profileId.trim();
  if (!conversationId || !source || !profileId) {
    cache.set(memory.sessionId, undefined);
    return undefined;
  }

  const storedNamespaceKey = text(session.meta.source_namespace_key);
  const tenantId = text(session.meta.tenant_id) ?? text(session.meta.tenantId) ?? null;
  const namespaceKey = storedNamespaceKey ? canonicalNamespaceKey(repos.db, storedNamespaceKey) : stableHash({
    tenantId,
    projectId: session.projectId ?? null,
    workspaceId: session.workspaceId ?? null
  });
  const key = stableHash({ source, profileId, namespaceKey, conversationId });
  cache.set(memory.sessionId, key);
  return key;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
