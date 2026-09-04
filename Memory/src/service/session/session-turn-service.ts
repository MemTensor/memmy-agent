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
  traceMetaFromMemory,
  type IntentDecision,
  type TurnRelationDecision
} from "../../algorithm/plugin-algorithms.js";
import {
  type MemmyConfig
} from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import {
  jobToRef,
  L3WorldModelScopeWorkspaceConflictError,
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
  RecallMemoryLayer,
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
import { memoryCaptureQaHash, normalizeMemoryCaptureSource } from "../../utils/memory-capture-claim.js";
import { isMemmyRecallToolName } from "../../utils/memmy-context-tags.js";
import { clip } from "../../utils/text.js";
import { nowIso } from "../../utils/time.js";
import {
  buildUserMemory,
  classifyUserMemory,
  isDynamicCurrentFactQuery,
  isPureUserMemoryStatement,
  isQuestionLike,
  isTaskLinkedUserFeedback,
  isUserMemoryQuestion
} from "../user-memory/user-memory.js";
import type {
  DecisionRepairLlmDraft,
  SynthesizeDecisionRepairDraft
} from "../feedback/feedback-experience.js";
import { recordApiLog } from "../model-audit/model-call-audit.js";
import {
  namespaceForRawTurn,
  namespaceForSession,
  normalizeNamespace,
  resolveV2WorkspaceIdentityForOpenRequest,
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
interface CompleteTurnResponse { turnId: string; sessionId: string; episodeId: string; rawTurnId: string; userMemoryId: string; userMemoryIds: string[]; l1MemoryId: string; l1MemoryIds: string[]; closedEpisodeIds: string[]; scheduledEvolution: boolean; jobs: JobRef[]; changeSeq: number; syncCursor: string; etag: string; serverTime: string; duplicate?: boolean; }
type EndTopicDecision = TurnRelationDecision & { relation: "end_topic" };
interface EpisodeTurnRoute { episode: EpisodeRecord; endTopicDecision?: EndTopicDecision; }
type TurnRouteAction = "create_first" | "append" | "split" | "end_topic";
interface TurnRouteProposal {
  action: TurnRouteAction;
  baseEpisodeId?: string;
  relationDecision: TurnRelationDecision;
  proposedAt: string;
  mergeMode: boolean;
  withinMergeWindow: boolean;
  gapMs: number;
}
interface CommittedTurnRoute extends EpisodeTurnRoute {
  closedEpisodeIds: string[];
  jobs: EvolutionJobRecord[];
  proposal: TurnRouteProposal;
  proposalStale: boolean;
}

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
const EXPLICIT_END_TOPIC_COMMANDS = new Set([
  "结束会话",
  "不聊了"
]);

function turnRouteProposalFromRecallRequest(request: unknown): TurnRouteProposal | undefined {
  if (!isRecord(request) || !isRecord(request.routeProposal)) return undefined;
  const proposal = request.routeProposal;
  const decision = isRecord(proposal.relationDecision) ? proposal.relationDecision : undefined;
  const action = proposal.action;
  if (
    (action !== "create_first" && action !== "append" && action !== "split" && action !== "end_topic") ||
    !decision ||
    (decision.relation !== "revision" &&
      decision.relation !== "follow_up" &&
      decision.relation !== "new_task" &&
      decision.relation !== "end_topic" &&
      decision.relation !== "unknown") ||
    typeof decision.confidence !== "number" ||
    typeof decision.reason !== "string" ||
    !Array.isArray(decision.signals) ||
    !decision.signals.every((signal) => typeof signal === "string") ||
    typeof proposal.proposedAt !== "string" ||
    typeof proposal.mergeMode !== "boolean" ||
    typeof proposal.withinMergeWindow !== "boolean" ||
    typeof proposal.gapMs !== "number"
  ) {
    return undefined;
  }
  return {
    action,
    ...(typeof proposal.baseEpisodeId === "string" ? { baseEpisodeId: proposal.baseEpisodeId } : {}),
    relationDecision: {
      relation: decision.relation,
      confidence: decision.confidence,
      reason: decision.reason,
      signals: decision.signals as string[],
      ...(typeof decision.llmModel === "string" ? { llmModel: decision.llmModel } : {})
    },
    proposedAt: proposal.proposedAt,
    mergeMode: proposal.mergeMode,
    withinMergeWindow: proposal.withinMergeWindow,
    gapMs: proposal.gapMs
  };
}

function turnIntentDecisionFromRecallRequest(request: unknown): IntentDecision | undefined {
  if (!isRecord(request) || !isRecord(request.turnIntentDecision)) return undefined;
  const decision = request.turnIntentDecision;
  const retrieval = isRecord(decision.retrieval) ? decision.retrieval : undefined;
  if (
    (decision.kind !== "task" &&
      decision.kind !== "memory_probe" &&
      decision.kind !== "chitchat" &&
      decision.kind !== "meta" &&
      decision.kind !== "unknown") ||
    typeof decision.confidence !== "number" ||
    typeof decision.reason !== "string" ||
    !Array.isArray(decision.signals) ||
    !decision.signals.every((signal) => typeof signal === "string") ||
    !retrieval ||
    typeof retrieval.tier1 !== "boolean" ||
    typeof retrieval.tier2 !== "boolean" ||
    typeof retrieval.tier3 !== "boolean"
  ) {
    return undefined;
  }
  return decision as unknown as IntentDecision;
}

function turnContextPacketId(
  sessionId: string,
  baseEpisodeId: string | undefined,
  turnId: string,
  searchEventId: string
): string {
  return `ctx_${stableHash(`${sessionId}:${baseEpisodeId ?? "unbound"}:${turnId}:${searchEventId}`).slice(0, 20)}`;
}

function explicitEndTopicDecision(text: string): EndTopicDecision | undefined {
  const command = text
    .trim()
    .toLowerCase()
    .replace(/[。！？!?.,，、;；:："'“”‘’]+$/gu, "")
    .replace(/\s+/gu, " ");
  if (!EXPLICIT_END_TOPIC_COMMANDS.has(command)) {
    return undefined;
  }
  return {
    relation: "end_topic",
    confidence: 1,
    reason: "explicit end-topic command",
    signals: ["explicit_end_topic_command"]
  };
}

function endTopicDecisionFromRawTurn(rawTurn: RawTurnRecord): EndTopicDecision | undefined {
  const turnStart = isRecord(rawTurn.messagePayload?.turn_start)
    ? rawTurn.messagePayload.turn_start
    : undefined;
  const close = turnStart && isRecord(turnStart.episode_close)
    ? turnStart.episode_close
    : undefined;
  const decision = close && isRecord(close.decision) ? close.decision : undefined;
  if (
    close?.closeAfterComplete !== true ||
    decision?.relation !== "end_topic" ||
    typeof decision.confidence !== "number" ||
    typeof decision.reason !== "string" ||
    !Array.isArray(decision.signals) ||
    !decision.signals.every((signal) => typeof signal === "string")
  ) {
    return undefined;
  }
  return {
    relation: "end_topic",
    confidence: decision.confidence,
    reason: decision.reason,
    signals: decision.signals,
    ...(typeof decision.llmModel === "string" ? { llmModel: decision.llmModel } : {})
  };
}

function rawTurnIsExcludedFromL1(rawTurn: RawTurnRecord): boolean {
  if (endTopicDecisionFromRawTurn(rawTurn)) {
    return true;
  }
  const turnStart = isRecord(rawTurn.messagePayload?.turn_start)
    ? rawTurn.messagePayload.turn_start
    : undefined;
  const intentDecision = turnStart && isRecord(turnStart.intent_decision)
    ? turnStart.intent_decision
    : undefined;
  const kind = typeof intentDecision?.kind === "string"
    ? intentDecision.kind
    : classifyIntent(rawTurn.userText ?? "").kind;
  if (kind === "chitchat" || kind === "meta" || kind === "memory_probe") return true;
  if (isUserMemoryQuestion(rawTurn.userText ?? "")) return true;
  if (isDynamicCurrentFactQuery(rawTurn.userText ?? "")) return true;
  const taskLinkedFeedback = isTaskLinkedUserFeedback(rawTurn.userText ?? "");
  const hasOnlyRecalledMemoryEvidence = rawTurn.sourceMemoryIds.length > 0 && (
    (rawTurn.toolCalls.length === 0 && rawTurn.toolResults.length === 0) ||
    (rawTurn.toolCalls.length > 0 && rawTurn.toolCalls.every((call) =>
      isToolCallPayload(call) && isMemmyRecallToolName(call.name)
    ))
  );
  if (
    !taskLinkedFeedback &&
    hasOnlyRecalledMemoryEvidence
  ) return true;
  if (
    isPureUserMemoryStatement(rawTurn.userText ?? "") &&
    rawTurn.toolCalls.length === 0 &&
    rawTurn.toolResults.length === 0 &&
    rawTurn.sourceMemoryIds.length === 0
  ) return !taskLinkedFeedback;
  return false;
}

function l1ObservationMetadata(rawTurn: RawTurnRecord, session: SessionRecord, at: string): {
  memoryKey?: string;
  info: Record<string, unknown>;
  internal: Record<string, unknown>;
} {
  const text = rawTurn.userText ?? "";
  const hasToolEvidence = rawTurn.toolCalls.length > 0 && rawTurn.toolResults.length > 0;
  const deviceMemoryObservation = hasToolEvidence &&
    /(?:(?:电脑|计算机|设备|机器).{0,16}(?:内存|ram)|(?:内存|ram).{0,16}(?:电脑|计算机|设备|机器))|\b(?:computer|device|machine)\b.{0,24}\b(?:memory|ram)\b/i.test(text);
  if (deviceMemoryObservation) {
    const deviceId = stringFromMaybeRecord(session.meta, "device_id") ??
      stringFromMaybeRecord(session.meta, "deviceId") ??
      stringFromMaybeRecord(session.meta, "installation_id") ??
      stringFromMaybeRecord(session.meta, "installationId") ??
      "local";
    const scopeKey = `device:${deviceId}:${session.profileId}`;
    const claim = {
      key: "device.total_memory",
      source_role: "tool",
      evidence_status: "verified",
      observed_at: at,
      scope_key: scopeKey,
      policy_eligible: false
    };
    return {
      memoryKey: `trace:environment:${scopeKey}:device.total_memory`,
      info: {
        scope_key: scopeKey,
        observed_at: at,
        evidence_status: "verified",
        policy_eligible: false
      },
      internal: {
        scope_key: scopeKey,
        observed_at: at,
        evidence_status: "verified",
        policy_eligible: false,
        claims: [claim]
      }
    };
  }
  if (hasToolEvidence) {
    return {
      info: { observed_at: at, evidence_status: "verified" },
      internal: {
        observed_at: at,
        evidence_status: "verified",
        claims: [{ source_role: "tool", evidence_status: "verified", observed_at: at }]
      }
    };
  }
  if (isQuestionLike(text) && !isTaskLinkedUserFeedback(text)) {
    return {
      info: { observed_at: at, evidence_status: "provisional", policy_eligible: false },
      internal: {
        observed_at: at,
        evidence_status: "provisional",
        policy_eligible: false,
        claims: [{ source_role: "agent", evidence_status: "provisional", observed_at: at }]
      }
    };
  }
  return { info: {}, internal: {} };
}

function pendingL1DecisionMetadata(observation: ReturnType<typeof l1ObservationMetadata>): ReturnType<typeof l1ObservationMetadata> {
  const originalEvidenceStatus = typeof observation.internal.evidence_status === "string"
    ? observation.internal.evidence_status
    : undefined;
  return {
    memoryKey: observation.memoryKey,
    info: {
      ...observation.info,
      evidence_status: "provisional"
    },
    internal: {
      ...observation.internal,
      evidence_status: "provisional",
      capture_decision: {
        status: "pending",
        ...(originalEvidenceStatus ? { original_evidence_status: originalEvidenceStatus } : {})
      }
    }
  };
}

function episodeClosedByEndTopicTurn(episode: EpisodeRecord, turnId: string): boolean {
  return episode.status === "closed" &&
    episode.meta.closeReason === "end_topic" &&
    episode.meta.endTopicTurnId === turnId;
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
    projectId?: string | null;
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
    if (request.l3WorldModelProtocolVersion === undefined && (
      request.l3WorldModelTransition !== undefined ||
      request.workspaceUri !== undefined ||
      request.workspaceHostId !== undefined
    )) {
      throw new MemoryServiceError("invalid_argument", "L3 World Model v2 fields require protocol version 2");
    }
    if (request.l3WorldModelProtocolVersion === 2) {
      const body = this.openV2Session(request, namespace, at);
      if (idempotencyKey) {
        this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
      }
      return body;
    }
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
      meta: {
        ...sanitizedSessionMeta(request.meta),
        ...(request.timeZone ? { time_zone: request.timeZone } : {})
      },
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

  private openV2Session(
    request: SessionOpenRequest,
    namespace: ReturnType<typeof normalizeNamespace>,
    at: string
  ): ReturnType<SessionTurnService["openSession"]> {
    if (!request.l3WorldModelTransition) {
      throw new MemoryServiceError("invalid_argument", "l3WorldModelTransition is required for protocol v2");
    }
    if (!namespace.sessionKey) {
      throw new MemoryServiceError("invalid_argument", "namespace.sessionKey is required for protocol v2");
    }
    let workspace: ReturnType<typeof resolveV2WorkspaceIdentityForOpenRequest>;
    try {
      workspace = resolveV2WorkspaceIdentityForOpenRequest(request, namespace);
    } catch (error) {
      throw new MemoryServiceError(
        "invalid_argument",
        error instanceof Error ? error.message : "invalid workspace identity"
      );
    }

    return this.deps.repos.transaction(() => {
      const source = request.source ?? namespace.source;
      const profileId = request.profileId ?? namespace.profileId;
      let existing = request.sessionId
        ? this.deps.repos.runtime.getSession(request.sessionId)
        : this.deps.repos.runtime.findOpenSessionByHostKey({
            userId: namespace.userId,
            source,
            profileId,
            hostSessionKey: namespace.sessionKey!
          });

      if (request.sessionId && !existing) {
        throw new MemoryServiceError("conflict", "l3_world_model_v2_session_not_open");
      }
      if (existing) {
        if (existing.status !== "open") {
          throw new MemoryServiceError("conflict", "l3_world_model_v2_session_not_open");
        }
        const protocol = existing.meta.l3_world_model_protocol_version;
        if (protocol === 2) {
          this.assertV2SessionIdentity(existing, request, namespace, workspace);
          this.bindV2SessionWorkspace(existing, optionalMetaString(existing.meta, "workspace_uri"), at);
          const touched = this.deps.repos.runtime.updateSessionScope(existing.id, {}, at) ?? existing;
          return this.v2SessionOpenBody(touched, true);
        }
        if (request.sessionId || request.l3WorldModelTransition !== "allow_legacy_rollover") {
          throw new MemoryServiceError("conflict", "l3_world_model_v2_session_not_open");
        }
        this.closeLegacySessionForV2Rollover(existing, at);
        existing = undefined;
      }

      const explicitProjectId = request.projectId ?? request.namespace?.projectId;
      const explicitWorkspaceId = request.workspaceId ?? request.namespace?.workspaceId;
      if (explicitProjectId || explicitWorkspaceId) {
        throw new MemoryServiceError(
          "invalid_argument",
          "protocol v2 derives projectId and workspaceId from workspace identity"
        );
      }
      const session: SessionRecord = {
        id: newId("session"),
        userId: namespace.userId,
        source,
        profileId,
        profileLabel: namespace.profileLabel,
        projectId: workspace.projectId ?? undefined,
        workspaceId: workspace.workspaceId ?? undefined,
        workspacePath: request.workspacePath ?? namespace.workspacePath,
        hostSessionKey: namespace.sessionKey,
        conversationId: this.deps.stringFromMeta(request.meta, "conversationId"),
        status: "open",
        meta: v2SessionMeta(request, workspace, request.timeZone),
        openedAt: at,
        lastSeenAt: at,
        updatedAt: at
      };
      this.deps.repos.runtime.createSession(session);
      this.bindV2SessionWorkspace(session, workspace.workspaceUri, at);
      const scopedNamespace = {
        ...namespace,
        projectId: session.projectId,
        workspaceId: session.workspaceId
      };
      const changeSeq = this.deps.repos.runtime.appendChange({
        memoryId: session.id,
        namespaceId: this.deps.namespaceIdFromContext(scopedNamespace),
        kind: "session",
        op: "created",
        entityId: session.id,
        userId: session.userId,
        changeType: "session_opened",
        after: session,
        source: "session.open",
        createdAt: at
      });
      return {
        ...this.v2SessionOpenBody(session, false),
        changeSeq,
        syncCursor: this.deps.encodeChangeCursor(changeSeq, scopedNamespace)
      };
    });
  }

  private bindV2SessionWorkspace(
    session: SessionRecord,
    workspaceUri: SessionOpenRequest["workspaceUri"] | null,
    at: string
  ): void {
    if (!session.projectId) return;
    if (!workspaceUri) {
      throw new MemoryServiceError("conflict", "l3_world_model_v2_session_workspace_missing");
    }
    try {
      this.deps.repos.l3WorldModels.bindWorkspaceUri(session.userId, session.projectId, workspaceUri, at);
    } catch (error) {
      if (error instanceof L3WorldModelScopeWorkspaceConflictError) {
        throw new MemoryServiceError("conflict", "l3_world_model_v2_session_scope_conflict");
      }
      throw error;
    }
  }

  private assertV2SessionIdentity(
    session: SessionRecord,
    request: SessionOpenRequest,
    namespace: ReturnType<typeof normalizeNamespace>,
    workspace: ReturnType<typeof resolveV2WorkspaceIdentityForOpenRequest>
  ): void {
    const savedWorkspaceUri = optionalMetaString(session.meta, "workspace_uri");
    const savedWorkspaceHostId = optionalMetaString(session.meta, "workspace_host_id");
    const requestProjectId = request.projectId ?? request.namespace?.projectId;
    const requestWorkspaceId = request.workspaceId ?? request.namespace?.workspaceId;
    const mismatch = session.userId !== namespace.userId ||
      session.source !== (request.source ?? namespace.source) ||
      session.profileId !== (request.profileId ?? namespace.profileId) ||
      session.hostSessionKey !== namespace.sessionKey ||
      (requestProjectId !== undefined && requestProjectId !== session.projectId) ||
      (requestWorkspaceId !== undefined && requestWorkspaceId !== session.workspaceId) ||
      (request.workspaceUri !== undefined && request.workspaceUri !== savedWorkspaceUri) ||
      (request.workspaceHostId !== undefined && request.workspaceHostId !== savedWorkspaceHostId) ||
      (request.workspaceUri !== undefined && workspace.projectId !== (session.projectId ?? null));
    if (mismatch) {
      throw new MemoryServiceError("conflict", "l3_world_model_v2_session_scope_conflict");
    }
  }

  private closeLegacySessionForV2Rollover(session: SessionRecord, at: string): void {
    const closedEpisodes = this.deps.repos.runtime.closeOpenEpisodesForSession(session.id, at);
    const closed = this.deps.repos.runtime.closeSession(session.id, at);
    if (!closed) throw new MemoryServiceError("conflict", "l3_world_model_v2_session_not_open");
    const closedWithMeta = this.deps.repos.runtime.updateSessionMeta(session.id, {
      close_reason: "l3_world_model_protocol_v2"
    }, at) ?? closed;
    for (const episode of closedEpisodes) {
      this.deps.repos.runtime.appendChange({
        memoryId: episode.id,
        namespaceId: this.deps.namespaceIdFromSession(closedWithMeta),
        kind: "episode",
        op: "updated",
        entityId: episode.id,
        userId: episode.userId,
        changeType: "episode_closed",
        after: episode,
        source: "session.open.v2_rollover",
        createdAt: at
      });
      this.deps.finalizeClosedEpisode(episode, at, "session_closed");
    }
    this.deps.repos.runtime.appendChange({
      memoryId: session.id,
      namespaceId: this.deps.namespaceIdFromSession(closedWithMeta),
      kind: "session",
      op: "updated",
      entityId: session.id,
      userId: session.userId,
      changeType: "session_closed",
      before: session,
      after: closedWithMeta,
      source: "session.open.v2_rollover",
      createdAt: at
    });
  }

  private v2SessionOpenBody(
    session: SessionRecord,
    resumed: boolean
  ): ReturnType<SessionTurnService["openSession"]> {
    return {
      sessionId: session.id,
      userId: session.userId,
      source: session.source,
      profileId: session.profileId,
      projectId: session.projectId ?? null,
      workspaceId: session.workspaceId,
      conversationId: session.conversationId,
      status: "open",
      resumed,
      openedAt: session.openedAt,
      serverTime: nowIso()
    };
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
    return this.deps.repos.transaction(() => {
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
      if (session.meta.l3_world_model_protocol_version === 2) {
        this.deps.repos.l3WorldModels.freezeBatches({
          sessionId,
          trigger: "session_close",
          at
        });
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
        status: "closed" as const,
        closedEpisodeIds: closedEpisodes.map((episode) => episode.id),
        changeSeq,
        syncCursor: this.deps.encodeChangeCursor(changeSeq, namespaceForSession(session)),
        closedAt: session.closedAt ?? nowIso(),
        serverTime: nowIso()
      };
    });
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
        time_zone: request.timeZone ?? stringFromMaybeRecord(session.meta, "time_zone"),
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
      const timeZone = request.timeZone ?? stringFromMaybeRecord(session.meta, "time_zone");
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
          source_memory_ids: sourceMemoryIds,
          time_zone: timeZone
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
          time_zone: timeZone,
          raw_turn_id: rawTurn.id,
          raw_span: { compact: true },
          error_signatures: [],
          trace: {
            key: `${episode.id}:${Date.parse(at)}:compact`,
            ts: Date.parse(at),
            time_zone: timeZone,
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
    searchEventId: string;
    hits: RecallHit[];
    injectedContext: InjectedContext;
    sourceMemoryIds: string[];
    droppedDueToBudget: Array<{
      id: string;
      kind: MemoryKind;
      memoryLayer: RecallMemoryLayer;
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
    const intentDecision = classifyIntent(request.query);
    const endTopicDecision = explicitEndTopicDecision(request.query);
    const latestEpisode = this.deps.repos.runtime.latestEpisodeForSession(session.id);
    const routeProposalPromise = this.proposeEpisodeRouteWithLlm(
      latestEpisode,
      request.query,
      endTopicDecision
    );
    const contextHints = turnStartContextHints(request);
    const intentLayers = this.deps.memoryLayersForIntent(intentDecision.kind);
    const requestedLayers = request.layers === undefined
      ? intentLayers
      : intentLayers.filter((layer: MemoryLayer) => request.layers?.includes(layer));
    const searchPromise = this.deps.search({
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: namespaceForSession(session),
      sessionId: session.id,
      episodeId: latestEpisode?.id,
      turnId,
      query: buildSearchQuery({ ...request, contextHints }, this.deps.config.domain),
      layers: endTopicDecision
        ? []
        : requestedLayers,
      limit: this.deps.turnStartRetrievalLimit(),
      contextBudget: typeof request.contextBudget === "number" ? request.contextBudget : undefined,
      includeInjectedContext: true,
      retrievalMode: "turn_start",
      contextHints,
      injectedContextQuery: request.query,
      turnIntentDecision: intentDecision
    });
    const [routeProposal, search] = await Promise.all([routeProposalPromise, searchPromise]);
    this.persistTurnStartRouteProposal(search.searchEventId, routeProposal);
    const contextPacketId = turnContextPacketId(
      session.id,
      routeProposal.baseEpisodeId,
      turnId,
      search.searchEventId
    );
    this.deps.repos.runtime.touchSession(session.id, nowIso());

    return {
      contextPacketId,
      turnId,
      sessionId: session.id,
      searchEventId: search.searchEventId,
      hits: search.hits,
      injectedContext: search.injectedContext,
      sourceMemoryIds: search.sourceMemoryIds,
      droppedDueToBudget: search.droppedDueToBudget,
      status: [
        ...search.status,
        ...(intentDecision.kind === "chitchat" || intentDecision.kind === "meta"
          ? [`intent:${intentDecision.kind}:retrieval_skipped`]
          : []),
        `relation:${routeProposal.relationDecision.relation}:proposed`
      ],
      serverTime: nowIso()
    };
  }

  completeTurn(turnId: string, request: TurnCompleteRequest & Record<string, unknown>): CompleteTurnResponse {
    request = sanitizeTurnCompleteRequest(request);
    if (request.status === "cancelled") {
      throw new MemoryServiceError("invalid_argument", "cancelled turns are not persisted");
    }
    if (!request.query.trim() || !request.answer.trim()) {
      throw new MemoryServiceError(
        "invalid_argument",
        "turn.complete requires a non-empty user query and assistant result"
      );
    }
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
          scheduledEvolution: false,
          jobs: [],
          duplicate: true
        };
      }
    }

    const newlyStoredL1MemoryIds: string[] = [];
    const response = this.deps.repos.transaction(() => {
      const session = this.deps.requireOpenSession(request.sessionId);
      this.deps.assertSessionInScope(session, request.namespace);
      const existingRawTurn = this.deps.repos.runtime.getRawTurnBySessionTurn(session.id, turnId);
      if (existingRawTurn) {
        this.deps.assertRawTurnInScope(existingRawTurn, request.namespace);
      }
      if (existingRawTurn && isRecord(existingRawTurn.messagePayload?.turn_complete)) {
        const at = nowIso();
        const episode = this.deps.requireEpisode(existingRawTurn.episodeId);
        const existingCaptureClaim = existingRawTurn.userText && existingRawTurn.assistantText
          ? this.deps.repos.captureClaims.get(
              session.userId,
              normalizeMemoryCaptureSource(session.source),
              memoryCaptureQaHash(existingRawTurn.userText, existingRawTurn.assistantText)
            )
          : undefined;
        const l1MemoryIds = episode.l1MemoryIds.filter((memoryId: string) => {
          const memory = this.deps.repos.memories.get(memoryId);
          return memory && (
            this.deps.rawTurnIdFromMemory(memory) === existingRawTurn.id ||
            memory.id === existingCaptureClaim?.primaryMemoryId
          );
        });
        const userMemoryIds = this.deps.repos.userMemories
          .listActive(session.userId)
          .filter((memory) => memory.sourceTurnRefs.includes(existingRawTurn.id))
          .map((memory) => memory.id);
        const responseChangeSeq = this.deps.repos.runtime.latestChangeSeq(
          session.userId,
          this.deps.namespaceIdFromSession(session)
        );
        const body: CompleteTurnResponse = {
          turnId,
          sessionId: session.id,
          episodeId: episode.id,
          rawTurnId: existingRawTurn.id,
          userMemoryId: userMemoryIds[0] ?? "",
          userMemoryIds,
          l1MemoryId: l1MemoryIds[0] ?? "",
          l1MemoryIds,
          closedEpisodeIds: episodeClosedByEndTopicTurn(episode, turnId) ? [episode.id] : [],
          scheduledEvolution: false,
          jobs: [],
          changeSeq: responseChangeSeq,
          syncCursor: this.deps.encodeChangeCursor(responseChangeSeq, namespaceForSession(session)),
          etag: stableHash({
            changeSeq: responseChangeSeq,
            l1MemoryIds,
            rawTurnId: existingRawTurn.id
          }),
          serverTime: at,
          duplicate: true
        };
        if (idempotencyKey) {
          this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
        }
        return body;
      }
      const turnStartRecall = this.deps.repos.runtime.getTurnStartRecallEvent(session.id, turnId);
      const requestSourceMemoryIds = normalizeCompleteTurnSourceMemoryIds(request);
      const sourceMemoryIds = requestSourceMemoryIds.length > 0
        ? requestSourceMemoryIds
        : turnStartRecall?.injectedMemoryIds ?? [];
      const completionRequest = sourceMemoryIds === requestSourceMemoryIds
        ? request
        : { ...request, sourceMemoryIds };
      const intentDecision = turnIntentDecisionFromRecallRequest(turnStartRecall?.request) ??
        classifyIntent(request.query);
      const endTopicDecision =
        explicitEndTopicDecision(request.query) ??
        (existingRawTurn ? endTopicDecisionFromRawTurn(existingRawTurn) : undefined);
      const at = nowIso();
      const recalledProposal = turnRouteProposalFromRecallRequest(turnStartRecall?.request);
      let route: CommittedTurnRoute;
      if (request.episodeId) {
        const episode = this.ensureEpisode(session, request.episodeId);
        const decision = endTopicDecision ?? recalledProposal?.relationDecision ?? classifyTurnRelation({
          prevUserText: "",
          prevAssistantText: "",
          newUserText: request.query,
          prevTags: []
        });
        const routedEndTopicDecision = endTopicDecision ?? (
          decision.relation === "end_topic" ? decision as EndTopicDecision : undefined
        );
        route = {
          episode,
          ...(routedEndTopicDecision ? { endTopicDecision: routedEndTopicDecision } : {}),
          closedEpisodeIds: [],
          jobs: [],
          proposal: {
            ...(recalledProposal ?? this.buildTurnRouteProposal(episode, decision, undefined, at)),
            action: routedEndTopicDecision ? "end_topic" : "append",
            baseEpisodeId: episode.id,
            relationDecision: decision
          },
          proposalStale: false
        };
      } else {
        const latest = this.deps.repos.runtime.latestEpisodeForSession(session.id);
        const proposalUsesObservedUnboundEpisode = Boolean(
          (recalledProposal?.action === "create_first" || recalledProposal?.action === "end_topic") &&
          recalledProposal.baseEpisodeId === undefined &&
          existingRawTurn &&
          latest?.id === existingRawTurn.episodeId &&
          !this.episodeRelationContext(latest).prevUserText
        );
        const proposalIsCurrent = Boolean(recalledProposal) &&
          (recalledProposal?.baseEpisodeId === latest?.id || proposalUsesObservedUnboundEpisode) &&
          !(recalledProposal?.action === "append" &&
            latest?.status === "closed" &&
            latest.meta.closeReason === "end_topic");
        if (!recalledProposal && existingRawTurn) {
          const episode = this.deps.requireEpisode(existingRawTurn.episodeId);
          const decision = endTopicDecision ?? classifyTurnRelation({
            prevUserText: "",
            prevAssistantText: "",
            newUserText: request.query,
            prevTags: []
          });
          const routedEndTopicDecision = decision.relation === "end_topic"
            ? decision as EndTopicDecision
            : undefined;
          route = {
            episode,
            ...(routedEndTopicDecision ? { endTopicDecision: routedEndTopicDecision } : {}),
            closedEpisodeIds: [],
            jobs: [],
            proposal: {
              ...this.buildTurnRouteProposal(episode, decision, undefined, at),
              action: routedEndTopicDecision ? "end_topic" : "append",
              baseEpisodeId: episode.id
            },
            proposalStale: true
          };
        } else {
          const proposal = proposalIsCurrent
            ? recalledProposal!
            : this.proposeEpisodeRoute(session, request.query, endTopicDecision);
          route = this.commitTurnRouteProposal(
            session,
            proposal,
            request.query,
            "turn.complete",
            at,
            !proposalIsCurrent
          );
        }
      }
      const episode = route.episode;
      const committedEndTopicDecision = route.endTopicDecision ?? endTopicDecision;
      const closedEpisodeIds = [...route.closedEpisodeIds];
      this.deps.assertEpisodeInScope(episode, request.namespace);
      if (existingRawTurn && existingRawTurn.episodeId !== episode.id) {
        this.deps.repos.runtime.rebindRawTurnEpisode(
          existingRawTurn.id,
          existingRawTurn.episodeId,
          episode.id,
          at
        );
      }
      this.deps.repos.runtime.touchSession(session.id, at);
      const rawTurnId = rawTurnIdForSessionTurn(session.id, turnId);
      const requestToolCalls = normalizeCompleteTurnToolCalls(completionRequest);
      const requestToolResults = normalizeCompleteTurnToolResults(completionRequest);
      const requestArtifacts = normalizeCompleteTurnArtifacts(completionRequest);
      const turnStartPayload = {
        intent_decision: intentDecision,
        routeProposal: recalledProposal ?? route.proposal,
        ...(route.proposalStale ? { routeProposalStale: true } : {}),
        ...(turnStartRecall
          ? {
              contextPacketId: turnContextPacketId(
                session.id,
                turnStartRecall.episodeId,
                turnId,
                turnStartRecall.id
              ),
              searchEventId: turnStartRecall.id,
              sourceMemoryIds
            }
          : {}),
        ...(committedEndTopicDecision
          ? {
              episode_close: {
                closeAfterComplete: true,
                decision: committedEndTopicDecision
              }
            }
          : {})
      };

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
          sourceMemoryIds,
          usage: isRecord(request.usage) ? request.usage : {},
          messagePayload: {
            turn_start: turnStartPayload,
            turn_complete: {
              completed_at: at,
              source_memory_ids: sourceMemoryIds,
              time_zone: request.timeZone ?? stringFromMaybeRecord(session.meta, "time_zone")
            }
          },
          status: request.status ?? "succeeded",
          createdAt: at
        });
      const rawTurnCreated = !existingRawTurn;
      const rawTurnFirstCompleted = rawTurnCreated
        || !isRecord(existingRawTurn.messagePayload?.turn_complete);
      const completedObservedRawTurn = existingRawTurn
        ? {
            ...completeObservedRawTurn(existingRawTurn, completionRequest, at),
            episodeId: episode.id
          }
        : undefined;
      const rawTurn = completedObservedRawTurn
        ? this.deps.repos.runtime.updateRawTurn({
            ...completedObservedRawTurn,
            messagePayload: {
              ...completedObservedRawTurn.messagePayload,
              turn_start: turnStartPayload
            }
          })
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
      if (episode.rawTurnIds.every((rawTurnId) => rawTurnId === rawTurn.id)) {
        this.deps.repos.runtime.updateEpisodeMeta(episode.id, {
          intentDecision
        });
      }
      this.deps.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);

      const userMemoryCapture = this.captureUserMemory(rawTurn, request, at);
      const requestTags = this.deps.normalizeRequestTags(request.tags);
      const capturedSteps = this.captureEpisodeIncrementalSteps(episode, rawTurn, at)
        .map((step) => {
          const stepRawTurnId = step.rawTurnId ?? rawTurn.id;
          return stepRawTurnId === rawTurn.id && requestTags.length > 0
            ? { ...step, tags: uniq([...step.tags, ...requestTags]) }
            : step;
        });

      const l1MemoryIds: string[] = [];
      const captureClaimByRawTurnId = new Map<string, boolean>();
      let changeSeq = 0;
      const jobs: EvolutionJobRecord[] = [...route.jobs, ...userMemoryCapture.jobs];

      for (const step of capturedSteps) {
        const stepRawTurnId = step.rawTurnId ?? rawTurn.id;
        const sourceRawTurn = stepRawTurnId === rawTurn.id
          ? rawTurn
          : this.deps.repos.runtime.getRawTurn(stepRawTurnId) ?? rawTurn;
        const modelDecidesCapture = this.deps.llm.isConfigured();
        const observation = modelDecidesCapture
          ? pendingL1DecisionMetadata(l1ObservationMetadata(sourceRawTurn, session, at))
          : l1ObservationMetadata(sourceRawTurn, session, at);
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
          lifecycleStatus: modelDecidesCapture ? "candidate" : "active",
          memoryType: "LongTermMemory",
          key: observation.memoryKey ?? `trace:${session.id}:${step.turnId}:${step.stepIndex}`,
          value: this.deps.renderTraceMemoryValue({
            ...step,
            summary: "",
            rawTurnId: stepRawTurnId
          }),
          tags: step.tags,
          info: {
            turn_id: step.turnId,
            raw_turn_id: stepRawTurnId,
            episode_id: episode.id,
            status: rawTurn.status,
            summary: "",
            time_zone: step.timeZone,
            ...observation.info
          },
          internal: {
            source: "turn.complete",
            plugin_algorithm: "capture.v7",
            source_raw_turn_id: stepRawTurnId,
            source_memory_ids: rawTurn.sourceMemoryIds,
            summary: "",
            reflection: step.reflection.text,
            alpha: step.reflection.alpha,
            value: step.value,
            priority: step.priority,
            time_zone: step.timeZone,
            raw_turn_id: stepRawTurnId,
            raw_span: {
              user_text: Boolean(step.userText),
              agent_text: Boolean(step.agentText),
              tool_call_count: step.toolCalls.length
            },
            error_signatures: step.errorSignatures,
            ...observation.internal,
            trace: {
              key: step.key,
              ts: step.ts,
              time_zone: step.timeZone,
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
              summary: "",
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

        let captureClaimed = captureClaimByRawTurnId.get(stepRawTurnId);
        if (captureClaimed === undefined) {
          const qaQuery = sourceRawTurn.userText ?? "";
          const qaAnswer = sourceRawTurn.assistantText ?? "";
          if (qaQuery.trim() && qaAnswer.trim()) {
            const capture = this.deps.repos.captureClaims.claim({
              userId: session.userId,
              source: normalizeMemoryCaptureSource(session.source),
              qaHash: memoryCaptureQaHash(qaQuery, qaAnswer),
              primaryMemoryId: l1Memory.id,
              capturedBy: "turn_complete",
              createdAt: at
            });
            captureClaimed = capture.claimed || capture.claim.capturedBy === "turn_complete";
            captureClaimByRawTurnId.set(stepRawTurnId, captureClaimed);
            if (!captureClaimed) {
              const existing = this.deps.repos.memories.getIncludingDeleted(capture.claim.primaryMemoryId);
              if (!existing) {
                throw new MemoryServiceError("conflict", "memory capture claim points to a missing memory");
              }
              if (existing.status !== "deleted" && !existing.deletedAt) {
                l1MemoryIds.push(existing.id);
                if (session.meta.l3_world_model_protocol_version === 2) {
                  this.deps.repos.l3WorldModels.registerInputTrace({
                    sessionId: session.id,
                    l1MemoryId: existing.id,
                    rawTurnId: stepRawTurnId,
                    episodeId: episode.id,
                    createdAt: at
                  });
                }
                this.deps.repos.runtime.appendEpisodeTurn(episode.id, stepRawTurnId, existing.id, at);
              }
            }
          } else {
            captureClaimed = true;
            captureClaimByRawTurnId.set(stepRawTurnId, true);
          }
        }
        if (!captureClaimed) continue;

        const upsert = this.deps.repos.memories.upsertByKey(l1Memory);
        l1MemoryIds.push(upsert.memory.id);
        newlyStoredL1MemoryIds.push(upsert.memory.id);
        if (session.meta.l3_world_model_protocol_version === 2) {
          this.deps.repos.l3WorldModels.registerInputTrace({
            sessionId: session.id,
            l1MemoryId: upsert.memory.id,
            rawTurnId: stepRawTurnId,
            episodeId: episode.id,
            createdAt: at
          });
        }
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
        const existingProcessing = this.deps.repos.processing.get(upsert.memory.id);
        const contentChanged = Boolean(
          !upsert.created && upsert.previous?.contentHash !== upsert.memory.contentHash
        );
        if (!existingProcessing || contentChanged) {
          if (contentChanged) {
            this.deps.repos.memories.deleteVector(upsert.memory.id, "vec_summary");
            this.deps.repos.memories.deleteVector(upsert.memory.id, "vec_action");
          }
          this.deps.repos.processing.save({
            memoryId: upsert.memory.id,
            state: "summary_pending",
            stage: "summary",
            activeJobId: null,
            attemptCount: 0,
            manualRetryCount: existingProcessing?.manualRetryCount ?? 0,
            retryAction: "retry",
            errorCode: null,
            errorMessage: null,
            failedAt: null,
            updatedAt: at
          });
          jobs.push(this.deps.enqueueJob({
            jobType: "trace_summary",
            userId: session.userId,
            sessionId: session.id,
            episodeId: episode.id,
            targetMemoryId: upsert.memory.id,
            payload: {
              source: "turn.complete.capture",
              contentHash: upsert.memory.contentHash,
              decideCapture: modelDecidesCapture,
              captureUserMemory: modelDecidesCapture && !request.userMemoryCorrection && step.stepIndex === 0,
              capturedUserMemoryIds: userMemoryCapture.memoryIds,
              ...(request.userMemoryCorrection ? {
                capturedUserMemoryAction: "corrected",
                capturedUserMemoryTargetId: request.userMemoryCorrection.targetMemoryId
              } : {})
            },
            maxAttempts: 3,
            createdAt: at
          }));
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
      const completedEndTopicDecision = committedEndTopicDecision ?? endTopicDecisionFromRawTurn(rawTurn);
      if (rawTurnFirstCompleted && completedEndTopicDecision) {
        const beforeClose = this.deps.repos.runtime.getEpisode(episode.id) ?? episode;
        const closed = this.deps.repos.runtime.closeEpisode(episode.id, {
          closeReason: "end_topic",
          topicState: "ended",
          relationDecision: completedEndTopicDecision,
          endTopicTurnId: turnId,
          closedBy: "turn.complete"
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
            before: beforeClose,
            after: closed,
            source: "turn.complete.end_topic",
            createdAt: at
          });
          jobs.push(...this.deps.finalizeClosedEpisode(closed, at, "end_topic"));
          closedEpisodeIds.push(closed.id);
        }
      } else if (episodeClosedByEndTopicTurn(episode, turnId)) {
        closedEpisodeIds.push(episode.id);
      }
      if (rawTurnFirstCompleted && !completedEndTopicDecision) {
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
      const uniqueClosedEpisodeIds = uniq(closedEpisodeIds);
      const responseChangeSeq = this.deps.repos.runtime.latestChangeSeq(session.userId, this.deps.namespaceIdFromSession(session));
      const body: CompleteTurnResponse = {
        turnId,
        sessionId: session.id,
        episodeId: episode.id,
        rawTurnId: rawTurn.id,
        userMemoryId: userMemoryCapture.memoryIds[0] ?? "",
        userMemoryIds: userMemoryCapture.memoryIds,
        l1MemoryId: l1MemoryIds[0] ?? "",
        l1MemoryIds,
        closedEpisodeIds: uniqueClosedEpisodeIds,
        scheduledEvolution: true,
        jobs: jobs.map(jobToRef),
        changeSeq: responseChangeSeq,
        syncCursor: this.deps.encodeChangeCursor(responseChangeSeq, namespaceForSession(session)),
        etag: stableHash({
          changeSeq: responseChangeSeq,
          userMemoryIds: userMemoryCapture.memoryIds,
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

    for (const memoryId of response.duplicate ? [] : newlyStoredL1MemoryIds) {
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
      attachedPolicyMemoryIds: [],
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
    this.deps.enqueueJob({
      jobType: "negative_experience",
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      payload: {
        source: "tool_failure_burst",
        sourceEventId: repair.id,
        repairId: repair.id,
        triggerCondition: `${burst.toolId}:${burst.context}`,
        confidence: repair.meta.confidence
      },
      createdAt: at
    });
    return {
      repairId: repair.id,
      contextHash: burst.contextHash,
      skipped: false,
      attachedPolicyIds: []
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
      lowValueMemories
    };
  }

  private async maybeSynthesizeFailureBurstDecisionRepair(
    burst: ToolFailureBurst,
    reason: string,
    evidence: {
      highValueMemories: MemoryRow[];
      lowValueMemories: MemoryRow[];
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
        .map((id) => this.deps.repos.memories.getIncludingDeleted(id))
        .filter((memory): memory is MemoryRow => Boolean(memory))
        .map((memory) => this.deps.rawTurnIdFromMemory(memory))
        .filter((id): id is string => Boolean(id))
    );
    const rawTurns = uniq([...episode.rawTurnIds, currentRawTurn.id])
      .map((id) => id === currentRawTurn.id ? currentRawTurn : this.deps.repos.runtime.getRawTurn(id))
      .filter((rawTurn): rawTurn is RawTurnRecord =>
        Boolean(rawTurn && (rawTurn.id === currentRawTurn.id || !seenRawTurnIds.has(rawTurn.id)))
      )
      .filter((rawTurn) => isRecord(rawTurn.messagePayload?.turn_complete))
      .filter((rawTurn) => !endTopicDecisionFromRawTurn(rawTurn))
      .filter((rawTurn) => this.deps.llm.isConfigured() || !rawTurnIsExcludedFromL1(rawTurn))
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
        timeZone: stringFromMaybeRecord(rawTurn.messagePayload, "time_zone") ??
          stringFromMaybeRecord(rawTurn.messagePayload?.turn_complete, "time_zone"),
        maxTextChars: this.deps.config.algorithm.capture.maxTextChars,
        maxToolOutputChars: this.deps.config.algorithm.capture.maxToolOutputChars
      }).map((step) => ({ ...step, rawTurnId: rawTurn.id }))
    );
  }

  private captureUserMemory(
    rawTurn: RawTurnRecord,
    request: TurnCompleteRequest,
    at: string
  ): { memoryIds: string[]; jobs: EvolutionJobRecord[] } {
    const correction = request.userMemoryCorrection;
    if (correction) {
      const target = this.deps.repos.userMemories.get(correction.targetMemoryId);
      if (!target || target.userId !== rawTurn.userId || target.status !== "active") {
        throw new MemoryServiceError("not_found", `active user memory not found: ${correction.targetMemoryId}`);
      }
      const content = correction.revisedContent.trim();
      const memoryTypes = classifyUserMemory(content);
      if (!content || memoryTypes.length === 0) {
        throw new MemoryServiceError("invalid_argument", "user memory correction requires complete revised user content");
      }
      const replacement = buildUserMemory({
        id: `user_memory_${stableHash(`${rawTurn.id}:${target.id}:${content}`).slice(0, 20)}`,
        sourceTurnId: rawTurn.id,
        userId: rawTurn.userId,
        memoryTypes,
        content,
        createdAt: at,
        replacesMemoryId: target.id
      });
      if (replacement.normalizedUserTextHash === target.normalizedUserTextHash) {
        throw new MemoryServiceError("invalid_argument", "user memory correction must change the target content");
      }
      const upsert = this.deps.repos.userMemories.upsertExact(replacement);
      const inserted = upsert.memory;
      const archived = this.deps.repos.userMemories.archiveForCorrection(target.id, inserted.id, at);
      this.appendUserMemoryChange(
        inserted,
        upsert.previous,
        upsert.created ? "created" : "updated",
        at
      );
      if (archived) this.appendUserMemoryChange(archived, target, "archived", at);
      return {
        memoryIds: [inserted.id],
        jobs: upsert.created ? this.userMemoryEmbeddingJobs(inserted, rawTurn, at) : []
      };
    }

    if (this.deps.llm.isConfigured()) return { memoryIds: [], jobs: [] };

    const content = rawTurn.userText?.trim() ?? "";
    const memoryTypes = classifyUserMemory(content);
    if (memoryTypes.length === 0) return { memoryIds: [], jobs: [] };
    const candidate = buildUserMemory({
      id: `user_memory_${stableHash(`${rawTurn.id}:${content}`).slice(0, 20)}`,
      sourceTurnId: rawTurn.id,
      userId: rawTurn.userId,
      memoryTypes,
      content,
      createdAt: at
    });
    const upsert = this.deps.repos.userMemories.upsertExact(candidate);
    this.appendUserMemoryChange(
      upsert.memory,
      upsert.previous,
      upsert.created ? "created" : "updated",
      at
    );
    return {
      memoryIds: [upsert.memory.id],
      jobs: upsert.created ? this.userMemoryEmbeddingJobs(upsert.memory, rawTurn, at) : []
    };
  }

  private userMemoryEmbeddingJobs(
    memory: { id: string; userId: string; content: string },
    rawTurn: RawTurnRecord,
    at: string
  ): EvolutionJobRecord[] {
    if (!this.deps.config.algorithm.capture.embedAfterCapture) return [];
    return [this.deps.enqueueJob({
      jobType: "user_memory_embedding",
      userId: memory.userId,
      sessionId: rawTurn.sessionId,
      episodeId: rawTurn.episodeId,
      targetMemoryId: memory.id,
      payload: { contentHash: stableHash(memory.content) },
      maxAttempts: 6,
      createdAt: at
    })];
  }

  private appendUserMemoryChange(
    memory: { id: string; userId: string },
    before: unknown,
    op: "created" | "updated" | "archived",
    at: string
  ): void {
    this.deps.repos.runtime.appendChange({
      memoryId: memory.id,
      kind: "user_memory",
      op,
      entityId: memory.id,
      userId: memory.userId,
      changeType: `user_memory_${op}`,
      before,
      after: memory,
      source: "turn.complete.user_memory",
      createdAt: at
    });
  }

  private buildTurnRouteProposal(
    latest: EpisodeRecord | undefined,
    decision: TurnRelationDecision,
    lastTurnAtMs?: number,
    proposedAt = nowIso()
  ): TurnRouteProposal {
    const mergeMode = this.deps.config.algorithm.session.followUpMode === "merge_follow_ups";
    const proposedAtMs = Date.parse(proposedAt);
    const gapMs = lastTurnAtMs
      ? Math.max(0, (Number.isFinite(proposedAtMs) ? proposedAtMs : Date.now()) - lastTurnAtMs)
      : 0;
    const withinMergeWindow =
      this.deps.config.algorithm.session.mergeMaxGapMs === 0 ||
      gapMs <= this.deps.config.algorithm.session.mergeMaxGapMs;
    const shouldAppendOpen =
      mergeMode &&
      withinMergeWindow &&
      (decision.relation === "revision" ||
        decision.relation === "follow_up" ||
        decision.relation === "unknown");
    const shouldReopenClosed = latest !== undefined && latest.meta.closeReason !== "end_topic" && (
      decision.relation === "revision" ||
      (mergeMode &&
        withinMergeWindow &&
        (decision.relation === "follow_up" || decision.relation === "unknown"))
    );
    const action: TurnRouteAction = decision.relation === "end_topic"
      ? "end_topic"
      : !latest
        ? "create_first"
        : latest.status === "open"
          ? (shouldAppendOpen ? "append" : "split")
          : (shouldReopenClosed ? "append" : "split");
    return {
      action,
      ...(latest ? { baseEpisodeId: latest.id } : {}),
      relationDecision: decision,
      proposedAt,
      mergeMode,
      withinMergeWindow,
      gapMs
    };
  }

  private proposeEpisodeRoute(
    session: SessionRecord,
    userText: string,
    forcedDecision?: TurnRelationDecision
  ): TurnRouteProposal {
    const latest = this.deps.repos.runtime.latestEpisodeForSession(session.id);
    const relationContext = latest ? this.episodeRelationContext(latest) : undefined;
    const decision = forcedDecision ?? classifyTurnRelation({
      prevUserText: relationContext?.prevUserText ?? "",
      prevAssistantText: relationContext?.prevAssistantText ?? "",
      newUserText: userText,
      gapMs: relationContext?.lastTurnAtMs
        ? Math.max(0, Date.now() - relationContext.lastTurnAtMs)
        : undefined,
      prevTags: relationContext?.tags ?? []
    });
    return this.buildTurnRouteProposal(latest, decision, relationContext?.lastTurnAtMs);
  }

  private async proposeEpisodeRouteWithLlm(
    latest: EpisodeRecord | undefined,
    userText: string,
    forcedDecision?: TurnRelationDecision
  ): Promise<TurnRouteProposal> {
    const relationContext = latest ? this.episodeRelationContext(latest) : undefined;
    if (forcedDecision || !latest || !relationContext?.prevUserText) {
      const decision = forcedDecision ?? classifyTurnRelation({
        prevUserText: relationContext?.prevUserText ?? "",
        prevAssistantText: relationContext?.prevAssistantText ?? "",
        newUserText: userText,
        gapMs: relationContext?.lastTurnAtMs
          ? Math.max(0, Date.now() - relationContext.lastTurnAtMs)
          : undefined,
        prevTags: relationContext?.tags ?? []
      });
      return this.buildTurnRouteProposal(latest, decision, relationContext?.lastTurnAtMs);
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
    return this.buildTurnRouteProposal(latest, decision, relationContext.lastTurnAtMs);
  }

  private persistTurnStartRouteProposal(searchEventId: string, routeProposal: TurnRouteProposal): void {
    const recall = this.deps.repos.runtime.getRecallEvent(searchEventId);
    if (!recall) return;
    const request = isRecord(recall.request) ? recall.request : {};
    this.deps.repos.runtime.updateRecallEventRequest(searchEventId, {
      ...request,
      routeProposal
    });
  }

  private commitTurnRouteProposal(
    session: SessionRecord,
    proposal: TurnRouteProposal,
    userText: string,
    source: string,
    at: string,
    proposalStale: boolean
  ): CommittedTurnRoute {
    const decision = proposal.relationDecision;
    const closedEpisodeIds: string[] = [];
    const jobs: EvolutionJobRecord[] = [];
    if (proposal.action === "create_first") {
      return {
        episode: this.ensureEpisode(session),
        closedEpisodeIds,
        jobs,
        proposal,
        proposalStale
      };
    }
    if (proposal.action === "end_topic") {
      const base = proposal.baseEpisodeId
        ? this.deps.repos.runtime.getEpisode(proposal.baseEpisodeId)
        : undefined;
      const episode = base?.status === "open" ? base : this.ensureEpisode(session);
      return {
        episode,
        endTopicDecision: decision as EndTopicDecision,
        closedEpisodeIds,
        jobs,
        proposal,
        proposalStale
      };
    }

    const baseEpisodeId = proposal.baseEpisodeId;
    if (!baseEpisodeId) {
      throw new MemoryServiceError("conflict", "episode route proposal is missing its base episode");
    }
    const latest = this.deps.requireEpisode(baseEpisodeId);
    if (proposal.action === "append") {
      if (latest.status === "open") {
        if (decision.relation === "revision") {
          this.recordRevisionFeedback(session, latest, userText, source);
        }
        const episode = this.deps.repos.runtime.updateEpisodeMeta(latest.id, {
          relation: decision.relation,
          relationDecision: decision,
          relationRouting: {
            action: "append_to_open_episode",
            mergeMode: proposal.mergeMode,
            withinMergeWindow: proposal.withinMergeWindow,
            gapMs: proposal.gapMs
          }
        }, at) ?? latest;
        return { episode, closedEpisodeIds, jobs, proposal, proposalStale };
      }
      const reopened = this.deps.repos.runtime.reopenEpisode(latest.id, {
        relation: decision.relation,
        relationDecision: decision,
        reopenedAt: at,
        reopenReason: decision.relation === "revision" ? "revision" : "follow_up",
        relationRouting: {
          action: "reopen_previous_episode",
          mergeMode: proposal.mergeMode,
          withinMergeWindow: proposal.withinMergeWindow,
          gapMs: proposal.gapMs
        },
        rewardDirty: {
          reason: "episode_reopened",
          reopenedFor: decision.relation,
          at
        }
      }, at);
      if (!reopened) {
        throw new MemoryServiceError("conflict", "failed to reopen the proposed episode");
      }
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
      return { episode: reopened, closedEpisodeIds, jobs, proposal, proposalStale };
    }

    this.recordImplicitTurnFeedback(session, latest, userText);
    if (latest.status === "open") {
      const closed = this.deps.repos.runtime.closeEpisode(latest.id, {
        closeReason: "topic_boundary",
        relation: decision.relation,
        relationDecision: decision,
        relationRouting: {
          action: decision.relation === "new_task"
            ? "close_open_and_start_new_task"
            : "close_open_and_start_new_episode",
          mergeMode: proposal.mergeMode,
          withinMergeWindow: proposal.withinMergeWindow,
          gapMs: proposal.gapMs
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
        jobs.push(...this.deps.finalizeClosedEpisode(closed, at, "topic_boundary"));
        closedEpisodeIds.push(closed.id);
        if (decision.relation === "new_task" && session.meta.l3_world_model_protocol_version === 2) {
          this.deps.repos.l3WorldModels.freezeBatches({
            sessionId: session.id,
            trigger: "new_task",
            at
          });
        }
      }
    } else {
      jobs.push(...this.deps.finalizeClosedEpisode(latest, at, "topic_boundary"));
      if (decision.relation === "new_task" && session.meta.l3_world_model_protocol_version === 2) {
        this.deps.repos.l3WorldModels.freezeBatches({
          sessionId: session.id,
          trigger: "new_task",
          at
        });
      }
    }
    const next = this.ensureEpisode(session);
    const episode = this.deps.repos.runtime.updateEpisodeMeta(next.id, {
      relation: decision.relation,
      relationDecision: decision,
      previousEpisodeId: latest.id,
      relationRouting: {
        action: decision.relation === "new_task" ? "start_new_task_episode" : "start_new_episode",
        mergeMode: proposal.mergeMode,
        withinMergeWindow: proposal.withinMergeWindow,
        gapMs: proposal.gapMs
      }
    }, at) ?? next;
    return { episode, closedEpisodeIds, jobs, proposal, proposalStale };
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
      .filter((rawTurn) => isRecord(rawTurn.messagePayload?.turn_complete))
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

function sanitizedSessionMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...(meta ?? {}) };
  delete sanitized.l3_world_model_protocol_version;
  delete sanitized.workspace_uri;
  delete sanitized.workspace_host_id;
  return sanitized;
}

function v2SessionMeta(
  request: SessionOpenRequest,
  workspace: ReturnType<typeof resolveV2WorkspaceIdentityForOpenRequest>,
  timeZone?: string
): Record<string, unknown> {
  return {
    ...sanitizedSessionMeta(request.meta),
    l3_world_model_protocol_version: 2,
    ...(workspace.workspaceUri ? { workspace_uri: workspace.workspaceUri } : {}),
    ...(workspace.workspaceHostId ? { workspace_host_id: workspace.workspaceHostId } : {}),
    ...(timeZone ? { time_zone: timeZone } : {})
  };
}

function optionalMetaString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value ? value : undefined;
}
