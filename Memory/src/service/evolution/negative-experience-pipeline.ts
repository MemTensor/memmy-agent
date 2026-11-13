import { createHash } from "node:crypto";
import type { MemmyConfig } from "../../config/index.js";
import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import { createMemoryLogger } from "../../logging/logger.js";
import type {
  DecisionRepairRecord,
  EpisodeRecord,
  EvolutionJobRecord,
  FeedbackRecord,
  Repositories
} from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import type { LlmClient } from "../../model/types.js";
import { stableHash, stableStringify } from "../../utils/id.js";
import { revisionInputHash, episodeGeneration, episodeRewardInputVersion } from "./episode-revision.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import {
  profileIdFromMemory,
  projectIdFromMemory
} from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { synthesizeFailureExperienceSink } from "../feedback/feedback-experience.js";
import { upsertL2Candidate, withdrawEpisodeRewardCandidate, type L2CandidateSignal } from "./l2-candidate-service.js";

const pipelineLogger = createMemoryLogger("pipeline");

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

type NegativeContribution = Omit<NegativeExperienceDraft, "episode" | "sourceMemory" | "feedback" | "repair"> & {
  sourceKey: string;
  episodeId: string;
  sourceMemoryId?: string;
  feedbackId?: string;
  repairId?: string;
};

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
    if (this.deps.config.algorithm.l2Induction.mode === "unified") {
      this.deps.repos.transaction(() => this.enqueueUnifiedCandidates(job));
      return;
    }
    const episode = job.episodeId ? this.deps.repos.runtime.getEpisode(job.episodeId) : undefined;
    if (!episode || episode.userId !== job.userId || episode.status !== "closed") return;
    if (typeof job.payload.episodeGeneration === "number" &&
        job.payload.episodeGeneration !== episodeGeneration(episode)) return;
    const source = negativeExperienceSource(job.payload.source);
    if (!source) return;
    if (source === "episode_reward" && typeof job.payload.rewardVersion === "string" &&
        job.payload.rewardVersion !== revisionInputHash([episode.rTask, episode.rewardDetail])) return;
    // Queue IDs and model wording are not the identity of an evidence source.
    const sourceId = source === "negative_feedback" ? text(job.payload.feedbackId)
      : source === "value_distribution" ? text(job.payload.repairId) : episode.id;
    if (!sourceId) return;
    const completionKey = `negative-source:v1:${stableHash(stableStringify([episode.userId, source, sourceId]))}`;
    const inputVersion = this.inputVersion(job, episode);
    const completed = this.deps.repos.runtime.getKv(completionKey)?.value;
    if (isRecord(completed) && completed.inputVersion === inputVersion) return;
    if (source === "episode_reward" && typeof episode.rTask === "number" &&
        (episode.rewardDetail.skipped === true || episode.rTask > this.deps.config.algorithm.negativeExperience.failureRTaskThreshold)) {
      this.deps.repos.transaction(() => {
        const previous = isRecord(completed) && typeof completed.memoryId === "string"
          ? this.deps.repos.memories.getIncludingDeleted(completed.memoryId) : undefined;
        if (previous && !previous.deletedAt && ["activated", "resolving"].includes(previous.status)) {
          this.withdrawContribution(job, previous, completionKey);
        }
        this.deps.repos.runtime.setKv(completionKey, { inputVersion, memoryId: previous?.id, withdrawn: true }, job.createdAt);
      });
      return;
    }
    const draft = await this.buildDraft(job);
    if (!draft || !isActionableNegativeExperience(draft)) return;
    this.deps.repos.transaction(() => {
      const current = this.deps.repos.runtime.getEpisode(episode.id);
      if (!current || current.status !== "closed" || this.inputVersion(job, current) !== inputVersion) {
        throw new Error("Negative experience inputs changed during generation");
      }
      const latest = this.deps.repos.runtime.getKv(completionKey)?.value;
      if (isRecord(latest) && latest.inputVersion === inputVersion) return;
      const previous = isRecord(latest) && typeof latest.memoryId === "string"
        ? this.deps.repos.memories.getIncludingDeleted(latest.memoryId) : undefined;
      // A user deletion/archive wins over regeneration of that source.
      const retirement = previous?.properties.internal_info.negative_retirement;
      const ownRetirement = previous?.status === "archived" && isRecord(retirement) &&
        retirement.sourceKey === completionKey && retirement.retiredVersion === previous.version &&
        previous.properties.internal_info.negative_generated_hash === revisionInputHash(previous.memoryValue);
      if (previous && (previous.deletedAt || (!ownRetirement && !["activated", "resolving"].includes(previous.status)))) return;
      const memoryId = this.materializeDraft(job, draft, completionKey);
      if (previous && previous.id !== memoryId) this.withdrawContribution(job, previous, completionKey);
      this.deps.repos.runtime.setKv(completionKey, { inputVersion, memoryId }, job.createdAt);
    });
  }

  private inputVersion(job: EvolutionJobRecord, episode: EpisodeRecord): string {
    const feedbackId = text(job.payload.feedbackId);
    const repairId = text(job.payload.repairId);
    return revisionInputHash({
      episode: episodeRewardInputVersion(this.deps.repos, episode),
      reward: [episode.rTask, episode.rewardDetail, episode.meta.reward],
      source: job.payload.source, issue: job.payload.issue, rewardReason: job.payload.rewardReason,
      feedback: feedbackId ? this.deps.repos.runtime.getFeedback(feedbackId) : undefined,
      repair: repairId ? this.deps.repos.runtime.getDecisionRepair(repairId) : undefined,
      language: this.deps.config.language, config: this.deps.config.algorithm.negativeExperience,
      model: [this.deps.skillLlm.config.provider, this.deps.skillLlm.config.model]
    });
  }

  private materializeDraft(job: EvolutionJobRecord, draft: NegativeExperienceDraft, sourceKey: string,
    replacement?: { memory: MemoryRow; contributions: NegativeContribution[] }): string {
    const config = this.deps.config.algorithm.negativeExperience;
    const signature = negativeExperienceSignature(draft);
    const scopeIdentity = [
      (draft.sourceMemory ? projectIdFromMemory(draft.sourceMemory) : undefined) ?? draft.episode.projectId ?? "",
      (draft.sourceMemory ? profileIdFromMemory(draft.sourceMemory) : undefined) ?? ""
    ].join(":");
    const key = `policy:avoid:${stableHash(`${scopeIdentity}:${signature}`).slice(0, 24)}`;
    let existing = replacement?.memory ?? this.findExisting(draft, key);
    if (existing?.deletedAt || existing?.status === "deleted") {
      throw new Error("Negative experience target was deleted by the user");
    }
    if (existing?.status === "archived") {
      const retirement = existing.properties.internal_info.negative_retirement;
      if (!isRecord(retirement) || retirement.retiredVersion !== existing.version ||
          existing.properties.internal_info.negative_generated_hash !== revisionInputHash(existing.memoryValue)) {
        throw new Error("Negative experience target was archived or edited by the user");
      }
      const { negative_retirement: _retirement, ...internal } = existing.properties.internal_info;
      const status = retirement.previousStatus === "activated" ? "activated" : "resolving";
      existing = this.deps.repos.memories.update({ ...existing, status,
        properties: { ...existing.properties, status, internal_info: internal }, updatedAt: job.createdAt });
    }
    if (existing && !["activated", "resolving"].includes(existing.status)) throw new Error("Negative experience target is not active");
    const storedHash = existing?.properties.internal_info.negative_generated_hash;
    if (typeof storedHash === "string" && storedHash !== revisionInputHash(existing!.memoryValue)) {
      throw new Error("Negative experience has user edits; preserve it for review");
    }
    const { episode, sourceMemory, feedback, repair, ...content } = draft;
    const contribution: NegativeContribution = { ...content, sourceKey, episodeId: episode.id,
      sourceMemoryId: sourceMemory?.id, feedbackId: feedback?.id, repairId: repair?.id };
    const priorContributions = this.contributions(existing);
    const contributions = replacement?.contributions ?? [
      ...priorContributions.filter(item => item.sourceKey !== sourceKey), contribution
    ];
    // Legacy rows have no attributable per-source text: retain their aggregate until a reviewed migration.
    const legacyAggregate = existing && !Array.isArray(existing.properties.internal_info.negative_contributions)
      ? { policy: existing.properties.internal_info.policy,
          eventIds: existing.properties.internal_info.source_event_ids,
          repairIds: existing.properties.internal_info.source_repair_ids,
          sources: existing.properties.internal_info.negative_experience_sources }
      : existing?.properties.internal_info.negative_legacy_aggregate;
    const hasLegacyAggregate = isRecord(legacyAggregate);
    const existingInternal: Record<string, unknown> = existing && isRecord(existing.properties.internal_info)
      ? existing.properties.internal_info
      : {};
    const originalPolicy = isRecord(existingInternal.policy) ? existingInternal.policy : {};
    const existingPolicy = hasLegacyAggregate && isRecord(legacyAggregate.policy) ? legacyAggregate.policy : { ...originalPolicy,
      source_episode_ids: [], source_trace_ids: [], source_feedback_ids: [], decision_guidance: {} };
    const gain = number(originalPolicy.gain) ?? 0;
    const rawGain = number(originalPolicy.raw_gain) ?? 0;
    const policyStatus = text(originalPolicy.status) ?? "candidate";
    const knownFeedbackIds = new Set(priorContributions.flatMap(item => item.feedbackId ? [item.feedbackId] : []));
    const independentFeedbackIds = stringArray(originalPolicy.source_feedback_ids).filter(id => !knownFeedbackIds.has(id));
    const sourceEventIds = cappedDistinct(
      [...(hasLegacyAggregate ? stringArray(legacyAggregate.eventIds) : []), ...contributions.map(item => item.sourceEventId)],
      config.maxSourceIds
    );

    const mergedEpisodeIds = cappedDistinct(
      [...stringArray(existingPolicy.source_episode_ids), ...contributions.map(item => item.episodeId)],
      config.maxSourceIds
    );
    const mergedTraceIds = cappedDistinct(
      [...stringArray(existingPolicy.source_trace_ids), ...contributions.flatMap(item => item.sourceTraceIds)],
      config.maxSourceIds
    );
    const mergedFeedbackIds = cappedDistinct(
      [
        ...stringArray(existingPolicy.source_feedback_ids), ...independentFeedbackIds,
        ...contributions.flatMap(item => item.feedbackId ? [item.feedbackId] : [])
      ],
      config.maxSourceIds
    );
    const mergedRepairIds = cappedDistinct(
      [
        ...(hasLegacyAggregate ? stringArray(legacyAggregate.repairIds) : []),
        ...contributions.flatMap(item => item.repairId ? [item.repairId] : [])
      ],
      config.maxSourceIds
    );
    const antiPatterns = cappedDistinct(
      [...decisionGuidance(existingPolicy, "anti_pattern"), ...contributions.map(item => item.antiPattern)],
      config.maxAntiPatterns
    );
    const preferences = cappedDistinct(
      [...decisionGuidance(existingPolicy, "preference"), ...contributions.map(item => item.preference)],
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
      confidence: draft.confidence, gain, rawGain
    });
    const policy = {
      ...existingPolicy,
      title,
      trigger,
      procedure,
      verification: draft.verification,
      boundary: draft.boundary,
      support,
      gain,
      raw_gain: rawGain,
      policy_confidence: draft.confidence,
      evidence_strength: draft.evidenceStrength,
      salience: draft.salience,
      status: policyStatus,
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
      lifecycleStatus: existing?.status === "activated" ? "active" : "candidate",
      memoryType: "LongTermMemory",
      key: existing?.memoryKey ?? key,
      value: body,
      tags: ["policy", "avoidance", "failure", "negative"],
      info: {
        signature,
        support,
        gain,
        raw_gain: rawGain,
        policy_confidence: draft.confidence,
        evidence_strength: draft.evidenceStrength,
        status: policyStatus,
        source_episode_ids: mergedEpisodeIds,
        source_trace_ids: mergedTraceIds,
        source_feedback_ids: mergedFeedbackIds,
        experience_type: draft.experienceType,
        evidence_polarity: "negative",
        source_basis: draft.sourceBasis,
        is_caveat: true
      },
      internal: {
        ...existingInternal,
        ...(hasLegacyAggregate ? { negative_legacy_aggregate: legacyAggregate } : {}),
        negative_contributions: contributions,
        negative_generated_hash: revisionInputHash(body),
        source: "worker.negative_experience.v1",
        plugin_algorithm: "negative_experience.v1",
        source_event_ids: sourceEventIds,
        source_episode_ids: mergedEpisodeIds,
        source_trace_ids: mergedTraceIds,
        source_feedback_ids: mergedFeedbackIds,
        source_repair_ids: mergedRepairIds,
        negative_experience_sources: cappedDistinct(
          [...(hasLegacyAggregate ? stringArray(legacyAggregate.sources) : []), ...contributions.map(item => item.source)],
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
    return upsert.memory.id;
  }

  private contributions(memory?: MemoryRow): NegativeContribution[] {
    const value = memory?.properties.internal_info.negative_contributions;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is NegativeContribution => isRecord(item) &&
      typeof item.sourceKey === "string" && typeof item.episodeId === "string" &&
      typeof item.title === "string" && typeof item.antiPattern === "string" &&
      typeof item.preference === "string" && Array.isArray(item.sourceTraceIds));
  }

  private withdrawContribution(job: EvolutionJobRecord, previous: MemoryRow, sourceKey: string): void {
    const contributions = this.contributions(previous);
    if (!contributions.some(item => item.sourceKey === sourceKey)) return;
    const hash = previous.properties.internal_info.negative_generated_hash;
    if (typeof hash !== "string" || hash !== revisionInputHash(previous.memoryValue)) {
      throw new Error("Negative experience withdrawal would overwrite user edits");
    }
    if (isRecord(previous.properties.internal_info.negative_legacy_aggregate)) {
      throw new Error("Legacy negative aggregate cannot be safely separated without review");
    }
    const remaining = contributions.filter(item => item.sourceKey !== sourceKey);
    if (remaining.length) {
      const latest = remaining.at(-1)!;
      const episode = this.deps.repos.runtime.getEpisode(latest.episodeId);
      if (!episode) throw new Error("Negative experience remaining source is missing");
      this.materializeDraft(job, { ...latest, episode,
        sourceMemory: latest.sourceMemoryId ? this.deps.repos.memories.get(latest.sourceMemoryId) : undefined,
        feedback: latest.feedbackId ? this.deps.repos.runtime.getFeedback(latest.feedbackId) : undefined,
        repair: latest.repairId ? this.deps.repos.runtime.getDecisionRepair(latest.repairId) : undefined
      }, latest.sourceKey, { memory: previous, contributions: remaining });
      return;
    }
    const policy = isRecord(previous.properties.internal_info.policy) ? previous.properties.internal_info.policy : {};
    const attributableFeedback = new Set(contributions.flatMap(item => item.feedbackId ? [item.feedbackId] : []));
    if (stringArray(policy.source_feedback_ids).some(id => !attributableFeedback.has(id))) {
      throw new Error("Negative experience has independent feedback; preserve it for review");
    }
    const retired = this.deps.repos.memories.update({ ...previous, status: "archived",
      properties: { ...previous.properties, status: "archived", internal_info: {
        ...previous.properties.internal_info, negative_contributions: [],
        negative_retirement: { sourceKey, retiredVersion: previous.version + 1, previousStatus: previous.status }
      } }, updatedAt: job.createdAt });
    this.deps.repos.runtime.appendChange({ memoryId: previous.id, entityId: previous.id,
      namespaceId: this.deps.namespaceIdFromMemory(previous), userId: previous.userId,
      kind: "policy", op: "updated", changeType: "negative_source_replaced",
      before: previous, after: retired, source: "worker.negative_experience.v1", createdAt: job.createdAt });
  }

  private enqueueUnifiedCandidates(job: EvolutionJobRecord): void {
    const source = negativeExperienceSource(job.payload.source);
    const episode = job.episodeId ? this.deps.repos.runtime.getEpisode(job.episodeId) : undefined;
    if (!source || !episode || episode.userId !== job.userId) return;
    if (source === "episode_reward" && typeof job.payload.rewardVersion === "string" &&
        job.payload.rewardVersion !== revisionInputHash([episode.rTask, episode.rewardDetail])) return;
    // Explicit corrections have their own identity and remain valid when a task reopens.
    if (source !== "negative_feedback" && (episode.status !== "closed" ||
        (typeof job.payload.episodeGeneration === "number" &&
          job.payload.episodeGeneration !== episodeGeneration(episode)))) return;
    const feedbackId = text(job.payload.feedbackId);
    const repairId = text(job.payload.repairId);
    const feedback = feedbackId ? this.deps.repos.runtime.getFeedback(feedbackId) : undefined;
    const repair = repairId ? this.deps.repos.runtime.getDecisionRepair(repairId) : undefined;
    if (feedbackId && (!feedback || feedback.userId !== job.userId || feedback.episodeId !== episode.id)) return;
    if (repairId && (!repair || repair.userId !== job.userId || repair.episodeId !== episode.id)) return;

    const sources = episode.l1MemoryIds.flatMap((id) => {
      const memory = this.deps.repos.memories.get(id);
      const trace = memory ? traceMetaFromMemory(memory) : null;
      if (!memory || !trace || memory.userId !== job.userId || memory.deletedAt ||
          memory.status === "deleted" || memory.status === "archived") return [];
      const raw = trace.rawTurnId ? this.deps.repos.runtime.getRawTurn(trace.rawTurnId) : undefined;
      if (raw && (raw.deletedAt || raw.redactedAt || raw.userId !== job.userId)) return [];
      if ((trace.episodeId ?? raw?.episodeId) !== episode.id) return [];
      return [{ memory, trace }];
    }).filter(({ memory }) => source !== "negative_feedback" || memory.id === feedback?.l1MemoryId);
    // Explicit feedback without its own L1 must not borrow another turn's L1.
    if (sources.length === 0 || (feedback && !sources.some(({ memory }) => memory.id === feedback.l1MemoryId)) ||
        (source === "negative_feedback" && !feedback)) {
      pipelineLogger.info("l2.candidate.skipped_no_l1", {
        route: "negative", source, episodeId: episode.id, feedbackId, repairId, jobId: job.id
      });
      return;
    }
    if (source === "episode_reward" && typeof episode.rTask === "number" &&
        (episode.rewardDetail.skipped === true || episode.rTask > this.deps.config.algorithm.negativeExperience.failureRTaskThreshold)) {
      for (const { memory } of sources) {
        const candidate = withdrawEpisodeRewardCandidate(this.deps.repos, {
          sourceMemoryId: memory.id, userId: job.userId, episodeId: episode.id, at: job.createdAt
        });
        if (candidate?.status === "pending") this.deps.enqueueJob({ jobType: "l2_induction", userId: job.userId,
          sessionId: episode.sessionId, episodeId: episode.id, targetMemoryId: memory.id,
          dedupeKey: `l2.unified.withdraw:${candidate.id}:${candidate.sourceVersion}`,
          payload: { unified: true, reason: "negative.reward_withdrawn" }, createdAt: job.createdAt });
      }
      return;
    }
    const sourceIds = new Set(sources.map(({ memory }) => memory.id));
    const rawIds = new Set(sources.map(({ trace }) => trace.rawTurnId).filter(Boolean));
    const rawTurns = this.deps.repos.runtime.listRawTurnsByEpisode(episode.id)
      .filter((turn) => turn.userId === job.userId && !turn.deletedAt && !turn.redactedAt &&
        (rawIds.has(turn.id) || turn.sourceMemoryIds.some((id) => sourceIds.has(id))));
    const sourceBasis = sourceBasisFor(source, feedback);
    const rewardReason = text(job.payload.rewardReason)
      ?? text(episode.rewardDetail.reason)
      ?? text(isRecord(episode.meta.reward) ? episode.meta.reward.reason : undefined);
    const signal: L2CandidateSignal = {
      eventId: source === "negative_feedback" ? feedback!.id
        : source === "episode_reward" ? episode.id
        : `negative:${source}:${repair?.id ?? episode.id}`,
      route: "negative",
      feedbackId: feedback?.id,
      repairId: repair?.id,
      polarity: "negative",
      sourceBasis,
      confidenceCap: sourceBasis === "implicit_failure_analysis"
        ? this.deps.config.algorithm.negativeExperience.implicitConfidenceCap
        : 1,
      evidenceStrength: clamp(feedback?.magnitude ?? Math.abs(episode.rTask ?? 0), 0, 1),
      repairValidated: repair?.validated,
      text: [
        `Negative evidence source: ${source}; basis: ${sourceBasis}.`,
        feedback?.rationale ? `Feedback: ${clip(feedback.rationale, 2400)}` : "",
        rewardReason ? `Reward assessment: ${clip(rewardReason, 1600)}` : "",
        text(job.payload.issue) ? `Reported issue: ${clip(text(job.payload.issue)!, 1200)}` : "",
        repair ? [
          `Repair proposal (${repair.validated ? "validated" : "unvalidated; do not infer a successful repair"}):`,
          `Issue: ${clip(repair.issue, 1200)}`,
          `Prefer: ${clip(repair.preference ?? repair.suggestion, 1200)}`,
          repair.antiPattern ? `Avoid: ${clip(repair.antiPattern, 1200)}` : ""
        ].filter(Boolean).join("\n") : ""
      ].filter(Boolean).join("\n\n")
    };
    let targetMemory: MemoryRow | undefined;
    const candidateVersions: string[] = [];
    for (const { memory, trace } of sources) {
      // Keep each L1's vector input local to that L1. The Episode batch supplies the union.
      const rawEvidence = rawTurns
        .filter((turn) => turn.id === trace.rawTurnId || turn.sourceMemoryIds.includes(memory.id))
        .map((turn) => [
          `Source turn ${turn.id}:`,
          turn.userText ? `User: ${clip(turn.userText, 700)}` : "",
          turn.assistantText ? `Agent: ${clip(turn.assistantText, 900)}` : "",
          turn.toolCalls.length ? `Observed tool calls: ${clip(JSON.stringify(turn.toolCalls), 1600)}` : "",
          turn.toolResults.length ? `Observed tool results: ${clip(JSON.stringify(turn.toolResults), 1600)}` : ""
        ].filter(Boolean).join("\n"));
      const candidate = upsertL2Candidate(this.deps.repos, {
        sourceMemoryId: memory.id,
        userId: job.userId,
        episodeId: episode.id,
        route: "negative",
        signal: { ...signal, text: [signal.text, ...rawEvidence].join("\n\n") },
        at: job.createdAt
      });
      if (!candidate || candidate.status !== "pending") continue;
      targetMemory ??= memory;
      candidateVersions.push(`${candidate.sourceMemoryId}:${candidate.sourceVersion}`);
    }
    if (targetMemory) {
      this.deps.enqueueJob({
        jobType: "l2_induction",
        userId: job.userId,
        sessionId: targetMemory.sessionId ?? episode.sessionId,
        episodeId: episode.id,
        targetMemoryId: targetMemory.id,
        dedupeKey: `l2.unified.negative:${createHash("sha256").update(candidateVersions.sort().join("\n")).digest("hex")}`,
        payload: { unified: true, reason: "negative.experience", source, sourceEventId: signal.eventId },
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
    if (!source || !episode) return undefined;

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
    }, { llm: this.deps.skillLlm, language: this.deps.config.language });
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
    return this.deps.repos.memories.getByKeyIncludingDeleted("L2", key);
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
  gain?: number;
  rawGain?: number;
}): string {
  return [
    input.title,
    `Trigger: ${input.trigger}`,
    `Avoid: ${input.antiPattern}`,
    `Safer behavior: ${input.procedure}`,
    `Verification: ${input.verification}`,
    `Boundary: ${input.boundary}`,
    `Support: ${input.support}`,
    `Gain: ${input.gain ?? 0}`,
    `Raw gain: ${input.rawGain ?? 0}`,
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
