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
import { createMemoryLogger } from "../../logging/logger.js";
import { stableHash, stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";
import {
  profileIdFromMemory,
  projectIdFromMemory
} from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { synthesizeFailureExperienceSink } from "../feedback/feedback-experience.js";

import { episodeInputRevision, jobRevisionIsCurrent } from "./episode-revision.js";

const pipelineLogger = createMemoryLogger("negative_experience");

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
    if (!this.deps.config.algorithm.negativeExperience.enabled || !jobRevisionIsCurrent(this.deps.repos, job)) return;
    if (job.payload.source === "value_distribution" && !this.deps.config.algorithm.feedback.valueDistributionRepairEnabled) return;
    const source = negativeExperienceSource(job.payload.source);
    const episode = job.episodeId ? this.deps.repos.runtime.getEpisode(job.episodeId) : undefined;
    if (!source || !episode) return;
    const sourceEventId = text(job.payload.sourceEventId)
      ?? (source === "episode_reward" ? episode.id : source === "negative_feedback" ? text(job.payload.feedbackId) : text(job.payload.repairId));
    if (!sourceEventId) return; // A queue attempt is not an evidence identity.
    const eventKey = `${source}:${sourceEventId}`;
    const inputRevision = episodeInputRevision(this.deps.repos, episode.id, true);
    const inputHash = stableHash(stableStringify({ inputRevision, source, sourceEventId,
      feedback: text(job.payload.feedbackId) ? this.deps.repos.runtime.getFeedback(String(job.payload.feedbackId)) : undefined,
      repair: text(job.payload.repairId) ? this.deps.repos.runtime.getDecisionRepair(String(job.payload.repairId)) : undefined,
      language: this.deps.config.language, config: this.deps.config.algorithm.negativeExperience }));
    const sources = isRecord(episode.meta.negativeExperienceSources) ? episode.meta.negativeExperienceSources : {};
    const previousEntry = isRecord(sources[eventKey]) ? sources[eventKey] : undefined;
    if (previousEntry?.inputHash === inputHash) return;
    const legacyMatches = episode.l2PolicyIds.map(id => this.deps.repos.memories.get(id)).filter((memory): memory is MemoryRow => Boolean(memory
      && memory.status !== "deleted" && stringArray(memory.properties.internal_info.source_event_ids).includes(sourceEventId)));
    const previous = typeof previousEntry?.memoryId === "string" ? this.deps.repos.memories.get(previousEntry.memoryId) : legacyMatches[0];
    if (previous && belongsToLegacySharedContribution(previous, sourceEventId)) {
      // Old shared prose has no per-source attribution. Do not guess a destructive split
      // or manufacture another effective contribution for the same known event. The marker
      // alone must not be silent: this record needs a manual split to become revisable.
      pipelineLogger.warn("negative_experience.legacy_shared_record", {
        memoryId: previous.id, episodeId: episode.id, sourceEventId
      });
      this.updateSource(episode.id, eventKey, { inputHash, memoryId: previous.id, legacySharedNeedsReview: true }, job.createdAt);
      return;
    }
    const retiring = source === "episode_reward" && typeof episode.rTask === "number"
      && episode.rTask > this.deps.config.algorithm.negativeExperience.failureRTaskThreshold;
    const draft = retiring ? undefined : await this.buildDraft({ ...job, payload: { ...job.payload, sourceEventId } });
    if (!retiring && (!draft || !isActionableNegativeExperience(draft))) {
      if (previous) throw new Error("negative experience revision did not produce a valid replacement");
      return;
    }
    this.deps.repos.transaction(() => {
      if (episodeInputRevision(this.deps.repos, episode.id, true) !== inputRevision) {
        if (source !== "episode_reward") throw new Error("negative event context changed; retry with current evidence");
        return;
      }
      let old = previous ? this.deps.repos.memories.get(previous.id) : undefined;
      if (old?.status === "archived" || old?.status === "deleted") old = undefined;
      const oldContributions = contributionMap(old);
      const attributableLegacy = Object.entries(oldContributions).find(([key, contribution]) => key.startsWith("legacy:")
        && contribution.sourceEventIds.length === 1 && contribution.sourceEventIds[0] === sourceEventId);
      if (old && !oldContributions[eventKey] && attributableLegacy) {
        // A single-source legacy contribution remains attributable after newer sources merge.
        delete oldContributions[attributableLegacy[0]];
        oldContributions[eventKey] = attributableLegacy[1];
        old = { ...old, properties: { ...old.properties, internal_info: { ...old.properties.internal_info, negative_contributions: oldContributions } } };
      }
      if (retiring) {
        if (old && oldContributions[eventKey]) {
          delete oldContributions[eventKey];
          this.saveContributions(old, oldContributions, job);
        }
        this.updateSource(episode.id, eventKey, { inputHash, memoryId: null }, job.createdAt);
        return;
      }
      const valid = draft!;
      const signature = negativeExperienceSignature(valid);
      const scope = [(valid.sourceMemory ? projectIdFromMemory(valid.sourceMemory) : undefined) ?? episode.projectId ?? "",
        (valid.sourceMemory ? profileIdFromMemory(valid.sourceMemory) : undefined) ?? ""].join(":");
      const key = `policy:avoid:${stableHash(`${scope}:${signature}`).slice(0, 24)}`;
      let target = this.deps.repos.memories.getByKey("L2", key);
      if (target?.status === "deleted" || target?.status === "archived") target = undefined;
      // A sole source keeps its record ID even when the model changes its wording.
      if (!target && old && Object.keys(oldContributions).length === 1 && oldContributions[eventKey]) target = old;
      if (old && target?.id !== old.id && oldContributions[eventKey]) {
        delete oldContributions[eventKey];
        this.saveContributions(old, oldContributions, job);
        old = undefined;
      }
      if (old && target?.id === old.id) target = old;
      const contributions = contributionMap(target);
      contributions[eventKey] = compactContribution(valid, inputHash);
      const saved = this.saveContributions(target, contributions, job, key);
      this.updateSource(episode.id, eventKey, { inputHash, memoryId: saved?.id }, job.createdAt);
      for (const duplicate of legacyMatches) {
        if (duplicate.id !== saved?.id && !isRecord(duplicate.properties.internal_info.negative_contributions)
          && stringArray(duplicate.properties.internal_info.source_event_ids).length === 1) {
          this.retire(duplicate, job.createdAt);
        }
      }
    });
  }

  private retire(memory: MemoryRow, at: string): void {
    const retired = this.deps.repos.memories.softDelete(memory.id, at);
    this.deps.repos.runtime.appendChange({ memoryId: memory.id, namespaceId: this.deps.namespaceIdFromMemory(memory), kind: "policy",
      op: "deleted", entityId: memory.id, userId: memory.userId, changeType: "negative_experience_retired",
      before: memory, after: retired, source: "worker.negative_experience.v1", createdAt: at });
  }

  private updateSource(episodeId: string, key: string, entry: Record<string, unknown>, at: string): void {
    const episode = this.deps.repos.runtime.getEpisode(episodeId)!;
    this.deps.repos.runtime.updateEpisodeMeta(episodeId, { negativeExperienceSources: {
      ...(isRecord(episode.meta.negativeExperienceSources) ? episode.meta.negativeExperienceSources : {}), [key]: entry
    } }, at);
  }

  private saveContributions(previous: MemoryRow | undefined, contributions: Record<string, NegativeContribution>, job: EvolutionJobRecord, key?: string): MemoryRow | undefined {
    const rows = Object.values(contributions);
    if (!rows.length) {
      if (previous) this.retire(previous, job.createdAt);
      return undefined;
    }
    const last = rows[rows.length - 1]!;
    const episode = this.deps.repos.runtime.getEpisode(last.episodeId)!;
    const config = this.deps.config.algorithm.negativeExperience;
    const distinct = (values: string[]) => [...new Set(values)];
    const episodeIds = distinct(rows.flatMap(row => row.episodeIds));
    const traceIds = distinct(rows.flatMap(row => row.sourceTraceIds));
    const feedbackIds = distinct(rows.flatMap(row => row.feedbackIds));
    const repairIds = distinct(rows.flatMap(row => row.repairIds));
    const antiPatterns = distinct(rows.map(row => row.antiPattern));
    const preferences = distinct(rows.map(row => row.preference));
    const combine = (field: "trigger" | "procedure" | "verification" | "boundary") => distinct(rows.map(row => row[field])).join("\n");
    const support = episodeIds.length;
    const policy = {
      title: last.title, trigger: combine("trigger"), procedure: combine("procedure"), verification: combine("verification"), boundary: combine("boundary"),
      support, gain: 0, raw_gain: 0, policy_confidence: last.confidence, evidence_strength: last.evidenceStrength, salience: last.salience,
      status: "candidate", experience_type: last.experienceType, evidence_polarity: "negative", source_cohort: "neg_episode",
      source_basis: last.sourceBasis, is_caveat: true, skill_eligible: false, signature: last.signature,
      source_episode_ids: episodeIds.slice(0, config.maxSourceIds), source_trace_ids: traceIds.slice(0, config.maxSourceIds),
      source_feedback_ids: feedbackIds.slice(0, config.maxSourceIds),
      decision_guidance: { preference: preferences.slice(0, config.maxPreferences), anti_pattern: antiPatterns.slice(0, config.maxAntiPatterns) },
      tags: ["policy", "avoidance", "failure"]
    };
    const sourceMemory = last.sourceMemoryId ? this.deps.repos.memories.get(last.sourceMemoryId) : undefined;
    const memory = this.deps.buildMemory({
      ...(previous ? { id: previous.id } : {}), userId: episode.userId, sessionId: episode.sessionId, conversationId: episode.conversationId,
      projectId: sourceMemory ? projectIdFromMemory(sourceMemory) : episode.projectId,
      profileId: sourceMemory ? profileIdFromMemory(sourceMemory) : undefined,
      layer: "L2", kind: "policy", lifecycleStatus: "candidate", memoryType: "LongTermMemory", key: key ?? previous?.memoryKey,
      value: renderNegativeExperienceBody({ ...policy, antiPattern: antiPatterns.join("\n"), confidence: last.confidence }),
      tags: ["policy", "avoidance", "failure", "negative"], info: { ...policy },
      internal: { source: "worker.negative_experience.v1", plugin_algorithm: "negative_experience.v1", policy,
        source_event_ids: distinct(rows.flatMap(row => row.sourceEventIds)).slice(0, config.maxSourceIds),
        source_episode_ids: policy.source_episode_ids, source_trace_ids: policy.source_trace_ids,
        source_feedback_ids: policy.source_feedback_ids, source_repair_ids: repairIds.slice(0, config.maxSourceIds),
        negative_experience_sources: distinct(rows.map(row => row.source)), negative_contributions: contributions },
      createdAt: previous?.createdAt ?? job.createdAt
    });
    const saved = previous ? this.deps.repos.memories.update({ ...memory, createdAt: previous.createdAt, version: previous.version })
      : this.deps.repos.memories.insert(memory);
    for (const id of episodeIds) this.deps.repos.runtime.appendEpisodeDerivedMemory(id, "L2", saved.id, job.createdAt);
    this.deps.repos.runtime.appendChange({ memoryId: saved.id, namespaceId: this.deps.namespaceIdFromMemory(saved), kind: "policy",
      op: previous ? "updated" : "created", entityId: saved.id, userId: saved.userId,
      changeType: previous ? "negative_experience_updated" : "negative_experience_created", before: previous, after: saved,
      source: "worker.negative_experience.v1", createdAt: job.createdAt });
    if (this.deps.config.algorithm.capture.embedAfterCapture) this.deps.enqueueJob({ jobType: "embedding", userId: saved.userId,
      sessionId: saved.sessionId, episodeId: episode.id, targetMemoryId: saved.id,
      payload: { reason: "negative_experience", contentHash: saved.contentHash }, createdAt: job.createdAt });
    return saved;
  }

  private async buildDraft(job: EvolutionJobRecord): Promise<NegativeExperienceDraft | undefined> {
    const source = negativeExperienceSource(job.payload.source);
    const sourceEventId = text(job.payload.sourceEventId);
    if (!sourceEventId) return undefined;
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
    const rewardReason = text(episode.rewardDetail.reason)
      ?? text(job.payload.rewardReason)
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

interface NegativeContribution {
  source: NegativeExperienceSource; sourceBasis: NegativeExperienceSourceBasis; sourceEventIds: string[];
  episodeId: string; episodeIds: string[]; sourceMemoryId?: string; feedbackIds: string[]; repairIds: string[];
  title: string; experienceType: "failure_avoidance" | "repair_instruction"; trigger: string; antiPattern: string;
  preference: string; procedure: string; verification: string; boundary: string; sourceTraceIds: string[];
  confidence: number; salience: number; evidenceStrength: number; signature: string; inputHash: string;
}
function compactContribution(draft: NegativeExperienceDraft, inputHash: string): NegativeContribution {
  const { episode, sourceMemory, feedback, repair, sourceEventId, ...fields } = draft;
  return { ...fields, episodeId: episode.id, episodeIds: [episode.id], sourceMemoryId: sourceMemory?.id,
    sourceEventIds: [sourceEventId], feedbackIds: feedback ? [feedback.id] : [], repairIds: repair ? [repair.id] : [],
    signature: negativeExperienceSignature(draft), inputHash };
}

function belongsToLegacySharedContribution(memory: MemoryRow, sourceEventId: string): boolean {
  const internal = memory.properties.internal_info;
  if (!isRecord(internal.negative_contributions)) {
    return stringArray(internal.source_event_ids).length > 1;
  }
  // Merging a new source preserves old unattributed prose under a legacy key.
  // Only sources inside that aggregate need protection; separately stored sources remain revisable.
  return Object.entries(internal.negative_contributions).some(([key, contribution]) => {
    if (!key.startsWith("legacy:") || !isRecord(contribution)) return false;
    const sourceEventIds = stringArray(contribution.sourceEventIds);
    return sourceEventIds.length > 1 && sourceEventIds.includes(sourceEventId);
  });
}

function contributionMap(memory?: MemoryRow): Record<string, NegativeContribution> {
  if (!memory) return {};
  const internal = memory.properties.internal_info;
  if (isRecord(internal.negative_contributions)) return structuredClone(internal.negative_contributions) as Record<string, NegativeContribution>;
  // Legacy aggregate content cannot safely be attributed to individual events. Keep it intact.
  const policy = isRecord(internal.policy) ? internal.policy : {};
  const episodeIds = stringArray(policy.source_episode_ids);
  if (!episodeIds.length) return {};
  return { [`legacy:${memory.id}`]: {
    source: "episode_reward", sourceBasis: "implicit_failure_analysis", sourceEventIds: stringArray(internal.source_event_ids),
    episodeId: episodeIds[0]!, episodeIds, feedbackIds: stringArray(policy.source_feedback_ids), repairIds: stringArray(internal.source_repair_ids),
    title: text(policy.title) ?? memory.memoryKey ?? "", experienceType: "failure_avoidance", trigger: text(policy.trigger) ?? "",
    antiPattern: decisionGuidance(policy, "anti_pattern").join("\n"), preference: decisionGuidance(policy, "preference").join("\n"),
    procedure: text(policy.procedure) ?? "", verification: text(policy.verification) ?? "", boundary: text(policy.boundary) ?? "",
    sourceTraceIds: stringArray(policy.source_trace_ids), confidence: number(policy.policy_confidence) ?? 0,
    salience: number(policy.salience) ?? 0, evidenceStrength: number(policy.evidence_strength) ?? 0,
    signature: text(policy.signature) ?? "", inputHash: "legacy"
  } };
}
