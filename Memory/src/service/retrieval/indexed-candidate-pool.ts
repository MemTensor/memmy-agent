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
    layers: MemoryLayer[];
    tags?: string[];
  }): number {
    const baseFilter: MemoryFilter = {
      memoryLayer: input.layers,
      status: ["activated", "resolving"]
    };
    return this.deps.repos.memories.count(input.tags?.length ? { ...baseFilter, tags: input.tags } : baseFilter);
  }

  hasRetrievalVectorCandidates(input: {
    layers: MemoryLayer[];
    tags?: string[];
  }): boolean {
    if (input.layers.length === 0) return false;
    const baseFilter: MemoryFilter = {
      memoryLayer: input.layers,
      status: ["activated", "resolving"]
    };
    return this.deps.repos.memories.hasVectorRows(input.tags?.length ? { ...baseFilter, tags: input.tags } : baseFilter);
  }

  async indexedRetrievalCandidatePool(input: {
    compiledQuery: CompiledRetrievalQuery;
    queryVector?: number[];
    layers: MemoryLayer[];
    tags?: string[];
    targetSkillId?: string;
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
    const routeTasks: Array<Promise<MemorySearchIdHit[]>> = [];
    const queryVector = input.queryVector && input.queryVector.length > 0 ? input.queryVector : undefined;
    const layers = input.layers;
    const addRoute = (run: () => MemorySearchIdHit[]): void => {
      routeTasks.push(Promise.resolve().then(run));
    };

    for (const layer of layers) {
      const filter: MemoryFilter = {
        memoryLayer: layer,
        status: ["activated", "resolving"],
        ...(input.tags?.length ? { tags: input.tags } : {})
      };
      const vectorPool = this.retrievalVectorPoolSize(layer, input.config);
      const keywordPool = this.retrievalKeywordPoolSize(layer, input.config);

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

    if (input.targetSkillId && layers.includes("Skill")) {
      routeTasks.push(Promise.resolve([{ id: input.targetSkillId, score: 1, channel: "vec" }]));
    }
    if (routeTasks.length === 0) {
      return { memories: [], channelScoresByMemory: new Map() };
    }

    const routeHits = await Promise.all(routeTasks);
    const flattenedHits = routeHits.flat();
    const candidateIds = dedupeStrings(flattenedHits.map((hit) => hit.id));
    const channelScoresByMemory = new Map<string, SeededChannelScores>();
    for (const hit of flattenedHits) {
      if (!hit.channel) continue;
      const scores = channelScoresByMemory.get(hit.id) ?? {};
      scores[hit.channel] = Math.max(scores[hit.channel] ?? -Infinity, hit.score);
      channelScoresByMemory.set(hit.id, scores);
    }
    return {
      memories: this.deps.repos.memories.getMany(candidateIds).filter((memory) => this.isMemoryReadyForRetrieval(memory)),
      channelScoresByMemory
    };
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
