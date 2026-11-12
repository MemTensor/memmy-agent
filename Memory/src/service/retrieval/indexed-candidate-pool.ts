import { setImmediate as yieldToIO } from "node:timers/promises";
import { isRecord } from "../../utils/json.js";
import type {
  CompiledRetrievalQuery,
  SeededChannelScores
} from "../../algorithm/plugin-algorithms.js";
import {
  importedSkillBodyPatternTerms,
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
import { createRecallSourceResolver, deduplicateCrossAccountMemoryCandidates } from "./cross-account-candidate-dedup.js";

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
      status: ["activated", "resolving"],
      ...(input.layers.includes("Skill") ? { eligibleImportedSkillsOnly: true } : {})
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
      status: ["activated", "resolving"],
      ...(input.layers.includes("Skill") ? { eligibleImportedSkillsOnly: true } : {})
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
    const diagnostics: RecallRouteDiagnostic[] = [];
    const usage = input.budget?.usage ?? {rows: 0, metadataRows: 0};
    const work = {deadlineAt: input.budget?.deadlineAt ?? Date.now() + 5_000,
      maxRows: input.budget?.maxRows ?? 10_000, maxMetadataRows: input.budget?.maxMetadataRows ?? 50_000};
    const keyCache = new Map<string, string>();
    const resolveSourceKey = createRecallSourceResolver(this.deps.repos);
    const groupCache = new Map<string, string[]>();
    const recentGroups = new Set<string>();
    const keyOf = (memory: MemoryRow) => {
      if (!keyCache.has(memory.id)) keyCache.set(memory.id, resolveSourceKey(memory) ?? `id:${memory.id}`);
      return keyCache.get(memory.id)!;
    };
    const refill = async (filter: MemoryFilter, limit: number, channel: string,
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
        else await yieldToIO();
      }
      diagnostic.uniqueCandidates=Math.min(accepted.size,limit);
      diagnostic.unknownIdentityCount=unknownIdentities.size;
      diagnostic.durationMs=Date.now()-routeStarted;
      return [...accepted.values()].slice(0,limit);
    };
    const queryVector = input.queryVector && input.queryVector.length > 0 ? input.queryVector : undefined;
    const commonFilter: MemoryFilter = {
      status: ["activated", "resolving"],
      ...(input.tags?.length ? { tags: input.tags } : {})
    };
    const skillFilter: MemoryFilter = {
      ...commonFilter,
      memoryLayer: "Skill",
      eligibleImportedSkillsOnly: true,
      ...(input.targetSkillId ? { ids: [input.targetSkillId] } : {}),
      ...(input.currentAgentId ? { excludedImportedSkillSourceAgentId: input.currentAgentId } : {})
    };
    const importedBodyTerms = importedSkillBodyPatternTerms(input.compiledQuery);
    const collectRoutes = (layers: readonly MemoryLayer[], extraPool: number): Array<Promise<MemorySearchIdHit[]>> => {
      const routeTasks: Array<Promise<MemorySearchIdHit[]>> = [];
      const addRoute = (run: () => MemorySearchIdHit[] | Promise<MemorySearchIdHit[]>): void => {
        routeTasks.push(Promise.resolve().then(run));
      };
      for (const layer of layers) {
        const filter: MemoryFilter = layer === "Skill" ? skillFilter : {
          ...commonFilter,
          memoryLayer: layer,
          ...(layer === "L1" && input.projectId !== undefined
            ? { workMemoryUserId: input.userId, workMemoryProjectId: input.projectId }
            : {})
        };
        const vectorPool = this.retrievalVectorPoolSize(layer, input.config) + extraPool;
        const keywordPool = this.retrievalKeywordPoolSize(layer, input.config) + extraPool;

        if (queryVector) {
          if (layer === "L1") {
            addRoute(async () => {
              const tags = input.config.tagFilter === "off" ? [] : input.compiledQuery.tags;
              const search = (field: "vec_summary" | "vec_action", anyOfTags?: string[]) =>
                refill(filter, vectorPool, field, (scoped, limit, onWindow) =>
                  this.deps.repos.memories.searchVectorIds(queryVector, field, scoped, limit, { anyOfTags, onWindow }));
              if (!tags.length) return [...await search("vec_summary"), ...await search("vec_action")];
              const tagged = [...await search("vec_summary", tags), ...await search("vec_action", tags)];
              return tagged.length || input.config.tagFilter === "on" ? tagged : search("vec_summary");
            });
          } else {
            addRoute(() => this.deps.repos.memories.searchVectorIds(queryVector, "vec", filter, vectorPool));
          }
        }

        if (input.compiledQuery.ftsMatch) {
          addRoute(() => refill(filter, keywordPool, "fts", (scoped, limit) => this.deps.repos.memories.searchFtsIds(input.compiledQuery.ftsMatch, scoped, limit, layer === "L1")));
        }
        if (input.compiledQuery.patternTerms.length > 0) {
          addRoute(() => refill(filter, keywordPool, "pattern", (scoped, limit) => this.deps.repos.memories.searchPatternIds(input.compiledQuery.patternTerms, scoped, limit, layer === "Skill")));
        }
        if (layer === "Skill" && importedBodyTerms.length > 0) {
          // Both imported routes share actual coverage, so a time-ranked legacy
          // pattern hit cannot overwrite the body route's relevance evidence.
          if (input.compiledQuery.patternTerms.length > 0) {
            addRoute(() => this.deps.repos.memories.searchImportedSkillPatternIds(importedBodyTerms, filter, keywordPool));
          }
          addRoute(() => this.deps.repos.memories.searchImportedSkillBodyIds(importedBodyTerms, filter, keywordPool));
        }
        if (layer === "L1" && input.compiledQuery.structuralFragments.length > 0) {
          addRoute(() => refill(filter, Math.max(input.config.tier2TopK, 10), "structural", (scoped, limit) =>
            this.deps.repos.memories.searchStructuralIds(input.compiledQuery.structuralFragments, scoped, limit)));
        }
      }
      return routeTasks;
    };

    const routeTasks = collectRoutes(input.layers, 0);
    if (input.targetSkillId && input.layers.includes("Skill")) {
      const target = this.deps.repos.memories.list(skillFilter, 1)[0];
      if (target) routeTasks.push(Promise.resolve([{ id: target.id, score: 1, channel: "vec" }]));
    }
    if (routeTasks.length === 0) {
      return { memories: [], channelScoresByMemory: new Map(), diagnostics };
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
    const grouped = this.groupImportedSkillsByName(await loadHits(routeTasks), channelScoresByMemory, skillFilter, takenNames);
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
        skillFilter,
        takenNames
      );
      readyMemories = [...readyMemories, ...refill.memories];
      if (seenIds.size === seenBefore) break;
      removed += refill.removed;
      lastRemoved = refill.removed;
    }
    return { ...deduplicateCrossAccountMemoryCandidates({
      memories: readyMemories,
      repos: this.deps.repos,
      preferredUserId: input.userId,
      resolveSourceKey,
      channelScoresByMemory
    }), diagnostics};
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
    filter: MemoryFilter,
    takenNames: Set<string>
  ): { memories: MemoryRow[]; removed: number } {
    const currentAgentId = filter.excludedImportedSkillSourceAgentId;
    const named = memories.filter((memory) => isImportedSkill(memory) && importedSkillName(memory));
    if (named.length === 0) return { memories: [...memories], removed: 0 };
    const installed = currentAgentId ? this.deps.repos.listInstalledSkillNamesForAgent(currentAgentId) : new Set<string>();
    const names = dedupeStrings(named.map((memory) => importedSkillName(memory)!))
      .filter((name) => !installed.has(name) && !takenNames.has(name));
    const latest = this.deps.repos.memories.latestImportedSkillsByName(names, filter);
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
      const chosenId = latest.get(name) ?? memory.id;
      const eligible = this.deps.repos.memories.list({ ...filter, ids: [chosenId, memory.id] }, 2)
        .filter(candidate => this.isMemoryReadyForRetrieval(candidate) && this.isSkillVisibleToAgent(candidate, currentAgentId));
      const usable = eligible.find(candidate => candidate.id === chosenId) ?? eligible[0];
      if (!usable) {
        removed += 1;
        continue;
      }
      takenNames.add(name);
      channelScoresByMemory.set(usable.id, groupScores.get(name) ?? channelScoresByMemory.get(usable.id) ?? {});
      kept.push(usable);
    }
    return { memories: kept, removed };
  }

  private isSkillVisibleToAgent(memory: MemoryRow, currentAgentId?: string): boolean {
    if (memory.memoryLayer !== "Skill") return true;
    const internal = memory.properties.internal_info;
    if (!isImportedSkill(memory)) return true;
    if (!this.deps.repos.isImportedSkillEligibleForEmbedding(memory)) return false;
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

function importedSkillName(memory: MemoryRow): string | undefined {
  const internal = memory.properties.internal_info;
  if (typeof internal.normalized_name === "string" && internal.normalized_name) return internal.normalized_name;
  const name = typeof internal.name === "string" ? internal.name : typeof memory.info.title === "string" ? memory.info.title : "";
  return normalizeSkillName(name) || undefined;
}
