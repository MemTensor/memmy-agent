import type { MemmyConfig } from "../../config/index.js";
import { isRecord } from "../../utils/json.js";
import type { StorageBackendCapabilities } from "../../storage/backend.js";
import type {
  ApiLogRecord,
  AuditLogRecord,
  ChangeLogRecord,
  EmbeddingRetryRecord,
  EmbeddingRetryStatus,
  EpisodeRecord,
  EvolutionJobRecord,
  RawTurnRecord,
  Repositories
} from "../../storage/repositories.js";
import { detailSummaryForMemory, sourceMemoryIdsFromMemory } from "./memory.js";
import {
  memoryFilterForNamespace,
  namespaceForMemory,
  namespaceForSession,
  namespaceIdFromContext,
  normalizeNamespace,
  sameProjectScope
} from "../namespace/namespace-scope.js";
import type {
  HealthResponse,
  MemoryFilter,
  MemoryKind,
  MemoryLayer,
  MemoryListItem,
  RawTurnSummary,
  RequestEnvelope,
  RuntimeNamespace
} from "../../types.js";
import { nowIso } from "../../utils/time.js";
import {
  panelAverage,
  panelDateKey,
  panelDateKeys,
  panelLastSevenDateKeys,
  panelPercentile95,
  panelRecallScore,
  panelRoundDecimal,
  panelRoundInt,
  panelToolLatency
} from "./model-costs.js";
import {
  panelCountByDate,
  panelListItemFromMemory,
  panelNamespaceDistribution,
  panelSourceDistribution
} from "./panel.js";

const PANEL_ITEMS_PAGE_SIZE = 20;
const PANEL_DAILY_ACTIVITY_DAYS = 371;

type PanelChange = {
  seq: number;
  op: "created" | "updated" | "archived" | "deleted";
  kind: MemoryKind | "session" | "episode" | "job" | "feedback" | "raw_turn" | "repair" | "skill_trial" | "recall" | "artifact";
  id: string;
  version?: number;
  source: "turn_complete" | "feedback" | "worker" | "panel" | "system";
  updatedAt: string;
};

/**
 * Boundary dependencies for the panel read model.  This keeps the model free of
 * a reverse dependency on MemoryService while retaining the service's existing
 * serialization, health, cursor, and configuration behavior.
 */
export interface PanelReadModelDependencies {
  repos: Repositories;
  config: () => MemmyConfig;
  storageCapabilities: () => StorageBackendCapabilities;
  schemaVersion: () => { version: number; lastMigrationId?: string };
  health: (routes?: string[]) => HealthResponse;
  models: () => HealthResponse["models"];
  resolveContext: (request: RequestEnvelope & { sessionId?: string; userId?: string }) => {
    userId: string;
    conversationId?: string;
    namespace: RuntimeNamespace;
  };
  encodeChangeCursor: (seq: number, namespace?: RuntimeNamespace) => string;
  decodeChangeCursor: (cursor: string | undefined, namespace?: RuntimeNamespace) => number;
  episodeRef: (episode: EpisodeRecord) => Record<string, unknown>;
  rawTurnSummary: (rawTurn: RawTurnRecord) => RawTurnSummary;
  now?: () => string;
}

export class PanelReadModel {
  private readonly now: () => string;

  constructor(private readonly deps: PanelReadModelDependencies) {
    this.now = deps.now ?? nowIso;
  }

  auditLogs(input: RequestEnvelope & {
    userId?: string;
    targetKind?: string;
    targetId?: string;
    limit?: number;
  } = {}): {
    items: ReturnType<Repositories["runtime"]["listAudit"]>;
    serverTime: string;
  } {
    const context = this.deps.resolveContext(input);
    const limit = input.limit ?? 50;
    const items = this.deps.repos.runtime.listAudit({
      userId: input.userId ?? context.userId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      limit: input.namespace ? 10_000 : limit
    }).filter((audit) => this.auditMatchesNamespace(audit, input.namespace ? context.namespace : undefined))
      .slice(0, limit);
    return {
      items,
      serverTime: this.now()
    };
  }

  serviceLogs(input: RequestEnvelope & {
    userId?: string;
    limit?: number;
    cursor?: string;
  } = {}): {
    cursor: string;
    entries: Array<{
      type: "change" | "audit" | "job";
      id: string;
      at: string;
      userId?: string;
      action: string;
      targetKind?: string;
      targetId?: string;
      source?: string;
      payload?: unknown;
    }>;
    changes: PanelChange[];
    audits: ReturnType<Repositories["runtime"]["listAudit"]>;
    jobs: EvolutionJobRecord[];
    serverTime: string;
  } {
    const limit = input.limit ?? 50;
    const changes = this.panelChanges({
      namespace: input.namespace,
      limit,
      cursor: input.cursor
    });
    const audits = this.auditLogs({ ...input, limit }).items;
    const jobs = [
      ...this.scopedJobs("failed", input, limit),
      ...this.scopedJobs("dead_letter", input, limit)
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit);
    const entries = [
      ...changes.items.map((change) => ({
        type: "change" as const,
        id: String(change.seq),
        at: change.createdAt,
        userId: change.userId,
        action: `${change.kind}.${change.op}`,
        targetKind: change.kind,
        targetId: change.entityId,
        source: change.source,
        payload: changeLogToPanelChange(change)
      })),
      ...audits.map((audit) => ({
        type: "audit" as const,
        id: audit.id,
        at: audit.createdAt,
        userId: audit.userId,
        action: audit.action,
        targetKind: audit.targetKind,
        targetId: audit.targetId,
        source: "audit",
        payload: audit
      })),
      ...jobs.map((job) => ({
        type: "job" as const,
        id: job.id,
        at: job.updatedAt,
        userId: job.userId,
        action: `job.${job.status}`,
        targetKind: job.jobType,
        targetId: job.targetMemoryId,
        source: "worker",
        payload: job
      }))
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
    return {
      cursor: changes.cursor,
      entries,
      changes: changes.changes,
      audits,
      jobs,
      serverTime: this.now()
    };
  }

  apiLogs(input: RequestEnvelope & {
    tools?: Array<"memory_add" | "memory_search" | "skill_generate" | "skill_evolve">;
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    limit?: number;
    offset?: number;
  } = {}): {
    logs: ReturnType<Repositories["runtime"]["listApiLogs"]>["logs"];
    total: number;
    limit: number;
    offset: number;
    nextOffset?: number;
    serverTime: string;
  } {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    const offset = Math.max(0, input.offset ?? 0);
    const queryLimit = input.namespace ? 10_000 : limit;
    const result = this.deps.repos.runtime.listApiLogs({
      toolNames: input.tools,
      sourceAgent: input.sourceAgent,
      excludedSourceAgents: input.excludedSourceAgents,
      limit: queryLimit,
      offset: input.namespace ? 0 : offset
    });
    const context = input.namespace ? this.deps.resolveContext(input) : undefined;
    const scopedLogs = context
      ? result.logs.filter((log) => this.apiLogMatchesNamespace(log, context.namespace))
      : result.logs;
    const logs = input.namespace ? scopedLogs.slice(offset, offset + limit) : scopedLogs;
    const total = input.namespace ? scopedLogs.length : result.total;
    return {
      logs: logs.map((log) => this.withCurrentTraceSummaries(log)),
      total,
      limit,
      offset,
      nextOffset: offset + logs.length < total ? offset + logs.length : undefined,
      serverTime: this.now()
    };
  }

  private withCurrentTraceSummaries(log: ApiLogRecord): ApiLogRecord {
    if (log.toolName !== "memory_add") return log;

    try {
      const output = JSON.parse(log.outputJson) as unknown;
      if (!isRecord(output) || !Array.isArray(output.details)) return log;

      let changed = false;
      const details = output.details.map((detail) => {
        if (!isRecord(detail) || (detail.role !== "trace" && detail.role !== "span")) return detail;
        const memoryId = typeof (detail.role === "span" ? detail.spanId : detail.traceId) === "string"
          ? detail.role === "span" ? detail.spanId : detail.traceId
          : detail.traceId;
        if (typeof memoryId !== "string") return detail;
        const memory = this.deps.repos.memories.get(memoryId);
        const spanGoal = memory && detail.role === "span"
          ? this.spanGoalForMemory(memory)
          : undefined;
        const summary = memory && detail.role === "trace" ? detailSummaryForMemory(memory) : undefined;
        const key = detail.role === "span" ? "spanGoal" : "summary";
        const value = spanGoal ?? summary;
        if (!value || detail[key] === value) return detail;
        changed = true;
        return { ...detail, [key]: value };
      });

      return changed ? { ...log, outputJson: JSON.stringify({ ...output, details }) } : log;
    } catch {
      return log;
    }
  }

  private spanGoalForMemory(memory: Parameters<typeof detailSummaryForMemory>[0]): string | undefined {
    const span = isRecord(memory.properties.internal_info.span) ? memory.properties.internal_info.span : undefined;
    const goal = span?.span_goal;
    return typeof goal === "string" && goal.trim() ? goal.trim() : undefined;
  }

  serviceMetrics(input: RequestEnvelope & { userId?: string } = {}): {
    storage: StorageBackendCapabilities;
    schema: { version: number; lastMigrationId?: string };
    memory: ReturnType<PanelReadModel["panelOverview"]>["stats"];
    changeSeq: number;
    feedback: { recent: number };
    jobs: Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number>;
    embeddingRetries: Record<"pending" | "in_progress" | "succeeded" | "failed", number>;
    models: HealthResponse["models"];
    serverTime: string;
  } {
    const overview = this.panelOverview(input);
    return {
      storage: this.deps.storageCapabilities(),
      schema: this.deps.schemaVersion(),
      memory: overview.stats,
      changeSeq: overview.latestChangeSeq,
      feedback: {
        recent: this.deps.repos.runtime.listFeedback({ limit: 1000 })
          .filter((feedback) => this.entityReferencesNamespace(feedback, input.namespace)).length
      },
      jobs: overview.stats.jobs,
      embeddingRetries: overview.stats.embeddingRetries,
      models: this.deps.models(),
      serverTime: this.now()
    };
  }

  adminStatus(input: RequestEnvelope & { userId?: string } = {}, routes: string[] = []): {
    health: HealthResponse;
    overview: ReturnType<PanelReadModel["panelOverview"]>;
    failedJobs: EvolutionJobRecord[];
    deadLetterJobs: EvolutionJobRecord[];
    serverTime: string;
  } {
    const failedJobs = this.scopedJobs("failed", input, 20);
    const deadLetterJobs = this.scopedJobs("dead_letter", input, 20);
    return {
      health: this.deps.health(routes),
      overview: this.panelOverview(input),
      failedJobs,
      deadLetterJobs,
      serverTime: this.now()
    };
  }

  configStatus(_input: RequestEnvelope = {}): {
    version: number;
    config: MemmyConfig;
    redacted: boolean;
    serverTime: string;
  } {
    const config = this.deps.config();
    return {
      version: config.version,
      config: redactConfig(config) as MemmyConfig,
      redacted: true,
      serverTime: this.now()
    };
  }

  panelOverview(input: RequestEnvelope & { userId?: string } = {}): {
    stats: {
      byLayer: Record<MemoryLayer, number>;
      byStatus: Record<"activated" | "resolving" | "archived" | "deleted", number>;
      episodes: Record<"open" | "processing" | "closed", number>;
      jobs: Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number>;
      embeddingRetries: Record<"pending" | "in_progress" | "succeeded" | "failed", number>;
      lastChangeSeq?: number;
    };
    counts: Record<MemoryLayer, number>;
    queuedJobs: number;
    latestChangeSeq: number;
    cursor: string;
    etag: string;
    serverTime: string;
  } {
    const memories = this.listAllMemoriesForStats(input);
    const byLayer = this.memoryLayerCounts(memories);
    const byStatus = this.memoryStatusCounts(memories);
    const context = input.namespace ? this.deps.resolveContext(input) : undefined;
    const namespaceId = context ? namespaceIdFromContext(context.namespace) : undefined;
    const userId = input.userId ?? context?.userId;
    const latestChangeSeq = this.deps.repos.runtime.latestChangeSeq(userId, namespaceId);
    const jobs = this.jobStatusCounts(input);
    const embeddingRetries = this.embeddingRetryStatusCounts(input);
    return {
      stats: {
        byLayer,
        byStatus,
        episodes: this.episodeStatusCounts(input),
        jobs,
        embeddingRetries,
        lastChangeSeq: latestChangeSeq || undefined
      },
      counts: byLayer,
      queuedJobs: jobs.queued,
      latestChangeSeq,
      cursor: this.deps.encodeChangeCursor(latestChangeSeq, context?.namespace),
      etag: `panel-overview-v${latestChangeSeq}`,
      serverTime: this.now()
    };
  }

  panelOverviewSummary(input: RequestEnvelope & { userId?: string } = {}): {
    counts: { memories: number; skills: number; experiences: number; worldModels: number };
    layerCounts: Record<MemoryLayer, number>;
    sourceDistribution: Array<{ source: string; count: number; percentage: number }>;
    namespaceDistribution: Array<{ tenantId: string; projectId: string; workspaceId?: string; workspacePath?: string; label: string; count: number; percentage: number }>;
    dailyActivity: Array<{ date: string; count: number }>;
  } {
    const memories = this.listAllMemoriesForStats(input);
    const dates = panelDateKeys(this.now(), PANEL_DAILY_ACTIVITY_DAYS);
    return {
      counts: {
        memories: memories.filter((memory) => memory.memoryLayer === "L1").length,
        skills: memories.filter((memory) => memory.memoryLayer === "Skill").length,
        experiences: memories.filter((memory) => memory.memoryLayer === "L2").length,
        worldModels: memories.filter((memory) => memory.memoryLayer === "L3").length
      },
      layerCounts: this.memoryLayerCounts(memories),
      dailyActivity: panelCountByDate(memories, dates, (memory) => memory.createdAt),
      sourceDistribution: panelSourceDistribution(memories),
      namespaceDistribution: panelNamespaceDistribution(memories, (memory) =>
        memory.sessionId ? this.deps.repos.runtime.getSession(memory.sessionId) : undefined
      )
    };
  }

  evolutionOverview(input: RequestEnvelope & { userId?: string } = {}): {
    layers: Array<{
      layer: MemoryLayer;
      count: number;
      candidates: number;
      failed: number;
      queued: number;
      recentJob?: EvolutionJobRecord;
    }>;
    l2Resolving: { active: boolean; count: number; reason: string };
    recentJobs: EvolutionJobRecord[];
    serverTime: string;
  } {
    const memories = this.listAllMemoriesForStats(input);
    const candidates = this.deps.repos.runtime.listPendingCandidatePool({
      userId: input.userId,
      now: this.now(),
      limit: 10_000
    }).filter((candidate) => {
      const memory = this.deps.repos.memories.get(candidate.sourceMemoryId);
      return Boolean(memory && this.memoryMatchesRequest(memory, input));
    });
    const recentJobs = this.scopedJobs(undefined, input, 200);
    const jobLayers: Record<MemoryLayer, EvolutionJobRecord["jobType"][]> = {
      L1: ["trace_summary", "import_summary", "reflection", "reward", "span_big_turn", "negative_experience", "embedding"],
      L2: ["l2_association", "l2_induction"],
      L3: ["l3_abstraction"],
      Skill: ["skill_crystallization", "skill_trial_resolve"]
    };
    const layers = (["L1", "L2", "L3", "Skill"] as const).map((layer) => {
      const jobs = recentJobs.filter((job) => jobLayers[layer].includes(job.jobType));
      return {
        layer,
        count: memories.filter((memory) => memory.memoryLayer === layer).length,
        candidates: layer === "L2"
          ? candidates.length
          : memories.filter((memory) => memory.memoryLayer === layer && memory.status === "resolving").length,
        failed: jobs.filter((job) => job.status === "failed" || job.status === "dead_letter").length,
        queued: jobs.filter((job) => job.status === "queued" || job.status === "leased").length,
        recentJob: jobs[0]
      };
    });
    const resolvingCount = memories.filter((memory) => memory.memoryLayer === "L2" && memory.status === "resolving").length;
    const eligibleEpisodes = new Set(candidates.map((candidate) =>
      isRecord(candidate.evidence) && typeof candidate.evidence.episodeId === "string"
        ? candidate.evidence.episodeId
        : undefined
    ).filter(Boolean)).size;
    const requiredEpisodes = this.deps.config().algorithm.l2Induction.minEpisodesForInduction;
    const reason = resolvingCount > 0
      ? `${resolvingCount} 条 L2 候选正在等待支持度、增益或试验门槛`
      : candidates.length === 0
      ? "没有符合价值与向量条件的 L1 候选"
      : eligibleEpisodes < requiredEpisodes
      ? `候选证据不足：${eligibleEpisodes}/${requiredEpisodes} 个独立 episode`
      : "候选已就绪，等待 l2_induction worker job";
    return {
      layers,
      l2Resolving: { active: resolvingCount > 0, count: resolvingCount, reason },
      recentJobs: recentJobs.slice(0, 10),
      serverTime: this.now()
    };
  }

  namespaceAudit(input: RequestEnvelope & { userId?: string } = {}): {
    summary: {
      total: number;
      missingWorkspace: number;
      unknownSource: number;
      missingAgentSourceTag: number;
      crossWorkspaceRisk: number;
    };
    issues: Array<{ memoryId: string; issue: string; severity: "warning" | "risk"; projectId?: string; workspaceId?: string; source?: string }>;
    serverTime: string;
  } {
    const memories = this.listAllMemoriesForStats(input);
    const issues: Array<{ memoryId: string; issue: string; severity: "warning" | "risk"; projectId?: string; workspaceId?: string; source?: string }> = [];
    let missingWorkspace = 0;
    let unknownSource = 0;
    let missingAgentSourceTag = 0;
    let crossWorkspaceRisk = 0;
    for (const memory of memories) {
      const namespace = namespaceForMemory(memory);
      const source = memory.agentId || (typeof memory.info.source === "string" ? memory.info.source : undefined) || "unknown";
      if (!namespace.workspaceId && !namespace.workspacePath) {
        missingWorkspace += 1;
        issues.push({ memoryId: memory.id, issue: "missing_workspace", severity: "risk", projectId: namespace.projectId, source });
      }
      if (source === "unknown") {
        unknownSource += 1;
        issues.push({ memoryId: memory.id, issue: "unknown_source", severity: "warning", projectId: namespace.projectId, workspaceId: namespace.workspaceId, source });
      }
      if (source !== "unknown" && !memory.tags.includes("agent-source")) {
        missingAgentSourceTag += 1;
        issues.push({ memoryId: memory.id, issue: "missing_agent_source_tag", severity: "warning", projectId: namespace.projectId, workspaceId: namespace.workspaceId, source });
      }
      if (memory.sessionId) {
        const session = this.deps.repos.runtime.getSession(memory.sessionId);
        if (session && namespace.workspaceId && session.workspaceId && namespace.workspaceId !== session.workspaceId) {
          crossWorkspaceRisk += 1;
          issues.push({ memoryId: memory.id, issue: "workspace_mismatch", severity: "risk", projectId: namespace.projectId, workspaceId: namespace.workspaceId, source });
        }
      }
    }
    return {
      summary: { total: memories.length, missingWorkspace, unknownSource, missingAgentSourceTag, crossWorkspaceRisk: crossWorkspaceRisk + missingWorkspace },
      issues: issues.slice(0, 500),
      serverTime: this.now()
    };
  }

  projectContextPack(input: RequestEnvelope & { userId?: string } = {}): {
    namespace: RuntimeNamespace;
    conventions: MemoryListItem[];
    commands: MemoryListItem[];
    architectureFacts: MemoryListItem[];
    recentTasks: Array<{ id: string; title: string; updatedAt: string }>;
    userPreferences: MemoryListItem[];
    graph: {
      nodes: Array<MemoryListItem & { external?: boolean }>;
      edges: Array<{ sourceId: string; targetId: string; relation: "source" | "supersedes"; reason?: string }>;
    };
    markdown: string;
    generatedAt: string;
  } {
    const context = this.deps.resolveContext(input);
    const memories = this.listAllMemoriesForStats({ ...input, namespace: context.namespace })
      .filter((memory) => memory.status === "activated" || memory.status === "resolving");
    const select = (pattern: RegExp, limit = 8) => memories
      .filter((memory) => pattern.test(`${memory.tags.join(" ")} ${detailSummaryForMemory(memory)} ${memory.memoryValue}`))
      .slice(0, limit)
      .map((memory) => this.deps.repos.memories.toListItem(memory));
    const conventions = select(/convention|约定|规范|rule|必须|should/i);
    const commands = select(/command|命令|npm |pnpm |yarn |cargo |pytest|docker |git /i);
    const architectureFacts = select(/architecture|架构|module|模块|service|database|repository|api/i);
    const userPreferences = select(/preference|偏好|喜欢|不喜欢|prefer/i);
    const recentTasks = this.deps.repos.runtime.listEpisodes(context.userId, 20)
      .filter((episode) => this.episodeMatchesNamespace(episode, context.namespace))
      .slice(0, 8)
      .map((episode) => ({ id: episode.id, title: String(this.deps.episodeRef(episode).title ?? this.deps.episodeRef(episode).summary ?? episode.id), updatedAt: episode.updatedAt }));
    const selectedIds = new Set([...conventions, ...commands, ...architectureFacts, ...userPreferences].map((item) => item.id));
    const selectedMemories = memories.filter((memory) => selectedIds.has(memory.id));
    const edges = selectedMemories.flatMap((memory) => [
      ...sourceMemoryIdsFromMemory(memory).map((sourceId) => ({ sourceId, targetId: memory.id, relation: "source" as const })),
      ...this.deps.repos.memories.relationsFor(memory.id).map((relation) => ({ sourceId: relation.sourceMemoryId, targetId: relation.targetMemoryId, relation: "supersedes" as const, reason: relation.reason }))
    ]).filter((edge, index, all) => all.findIndex((item) => item.sourceId === edge.sourceId && item.targetId === edge.targetId && item.relation === edge.relation) === index);
    const graphIds = new Set([...selectedIds, ...edges.flatMap((edge) => [edge.sourceId, edge.targetId])]);
    const graphNodes = this.deps.repos.memories.getMany([...graphIds]).map((memory) => ({
      ...this.deps.repos.memories.toListItem(memory),
      ...(selectedIds.has(memory.id) ? {} : { external: true })
    }));
    const section = (title: string, items: MemoryListItem[]) => `## ${title}\n${items.length ? items.map((item) => `- ${item.summary || item.title} (${item.id})`).join("\n") : "- 暂无"}`;
    const markdown = [
      `# Project Memory Pack: ${context.namespace.projectId ?? context.namespace.workspaceId ?? "unscoped"}`,
      section("当前项目约定", conventions),
      section("常用命令", commands),
      section("架构事实", architectureFacts),
      `## 最近任务\n${recentTasks.length ? recentTasks.map((task) => `- ${task.title} (${task.id})`).join("\n") : "- 暂无"}`,
      section("用户偏好", userPreferences)
    ].join("\n\n");
    return { namespace: context.namespace, conventions, commands, architectureFacts, recentTasks, userPreferences, graph: { nodes: graphNodes, edges }, markdown, generatedAt: this.now() };
  }

  projectContextPacks(input: RequestEnvelope & { userId?: string } = {}) {
    if (input.namespace) return { packs: [this.projectContextPack(input)], generatedAt: this.now() };
    const memories = this.listAllMemoriesForStats(input);
    const namespaces = new Map<string, RuntimeNamespace>();
    for (const memory of memories) {
      const namespace = namespaceForMemory(memory);
      const key = `${namespace.tenantId ?? "local"}:${namespace.projectId ?? "unscoped"}:${namespace.workspaceId ?? namespace.workspacePath ?? ""}`;
      namespaces.set(key, namespace);
    }
    return {
      packs: [...namespaces.values()].map((namespace) => this.projectContextPack({ ...input, namespace })),
      generatedAt: this.now()
    };
  }

  panelAnalysis(input: RequestEnvelope & { userId?: string } = {}): {
    metrics: {
      avgRecallScore: number;
      recallEvents: number;
      activeSkills: number;
      recentlyUsedSkills: number;
      avgToolLatencyMs: number;
      p95ToolLatencyMs: number;
    };
    dailyMemoryWrites: Array<{ date: string; count: number }>;
    dailySkillEvolutions: Array<{ date: string; count: number }>;
    toolLatency: {
      tools: Array<{ name: string; calls: number; avgMs: number; p95Ms: number }>;
      series: Array<{ name: string; points: Array<{ date: string; avgMs: number }> }>;
    };
  } {
    const dates = panelLastSevenDateKeys(this.now());
    const memories = this.listAllMemoriesForStats(input);
    const skillMemories = memories.filter((memory) => memory.memoryLayer === "Skill");
    const logs = this.apiLogs({ ...input, limit: 10_000, offset: 0 }).logs
      .filter((log) => dates.includes(panelDateKey(log.calledAt)));
    const recallScores = logs
      .filter((log) => log.toolName === "memory_search")
      .map((log) => panelRecallScore(log.outputJson))
      .filter((score): score is number => score !== undefined);
    const durations = logs.map((log) => Math.max(0, Math.round(log.durationMs)));
    return {
      metrics: {
        avgRecallScore: panelRoundDecimal(panelAverage(recallScores), 2),
        recallEvents: logs.filter((log) => log.toolName === "memory_search").length,
        activeSkills: skillMemories.filter((memory) => memory.status === "activated").length,
        recentlyUsedSkills: skillMemories.filter((memory) => dates.includes(panelDateKey(memory.updatedAt))).length,
        avgToolLatencyMs: panelRoundInt(panelAverage(durations)),
        p95ToolLatencyMs: panelPercentile95(durations)
      },
      dailyMemoryWrites: panelCountByDate(memories, dates, (memory) => memory.createdAt),
      dailySkillEvolutions: panelCountByDate(skillMemories, dates, (memory) => memory.updatedAt),
      toolLatency: panelToolLatency(logs, dates)
    };
  }

  panelItems(input: RequestEnvelope & {
    userId?: string;
    layer?: MemoryLayer;
    status?: "activated" | "resolving" | "archived" | "deleted";
    q?: string;
    tags?: string[];
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    projectId?: string;
    workspaceId?: string;
    page?: number;
    limit?: number;
    cursor?: string | number;
  }): {
    items: MemoryListItem[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    etag: string;
    nextCursor?: string;
    serverTime: string;
  } {
    const pageSize = normalizePanelItemsLimit(input.limit);
    const filter: MemoryFilter = {
      ...(input.namespace ? memoryFilterForNamespace(input.namespace) : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      memoryLayer: input.layer,
      status: input.status,
      tags: input.tags,
      agentId: input.sourceAgent,
      excludedAgentIds: input.excludedSourceAgents,
      ...(input.namespace ? {} : {
        projectId: input.projectId,
        workspaceId: input.workspaceId
      })
    };
    const total = input.q?.trim()
      ? this.deps.repos.memories.searchCount(input.q, { ...filter, status: filter.status ?? ["activated", "resolving"] })
      : this.deps.repos.memories.count(filter);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = normalizePageNumber(input.page);
    const page = Math.min(requestedPage, totalPages);
    const offset = normalizeOffsetCursor(input.cursor) ?? ((page - 1) * pageSize);
    const memories = input.q?.trim()
      ? this.deps.repos.memories.getMany(this.deps.repos.memories.searchPanelIds(
          input.q,
          { ...filter, status: filter.status ?? ["activated", "resolving"] },
          pageSize,
          offset
        ).map((hit) => hit.id))
      : this.deps.repos.memories.list(filter, pageSize, offset);
    return {
      items: memories.map((memory) => panelListItemFromMemory(
        this.deps.repos.memories.toListItem(memory),
        memory,
        this.deps.repos.processing.get(memory.id),
        memory.sessionId ? this.deps.repos.runtime.getSession(memory.sessionId) : undefined
      )),
      page,
      pageSize,
      total,
      totalPages,
      hasNext: offset + memories.length < total,
      hasPrev: offset > 0,
      etag: `panel-items-v${this.deps.repos.runtime.latestChangeSeq()}`,
      nextCursor: offset + memories.length < total ? String(offset + memories.length) : undefined,
      serverTime: this.now()
    };
  }

  panelTasks(input: RequestEnvelope & { q?: string; page?: number }): {
    tasks: Array<{
      id: string;
      episode: Record<string, unknown>;
      memoryIds: string[];
      turns: RawTurnSummary[];
      updatedAt: string;
    }>;
    page: number;
    pageSize: 20;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    serverTime: string;
  } {
    const pageSize = 20 as const;
    const query = input.q?.trim() || undefined;
    const context = input.namespace ? this.deps.resolveContext(input) : undefined;
    const userId = input.namespace?.userId ?? context?.userId;
    const episodes = this.deps.repos.runtime.listEpisodes(userId, 10_000, 0, query)
      .filter((episode) => this.episodeMatchesNamespace(episode, context?.namespace));
    const total = episodes.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(normalizePageNumber(input.page), totalPages);
    const pageEpisodes = episodes.slice((page - 1) * pageSize, page * pageSize);
    return {
      tasks: pageEpisodes.map((episode) => ({
        id: episode.id,
        episode: this.deps.episodeRef(episode),
        memoryIds: episode.l1MemoryIds.filter((memoryId) => Boolean(this.deps.repos.memories.get(memoryId))),
        turns: this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, 1000).map(this.deps.rawTurnSummary),
        updatedAt: episode.updatedAt
      })),
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      serverTime: this.now()
    };
  }

  panelChanges(input: RequestEnvelope & {
    userId?: string;
    limit?: number;
    cursor?: string;
  } = {}): {
    cursor: string;
    changes: PanelChange[];
    hasMore: boolean;
    items: ChangeLogRecord[];
    serverTime: string;
  } {
    const limit = input.limit ?? 50;
    const context = input.namespace ? this.deps.resolveContext(input) : undefined;
    const namespaceId = context ? namespaceIdFromContext(context.namespace) : undefined;
    const userId = input.userId ?? context?.userId;
    const cursorSeq = this.deps.decodeChangeCursor(input.cursor, context?.namespace);
    const items = this.deps.repos.runtime.listChanges(userId, limit, cursorSeq, namespaceId);
    const lastSeq = items.reduce((max, item) => Math.max(max, item.seq), cursorSeq);
    return {
      cursor: this.deps.encodeChangeCursor(lastSeq, context?.namespace),
      changes: items.map(changeLogToPanelChange),
      hasMore: items.length === limit,
      items,
      serverTime: this.now()
    };
  }

  panelJobs(input: RequestEnvelope & {
    userId?: string;
    status?: "queued" | "leased" | "succeeded" | "failed" | "dead_letter";
    limit?: number;
  } = {}): {
    jobs: Array<EvolutionJobRecord & { error?: { code: string; message: string } }>;
    items: EvolutionJobRecord[];
    nextCursor?: string;
    serverTime: string;
  } {
    const items = this.scopedJobs(input.status, input, input.limit ?? 50);
    return {
      jobs: items.map((job) => ({
        ...job,
        error: job.lastError ? { code: "worker_error", message: job.lastError } : undefined
      })),
      items,
      serverTime: this.now()
    };
  }

  private scopedJobs(
    status: EvolutionJobRecord["status"] | undefined,
    input: RequestEnvelope & { userId?: string },
    limit: number
  ): EvolutionJobRecord[] {
    const context = input.namespace ? this.deps.resolveContext(input) : undefined;
    const userId = input.userId ?? context?.userId;
    return this.deps.repos.runtime.listJobs(status, input.namespace ? 10_000 : limit, userId)
      .filter((job) => !userId || job.userId === userId)
      .filter((job) => this.jobMatchesNamespace(job, context?.namespace))
      .slice(0, limit);
  }

  private jobMatchesNamespace(job: EvolutionJobRecord, namespace: RuntimeNamespace | undefined): boolean {
    if (!namespace) return true;
    if (job.sessionId) {
      const session = this.deps.repos.runtime.getSession(job.sessionId);
      if (session) return sameProjectScope(namespaceForSession(session), namespace);
    }
    if (job.episodeId) {
      const episode = this.deps.repos.runtime.getEpisode(job.episodeId);
      if (episode) return this.episodeMatchesNamespace(episode, namespace);
    }
    if (job.targetMemoryId) {
      const memory = this.deps.repos.memories.get(job.targetMemoryId);
      if (memory) return sameProjectScope(namespaceForMemory(memory), namespace);
    }
    return this.entityReferencesNamespace(job.payload, namespace);
  }

  private episodeMatchesNamespace(episode: EpisodeRecord, namespace: RuntimeNamespace | undefined): boolean {
    if (!namespace) return true;
    const session = this.deps.repos.runtime.getSession(episode.sessionId);
    if (session) return sameProjectScope(namespaceForSession(session), namespace);
    return sameProjectScope({
      source: "unknown",
      profileId: "default",
      userId: episode.userId,
      tenantId: "local",
      projectId: episode.projectId
    }, namespace);
  }

  private auditMatchesNamespace(audit: AuditLogRecord, namespace: RuntimeNamespace | undefined): boolean {
    if (!namespace) return true;
    if (audit.sessionId) {
      const session = this.deps.repos.runtime.getSession(audit.sessionId);
      if (session) return sameProjectScope(namespaceForSession(session), namespace);
    }
    if (this.entityReferencesNamespace(audit.actor, namespace)) return true;
    return this.idMatchesNamespace(audit.targetId, namespace) ||
      this.entityReferencesNamespace(audit.after, namespace) ||
      this.entityReferencesNamespace(audit.before, namespace);
  }

  private apiLogMatchesNamespace(log: ApiLogRecord, namespace: RuntimeNamespace): boolean {
    try {
      const input = JSON.parse(log.inputJson) as unknown;
      const output = JSON.parse(log.outputJson) as unknown;
      return this.entityReferencesNamespace(input, namespace) || this.entityReferencesNamespace(output, namespace);
    } catch {
      return false;
    }
  }

  private embeddingRetryMatchesNamespace(retry: EmbeddingRetryRecord, namespace: RuntimeNamespace | undefined): boolean {
    if (!namespace) return true;
    const memory = this.deps.repos.memories.get(retry.targetId);
    return Boolean(memory && sameProjectScope(namespaceForMemory(memory), namespace));
  }

  private entityReferencesNamespace(value: unknown, namespace: RuntimeNamespace | undefined): boolean {
    if (!namespace) return true;
    if (!isRecord(value)) return false;
    const embedded = isRecord(value.namespace) ? value.namespace : value;
    const embeddedNamespace = runtimeNamespaceFromRecord(embedded);
    if (embeddedNamespace && sameProjectScope(embeddedNamespace, namespace)) return true;

    for (const key of ["sessionId", "session_id", "episodeId", "episode_id", "rawTurnId", "raw_turn_id", "memoryId", "memory_id", "targetMemoryId", "target_memory_id", "traceId", "trace_id", "spanId", "span_id"]) {
      const id = value[key];
      if (typeof id === "string" && this.idMatchesNamespace(id, namespace)) return true;
    }
    for (const key of ["details", "candidates", "filtered", "items"]) {
      const entries = value[key];
      if (Array.isArray(entries) && entries.some((entry) => this.entityReferencesNamespace(entry, namespace))) return true;
    }
    return false;
  }

  private idMatchesNamespace(id: string, namespace: RuntimeNamespace): boolean {
    const session = this.deps.repos.runtime.getSession(id);
    if (session) return sameProjectScope(namespaceForSession(session), namespace);
    const episode = this.deps.repos.runtime.getEpisode(id);
    if (episode) return this.episodeMatchesNamespace(episode, namespace);
    const rawTurn = this.deps.repos.runtime.getRawTurn(id);
    if (rawTurn) {
      const rawSession = this.deps.repos.runtime.getSession(rawTurn.sessionId);
      return Boolean(rawSession && sameProjectScope(namespaceForSession(rawSession), namespace));
    }
    const memory = this.deps.repos.memories.get(id);
    return Boolean(memory && sameProjectScope(namespaceForMemory(memory), namespace));
  }

  private jobStatusCounts(input: RequestEnvelope & { userId?: string }): Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number> {
    return {
      queued: this.scopedJobs("queued", input, 10_000).length,
      leased: this.scopedJobs("leased", input, 10_000).length,
      succeeded: this.scopedJobs("succeeded", input, 10_000).length,
      failed: this.scopedJobs("failed", input, 10_000).length,
      dead_letter: this.scopedJobs("dead_letter", input, 10_000).length
    };
  }

  private memoryLayerCounts(memories: ReturnType<Repositories["memories"]["list"]>): Record<MemoryLayer, number> {
    return {
      L1: memories.filter((memory) => memory.memoryLayer === "L1").length,
      L2: memories.filter((memory) => memory.memoryLayer === "L2").length,
      L3: memories.filter((memory) => memory.memoryLayer === "L3").length,
      Skill: memories.filter((memory) => memory.memoryLayer === "Skill").length
    };
  }

  private memoryStatusCounts(memories: ReturnType<Repositories["memories"]["list"]>): Record<"activated" | "resolving" | "archived" | "deleted", number> {
    return {
      activated: memories.filter((memory) => memory.status === "activated").length,
      resolving: memories.filter((memory) => memory.status === "resolving").length,
      archived: memories.filter((memory) => memory.status === "archived").length,
      deleted: memories.filter((memory) => memory.status === "deleted").length
    };
  }

  private episodeStatusCounts(input: RequestEnvelope & { userId?: string }): Record<"open" | "processing" | "closed", number> {
    const context = input.namespace ? this.deps.resolveContext(input) : undefined;
    const episodes = this.deps.repos.runtime.listEpisodes(input.userId ?? context?.userId, 10_000)
      .filter((episode) => this.episodeMatchesNamespace(episode, context?.namespace));
    return {
      open: episodes.filter((episode) => episode.status === "open").length,
      processing: episodes.filter((episode) => episode.status === "processing").length,
      closed: episodes.filter((episode) => episode.status === "closed").length
    };
  }

  private embeddingRetryStatusCounts(input: RequestEnvelope & { userId?: string }): Record<"pending" | "in_progress" | "succeeded" | "failed", number> {
    const statuses: EmbeddingRetryStatus[] = ["pending", "in_progress", "succeeded", "failed"];
    const counts = { pending: 0, in_progress: 0, succeeded: 0, failed: 0 };
    for (const status of statuses) {
      counts[status] = this.deps.repos.runtime.listEmbeddingRetries(status, 10_000, input.userId)
        .filter((retry) => this.embeddingRetryMatchesNamespace(retry, input.namespace)).length;
    }
    return counts;
  }

  private listAllMemoriesForStats(input: RequestEnvelope & { userId?: string } = {}) {
    const rows = [] as ReturnType<Repositories["memories"]["list"]>;
    const pageSize = 1000;
    const context = input.namespace ? this.deps.resolveContext(input) : undefined;
    const filter: MemoryFilter = {
      ...(context ? memoryFilterForNamespace(context.namespace) : {}),
      ...(input.userId ?? context?.userId ? { userId: input.userId ?? context?.userId } : {})
    };
    for (let offset = 0;; offset += pageSize) {
      const batch = this.deps.repos.memories.list(filter, pageSize, offset);
      rows.push(...batch);
      if (batch.length < pageSize) break;
    }
    return rows;
  }

  private memoryMatchesRequest(memory: Parameters<Repositories["memories"]["toListItem"]>[0], input: RequestEnvelope & { userId?: string }): boolean {
    if (input.userId && memory.userId !== input.userId) return false;
    return !input.namespace || sameProjectScope(namespaceForMemory(memory), input.namespace);
  }
}

function runtimeNamespaceFromRecord(value: Record<string, unknown>): RuntimeNamespace | undefined {
  const stringValue = (key: string): string | undefined => typeof value[key] === "string" ? value[key] as string : undefined;
  const projectId = stringValue("projectId") ?? stringValue("project_id");
  const workspaceId = stringValue("workspaceId") ?? stringValue("workspace_id");
  const workspacePath = stringValue("workspacePath") ?? stringValue("workspace_path");
  const tenantId = stringValue("tenantId") ?? stringValue("tenant_id");
  if (!projectId && !workspaceId && !workspacePath && !tenantId) return undefined;
  return normalizeNamespace({
    source: stringValue("source") ?? "unknown",
    profileId: stringValue("profileId") ?? stringValue("profile_id") ?? "default",
    userId: stringValue("userId") ?? stringValue("user_id"),
    tenantId,
    projectId,
    workspaceId,
    workspacePath
  });
}

export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(value)) {
    out[key] = /token|apiKey|secret|password/i.test(key)
      ? typeof next === "string" && next ? "[redacted]" : next
      : redactConfig(next);
  }
  return out;
}

export function changeLogToPanelChange(change: ChangeLogRecord): PanelChange {
  return {
    seq: change.seq,
    op: normalizeChangeOp(change.op) ?? changeOp(change.changeType),
    kind: normalizeChangeKind(change.kind) ?? changeKind(change),
    id: change.entityId ?? change.memoryId,
    version: change.version ?? versionFromChange(change),
    source: changeSource(change.source),
    updatedAt: change.createdAt
  };
}

function normalizePageNumber(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value!));
}

function normalizePanelItemsLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return PANEL_ITEMS_PAGE_SIZE;
  return clampNumber(Math.floor(value!), 1, 100);
}

function normalizeOffsetCursor(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

function normalizeChangeOp(value: string | undefined): PanelChange["op"] | undefined {
  return value === "created" || value === "updated" || value === "archived" || value === "deleted" ? value : undefined;
}

function normalizeChangeKind(value: string | undefined): PanelChange["kind"] | undefined {
  return value === "trace" || value === "span" || value === "policy" || value === "world_model" || value === "skill" ||
    value === "session" || value === "episode" || value === "job" || value === "feedback" ||
    value === "raw_turn" || value === "repair" || value === "skill_trial" || value === "recall" ||
    value === "artifact"
    ? value
    : undefined;
}

function changeOp(changeType: string): PanelChange["op"] {
  if (changeType.includes("delete")) return "deleted";
  if (changeType.includes("archive")) return "archived";
  if (changeType.includes("create") || changeType.includes("insert")) return "created";
  return "updated";
}

function changeKind(change: ChangeLogRecord): PanelChange["kind"] {
  if (change.changeType.includes("artifact") || change.memoryId.startsWith("artifact_")) return "artifact";
  if (change.changeType.includes("skill_trial")) return "skill_trial";
  if (change.changeType.includes("recall")) return "recall";
  if (change.changeType.includes("session")) return "session";
  if (change.changeType.includes("episode")) return "episode";
  if (change.changeType.includes("job")) return "job";
  if (change.changeType.includes("feedback")) return "feedback";
  if (change.changeType.includes("repair") || change.memoryId.startsWith("repair_")) return "repair";
  if (change.changeType.includes("raw_turn") || change.memoryId.startsWith("raw_")) return "raw_turn";
  const after = isRecord(change.after) ? change.after : undefined;
  const layer = after?.memoryLayer ?? after?.memory_layer;
  if (layer === "L1") return "trace";
  if (layer === "L2") return "policy";
  if (layer === "L3") return "world_model";
  if (layer === "Skill") return "skill";
  return "trace";
}

function versionFromChange(change: ChangeLogRecord): number | undefined {
  const after = isRecord(change.after) ? change.after : undefined;
  return typeof after?.version === "number" ? after.version : undefined;
}

function changeSource(source: string): PanelChange["source"] {
  if (source.startsWith("turn.")) return "turn_complete";
  if (source.startsWith("feedback.")) return "feedback";
  if (source.startsWith("worker.")) return "worker";
  if (source.startsWith("panel.")) return "panel";
  return "system";
}


function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
