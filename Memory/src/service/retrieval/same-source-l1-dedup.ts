import { traceMetaFromMemory, type SeededChannelScores } from "../../algorithm/plugin-algorithms.js";
import type { Repositories } from "../../storage/repositories.js";
import { attachMemoryVector, memoryVector, memoryVectorEntries } from "../../storage/memory-vector-state.js";
import type { MemoryRow } from "../../types.js";

export interface SameSourceL1CandidateDedupResult {
  memories: MemoryRow[];
  channelScoresByMemory: ReadonlyMap<string, SeededChannelScores>;
  memoryIdByMemoryId: ReadonlyMap<string, string>;
}

/**
 * Collapse proven copies of the same native L1 source step before ranking.
 * UID never participates in grouping or representative selection. Historical
 * rows and their content are preserved; incomplete source identities stay separate.
 */
export function deduplicateSameSourceL1Candidates(input: {
  memories: readonly MemoryRow[];
  repos: Repositories;
  excludeTraceRawTurnIds?: ReadonlySet<string>;
  channelScoresByMemory?: ReadonlyMap<string, SeededChannelScores>;
}): SameSourceL1CandidateDedupResult {
  const groups = new Map<string, { firstIndex: number; memories: MemoryRow[] }>();
  input.memories.forEach((memory, index) => {
    const groupState = input.repos.memories.nativeDuplicates(memory);
    if (groupState.deleted) return;
    // Use the repository's single source-identity rule, also used by L2 evidence.
    // A recent turn must not re-enter context through another historical copy.
    if (input.excludeTraceRawTurnIds?.size && groupState.ids.some(id => {
      const member = id === memory.id ? memory : input.repos.memories.get(id);
      const rawTurnId = member ? traceMetaFromMemory(member)?.rawTurnId : undefined;
      return rawTurnId && input.excludeTraceRawTurnIds?.has(rawTurnId);
    })) return;
    const key = groupState.ids.length > 1 ? `native:${groupState.ids[0]}` : undefined;
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
