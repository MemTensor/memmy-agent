/**
 * Episode-oriented memory read model.
 *
 * This module deliberately owns no repository or service instance.  Its caller
 * supplies narrow read ports and authorization policies, so it can be used by
 * MemoryService (or another HTTP/CLI adapter) without creating a reverse
 * dependency on that service.
 *
 * Intended destination: Memory/src/service/read-model/episode.ts
 */
import { episodeTitleDisplayState } from "../episode-title/episode-title-service.js";
import type {
  EpisodeRecord,
  FeedbackRecord,
  RawTurnRecord,
  SessionRecord,
  SkillTrialRecord,
  TracePolicyLinkRecord
} from "../../storage/repositories.js";
import { firstLine } from "../../utils/text.js";
import type {
  MemoryDetailItem,
  MemoryLayer,
  MemoryListItem,
  MemoryProcessingRecord,
  MemoryRow,
  RawTurnSummary,
  RequestEnvelope,
  RuntimeNamespace
} from "../../types.js";

export interface EpisodeTimelineDetail {
  sessionId?: string;
  episodeId?: string;
  traces: MemoryListItem[];
  rawTurns?: RawTurnSummary[];
  items: MemoryListItem[];
  nextCursor?: string;
  serverTime: string;
}

export interface EpisodeDetailItem {
  id: string;
  kind: "episode";
  memoryLayer: "Episode";
  status: EpisodeRecord["status"];
  title: string;
  summary: string;
  tags: string[];
  updatedAt: string;
  version: number;
  body: string;
  createdAt: string;
  sourceMemoryIds: string[];
  metadata: Record<string, unknown>;
  timeline: EpisodeTimelineDetail;
}

export type MemoryDetailResponse = MemoryDetailItem & {
  item: MemoryDetailItem;
  refs: Record<string, unknown>;
  version: number;
  etag: string;
};

type UserMemoryDetailResponse = Omit<MemoryDetailItem, "memoryLayer"> & { memoryLayer: "UserMemory" };
export type MemoryGetResponse = MemoryDetailResponse | (UserMemoryDetailResponse & { item: UserMemoryDetailResponse; refs: Record<string, unknown>; etag: string }) | (EpisodeDetailItem & {
  item: EpisodeDetailItem;
  refs: Record<string, unknown>;
  etag: string;
});

export interface TimelineRequest extends RequestEnvelope {
  userId?: string;
  sessionId?: string;
  episodeId?: string;
  layers?: MemoryLayer[];
  tags?: string[];
  limit?: number;
  cursor?: number;
}

/** The storage-facing portion of the read model's dependency contract. */
export interface EpisodeReadModelRepositories {
  memories: {
    visibleEvidenceIds(ids: readonly string[],local?:boolean): Set<string>;
    effectiveEpisodeL1Ids(episodes: Array<{id: string; userId?: string; sessionId?:string; l1MemoryIds: string[]}>,local?:boolean): Map<string, Set<string>>;
    getForDisplay(id: string): MemoryRow | undefined;
    getManyForDisplay(ids: readonly string[]): MemoryRow[];
    listForDisplay(filter: { memoryLayer?: MemoryLayer[]; tags?: string[] }, limit: number, cursor: number): MemoryRow[];
    toListItem(memory: MemoryRow): MemoryListItem;
  };
  processing: {
    get(memoryId: string): MemoryProcessingRecord | undefined;
  };
  runtime: {
    listUnassignedRawTurnsBySession(sessionId: string): RawTurnRecord[];
    l1MemoryIdsForRawTurn(rawTurnId: string): string[];
    getEpisode(id: string): EpisodeRecord | undefined;
    getFeedback(id: string): FeedbackRecord | undefined;
    listEpisodesForSession(sessionId: string): EpisodeRecord[];
    getRawTurn(id: string): RawTurnRecord | undefined;
    listRawTurnsByEpisode(episodeId: string, limit?: number): RawTurnRecord[];
    listTracePolicyLinks(input: {
      userId?: string;
      l1MemoryId?: string;
      l2MemoryId?: string;
      limit?: number;
    }): TracePolicyLinkRecord[];
    listSkillTrials(input: {
      userId?: string;
      skillMemoryId?: string;
      sessionId?: string;
      episodeId?: string;
      l1MemoryId?: string;
      rawTurnId?: string;
      status?: SkillTrialRecord["status"];
      outcome?: SkillTrialRecord["outcome"];
      limit?: number;
    }): SkillTrialRecord[];
  };
}

/**
 * All policy and formatting concerns are explicit dependencies.  The adapter
 * normally delegates these functions to the existing authorization, namespace,
 * and memory-detail helpers.
 */
export interface EpisodeReadModelDependencies {
  localMemory?: boolean;
  repos: EpisodeReadModelRepositories;
  assertMemorySearchEnabled(): void;
  resolveContext(request: RequestEnvelope): unknown;
  requireSession(id: string): SessionRecord;
  requireEpisode(id: string): EpisodeRecord;
  assertSessionInScope(session: SessionRecord, namespace?: RuntimeNamespace): void;
  assertEpisodeInScope(episode: EpisodeRecord, namespace?: RuntimeNamespace): void;
  assertMemoryInScope(memory: MemoryRow, namespace?: RuntimeNamespace): void;
  assertPanelMemoryInScope?(memory:MemoryRow,namespace?:RuntimeNamespace):void;
  assertPanelEpisodeInScope?(episode:EpisodeRecord,namespace?:RuntimeNamespace):void;
  namespaceForSession(session: SessionRecord): RuntimeNamespace;
  readableMemoryIdKind(id: string): "trace" | "policy" | "world" | "skill" | "episode" | "raw" | "unknown";
  invalidArgument(message: string): Error;
  notFound(message: string): Error;
  memoryMatchesTags(memory: MemoryRow, tags: string[] | undefined): boolean;
  rawTurnSummary(rawTurn: RawTurnRecord): RawTurnSummary;
  rawTurnIdFromMemory(memory: MemoryRow): string | undefined;
  episodeIdFromMemory(memory: MemoryRow): string | undefined;
  traceSortKey(memory: MemoryRow): number;
  detailFromMemory(memory: MemoryRow, processing?: MemoryProcessingRecord): MemoryDetailItem;
  memoryDetailWithLayerPayload(detail: MemoryDetailItem, memory: MemoryRow): MemoryDetailItem & Record<string, unknown>;
  memoryEtag(memory: MemoryRow): string;
  stableHash(value: unknown): string;
  nowIso(): string;
}

export class EpisodeReadModel {
  constructor(private readonly deps: EpisodeReadModelDependencies) {}

  timeline(input: TimelineRequest,panelRead=false): EpisodeTimelineDetail {
    this.deps.assertMemorySearchEnabled();
    // Preserve the current service's context-resolution side effect/validation.
    void this.deps.resolveContext(input);
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? 0;
    const layers = input.layers && input.layers.length > 0 ? input.layers : (["L1"] as MemoryLayer[]);
    let scopedEpisode: EpisodeRecord | undefined;
    let scopedSession: SessionRecord | undefined;

    if (input.sessionId) {
      scopedSession = this.deps.requireSession(input.sessionId);
      this.deps.assertSessionInScope(scopedSession, input.namespace);
    }
    if (input.episodeId) {
      scopedEpisode = this.deps.requireEpisode(input.episodeId);
      (panelRead ? this.deps.assertPanelEpisodeInScope ?? this.deps.assertEpisodeInScope : this.deps.assertEpisodeInScope)(scopedEpisode, input.namespace);
      if (input.sessionId && scopedEpisode.sessionId !== input.sessionId) {
        throw this.deps.invalidArgument("episode does not belong to session");
      }
    }

    const timelineEpisodes = scopedEpisode
      ? [scopedEpisode]
      : scopedSession
        ? this.deps.repos.runtime.listEpisodesForSession(scopedSession.id)
            .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.id.localeCompare(b.id))
        : undefined;
    let items = timelineEpisodes
      ? this.timelineItemsFromEpisodes(timelineEpisodes, layers, input.tags, limit, cursor,panelRead)
      : this.deps.repos.memories
          .listForDisplay({ memoryLayer: layers, tags: input.tags }, limit, cursor)
          .map((memory) => this.deps.repos.memories.toListItem(memory));
    let rawTurns = timelineEpisodes
      ? timelineEpisodes
          .flatMap((episode) => this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, limit)
            .filter(turn=>!panelRead || (!turn.redactedAt && turn.sessionId===episode.sessionId)))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((turn) => this.deps.rawTurnSummary(turn))
      : undefined;

    if (scopedSession && !scopedEpisode) {
      const pending = this.deps.repos.runtime.listUnassignedRawTurnsBySession(scopedSession.id);
      rawTurns = [...(rawTurns ?? []), ...pending.map(turn => this.deps.rawTurnSummary(turn))]
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, limit);
      const ids = dedupeStrings([
        ...(timelineEpisodes ?? []).flatMap(episode => timelineMemoryIdsForEpisode(episode, new Set(layers))),
        ...pending.flatMap(turn => this.deps.repos.runtime.l1MemoryIdsForRawTurn(turn.id))
      ]);
      items = this.deps.repos.memories.getManyForDisplay(ids)
        .filter(memory => layers.includes(memory.memoryLayer) && this.deps.memoryMatchesTags(memory, input.tags))
        .sort((a, b) => this.deps.traceSortKey(a) - this.deps.traceSortKey(b) || a.id.localeCompare(b.id))
        .slice(cursor, cursor + limit).map(memory => this.deps.repos.memories.toListItem(memory));
    }
    return {
      sessionId: input.sessionId ?? scopedEpisode?.sessionId,
      episodeId: input.episodeId,
      traces: items,
      rawTurns,
      items,
      nextCursor: items.length === limit ? String(cursor + items.length) : undefined,
      serverTime: this.deps.nowIso()
    };
  }

  timelineItemsFromEpisodes(
    episodes: readonly EpisodeRecord[],
    layers: readonly MemoryLayer[],
    tags: string[] | undefined,
    limit: number,
    cursor: number,
    panelRead=false
  ): MemoryListItem[] {
    const layerSet = new Set(layers);
    const effective = this.deps.repos.memories.effectiveEpisodeL1Ids([...episodes],panelRead || this.deps.localMemory);
    const memoryIds = dedupeStrings(episodes.flatMap(episode => timelineMemoryIdsForEpisode({
      ...episode, l1MemoryIds: [...(effective.get(episode.id) ?? [])]
    }, layerSet)));
    const layerFilter = new Set(layers);
    return this.deps.repos.memories
      .getManyForDisplay(memoryIds)
      .filter((memory) => layerFilter.has(memory.memoryLayer))
      .filter((memory) => this.deps.memoryMatchesTags(memory, tags))
      .sort((a, b) => this.deps.traceSortKey(a) - this.deps.traceSortKey(b) || a.id.localeCompare(b.id))
      .slice(cursor, cursor + limit)
      .map((memory) => this.deps.repos.memories.toListItem(memory));
  }

  getMemory(id: string, request: RequestEnvelope = {},panelRead=false): MemoryGetResponse {
    this.deps.assertMemorySearchEnabled();
    const idKind = this.deps.readableMemoryIdKind(id);
    if (idKind === "episode") return this.getEpisodeMemory(id, request,panelRead);
    if (idKind === "raw") {
      throw this.deps.invalidArgument("raw turn ids are internal; use the containing trace_ or episode_ id");
    }

    const memory = this.deps.repos.memories.getForDisplay(id);
    if (!memory) throw this.deps.notFound(`memory not found: ${id}`);
    (panelRead ? this.deps.assertPanelMemoryInScope ?? this.deps.assertMemoryInScope : this.deps.assertMemoryInScope)(memory, request.namespace);
    const detail = this.deps.detailFromMemory(memory, this.deps.repos.processing.get(memory.id));
    const refs = this.refsForMemory(memory,panelRead);
    const item = this.deps.memoryDetailWithLayerPayload(detail, memory);
    if (memory.properties.internal_info.memory_kind === "span") {
      const span = memory.properties.internal_info.span as {
        raw_turn_id: string;
        tool_call_start: number;
        tool_call_end: number;
      };
      const rawTurn = this.deps.repos.runtime.getRawTurn(span.raw_turn_id);
      item.metadata.spanDetail = {
        toolCallStart: span.tool_call_start,
        toolCallEnd: span.tool_call_end,
        toolCalls: rawTurn && !rawTurn.deletedAt && !rawTurn.redactedAt && (panelRead || this.deps.localMemory ? !memory.sessionId || rawTurn.sessionId===memory.sessionId : rawTurn.userId===memory.userId)
          ? rawTurn.toolCalls.slice(span.tool_call_start, span.tool_call_end + 1) : []
      };
    }
    return {
      ...item,
      item,
      refs,
      version: memory.version,
      etag: this.deps.memoryEtag(memory),
      metadata: { ...item.metadata, refs }
    };
  }

  getEpisodeMemory(id: string, request: RequestEnvelope = {},panelRead=false): EpisodeDetailItem & {
    item: EpisodeDetailItem;
    refs: Record<string, unknown>;
    etag: string;
  } {
    const stored = this.deps.requireEpisode(id);
    (panelRead ? this.deps.assertPanelEpisodeInScope ?? this.deps.assertEpisodeInScope : this.deps.assertEpisodeInScope)(stored, request.namespace);
    const live = new Set(this.deps.repos.memories.getManyForDisplay([
      ...stored.l2PolicyIds, ...stored.l3WorldModelIds, ...stored.skillMemoryIds
    ]).filter(memory => memory.status !== "deleted" && !memory.deletedAt).map(memory => memory.id));
    const episode = {...stored,
      l1MemoryIds: [...(this.deps.repos.memories.effectiveEpisodeL1Ids([stored],panelRead || this.deps.localMemory).get(id) ?? [])],
      l2PolicyIds: [...new Set(stored.l2PolicyIds.filter(id => live.has(id)))],
      l3WorldModelIds: [...new Set(stored.l3WorldModelIds.filter(id => live.has(id)))],
      skillMemoryIds: [...new Set(stored.skillMemoryIds.filter(id => live.has(id)))]
    };
    const session = this.deps.requireSession(episode.sessionId);
    const namespace = request.namespace ?? this.deps.namespaceForSession(session);
    const timeline = this.timeline({
      ...request,
      namespace,
      episodeId: id,
      layers: ["L1", "L2", "L3", "Skill"],
      limit: 100
    },panelRead);
    const sourceMemoryIds = dedupeStrings([
      ...episode.l1MemoryIds,
      ...episode.l2PolicyIds,
      ...episode.l3WorldModelIds,
      ...episode.skillMemoryIds
    ]);
    const refs = {
      episode,
      rawTurns: timeline.rawTurns ?? [],
      timeline: timeline.items,
      traceMemoryIds: episode.l1MemoryIds,
      policyMemoryIds: episode.l2PolicyIds,
      worldModelMemoryIds: episode.l3WorldModelIds,
      skillMemoryIds: episode.skillMemoryIds,
      feedbackIds: episode.feedbackIds,
      // turn.judge.v1 writes a reaction every turn, mostly neutral: count each kind.
      feedbackCounts: feedbackPolarityCounts(episode.feedbackIds.map((feedbackId) => this.deps.repos.runtime.getFeedback(feedbackId))),
      decisionRepairIds: episode.decisionRepairIds
    };
    const item = episodeDetailItem(episode, timeline, sourceMemoryIds, refs);
    return {
      ...item,
      item,
      refs,
      etag: `episode:${episode.id}:v${item.version}:${this.deps.stableHash({
        updatedAt: episode.updatedAt,
        sourceMemoryIds
      }).slice(0, 12)}`,
      metadata: { ...item.metadata, refs }
    };
  }

  private effectivePolicyLinks(links: TracePolicyLinkRecord[],panelRead=false): TracePolicyLinkRecord[] {
    const local = panelRead || this.deps.localMemory;
    const memories = this.deps.repos.memories.getManyForDisplay([...new Set(links.flatMap(link => [link.l1MemoryId,link.l2MemoryId]))]);
    const byId = new Map(memories.filter(memory => memory.status !== "deleted" && !memory.deletedAt).map(memory => [memory.id,memory]));
    const visible = this.deps.repos.memories.visibleEvidenceIds(links.map(link => link.l1MemoryId),local);
    const seen = new Set<string>();
    return links.filter(link => {
      const trace=byId.get(link.l1MemoryId), policy=byId.get(link.l2MemoryId);
      if (!trace || !policy || (!local && trace.userId !== policy.userId) || !visible.has(trace.id)) return false;
      const internal=policy.properties.internal_info;
      const policyMeta=internal.policy as {source_trace_ids?:unknown} | undefined;
      const sources=policyMeta?.source_trace_ids ?? internal.source_trace_ids;
      if (Array.isArray(sources) && !sources.includes(trace.id)) return false;
      const key=`${trace.id}:${policy.id}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  refsForMemory(memory: MemoryRow,panelRead=false): Record<string, unknown> {
    const local = panelRead || this.deps.localMemory;
    if (memory.memoryLayer === "L1") {
      if (memory.properties.internal_info.memory_kind === "work_memory") {
        return {};
      }
      const rawTurnId = this.deps.rawTurnIdFromMemory(memory);
      const candidate = rawTurnId ? this.deps.repos.runtime.getRawTurn(rawTurnId) : undefined;
      const rawTurn = candidate && !candidate.deletedAt && !candidate.redactedAt && (local ? !memory.sessionId || candidate.sessionId===memory.sessionId : candidate.userId===memory.userId) ? candidate : undefined;
      const episodeId = rawTurn?.episodeId ?? this.deps.episodeIdFromMemory(memory);
      const episode = episodeId ? this.deps.repos.runtime.getEpisode(episodeId) : undefined;
      return {
        rawTurn: rawTurn ? this.deps.rawTurnSummary(rawTurn) : undefined,
        episode: episode ? episodeRef(episode) : undefined,
        policyLinks: this.effectivePolicyLinks(this.deps.repos.runtime.listTracePolicyLinks({
          userId: local ? undefined : memory.userId,
          l1MemoryId: memory.id,
          limit: 50
        }),panelRead).map(policyLinkRef)
      };
    }
    if (memory.memoryLayer === "L2") {
      return {
        policyLinks: this.effectivePolicyLinks(this.deps.repos.runtime.listTracePolicyLinks({
          userId: local ? undefined : memory.userId,
          l2MemoryId: memory.id,
          limit: 100
        }),panelRead).map(policyLinkRef)
      };
    }
    if (memory.memoryLayer === "Skill") {
      return {
        skillTrials: this.deps.repos.runtime.listSkillTrials({
          userId: local ? undefined : memory.userId,
          skillMemoryId: memory.id,
          limit: 100
        }).map((trial) => skillTrialRef(
          trial,
          trial.episodeId ? this.deps.repos.runtime.getEpisode(trial.episodeId) : undefined
        ))
      };
    }
    return {};
  }
}

export function episodeRef(episode: EpisodeRecord, titleJobPending = false): Record<string, unknown> {
  const skillStatus = episodeSkillStatus(episode);
  const skillReason = episodeSkillReason(episode);
  const titleState = episodeTitleDisplayState(episode, titleJobPending);
  return {
    id: episode.id,
    sessionId: episode.sessionId,
    title: episode.title,
    summary: episode.summary,
    status: episode.status,
    startedAt: episode.openedAt,
    endedAt: episode.closedAt ?? undefined,
    turnCount: episode.turnCount,
    rTask: episode.rTask,
    rewardSkipped: episode.rewardDetail.skipped === true,
    rewardReason: typeof episode.rewardDetail.reason === "string" ? episode.rewardDetail.reason : undefined,
    closeReason: typeof episode.meta.closeReason === "string" ? episode.meta.closeReason : undefined,
    topicState: typeof episode.meta.topicState === "string" ? episode.meta.topicState : undefined,
    abandonReason: typeof episode.meta.abandonReason === "string" ? episode.meta.abandonReason : undefined,
    pipelineStatus: episode.pipelineStatus,
    pipelineError: episode.pipelineError,
    skillMemoryIds: episode.skillMemoryIds,
    linkedSkillId: episode.skillMemoryIds[0],
    skillStatus,
    skillReason,
    titleGenerated: titleState.titleGenerated,
    titlePending: titleState.titlePending
  };
}

export function episodeSkillStatus(episode: EpisodeRecord): string {
  if (episode.skillMemoryIds.length > 0) return "succeeded";
  if (episode.pipelineStatus === "running") return "running";
  if (episode.pipelineStatus === "failed") return "failed";
  if (typeof episode.rTask === "number" && episode.rTask <= -0.5) return "skipped";
  if (
    episode.rewardDetail.skipped === true ||
    episode.meta.closeReason === "abandoned" ||
    (typeof episode.rTask === "number" && episode.rTask < 0.3)
  ) return "skipped";
  return "queued";
}

export function episodeSkillReason(episode: EpisodeRecord): string | undefined {
  if (episode.skillMemoryIds.length > 0) return "已从该任务沉淀出可复用技能。";
  if (episode.pipelineError?.trim()) return `技能沉淀失败：${episode.pipelineError.trim()}`;
  if (typeof episode.rTask === "number" && episode.rTask <= -0.5) {
    return `任务评分 ${episode.rTask.toFixed(2)}，被视为反例；不会沉淀出新的经验或技能。`;
  }
  if (episode.rewardDetail.skipped === true) {
    if (episode.turnCount < 2) return "对话轮次不足，需要至少 2 轮完整问答才能生成摘要或技能。";
    return "Reward 评分被跳过，暂不生成技能。";
  }
  if (episode.meta.closeReason === "abandoned") return "任务在完成打分前结束，暂不生成技能。";
  if (typeof episode.rTask === "number" && episode.rTask < 0.3) {
    return `任务评分 ${episode.rTask.toFixed(2)} 未达到沉淀阈值，暂不生成技能。`;
  }
  if (episode.pipelineStatus === "running") return "正在沉淀技能。";
  if (episode.pipelineStatus === "succeeded") return "本任务未产出可复用技能。";
  if (episode.status === "open") return "任务仍在进行中，暂未启动技能沉淀。";
  return typeof episode.meta.skillReason === "string"
    ? episode.meta.skillReason
    : "等待评分完成后判断是否沉淀技能。";
}

export function policyLinkRef(link: TracePolicyLinkRecord): {
  policyMemoryId: string;
  traceMemoryId: string;
  relation: string;
} {
  return {
    policyMemoryId: link.l2MemoryId,
    traceMemoryId: link.l1MemoryId,
    relation: link.relation
  };
}

export function skillTrialRef(trial: SkillTrialRecord, episode?: EpisodeRecord): {
  trialId: string;
  status: SkillTrialRecord["status"];
  episodeId?: string;
  reward?: number;
} {
  return {
    trialId: trial.id,
    status: trial.status,
    episodeId: trial.episodeId,
    reward: typeof episode?.rTask === "number" ? episode.rTask : undefined
  };
}

export function timelineMemoryIdsForEpisode(
  episode: EpisodeRecord,
  layers: ReadonlySet<MemoryLayer>
): string[] {
  return [
    ...(layers.has("L1") ? episode.l1MemoryIds : []),
    ...(layers.has("L2") ? episode.l2PolicyIds : []),
    ...(layers.has("L3") ? episode.l3WorldModelIds : []),
    ...(layers.has("Skill") ? episode.skillMemoryIds : [])
  ];
}

export function episodeDetailItem(
  episode: EpisodeRecord,
  timeline: EpisodeTimelineDetail,
  sourceMemoryIds: string[],
  refs: Record<string, unknown>
): EpisodeDetailItem {
  const firstUserText = timeline.rawTurns
    ?.map((turn) => turn.userText?.trim())
    .find((text): text is string => Boolean(text));
  const title = truncateDetailTitle(episode.title ?? firstLine(firstUserText ?? episode.summary ?? "") ?? episode.id);
  const summary = episode.summary ??
    firstLine(firstUserText ?? "") ??
    `${timeline.items.length} memory item(s), ${timeline.rawTurns?.length ?? 0} raw turn(s)`;
  const version = Math.max(1, episode.turnCount, sourceMemoryIds.length, timeline.rawTurns?.length ?? 0);
  return {
    id: episode.id,
    kind: "episode",
    memoryLayer: "Episode",
    status: episode.status,
    title,
    summary,
    tags: ["episode", episode.status],
    updatedAt: episode.updatedAt,
    version,
    body: renderEpisodeDetailBody(episode, timeline, title),
    createdAt: episode.openedAt,
    sourceMemoryIds,
    metadata: {
      episode,
      timeline: {
        memoryCount: timeline.items.length,
        rawTurnCount: timeline.rawTurns?.length ?? 0,
        traceMemoryIds: episode.l1MemoryIds,
        policyMemoryIds: episode.l2PolicyIds,
        worldModelMemoryIds: episode.l3WorldModelIds,
        skillMemoryIds: episode.skillMemoryIds
      },
      refs
    },
    timeline
  };
}

export function renderEpisodeDetailBody(
  episode: EpisodeRecord,
  timeline: EpisodeTimelineDetail,
  title: string
): string {
  const lines = [
    `Episode: ${title}`,
    `Status: ${episode.status}`,
    typeof episode.rTask === "number" ? `Reward: ${episode.rTask}` : "",
    `Raw turns: ${timeline.rawTurns?.length ?? 0}`,
    `Memory timeline items: ${timeline.items.length}`
  ].filter(Boolean);
  if (timeline.rawTurns?.length) {
    lines.push("", "Raw turn details:");
    timeline.rawTurns.forEach((turn, index) => {
      lines.push(`${index + 1}. ${turn.turnId}`);
      if (turn.userText) lines.push(`   user: ${truncateEpisodeLine(turn.userText)}`);
      if (turn.assistantText) lines.push(`   assistant: ${truncateEpisodeLine(turn.assistantText)}`);
      if (turn.toolCalls?.length) lines.push(`   toolCalls: ${turn.toolCalls.length}`);
      if (turn.toolResults?.length) lines.push(`   toolResults: ${turn.toolResults.length}`);
    });
  }
  if (timeline.items.length) {
    lines.push("", "Related memories:");
    timeline.items.forEach((item, index) => {
      lines.push(`${index + 1}. [${item.memoryLayer}] ${item.id} - ${truncateEpisodeLine(item.title || item.summary, 160)}`);
    });
  }
  return lines.join("\n");
}

export function truncateEpisodeLine(value: string, maxChars = 220): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 3)}...`;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}


function truncateDetailTitle(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

export function feedbackPolarityCounts(
  feedback: ReadonlyArray<{ polarity: "positive" | "negative" | "neutral" } | undefined>
): { positive: number; negative: number; neutral: number } {
  const counts = { positive: 0, negative: 0, neutral: 0 };
  for (const item of feedback) if (item) counts[item.polarity] += 1;
  return counts;
}
