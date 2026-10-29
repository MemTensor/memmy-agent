import { isRecord } from "../../utils/json.js";
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
import { deduplicateCrossAccountMemoryCandidates, recallSourceKey } from "./cross-account-candidate-dedup.js";

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

export interface RecallRouteDiagnostic {
  channel: string;
  rounds: number;
  rawHits: number;
  duplicateHits: number;
  unknownIdentityCount: number;
  metadataRows: number;
  durationMs?: number;
  uniqueCandidates: number;
  stopReason: "target_met" | "scope_exhausted" | "work_budget_limited" | "deadline" | "cancelled" | "error" | "no_progress";
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
    excludeTraceRawTurnIds?: ReadonlySet<string>;
    budget?: { maxRows?: number; maxMetadataRows?: number; deadlineAt?: number; signal?: AbortSignal; usage?: {rows: number; metadataRows: number} };
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
    diagnostics: RecallRouteDiagnostic[];
  }> {
    const routeTasks: Array<Promise<MemorySearchIdHit[]>> = [];
    const diagnostics: RecallRouteDiagnostic[] = [];
    const usage = input.budget?.usage ?? {rows: 0, metadataRows: 0};
    const work = {deadlineAt: input.budget?.deadlineAt ?? Date.now() + 5_000,
      maxRows: input.budget?.maxRows ?? 10_000, maxMetadataRows: input.budget?.maxMetadataRows ?? 50_000};
    const keyCache = new Map<string, string>();
    const groupCache = new Map<string, string[]>();
    const recentGroups = new Set<string>();
    const keyOf = (memory: MemoryRow) => {
      if (!keyCache.has(memory.id)) keyCache.set(memory.id, recallSourceKey(memory, this.deps.repos) ?? `id:${memory.id}`);
      return keyCache.get(memory.id)!;
    };
    const refill = (filter: MemoryFilter, limit: number, channel: string,
      run: (filter: MemoryFilter, limit: number, onWindow: (ids: string[], more: boolean) => void) => MemorySearchIdHit[]) => {
      if (filter.memoryLayer !== "L1") {
        try { return run(filter, limit, () => {}); }
        catch { diagnostics.push({channel,rounds:1,rawHits:0,duplicateHits:0,unknownIdentityCount:0,metadataRows:0,uniqueCandidates:0,stopReason:"error"});return []; }
      }
      const routeStarted=Date.now();
      const accepted = new Map<string, MemorySearchIdHit>();
      const excluded = new Set<string>();
      const unknownIdentities = new Set<string>();
      const diagnostic: RecallRouteDiagnostic = {channel, rounds: 0, rawHits: 0, duplicateHits: 0, unknownIdentityCount: 0, metadataRows: 0, uniqueCandidates: 0, stopReason: "scope_exhausted"};
      diagnostics.push(diagnostic);
      const batchSize = Math.max(1, Math.min(256, limit));
      for (let round=0; round<128; round++) {
        if (accepted.size >= limit) {diagnostic.stopReason="target_met"; break;}
        if (input.budget?.signal?.aborted) {diagnostic.stopReason="cancelled"; break;}
        if (Date.now() >= work.deadlineAt) {diagnostic.stopReason="deadline"; break;}
        if (usage.rows >= work.maxRows || usage.metadataRows >= work.maxMetadataRows) {diagnostic.stopReason="work_budget_limited"; break;}
        let window: string[] | undefined;
        let windowMore = false;
        const size = Math.min(batchSize, work.maxRows - usage.rows);
        let hits: MemorySearchIdHit[];
        try {
          hits = run({...filter, excludedIds: [...excluded]}, size,
            (ids, more) => {window=ids; windowMore=more;});
        } catch {diagnostic.stopReason="error"; break;}
        diagnostic.rounds++;
        usage.rows += hits.length;
        diagnostic.rawHits += hits.length;
        const fresh = hits.filter(hit => !excluded.has(hit.id));
        const memories = this.deps.repos.memories.getMany(dedupeStrings(fresh.map(hit => hit.id)));
        const memoriesById = new Map(memories.map(memory => [memory.id, memory]));
        const before = excluded.size;
        for (const hit of fresh) {
          excluded.add(hit.id);
          const memory = memoriesById.get(hit.id);
          if (!memory) continue;
          const key = keyOf(memory);
          if (key.startsWith("id:")) unknownIdentities.add(memory.id);
          if (!this.isMemoryReadyForRetrieval(memory)) continue;
          const trace = isRecord(memory.properties.internal_info.trace) ? memory.properties.internal_info.trace : undefined;
          const raw = trace?.raw_turn_id ?? memory.info.raw_turn_id;
          if (typeof raw === "string" && input.excludeTraceRawTurnIds?.has(raw)) recentGroups.add(key);
          if (!key.startsWith("id:") && !groupCache.has(key) &&
            (accepted.has(key) || Boolean(input.excludeTraceRawTurnIds?.size))) {
            const turn = memory.info.turn_id ?? trace?.turn_id;
            if (typeof turn === "string") {
              const remaining = Math.max(0, work.maxMetadataRows - usage.metadataRows);
              const cap = Math.min(10_000, remaining);
              const members = this.deps.repos.memories.recallSourceCandidates(turn, filter, cap + 1, typeof trace?.step_index === "number" ? trace.step_index : undefined);
              usage.metadataRows += members.length;
              diagnostic.metadataRows += members.length;
              if (members.length > cap) {
                diagnostic.stopReason="work_budget_limited";
                break;
              }
              const sameSource=members.filter(row => keyOf(row) === key);
              groupCache.set(key, sameSource.map(row => row.id));
              if (sameSource.some(row => {
                const meta=isRecord(row.properties.internal_info.trace) ? row.properties.internal_info.trace : undefined;
                const id=meta?.raw_turn_id ?? row.info.raw_turn_id;
                return typeof id === "string" && input.excludeTraceRawTurnIds?.has(id);
              })) recentGroups.add(key);
            }
          }
          for (const id of groupCache.get(key) ?? []) excluded.add(id);
          if (recentGroups.has(key)) {accepted.delete(key); continue;}
          const previous = accepted.get(key);
          if (previous) diagnostic.duplicateHits++;
          if (previous && hit.channel?.startsWith("vec") && hit.score > previous.score) {
            accepted.set(key, hit);
          }
          if (!previous) {
            // Text routes are ranked across source groups, never reset at a page boundary.
            accepted.set(key, {...hit, score: hit.channel === "fts" || hit.channel === "pattern" || hit.channel === "structural"
              ? 1 / (accepted.size + 1) : hit.score});
          }
        }
        if (diagnostic.stopReason === "work_budget_limited") break;
        if (accepted.size >= limit) {diagnostic.stopReason="target_met"; break;}
        if (window && hits.length < size) {
          for (const id of window) excluded.add(id);
          // A window with no usable vectors can have more compatible metadata behind it.
          if (!windowMore) {diagnostic.stopReason="scope_exhausted"; break;}
          usage.rows += Math.max(0, window.length - hits.length);
        } else if (!window && hits.length < size) {diagnostic.stopReason="scope_exhausted"; break;}
        if (excluded.size === before) {diagnostic.stopReason="no_progress"; break;}
        if (round === 127) diagnostic.stopReason="work_budget_limited";
      }
      diagnostic.uniqueCandidates=Math.min(accepted.size,limit);
      diagnostic.unknownIdentityCount=unknownIdentities.size;
      diagnostic.durationMs=Date.now()-routeStarted;
      return [...accepted.values()].slice(0,limit);
    };
    const queryVector = input.queryVector && input.queryVector.length > 0 ? input.queryVector : undefined;
    const layers = input.layers;
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
        ...(input.tags?.length ? { tags: input.tags } : {})
      };
      const vectorPool = this.retrievalVectorPoolSize(layer, input.config);
      const keywordPool = this.retrievalKeywordPoolSize(layer, input.config);

      if (queryVector) {
        if (layer === "L1") {
          addRoute(() => {
            const tags = input.config.tagFilter === "off" ? [] : input.compiledQuery.tags;
            const search = (field: "vec_summary" | "vec_action", anyOfTags?: string[]) =>
              refill(filter, vectorPool, field, (scoped, limit, onWindow) =>
                this.deps.repos.memories.searchVectorIds(queryVector, field, scoped, limit, {anyOfTags, onWindow}));
            if (!tags.length) return [...search("vec_summary"), ...search("vec_action")];
            const tagged=[...search("vec_summary", tags), ...search("vec_action", tags)];
            return tagged.length || input.config.tagFilter === "on" ? tagged : search("vec_summary");
          });
        } else {
          addRoute(() => this.deps.repos.memories.searchVectorIds(queryVector, "vec", filter, vectorPool));
        }
      }

      if (input.compiledQuery.ftsMatch) {
        addRoute(() => refill(filter, keywordPool, "fts", (scoped, limit) => this.deps.repos.memories.searchFtsIds(input.compiledQuery.ftsMatch, scoped, limit, true)));
      }
      if (input.compiledQuery.patternTerms.length > 0) {
        addRoute(() => refill(filter, keywordPool, "pattern", (scoped, limit) => this.deps.repos.memories.searchPatternIds(input.compiledQuery.patternTerms, scoped, limit)));
      }
      if (layer === "L1" && input.compiledQuery.structuralFragments.length > 0) {
        addRoute(() => refill(filter, Math.max(input.config.tier2TopK, 10), "structural", (scoped, limit) => this.deps.repos.memories.searchStructuralIds(input.compiledQuery.structuralFragments, scoped, limit)));
      }
    }

    if (input.targetSkillId && layers.includes("Skill")) {
      routeTasks.push(Promise.resolve([{ id: input.targetSkillId, score: 1, channel: "vec" }]));
    }
    if (routeTasks.length === 0) {
      return { memories: [], channelScoresByMemory: new Map(), diagnostics };
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
    const readyMemories = this.deps.repos.memories.getMany(candidateIds).filter((memory) =>
        this.isMemoryReadyForRetrieval(memory) &&
        this.isSkillVisibleToAgent(memory, input.currentAgentId)
      );
    return {...deduplicateCrossAccountMemoryCandidates({
      memories: readyMemories,
      repos: this.deps.repos,
      preferredUserId: input.userId,
      channelScoresByMemory
    }), diagnostics};
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
