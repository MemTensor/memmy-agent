import type { MemmyConfig } from "../../config/index.js";
import type {
  DecisionRepairRecord,
  EpisodeRecord,
  EvolutionJobRecord,
  FeedbackRecord,
  Repositories
} from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import type { LlmClient } from "../../model/types.js";
import { stableHash } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import {
  profileIdFromMemory,
  projectIdFromMemory
} from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { synthesizeFailureExperienceSink } from "../feedback/feedback-experience.js";

export type NegativeExperienceSource =
  | "episode_reward"
  | "negative_feedback"
  | "tool_failure_burst"
  | "value_distribution";

type NegativeExperienceSourceBasis =
  | "user_corrective_feedback"
  | "implicit_failure_analysis"
  | "tool_failure_burst"
  | "value_distribution_repair";

interface NegativeExperienceDraft {
  source: NegativeExperienceSource;
  sourceBasis: NegativeExperienceSourceBasis;
  sourceEventId: string;
  episode: EpisodeRecord;
  sourceMemory?: MemoryRow;
  feedback?: FeedbackRecord;
  repair?: DecisionRepairRecord;
  title: string;
  experienceType: "failure_avoidance" | "repair_instruction";
  trigger: string;
  antiPattern: string;
  preference: string;
  procedure: string;
  verification: string;
  boundary: string;
  sourceTraceIds: string[];
  confidence: number;
  salience: number;
  evidenceStrength: number;
}

export interface NegativeExperiencePipelineDeps {
  repos: Repositories;
  config: MemmyConfig;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertEvolutionMemory(memory: MemoryRow): {
    memory: MemoryRow;
    created: boolean;
    previous?: MemoryRow;
  };
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string;
  skillLlm: LlmClient;
}

export class NegativeExperiencePipeline {
  constructor(private readonly deps: NegativeExperiencePipelineDeps) {}

  async materialize(job: EvolutionJobRecord): Promise<void> {
    if (!this.deps.config.algorithm.negativeExperience.enabled) return;
    if (
      job.payload.source === "value_distribution"
      && !this.deps.config.algorithm.feedback.valueDistributionRepairEnabled
    ) return;
    const draft = await this.buildDraft(job);
    if (!draft || !isActionableNegativeExperience(draft)) return;

    const config = this.deps.config.algorithm.negativeExperience;
    const sourceTraceIds = draft.sourceTraceIds.slice(0, config.maxSourceIds);
    const signature = negativeExperienceSignature(draft);
    const scopeIdentity = [
      (draft.sourceMemory ? projectIdFromMemory(draft.sourceMemory) : undefined) ?? draft.episode.projectId ?? "",
      (draft.sourceMemory ? profileIdFromMemory(draft.sourceMemory) : undefined) ?? ""
    ].join(":");
    const key = `policy:avoid:${stableHash(`${scopeIdentity}:${signature}`).slice(0, 24)}`;
    const existing = this.findExisting(draft, key);
    const existingInternal: Record<string, unknown> = existing && isRecord(existing.properties.internal_info)
      ? existing.properties.internal_info
      : {};
    const existingPolicy = isRecord(existingInternal.policy) ? existingInternal.policy : {};
    const sourceEventIds = cappedDistinct(
      [...stringArray(existingInternal.source_event_ids), draft.sourceEventId],
      config.maxSourceIds
    );
    if (stringArray(existingInternal.source_event_ids).includes(draft.sourceEventId)) return;

    const mergedEpisodeIds = cappedDistinct(
      [...stringArray(existingPolicy.source_episode_ids), draft.episode.id],
      config.maxSourceIds
    );
    const mergedTraceIds = cappedDistinct(
      [...stringArray(existingPolicy.source_trace_ids), ...sourceTraceIds],
      config.maxSourceIds
    );
    const mergedFeedbackIds = cappedDistinct(
      [
        ...stringArray(existingPolicy.source_feedback_ids),
        ...(draft.feedback ? [draft.feedback.id] : [])
      ],
      config.maxSourceIds
    );
    const mergedRepairIds = cappedDistinct(
      [
        ...stringArray(existingInternal.source_repair_ids),
        ...(draft.repair ? [draft.repair.id] : [])
      ],
      config.maxSourceIds
    );
    const antiPatterns = cappedDistinct(
      [...decisionGuidance(existingPolicy, "anti_pattern"), draft.antiPattern],
      config.maxAntiPatterns
    );
    const preferences = cappedDistinct(
      [...decisionGuidance(existingPolicy, "preference"), draft.preference],
      config.maxPreferences
    );
    const support = Math.max(1, mergedEpisodeIds.length);
    const title = draft.title;
    const trigger = draft.trigger;
    const procedure = draft.procedure;
    const antiPattern = antiPatterns.join("\n");
    const body = renderNegativeExperienceBody({
      title,
      trigger,
      antiPattern,
      procedure,
      verification: draft.verification,
      boundary: draft.boundary,
      support,
      confidence: draft.confidence
    });
    const policy = {
      ...existingPolicy,
      title,
      trigger,
      procedure,
      verification: draft.verification,
      boundary: draft.boundary,
      support,
      gain: 0,
      raw_gain: 0,
      policy_confidence: draft.confidence,
      evidence_strength: draft.evidenceStrength,
      salience: draft.salience,
      status: "candidate",
      experience_type: draft.experienceType,
      evidence_polarity: "negative",
      source_cohort: "neg_episode",
      source_basis: draft.sourceBasis,
      is_caveat: true,
      skill_eligible: false,
      signature,
      source_episode_ids: mergedEpisodeIds,
      source_trace_ids: mergedTraceIds,
      source_feedback_ids: mergedFeedbackIds,
      decision_guidance: {
        preference: preferences,
        anti_pattern: antiPatterns
      },
      tags: cappedDistinct(
        [...stringArray(existingPolicy.tags), "policy", "avoidance", "failure"],
        config.maxSourceIds
      )
    };
    const memory = this.deps.buildMemory({
      userId: draft.episode.userId,
      sessionId: draft.episode.sessionId,
      conversationId: draft.episode.conversationId,
      projectId: (draft.sourceMemory ? projectIdFromMemory(draft.sourceMemory) : undefined)
        ?? draft.episode.projectId,
      profileId: draft.sourceMemory ? profileIdFromMemory(draft.sourceMemory) : undefined,
      layer: "L2",
      kind: "policy",
      lifecycleStatus: "candidate",
      memoryType: "LongTermMemory",
      key: existing?.memoryKey ?? key,
      value: body,
      tags: ["policy", "avoidance", "failure", "negative"],
      info: {
        signature,
        support,
        gain: 0,
        raw_gain: 0,
        policy_confidence: draft.confidence,
        evidence_strength: draft.evidenceStrength,
        status: "candidate",
        source_episode_ids: mergedEpisodeIds,
        source_trace_ids: mergedTraceIds,
        source_feedback_ids: mergedFeedbackIds,
        experience_type: draft.experienceType,
        evidence_polarity: "negative",
        source_basis: draft.sourceBasis,
        is_caveat: true
      },
      internal: {
        source: "worker.negative_experience.v1",
        plugin_algorithm: "negative_experience.v1",
        source_event_ids: sourceEventIds,
        source_episode_ids: mergedEpisodeIds,
        source_trace_ids: mergedTraceIds,
        source_feedback_ids: mergedFeedbackIds,
        source_repair_ids: mergedRepairIds,
        negative_experience_sources: cappedDistinct(
          [...stringArray(existingInternal.negative_experience_sources), draft.source],
          config.maxSourceIds
        ),
        policy
      },
      createdAt: job.createdAt
    });
    const upsert = this.deps.upsertEvolutionMemory(memory);
    this.deps.repos.runtime.appendEpisodeDerivedMemory(
      draft.episode.id,
      "L2",
      upsert.memory.id,
      job.createdAt
    );
    this.deps.repos.runtime.appendChange({
      memoryId: upsert.memory.id,
      namespaceId: this.deps.namespaceIdFromMemory(upsert.memory),
      kind: "policy",
      op: upsert.created ? "created" : "updated",
      entityId: upsert.memory.id,
      userId: upsert.memory.userId,
      changeType: upsert.created ? "negative_experience_created" : "negative_experience_updated",
      before: upsert.previous,
      after: upsert.memory,
      source: "worker.negative_experience.v1",
      createdAt: job.createdAt
    });
    if (this.deps.config.algorithm.capture.embedAfterCapture) {
      this.deps.enqueueJob({
        jobType: "embedding",
        userId: upsert.memory.userId,
        sessionId: upsert.memory.sessionId,
        episodeId: draft.episode.id,
        targetMemoryId: upsert.memory.id,
        payload: {
          reason: "negative_experience",
          contentHash: upsert.memory.contentHash
        },
        createdAt: job.createdAt
      });
    }
  }

  private async buildDraft(job: EvolutionJobRecord): Promise<NegativeExperienceDraft | undefined> {
    const source = negativeExperienceSource(job.payload.source);
    const sourceEventId = text(job.payload.sourceEventId) ?? job.id;
    const episode = job.episodeId
      ? this.deps.repos.runtime.getEpisode(job.episodeId)
      : undefined;
    if (!source || !episode || episode.userId !== job.userId) return undefined;

    const feedbackId = text(job.payload.feedbackId);
    const repairId = text(job.payload.repairId);
    const feedback = feedbackId ? this.deps.repos.runtime.getFeedback(feedbackId) : undefined;
    const repair = repairId ? this.deps.repos.runtime.getDecisionRepair(repairId) : undefined;
    const sourceMemory = feedback?.l1MemoryId
      ? this.deps.repos.memories.get(feedback.l1MemoryId)
      : [...episode.l1MemoryIds].reverse()
          .map((id) => this.deps.repos.memories.get(id))
          .find((memory): memory is MemoryRow => Boolean(memory));
    const rawTurns = this.deps.repos.runtime.listRawTurnsByEpisode(episode.id);
    const rewardReason = text(job.payload.rewardReason)
      ?? text(episode.rewardDetail.reason)
      ?? text(isRecord(episode.meta.reward) ? episode.meta.reward.reason : undefined);
    const issue = text(job.payload.issue) ?? repair?.issue;
    const feedbackText = [
      feedback?.rationale,
      issue,
      rewardReason,
      repair?.preference,
      repair?.antiPattern
    ].map(text).filter(Boolean).join("\n");
    const episodeTraceIds = episode.l1MemoryIds
      .map((id) => this.deps.repos.memories.get(id))
      .filter((memory): memory is MemoryRow => Boolean(memory))
      .map((memory) => memory.id);
    const episodeContext = rawTurns
      .map((turn, index) => [
        `TURN ${index + 1}`,
        turn.userText ? `User: ${clip(turn.userText, 700)}` : "",
        turn.assistantText ? `Agent: ${clip(turn.assistantText, 900)}` : ""
      ].filter(Boolean).join("\n"))
      .join("\n\n");
    const sink = await synthesizeFailureExperienceSink({
      feedbackText,
      userRequest: rawTurns.find((turn) => Boolean(text(turn.userText)))?.userText?.trim() ?? "",
      agentResponse: rawTurns.at(-1)?.assistantText?.trim() ?? "",
      episodeContext,
      allowedTraceIds: episodeTraceIds
    }, { llm: this.deps.skillLlm });
    if (!sink) return undefined;
    const antiPattern = sink.avoid.join("\n");
    const preference = sink.prefer.join("\n");
    const sourceBasis = sourceBasisFor(source, feedback);
    const confidenceCap = sourceBasis === "implicit_failure_analysis"
      ? this.deps.config.algorithm.negativeExperience.implicitConfidenceCap
      : 1;
    return {
      source,
      sourceBasis,
      sourceEventId,
      episode,
      sourceMemory,
      feedback,
      repair,
      title: sink.title,
      experienceType: sink.experienceType,
      trigger: sink.trigger,
      antiPattern,
      preference,
      procedure: sink.procedure,
      verification: sink.verification,
      boundary: sink.boundary,
      sourceTraceIds: sink.supportTraceIds,
      confidence: clamp(sink.confidence, 0, confidenceCap),
      salience: clamp(Math.max(
        typeof episode.rTask === "number" ? Math.abs(episode.rTask) : 0,
        feedback?.magnitude ?? 0,
        number(repair?.meta.confidence) ?? 0
      ), 0, 1),
      evidenceStrength: clamp(feedback?.magnitude ?? Math.abs(episode.rTask ?? 0), 0, 1)
    };
  }

  private findExisting(draft: NegativeExperienceDraft, key: string): MemoryRow | undefined {
    void draft;
    return this.deps.repos.memories.getByKey("L2", key);
  }
}

function negativeExperienceSource(value: unknown): NegativeExperienceSource | undefined {
  return value === "episode_reward"
    || value === "negative_feedback"
    || value === "tool_failure_burst"
    || value === "value_distribution"
    ? value
    : undefined;
}

function sourceBasisFor(
  source: NegativeExperienceSource,
  feedback?: FeedbackRecord
): NegativeExperienceSourceBasis {
  if (source === "tool_failure_burst") return "tool_failure_burst";
  if (source === "value_distribution") return "value_distribution_repair";
  if (source === "negative_feedback" && feedback?.channel === "explicit") {
    return "user_corrective_feedback";
  }
  return "implicit_failure_analysis";
}

function isActionableNegativeExperience(draft: NegativeExperienceDraft): boolean {
  if (!draft.trigger.trim() || !draft.antiPattern.trim() || !draft.preference.trim()) return false;
  const minConfidence = draft.sourceBasis === "tool_failure_burst" ? 0.4 : 0.6;
  if (draft.confidence < minConfidence) return false;
  if (normalizeSignatureText(draft.antiPattern) === normalizeSignatureText(draft.preference)) return false;
  return !(
    isGenericNegativeGuidance(draft.antiPattern)
    && isGenericNegativeGuidance(draft.preference)
  );
}

function isGenericNegativeGuidance(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/^(?:avoid|prefer|safer behavior)\s*:\s*/i, "")
    .replace(/[。.!！]+$/g, "")
    .trim();
  return [
    "be careful",
    "verify more",
    "avoid assumptions",
    "listen to the user",
    "do better",
    "小心一点",
    "多验证",
    "避免假设",
    "下次做得更好"
  ].includes(normalized);
}

function negativeExperienceSignature(draft: NegativeExperienceDraft): string {
  const normalized = [
    normalizeSignatureText(draft.trigger),
    normalizeSignatureText(draft.antiPattern),
    normalizeSignatureText(draft.preference)
  ].join("\n");
  return `avoid:${stableHash(normalized).slice(0, 24)}`;
}

function renderNegativeExperienceBody(input: {
  title: string;
  trigger: string;
  antiPattern: string;
  procedure: string;
  verification: string;
  boundary: string;
  support: number;
  confidence: number;
}): string {
  return [
    input.title,
    `Trigger: ${input.trigger}`,
    `Avoid: ${input.antiPattern}`,
    `Safer behavior: ${input.procedure}`,
    `Verification: ${input.verification}`,
    `Boundary: ${input.boundary}`,
    `Support: ${input.support}`,
    "Gain: 0",
    "Raw gain: 0",
    `Confidence: ${input.confidence}`
  ].join("\n");
}

function decisionGuidance(policy: Record<string, unknown>, key: "preference" | "anti_pattern"): string[] {
  const guidance = isRecord(policy.decision_guidance) ? policy.decision_guidance : {};
  return stringArray(guidance[key]);
}

function normalizeSignatureText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function cappedDistinct(values: string[], limit: number): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .slice(0, Math.max(0, Math.floor(limit)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
