import { traceMetaFromMemory, type SeededChannelScores } from "../../algorithm/plugin-algorithms.js";
import type { Repositories } from "../../storage/repositories.js";
import { attachMemoryVector, memoryVector, memoryVectorEntries } from "../../storage/memory-vector-state.js";
import type { MemoryRow } from "../../types.js";

export interface SameSourceL1CandidateDedupResult {
  memories: MemoryRow[];
  channelScoresByMemory: ReadonlyMap<string, SeededChannelScores>;
  memoryIdByMemoryId: ReadonlyMap<string, string>;
  sourceIdsByCandidateId: ReadonlyMap<string, readonly string[]>;
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newestMemoryFirst(left: MemoryRow, right: MemoryRow): number {
  return timestampValue(right.updatedAt) - timestampValue(left.updatedAt) ||
    right.version - left.version ||
    timestampValue(right.createdAt) - timestampValue(left.createdAt) ||
    left.id.localeCompare(right.id);
}

function sameContentRevision(left: MemoryRow, right: MemoryRow): boolean {
  const leftTrace = traceMetaFromMemory(left);
  const rightTrace = traceMetaFromMemory(right);
  return (left.contentHash ?? null) === (right.contentHash ?? null) &&
    left.memoryValue === right.memoryValue &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags) &&
    JSON.stringify([
      leftTrace?.summary, leftTrace?.userText, leftTrace?.agentText,
      leftTrace?.toolCalls, leftTrace?.reflection, leftTrace?.errorSignatures
    ]) === JSON.stringify([
      rightTrace?.summary, rightTrace?.userText, rightTrace?.agentText,
      rightTrace?.toolCalls, rightTrace?.reflection, rightTrace?.errorSignatures
    ]);
}

export function memoryMatchesRequestedTags(memory: MemoryRow, tags: readonly string[] = []): boolean {
  if (tags.length === 0) return true;
  const infoTags = Array.isArray(memory.info.tags) ? memory.info.tags : [];
  const propertyTags = Array.isArray(memory.properties.tags) ? memory.properties.tags : [];
  const available = new Set([...memory.tags, ...infoTags, ...propertyTags]
    .filter((tag): tag is string => typeof tag === "string")
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean));
  return tags.every(tag => available.has(tag.trim().toLowerCase()));
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
  isMemoryEligible?: (memory: MemoryRow) => boolean;
  isMemoryInScope?: (memory: MemoryRow) => boolean;
  /** Disable repository expansion when merging already-normalized query-rewrite results. */
  includeUnreturnedCopies?: boolean;
}): SameSourceL1CandidateDedupResult {
  const groups = new Map<string, {
    firstIndex: number;
    nativeIds: string[];
    candidateIds: Set<string>;
    memoriesById: Map<string, MemoryRow>;
  }>();
  const candidateMemoriesById = new Map<string, MemoryRow>();
  const sourceIdsByCandidateId = new Map<string, readonly string[]>();
  input.memories.forEach((memory, index) => {
    const groupState = input.repos.memories.nativeDuplicates(memory);
    sourceIdsByCandidateId.set(memory.id, groupState.ids);
    if (groupState.deleted) return;
    const key = groupState.ids.length > 1 ? `native:${groupState.ids[0]}` : undefined;
    const groupKey = key ?? `unique:${index}:${memory.id}`;
    const group = groups.get(groupKey) ?? {
      firstIndex: index,
      nativeIds: groupState.ids.length > 0 ? [...groupState.ids] : [memory.id],
      candidateIds: new Set<string>(),
      memoriesById: new Map<string, MemoryRow>()
    };
    group.candidateIds.add(memory.id);
    group.memoriesById.set(memory.id, memory);
    groups.set(groupKey, group);
    candidateMemoriesById.set(memory.id, memory);
  });

  const includeUnreturnedCopies = input.includeUnreturnedCopies !== false;
  const sourceMemoriesById = new Map(candidateMemoriesById);
  if (includeUnreturnedCopies) {
    const sourceIds = [...new Set([...groups.values()]
      .filter(group => group.nativeIds.length > 1)
      .flatMap(group => group.nativeIds))];
    // Keep each IN query below SQLite's conservative parameter limit.
    for (let offset = 0; offset < sourceIds.length; offset += 500) {
      for (const memory of input.repos.memories.getMany(sourceIds.slice(offset, offset + 500))) {
        if (!sourceMemoriesById.has(memory.id)) sourceMemoriesById.set(memory.id, memory);
      }
    }
  }

  const selected = [...groups.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((group) => {
      const eligible = group.nativeIds.flatMap(id => {
        const memory = sourceMemoriesById.get(id) ?? group.memoriesById.get(id);
        if (!memory) return [];
        const isEligible = input.isMemoryEligible?.(memory) ??
          (memory.status === "activated" || memory.status === "resolving");
        return isEligible ? [memory] : [];
      });
      const excludedByRecentTurn = Boolean(input.excludeTraceRawTurnIds?.size && group.nativeIds.some(id => {
        const member = sourceMemoriesById.get(id) ?? input.repos.memories.get(id);
        const rawTurnId = member ? traceMetaFromMemory(member)?.rawTurnId : undefined;
        return rawTurnId && input.excludeTraceRawTurnIds?.has(rawTurnId);
      }));
      const membersById = new Map(eligible.map(memory => [memory.id, memory]));
      const representative = [...membersById.values()].sort(newestMemoryFirst)[0];
      const representativeInScope = representative && (input.isMemoryInScope?.(representative) ?? true);
      return representative && representativeInScope && !excludedByRecentTurn
        ? { representative, members: [...membersById.values()], nativeIds: group.nativeIds, candidateIds: group.candidateIds }
        : undefined;
    })
    .filter((group): group is NonNullable<typeof group> => Boolean(group));

  const channelScoresByMemory = new Map<string, SeededChannelScores>();
  const memoryIdByMemoryId = new Map<string, string>();
  for (const group of selected) {
    if (group.members.length === 1) {
      const memory = group.representative;
      for (const id of group.nativeIds) memoryIdByMemoryId.set(id, memory.id);
      const scores = group.candidateIds.has(memory.id)
        ? input.channelScoresByMemory?.get(memory.id)
        : undefined;
      if (scores) channelScoresByMemory.set(memory.id, scores);
      continue;
    }

    const merged: SeededChannelScores = {};
    for (const memory of group.members) {
      memoryIdByMemoryId.set(memory.id, group.representative.id);
      if (sameContentRevision(memory, group.representative)) {
        for (const vector of memoryVectorEntries(memory)) {
          if (!memoryVector(group.representative, vector.vectorField)) {
            attachMemoryVector(group.representative, vector);
          }
        }
        const scores = group.candidateIds.has(memory.id)
          ? input.channelScoresByMemory?.get(memory.id)
          : undefined;
        for (const [channel, score] of Object.entries(scores ?? {})) {
          const key = channel as keyof SeededChannelScores;
          const current = merged[key];
          if (typeof score === "number" && (current === undefined || score > current)) {
            merged[key] = score;
          }
        }
      }
    }
    for (const id of group.nativeIds) memoryIdByMemoryId.set(id, group.representative.id);
    if (Object.keys(merged).length > 0) channelScoresByMemory.set(group.representative.id, merged);
  }

  return {
    memories: selected.map((group) => group.representative),
    channelScoresByMemory,
    memoryIdByMemoryId,
    sourceIdsByCandidateId
  };
}
