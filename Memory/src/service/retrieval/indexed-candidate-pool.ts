import type {
  CompiledRetrievalQuery,
  SeededChannelScores
} from "../../algorithm/plugin-algorithms.js";
import {
  isMemoryReadyForRetrieval
} from "../../algorithm/plugin-algorithms.js";
import {
  Repositories,
  type MemorySearchIdHit
} from "../../storage/repositories.js";
import type {
  MemoryFilter,
  MemoryLayer,
  MemoryRow
} from "../../types.js";
import { isImportedSkill, normalizeSkillName } from "../../storage/imported-skill.js";
import { deduplicateCrossAccountMemoryCandidates } from "./cross-account-candidate-dedup.js";

export function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

interface IndexedCandidatePoolDependencies {
  repos: Repositories;
  memoryHasImportPipeline(memory: MemoryRow): boolean;
}

export class IndexedCandidatePool {
  constructor(private readonly deps: IndexedCandidatePoolDependencies) {}

  retrievalCandidateCount(input: {
    userId: string;
    layers: MemoryLayer[];
    tags?: string[];
    projectId?: string | null;
  }): number {
    const baseFilter: MemoryFilter = {
      memoryLayer: input.layers,
      status: ["activated", "resolving"]
    };
    const scopedFilter = input.layers.includes("L1") && input.projectId !== undefined
      ? { ...baseFilter, workMemoryUserId: input.userId, workMemoryProjectId: input.projectId }
      : baseFilter;
    return this.deps.repos.memories.count(input.tags?.length ? { ...scopedFilter, tags: input.tags } : scopedFilter);
  }

  hasRetrievalVectorCandidates(input: {
    userId: string;
    layers: MemoryLayer[];
    tags?: string[];
    projectId?: string | null;
  }): boolean {
    if (input.layers.length === 0) return false;
    const baseFilter: MemoryFilter = {
      memoryLayer: input.layers,
      status: ["activated", "resolving"]
    };
    const scopedFilter = input.layers.includes("L1") && input.projectId !== undefined
      ? { ...baseFilter, workMemoryUserId: input.userId, workMemoryProjectId: input.projectId }
      : baseFilter;
    return this.deps.repos.memories.hasVectorRows(input.tags?.length ? { ...scopedFilter, tags: input.tags } : scopedFilter);
  }

  async indexedRetrievalCandidatePool(input: {
    userId: string;
    compiledQuery: CompiledRetrievalQuery;
    queryVector?: number[];
    layers: MemoryLayer[];
    tags?: string[];
    projectId?: string | null;
    targetSkillId?: string;
    currentAgentId?: string;
    config: {
      tier1TopK: number;
      tier2TopK: number;
      tier3TopK: number;
      candidatePoolFactor: number;
      keywordTopK: number;
      tagFilter: "auto" | "on" | "off";
    };
  }): Promise<{
    memories: MemoryRow[];
    channelScoresByMemory: ReadonlyMap<string, SeededChannelScores>;
  }> {
    const queryVector = input.queryVector && input.queryVector.length > 0 ? input.queryVector : undefined;
    const collectRoutes = (layers: readonly MemoryLayer[], extraPool: number): Array<Promise<MemorySearchIdHit[]>> => {
      const routeTasks: Array<Promise<MemorySearchIdHit[]>> = [];
      const addRoute = (run: () => MemorySearchIdHit[]): void => {
        routeTasks.push(Promise.resolve().then(run));
      };
      for (const layer of layers) {
        const filter: MemoryFilter = {
          memoryLayer: layer,
          status: ["activated", "resolving"],
          ...(layer === "L1" && input.projectId !== undefined
            ? { workMemoryUserId: input.userId, workMemoryProjectId: input.projectId }
            : {}),
          ...(input.tags?.length ? { tags: input.tags } : {}),
          // The current Agent's own imported skills are left out in the query,
          // so they never take a candidate slot.
          ...(layer === "Skill" && input.currentAgentId ? { excludedImportedSkillSourceAgentId: input.currentAgentId } : {})
        };
        const vectorPool = this.retrievalVectorPoolSize(layer, input.config) + extraPool;
        const keywordPool = this.retrievalKeywordPoolSize(layer, input.config) + extraPool;

        if (queryVector) {
          if (layer === "L1") {
            addRoute(() => this.searchTraceVectorRoutes(queryVector, filter, vectorPool, input.compiledQuery, input.config));
          } else {
            addRoute(() => this.deps.repos.memories.searchVectorIds(queryVector, "vec", filter, vectorPool));
          }
        }

        if (input.compiledQuery.ftsMatch) {
          addRoute(() => this.deps.repos.memories.searchFtsIds(input.compiledQuery.ftsMatch, filter, keywordPool));
        }
        if (input.compiledQuery.patternTerms.length > 0) {
          addRoute(() => this.deps.repos.memories.searchPatternIds(input.compiledQuery.patternTerms, filter, keywordPool));
        }
        if (layer === "L1" && input.compiledQuery.structuralFragments.length > 0) {
          addRoute(() => this.deps.repos.memories.searchStructuralIds(
            input.compiledQuery.structuralFragments,
            filter,
            Math.max(input.config.tier2TopK, 10)
          ));
        }
      }
      return routeTasks;
    };

    const routeTasks = collectRoutes(input.layers, 0);
    if (input.targetSkillId && input.layers.includes("Skill")) {
      routeTasks.push(Promise.resolve([{ id: input.targetSkillId, score: 1, channel: "vec" }]));
    }
    if (routeTasks.length === 0) {
      return { memories: [], channelScoresByMemory: new Map() };
    }

    const channelScoresByMemory = new Map<string, SeededChannelScores>();
    const seenIds = new Set<string>();
    const loadHits = async (tasks: Array<Promise<MemorySearchIdHit[]>>): Promise<MemoryRow[]> => {
      const flattenedHits = (await Promise.all(tasks)).flat();
      for (const hit of flattenedHits) {
        if (!hit.channel) continue;
        const scores = channelScoresByMemory.get(hit.id) ?? {};
        scores[hit.channel] = Math.max(scores[hit.channel] ?? -Infinity, hit.score);
        channelScoresByMemory.set(hit.id, scores);
      }
      const newIds = dedupeStrings(flattenedHits.map((hit) => hit.id)).filter((id) => !seenIds.has(id));
      for (const id of newIds) seenIds.add(id);
      return this.deps.repos.memories.getMany(newIds).filter((memory) =>
        this.isMemoryReadyForRetrieval(memory) &&
        this.isSkillVisibleToAgent(memory, input.currentAgentId)
      );
    };

    const takenNames = new Set<string>();
    const grouped = this.groupImportedSkillsByName(await loadHits(routeTasks), channelScoresByMemory, input.currentAgentId, takenNames);
    let readyMemories = grouped.memories;
    // Same-name copies dropped by grouping would otherwise leave the Skill
    // layer short; widen the Skill queries by the number dropped so far until
    // a round drops nothing or the queries return no new records.
    let removed = grouped.removed;
    let lastRemoved = grouped.removed;
    while (lastRemoved > 0 && input.layers.includes("Skill")) {
      const seenBefore = seenIds.size;
      const refill = this.groupImportedSkillsByName(
        await loadHits(collectRoutes(["Skill"], removed)),
        channelScoresByMemory,
        input.currentAgentId,
        takenNames
      );
      readyMemories = [...readyMemories, ...refill.memories];
      if (seenIds.size === seenBefore) break;
      removed += refill.removed;
      lastRemoved = refill.removed;
    }
    return deduplicateCrossAccountMemoryCandidates({
      memories: readyMemories,
      repos: this.deps.repos,
      preferredUserId: input.userId,
      channelScoresByMemory
    });
  }

  /**
   * Imported skills that share a normalized name are one group and yield one
   * candidate: none when the current Agent already has a skill of that name,
   * otherwise the group's most recently modified current version (looked up
   * across all sources, not only among these candidates). The chosen record
   * takes the best channel scores of the group's candidates.
   */
  private groupImportedSkillsByName(
    memories: readonly MemoryRow[],
    channelScoresByMemory: Map<string, SeededChannelScores>,
    currentAgentId: string | undefined,
    takenNames: Set<string>
  ): { memories: MemoryRow[]; removed: number } {
    const named = memories.filter((memory) => isImportedSkill(memory) && importedSkillName(memory));
    if (named.length === 0) return { memories: [...memories], removed: 0 };
    const installed = currentAgentId ? this.deps.repos.memories.listInstalledSkillNamesForAgent(currentAgentId) : new Set<string>();
    const names = dedupeStrings(named.map((memory) => importedSkillName(memory)!))
      .filter((name) => !installed.has(name) && !takenNames.has(name));
    const latest = this.deps.repos.memories.latestImportedSkillsByName(names, currentAgentId);
    const groupScores = new Map<string, SeededChannelScores>();
    for (const memory of named) {
      const name = importedSkillName(memory)!;
      const merged = { ...(groupScores.get(name) ?? {}) };
      for (const [channel, score] of Object.entries(channelScoresByMemory.get(memory.id) ?? {})) {
        const key = channel as keyof SeededChannelScores;
        merged[key] = Math.max(merged[key] ?? -Infinity, score as number);
      }
      groupScores.set(name, merged);
    }
    const kept: MemoryRow[] = [];
    let removed = 0;
    for (const memory of memories) {
      const name = isImportedSkill(memory) ? importedSkillName(memory) : undefined;
      if (!name) {
        kept.push(memory);
        continue;
      }
      if (installed.has(name) || takenNames.has(name)) {
        removed += 1;
        continue;
      }
      takenNames.add(name);
      const chosenId = latest.get(name) ?? memory.id;
      const chosen = chosenId === memory.id
        ? memory
        : memories.find((candidate) => candidate.id === chosenId) ?? this.deps.repos.memories.get(chosenId);
      const usable = chosen && this.isMemoryReadyForRetrieval(chosen) && this.isSkillVisibleToAgent(chosen, currentAgentId)
        ? chosen
        : memory;
      channelScoresByMemory.set(usable.id, groupScores.get(name) ?? channelScoresByMemory.get(usable.id) ?? {});
      kept.push(usable);
    }
    return { memories: kept, removed };
  }

  private isSkillVisibleToAgent(memory: MemoryRow, currentAgentId?: string): boolean {
    if (memory.memoryLayer !== "Skill") return true;
    const internal = memory.properties.internal_info;
    if (internal.read_only !== true) return true;
    const sourceAgentId = typeof internal.source_agent_id === "string"
      ? internal.source_agent_id.trim()
      : "";
    if (!sourceAgentId) return false;
    return !currentAgentId || normalizeAgentId(sourceAgentId) !== normalizeAgentId(currentAgentId);
  }

  private searchTraceVectorRoutes(
    queryVector: number[],
    filter: MemoryFilter,
    vectorPool: number,
    compiledQuery: CompiledRetrievalQuery,
    config: {
      tagFilter: "auto" | "on" | "off";
    }
  ): MemorySearchIdHit[] {
    const tags = config.tagFilter === "off" ? [] : compiledQuery.tags;
    const search = (anyOfTags?: string[]): MemorySearchIdHit[] => {
      const summary = this.deps.repos.memories.searchVectorIds(queryVector, "vec_summary", filter, vectorPool, {
        anyOfTags
      });
      const action = this.deps.repos.memories.searchVectorIds(queryVector, "vec_action", filter, vectorPool, {
        anyOfTags
      });
      return [...summary, ...action];
    };
    if (tags.length === 0) return search();
    const tagged = search(tags);
    if (tagged.length > 0 || config.tagFilter === "on") return tagged;
    return this.deps.repos.memories.searchVectorIds(queryVector, "vec_summary", filter, vectorPool);
  }

  isMemoryReadyForRetrieval(memory: MemoryRow): boolean {
    const processing = this.deps.repos.processing.get(memory.id);
    if (!processing || !this.deps.memoryHasImportPipeline(memory)) return isMemoryReadyForRetrieval(memory);
    if (processing.state === "ready" || processing.state === "ready_text_only") return true;
    if (
      processing.state === "embedding_pending" ||
      processing.state === "embedding" ||
      (processing.state === "failed" && processing.stage === "embedding")
    ) {
      return isMemoryReadyForRetrieval(memory);
    }
    return false;
  }

  private retrievalVectorPoolSize(
    layer: MemoryLayer,
    config: {
      tier1TopK: number;
      tier2TopK: number;
      tier3TopK: number;
      candidatePoolFactor: number;
    }
  ): number {
    const topK = layer === "Skill"
      ? config.tier1TopK
      : layer === "L3"
        ? config.tier3TopK
        : config.tier2TopK;
    return Math.max(1, Math.ceil(topK * config.candidatePoolFactor));
  }

  private retrievalKeywordPoolSize(
    layer: MemoryLayer,
    config: {
      tier1TopK: number;
      tier2TopK: number;
      tier3TopK: number;
      keywordTopK: number;
    }
  ): number {
    const topK = layer === "Skill"
      ? config.tier1TopK
      : layer === "L3"
        ? config.tier3TopK
        : config.tier2TopK;
    return Math.max(topK, config.keywordTopK);
  }

  private listAllMemories(filter: MemoryFilter): MemoryRow[] {
    const total = this.deps.repos.memories.count(filter);
    return total <= 0 ? [] : this.deps.repos.memories.list(filter, total);
  }
}

function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function importedSkillName(memory: MemoryRow): string | undefined {
  const internal = memory.properties.internal_info;
  if (typeof internal.normalized_name === "string" && internal.normalized_name) return internal.normalized_name;
  const name = typeof internal.name === "string" ? internal.name : typeof memory.info.title === "string" ? memory.info.title : "";
  return normalizeSkillName(name) || undefined;
}
