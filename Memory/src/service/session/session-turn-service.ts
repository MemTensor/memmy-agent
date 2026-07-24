import {
  captureTurnSteps,
  classifyIntent,
  classifyTurnFeedback,
  classifyTurnRelation,
  classifyTurnRelationWithLlm,
  policyMetaFromMemory,
  retrievalLayersForMode,
  retrievePluginMemories,
  signatureFromTraceParts,
  traceMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import {
  type MemmyConfig
} from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import {
  jobToRef,
  Repositories,
  type EpisodeRecord,
  type EvolutionJobRecord,
  type RawTurnRecord,
  type SessionRecord
} from "../../storage/repositories.js";
import type {
  FeedbackRequest,
  InjectedContext,
  JobRef,
  MemoryKind,
  MemoryLayer,
  MemoryRow,
  RecallHit,
  RepairSuggestionRequest,
  RequestEnvelope,
  SessionCompactRequest,
  SessionOpenRequest,
  SubagentCompleteRequest,
  SubagentStartRequest,
  ToolCallPayload,
  ToolObserveRequest,
  TurnCompleteRequest,
  TurnStartRequest
} from "../../types.js";
import { MemoryServiceError } from "../../utils/error.js";
import { newId,stableHash,stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import { nowIso } from "../../utils/time.js";
import type {
  DecisionRepairLlmDraft,
  SynthesizeDecisionRepairDraft
} from "../feedback/feedback-experience.js";
import { recordApiLog } from "../model-audit/model-call-audit.js";
import {
  namespaceForRawTurn,
  namespaceForSession,
  normalizeNamespace,
  sessionScopeForOpenRequest
} from "../namespace/namespace-scope.js";
import {
  detailSummaryForMemory,
  detailTitleForMemory,
  firstDetailDisplayString
} from "../read-model/memory.js";
import {
  buildRepairSuggestionQuery,
  buildSearchQuery,
  completeObservedRawTurn,
  normalizeCompleteTurnArtifacts,
  normalizeCompleteTurnSourceMemoryIds,
  normalizeCompleteTurnToolCalls,
  normalizeCompleteTurnToolResults,
  rawTurnIdForSessionTurn,
  sanitizeTurnCompleteRequest,
  sanitizeTurnStartRequest,
  turnStartContextHints
} from "../turn/turn-normalization.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
interface ToolFailureRecord { toolId: string; context: string; step: number; reason: string; ts: number; rawTurnId?: string; sessionId?: string; episodeId?: string; }
interface ToolFailureState { toolId: string; context: string; firstSeen: number; lastSeen: number; windowStart: number; occurrences: ToolFailureRecord[]; }
interface ToolFailureBurst extends ToolFailureState { contextHash: string; failureCount: number; }
interface DecisionRepairSummary { repairId?: string; contextHash?: string; skipped?: boolean; reason?: string; attachedPolicyIds?: string[]; }
type SessionTurnDependencies = {
  repos: Repositories;
  readonly config: MemmyConfig;
  readonly llm: LlmClient;
  readonly skillLlm: LlmClient;
  synthesizeDecisionRepairDraft: SynthesizeDecisionRepairDraft;
} & Record<string, any>;
interface CompleteTurnResponse { turnId: string; sessionId: string; episodeId: string; rawTurnId: string; l1MemoryId: string; l1MemoryIds: string[]; closedEpisodeIds: string[]; scheduledEvolution: boolean; jobs: JobRef[]; changeSeq: number; syncCursor: string; etag: string; serverTime: string; duplicate?: boolean; }

export interface ToolOutcomeObservation { toolId: string; success?: boolean; reason?: string; }

export function toolObservationEvent(input: ToolObserveRequest): { phase: "start" | "complete" | "error"; event: ToolCallPayload; toolCall: ToolCallPayload; toolResult?: ToolCallPayload } {
  const error = errorMessageFromUnknown(input.error);
  const success = input.error !== undefined ? false : input.result !== undefined ? true : undefined;
  const phase = input.error !== undefined ? "error" : input.result !== undefined ? "complete" : "start";
  const event: ToolCallPayload = { id: input.toolCallId, name: input.toolName, input: input.args, output: input.error === undefined ? input.result : undefined, error, success };
  return { phase, event, toolCall: { id: input.toolCallId, name: input.toolName, input: input.args }, toolResult: phase === "start" ? undefined : event };
}

export function toolOutcomeFromObservation(input: ToolObserveRequest, rawTurn: RawTurnRecord, updatedRawTurn: RawTurnRecord): ToolOutcomeObservation | undefined {
  const event = toolObservationEvent(input).event; const eventRecord = event as unknown as Record<string, unknown>;
  const call = matchingObservedToolCall(eventRecord, rawTurn, updatedRawTurn);
  const resultSuccess = input.result === undefined ? undefined : successFromToolObservation(eventRecord) ?? true;
  return { toolId: input.toolName, success: input.error !== undefined ? false : resultSuccess, reason: failureReasonFromToolObservation(event, call) };
}

export function toolRepairContext(session: SessionRecord, episode: EpisodeRecord): string { return [session.userId, session.projectId ?? session.workspaceId ?? session.conversationId ?? "default", episode.id].join(":"); }
export function toolSignalKey(toolId: string, context: string): string { return `${toolId}|${context}`; }
export function toolRepairContextHash(toolId: string, context: string): string { return stableHash(`${toolId}\n${context}`).slice(0, 16); }
export function repairEvidenceValueDiff(high: MemoryRow[], low: MemoryRow[]): number { if (!high.length || !low.length) return Number.POSITIVE_INFINITY; return Math.abs(meanTraceValue(high) - meanTraceValue(low)); }
export function isRepairFailureLikeTrace(trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>): boolean { const blob = `${trace.agentText}\n${trace.reflection ?? ""}`.toLowerCase(); return /(error|failed|failure|exception|traceback|timeout|retry)/.test(blob) || trace.toolCalls.some((call) => Boolean(call.error ?? errorMessageFromUnknown(call.output))); }
export function repairTraceContains(trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>, needle: string): boolean { return `${trace.userText}\n${trace.agentText}\n${trace.reflection ?? ""}`.toLowerCase().includes(needle); }

function matchingObservedToolCall(record: Record<string, unknown> | undefined, rawTurn: RawTurnRecord, updatedRawTurn: RawTurnRecord): ToolCallPayload | undefined { const id = stringFromMaybeRecord(record, "id") ?? stringFromMaybeRecord(record, "toolCallId"); const name = stringFromMaybeRecord(record, "name") ?? stringFromMaybeRecord(record, "toolName"); const calls = [...updatedRawTurn.toolCalls, ...rawTurn.toolCalls].filter(isToolCallPayload); return calls.find((call) => id && call.id === id) ?? calls.find((call) => name && call.name === name); }
function successFromToolObservation(record: Record<string, unknown> | undefined): boolean | undefined { if (!record) return undefined; if (typeof record.success === "boolean") return record.success; if (typeof record.ok === "boolean") return record.ok; if (typeof record.exitCode === "number") return record.exitCode === 0; if (typeof record.status === "string") { const status = record.status.toLowerCase(); if (["succeeded","success","ok","passed"].includes(status)) return true; if (["failed","failure","error","cancelled"].includes(status)) return false; } return record.error !== undefined ? false : undefined; }
function failureReasonFromToolObservation(event: unknown, call: ToolCallPayload | undefined): string | undefined { const reason = errorMessageFromUnknown(event) ?? (isRecord(event) ? stringFromMaybeRecord(event, "output") : undefined) ?? call?.error ?? errorMessageFromUnknown(call?.output); return reason ? clip(reason, 240) : undefined; }
function meanTraceValue(memories: MemoryRow[]): number { const values = memories.map((memory) => traceMetaFromMemory(memory)?.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value)); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function errorMessageFromUnknown(value: unknown): string | undefined { if (value === undefined || value === null) return undefined; if (value instanceof Error) return value.message; if (typeof value === "string") return value; if (isRecord(value)) { const message = value.error ?? value.message; if (typeof message === "string") return message; } return undefined; }
function stringFromMaybeRecord(record: unknown, key: string): string | undefined { return isRecord(record) ? (typeof record[key] === "string" ? record[key] as string : undefined) : undefined; }
function isToolCallPayload(value: unknown): value is ToolCallPayload { return isRecord(value) && typeof value.name === "string"; }


function uniq<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function objectField(value: unknown, key: string): string | undefined { return isRecord(value) && typeof value[key] === "string" ? value[key] as string : undefined; }

export function closedEpisodeIdsFromBoundary(
  before: EpisodeRecord | undefined,
  selected: EpisodeRecord,
  after: EpisodeRecord | undefined
): string[] {
  if (!before || before.id === selected.id || before.status !== "open" || after?.status !== "closed") {
    return [];
  }
  return [before.id];
}

export function summarizeTurn(rawTurn: RawTurnRecord): string {
  const parts = [
    `Turn: ${rawTurn.turnId}`,
    rawTurn.userText ? `User: ${clip(rawTurn.userText, 1200)}` : undefined,
    rawTurn.assistantText ? `Assistant: ${clip(rawTurn.assistantText, 1600)}` : undefined,
    rawTurn.reasoningSummary ? `Reasoning summary: ${clip(rawTurn.reasoningSummary, 800)}` : undefined,
    rawTurn.toolCalls.length
      ? `Tool calls: ${rawTurn.toolCalls.map((call) => objectField(call, "name") ?? "tool").join(", ")}`
      : undefined,
    rawTurn.toolResults.length ? `Tool results: ${rawTurn.toolResults.length}` : undefined
  ].filter(Boolean);
  return parts.join("\n");
}

export function rawTurnSummary(rawTurn: RawTurnRecord): {
  rawTurnId: string;
  episodeId: string;
  turnId: string;
  userText?: string;
  assistantText?: string;
  reasoningSummary?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  createdAt: string;
} {
  const redacted = Boolean(rawTurn.redactedAt || rawTurn.deletedAt);
  return {
    rawTurnId: rawTurn.id,
    episodeId: rawTurn.episodeId,
    turnId: rawTurn.turnId,
    userText: redacted ? undefined : rawTurn.userText,
    assistantText: redacted ? undefined : rawTurn.assistantText,
    reasoningSummary: redacted ? undefined : rawTurn.reasoningSummary,
    toolCalls: redacted ? undefined : rawTurn.toolCalls,
    toolResults: redacted ? undefined : rawTurn.toolResults,
    createdAt: rawTurn.createdAt
  };
}

export function failureBurstPreference(
  burst: ToolFailureBurst,
  reason: string,
  bestMemory: MemoryRow | undefined
): string {
  const trace = bestMemory ? traceMetaFromMemory(bestMemory) : null;
  const bestText = trace?.reflection ?? trace?.agentText ?? trace?.summary;
  if (bestText) return `Prefer: ${clip(bestText, 200)}`;
  return `Prefer: switch strategy for ${burst.toolId} instead of repeating the same failing call.`;
}

export function failureBurstAntiPattern(burst: ToolFailureBurst, reason: string): string {
  return `Avoid: repeating ${burst.toolId} after ${burst.failureCount} failures with ${clip(reason, 160)}.`;
}

export class SessionTurnService {
  private readonly toolFailureStates = new Map<string, ToolFailureState>();
  private readonly toolSuccessSteps = new Map<string, number>();
  private readonly toolStepCounters = new Map<string, number>();

  constructor(private readonly deps: SessionTurnDependencies) {}

  openSession(request: SessionOpenRequest): {
    sessionId: string;
    userId: string;
    source: string;
    profileId: string;
    projectId?: string;
    workspaceId?: string;
    conversationId?: string;
    status: "open";
    resumed: boolean;
    changeSeq?: number;
    syncCursor?: string;
    duplicate?: boolean;
    openedAt: string;
    serverTime: string;
  } {
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.openSessionNoWrite(request);
    }
    const idempotencyKey = request.adapterId && request.requestId
      ? `session.open:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = stableHash({ operation: "session.open", request });
    if (idempotencyKey) {
      const existing = this.deps.repos.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryServiceError("conflict", "idempotency key reused with different session.open request body");
        }
        return this.deps.withDuplicateFlag(existing.response) as ReturnType<SessionTurnService["openSession"]>;
      }
    }
    const namespace = normalizeNamespace(request.namespace);
    const at = nowIso();
    if (request.sessionId) {
      const existingSession = this.deps.repos.runtime.getSession(request.sessionId);
      if (existingSession) {
        this.deps.assertSessionInScope(existingSession, request.namespace);
        if (existingSession.status !== "open") {
          throw new MemoryServiceError("conflict", `session is not open: ${request.sessionId}`);
        }
        const refreshed = this.deps.repos.runtime.updateSessionScope(
          existingSession.id,
          sessionScopeForOpenRequest(request, namespace),
          at
        ) ?? existingSession;
        const body = {
          sessionId: refreshed.id,
          userId: refreshed.userId,
          source: refreshed.source,
          profileId: refreshed.profileId,
          projectId: refreshed.projectId,
          workspaceId: refreshed.workspaceId,
          conversationId: refreshed.conversationId,
          status: "open" as const,
          resumed: true,
          openedAt: refreshed.openedAt,
          serverTime: nowIso()
        };
        if (idempotencyKey) {
          this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
        }
        return body;
      }
    }
    const hostSessionKey = namespace.sessionKey;
    if (hostSessionKey) {
      const existingSession = this.deps.repos.runtime.findOpenSessionByHostKey({
        userId: namespace.userId,
        source: request.source ?? namespace.source,
        profileId: request.profileId ?? namespace.profileId,
        hostSessionKey
      });
      if (existingSession) {
        this.deps.assertSessionInScope(existingSession, request.namespace);
        const touched = this.deps.repos.runtime.updateSessionScope(
          existingSession.id,
          sessionScopeForOpenRequest(request, namespace),
          at
        ) ?? existingSession;
        const body = {
          sessionId: touched.id,
          userId: touched.userId,
          source: touched.source,
          profileId: touched.profileId,
          projectId: touched.projectId,
          workspaceId: touched.workspaceId,
          conversationId: touched.conversationId,
          status: "open" as const,
          resumed: true,
          openedAt: touched.openedAt,
          serverTime: nowIso()
        };
        if (idempotencyKey) {
          this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
        }
        return body;
      }
    }
    const session: SessionRecord = {
      id: request.sessionId ?? newId("session"),
      userId: namespace.userId,
      source: request.source ?? namespace.source,
      profileId: request.profileId ?? namespace.profileId,
      profileLabel: namespace.profileLabel,
      projectId: request.projectId ?? namespace.projectId ?? namespace.workspaceId,
      workspaceId: request.workspaceId ?? namespace.workspaceId,
      workspacePath: request.workspacePath ?? namespace.workspacePath,
      hostSessionKey,
      conversationId: this.deps.stringFromMeta(request.meta, "conversationId"),
      status: "open" as const,
      meta: request.meta ?? {},
      openedAt: at,
      lastSeenAt: at,
      updatedAt: at
    };

    this.deps.repos.runtime.createSession(session);
    const changeSeq = this.deps.repos.runtime.appendChange({
      memoryId: session.id,
      namespaceId: this.deps.namespaceIdFromContext(namespace),
      kind: "session",
      op: "created",
      entityId: session.id,
      userId: session.userId,
      changeType: "session_opened",
      after: session,
      source: "session.open",
      createdAt: at
    });
    const body = {
      sessionId: session.id,
      userId: session.userId,
      source: session.source,
      profileId: session.profileId,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      conversationId: session.conversationId,
      status: "open" as const,
      resumed: false,
      changeSeq,
      syncCursor: this.deps.encodeChangeCursor(changeSeq, namespace),
      openedAt: at,
      serverTime: nowIso()
    };
    if (idempotencyKey) {
      this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
    }
    return body;
  }

  closeSession(sessionId: string, request: RequestEnvelope = {}): {
    ok: true;
    sessionId: string;
    status: "closed";
    closedEpisodeIds: string[];
    changeSeq: number;
    syncCursor: string;
    closedAt: string;
    serverTime: string;
  } {
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.closeSessionNoWrite(sessionId, request);
    }
    const existing = this.deps.repos.runtime.getSession(sessionId);
    if (!existing) {
      throw new MemoryServiceError("not_found", `session not found: ${sessionId}`);
    }
    this.deps.assertSessionInScope(existing, request.namespace);
    const at = nowIso();
    const closedEpisodes = this.deps.repos.runtime.closeOpenEpisodesForSession(sessionId, at);
    const session = this.deps.repos.runtime.closeSession(sessionId, at);
    if (!session) {
      throw new MemoryServiceError("not_found", `session not found: ${sessionId}`);
    }
    for (const episode of closedEpisodes) {
      this.deps.repos.runtime.appendChange({
        memoryId: episode.id,
        namespaceId: this.deps.namespaceIdFromSession(session),
        kind: "episode",
        op: "updated",
        entityId: episode.id,
        userId: episode.userId,
        changeType: "episode_closed",
        after: episode,
        source: "session.close",
        createdAt: at
      });
      this.deps.finalizeClosedEpisode(episode, at, "session_closed");
    }
    const changeSeq = this.deps.repos.runtime.appendChange({
      memoryId: sessionId,
      namespaceId: this.deps.namespaceIdFromSession(session),
      kind: "session",
      op: "updated",
      entityId: sessionId,
      userId: session.userId,
      changeType: "session_closed",
      before: existing,
      after: session,
      source: "session.close",
      createdAt: at
    });
    return {
      ok: true,
      sessionId,
      status: "closed",
      closedEpisodeIds: closedEpisodes.map((episode) => episode.id),
      changeSeq,
      syncCursor: this.deps.encodeChangeCursor(changeSeq, namespaceForSession(session)),
      closedAt: session.closedAt ?? nowIso(),
      serverTime: nowIso()
    };
  }

  compactSession(sessionId: string, request: SessionCompactRequest = {}): {
    memorySnapshot: {
      summary: string;
      sourceTurnIds: string[];
      sourceMemoryIds: string[];
      tokenEstimate?: number;
    };
    contextPacketId: string;
    rawTurnId?: string;
    l1MemoryId?: string;
    changeSeq?: number;
    syncCursor?: string;
    jobs: JobRef[];
    serverTime: string;
  } {
    this.deps.assertMemoryAddEnabled();
    const session = this.deps.requireSession(sessionId);
    this.deps.assertSessionInScope(session, request.namespace);
    const episode = this.ensureEpisode(session, request.episodeId);
    const at = nowIso();
    const sourceMemoryIds = request.sourceMemoryIds?.length
      ? request.sourceMemoryIds
      : episode.l1MemoryIds.slice(-12);
    const sourceMemories = this.deps.repos.memories.getMany(sourceMemoryIds);
    const sourceTurnIds = request.sourceTurnIds?.length
      ? request.sourceTurnIds
      : sourceMemories
          .map((memory) => stringFromMaybeRecord(memory.info, "turn_id"))
          .filter((value): value is string => Boolean(value));
    const summary = request.summary?.trim() ||
      sourceMemories.map((memory) => this.deps.firstLine(memory.memoryValue)).filter(Boolean).slice(0, 8).join("\n") ||
      `Compact snapshot for session ${sessionId}`;
    const rawTurnId = newId("raw");
    const contextPacketId = `ctx_${stableHash(`${sessionId}:${episode.id}:${summary}:${rawTurnId}`).slice(0, 20)}`;
    const turnId = `compact:${contextPacketId}`;
    const rawTurn = this.deps.repos.runtime.insertRawTurn({
      id: rawTurnId,
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      userId: session.userId,
      conversationId: session.conversationId,
      assistantText: summary,
      toolCalls: [],
      toolResults: [],
      sourceMemoryIds,
      usage: {},
      messagePayload: {
        compact: {
          contextPacketId,
          sourceTurnIds,
          sourceMemoryIds,
          tokenEstimate: request.tokenEstimate
        }
      },
      status: "succeeded",
      createdAt: at
    });
    this.deps.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
    this.deps.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: this.deps.namespaceIdFromSession(session),
      kind: "raw_turn",
      op: "created",
      entityId: rawTurn.id,
      userId: session.userId,
      changeType: "raw_turn_created",
      after: rawTurn,
      source: "session.compact",
      createdAt: at
    });

    let l1MemoryId: string | undefined;
    const jobs: EvolutionJobRecord[] = [];
    if (request.createL1 !== false) {
      const l1 = this.deps.buildMemory({
        id: `trace_${stableHash(`compact:L1:${rawTurn.id}`).slice(0, 20)}`,
        userId: session.userId,
        conversationId: session.conversationId,
        sessionId: session.id,
        agentId: session.source,
        appId: session.workspaceId,
        projectId: session.projectId,
        profileId: session.profileId,
        layer: "L1",
        kind: "trace",
        memoryType: "LongTermMemory",
        key: `trace:${session.id}:${turnId}:compact`,
        value: [
          `Summary: ${summary}`,
          `RawTurn: ${rawTurn.id}`,
          "TraceStep: compact",
          "Alpha: 0.5",
          "Value: 0",
          "Priority: 0.5"
        ].join("\n"),
        tags: ["trace", "compact", "summary"],
        info: {
          turn_id: turnId,
          raw_turn_id: rawTurn.id,
          episode_id: episode.id,
          summary,
          source_memory_ids: sourceMemoryIds
        },
        internal: {
          source: "session.compact",
          plugin_algorithm: "capture.compact.v1",
          source_raw_turn_id: rawTurn.id,
          source_memory_ids: sourceMemoryIds,
          summary,
          reflection: null,
          alpha: 0.5,
          value: 0,
          priority: 0.5,
          raw_turn_id: rawTurn.id,
          raw_span: { compact: true },
          error_signatures: [],
          trace: {
            key: `${episode.id}:${Date.parse(at)}:compact`,
            ts: Date.parse(at),
            turn_id: turnId,
            raw_turn_id: rawTurn.id,
            raw_span: { compact: true },
            episode_id: episode.id,
            step_index: 0,
            sub_step_total: 1,
            tool_calls: [],
            reflection: null,
            alpha: 0.5,
            usable: true,
            reflection_source: "synth",
            summary,
            tags: ["compact", "summary"],
            value: 0,
            priority: 0.5,
            signature: "compact|summary|_|_",
            error_signatures: []
          }
        },
        createdAt: at
      });
      const upsert = this.deps.repos.memories.upsertByKey(l1);
      l1MemoryId = upsert.memory.id;
      this.deps.repos.runtime.appendChange({
        memoryId: upsert.memory.id,
        namespaceId: this.deps.namespaceIdFromMemory(upsert.memory),
        kind: "trace",
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId: session.userId,
        changeType: upsert.created ? "create" : "update",
        before: upsert.previous,
        after: upsert.memory,
        source: "session.compact",
        createdAt: at
      });
      this.deps.repos.runtime.appendEpisodeTurn(episode.id, rawTurn.id, upsert.memory.id, at);
      jobs.push(this.deps.enqueueJob({
        jobType: "embedding",
        userId: session.userId,
        sessionId: session.id,
        episodeId: episode.id,
        targetMemoryId: upsert.memory.id,
        payload: { reason: "compact.snapshot" },
        createdAt: at
      }));
    }
    jobs.push(this.deps.enqueueJob({
      jobType: "l3_abstraction",
      userId: session.userId,
      sessionId,
      episodeId: episode.id,
      payload: {
        reason: "manual_compaction",
        targetKind: "policy_cluster",
        sourceMemoryId: l1MemoryId,
        episodeId: episode.id,
        rawTurnId: rawTurn.id
      },
      createdAt: at
    }));
    this.deps.repos.runtime.insertAudit({
      userId: session.userId,
      sessionId: session.id,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "compact",
      targetKind: "session",
      targetId: session.id,
      meta: { rawTurnId: rawTurn.id, l1MemoryId, contextPacketId },
      createdAt: at
    });
    const changeSeq = this.deps.repos.runtime.latestChangeSeq(session.userId, this.deps.namespaceIdFromSession(session));
    return {
      memorySnapshot: {
        summary,
        sourceTurnIds,
        sourceMemoryIds,
        tokenEstimate: request.tokenEstimate
      },
      contextPacketId,
      rawTurnId: rawTurn.id,
      l1MemoryId,
      changeSeq,
      syncCursor: changeSeq === undefined ? undefined : this.deps.encodeChangeCursor(changeSeq, namespaceForSession(session)),
      jobs: jobs.map(jobToRef),
      serverTime: nowIso()
    };
  }

  async startTurn(request: TurnStartRequest & Record<string, unknown>): Promise<{
    contextPacketId: string;
    turnId: string;
    sessionId: string;
    episodeId: string;
    closedEpisodeIds: string[];
    searchEventId: string;
    hits: RecallHit[];
    injectedContext: InjectedContext;
    sourceMemoryIds: string[];
    droppedDueToBudget: Array<{
      id: string;
      kind: MemoryKind;
      memoryLayer: MemoryLayer;
      reason: "token_budget";
      tokenEstimate?: number;
    }>;
    status: string[];
    serverTime: string;
  }> {
    request = sanitizeTurnStartRequest(request);
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.startTurnNoWrite(request);
    }
    const session = this.deps.requireOpenSession(request.sessionId);
    this.deps.assertSessionInScope(session, request.namespace);
    const turnId = request.turnId ?? newId("turn");
    const existingRawTurn = this.deps.repos.runtime.getRawTurnBySessionTurn(session.id, turnId);
    if (existingRawTurn) {
      this.deps.assertRawTurnInScope(existingRawTurn, request.namespace);
    }
    const latestEpisodeBefore = existingRawTurn
      ? undefined
      : this.deps.repos.runtime.latestEpisodeForSession(session.id);
    const episode = existingRawTurn
      ? this.deps.requireEpisode(existingRawTurn.episodeId)
      : await this.ensureEpisodeForTurnWithLlm(session, undefined, request.query, "turn.start");
    const closedEpisodeIds = closedEpisodeIdsFromBoundary(
      latestEpisodeBefore,
      episode,
      latestEpisodeBefore ? this.deps.repos.runtime.getEpisode(latestEpisodeBefore.id) : undefined
    );
    const intentDecision = episode.rawTurnIds.length === 0
      ? classifyIntent(request.query)
      : undefined;
    if (intentDecision) {
      this.deps.repos.runtime.updateEpisodeMeta(episode.id, {
        intentDecision
      });
    }
    const contextHints = turnStartContextHints(request);
    const search = await this.deps.search({
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: namespaceForSession(session),
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      query: buildSearchQuery({ ...request, contextHints }, this.deps.config.domain),
      layers: intentDecision ? this.deps.memoryLayersForIntent(intentDecision.kind) : ["Skill", "L2", "L1", "L3"],
      limit: this.deps.turnStartRetrievalLimit(),
      contextBudget: typeof request.contextBudget === "number" ? request.contextBudget : undefined,
      includeInjectedContext: true,
      retrievalMode: "turn_start",
      contextHints,
      injectedContextQuery: request.query
    });
    const contextPacketId = `ctx_${stableHash(`${session.id}:${episode.id}:${turnId}:${search.searchEventId}`).slice(0, 20)}`;
    if (!existingRawTurn) {
      const at = nowIso();
      this.deps.repos.runtime.touchSession(session.id, at);
      const rawTurn = this.deps.repos.runtime.insertRawTurn({
        id: rawTurnIdForSessionTurn(session.id, turnId),
        sessionId: session.id,
        episodeId: episode.id,
        turnId,
        userId: session.userId,
        conversationId: session.conversationId,
        userText: request.query,
        toolCalls: [],
        toolResults: [],
        sourceMemoryIds: search.sourceMemoryIds,
        usage: {},
        messagePayload: {
          turn_start: {
            contextPacketId,
            searchEventId: search.searchEventId
          }
        },
        status: "started",
        createdAt: at
      });
      this.deps.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
      this.deps.repos.runtime.appendChange({
        memoryId: rawTurn.id,
        namespaceId: this.deps.namespaceIdFromSession(session),
        kind: "raw_turn",
        op: "created",
        entityId: rawTurn.id,
        userId: session.userId,
        changeType: "raw_turn_created",
        after: rawTurn,
        source: "turn.start",
        createdAt: at
      });
    }

    return {
      contextPacketId,
      turnId,
      sessionId: session.id,
      episodeId: episode.id,
      closedEpisodeIds,
      searchEventId: search.searchEventId,
      hits: search.hits,
      injectedContext: search.injectedContext,
      sourceMemoryIds: search.sourceMemoryIds,
      droppedDueToBudget: search.droppedDueToBudget,
      status: [
        ...search.status,
        ...(intentDecision && (intentDecision.kind === "chitchat" || intentDecision.kind === "meta")
          ? [`intent:${intentDecision.kind}:retrieval_skipped`]
          : [])
      ],
      serverTime: nowIso()
    };
  }

  completeTurn(turnId: string, request: TurnCompleteRequest & Record<string, unknown>): CompleteTurnResponse {
    request = sanitizeTurnCompleteRequest(request);
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.completeTurnNoWrite(turnId, request);
    }
    const startedAt = Date.now();
    const idempotencyKey = request.adapterId && request.requestId
      ? `turn.complete:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = stableHash({
      turnId,
      request
    });

    if (idempotencyKey) {
      const existing = this.deps.repos.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryServiceError("conflict", "idempotency key reused with different request body");
        }
        return {
          ...(existing.response as CompleteTurnResponse),
          duplicate: true
        };
      }
    }

    const response = this.deps.repos.transaction(() => {
      const session = this.deps.requireOpenSession(request.sessionId);
      this.deps.assertSessionInScope(session, request.namespace);
      const existingRawTurn = this.deps.repos.runtime.getRawTurnBySessionTurn(session.id, turnId);
      if (existingRawTurn) {
        this.deps.assertRawTurnInScope(existingRawTurn, request.namespace);
      }
      const latestEpisodeBefore = existingRawTurn
        ? undefined
        : this.deps.repos.runtime.latestEpisodeForSession(session.id);
      const episode = existingRawTurn
        ? this.deps.requireEpisode(existingRawTurn.episodeId)
        : this.ensureEpisodeForTurn(session, request.episodeId, request.query, "turn.complete");
      const closedEpisodeIds = closedEpisodeIdsFromBoundary(
        latestEpisodeBefore,
        episode,
        latestEpisodeBefore ? this.deps.repos.runtime.getEpisode(latestEpisodeBefore.id) : undefined
      );
      this.deps.assertEpisodeInScope(episode, request.namespace);
      const at = nowIso();
      this.deps.repos.runtime.touchSession(session.id, at);
      const rawTurnId = rawTurnIdForSessionTurn(session.id, turnId);
      const requestToolCalls = normalizeCompleteTurnToolCalls(request);
      const requestToolResults = normalizeCompleteTurnToolResults(request);
      const requestArtifacts = normalizeCompleteTurnArtifacts(request);

      const insertedRawTurn: RawTurnRecord =
        existingRawTurn ??
        this.deps.repos.runtime.insertRawTurn({
          id: rawTurnId,
          sessionId: session.id,
          episodeId: episode.id,
          turnId,
          userId: session.userId,
          conversationId: session.conversationId,
          userText: request.query,
          assistantText: request.answer,
          reasoningSummary: stringFromMaybeRecord(request, "reasoningSummary"),
          toolCalls: requestToolCalls,
          toolResults: requestToolResults,
          sourceMemoryIds: normalizeCompleteTurnSourceMemoryIds(request),
          usage: isRecord(request.usage) ? request.usage : {},
          messagePayload: {
            turn_complete: {
              completed_at: at,
              source_memory_ids: normalizeCompleteTurnSourceMemoryIds(request)
            }
          },
          status: request.status ?? "succeeded",
          createdAt: at
        });
      const rawTurnCreated = !existingRawTurn;
      const rawTurnFirstCompleted = rawTurnCreated
        || !isRecord(existingRawTurn.messagePayload?.turn_complete);
      const rawTurn = existingRawTurn
        ? this.deps.repos.runtime.updateRawTurn(completeObservedRawTurn(existingRawTurn, request, at))
        : insertedRawTurn;
      if (rawTurnCreated) {
        this.deps.repos.runtime.appendChange({
          memoryId: rawTurn.id,
          namespaceId: this.deps.namespaceIdFromSession(session),
          kind: "raw_turn",
          op: "created",
          entityId: rawTurn.id,
          userId: session.userId,
          changeType: "raw_turn_created",
          after: rawTurn,
          source: "turn.complete",
          createdAt: at
        });
      } else if (stableHash(existingRawTurn) !== stableHash(rawTurn)) {
        this.deps.repos.runtime.appendChange({
          memoryId: rawTurn.id,
          namespaceId: this.deps.namespaceIdFromSession(session),
          kind: "raw_turn",
          op: "updated",
          entityId: rawTurn.id,
          userId: session.userId,
          changeType: "raw_turn_update",
          before: existingRawTurn,
          after: rawTurn,
          source: "turn.complete",
          createdAt: at
        });
      }

      const requestTags = this.deps.normalizeRequestTags(request.tags);
      const capturedSteps = this.captureEpisodeIncrementalSteps(episode, rawTurn, at)
        .map((step) => {
          const stepRawTurnId = step.rawTurnId ?? rawTurn.id;
          return stepRawTurnId === rawTurn.id && requestTags.length > 0
            ? { ...step, tags: uniq([...step.tags, ...requestTags]) }
            : step;
        });

      const l1MemoryIds: string[] = [];
      let changeSeq = 0;
      const jobs: EvolutionJobRecord[] = [];

      for (const step of capturedSteps) {
        const stepRawTurnId = step.rawTurnId ?? rawTurn.id;
        const signature = signatureFromTraceParts(step.tags, step.toolCalls, step.reflection.text ?? "");
        const l1Memory = this.deps.buildMemory({
          id: `trace_${stableHash(`L1:${session.id}:${step.turnId}:${step.stepIndex}`).slice(0, 20)}`,
          userId: session.userId,
          conversationId: session.conversationId,
          sessionId: session.id,
          agentId: session.source,
          appId: session.workspaceId,
          projectId: session.projectId,
          profileId: session.profileId,
          layer: "L1",
          kind: "trace",
          memoryType: "LongTermMemory",
          key: `trace:${session.id}:${step.turnId}:${step.stepIndex}`,
          value: this.deps.renderTraceMemoryValue({
            ...step,
            rawTurnId: stepRawTurnId
          }),
          tags: step.tags,
          info: {
            turn_id: step.turnId,
            raw_turn_id: stepRawTurnId,
            episode_id: episode.id,
            status: rawTurn.status,
            summary: step.summary
          },
          internal: {
            source: "turn.complete",
            plugin_algorithm: "capture.v7",
            source_raw_turn_id: stepRawTurnId,
            source_memory_ids: rawTurn.sourceMemoryIds,
            summary: step.summary,
            reflection: step.reflection.text,
            alpha: step.reflection.alpha,
            value: step.value,
            priority: step.priority,
            raw_turn_id: stepRawTurnId,
            raw_span: {
              user_text: Boolean(step.userText),
              agent_text: Boolean(step.agentText),
              tool_call_count: step.toolCalls.length
            },
            error_signatures: step.errorSignatures,
            trace: {
              key: step.key,
              ts: step.ts,
              turn_id: step.turnId,
              raw_turn_id: stepRawTurnId,
              raw_span: {
                user_text: Boolean(step.userText),
                agent_text: Boolean(step.agentText),
                tool_call_count: step.toolCalls.length
              },
              episode_id: episode.id,
              step_index: step.stepIndex,
              sub_step_total: step.subStepTotal,
              agent_thinking: step.agentThinking,
              userText: step.userText,
              agentText: step.agentText,
              tool_calls: this.deps.sanitizeTraceToolCalls(step.toolCalls),
              reflection: step.reflection.text,
              alpha: step.reflection.alpha,
              usable: step.reflection.usable,
              reflection_source: step.reflection.source,
              summary: step.summary,
              tags: step.tags,
              value: step.value,
              priority: step.priority,
              signature,
              error_signatures: step.errorSignatures,
              vec_summary: step.vecSummary,
              vec_action: step.vecAction
            }
          },
          createdAt: at
        });

        const upsert = this.deps.repos.memories.upsertByKey(l1Memory);
        l1MemoryIds.push(upsert.memory.id);
        changeSeq = this.deps.repos.runtime.appendChange({
          memoryId: upsert.memory.id,
          namespaceId: this.deps.namespaceIdFromMemory(upsert.memory),
          kind: "trace",
          op: upsert.created ? "created" : "updated",
          entityId: upsert.memory.id,
          userId: session.userId,
          changeType: upsert.created ? "create" : "update",
          before: upsert.previous,
          after: upsert.memory,
          source: "turn.complete.capture.v7",
          createdAt: at
        });
        this.deps.repos.runtime.appendEpisodeTurn(episode.id, stepRawTurnId, upsert.memory.id, at);
        if (!this.deps.repos.processing.get(upsert.memory.id)) {
          const summaryRequired = this.deps.llm.isConfigured();
          const embeddingRequired = this.deps.config.algorithm.capture.embedAfterCapture;
          const job = summaryRequired
            ? this.deps.enqueueJob({
              jobType: "trace_summary",
              userId: session.userId,
              sessionId: session.id,
              episodeId: episode.id,
              targetMemoryId: upsert.memory.id,
              payload: {
                turnId: step.turnId,
                rawTurnId: stepRawTurnId,
                source: "turn.complete.capture.v7",
                contentHash: upsert.memory.contentHash
              },
              maxAttempts: 3,
              createdAt: at
            })
            : embeddingRequired
              ? this.deps.enqueueJob({
                jobType: "embedding",
                userId: session.userId,
                sessionId: session.id,
                episodeId: episode.id,
                targetMemoryId: upsert.memory.id,
                payload: {
                  turnId: step.turnId,
                  rawTurnId: stepRawTurnId,
                  source: "turn.complete.capture.v7",
                  contentHash: upsert.memory.contentHash
                },
                maxAttempts: 6,
                createdAt: at
              })
              : undefined;
          if (job) jobs.push(job);
          this.deps.repos.processing.save({
            memoryId: upsert.memory.id,
            state: summaryRequired
              ? "summary_pending"
              : embeddingRequired
                ? "embedding_pending"
                : "ready_text_only",
            stage: summaryRequired ? "summary" : embeddingRequired ? "embedding" : null,
            activeJobId: job?.id ?? null,
            attemptCount: 0,
            manualRetryCount: 0,
            retryAction: "retry",
            errorCode: null,
            errorMessage: null,
            failedAt: null,
            updatedAt: at
          });
        }
      }
      for (const artifact of requestArtifacts) {
        const artifactId = this.deps.repos.runtime.insertArtifact({
          sessionId: session.id,
          episodeId: episode.id,
          rawTurnId: rawTurn.id,
          userId: session.userId,
          kind: artifact.kind,
          uri: artifact.uri,
          payload: artifact.payload,
          createdAt: at
        });
        this.deps.repos.runtime.appendChange({
          memoryId: artifactId,
          namespaceId: this.deps.namespaceIdFromSession(session),
          kind: "artifact",
          op: "created",
          entityId: artifactId,
          userId: session.userId,
          changeType: "artifact_created",
          after: {
            id: artifactId,
            sessionId: session.id,
            episodeId: episode.id,
            rawTurnId: rawTurn.id,
            userId: session.userId,
            kind: artifact.kind,
            uri: artifact.uri,
            payload: artifact.payload,
            createdAt: at
          },
          source: "turn.complete.artifact",
          createdAt: at
        });
      }
      if (rawTurnFirstCompleted) {
        jobs.push(this.deps.enqueueJob({
          jobType: "episode_idle_close",
          userId: session.userId,
          sessionId: session.id,
          episodeId: episode.id,
          dedupeKey: `episode_idle_close:${rawTurn.id}`,
          payload: {
            triggerRawTurnId: rawTurn.id,
            triggerEpisodeId: episode.id,
            triggeredAt: at
          },
          createdAt: at
        }));
      }
      const responseChangeSeq = this.deps.repos.runtime.latestChangeSeq(session.userId, this.deps.namespaceIdFromSession(session));
      const body: CompleteTurnResponse = {
        turnId,
        sessionId: session.id,
        episodeId: episode.id,
        rawTurnId: rawTurn.id,
        l1MemoryId: l1MemoryIds[0] ?? "",
        l1MemoryIds,
        closedEpisodeIds,
        scheduledEvolution: true,
        jobs: jobs.map(jobToRef),
        changeSeq: responseChangeSeq,
        syncCursor: this.deps.encodeChangeCursor(responseChangeSeq, namespaceForSession(session)),
        etag: stableHash({
          changeSeq: responseChangeSeq,
          l1MemoryIds,
          rawTurnId: rawTurn.id
        }),
        serverTime: nowIso()
      };

      if (idempotencyKey) {
        this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
      }
      return body;
    });

    for (const memoryId of response.l1MemoryIds) {
      const memory = this.deps.repos.memories.get(memoryId);
      recordApiLog(this.deps.repos.runtime, "memory_add", {
        sessionId: response.sessionId,
        turnId,
        episodeId: response.episodeId,
        source: "turn.complete",
        sourceAgent: memory?.agentId,
        query: request.query,
        toolCallCount: normalizeCompleteTurnToolCalls(request).length
      }, {
        stored: 1,
        details: [{
          role: "trace",
          action: "stored",
          sourceAgent: memory?.agentId,
          traceId: memoryId,
          episodeId: response.episodeId,
          query: request.query,
          agent: request.answer,
          summary: memory ? detailSummaryForMemory(memory) || detailTitleForMemory(memory) : undefined
        }]
      }, Date.now() - startedAt, true, response.serverTime, memory?.agentId);
    }

    return response;
  }

  async observeTool(input: ToolObserveRequest): Promise<{
    ok: true;
    eventId: string;
    rawTurnId?: string;
    repair?: DecisionRepairSummary;
    changeSeq?: number;
    syncCursor?: string;
    serverTime: string;
  }> {
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.observeToolNoWrite(input);
    }
    const session = this.deps.requireOpenSession(input.sessionId);
    this.deps.assertSessionInScope(session, input.namespace);
    const episode = this.ensureEpisode(session, input.episodeId);
    const at = nowIso();
    const observation = toolObservationEvent(input);
    const turnId = input.turnId ?? `observe:${stableHash(`${session.id}:${at}:${stableStringify(observation.event)}`).slice(0, 16)}`;
    const existing = this.deps.repos.runtime.getRawTurnBySessionTurn(session.id, turnId);
    if (existing) {
      this.deps.assertRawTurnInScope(existing, input.namespace);
      if (existing.sessionId !== session.id) {
        throw new MemoryServiceError("conflict", "observed raw turn belongs to a different session");
      }
      if (input.episodeId && existing.episodeId !== input.episodeId) {
        throw new MemoryServiceError("conflict", "observed raw turn belongs to a different episode");
      }
    }
    const createdRawTurn = !existing;
    const rawTurn = existing ?? this.deps.repos.runtime.insertRawTurn({
      id: `raw_${stableHash(`${session.id}:${turnId}`).slice(0, 20)}`,
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      userId: session.userId,
      conversationId: session.conversationId,
      toolCalls: [],
      toolResults: [],
      sourceMemoryIds: [],
      usage: {},
      messagePayload: {
        observe: {
          requestId: input.requestId,
          adapterId: input.adapterId
        }
      },
      status: "observed",
      createdAt: at
    });
    const nextToolCalls = rawTurn.toolCalls.some((call) =>
      isToolCallPayload(call) &&
      ((input.toolCallId && call.id === input.toolCallId) || call.name === input.toolName)
    )
      ? rawTurn.toolCalls
      : [...rawTurn.toolCalls, observation.toolCall];
    const updatedRawTurn: RawTurnRecord = {
      ...rawTurn,
      toolCalls: nextToolCalls,
      toolResults: observation.toolResult === undefined ? rawTurn.toolResults : [...rawTurn.toolResults, observation.toolResult],
      messagePayload: {
        ...(rawTurn.messagePayload ?? {}),
        last_observation: {
          phase: observation.phase,
          observed_at: at
        }
      }
    };
    this.deps.repos.runtime.updateRawTurn(updatedRawTurn);
    this.deps.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
    const eventId = this.deps.repos.runtime.insertArtifact({
      sessionId: session.id,
      episodeId: episode.id,
      rawTurnId: rawTurn.id,
      userId: session.userId,
      kind: "tool_call",
      payload: {
        phase: observation.phase,
        value: observation.event
      },
      createdAt: at
    });
    this.deps.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: this.deps.namespaceIdFromSession(session),
      kind: "raw_turn",
      op: createdRawTurn ? "created" : "updated",
      entityId: rawTurn.id,
      userId: session.userId,
      changeType: createdRawTurn ? "raw_turn_created" : "raw_turn_update",
      before: createdRawTurn ? undefined : rawTurn,
      after: updatedRawTurn,
      source: "tools.observe",
      createdAt: at
    });
    const repair = await this.recordToolOutcomeForRepair(input, session, episode, rawTurn, updatedRawTurn, at);
    const responseChangeSeq = this.deps.repos.runtime.latestChangeSeq(session.userId, this.deps.namespaceIdFromSession(session));
    return {
      ok: true,
      eventId,
      rawTurnId: rawTurn.id,
      repair,
      changeSeq: responseChangeSeq,
      syncCursor: this.deps.encodeChangeCursor(responseChangeSeq, namespaceForSession(session)),
      serverTime: nowIso()
    };
  }

  private async recordToolOutcomeForRepair(
    input: ToolObserveRequest,
    session: SessionRecord,
    episode: EpisodeRecord,
    rawTurn: RawTurnRecord,
    updatedRawTurn: RawTurnRecord,
    at: string
  ): Promise<DecisionRepairSummary | undefined> {
    const outcome = toolOutcomeFromObservation(input, rawTurn, updatedRawTurn);
    if (!outcome || outcome.success === undefined) return undefined;
    const context = toolRepairContext(session, episode);
    const step = this.nextToolObservationStep(outcome.toolId, context);
    if (outcome.success) {
      this.recordToolSuccess(outcome.toolId, context, step);
      return undefined;
    }
    const burst = this.recordToolFailure({
      toolId: outcome.toolId,
      context,
      step,
      reason: outcome.reason ?? "tool failed",
      ts: Date.parse(at),
      rawTurnId: rawTurn.id,
      sessionId: session.id,
      episodeId: episode.id
    });
    if (!burst) return undefined;
    return this.maybeCreateFailureBurstRepair({
      burst,
      session,
      episode,
      rawTurn,
      reason: outcome.reason ?? "tool failed",
      at
    });
  }

  private nextToolObservationStep(toolId: string, context: string): number {
    const key = toolSignalKey(toolId, context);
    const next = (this.toolStepCounters.get(key) ?? 0) + 1;
    this.toolStepCounters.set(key, next);
    return next;
  }

  private recordToolFailure(record: ToolFailureRecord): ToolFailureBurst | undefined {
    const key = toolSignalKey(record.toolId, record.context);
    const existing = this.toolFailureStates.get(key);
    const state: ToolFailureState = existing ?? {
      toolId: record.toolId,
      context: record.context,
      firstSeen: record.ts,
      lastSeen: record.ts,
      windowStart: record.step,
      occurrences: []
    };
    const minStep = record.step - this.deps.config.algorithm.feedback.failureWindow + 1;
    state.occurrences = state.occurrences.filter((item) => item.step >= minStep);
    state.occurrences.push(record);
    state.lastSeen = record.ts;
    state.windowStart = minStep;
    if (!existing) state.firstSeen = record.ts;
    this.toolFailureStates.set(key, state);

    const successAt = this.toolSuccessSteps.get(key);
    const successInWindow = successAt !== undefined && successAt >= state.windowStart;
    if (state.occurrences.length >= this.deps.config.algorithm.feedback.failureThreshold && !successInWindow) {
      return {
        ...state,
        contextHash: toolRepairContextHash(record.toolId, record.context),
        failureCount: state.occurrences.length
      };
    }
    return undefined;
  }

  private recordToolSuccess(toolId: string, context: string, step: number): void {
    const key = toolSignalKey(toolId, context);
    this.toolSuccessSteps.set(key, step);
    const state = this.toolFailureStates.get(key);
    if (!state) return;
    state.occurrences = state.occurrences.filter((item) => item.step >= step);
  }

  private async maybeCreateFailureBurstRepair(input: {
    burst: ToolFailureBurst;
    session: SessionRecord;
    episode: EpisodeRecord;
    rawTurn: RawTurnRecord;
    reason: string;
    at: string;
  }): Promise<DecisionRepairSummary> {
    const { burst, session, episode, rawTurn, reason, at } = input;
    const cooldownMs = this.deps.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(at) - cooldownMs).toISOString();
      const recent = this.deps.repos.runtime.listDecisionRepairs({
        userId: session.userId,
        contextHash: burst.contextHash,
        since,
        limit: 1
      });
      if (recent.length > 0) {
        return {
          contextHash: burst.contextHash,
          skipped: true,
          reason: "cooldown"
        };
      }
    }

    const evidence = this.failureBurstRepairEvidence({
      session,
      toolId: burst.toolId,
      reason,
      limit: this.deps.config.algorithm.feedback.evidenceLimit
    });
    const valueDiff = repairEvidenceValueDiff(evidence.highValueMemories, evidence.lowValueMemories);
    if (valueDiff < this.deps.config.algorithm.feedback.valueDelta) {
      return {
        contextHash: burst.contextHash,
        skipped: true,
        reason: "value-delta-low"
      };
    }

    const llmDraft = await this.maybeSynthesizeFailureBurstDecisionRepair(burst, reason, evidence);
    const preference = llmDraft?.preference ?? failureBurstPreference(burst, reason, evidence.highValueMemories[0]);
    const antiPattern = llmDraft?.antiPattern ?? failureBurstAntiPattern(burst, reason);
    const repair = this.deps.repos.runtime.insertDecisionRepair({
      id: newId("repair"),
      sessionId: session.id,
      episodeId: episode.id,
      rawTurnId: rawTurn.id,
      userId: session.userId,
      projectId: session.projectId ?? session.workspaceId,
      contextHash: burst.contextHash,
      issue: `Repeated ${burst.toolId} failure: ${clip(reason, 180)}`,
      suggestion: preference,
      preference,
      antiPattern,
      highValueMemoryIds: evidence.highValueMemories.map((memory) => memory.id),
      lowValueMemoryIds: evidence.lowValueMemories.map((memory) => memory.id),
      attachedPolicyMemoryIds: evidence.policyIds,
      validated: false,
      source: {
        source: "tools.observe.decision_repair.v7",
        trigger: "failure-burst",
        ...(llmDraft ? { synthesis: "llm" } : {}),
        burst: {
          toolId: burst.toolId,
          context: burst.context,
          contextHash: burst.contextHash,
          failureCount: burst.failureCount,
          failures: burst.occurrences.map((failure) => ({
            step: failure.step,
            reason: failure.reason,
            rawTurnId: failure.rawTurnId
          }))
        }
      },
      meta: {
        trigger: "failure-burst",
        severity: llmDraft?.severity ?? "warn",
        confidence: llmDraft?.confidence ??
          (evidence.highValueMemories.length > 0 && evidence.lowValueMemories.length > 0 ? 0.6 : 0.4),
        valueDiff
      },
      createdAt: at
    });
    this.deps.repos.runtime.appendEpisodeDecisionRepair(episode.id, repair.id, at);
    const attachedPolicyIds = evidence.policyIds.length > 0
      ? this.deps.attachRepairToPolicies(repair.id, evidence.policyIds, repair.preference, repair.antiPattern, at)
      : [];
    this.deps.repos.runtime.appendChange({
      memoryId: repair.id,
      namespaceId: this.deps.namespaceIdFromSession(session),
      userId: session.userId,
      kind: "repair",
      op: "created",
      entityId: repair.id,
      changeType: "decision_repair_created",
      after: repair,
      source: "tools.observe.decision_repair.v7",
      createdAt: at
    });
    return {
      repairId: repair.id,
      contextHash: burst.contextHash,
      skipped: false,
      attachedPolicyIds
    };
  }

  private failureBurstRepairEvidence(input: {
    session: SessionRecord;
    toolId: string;
    reason: string;
    limit: number;
  }): {
    highValueMemories: MemoryRow[];
    lowValueMemories: MemoryRow[];
    policyIds: string[];
  } {
    const query = `${input.toolId}\n${input.reason}`;
    const policies = this.deps.repos.memories.search(
      query,
      {
        memoryLayer: "L2",
        status: "activated"
      },
      input.limit
    );
    const policyIds = policies.map((policy) => policy.id);
    const l1Hits = this.deps.repos.memories.search(
      query,
      {
        memoryLayer: "L1",
        status: "activated"
      },
      input.limit * 4
    );
    const highValueMemories: MemoryRow[] = [];
    const lowValueMemories: MemoryRow[] = [];
    for (const hit of l1Hits) {
      const memory = this.deps.repos.memories.get(hit.id);
      if (!memory) continue;
      const trace = this.deps.traceMeta(memory);
      if (!trace) continue;
      if (trace.value > 0 && highValueMemories.length < input.limit) {
        highValueMemories.push(memory);
      }
      if (
        trace.value < -this.deps.config.algorithm.feedback.minLowValueThreshold &&
        lowValueMemories.length < input.limit
      ) {
        lowValueMemories.push(memory);
      }
    }
    for (const policy of this.deps.repos.memories.getMany(policyIds)) {
      const meta = policyMetaFromMemory(policy);
      if (!meta) continue;
      for (const memory of this.deps.repos.memories.getMany(meta.sourceTraceIds)) {
        const trace = this.deps.traceMeta(memory);
        if (!trace) continue;
        if (trace.value > 0 && highValueMemories.length < input.limit && !highValueMemories.some((item) => item.id === memory.id)) {
          highValueMemories.push(memory);
        }
        if (
          trace.value < -this.deps.config.algorithm.feedback.minLowValueThreshold &&
          lowValueMemories.length < input.limit &&
          !lowValueMemories.some((item) => item.id === memory.id)
        ) {
          lowValueMemories.push(memory);
        }
      }
    }
    return {
      highValueMemories,
      lowValueMemories,
      policyIds
    };
  }

  private async maybeSynthesizeFailureBurstDecisionRepair(
    burst: ToolFailureBurst,
    reason: string,
    evidence: {
      highValueMemories: MemoryRow[];
      lowValueMemories: MemoryRow[];
      policyIds: string[];
    }
  ): Promise<DecisionRepairLlmDraft | undefined> {
    return this.deps.synthesizeDecisionRepairDraft({
      trigger: "failure-burst",
      contextHash: burst.contextHash,
      feedbackText: `${burst.toolId}: ${reason}`,
      classification: {
        shape: "negative",
        confidence: 0.6,
        avoid: reason,
        text: reason
      },
      highValue: this.deps.decisionRepairTraceSources(evidence.highValueMemories),
      lowValue: this.deps.decisionRepairTraceSources(evidence.lowValueMemories),
      traceCharCap: this.deps.config.algorithm.feedback.traceCharCap
    });
  }

  subagentStart(input: SubagentStartRequest): {
    ok: true;
    eventId: string;
    childSessionId?: string;
    rawTurnId: string;
    changeSeq: number;
    syncCursor: string;
    serverTime: string;
  } {
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.subagentStartNoWrite(input);
    }
    const session = this.deps.requireOpenSession(input.sessionId);
    this.deps.assertSessionInScope(session, input.namespace);
    const episode = this.ensureEpisode(session, input.episodeId);
    const at = nowIso();
    const metadata = input.metadata ?? {};
    const subagentId = input.subagentId ?? newId("subagent");
    const rawTurnId = newId("raw");
    const turnId = `subagent:start:${subagentId}:${rawTurnId.slice("raw_".length, "raw_".length + 12)}`;
    const rawTurn = this.deps.repos.runtime.insertRawTurn({
      id: rawTurnId,
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      userId: session.userId,
      conversationId: session.conversationId,
      userText: input.task,
      toolCalls: [],
      toolResults: [],
      sourceMemoryIds: [],
      usage: {},
      messagePayload: {
        subagentStart: {
          subagentId,
          task: input.task,
          metadata
        }
      },
      status: "started",
      createdAt: at
    });
    this.deps.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
    const changeSeq = this.deps.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: this.deps.namespaceIdFromSession(session),
      kind: "raw_turn",
      op: "created",
      entityId: rawTurn.id,
      userId: session.userId,
      changeType: "raw_turn_created",
      after: rawTurn,
      source: "subagent.start",
      createdAt: at
    });
    const eventId = this.deps.repos.runtime.insertArtifact({
      sessionId: session.id,
      episodeId: episode.id,
      rawTurnId: rawTurn.id,
      userId: session.userId,
      kind: "subagent_start",
      payload: {
        subagentId,
        task: input.task,
        metadata
      },
      createdAt: at
    });
    this.deps.repos.runtime.insertAudit({
      userId: session.userId,
      sessionId: session.id,
      actor: input.namespace ? { ...input.namespace } : {},
      action: "subagent_start",
      targetKind: "raw_turn",
      targetId: rawTurn.id,
      meta: { subagentId },
      createdAt: at
    });
    return {
      ok: true,
      eventId,
      rawTurnId: rawTurn.id,
      changeSeq,
      syncCursor: this.deps.encodeChangeCursor(changeSeq, namespaceForSession(session)),
      serverTime: nowIso()
    };
  }

  subagentComplete(input: SubagentCompleteRequest): CompleteTurnResponse {
    const metadata = input.metadata ?? {};
    const subagentId = input.subagentId ?? "subagent";
    const turnId = `subagent:complete:${subagentId}:${stableHash(stableStringify(input.result ?? input.summary ?? "")).slice(0, 12)}`;
    const result = this.completeTurn(turnId, {
      adapterId: input.adapterId,
      requestId: input.requestId,
      namespace: input.namespace,
      sessionId: input.sessionId,
      query: `Subagent ${subagentId} completed.`,
      answer: input.result ?? input.summary ?? "Subagent completed.",
      status: input.status ?? "succeeded",
    });
    const rawTurn = this.deps.repos.runtime.getRawTurn(result.rawTurnId);
    if (rawTurn) {
      const at = nowIso();
      const nextRawTurn = {
        ...rawTurn,
        messagePayload: {
          ...(rawTurn.messagePayload ?? {}),
          subagentComplete: {
            subagentId,
            summary: input.summary,
            metadata
          }
        }
      };
      const updatedRawTurn = this.deps.repos.runtime.updateRawTurn(nextRawTurn);
      if (stableHash(rawTurn) !== stableHash(updatedRawTurn)) {
        const session = this.deps.repos.runtime.getSession(updatedRawTurn.sessionId);
        const cursorNamespace = session ? namespaceForSession(session) : namespaceForRawTurn(updatedRawTurn);
        const changeSeq = this.deps.repos.runtime.appendChange({
          memoryId: updatedRawTurn.id,
          namespaceId: this.deps.namespaceIdFromContext(cursorNamespace),
          kind: "raw_turn",
          op: "updated",
          entityId: updatedRawTurn.id,
          userId: updatedRawTurn.userId,
          changeType: "raw_turn_update",
          before: rawTurn,
          after: updatedRawTurn,
          source: "subagent.complete",
          createdAt: at
        });
        return {
          ...result,
          changeSeq,
          syncCursor: this.deps.encodeChangeCursor(changeSeq, cursorNamespace),
          etag: stableHash({
            etag: result.etag,
            rawTurnId: updatedRawTurn.id,
            changeSeq
          }),
          serverTime: nowIso()
        };
      }
    }
    return result;
  }

  async repairSuggestion(input: RepairSuggestionRequest): Promise<{
    suggestedAction: "none" | "append_hint" | "replacement_suggestion";
    appendHint?: {
      content: string;
      sourceMemoryIds: string[];
    };
    replacementSuggestion?: {
      content: string;
      sourceMemoryIds: string[];
    };
    reason?: string;
    sourceMemoryIds: string[];
  }> {
    if (!this.deps.memorySearchEnabled()) {
      return {
        suggestedAction: "none",
        reason: "memory_search:disabled",
        sourceMemoryIds: []
      };
    }
    const session = this.deps.requireOpenSession(input.sessionId);
    this.deps.assertSessionInScope(session, input.namespace);
    const episode = this.deps.repos.runtime.latestEpisodeForSession(input.sessionId);
    const contextHash = input.toolName && episode
      ? toolRepairContextHash(input.toolName, toolRepairContext(session, episode))
      : undefined;
    const query = buildRepairSuggestionQuery(input);
    const repairLayers = retrievalLayersForMode("decision_repair");
    const candidates = this.deps.repos.memories.list(
      {
        memoryLayer: repairLayers,
        status: ["activated", "resolving"]
      },
      500
    ).filter((memory) => this.deps.isMemoryReadyForRetrieval(memory));
    const retrieval = retrievePluginMemories({
      query,
      queryVector: await this.deps.queryVector(query),
      memories: candidates,
      mode: "decision_repair",
      layers: repairLayers,
      limit: 5,
      config: this.deps.retrievalTuningConfig()
    });
    const retrievedMemories = this.deps.repos.memories.getMany(retrieval.hits.map((hit) => hit.id));
    const policyMemories = retrievedMemories.filter((memory) => memory.memoryLayer === "L2");
    const retrievedMemoryById = new Map(retrievedMemories.map((memory) => [memory.id, memory]));
    const policyGuidance = policyMemories.flatMap((memory) => {
      const policy = policyMetaFromMemory(memory);
      if (!policy) return [];
      return [
        ...policy.decisionGuidance.preference,
        ...policy.decisionGuidance.antiPattern,
        policy.procedure ? `Related policy: ${clip(policy.procedure, 220)}` : undefined
      ].filter((item): item is string => Boolean(item));
    });
    const retrievalGuidance = retrieval.hits
      .filter((hit) => !policyMemories.some((memory) => memory.id === hit.id))
      .map((hit) => {
        const memory = retrievedMemoryById.get(hit.id);
        const trace = memory ? traceMetaFromMemory(memory) : null;
        const toolText = trace?.toolCalls
          .map((call) => [
            call.name,
            this.deps.stringifyForMemory(call.input),
            this.deps.stringifyForMemory(call.output),
            call.error
          ].filter(Boolean).join(" "))
          .join("\n");
        const snippet = memory
          ? firstDetailDisplayString(toolText, memory.memoryValue, detailSummaryForMemory(memory), hit.snippet)
          : hit.snippet;
        return `Relevant ${hit.kind}: ${clip(snippet ?? "", 500)}`;
      });
    const repairs = contextHash
      ? this.deps.repos.runtime.listDecisionRepairs({
          userId: session.userId,
          contextHash,
          limit: 5
        })
      : [];
    const repairGuidance = repairs.flatMap((repair) => [
      repair.preference,
      repair.antiPattern
    ].filter((item): item is string => Boolean(item)));
    const hint = uniq([
      ...repairGuidance,
      ...policyGuidance,
      ...retrievalGuidance
    ]).join("\n");
    const retrievedRawTurnIds = new Set(
      retrievedMemories
        .map((memory) => this.deps.rawTurnIdFromMemory(memory))
        .filter((id): id is string => Boolean(id))
    );
    const retrievedSiblingTraceIds = retrievedRawTurnIds.size > 0
      ? candidates
          .filter((memory) => memory.memoryLayer === "L1" && retrievedRawTurnIds.has(this.deps.rawTurnIdFromMemory(memory) ?? ""))
          .map((memory) => memory.id)
      : [];
    const sourceMemoryIds = uniq([
      ...retrievedMemories.flatMap((memory) => this.deps.retrievedMemorySourceIds(memory)),
      ...retrievedSiblingTraceIds,
      ...repairs.flatMap((repair) => repair.attachedPolicyMemoryIds),
      ...repairs.flatMap((repair) => repair.highValueMemoryIds)
    ]);
    return {
      suggestedAction: hint ? "append_hint" : "none",
      appendHint: hint ? {
        content: hint,
        sourceMemoryIds
      } : undefined,
      reason: repairGuidance.length > 0
        ? "matched decision repair guidance"
        : policyGuidance.length > 0
          ? "matched L2 repair policies"
            : retrievalGuidance.length > 0
              ? "matched decision repair retrieval"
              : "no repair guidance found",
      sourceMemoryIds
    };
  }

  private captureEpisodeIncrementalSteps(
    episode: EpisodeRecord,
    currentRawTurn: RawTurnRecord,
    at: string
  ): ReturnType<typeof captureTurnSteps> {
    const seenRawTurnIds = new Set(
      episode.l1MemoryIds
        .map((id) => this.deps.repos.memories.get(id))
        .filter((memory): memory is MemoryRow => Boolean(memory))
        .map((memory) => this.deps.rawTurnIdFromMemory(memory))
        .filter((id): id is string => Boolean(id))
    );
    const rawTurns = uniq([...episode.rawTurnIds, currentRawTurn.id])
      .map((id) => id === currentRawTurn.id ? currentRawTurn : this.deps.repos.runtime.getRawTurn(id))
      .filter((rawTurn): rawTurn is RawTurnRecord =>
        Boolean(rawTurn && (rawTurn.id === currentRawTurn.id || !seenRawTurnIds.has(rawTurn.id)))
      )
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return rawTurns.flatMap((rawTurn) =>
      captureTurnSteps({
        episodeId: episode.id,
        sessionId: rawTurn.sessionId,
        turnId: rawTurn.turnId,
        userText: rawTurn.userText ?? "",
        assistantText: rawTurn.assistantText ?? "",
        reasoningSummary: rawTurn.reasoningSummary,
        toolCalls: rawTurn.toolCalls.filter(isToolCallPayload),
        toolResults: rawTurn.toolResults,
        createdAtIso: rawTurn.createdAt || at,
        maxTextChars: this.deps.config.algorithm.capture.maxTextChars,
        maxToolOutputChars: this.deps.config.algorithm.capture.maxToolOutputChars
      }).map((step) => ({ ...step, rawTurnId: rawTurn.id }))
    );
  }

  private async ensureEpisodeForTurnWithLlm(
    session: SessionRecord,
    episodeId: string | undefined,
    userText: string | undefined,
    source: string
  ): Promise<EpisodeRecord> {
    if (episodeId || !userText?.trim()) {
      return this.ensureEpisode(session, episodeId);
    }
    const latest = this.deps.repos.runtime.latestEpisodeForSession(session.id);
    if (!latest) {
      return this.ensureEpisode(session);
    }
    const relationContext = this.episodeRelationContext(latest);
    if (!relationContext.prevUserText) {
      return this.ensureEpisode(session);
    }
    const decision = await classifyTurnRelationWithLlm({
      prevUserText: relationContext.prevUserText,
      prevAssistantText: relationContext.prevAssistantText,
      newUserText: userText,
      gapMs: relationContext.lastTurnAtMs
        ? Math.max(0, Date.now() - relationContext.lastTurnAtMs)
        : undefined,
      prevTags: relationContext.tags
    }, {
      llm: this.deps.llm
    });
    return this.applyEpisodeRelationDecision(session, latest, decision, userText, source, relationContext.lastTurnAtMs);
  }

  private ensureEpisodeForTurn(
    session: SessionRecord,
    episodeId: string | undefined,
    userText: string | undefined,
    source: string
  ): EpisodeRecord {
    if (episodeId || !userText?.trim()) {
      return this.ensureEpisode(session, episodeId);
    }
    const latest = this.deps.repos.runtime.latestEpisodeForSession(session.id);
    if (!latest) {
      return this.ensureEpisode(session);
    }
    const relationContext = this.episodeRelationContext(latest);
    if (!relationContext.prevUserText) {
      return this.ensureEpisode(session);
    }
    const decision = classifyTurnRelation({
      prevUserText: relationContext.prevUserText,
      prevAssistantText: relationContext.prevAssistantText,
      newUserText: userText,
      gapMs: relationContext.lastTurnAtMs
        ? Math.max(0, Date.now() - relationContext.lastTurnAtMs)
        : undefined,
      prevTags: relationContext.tags
    });
    return this.applyEpisodeRelationDecision(session, latest, decision, userText, source, relationContext.lastTurnAtMs);
  }

  private applyEpisodeRelationDecision(
    session: SessionRecord,
    latest: EpisodeRecord,
    decision: ReturnType<typeof classifyTurnRelation>,
    userText: string,
    source: string,
    lastTurnAtMs?: number
  ): EpisodeRecord {
    const mergeMode = this.deps.config.algorithm.session.followUpMode === "merge_follow_ups";
    const gapMs = lastTurnAtMs ? Math.max(0, Date.now() - lastTurnAtMs) : 0;
    const withinMergeWindow =
      this.deps.config.algorithm.session.mergeMaxGapMs === 0 ||
      gapMs <= this.deps.config.algorithm.session.mergeMaxGapMs;
    const shouldAppendOpen =
      mergeMode &&
      withinMergeWindow &&
      (decision.relation === "revision" ||
        decision.relation === "follow_up" ||
        decision.relation === "unknown");
    if (latest.status === "open") {
      if (shouldAppendOpen) {
        if (decision.relation === "revision") {
          this.recordRevisionFeedback(session, latest, userText, source);
        }
        return this.deps.repos.runtime.updateEpisodeMeta(latest.id, {
          relation: decision.relation,
          relationDecision: decision,
          relationRouting: {
            action: "append_to_open_episode",
            mergeMode,
            withinMergeWindow,
            gapMs
          }
        }) ?? latest;
      }
      if (decision.relation === "new_task" || !shouldAppendOpen) {
        this.recordImplicitTurnFeedback(session, latest, userText);
        const at = nowIso();
        const closed = this.deps.repos.runtime.closeEpisode(latest.id, {
          closeReason: "topic_boundary",
          relation: decision.relation,
          relationDecision: decision,
          relationRouting: {
            action: decision.relation === "new_task"
              ? "close_open_and_start_new_task"
              : "close_open_and_start_new_episode",
            mergeMode,
            withinMergeWindow,
            gapMs
          },
          closedBy: source
        }, at);
        if (closed) {
          this.deps.repos.runtime.appendChange({
            memoryId: closed.id,
            namespaceId: this.deps.namespaceIdFromSession(session),
            kind: "episode",
            op: "updated",
            entityId: closed.id,
            userId: closed.userId,
            changeType: "episode_closed",
            before: latest,
            after: closed,
            source,
            createdAt: at
          });
          this.deps.finalizeClosedEpisode(closed, at, "topic_boundary");
        }
        const next = this.ensureEpisode(session);
        return this.deps.repos.runtime.updateEpisodeMeta(next.id, {
          relation: decision.relation,
          relationDecision: decision,
          previousEpisodeId: latest.id,
          relationRouting: {
            action: decision.relation === "new_task"
              ? "start_new_task_episode"
              : "start_new_episode",
            mergeMode,
            withinMergeWindow,
            gapMs
          }
        }, at) ?? next;
      }
      return this.deps.repos.runtime.updateEpisodeMeta(latest.id, {
        relation: decision.relation,
        relationDecision: decision
      }) ?? latest;
    }

    const shouldReopenClosed =
      decision.relation === "revision" ||
      (mergeMode &&
        withinMergeWindow &&
        (decision.relation === "follow_up" || decision.relation === "unknown"));
    if (shouldReopenClosed) {
      const at = nowIso();
      const reopened = this.deps.repos.runtime.reopenEpisode(latest.id, {
        relation: decision.relation,
        relationDecision: decision,
        reopenedAt: at,
        reopenReason: decision.relation === "revision" ? "revision" : "follow_up",
        relationRouting: {
          action: "reopen_previous_episode",
          mergeMode,
          withinMergeWindow,
          gapMs
        },
        rewardDirty: {
          reason: "episode_reopened",
          reopenedFor: decision.relation,
          at
        }
      }, at);
      if (reopened) {
        this.deps.repos.runtime.appendChange({
          memoryId: reopened.id,
          namespaceId: this.deps.namespaceIdFromSession(session),
          kind: "episode",
          op: "updated",
          entityId: reopened.id,
          userId: reopened.userId,
          changeType: "episode_reopened",
          before: latest,
          after: reopened,
          source,
          createdAt: at
        });
        if (decision.relation === "revision") {
          this.recordRevisionFeedback(session, reopened, userText, source);
        }
        return reopened;
      }
    }

    this.recordImplicitTurnFeedback(session, latest, userText);
    this.deps.finalizeClosedEpisode(latest, nowIso(), "topic_boundary");
    const next = this.ensureEpisode(session);
    return this.deps.repos.runtime.updateEpisodeMeta(next.id, {
      relation: decision.relation,
      relationDecision: decision,
      previousEpisodeId: latest.id,
      relationRouting: {
        action: decision.relation === "new_task" ? "start_new_task_episode" : "start_new_episode",
        mergeMode,
        withinMergeWindow,
        gapMs
      }
    }) ?? next;
  }

  private episodeRelationContext(episode: EpisodeRecord): {
    prevUserText: string;
    prevAssistantText: string;
    lastTurnAtMs?: number;
    tags: string[];
  } {
    const rawTurns = episode.rawTurnIds
      .map((id) => this.deps.repos.runtime.getRawTurn(id))
      .filter((rawTurn): rawTurn is RawTurnRecord => Boolean(rawTurn))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const userTurns = rawTurns
      .map((rawTurn) => rawTurn.userText?.trim())
      .filter((text): text is string => Boolean(text));
    const assistantTurns = rawTurns
      .map((rawTurn) => rawTurn.assistantText?.trim())
      .filter((text): text is string => Boolean(text));
    const firstUser = userTurns[0] ?? "";
    const lastUser = userTurns[userTurns.length - 1] ?? "";
    const lastAssistant = assistantTurns[assistantTurns.length - 1] ?? "";
    const prevUserText = firstUser && lastUser && firstUser !== lastUser
      ? [
          `[Task topic]: ${firstUser.slice(0, 300)}`,
          `[Latest user message]: ${lastUser.slice(0, 700)}`
        ].join("\n\n")
      : (lastUser || firstUser).slice(0, 1000);
    const tags = uniq(
      episode.l1MemoryIds.flatMap((id) => this.deps.repos.memories.get(id)?.tags ?? [])
    );
    const lastTurnAtMs = rawTurns.length > 0
      ? Date.parse(rawTurns[rawTurns.length - 1]!.createdAt)
      : undefined;
    return {
      prevUserText,
      prevAssistantText: lastAssistant.slice(0, 2000),
      lastTurnAtMs: Number.isFinite(lastTurnAtMs) ? lastTurnAtMs : undefined,
      tags
    };
  }

  private recordImplicitTurnFeedback(
    session: SessionRecord,
    episode: EpisodeRecord,
    userText: string
  ): void {
    const target = this.deps.feedbackTargetFromEpisode(episode);
    if (!target) return;
    const rawTurnId = this.deps.rawTurnIdFromMemory(target);
    const rawTurn = rawTurnId ? this.deps.repos.runtime.getRawTurn(rawTurnId) : undefined;
    const trace = this.deps.traceMeta(target);
    const classification = classifyTurnFeedback({
      userText,
      agentText: rawTurn?.assistantText ?? trace?.agentText
    });
    if (!classification.isFeedback || classification.confidence < 0.6) return;
    const polarity = this.deps.polarityFromTurnFeedback(classification);
    if (polarity === "neutral" && classification.magnitude <= 0) return;

    const contextHash = stableHash({
      source: "turn.feedback_classifier",
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      userText,
      polarity,
      method: classification.method
    }).slice(0, 32);
    const duplicate = this.deps.repos.runtime.listFeedback({
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      limit: 20
    }).some((feedback) => feedback.contextHash === contextHash);
    if (duplicate) return;

    const at = nowIso();
    const rawPayload = {
      source: "turn_feedback_classifier",
      method: classification.method,
      confidence: classification.confidence,
      classifierPolarity: classification.polarity
    };
    const feedbackRequest: FeedbackRequest = {
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "implicit",
      polarity,
      magnitude: classification.magnitude,
      rationale: classification.rationale,
      rawPayload,
      namespace: namespaceForSession(session)
    };
    const feedback = this.deps.repos.runtime.insertFeedback({
      id: newId("feedback"),
      userId: session.userId,
      projectId: session.projectId,
      conversationId: session.conversationId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "implicit",
      polarity,
      magnitude: classification.magnitude,
      rationale: classification.rationale,
      rawPayload,
      contextHash,
      createdAt: at
    });
    this.deps.repos.runtime.appendEpisodeFeedback(episode.id, feedback.id, at);
    this.deps.maybeCreateDecisionRepair(feedbackRequest, feedback, contextHash, this.deps.namespaceIdFromSession(session));
    this.deps.enqueueJob({
      jobType: "reward",
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      payload: {
        feedbackId: feedback.id,
        l1MemoryId: target.id,
        channel: feedback.channel,
        polarity: feedback.polarity,
        magnitude: feedback.magnitude,
        rationale: feedback.rationale,
        trigger: "implicit_turn_feedback"
      },
      createdAt: at
    });
    for (const trial of this.deps.pendingTrialsForFeedback(feedback)) {
      this.deps.enqueueJob({
        jobType: "skill_trial_resolve",
        userId: session.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        payload: {
          trialId: trial.id,
          feedbackId: feedback.id,
          targetKind: "skill_trial",
          trigger: "implicit_turn_feedback"
        },
        createdAt: at
      });
    }
    this.deps.repos.runtime.appendChange({
      memoryId: target.id,
      namespaceId: this.deps.namespaceIdFromSession(session),
      kind: "feedback",
      op: "created",
      entityId: feedback.id,
      userId: session.userId,
      changeType: "feedback",
      after: feedback,
      source: "turn.feedback_classifier",
      createdAt: at
    });
  }

  private recordRevisionFeedback(
    session: SessionRecord,
    episode: EpisodeRecord,
    userText: string,
    source: string
  ): void {
    const target = this.deps.feedbackTargetFromEpisode(episode);
    if (!target) return;
    const contextHash = stableHash({
      source: "relation.revision",
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      userText
    }).slice(0, 32);
    const duplicate = this.deps.repos.runtime.listFeedback({
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      limit: 20
    }).some((feedback) => feedback.contextHash === contextHash);
    if (duplicate) return;

    const at = nowIso();
    const rawTurnId = this.deps.rawTurnIdFromMemory(target);
    const rawPayload = {
      source: "relation_classifier",
      relation: "revision"
    };
    const feedbackRequest: FeedbackRequest = {
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: userText,
      rawPayload,
      namespace: namespaceForSession(session)
    };
    const feedback = this.deps.repos.runtime.insertFeedback({
      id: newId("feedback"),
      userId: session.userId,
      projectId: session.projectId,
      conversationId: session.conversationId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: userText,
      rawPayload,
      contextHash,
      createdAt: at
    });
    this.deps.repos.runtime.appendEpisodeFeedback(episode.id, feedback.id, at);
    this.deps.maybeCreateDecisionRepair(feedbackRequest, feedback, contextHash, this.deps.namespaceIdFromSession(session));
    this.deps.enqueueJob({
      jobType: "reward",
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      payload: {
        feedbackId: feedback.id,
        l1MemoryId: target.id,
        channel: feedback.channel,
        polarity: feedback.polarity,
        magnitude: feedback.magnitude,
        rationale: feedback.rationale,
        trigger: "revision_feedback"
      },
      createdAt: at
    });
    for (const trial of this.deps.pendingTrialsForFeedback(feedback)) {
      this.deps.enqueueJob({
        jobType: "skill_trial_resolve",
        userId: session.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        payload: {
          trialId: trial.id,
          feedbackId: feedback.id,
          targetKind: "skill_trial",
          trigger: "revision_feedback"
        },
        createdAt: at
      });
    }
    this.deps.repos.runtime.appendChange({
      memoryId: target.id,
      namespaceId: this.deps.namespaceIdFromSession(session),
      kind: "feedback",
      op: "created",
      entityId: feedback.id,
      userId: session.userId,
      changeType: "feedback",
      after: feedback,
      source,
      createdAt: at
    });
  }

  ensureEpisode(session: SessionRecord, episodeId?: string): EpisodeRecord {
    if (episodeId) {
      const existing = this.deps.repos.runtime.getEpisode(episodeId);
      if (existing) {
        return existing;
      }
    }

    const latest = episodeId ? undefined : this.deps.repos.runtime.latestEpisodeForSession(session.id);
    if (latest && latest.status === "open") {
      return latest;
    }

    const at = nowIso();
    const episode = this.deps.repos.runtime.createEpisode({
      id: episodeId ?? newId("episode"),
      sessionId: session.id,
      userId: session.userId,
      projectId: session.projectId ?? session.workspaceId,
      conversationId: session.conversationId,
      status: "open",
      l1MemoryIds: [],
      rawTurnIds: [],
      feedbackIds: [],
      decisionRepairIds: [],
      l2PolicyIds: [],
      l3WorldModelIds: [],
      skillMemoryIds: [],
      turnCount: 0,
      rewardDetail: {},
      pipelineStatus: "idle",
      meta: {},
      openedAt: at,
      updatedAt: at
    });
    this.deps.repos.runtime.appendChange({
      memoryId: episode.id,
      namespaceId: this.deps.namespaceIdFromSession(session),
      kind: "episode",
      op: "created",
      entityId: episode.id,
      userId: episode.userId,
      changeType: "episode_opened",
      after: episode,
      source: "session.episode",
      createdAt: at
    });
    return episode;
  }
}
