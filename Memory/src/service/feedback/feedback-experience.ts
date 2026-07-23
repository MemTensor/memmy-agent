import type {
  FeedbackTextClassification,
  FeedbackTextShape,
  TurnFeedbackClassification
} from "../../algorithm/plugin-algorithms.js";
import {
  DECISION_REPAIR_PROMPT,
  classifyFeedbackText,
  cosine,
  policyMetaFromMemory,
  policyStatusAfterGain,
  skillMetaFromMemory,
  traceMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import {
  type MemmyConfig
} from "../../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../../logging/logger.js";
import type { Embedder,LlmClient } from "../../model/types.js";
import {
  Repositories,
  jobToRef,
  kindFromMemory,
  type EpisodeRecord,
  type EvolutionJobRecord,
  type FeedbackRecord,
  type RawTurnRecord,
  type RecallEventRecord,
  type SessionRecord,
  type SkillTrialRecord
} from "../../storage/repositories.js";
import type {
  FeedbackRequest,
  JobRef,
  MemoryRow,
  RequestEnvelope,
  RuntimeNamespace,
  ToolCallPayload
} from "../../types.js";
import { MemoryServiceError } from "../../utils/error.js";
import { newId,stableHash,stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import { nowIso } from "../../utils/time.js";
import { updatePolicyStats } from "../evolution/policy-induction.js";
import {
  namespaceForMemory,
  namespaceForSession,
  normalizeNamespace,
  profileIdFromMemory,
  projectIdFromMemory
} from "../namespace/namespace-scope.js";
import {
  skillBetaPosterior
} from "../read-model/skill.js";
import {
  isRepairFailureLikeTrace as sessionIsRepairFailureLikeTrace,
  repairTraceContains as sessionRepairTraceContains
} from "../session/session-turn-service.js";
import {
  type EnqueueJobInput
} from "../worker/job-handlers.js";


export interface ResolvedContext {
  userId: string;
  conversationId?: string;
  namespace: RuntimeNamespace;
}

export interface FeedbackResponse {
  id: string;
  ts: string;
  channel: FeedbackRequest["channel"];
  polarity: FeedbackRequest["polarity"];
  magnitude: number;
  scheduledEvolution: boolean;
  changeSeq: number;
  syncCursor: string;
  feedbackId: string;
  recallEventId?: string;
  recallOutcome?: NonNullable<RecallEventRecord["outcome"]>;
  repair?: { repairId?: string; contextHash?: string; skipped?: boolean; reason?: string; attachedPolicyIds?: string[] };
  jobs: JobRef[];
  serverTime: string;
  duplicate?: boolean;
}

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;

export interface FeedbackExperienceServiceDeps {
  repos: Repositories;
  readonly config: MemmyConfig;
  readonly skillLlm: LlmClient;
  readonly embedder: Embedder;
  memoryAddEnabled(): boolean;
  resolveContext(request: RequestEnvelope): ResolvedContext;
  assertSessionInScope(session: SessionRecord, namespace?: RuntimeNamespace): void;
  assertEpisodeInScope(episode: EpisodeRecord, namespace?: RuntimeNamespace): void;
  assertRawTurnInScope(rawTurn: RawTurnRecord, namespace?: RuntimeNamespace): void;
  assertMemoryInScope(memory: MemoryRow, namespace?: RuntimeNamespace): void;
  requireEpisode(id: string): EpisodeRecord;
  requireRawTurn(id: string): RawTurnRecord;
  requireExistingMemory(id: string): MemoryRow;
  traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  encodeChangeCursor(seq: number, namespace?: RuntimeNamespace): string;
  readOnlyCursor(namespace?: RuntimeNamespace): { changeSeq: number; syncCursor: string };
  findExistingSkillForPolicy(policy: PolicyMeta, userId: string): NonNullable<ReturnType<typeof skillMetaFromMemory>> | null;
  upsertEvolutionMemory(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  pendingTrialsForFeedback(feedback: FeedbackRecord): SkillTrialRecord[];
}

export interface DecisionRepairTraceSource {
  memory: MemoryRow;
  rawTurn?: RawTurnRecord;
}

export interface DecisionRepairLlmDraft {
  preference: string;
  antiPattern: string;
  severity: "info" | "warn";
  confidence: number;
}

export interface DecisionRepairSynthesisRequest {
  trigger: string;
  contextHash: string;
  feedbackText: string;
  classification: FeedbackTextClassification;
  highValue: DecisionRepairTraceSource[];
  lowValue: DecisionRepairTraceSource[];
  traceCharCap: number;
  diagnostics?: {
    pipeline?: string;
    feedbackId?: string;
    sourceMemoryId?: string;
  };
}

const pipelineLogger = createMemoryLogger("pipeline");

export type SynthesizeDecisionRepairDraft = (
  input: DecisionRepairSynthesisRequest
) => Promise<DecisionRepairLlmDraft | undefined>;

interface FeedbackAttribution {
  l1MemoryId?: string;
  rawTurnId?: string;
  episodeId?: string;
  sessionId?: string;
}

type FeedbackExperienceType =
  | "success_pattern"
  | "repair_validated"
  | "failure_avoidance"
  | "repair_instruction"
  | "preference"
  | "verifier_feedback";

type FeedbackEvidencePolarity = "positive" | "negative" | "mixed" | "neutral";

interface FeedbackExperienceDraft {
  type: FeedbackExperienceType;
  polarity: FeedbackEvidencePolarity;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  decisionGuidance: {
    preference: string[];
    antiPattern: string[];
  };
  salience: number;
  confidence: number;
  skillEligible: boolean;
  verifierMeta: Record<string, unknown> | null;
  sourceEpisodeIds: string[];
  sourceTraceIds: string[];
  sourceFeedbackIds: string[];
  vectorText: string;
  tags: string[];
}

export class FeedbackExperienceService {
  constructor(private readonly deps: FeedbackExperienceServiceDeps) {}

async feedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    if (!this.deps.memoryAddEnabled()) {
      return this.feedbackNoWrite(request);
    }
    const idempotencyKey = request.adapterId && request.requestId
      ? `feedback.add:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = stableHash({ request });
    if (idempotencyKey) {
      const existing = this.deps.repos.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryServiceError("conflict", "idempotency key reused with different feedback request body");
        }
        const body = existing.response as FeedbackResponse;
        return {
          ...body,
          duplicate: true
        };
      }
    }
    const context = this.resolveFeedbackContext(request);
    const attribution = this.resolveFeedbackAttribution(request, context);
    const attributedRequest: FeedbackRequest = {
      ...request,
      l1MemoryId: request.l1MemoryId ?? attribution.l1MemoryId,
      rawTurnId: request.rawTurnId ?? attribution.rawTurnId,
      episodeId: request.episodeId ?? attribution.episodeId,
      sessionId: request.sessionId ?? attribution.sessionId
    };
    const recallOutcome = recallOutcomeFromFeedback(request);
    let recallEvent: RecallEventRecord | undefined;
    if (request.recallEventId) {
      recallEvent = this.deps.repos.runtime.getRecallEvent(request.recallEventId);
      if (!recallEvent) {
        throw new MemoryServiceError("not_found", `recall event not found: ${request.recallEventId}`);
      }
    }
    const feedbackId = newId("feedback");
    const feedbackContextHash = this.feedbackContextHash(attributedRequest, context);
    const feedback = this.deps.repos.runtime.insertFeedback({
      id: feedbackId,
      userId: context.userId,
      projectId: context.namespace.projectId ?? context.namespace.workspaceId,
      conversationId: context.conversationId,
      sessionId: attributedRequest.sessionId,
      episodeId: attributedRequest.episodeId,
      l1MemoryId: attributedRequest.l1MemoryId,
      rawTurnId: attributedRequest.rawTurnId,
      channel: request.channel,
      polarity: request.polarity,
      magnitude: request.magnitude ?? 1,
      rationale: request.rationale,
      rawPayload: request.rawPayload ?? {},
      contextHash: feedbackContextHash,
      createdAt: nowIso()
    });
    if (feedback.episodeId) {
      this.deps.repos.runtime.appendEpisodeFeedback(feedback.episodeId, feedback.id, feedback.createdAt);
    }
    const repairDraft = await this.maybeSynthesizeFeedbackDecisionRepair(
      attributedRequest,
      feedback,
      feedbackContextHash
    );
    const repair = this.maybeCreateDecisionRepair(
      attributedRequest,
      feedback,
      feedbackContextHash,
      namespaceIdFromContext(context.namespace),
      repairDraft
    );
    const updatedRecallEvent = recallEvent && recallOutcome
      ? this.deps.repos.runtime.updateRecallEventOutcome(recallEvent.id, recallOutcome)
      : undefined;
    if (updatedRecallEvent) {
      this.applyRecallOutcome(updatedRecallEvent, feedback, feedback.createdAt);
    }
    const jobs: EvolutionJobRecord[] = [];
    jobs.push(...await this.maybeCreateFeedbackExperience(attributedRequest, feedback, context));
    if (attributedRequest.l1MemoryId || attributedRequest.episodeId) {
      jobs.push(
        this.deps.enqueueJob({
          jobType: "reward",
          userId: context.userId,
          sessionId: attributedRequest.sessionId,
          episodeId: attributedRequest.episodeId,
          payload: {
            feedbackId: feedback.id,
            ...(attributedRequest.l1MemoryId ? { l1MemoryId: attributedRequest.l1MemoryId } : {}),
            channel: feedback.channel,
            polarity: feedback.polarity,
            magnitude: feedback.magnitude,
            rationale: feedback.rationale,
            trigger: feedback.channel === "implicit" ? "implicit_feedback" : "explicit_feedback"
          }
        })
      );
    }
    for (const trial of this.deps.pendingTrialsForFeedback(feedback)) {
      jobs.push(this.deps.enqueueJob({
        jobType: "skill_trial_resolve",
        userId: context.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        payload: {
          trialId: trial.id,
          feedbackId: feedback.id,
          targetKind: "skill_trial",
          rawTurnId: trial.rawTurnId,
          turnId: trial.turnId
        }
      }));
    }
    const changeSeq = this.deps.repos.runtime.appendChange({
      memoryId: attributedRequest.l1MemoryId ?? attributedRequest.rawTurnId ?? feedback.id,
      namespaceId: namespaceIdFromContext(context.namespace),
      kind: "feedback",
      op: "created",
      entityId: feedback.id,
      userId: context.userId,
      changeType: "feedback",
      after: feedback,
      source: "feedback.add",
      createdAt: feedback.createdAt
    });
    const body = {
      id: feedbackId,
      ts: feedback.createdAt,
      channel: feedback.channel,
      polarity: feedback.polarity,
      magnitude: feedback.magnitude,
      scheduledEvolution: jobs.length > 0,
      changeSeq,
      syncCursor: this.deps.encodeChangeCursor(changeSeq, context.namespace),
      feedbackId,
      recallEventId: updatedRecallEvent?.id,
      recallOutcome: updatedRecallEvent?.outcome,
      repair,
      jobs: jobs.map(jobToRef),
      serverTime: nowIso()
    };
    if (idempotencyKey) {
      this.deps.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body);
    }
    return body;
  }

feedbackContextHash(
    request: FeedbackRequest,
    context: ResolvedContext
  ): string {
    const rawContextHash = isRecord(request.rawPayload) && typeof request.rawPayload.contextHash === "string"
      ? request.rawPayload.contextHash
      : undefined;
    if (rawContextHash) return rawContextHash;
    return stableHash({
      sessionId: request.sessionId,
      episodeId: request.episodeId,
      rawTurnId: request.rawTurnId,
      l1MemoryId: request.l1MemoryId,
      recallEventId: request.recallEventId,
      rationale: request.rationale
    }).slice(0, 32);
  }

async maybeSynthesizeFeedbackDecisionRepair(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    contextHash: string
  ): Promise<DecisionRepairLlmDraft | undefined> {
    const classification = classifyFeedbackText(request.rationale ?? feedback.rationale ?? "");
    const shouldRepair = request.polarity === "negative" ||
      classification.shape === "negative" ||
      classification.shape === "preference" ||
      classification.shape === "correction" ||
      classification.shape === "constraint";
    if (!shouldRepair) return undefined;
    const cooldownMs = this.deps.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(feedback.createdAt) - cooldownMs).toISOString();
      const recent = this.deps.repos.runtime.listDecisionRepairs({
        userId: feedback.userId,
        contextHash,
        since,
        limit: 1
      });
      if (recent.length > 0) return undefined;
    }

    const attachedPolicyIds = this.deps.config.algorithm.feedback.attachToPolicy
      ? this.feedbackCandidatePolicyIds(request, feedback)
      : [];
    const evidence = this.feedbackRepairEvidence(request, feedback, attachedPolicyIds);
    const highValue = this.decisionRepairTraceSources(
      this.deps.repos.memories.getMany(evidence.highValueMemoryIds)
    );
    const lowValue = this.decisionRepairTraceSources(
      this.deps.repos.memories.getMany(evidence.lowValueMemoryIds)
    );
    return synthesizeDecisionRepairDraft({
      trigger: "user.feedback",
      contextHash,
      feedbackText: request.rationale ?? feedback.rationale ?? "",
      classification,
      highValue,
      lowValue,
      traceCharCap: this.deps.config.algorithm.feedback.traceCharCap,
      diagnostics: {
        pipeline: "decision_repair.feedback",
        feedbackId: feedback.id
      }
    }, {
      useLlm: this.deps.config.algorithm.feedback.useLlm,
      llm: this.deps.skillLlm
    });
  }

maybeCreateDecisionRepair(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    contextHash: string,
    namespaceId: string,
    llmDraft?: DecisionRepairLlmDraft
  ): {
    repairId?: string;
    contextHash?: string;
    skipped?: boolean;
    reason?: string;
    attachedPolicyIds?: string[];
  } | undefined {
    const classification = classifyFeedbackText(request.rationale ?? "");
    const shouldRepair = request.polarity === "negative" ||
      classification.shape === "negative" ||
      classification.shape === "preference" ||
      classification.shape === "correction" ||
      classification.shape === "constraint";
    if (!shouldRepair) return undefined;

    const cooldownMs = this.deps.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(feedback.createdAt) - cooldownMs).toISOString();
      const recent = this.deps.repos.runtime.listDecisionRepairs({
        userId: feedback.userId,
        contextHash,
        since,
        limit: 1
      });
      if (recent.length > 0) {
        return {
          contextHash,
          skipped: true,
          reason: "cooldown"
        };
      }
    }

    const attachedPolicyIds = this.deps.config.algorithm.feedback.attachToPolicy
      ? this.feedbackCandidatePolicyIds(request, feedback)
      : [];
    const evidence = this.feedbackRepairEvidence(request, feedback, attachedPolicyIds);
    const repair = this.deps.repos.runtime.insertDecisionRepair({
      id: newId("repair"),
      sessionId: feedback.sessionId,
      episodeId: feedback.episodeId,
      rawTurnId: feedback.rawTurnId,
      userId: feedback.userId,
      projectId: feedback.projectId,
      contextHash,
      issue: repairIssueFromFeedback(request, classification),
      suggestion: llmDraft?.preference ?? repairSuggestionFromFeedback(request, classification),
      preference: llmDraft?.preference ?? repairPreferenceFromFeedback(request, classification),
      antiPattern: llmDraft?.antiPattern ?? repairAntiPatternFromFeedback(request, classification),
      highValueMemoryIds: evidence.highValueMemoryIds,
      lowValueMemoryIds: evidence.lowValueMemoryIds,
      attachedPolicyMemoryIds: attachedPolicyIds,
      feedbackId: feedback.id,
      validated: false,
      source: {
        source: "feedback.decision_repair.v7",
        classification,
        attachedPolicyIds,
        ...(llmDraft ? { synthesis: "llm" } : {})
      },
      meta: {
        trigger: "user_feedback",
        polarity: feedback.polarity,
        severity: llmDraft?.severity,
        confidence: llmDraft?.confidence ?? classification.confidence
      },
      createdAt: feedback.createdAt
    });
    if (feedback.episodeId) {
      this.deps.repos.runtime.appendEpisodeDecisionRepair(feedback.episodeId, repair.id, feedback.createdAt);
    }
    const actuallyAttached = attachedPolicyIds.length > 0
      ? this.attachRepairToPolicies(repair.id, attachedPolicyIds, repair.preference, repair.antiPattern, feedback.createdAt)
      : [];
    this.deps.repos.runtime.appendChange({
      memoryId: repair.id,
      namespaceId,
      userId: feedback.userId,
      kind: "repair",
      op: "created",
      entityId: repair.id,
      changeType: "decision_repair_created",
      after: repair,
      source: "feedback.decision_repair.v7",
      createdAt: feedback.createdAt
    });
    return {
      repairId: repair.id,
      contextHash,
      skipped: false,
      attachedPolicyIds: actuallyAttached
    };
  }

async maybeCreateFeedbackExperience(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    context: ResolvedContext
  ): Promise<EvolutionJobRecord[]> {
    const text = feedbackExperienceText(feedback);
    if (!text) return [];
    const classification = classifyFeedbackText(text);
    const episode = feedback.episodeId ? this.deps.repos.runtime.getEpisode(feedback.episodeId) : undefined;
    const traceMemory = feedback.l1MemoryId ? this.deps.repos.memories.get(feedback.l1MemoryId) : undefined;
    const trace = traceMemory ? this.deps.traceMeta(traceMemory) : null;
    const significance = feedbackExperienceSignificance(feedback, classification, episode);
    if (significance < 0.5 || !isActionableFeedbackExperience(text, classification.shape)) {
      return [];
    }
    const fallbackDraft = buildFeedbackExperienceDraft({
      feedback,
      text,
      classification,
      significance,
      episode,
      trace,
      traceMemory
    });
    const draft = await this.enhanceFeedbackExperienceDraft(fallbackDraft, {
      text,
      feedback,
      episode,
      trace
    });
    const vector = await this.deps.embedder.embedOne(draft.vectorText, "query");
    const existing = this.findSimilarFeedbackExperience(draft, vector, feedback.userId);
    const at = feedback.createdAt;
    const saved = existing
      ? this.mergeFeedbackExperiencePolicy(existing, draft, vector, at)
      : this.insertFeedbackExperiencePolicy(request, feedback, context, draft, vector, at);
    for (const episodeId of draft.sourceEpisodeIds) {
      this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", saved.id, at);
    }
    const repairCandidate = this.maybeMintRepairCandidateSkill(saved, context, at);
    if (repairCandidate) {
      for (const episodeId of draft.sourceEpisodeIds) {
        this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "Skill", repairCandidate.id, at);
      }
    }
    const jobs: EvolutionJobRecord[] = [];
    if (this.deps.config.algorithm.capture.embedAfterCapture) {
      if (repairCandidate) {
        jobs.push(this.deps.enqueueJob({
          jobType: "embedding",
          userId: repairCandidate.userId,
          sessionId: repairCandidate.sessionId,
          episodeId: feedback.episodeId,
          targetMemoryId: repairCandidate.id,
          payload: { reason: "repair.candidate" },
          createdAt: at
        }));
      }
    }
    jobs.push(
      this.deps.enqueueJob({
        jobType: "skill_crystallization",
        userId: saved.userId,
        sessionId: saved.sessionId,
        episodeId: feedback.episodeId,
        targetMemoryId: saved.id,
        payload: { reason: "feedback.experience", feedbackId: feedback.id },
        createdAt: at
      }),
      this.deps.enqueueJob({
        jobType: "l3_abstraction",
        userId: saved.userId,
        sessionId: saved.sessionId,
        episodeId: feedback.episodeId,
        payload: {
          reason: "feedback.experience",
          targetKind: "policy_cluster",
          seedPolicyId: saved.id,
          policyIds: [saved.id],
          feedbackId: feedback.id
        },
        createdAt: at
      })
    );
    return jobs;
  }

maybeMintRepairCandidateSkill(
    policyMemory: MemoryRow,
    context: ResolvedContext,
    at: string
  ): MemoryRow | undefined {
    const policy = policyMetaFromMemory(policyMemory);
    if (!policy || !isRepairCandidatePolicyForSkill(policy)) return undefined;
    if (this.deps.findExistingSkillForPolicy(policy, policyMemory.userId)) return undefined;

    const fix = policy.decisionGuidance.preference.find((item) => item.trim().length > 0);
    if (!fix) return undefined;
    const name = repairCandidateSkillName(policy, fix);
    const invocationGuide = renderRepairCandidateGuide(policy, fix);
    const eta = Math.max(0.1, this.deps.config.algorithm.skill.minEtaForRetrieval);
    const betaPosterior = skillBetaPosterior(0, 0);
    const procedureJson = {
      summary: policy.procedure || fix,
      preconditions: [policy.trigger].filter(Boolean),
      parameters: [],
      steps: [
        {
          title: "Apply candidate repair",
          body: fix
        },
        {
          title: "Verify closure",
          body: policy.verification || "Check the current task outcome before treating the repair as validated."
        }
      ],
      decisionGuidance: {
        preference: policy.decisionGuidance.preference,
        antiPattern: policy.decisionGuidance.antiPattern
      },
      reliability: {
        supportCount: 1,
        successRate: 0,
        betaPosterior
      },
      repairOrigin: true,
      strictTrial: repairCandidateStrictTrial(policy)
    };
    const skill = this.deps.buildMemory({
      userId: policyMemory.userId,
      conversationId: policyMemory.conversationId,
      sessionId: policyMemory.sessionId,
      agentId: policyMemory.agentId ?? context.namespace.source,
      appId: policyMemory.appId ?? context.namespace.workspaceId,
      projectId: projectIdFromMemory(policyMemory) ?? context.namespace.projectId,
      profileId: profileIdFromMemory(policyMemory) ?? context.namespace.profileId,
      layer: "Skill",
      kind: "skill",
      lifecycleStatus: "candidate",
      memoryType: "SkillMemory",
      key: `skill:${policy.id}`,
      value: invocationGuide,
      tags: uniq(["skill", "repair_candidate", ...policyMemory.tags.filter((tag) => tag !== "policy")]).slice(0, 12),
      info: {
        name,
        eta,
        status: "candidate",
        source_memory_ids: [policy.id],
        repair_origin: true,
        strict_trial: repairCandidateStrictTrial(policy)
      },
      internal: {
        source: "feedback.repair_candidate.v1",
        plugin_algorithm: "skill.repair_candidate.v1",
        source_memory_ids: [policy.id],
        source_policy_ids: [policy.id],
        source_world_model_ids: [],
        evidence_anchor_ids: policy.sourceTraceIds.slice(0, this.deps.config.algorithm.skill.evidenceLimit),
        name,
        invocation_guide: invocationGuide,
        procedure_json: procedureJson,
        eta,
        support: 1,
        gain: policy.gain,
        repair_origin: true,
        repairOrigin: true,
        strict_trial: repairCandidateStrictTrial(policy),
        strictTrial: repairCandidateStrictTrial(policy),
        skill: {
          name,
          eta,
          status: "candidate",
          support: 1,
          gain: policy.gain,
          source_policy_ids: [policy.id],
          source_world_model_ids: [],
          evidence_anchor_ids: policy.sourceTraceIds.slice(0, this.deps.config.algorithm.skill.evidenceLimit),
          invocation_guide: invocationGuide,
          procedure_json: procedureJson,
          trials_attempted: 0,
          trials_passed: 0,
          success_rate: 0,
          beta_posterior: betaPosterior,
          repair_origin: true,
          repairOrigin: true,
          strict_trial: repairCandidateStrictTrial(policy),
          strictTrial: repairCandidateStrictTrial(policy),
          vec: null
        }
      },
      createdAt: at
    });
    const upsert = this.deps.upsertEvolutionMemory(skill);
    this.deps.repos.runtime.appendChange({
      memoryId: upsert.memory.id,
      namespaceId: namespaceIdFromMemory(upsert.memory),
      kind: "skill",
      op: upsert.created ? "created" : "updated",
      entityId: upsert.memory.id,
      userId: upsert.memory.userId,
      changeType: upsert.created ? "repair_candidate_skill_create" : "repair_candidate_skill_update",
      before: upsert.previous,
      after: upsert.memory,
      source: "feedback.repair_candidate.v1",
      createdAt: at
    });
    return upsert.memory;
  }

async enhanceFeedbackExperienceDraft(
    fallback: FeedbackExperienceDraft,
    input: {
      text: string;
      feedback: FeedbackRecord;
      episode?: EpisodeRecord;
      trace: TraceMeta | null;
    }
  ): Promise<FeedbackExperienceDraft> {
    if (!this.deps.config.algorithm.feedback.useLlm || !this.deps.skillLlm.isConfigured()) {
      return fallback;
    }
    const context = this.feedbackExperienceEpisodeContext(input.episode, input.trace);
    const polarity = feedbackPolarityForRefinement(input.feedback, fallback);
    try {
      if (polarity === "negative") {
        const result = await this.deps.skillLlm.completeJson<{
          title?: unknown;
          trigger?: unknown;
          procedure?: unknown;
          verification?: unknown;
          boundary?: unknown;
          experience_type?: unknown;
          decision_guidance?: unknown;
          support_trace_ids?: unknown;
        }>([
          {
            role: "system",
            content: FAILURE_EXPERIENCE_SINK_PROMPT.system
          },
          {
            role: "user",
            content: failureExperienceSinkUserPrompt({
              feedbackText: input.text,
              userRequest: context.userRequest,
              agentResponse: context.agentResponse,
              episodeContext: context.fullContext
            })
          }
        ], {
          operation: `${FAILURE_EXPERIENCE_SINK_PROMPT.id}.v${FAILURE_EXPERIENCE_SINK_PROMPT.version}`,
          thinkingMode: "enabled",
          temperature: 0.2,
          maxTokens: 900
        });
        return applyFailureExperienceSink(fallback, result);
      }
      const result = await this.deps.skillLlm.completeJson<{
        title?: unknown;
        trigger?: unknown;
        procedure?: unknown;
        caveats?: unknown;
        verification?: unknown;
        confidence?: unknown;
      }>([
        {
          role: "system",
          content: FEEDBACK_REFINEMENT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: feedbackRefinementUserPrompt({
            feedbackText: input.text,
            polarity,
            userRequest: context.userRequest,
            agentResponse: context.agentResponse,
            episodeContext: context.fullContext
          })
        }
      ], {
        operation: "feedback.refine.v1",
        thinkingMode: "enabled",
        temperature: 0.2,
        maxTokens: 700
      });
      return applyFeedbackRefinement(fallback, {
        title: stringOr(result.title, ""),
        trigger: stringOr(result.trigger, ""),
        procedure: stringOr(result.procedure, ""),
        verification: stringOr(result.verification, ""),
        caveats: stringArray(result.caveats),
        confidence: numberOr(result.confidence, fallback.confidence),
        method: "llm"
      });
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: polarity === "negative"
          ? `${FAILURE_EXPERIENCE_SINK_PROMPT.id}.v${FAILURE_EXPERIENCE_SINK_PROMPT.version}`
          : "feedback.refine.v1",
        pipeline: "feedback.refinement",
        fallback: "rule_based_refinement",
        feedbackId: input.feedback.id,
        ...memoryErrorFields(error)
      });
      return applyFeedbackRefinement(
        fallback,
        refineFeedbackExperienceByRules({
          feedbackText: input.text,
          polarity,
          userRequest: context.userRequest,
          episodeContext: context.fullContext
        })
      );
    }
  }

feedbackExperienceEpisodeContext(
    episode: EpisodeRecord | undefined,
    currentTrace: TraceMeta | null
  ): {
    userRequest: string;
    agentResponse: string;
    fullContext: string;
  } {
    const traces: TraceMeta[] = [];
    for (const id of episode?.l1MemoryIds ?? []) {
      const memory = this.deps.repos.memories.get(id);
      const trace = memory ? this.deps.traceMeta(memory) : null;
      if (trace) traces.push(trace);
    }
    if (currentTrace && !traces.some((trace) => trace.id === currentTrace.id)) {
      traces.push(currentTrace);
    }
    traces.sort((a, b) => a.ts - b.ts);
    if (traces.length === 0) {
      return { userRequest: "", agentResponse: "", fullContext: "" };
    }
    const selected = feedbackRefinementSelectedTraces(traces);
    const last = selected[selected.length - 1] ?? traces[traces.length - 1]!;
    return {
      userRequest: last.userText,
      agentResponse: last.agentText,
      fullContext: selected.map((trace) =>
        feedbackRefinementTurnBlock(traces.indexOf(trace) + 1, trace)
      ).join("\n\n")
    };
  }

findSimilarFeedbackExperience(
    draft: FeedbackExperienceDraft,
    vector: number[],
    userId: string
  ): MemoryRow | null {
    let best: { memory: MemoryRow; score: number; policy: PolicyMeta } | null = null;
    for (const memory of this.deps.repos.memories.list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 1000)) {
      const policy = policyMetaFromMemory(memory);
      if (!policy) continue;
      const sourceFeedbackIds = stringArray(memory.properties.internal_info.source_feedback_ids)
        .concat(stringArray(isRecord(memory.properties.internal_info.policy)
          ? memory.properties.internal_info.policy.source_feedback_ids
          : undefined));
      const sourceOverlap = draft.sourceTraceIds.some((id) => policy.sourceTraceIds.includes(id));
      const vectorScore = policy.vec ? cosine(vector, policy.vec) : 0;
      const score = Math.max(vectorScore, sourceOverlap && sourceFeedbackIds.length > 0 ? 0.83 : 0);
      if (score < 0.72) continue;
      if (policy.experienceType !== draft.type && score < 0.82) continue;
      if (!best || score > best.score) best = { memory, score, policy };
    }
    return best?.memory ?? null;
  }

insertFeedbackExperiencePolicy(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    context: ResolvedContext,
    draft: FeedbackExperienceDraft,
    vector: number[],
    at: string
  ): MemoryRow {
    const key = `feedback:${stableHash(`${draft.type}:${draft.title}:${draft.trigger}`).slice(0, 16)}`;
    const l2 = this.deps.buildMemory({
      userId: feedback.userId,
      conversationId: feedback.conversationId ?? context.conversationId,
      sessionId: feedback.sessionId ?? request.sessionId,
      agentId: context.namespace.source,
      appId: context.namespace.workspaceId,
      projectId: context.namespace.projectId,
      profileId: context.namespace.profileId,
      layer: "L2",
      kind: "policy",
      lifecycleStatus: draft.salience >= 0.5 ? "active" : "candidate",
      memoryType: "LongTermMemory",
      key,
      value: renderFeedbackExperienceBody(draft),
      tags: draft.tags,
      info: {
        support: 1,
        gain: Math.max(0.02, draft.salience),
        policy_confidence: draft.confidence,
        status: draft.salience >= 0.5 ? "active" : "candidate",
        source_memory_ids: draft.sourceTraceIds,
        source_feedback_ids: draft.sourceFeedbackIds,
        experience_type: draft.type,
        evidence_polarity: draft.polarity
      },
      internal: {
        source: "feedback.experience.v1",
        plugin_algorithm: "feedback.experience.v1",
        source_memory_ids: draft.sourceTraceIds,
        source_l1_memory_ids: draft.sourceTraceIds,
        source_feedback_ids: draft.sourceFeedbackIds,
        title: draft.title,
        trigger: draft.trigger,
        procedure: draft.procedure,
        verification: draft.verification,
        boundary: draft.boundary,
        support: 1,
        gain: Math.max(0.02, draft.salience),
        raw_gain: draft.salience,
        policy_confidence: draft.confidence,
        status: draft.salience >= 0.5 ? "active" : "candidate",
        source_episode_ids: draft.sourceEpisodeIds,
        source_trace_ids: draft.sourceTraceIds,
        policy: {
          title: draft.title,
          trigger: draft.trigger,
          procedure: draft.procedure,
          verification: draft.verification,
          boundary: draft.boundary,
          support: 1,
          gain: Math.max(0.02, draft.salience),
          raw_gain: draft.salience,
          policy_confidence: draft.confidence,
          status: draft.salience >= 0.5 ? "active" : "candidate",
          experience_type: draft.type,
          evidence_polarity: draft.polarity,
          salience: draft.salience,
          confidence: draft.confidence,
          source_episode_ids: draft.sourceEpisodeIds,
          source_trace_ids: draft.sourceTraceIds,
          source_feedback_ids: draft.sourceFeedbackIds,
          induced_by: "feedback.experience.v1",
          decision_guidance: policyDecisionGuidanceForStorage(draft.decisionGuidance),
          verifier_meta: draft.verifierMeta,
          skill_eligible: draft.skillEligible,
          signature: `feedback|${draft.type}|${draft.polarity}`,
          vec: vector
        }
      },
      createdAt: at
    });
    const upsert = this.deps.repos.memories.upsertByKey(l2);
    this.deps.repos.runtime.appendChange({
      memoryId: upsert.memory.id,
      namespaceId: namespaceIdFromMemory(upsert.memory),
      kind: "policy",
      op: upsert.created ? "created" : "updated",
      entityId: upsert.memory.id,
      userId: upsert.memory.userId,
      changeType: upsert.created ? "feedback_experience_create" : "feedback_experience_update",
      before: upsert.previous,
      after: upsert.memory,
      source: "feedback.experience.v1",
      createdAt: at
    });
    return upsert.memory;
  }

mergeFeedbackExperiencePolicy(
    memory: MemoryRow,
    draft: FeedbackExperienceDraft,
    vector: number[],
    at: string
  ): MemoryRow {
    const previous = memory;
    const policy = policyMetaFromMemory(memory);
    const internalPolicy = isRecord(memory.properties.internal_info.policy)
      ? memory.properties.internal_info.policy
      : {};
    const existingPolarity = policy?.evidencePolarity ?? "positive";
    const polarity = mergeFeedbackPolarity(existingPolarity, draft.polarity);
    const skillEligible = Boolean((policy?.skillEligible ?? true) || draft.skillEligible);
    const support = Math.max(1, policy?.support ?? 0) + 1;
    const gain = Math.max(policy?.gain ?? 0, draft.salience, 0.02);
    const status = memoryStatusForLifecycleStatus(memory.status === "archived" ? "archived" : "active");
    const experienceType: FeedbackExperienceType = skillEligible && polarity === "mixed"
      ? "repair_validated"
      : (policy?.experienceType ?? draft.type);
    const sourceEpisodeIds = uniq([...(policy?.sourceEpisodeIds ?? []), ...draft.sourceEpisodeIds]);
    const sourceTraceIds = uniq([...(policy?.sourceTraceIds ?? []), ...draft.sourceTraceIds]);
    const sourceFeedbackIds = uniq([
      ...stringArray(internalPolicy.source_feedback_ids),
      ...draft.sourceFeedbackIds
    ]);
    const decisionGuidance = {
      preference: uniq([...(policy?.decisionGuidance.preference ?? []), ...draft.decisionGuidance.preference]),
      antiPattern: uniq([...(policy?.decisionGuidance.antiPattern ?? []), ...draft.decisionGuidance.antiPattern])
    };
    const nextPolicy = {
      ...internalPolicy,
      title: draft.title,
      trigger: draft.trigger,
      procedure: draft.procedure,
      verification: draft.verification,
      boundary: draft.boundary,
      support,
      gain,
      raw_gain: Math.max(numberOr(internalPolicy.raw_gain, 0), draft.salience),
      status: memory.status === "archived" ? "archived" : "active",
      experience_type: experienceType,
      evidence_polarity: polarity,
      salience: Math.max(numberOr(internalPolicy.salience, 0), draft.salience),
      policy_confidence: Math.max(policy?.confidence ?? 0.5, draft.confidence),
      confidence: Math.max(policy?.confidence ?? 0.5, draft.confidence),
      source_episode_ids: sourceEpisodeIds,
      source_trace_ids: sourceTraceIds,
      source_feedback_ids: sourceFeedbackIds,
      decision_guidance: policyDecisionGuidanceForStorage(decisionGuidance),
      verifier_meta: internalPolicy.verifier_meta ?? draft.verifierMeta,
      skill_eligible: skillEligible,
      vec: vector
    };
    const mergedDraft = {
      ...draft,
      type: experienceType,
      polarity,
      support,
      gain,
      sourceEpisodeIds,
      sourceTraceIds,
      sourceFeedbackIds,
      decisionGuidance
    };
    const next: MemoryRow = {
      ...memory,
      status,
      memoryValue: renderFeedbackExperienceBody(mergedDraft),
      info: {
        ...memory.info,
        support,
        gain,
        policy_confidence: nextPolicy.policy_confidence,
        status: nextPolicy.status,
        source_memory_ids: sourceTraceIds,
        source_feedback_ids: sourceFeedbackIds,
        experience_type: experienceType,
        evidence_polarity: polarity
      },
      properties: {
        ...memory.properties,
        status,
        info: {
          ...(memory.properties.info ?? {}),
          support,
          gain,
          policy_confidence: nextPolicy.policy_confidence,
          status: nextPolicy.status,
          source_memory_ids: sourceTraceIds,
          source_feedback_ids: sourceFeedbackIds,
          experience_type: experienceType,
          evidence_polarity: polarity
        },
        internal_info: {
          ...memory.properties.internal_info,
          source_memory_ids: sourceTraceIds,
          source_l1_memory_ids: sourceTraceIds,
          source_feedback_ids: sourceFeedbackIds,
          title: nextPolicy.title,
          trigger: nextPolicy.trigger,
          procedure: nextPolicy.procedure,
          verification: nextPolicy.verification,
          boundary: nextPolicy.boundary,
          support,
          gain,
          raw_gain: nextPolicy.raw_gain,
          policy_confidence: nextPolicy.policy_confidence,
          status: nextPolicy.status,
          source_episode_ids: sourceEpisodeIds,
          source_trace_ids: sourceTraceIds,
          decision_guidance: nextPolicy.decision_guidance,
          policy: nextPolicy
        }
      },
      updatedAt: at,
      contentHash: stableHash(renderFeedbackExperienceBody(mergedDraft))
    };
    const saved = this.deps.repos.memories.update(next);
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: namespaceIdFromMemory(saved),
      kind: "policy",
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "feedback_experience_merge",
      before: previous,
      after: saved,
      source: "feedback.experience.v1",
      createdAt: at
    });
    return saved;
  }

feedbackCandidatePolicyIds(request: FeedbackRequest, feedback: FeedbackRecord): string[] {
    const ids = new Set<string>();
    if (request.recallEventId) {
      const recall = this.deps.repos.runtime.getRecallEvent(request.recallEventId);
      for (const id of recall?.injectedMemoryIds ?? []) {
        const memory = this.deps.repos.memories.get(id);
        if (memory?.memoryLayer === "L2") ids.add(memory.id);
      }
    }
    if (feedback.l1MemoryId) {
      for (const link of this.deps.repos.runtime.listTracePolicyLinks({
        userId: feedback.userId,
        l1MemoryId: feedback.l1MemoryId,
        limit: 20
      })) {
        ids.add(link.l2MemoryId);
      }
    }
    if (ids.size === 0 && feedback.rationale) {
      for (const hit of this.deps.repos.memories.search(
        feedback.rationale,
        {
          memoryLayer: "L2",
          status: "activated"
        },
        3
      )) {
        ids.add(hit.id);
      }
    }
    return [...ids].slice(0, this.deps.config.algorithm.feedback.evidenceLimit);
  }

feedbackRepairEvidence(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    policyIds: string[]
  ): {
    highValueMemoryIds: string[];
    lowValueMemoryIds: string[];
  } {
    const limit = this.deps.config.algorithm.feedback.evidenceLimit;
    const low = new Set<string>();
    const high = new Set<string>();
    if (feedback.l1MemoryId) {
      if (feedback.polarity === "negative") {
        low.add(feedback.l1MemoryId);
      } else if (feedback.polarity === "positive") {
        high.add(feedback.l1MemoryId);
      }
    }
    if (request.recallEventId) {
      const recall = this.deps.repos.runtime.getRecallEvent(request.recallEventId);
      for (const id of recall?.injectedMemoryIds ?? []) {
        if (feedback.polarity === "negative") {
          low.add(id);
        } else if (feedback.polarity === "positive") {
          high.add(id);
        }
      }
    }
    for (const policy of this.deps.repos.memories.getMany(policyIds)) {
      const meta = policyMetaFromMemory(policy);
      if (!meta) continue;
      for (const id of meta.sourceTraceIds) {
        if (feedback.polarity === "negative") low.add(id);
        if (feedback.polarity === "positive") high.add(id);
      }
    }
    const searchText = request.rationale ?? feedback.rationale;
    if (request.sessionId && (high.size < limit || low.size < limit)) {
      const evidence = this.sessionRepairEvidence(
        feedback.userId,
        request.sessionId,
        searchText,
        limit
      );
      for (const memory of evidence.highValue) {
        if (!low.has(memory.id) && high.size < limit) high.add(memory.id);
      }
      for (const memory of evidence.lowValue) {
        if (!high.has(memory.id) && low.size < limit) low.add(memory.id);
      }
    }
    if (searchText && high.size < limit) {
      for (const memory of this.deps.repos.memories.search(
        searchText,
        {
          memoryLayer: "L1",
          status: "activated"
        },
        limit * 2
      )) {
        const fullMemory = this.deps.repos.memories.get(memory.id);
        const trace = fullMemory ? this.deps.traceMeta(fullMemory) : null;
        if (trace && trace.value > 0 && !low.has(memory.id)) high.add(memory.id);
        if (high.size >= limit) break;
      }
    }
    if (searchText && low.size < limit) {
      for (const memory of this.deps.repos.memories.search(
        searchText,
        {
          memoryLayer: "L1",
          status: "activated"
        },
        limit * 2
      )) {
        const fullMemory = this.deps.repos.memories.get(memory.id);
        const trace = fullMemory ? this.deps.traceMeta(fullMemory) : null;
        if (
          trace &&
          !high.has(memory.id) &&
          (
            trace.value < -this.deps.config.algorithm.feedback.minLowValueThreshold ||
            sessionIsRepairFailureLikeTrace(trace)
          )
        ) {
          low.add(memory.id);
        }
        if (low.size >= limit) break;
      }
    }
    return {
      highValueMemoryIds: [...high].slice(0, limit),
      lowValueMemoryIds: [...low].slice(0, limit)
    };
  }

sessionRepairEvidence(
    userId: string,
    sessionId: string,
    keyword: string | undefined,
    limit: number
  ): {
    highValue: MemoryRow[];
    lowValue: MemoryRow[];
  } {
    const recent = this.deps.repos.memories
      .list(
        {
          sessionId,
          memoryLayer: "L1",
          status: "activated"
        },
        Math.max(limit * 6, 24)
      )
      .map((memory) => ({ memory, trace: this.deps.traceMeta(memory) }))
      .filter((item): item is { memory: MemoryRow; trace: TraceMeta } => Boolean(item.trace));
    if (recent.length === 0) {
      return { highValue: [], lowValue: [] };
    }

    const needle = keyword?.toLowerCase().trim() ?? "";
    const firstPass = this.partitionSessionRepairEvidence(recent, needle, limit);
    const emptyFirstPass = firstPass.highValue.length === 0 && firstPass.lowValue.length === 0;
    if (!needle || !emptyFirstPass) {
      return firstPass;
    }
    return this.partitionSessionRepairEvidence(recent, "", limit);
  }

partitionSessionRepairEvidence(
    rows: Array<{ memory: MemoryRow; trace: TraceMeta }>,
    needle: string,
    limit: number
  ): {
    highValue: MemoryRow[];
    lowValue: MemoryRow[];
  } {
    const highValue: MemoryRow[] = [];
    const lowValue: MemoryRow[] = [];
    for (const row of rows) {
      if (needle && !sessionRepairTraceContains(row.trace, needle)) continue;
      if (row.trace.value > 0) {
        if (highValue.length < limit) highValue.push(row.memory);
      } else if (
        row.trace.value < -this.deps.config.algorithm.feedback.minLowValueThreshold ||
        sessionIsRepairFailureLikeTrace(row.trace)
      ) {
        if (lowValue.length < limit) lowValue.push(row.memory);
      }
      if (highValue.length >= limit && lowValue.length >= limit) break;
    }
    return { highValue, lowValue };
  }

decisionRepairTraceSources(memories: MemoryRow[]): DecisionRepairTraceSource[] {
    return memories.map((memory) => {
      const rawTurnId = rawTurnIdFromMemory(memory);
      return {
        memory,
        rawTurn: rawTurnId ? this.deps.repos.runtime.getRawTurn(rawTurnId) : undefined
      };
    });
  }

attachRepairToPolicies(
    repairId: string,
    policyIds: string[],
    preference: string | undefined,
    antiPattern: string | undefined,
    at: string
  ): string[] {
    const attached: string[] = [];
    for (const policyId of policyIds) {
      const memory = this.deps.repos.memories.get(policyId);
      if (!memory || memory.memoryLayer !== "L2") continue;
      const previous = memory;
      const next = updatePolicyDecisionGuidance(memory, {
        preference,
        antiPattern,
        repairId,
        updatedAt: at
      });
      if (next === memory) continue;
      const saved = this.deps.repos.memories.update(next);
      attached.push(saved.id);
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "policy_repair_attached",
        before: previous,
        after: saved,
        source: "feedback.decision_repair.v7",
        createdAt: at
      });
    }
    return attached;
  }

applyRecallOutcome(
    event: RecallEventRecord,
    feedback: FeedbackRecord,
    at: string
  ): void {
    const outcome = event.outcome;
    if (!outcome || outcome === "pending") return;
    const memoryIds = uniq(event.injectedMemoryIds ?? event.hitMemoryIds);
    for (const memory of this.deps.repos.memories.getMany(memoryIds)) {
      if (memory.userId !== event.userId) continue;
      const previous = memory;
      let next = updateRecallStats(memory, {
        outcome,
        feedbackId: feedback.id,
        recallEventId: event.id,
        updatedAt: at
      });
      if (outcome !== "ignored" && memory.memoryLayer === "L2") {
        const policy = policyMetaFromMemory(next);
        if (policy) {
          const direction = outcome === "positive" ? 1 : -1;
          const nextGain = clampNumber(
            policy.gain + direction * 0.02 * clampNumber(feedback.magnitude, 0, 1),
            -1,
            1
          );
          const status = policyStatusAfterGain({
            currentStatus: policy.status,
            support: policy.support,
            gain: nextGain,
            minSupport: this.deps.config.algorithm.l2Induction.minEpisodesForInduction,
            minGain: this.deps.config.algorithm.l2Induction.minGain,
            archiveGain: this.deps.config.algorithm.l2Induction.archiveGain
          });
          next = updatePolicyStats(next, {
            support: policy.support,
            gain: nextGain,
            rawGain: nextGain,
            status,
            sourceEpisodeIds: policy.sourceEpisodeIds,
            sourceTraceIds: policy.sourceTraceIds,
            updatedAt: at
          });
        }
      }
      const saved = this.deps.repos.memories.update(next);
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "recall_outcome_update",
        before: previous,
        after: saved,
        source: "worker.recall_outcome.v7",
        createdAt: at
      });
    }
    this.deps.repos.runtime.appendChange({
      memoryId: event.id,
      namespaceId: event.namespaceId,
      userId: event.userId,
      kind: "recall",
      op: "updated",
      entityId: event.id,
      changeType: "recall_outcome",
      after: event,
      source: "feedback.recall_outcome",
      createdAt: at
    });
  }

feedbackNoWrite(request: FeedbackRequest): FeedbackResponse {
    const cursor = this.deps.readOnlyCursor(request.namespace);
    const feedbackId = `feedback_${stableHash({
      sessionId: request.sessionId,
      target: request.target,
      polarity: request.polarity,
      rationale: request.rationale
    }).slice(0, 20)}`;
    return {
      id: feedbackId,
      ts: nowIso(),
      channel: request.channel,
      polarity: request.polarity,
      magnitude: request.magnitude ?? 1,
      scheduledEvolution: false,
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      feedbackId,
      jobs: [],
      serverTime: nowIso()
    };
  }

resolveFeedbackContext(request: FeedbackRequest): ResolvedContext {
    if (request.sessionId) {
      const session = this.deps.repos.runtime.getSession(request.sessionId);
      if (session) {
        this.deps.assertSessionInScope(session, request.namespace);
        return {
          userId: session.userId,
          conversationId: session.conversationId,
          namespace: namespaceForSession(session)
        };
      }
    }
    if (request.episodeId) {
      const episode = this.deps.repos.runtime.getEpisode(request.episodeId);
      if (episode) {
        this.deps.assertEpisodeInScope(episode, request.namespace);
        const session = this.deps.repos.runtime.getSession(episode.sessionId);
        if (session) {
          return {
            userId: session.userId,
            conversationId: session.conversationId,
            namespace: namespaceForSession(session)
          };
        }
        return {
          userId: episode.userId,
          conversationId: episode.conversationId,
          namespace: {
            ...normalizeNamespace(request.namespace),
            userId: episode.userId
          }
        };
      }
    }
    if (request.rawTurnId) {
      const rawTurn = this.deps.repos.runtime.getRawTurn(request.rawTurnId);
      if (rawTurn) {
        this.deps.assertRawTurnInScope(rawTurn, request.namespace);
        const session = this.deps.repos.runtime.getSession(rawTurn.sessionId);
        if (session) {
          return {
            userId: session.userId,
            conversationId: session.conversationId,
            namespace: namespaceForSession(session)
          };
        }
        return {
          userId: rawTurn.userId,
          conversationId: rawTurn.conversationId,
          namespace: {
            ...normalizeNamespace(request.namespace),
            userId: rawTurn.userId
          }
        };
      }
    }
    if (request.l1MemoryId) {
      const memory = this.deps.repos.memories.get(request.l1MemoryId);
      if (memory) {
        this.deps.assertMemoryInScope(memory, request.namespace);
        const session = memory.sessionId ? this.deps.repos.runtime.getSession(memory.sessionId) : undefined;
        if (session) {
          return {
            userId: session.userId,
            conversationId: session.conversationId,
            namespace: namespaceForSession(session)
          };
        }
        return {
          userId: memory.userId,
          conversationId: memory.conversationId,
          namespace: namespaceForMemory(memory)
        };
      }
    }
    return this.deps.resolveContext(request);
  }

resolveFeedbackAttribution(
    request: FeedbackRequest,
    context: ResolvedContext
  ): FeedbackAttribution {
    let episode = request.episodeId ? this.deps.requireEpisode(request.episodeId) : undefined;
    if (episode) {
      this.deps.assertEpisodeInScope(episode, request.namespace);
      if (request.sessionId && episode.sessionId !== request.sessionId) {
        throw new MemoryServiceError("conflict", "feedback episode does not belong to the requested session");
      }
    }

    let rawTurn = request.rawTurnId ? this.deps.requireRawTurn(request.rawTurnId) : undefined;
    if (rawTurn) {
      this.deps.assertRawTurnInScope(rawTurn, request.namespace);
      if (request.sessionId && rawTurn.sessionId !== request.sessionId) {
        throw new MemoryServiceError("conflict", "feedback raw turn does not belong to the requested session");
      }
      if (episode && rawTurn.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "feedback raw turn does not belong to the requested episode");
      }
      episode = episode ?? this.deps.repos.runtime.getEpisode(rawTurn.episodeId);
    }

    if (request.l1MemoryId) {
      const memory = this.deps.requireExistingMemory(request.l1MemoryId);
      this.deps.assertMemoryInScope(memory, request.namespace);
      const trace = this.deps.traceMeta(memory);
      if (!trace) {
        throw new MemoryServiceError("invalid_argument", "feedback l1MemoryId must reference an L1 trace memory");
      }
      const traceRawTurnId = rawTurnIdFromMemory(memory);
      if (request.sessionId && memory.sessionId && memory.sessionId !== request.sessionId) {
        throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested session");
      }
      if (episode && trace.episodeId && trace.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested episode");
      }
      if (rawTurn && traceRawTurnId && traceRawTurnId !== rawTurn.id) {
        throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested raw turn");
      }
      return {
        l1MemoryId: memory.id,
        rawTurnId: rawTurn?.id ?? traceRawTurnId,
        episodeId: episode?.id ?? trace.episodeId,
        sessionId: request.sessionId ?? memory.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
      };
    }

    const rawTurnTarget = rawTurn ? this.feedbackTargetFromRawTurn(rawTurn) : undefined;
    if (rawTurnTarget) {
      const trace = this.deps.traceMeta(rawTurnTarget);
      return {
        l1MemoryId: rawTurnTarget.id,
        rawTurnId: rawTurn?.id ?? rawTurnIdFromMemory(rawTurnTarget),
        episodeId: episode?.id ?? trace?.episodeId,
        sessionId: request.sessionId ?? rawTurnTarget.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
      };
    }

    const episodeTarget = episode ? this.feedbackTargetFromEpisode(episode) : undefined;
    if (episode && episodeTarget) {
      const trace = this.deps.traceMeta(episodeTarget);
      return {
        l1MemoryId: episodeTarget.id,
        rawTurnId: rawTurnIdFromMemory(episodeTarget),
        episodeId: episode.id ?? trace?.episodeId,
        sessionId: request.sessionId ?? episodeTarget.sessionId ?? episode.sessionId
      };
    }

    return {
      rawTurnId: rawTurn?.id,
      episodeId: episode?.id,
      sessionId: request.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
    };
  }

feedbackTargetFromRawTurn(rawTurn: RawTurnRecord): MemoryRow | undefined {
    const episode = this.deps.repos.runtime.getEpisode(rawTurn.episodeId);
    for (const id of [...(episode?.l1MemoryIds ?? [])].reverse()) {
      const memory = this.deps.repos.memories.get(id);
      if (memory && rawTurnIdFromMemory(memory) === rawTurn.id && this.deps.traceMeta(memory)) {
        return memory;
      }
    }
    return this.deps.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .find((memory) => rawTurnIdFromMemory(memory) === rawTurn.id && Boolean(this.deps.traceMeta(memory)));
  }

feedbackTargetFromEpisode(episode: EpisodeRecord): MemoryRow | undefined {
    for (const id of [...episode.l1MemoryIds].reverse()) {
      const memory = this.deps.repos.memories.get(id);
      if (memory && this.deps.traceMeta(memory)) {
        return memory;
      }
    }
    return undefined;
  }
}

function updatePolicyDecisionGuidance(memory: MemoryRow, input: {
  preference?: string;
  antiPattern?: string;
  repairId: string;
  updatedAt: string;
}): MemoryRow {
  const internalPolicy = isRecord(memory.properties.internal_info.policy)
    ? memory.properties.internal_info.policy
    : {};
  const currentGuidance = isRecord(internalPolicy.decision_guidance)
    ? internalPolicy.decision_guidance
    : {};
  const preference = uniq([
    ...stringArray(currentGuidance.preference),
    ...(input.preference ? [input.preference] : [])
  ]);
  const antiPattern = uniq([
    ...stringArray(currentGuidance.anti_pattern),
    ...(input.antiPattern ? [input.antiPattern] : [])
  ]);
  const repairIds = uniq([
    ...stringArray(currentGuidance.repair_ids),
    input.repairId
  ]);
  const changed = preference.length !== stringArray(currentGuidance.preference).length ||
    antiPattern.length !== stringArray(currentGuidance.anti_pattern).length ||
    repairIds.length !== stringArray(currentGuidance.repair_ids).length;
  if (!changed) return memory;
  return {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        decision_guidance: {
          preference,
          anti_pattern: antiPattern,
          repair_ids: repairIds
        },
        policy: {
          ...internalPolicy,
          decision_guidance: {
            preference,
            anti_pattern: antiPattern,
            repair_ids: repairIds
          }
        }
      }
    },
    updatedAt: input.updatedAt
  };
}

function updateRecallStats(memory: MemoryRow, input: {
  outcome: NonNullable<RecallEventRecord["outcome"]>;
  feedbackId: string;
  recallEventId: string;
  updatedAt: string;
}): MemoryRow {
  const current = isRecord(memory.properties.internal_info.recall)
    ? memory.properties.internal_info.recall
    : {};
  const positive = numberOr(current.positive, 0) + (input.outcome === "positive" ? 1 : 0);
  const negative = numberOr(current.negative, 0) + (input.outcome === "negative" ? 1 : 0);
  const ignored = numberOr(current.ignored, 0) + (input.outcome === "ignored" ? 1 : 0);
  const total = positive + negative + ignored;
  const effectiveness = total > 0 ? (positive - negative) / total : 0;
  return {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        recall: {
          ...current,
          positive,
          negative,
          ignored,
          total,
          effectiveness,
          last_outcome: input.outcome,
          last_feedback_id: input.feedbackId,
          last_recall_event_id: input.recallEventId,
          updated_at: input.updatedAt
        }
      }
    },
    updatedAt: input.updatedAt
  };
}

function isRepairCandidatePolicyForSkill(policy: PolicyMeta): boolean {
  return policy.evidencePolarity === "negative" &&
    policy.skillEligible === false &&
    policy.decisionGuidance.preference.some((item) => item.trim().length > 0);
}

function repairCandidateStrictTrial(policy: PolicyMeta): boolean {
  const internalPolicy = isRecord(policy.memory.properties.internal_info.policy)
    ? policy.memory.properties.internal_info.policy
    : {};
  const verifierMeta = isRecord(internalPolicy.verifier_meta)
    ? internalPolicy.verifier_meta
    : null;
  return Boolean(verifierMeta && (
    verifierMeta.passed !== undefined ||
    verifierMeta.total !== undefined ||
    verifierMeta.reward !== undefined ||
    verifierMeta.score !== undefined
  ));
}

function repairCandidateSkillName(policy: PolicyMeta, fix: string): string {
  const words = `${policy.title} ${fix}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && word !== "repair" && word !== "avoid")
    .slice(0, 5);
  const raw = ["repair", ...words].join("_").slice(0, 48).replace(/_+$/g, "");
  return raw && raw !== "repair" ? raw : `repair_${stableHash(policy.id).slice(0, 10)}`;
}

function renderRepairCandidateGuide(policy: PolicyMeta, fix: string): string {
  return [
    `# ${policy.title || "Repair candidate"}`,
    "Candidate fix distilled from a past failure on a similar task. Applying it here both solves the task and validates the fix.",
    "",
    policy.trigger ? "**When to use**" : "",
    policy.trigger,
    policy.trigger ? "" : "",
    "**Suggested fix**",
    fix,
    "",
    policy.decisionGuidance.antiPattern.length > 0 ? "**Avoid**" : "",
    ...policy.decisionGuidance.antiPattern.map((item) => `- ${item}`),
    policy.verification ? "" : "",
    policy.verification ? "**Verify**" : "",
    policy.verification
  ].filter((line) => typeof line === "string" && line.length > 0).join("\n");
}

function recallOutcomeFromFeedback(feedback: FeedbackRequest): NonNullable<RecallEventRecord["outcome"]> {
  if (feedback.polarity === "positive") return "positive";
  if (feedback.polarity === "negative") return "negative";
  return "ignored";
}

export function polarityFromTurnFeedback(
  feedback: TurnFeedbackClassification
): FeedbackRequest["polarity"] {
  if (feedback.polarity === "positive") return "positive";
  if (feedback.polarity === "negative") return "negative";
  return "neutral";
}

function repairIssueFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  if (classification.shape === "correction" && classification.correction) {
    return `Correction requested: ${clip(classification.correction, 180)}`;
  }
  if (classification.shape === "preference" && classification.avoid) {
    return `Avoided approach: ${clip(classification.avoid, 180)}`;
  }
  if (classification.shape === "constraint" && classification.constraint) {
    return `Missing constraint: ${clip(classification.constraint, 180)}`;
  }
  return clip(request.rationale ?? classification.text, 220) || "negative feedback";
}

function repairSuggestionFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  const target = classification.prefer ?? classification.correction ?? classification.constraint;
  if (target) return `Prefer: ${clip(target, 200)}`;
  return clip(request.rationale ?? classification.text, 220) || "Prefer the path that avoids the reported issue.";
}

function repairPreferenceFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  const target = classification.prefer ?? classification.correction ?? classification.constraint;
  if (target) return `Prefer: ${clip(target, 200)}`;
  return `Prefer: ${clip(request.rationale ?? classification.text, 200) || "use a corrected approach next time"}`;
}

function repairAntiPatternFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  const target = classification.avoid ?? (
    classification.shape === "negative" ? (request.rationale ?? classification.text) : undefined
  );
  if (target) return `Avoid: ${clip(target, 200)}`;
  return "Avoid: repeating the same approach after negative feedback.";
}

function cleanFeedbackText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^["'`]|["'`]$/g, "").trim() || undefined;
}

export const DECISION_REPAIR_OPERATION = `${DECISION_REPAIR_PROMPT.id}.v${DECISION_REPAIR_PROMPT.version}`;

const DECISION_REPAIR_SYSTEM_PROMPT = `${DECISION_REPAIR_PROMPT.system}

Service extension:
- USER_FEEDBACK may be provided when the repair is triggered by explicit user
  correction, preference, or constraint feedback instead of a pure retry loop.
- In that case, CURRENT_CONTEXT describes what the agent is trying to fix now,
  and FAILURE_HISTORY may contain low-value traces or the feedback text itself.
- Ground guidance in USER_FEEDBACK, FAILURE_HISTORY, or SIMILAR_SUCCESS.
- If SIMILAR_SUCCESS is empty, use severity="info" and confidence <= 0.5 unless
  the user feedback is a direct correction.`;

export function decisionRepairPromptMessages(
  input: DecisionRepairSynthesisRequest
): Array<{ role: "system" | "user"; content: string }> {
  const high = input.highValue
    .map((memory) => decisionRepairTraceBlock(memory, input.traceCharCap))
    .filter(Boolean)
    .join("\n---\n");
  const low = input.lowValue
    .map((memory) => decisionRepairTraceBlock(memory, input.traceCharCap))
    .filter(Boolean)
    .join("\n---\n");
  const contextHead = [
    `TRIGGER: ${input.trigger}`,
    `CONTEXT_HASH: ${input.contextHash}`,
    `FEEDBACK_SHAPE: ${input.classification.shape}`,
    input.classification.prefer ? `USER_PREFERS: ${input.classification.prefer}` : "",
    input.classification.avoid ? `USER_AVOIDS: ${input.classification.avoid}` : "",
    input.classification.correction ? `USER_CORRECTION: ${input.classification.correction}` : "",
    input.classification.constraint ? `USER_CONSTRAINT: ${input.classification.constraint}` : ""
  ].filter(Boolean).join("\n");
  const userContent = [
    "CURRENT_CONTEXT:",
    contextHead,
    "",
    `USER_FEEDBACK:\n${clip(input.feedbackText, 800) || "(none)"}`,
    "",
    "FAILURE_HISTORY:",
    low || "(none)",
    "",
    "SIMILAR_SUCCESS:",
    high || "(none)",
    "",
    "Return the JSON object described in the system prompt."
  ].join("\n");
  return [
    { role: "system", content: DECISION_REPAIR_SYSTEM_PROMPT },
    { role: "user", content: userContent }
  ];
}

export async function synthesizeDecisionRepairDraft(
  input: DecisionRepairSynthesisRequest,
  options: { useLlm: boolean; llm: LlmClient }
): Promise<DecisionRepairLlmDraft | undefined> {
  if (!options.useLlm || !options.llm.isConfigured()) return undefined;
  const messages = decisionRepairPromptMessages(input);
  try {
    const result = await options.llm.completeJson<{
      preference?: unknown;
      anti_pattern?: unknown;
      severity?: unknown;
      confidence?: unknown;
    }>(messages, {
      operation: DECISION_REPAIR_OPERATION,
      thinkingMode: "enabled",
      temperature: options.llm.config.temperature,
      maxTokens: 800
    });
    return normalizeDecisionRepairLlmDraft(result);
  } catch (error) {
    pipelineLogger.warn("fallback.used", {
      operation: DECISION_REPAIR_OPERATION,
      pipeline: input.diagnostics?.pipeline ?? decisionRepairPipelineForTrigger(input.trigger),
      fallback: "no_llm_draft",
      feedbackId: input.diagnostics?.feedbackId,
      sourceMemoryId: input.diagnostics?.sourceMemoryId,
      ...memoryErrorFields(error)
    });
    return undefined;
  }
}

function decisionRepairPipelineForTrigger(trigger: string): string {
  if (trigger === "failure-burst") return "decision_repair.failure_burst";
  if (trigger === "value-distribution") return "decision_repair.value_distribution";
  return "decision_repair.feedback";
}

function decisionRepairTraceBlock(source: DecisionRepairTraceSource, charCap: number): string {
  const { memory, rawTurn } = source;
  const trace = traceMetaFromMemoryWithRaw(memory, rawTurn);
  if (!trace) return "";
  return [
    `trace ${memory.id}`,
    `value: ${roundNumber(trace.value)}`,
    trace.userText ? `user: ${tailClip(trace.userText, charCap)}` : "",
    trace.agentText ? `agent: ${tailClip(trace.agentText, charCap)}` : "",
    trace.reflection ? `reflection: ${tailClip(trace.reflection, charCap)}` : ""
  ].filter(Boolean).join("\n");
}

export function normalizeDecisionRepairLlmDraft(value: {
  preference?: unknown;
  anti_pattern?: unknown;
  severity?: unknown;
  confidence?: unknown;
}): DecisionRepairLlmDraft | undefined {
  const preference = typeof value.preference === "string" ? value.preference.trim() : "";
  const antiPattern = typeof value.anti_pattern === "string" ? value.anti_pattern.trim() : "";
  if (!preference && !antiPattern) return undefined;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? clampNumber(value.confidence, 0, 1)
    : 0.5;
  return {
    preference: clip(preference || "Prefer the path that avoids the reported issue.", 360),
    antiPattern: clip(antiPattern || "Avoid repeating the reported failing approach.", 360),
    severity: value.severity === "warn" ? "warn" : "info",
    confidence
  };
}

const FAILURE_EXPERIENCE_SINK_PROMPT = {
  id: "failure.experience.sink",
  version: 5,
  system: `You induce a candidate policy from an episode where the task was not finished satisfactorily.

Goal:
- Extract one reusable policy that helps a similar task reach a satisfactory finish.
- Make it operational: trigger + procedure + verification. Prefer practical guidance (priorities, sequencing, closure checks) over abstract commentary.
- Use corrective_signals to see what the goal still needed; use phase_chunks and episode_timeline for context.

Input:
- task_context.user_goal: task framing and requirements (may be truncated).
- phase_chunks: recent traces (conversation + limited tool output snippets).
- episode_timeline.turns: ordered user turns with timing.
- corrective_signals: feedback with turn_index and timing relative to turns.

Evidence:
1) Ground only in the fields above. Do not invent tests, files, errors, or violations.
2) task_context states requirements; it does not by itself show what went wrong in the attempt.
3) Tie each claim to a quotable phenomenon (e.g. external judgment still open, requested substance missing, timeout without deliverable, feedback naming an unmet acceptance criterion).
4) If evidence is thin, keep the policy narrow and note limits in boundary.
5) Source-specific entities are not reusable guidance by default: names, locations, product names, file names, one-off requested targets, and one task's acceptance details must be abstracted into categories or variables.
6) Preserve an entity only when the input explicitly marks it as a structured stable fact, such as a user profile fact, workspace/project fact, long-term preference memory, or stable-fact annotation.
7) Current episode text, tool output, verifier feedback, or a one-time task requirement are not enough evidence to call an entity long-term. Do not infer long-term preference from them.
8) Do not put source-specific entities into title, trigger, procedure, verification, boundary, or decision_guidance unless the structured stable source is present.

Guidance:
9) prefer: habits that advance completion (may be empty).
10) avoid: habits that leave the goal unmet--outcome/behavior gaps only. Do not name tools or channels; do not use "do not use / never call" style lines.
11) procedure and verification must be checkable from visible outcomes or judgments in the input.
12) verification: how to tell the task is done or accepted.

Types:
13) "failure_avoidance" when feedback shows the goal stayed open and you mainly generalize what to stop doing before ending.
14) "repair_instruction" when you can give a repeatable completion pattern (what to finish or confirm before done).

Other:
15) trigger: task-level, recognizable when a similar task starts or nears closure.
16) support_trace_ids: only traces you actually used.

Return JSON:
{
  "title": "short title",
  "trigger": "state condition",
  "procedure": "step-by-step guidance",
  "verification": "how to verify completion",
  "boundary": "scope/limits",
  "experience_type": "repair_instruction | failure_avoidance",
  "decision_guidance": {
    "prefer": ["..."],
    "avoid": ["..."]
  },
  "support_trace_ids": ["tr_..."]
}`
} as const;

const FEEDBACK_REFINEMENT_SYSTEM_PROMPT = `You extract actionable guidance from user feedback.

Given a user's feedback on an agent's response, produce a procedural policy
that helps the agent avoid the same mistake (or replicate the same success)
in future similar tasks.

CRITICAL REQUIREMENTS:

1. TRIGGER must be SPECIFIC and CONCRETE:
   - BAD: "When a similar task appears" (what is similar?)
   - GOOD: "When the user asks to implement bubble sort"
   Extract the concrete task type, domain, or feature from the episode context.

2. PROCEDURE must be ACTIONABLE and CONCISE:
   - BAD: "adjust according to feedback"
   - GOOD: "Implement descending order by using > in the comparison"
   Specify concrete steps the agent should take.

3. CAVEATS must provide SPECIFIC ANTI-PATTERNS:
   - BAD: "avoid repeating the current mistake"
   - GOOD: "Do not assume the default sort direction is ascending"
   Return [] if no concrete anti-pattern can be extracted.

4. VERIFICATION is OPTIONAL:
   - BAD: "check whether the issue is solved"
   - GOOD: "Check the comparison operator direction (< vs >)"
   Return "" if no concrete, checkable verification method exists.

Focus on TRIGGER + PROCEDURE. Caveats and verification are optional - only
fill them when there is specific content.

Return JSON:
{
  "title": "short imperative title",
  "trigger": "SPECIFIC task type/domain/feature (not 'similar task')",
  "procedure": "CONCRETE actionable steps (not 'adjust according to feedback')",
  "caveats": ["SPECIFIC anti-patterns"] or [],
  "verification": "CHECKABLE verification method" or "",
  "confidence": number in [0, 1]
}`;

const NEGATIVE_FEEDBACK_REFINEMENT_EXAMPLES = `Extract guidance to AVOID this mistake.

CRITICAL: Be SPECIFIC and CONCISE.
- Identify the concrete task type, e.g. "bubble sort implementation", not "similar task".
- Extract the specific requirement, e.g. "descending order", not "adjust according to feedback".
- Only fill caveats/verification if you have specific content.

Example 1:
Turn 1:
User: "写个冒泡排序"
Agent: [generates ascending sort code]

Turn 2:
User: "写的不对，我要的是从大到小的"

Output:
{
  "title": "Bubble sort: descending order",
  "trigger": "When the user asks to implement bubble sort.",
  "procedure": "Implement descending order by using > in the comparison.",
  "caveats": [],
  "verification": "",
  "confidence": 0.85
}

Example 2:
Turn 1:
User: "Write a function to filter even numbers from an array."
Agent: [generates filter with wrong boolean logic]

Turn 2:
User: "Wrong, it should use AND conditions, not OR."

Output:
{
  "title": "Confirm filter condition operators",
  "trigger": "When the user asks to filter or select data.",
  "procedure": "Before generating code, confirm whether multiple filter conditions should use AND or OR.",
  "caveats": ["Do not assume multiple conditions use OR by default."],
  "verification": "Check that the generated code uses the requested logical operator.",
  "confidence": 0.9
}

BAD Example:
{
  "title": "Fix user feedback",
  "trigger": "When a similar task appears",
  "procedure": "Adjust according to feedback",
  "caveats": ["Avoid repeating the current mistake"],
  "verification": "Check whether the issue is solved",
  "confidence": 0.5
}`;

const POSITIVE_FEEDBACK_REFINEMENT_EXAMPLES = `Extract guidance to REPLICATE this success.

CRITICAL: Be SPECIFIC and CONCISE.
- Identify the concrete task type.
- Extract the specific success pattern.
- Only fill caveats/verification if you have specific content.

Example:
Turn 1:
User: "写个快速排序"
Agent: [generates quicksort with three-way partitioning]

Turn 2:
User: "很好，这个实现很高效"

Output:
{
  "title": "Quicksort: use three-way partitioning",
  "trigger": "When the user asks to implement quicksort.",
  "procedure": "Use three-way partitioning for duplicate elements and choose a median or random pivot.",
  "caveats": ["Avoid always choosing the first element as pivot because sorted arrays degrade to O(n^2)."],
  "verification": "Check that the code partitions into less-than, equal-to, and greater-than groups.",
  "confidence": 0.85
}`;

function feedbackExperienceText(feedback: FeedbackRecord): string {
  return dedupeTextLines([
    feedback.rationale,
    feedbackRawText(feedback.rawPayload)
  ]).join("\n").trim();
}

function feedbackPolarityForRefinement(
  feedback: FeedbackRecord,
  draft: FeedbackExperienceDraft
): "positive" | "negative" | "neutral" {
  if (feedback.polarity === "positive" || draft.polarity === "positive") return "positive";
  if (feedback.polarity === "negative" || draft.polarity === "negative") return "negative";
  return "neutral";
}

function feedbackRefinementUserPrompt(input: {
  feedbackText: string;
  polarity: "positive" | "negative" | "neutral";
  userRequest: string;
  agentResponse: string;
  episodeContext: string;
}): string {
  const isNegative = input.polarity === "negative";
  const context = input.episodeContext
    ? `EPISODE CONTEXT (first turn + last 3 turns):\n${input.episodeContext}`
    : [
        `USER REQUEST:\n${clip(input.userRequest, 500)}`,
        `AGENT RESPONSE:\n${clip(input.agentResponse, 800)}`
      ].join("\n\n");
  return [
    context,
    `USER FEEDBACK (${input.polarity}):\n${input.feedbackText}`,
    isNegative ? NEGATIVE_FEEDBACK_REFINEMENT_EXAMPLES : POSITIVE_FEEDBACK_REFINEMENT_EXAMPLES,
    "Output JSON only."
  ].join("\n\n");
}

function failureExperienceSinkUserPrompt(input: {
  feedbackText: string;
  userRequest: string;
  agentResponse: string;
  episodeContext: string;
}): string {
  const timeline = input.episodeContext
    .split(/\n\s*\n/)
    .map((text, index) => ({
      turn_index: index + 1,
      text: clip(text, 700)
    }))
    .filter((turn) => turn.text.length > 0);
  return stableStringify({
    task_context: {
      user_goal: clip(input.userRequest || input.episodeContext || "unknown task", 800)
    },
    phase_chunks: [
      {
        id: "recent_episode_context",
        text: clip(input.episodeContext || [
          `User: ${input.userRequest}`,
          `Agent: ${input.agentResponse}`
        ].join("\n"), 2400)
      }
    ],
    episode_timeline: {
      turns: timeline
    },
    corrective_signals: [
      {
        turn_index: timeline.length || null,
        timing: "after_attempt",
        text: clip(input.feedbackText, 1000)
      }
    ]
  });
}

function applyFeedbackRefinement(
  draft: FeedbackExperienceDraft,
  refinement: {
    title: string;
    trigger: string;
    procedure: string;
    verification: string;
    caveats: string[];
    confidence: number;
    method: "llm" | "rule";
  }
): FeedbackExperienceDraft {
  const prefix = feedbackExperiencePrefix(draft.type);
  const refinedTitle = cleanFeedbackText(refinement.title);
  const title = refinedTitle
    ? `${prefix}: ${stripFeedbackRefinementPrefix(refinedTitle, prefix)}`
    : draft.title;
  const trigger = cleanFeedbackText(refinement.trigger) ?? draft.trigger;
  const procedure = cleanFeedbackText(refinement.procedure) ?? draft.procedure;
  const verification = typeof refinement.verification === "string" && refinement.verification.trim()
    ? refinement.verification.trim()
    : draft.verification;
  const caveats = dedupeTextLines(refinement.caveats.map((item) => clip(item, 360)));
  const decisionGuidance = {
    preference: dedupeTextLines([
      ...draft.decisionGuidance.preference,
      draft.type === "success_pattern" || draft.type === "repair_validated" ? procedure : undefined
    ]),
    antiPattern: dedupeTextLines([
      ...draft.decisionGuidance.antiPattern,
      ...caveats
    ])
  };
  return {
    ...draft,
    title,
    trigger,
    procedure,
    verification,
    decisionGuidance,
    confidence: clampNumber(Math.max(draft.confidence, refinement.confidence), 0, 1),
    vectorText: [title, trigger, procedure, verification, draft.boundary].join("\n"),
    tags: uniq([...draft.tags, `feedback-${refinement.method}-refined`]).slice(0, 12)
  };
}

function applyFailureExperienceSink(
  draft: FeedbackExperienceDraft,
  sink: {
    title?: unknown;
    trigger?: unknown;
    procedure?: unknown;
    verification?: unknown;
    boundary?: unknown;
    experience_type?: unknown;
    decision_guidance?: unknown;
    support_trace_ids?: unknown;
  }
): FeedbackExperienceDraft {
  const guidance = isRecord(sink.decision_guidance) ? sink.decision_guidance : {};
  const title = cleanFeedbackText(stringOr(sink.title, "")) ?? draft.title;
  const trigger = cleanFeedbackText(stringOr(sink.trigger, "")) ?? draft.trigger;
  const procedure = cleanFeedbackText(stringOr(sink.procedure, "")) ?? draft.procedure;
  const verification = cleanFeedbackText(stringOr(sink.verification, "")) ?? draft.verification;
  const boundary = cleanFeedbackText(stringOr(sink.boundary, "")) ?? draft.boundary;
  const experienceType = sink.experience_type === "failure_avoidance"
    ? "failure_avoidance"
    : sink.experience_type === "repair_instruction"
      ? "repair_instruction"
      : draft.type === "failure_avoidance"
        ? "failure_avoidance"
        : "repair_instruction";
  const supportTraceIds = stringArray(sink.support_trace_ids);
  const decisionGuidance = {
    preference: dedupeTextLines([
      ...draft.decisionGuidance.preference,
      ...stringArray(guidance.prefer),
      ...stringArray(guidance.preference)
    ]),
    antiPattern: dedupeTextLines([
      ...draft.decisionGuidance.antiPattern,
      ...stringArray(guidance.avoid),
      ...stringArray(guidance.anti_pattern),
      ...stringArray(guidance.antiPattern)
    ])
  };
  return {
    ...draft,
    type: experienceType,
    title,
    trigger,
    procedure,
    verification,
    boundary,
    decisionGuidance,
    sourceTraceIds: supportTraceIds.length > 0
      ? uniq([...draft.sourceTraceIds, ...supportTraceIds]).slice(0, 20)
      : draft.sourceTraceIds,
    vectorText: [title, trigger, procedure, verification, boundary].join("\n"),
    tags: uniq([...draft.tags, "feedback-failure-sink-refined"]).slice(0, 12)
  };
}

function stripFeedbackRefinementPrefix(title: string, prefix: string): string {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*[:：-]\\s*`, "i");
  return title.replace(pattern, "").trim() || title;
}

function refineFeedbackExperienceByRules(input: {
  feedbackText: string;
  polarity: "positive" | "negative" | "neutral";
  userRequest: string;
  episodeContext: string;
}): {
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  caveats: string[];
  confidence: number;
  method: "rule";
} {
  const text = input.feedbackText.trim();
  const lower = text.toLowerCase();
  const task = feedbackTaskContext(input.userRequest, input.episodeContext);

  const preferZh = text.match(/用\s*(.+?)\s*(代替|而不是)\s*(.+?)([。!?\n]|$)/i);
  const preferEn = preferZh ? null : text.match(/use\s+(.+?)\s+instead\s+of\s+(.+?)([.!?\n]|$)/i);
  if (preferZh || preferEn) {
    const preferred = cleanFeedbackText(preferZh?.[1] ?? preferEn?.[1]) ?? "";
    const avoided = cleanFeedbackText(preferZh?.[3] ?? preferEn?.[2]) ?? "";
    return {
      title: preferred ? `Use ${firstFeedbackSentence(preferred, 60)}` : firstFeedbackSentence(text, 80),
      trigger: task.trigger || "When choosing an implementation approach.",
      procedure: preferred && avoided ? `Use ${preferred} instead of ${avoided}.` : text,
      caveats: avoided ? [`Avoid using ${avoided}.`] : [],
      verification: preferred ? `Check that the answer uses ${firstFeedbackSentence(preferred, 80)}.` : "",
      confidence: 0.75,
      method: "rule"
    };
  }

  const should = text.match(/(?:应该|should)\s+(.+?)([。!?\n]|$)/i);
  if (should) {
    const action = cleanFeedbackText(should[1]) ?? text;
    return {
      title: firstFeedbackSentence(action, 80),
      trigger: task.trigger || "When handling the related task.",
      procedure: action,
      caveats: input.polarity === "negative" ? [`Avoid ignoring this requirement: ${action}`] : [],
      verification: `Check that the answer applies: ${firstFeedbackSentence(action, 80)}.`,
      confidence: 0.65,
      method: "rule"
    };
  }

  const avoid = text.match(/(?:不要|别|avoid|don't|do not)\s+(.+?)([。!?\n]|$)/i);
  if (avoid) {
    const antiPattern = cleanFeedbackText(avoid[1]) ?? text;
    return {
      title: `Avoid ${firstFeedbackSentence(antiPattern, 60)}`,
      trigger: task.trigger || "When handling the related task.",
      procedure: `Check the plan and avoid: ${antiPattern}`,
      caveats: [antiPattern],
      verification: `Check that the answer avoids: ${firstFeedbackSentence(antiPattern, 80)}.`,
      confidence: 0.7,
      method: "rule"
    };
  }

  if (input.polarity === "negative") {
    return {
      title: firstFeedbackSentence(text, 80),
      trigger: task.trigger || task.taskType || "When handling the related task.",
      procedure: text,
      caveats: [],
      verification: "",
      confidence: 0.5,
      method: "rule"
    };
  }

  return {
    title: firstFeedbackSentence(text, 80),
    trigger: task.trigger || task.taskType || "When handling the related task.",
    procedure: `Continue using this approach: ${text}`,
    caveats: [],
    verification: "",
    confidence: 0.6,
    method: "rule"
  };
}

function feedbackTaskContext(
  userRequest: string,
  episodeContext: string
): { trigger: string; taskType: string } {
  const combined = `${userRequest} ${episodeContext}`.toLowerCase();
  const patterns: Array<{ pattern: RegExp; trigger: string; taskType: string }> = [
    { pattern: /(写|实现|生成|创建).{0,8}(排序|冒泡|快排|归并|选择|插入)/, trigger: "When the user asks to implement a sorting algorithm.", taskType: "sorting algorithm implementation" },
    { pattern: /(写|实现|生成|创建).{0,8}(搜索|查找|二分|遍历)/, trigger: "When the user asks to implement a search algorithm.", taskType: "search algorithm implementation" },
    { pattern: /(筛选|过滤|filter|select).{0,16}(数据|数组|列表|records|rows)/, trigger: "When the user asks to filter data.", taskType: "data filtering" },
    { pattern: /(读取|写入|操作).{0,8}(文件|file)/, trigger: "When the user asks for file operations.", taskType: "file operation" },
    { pattern: /(调用|请求|fetch).{0,8}(api|接口|服务)/, trigger: "When the user asks to call an API or service.", taskType: "API call" },
    { pattern: /(处理|解析|parse).{0,12}(json|xml|csv|数据|filing|document)/, trigger: "When the user asks to parse structured data or documents.", taskType: "structured data parsing" },
    { pattern: /(格式化|format|转换|convert)/, trigger: "When the user asks to format or convert data.", taskType: "data formatting" },
    { pattern: /(sec|13f|cusip|issuer|holding)/, trigger: "When the user asks to parse SEC 13F holdings or issuer/CUSIP data.", taskType: "SEC 13F parsing" }
  ];
  for (const item of patterns) {
    if (item.pattern.test(combined)) {
      return { trigger: item.trigger, taskType: item.taskType };
    }
  }
  const verbNoun = combined.match(/\b(write|implement|create|parse|process|convert|filter)\s+(.{2,40}?)(?:\.|\n|$)/i);
  if (verbNoun?.[1] && verbNoun[2]) {
    const task = clip(verbNoun[2].trim(), 80);
    return {
      trigger: `When the user asks to ${verbNoun[1]} ${task}.`,
      taskType: `${verbNoun[1]} ${task}`
    };
  }
  return { trigger: "", taskType: "" };
}

function feedbackRefinementSelectedTraces(traces: TraceMeta[]): TraceMeta[] {
  const selected: TraceMeta[] = [];
  const first = traces[0];
  if (first) selected.push(first);
  const start = Math.max(1, traces.length - 3);
  for (let index = start; index < traces.length; index += 1) {
    const trace = traces[index];
    if (trace && trace.id !== first?.id) selected.push(trace);
  }
  return selected;
}

function feedbackRefinementTurnBlock(turnNumber: number, trace: TraceMeta): string {
  return [
    `Turn ${turnNumber}:`,
    `User: ${clip(trace.userText, 400)}`,
    `Agent: ${clip(trace.agentText, 600)}`
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function feedbackExperienceSignificance(
  feedback: FeedbackRecord,
  classification: FeedbackTextClassification,
  episode: EpisodeRecord | undefined
): number {
  const reward = isRecord(episode?.meta.reward) && typeof episode.meta.reward.rHuman === "number"
    ? Math.abs(episode.meta.reward.rHuman)
    : 0;
  return clampNumber(Math.max(
    feedback.magnitude ?? 0,
    classification.confidence,
    feedbackVerifierScore(feedback.rawPayload),
    reward
  ), 0, 1);
}

function isActionableFeedbackExperience(text: string, shape: FeedbackTextShape): boolean {
  if (shape !== "unknown" && shape !== "confusion") return true;
  return /\b(next time|should|must|avoid|prefer|instead|do not|don't|pass|fail|failed|success|expected|actual)\b/i.test(text) ||
    /下次|应该|必须|不要|别|成功|失败|反例|期望|实际|改/.test(text);
}

function buildFeedbackExperienceDraft(input: {
  feedback: FeedbackRecord;
  text: string;
  classification: FeedbackTextClassification;
  significance: number;
  episode?: EpisodeRecord;
  trace: TraceMeta | null;
  traceMemory?: MemoryRow;
}): FeedbackExperienceDraft {
  const text = clip(input.text, 360);
  const lower = input.text.toLowerCase();
  const verifierMeta = extractFeedbackVerifierMeta(input.feedback.rawPayload, lower);
  const pass = isPositiveFeedbackExperience(input.feedback, lower, input.classification.shape, verifierMeta);
  const fail = isNegativeFeedbackExperience(input.feedback, lower, input.classification.shape, verifierMeta);
  const hasAvoid = /\b(avoid|do not|don't|never|stop|wrong|incorrect|failed|fail)\b/i.test(input.text) ||
    /不要|别|不能|错误|失败|反例/.test(input.text);
  let type: FeedbackExperienceType;
  let polarity: FeedbackEvidencePolarity;
  let skillEligible = false;
  if (pass) {
    type = "success_pattern";
    polarity = "positive";
    skillEligible = true;
  } else if (fail && hasAvoid) {
    type = "failure_avoidance";
    polarity = "negative";
  } else if (input.classification.shape === "preference") {
    type = "preference";
    polarity = fail ? "negative" : "neutral";
  } else if (hasAvoid) {
    type = "failure_avoidance";
    polarity = "negative";
  } else if (input.classification.shape === "correction" || input.classification.shape === "constraint" || fail) {
    type = "repair_instruction";
    polarity = fail ? "negative" : "neutral";
  } else if (verifierMeta) {
    type = "verifier_feedback";
    polarity = pass ? "positive" : fail ? "negative" : "neutral";
  } else {
    type = "repair_instruction";
    polarity = "neutral";
  }
  const prefix = feedbackExperiencePrefix(type);
  const traceContext = input.trace ? feedbackTraceHint(input.trace) : null;
  const title = `${prefix}: ${firstFeedbackSentence(text, Math.max(30, 120 - prefix.length - 2))}`;
  const trigger = [
    "When a future task is similar to the source episode or asks for comparable output.",
    input.trace?.userText ? `Source user request: ${clip(input.trace.userText, 220)}` : null
  ].filter(Boolean).join("\n");
  const procedure = [
    type === "failure_avoidance"
      ? `Avoid repeating this behavior: ${text}`
      : type === "repair_instruction"
      ? `When this feedback pattern appears, repair the answer by applying: ${text}`
      : type === "preference"
      ? `Prefer this behavior in similar tasks: ${text}`
      : `This was accepted as a useful approach: ${text}`,
    traceContext ? `Source turn context: ${traceContext}` : null
  ].filter(Boolean).join("\n");
  const verification = type === "success_pattern"
    ? "Before reusing, confirm the current task has the same success criteria as the feedback."
    : "Before answering, check the current plan against this avoid/repair instruction.";
  const boundary = [
    "Use only for similar task shape, evaluator expectation, or user preference.",
    input.episode?.id ? `Source episode: ${input.episode.id}` : null,
    input.feedback.id ? `Source feedback: ${input.feedback.id}` : null
  ].filter(Boolean).join("\n");
  const sourceTraceIds = feedbackExperienceTraceIds(input.feedback, input.episode, input.trace);
  const guidance = feedbackExperienceGuidance(type, input.classification, text);
  const confidence = clampNumber(Math.max(input.classification.confidence, input.significance), 0, 1);
  const salience = clampNumber(Math.max(input.feedback.magnitude ?? 0, input.significance), 0, 1);
  const tags = uniq([
    "policy",
    "feedback",
    type,
    polarity,
    ...(input.trace?.tags ?? []),
    ...(input.traceMemory?.tags ?? [])
  ]).slice(0, 12);
  return {
    type,
    polarity,
    title,
    trigger,
    procedure,
    verification,
    boundary,
    decisionGuidance: guidance,
    salience,
    confidence,
    skillEligible,
    verifierMeta,
    sourceEpisodeIds: input.feedback.episodeId ? [input.feedback.episodeId] : [],
    sourceTraceIds,
    sourceFeedbackIds: [input.feedback.id],
    vectorText: [title, trigger, procedure, verification, boundary].join("\n"),
    tags
  };
}

function renderFeedbackExperienceBody(draft: FeedbackExperienceDraft & {
  support?: number;
  gain?: number;
}): string {
  return [
    draft.title,
    `Trigger: ${draft.trigger}`,
    `Procedure: ${draft.procedure}`,
    `Verification: ${draft.verification}`,
    `Boundary: ${draft.boundary}`,
    `Experience: ${draft.type}`,
    `Evidence polarity: ${draft.polarity}`,
    `Support: ${draft.support ?? 1}`,
    `Gain: ${roundNumber(draft.gain ?? Math.max(0.02, draft.salience))}`,
    `Confidence: ${roundNumber(draft.confidence)}`,
    draft.decisionGuidance.preference.length
      ? `Preference: ${draft.decisionGuidance.preference.join(" | ")}`
      : undefined,
    draft.decisionGuidance.antiPattern.length
      ? `Anti-pattern: ${draft.decisionGuidance.antiPattern.join(" | ")}`
      : undefined,
    `Feedback: ${draft.sourceFeedbackIds.join(", ")}`,
    draft.sourceTraceIds.length ? `Evidence: ${draft.sourceTraceIds.join(", ")}` : undefined
  ].filter(Boolean).join("\n");
}

function feedbackExperienceGuidance(
  type: FeedbackExperienceType,
  classification: FeedbackTextClassification,
  text: string
): FeedbackExperienceDraft["decisionGuidance"] {
  const preference: string[] = [];
  const antiPattern: string[] = [];
  if (classification.shape === "preference") {
    if (classification.prefer) preference.push(clip(classification.prefer, 360));
    if (classification.avoid) antiPattern.push(clip(classification.avoid, 360));
  } else if (classification.shape === "correction" && classification.correction) {
    preference.push(clip(classification.correction, 360));
  } else if (classification.shape === "constraint" && classification.constraint) {
    preference.push(clip(classification.constraint, 360));
  }
  if (type === "failure_avoidance") antiPattern.push(text);
  if (type === "repair_instruction" || type === "success_pattern") preference.push(text);
  return {
    preference: dedupeTextLines(preference),
    antiPattern: dedupeTextLines(antiPattern)
  };
}

function policyDecisionGuidanceForStorage(guidance: FeedbackExperienceDraft["decisionGuidance"]): {
  preference: string[];
  anti_pattern: string[];
} {
  return {
    preference: guidance.preference,
    anti_pattern: guidance.antiPattern
  };
}

function feedbackExperienceTraceIds(
  feedback: FeedbackRecord,
  episode: EpisodeRecord | undefined,
  trace: TraceMeta | null
): string[] {
  return uniq([
    feedback.l1MemoryId,
    trace?.id,
    ...(episode?.l1MemoryIds ?? [])
  ].filter((id): id is string => typeof id === "string" && id.length > 0));
}

function feedbackExperiencePrefix(type: FeedbackExperienceType): string {
  if (type === "failure_avoidance") return "Avoid";
  if (type === "repair_instruction") return "Repair";
  if (type === "preference") return "Prefer";
  if (type === "verifier_feedback") return "Verifier";
  if (type === "repair_validated") return "Validated";
  return "Success";
}

function firstFeedbackSentence(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0] ?? normalized;
  return clip(sentence, maxChars);
}

function feedbackTraceHint(trace: TraceMeta): string {
  return [
    trace.summary ? `summary=${clip(trace.summary, 140)}` : null,
    trace.userText ? `user=${clip(trace.userText, 140)}` : null,
    trace.reflection ? `note=${clip(trace.reflection, 140)}` : null
  ].filter(Boolean).join(" | ");
}

function feedbackRawText(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (!isRecord(raw)) return String(raw);
  return dedupeTextLines([
    raw.feedback,
    raw.text,
    raw.message,
    raw.rationale,
    raw.reason,
    raw.verdict,
    raw.summary
  ].filter((item): item is string => typeof item === "string")).join("\n");
}

function extractFeedbackVerifierMeta(raw: unknown, lower: string): Record<string, unknown> | null {
  const looksVerifier = lower.includes("verifier") ||
    lower.includes("verification") ||
    lower.includes("counterexample") ||
    lower.includes("本任务评为反例");
  if (!looksVerifier && !isRecord(raw)) return null;
  const meta: Record<string, unknown> = { source: "feedback" };
  if (looksVerifier) meta.verifier = true;
  if (isRecord(raw)) {
    for (const key of ["verdict", "score", "reward", "passed", "taskId", "family", "reason"]) {
      if (raw[key] !== undefined) meta[key] = raw[key];
    }
  }
  return Object.keys(meta).length > 1 || looksVerifier ? meta : null;
}

function feedbackVerifierScore(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  for (const key of ["score", "reward", "r", "rating"]) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) return Math.min(1, Math.abs(value));
  }
  return 0;
}

function isPositiveFeedbackExperience(
  feedback: FeedbackRecord,
  lower: string,
  shape: FeedbackTextShape,
  verifier: Record<string, unknown> | null
): boolean {
  if (feedback.polarity === "positive") return true;
  if (shape === "positive") return true;
  if (verifier && lower.includes("pass")) return true;
  return /\b(success|succeeded|passed|task succeeded|works well|correct)\b/.test(lower) ||
    /成功|通过|正确|太好了|写得很好/.test(lower);
}

function isNegativeFeedbackExperience(
  feedback: FeedbackRecord,
  lower: string,
  shape: FeedbackTextShape,
  verifier: Record<string, unknown> | null
): boolean {
  if (feedback.polarity === "negative") return true;
  if (shape === "negative" || shape === "correction") return true;
  if (verifier && /\b(fail|failed|counterexample)\b/.test(lower)) return true;
  return /\b(fail|failed|wrong|incorrect|counterexample|not acceptable)\b/.test(lower) ||
    /失败|错误|不对|反例/.test(lower);
}

function mergeFeedbackPolarity(
  current: FeedbackEvidencePolarity,
  next: FeedbackEvidencePolarity
): FeedbackEvidencePolarity {
  if (current === next) return current;
  if (current === "mixed" || next === "mixed") return "mixed";
  if (current === "neutral") return next;
  if (next === "neutral") return current;
  return "mixed";
}

function dedupeTextLines(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const line = value.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function tailClip(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `...${cleaned.slice(Math.max(0, cleaned.length - max))}`;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function traceMetaFromMemoryWithRaw(memory: MemoryRow, rawTurn?: RawTurnRecord): TraceMeta | null {
  const trace = traceMetaFromMemory(memory);
  if (!trace || !rawTurn) return trace;

  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const rawSpan = isRecord(internalTrace.raw_span) ? internalTrace.raw_span : {};
  const hasUserSpan = rawSpan.user_text === true;
  const hasAgentSpan = rawSpan.agent_text === true;
  const isRedacted = Boolean(rawTurn.redactedAt || rawTurn.deletedAt);

  return {
    ...trace,
    toolCalls: isRedacted
      ? trace.toolCalls
      : rawTurn.toolCalls.filter(isToolCallPayload),
    userText: isRedacted
      ? (hasUserSpan ? "[REDACTED]" : trace.userText)
      : (trace.userText || (hasUserSpan ? rawTurn.userText ?? "" : "")),
    agentText: isRedacted
      ? (hasAgentSpan ? "[REDACTED]" : trace.agentText)
      : (trace.agentText || (hasAgentSpan ? rawTurn.assistantText ?? "" : ""))
  };
}

function rawTurnIdFromMemory(memory: MemoryRow): string | undefined {
  const sourceRawTurnId = memory.properties.internal_info.source_raw_turn_id;
  if (typeof sourceRawTurnId === "string" && sourceRawTurnId) return sourceRawTurnId;
  const rawTurnId = memory.properties.internal_info.raw_turn_id;
  if (typeof rawTurnId === "string" && rawTurnId) return rawTurnId;
  const trace = memory.properties.internal_info.trace;
  return isRecord(trace) ? stringFromRecord(trace, "raw_turn_id") : undefined;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isToolCallPayload(value: unknown): value is ToolCallPayload {
  return isRecord(value) && typeof value.name === "string";
}

function roundNumber(value: number, digits = 4): number {
  const base = Math.pow(10, digits);
  return Math.round(value * base) / base;
}

function namespaceIdFromMemory(memory: MemoryRow): string {
  return namespaceIdFromContext(namespaceForMemory(memory));
}

function namespaceIdFromContext(namespace: RuntimeNamespace): string {
  return [
    namespace.tenantId,
    namespace.userId,
    namespace.projectId ?? namespace.workspaceId,
    namespace.source,
    namespace.profileId
  ].filter(Boolean).join(":");
}

function memoryStatusForLifecycleStatus(status: "candidate" | "active" | "archived"): "activated" | "resolving" | "archived" {
  if (status === "archived") return "archived";
  return status === "candidate" ? "resolving" : "activated";
}
