import {
  L2_INDUCTION_PROMPT,
  buildPolicyDraft,
  detectDominantLanguage,
  l2CandidateIdFor,
  languageSteeringLine,
  packL2InductionTraces,
  policyMetaFromMemory,
  signatureFromTrace,
  skillMetaFromMemory,
  traceMetaFromMemory,
  tracePolicySimilarity
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import type { EvolutionJobRecord } from "../../storage/repositories.js";
import { kindFromMemory } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { stableHash } from "../../utils/id.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";

export type PolicyDraft = ReturnType<typeof buildPolicyDraft>;
export type PolicyEnhancementResult =
  | { ok: true; draft: PolicyDraft }
  | { ok: false; reason: string };
type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;

type JobChangeKind = "created" | "updated" | "skipped";
type PolicyLifecycleStatus = "candidate" | "active" | "archived";

type CandidatePoolRecord = {
  sourceMemoryId: string;
  candidateKey: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  sourceEpisodeId?: string;
};

type PolicyTraceLink = {
  l1MemoryId: string;
  l2MemoryId: string;
};

type ReposPort = {
  memories: {
    get(id: string): MemoryRow | undefined;
    getByKey(userId: string, memoryLayer: "L2", memoryKey: string): MemoryRow | undefined;
    list(filter: Record<string, unknown>, limit?: number): MemoryRow[];
    getMany(ids: string[]): MemoryRow[];
    update(memory: MemoryRow): MemoryRow;
  };
  runtime: {
    pruneCandidatePool(now: string): number;
    listPendingCandidatePool(input: {
      userId?: string;
      now?: string;
      limit?: number;
    }): CandidatePoolRecord[];
    upsertCandidatePoolTrace(input: {
      id: string;
      userId: string;
      sessionId?: string;
      sourceMemoryId: string;
      candidateKey: string;
      candidateValue: string;
      score: number;
      evidence: unknown;
      createdAt: string;
      updatedAt: string;
      expiresAt?: string | null;
    }): void;
    markCandidatePoolPromoted(input: {
      userId?: string;
      candidateKey: string;
      sourceMemoryIds: string[];
      policyId: string;
      at: string;
    }): void;
    listTracePolicyLinks(input: {
      userId?: string;
      l1MemoryId?: string;
      l2MemoryId?: string;
      limit?: number;
    }): PolicyTraceLink[];
    insertTracePolicyLink(input: {
      userId: string;
      l1MemoryId: string;
      l2MemoryId: string;
      relation?: string;
      strength?: number;
      createdAt?: string;
    }): string;
    appendEpisodeDerivedMemory(
      episodeId: string,
      layer: "L1" | "L2" | "L3" | "Skill",
      memoryId: string,
      at: string
    ): void;
  };
};

export interface PolicyInductionDeps {
  config: MemmyConfig;
  repos: ReposPort;
  nowIso: () => string;
  skillLlm: LlmClient;
  traceMeta(memory: MemoryRow | null | undefined): TraceMeta | null;
  projectIdFromMemory(memory: MemoryRow): string | undefined;
  profileIdFromMemory(memory: MemoryRow): string | undefined;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertEvolutionMemory(memory: MemoryRow): {
    memory: MemoryRow;
    created: boolean;
    previous?: MemoryRow;
  };
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  enqueueChange(input: {
    memoryId: string;
    namespaceId?: string;
    kind: string;
    op: JobChangeKind;
    entityId: string;
    userId: string;
    changeType: string;
    before?: unknown;
    after: unknown;
    source: string;
    createdAt: string;
  }): void;
  namespaceIdFromMemory(memory: MemoryRow): string | undefined;
  onSkillRewardDrift(policy: PolicyMeta, at: string): void;
}

export class PolicyInductionEngine {
  constructor(private readonly deps: PolicyInductionDeps) {}

  async induceL2(job: EvolutionJobRecord): Promise<void> {
    const source = this.l2InductionSourceForJob(job);
    if (!source) {
      const sourceMemoryId = typeof job.payload?.sourceMemoryId === "string"
        ? job.payload.sourceMemoryId
        : typeof job.payload?.l1MemoryId === "string"
        ? job.payload.l1MemoryId
        : job.targetMemoryId;
      throw new Error(`source memory not found for l2 induction: ${sourceMemoryId ?? job.id}`);
    }
    const sourceTrace = this.deps.traceMeta(source);
    if (!sourceTrace) {
      return;
    }
    const at = this.deps.nowIso();
    const sourceSignature = signatureFromTrace(sourceTrace);
    const sourceNamespaceId = this.deps.namespaceIdFromMemory(source);
    this.deps.repos.runtime.pruneCandidatePool(at);
    if (this.isTraceEligibleForL2(sourceTrace)) {
      this.recordCandidatePoolTrace(sourceTrace, sourceSignature, at);
    }

    const pendingCandidates = this.deps.repos.runtime.listPendingCandidatePool({
      userId: source.userId,
      now: at,
      limit: 2000
    });
    const pendingTraceIds = uniq(pendingCandidates.map((candidate) => candidate.sourceMemoryId));
    const eligibleTraces = this.deps.repos.memories
      .getMany(pendingTraceIds)
      .map((memory) => this.deps.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace && this.isTraceEligibleForL2(trace))
      );
    const eligibleById = new Map(eligibleTraces.map((trace) => [trace.id, trace]));
    const signatures = uniq(
      pendingCandidates
        .filter((candidate) => eligibleById.has(candidate.sourceMemoryId))
        .map((candidate) => candidate.candidateKey)
    );

    for (const signature of signatures) {
      const bucket = uniq(
        pendingCandidates
          .filter((candidate) => candidate.candidateKey === signature)
          .map((candidate) => candidate.sourceMemoryId)
      )
        .map((traceId) => eligibleById.get(traceId))
        .filter((trace): trace is TraceMeta => Boolean(trace));
      const distinctEpisodeCount = uniq(
        bucket
          .map((trace) => trace.episodeId)
          .filter((id): id is string => Boolean(id))
      ).length;
      if (distinctEpisodeCount < this.deps.config.algorithm.l2Induction.minEpisodesForInduction) {
        continue;
      }

      const bucketTraceIds = bucket.map((trace) => trace.id);
      const byEpisode = new Map<string, TraceMeta>();
      for (const trace of bucket) {
        if (!trace.episodeId) continue;
        const previous = byEpisode.get(trace.episodeId);
        if (!previous || trace.value > previous.value || trace.priority > previous.priority) {
          byEpisode.set(trace.episodeId, trace);
        }
      }
      const promptEvidenceTraces = [...byEpisode.values()];
      const matchingPolicy = this.findExistingPolicyForL2Bucket(signature, bucket, source.userId);
      if (matchingPolicy) {
        for (const trace of bucket) {
          const similarity = tracePolicySimilarity(trace, matchingPolicy);
          this.deps.repos.runtime.insertTracePolicyLink({
            userId: source.userId,
            l1MemoryId: trace.id,
            l2MemoryId: matchingPolicy.id,
            relation: matchingPolicy.signature === signature ? "matches_signature" : "similar_pattern",
            strength: matchingPolicy.signature === signature ? 1 : similarity.score,
            createdAt: at
          });
        }
        this.markCandidatePoolPromoted(source.userId, signature, bucketTraceIds, matchingPolicy.id, at);
        this.recomputePolicyStats(matchingPolicy.id, source.userId, at, sourceTrace.episodeId);
        for (const episodeId of uniq(
          bucket.map((trace) => trace.episodeId).filter((id): id is string => Boolean(id))
        )) {
          this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", matchingPolicy.id, at);
        }
        continue;
      }

      const policyKey = `policy:${stableHash(signature).slice(0, 16)}`;
      const existingPolicyMemory = this.deps.repos.memories.getByKey(source.userId, "L2", policyKey);
      const existingPolicy = existingPolicyMemory && !this.isArchivedEvolutionMemory(existingPolicyMemory)
        ? policyMetaFromMemory(existingPolicyMemory)
        : null;

      const fallbackDraft = buildPolicyDraft({
        signature,
        evidenceTraces: bucket,
        allTraces: this.l2GainReferenceTraces(bucket, sourceTrace.episodeId),
        minSupport: this.deps.config.algorithm.l2Induction.minEpisodesForInduction,
        minGain: this.deps.config.algorithm.l2Induction.minGain,
        archiveGain: this.deps.config.algorithm.l2Induction.archiveGain,
        tauSoftmax: this.deps.config.algorithm.l2Induction.tauSoftmax,
        gainEmaAlpha: this.deps.config.algorithm.l2Induction.gainEmaAlpha,
        currentStatus: existingPolicy?.status,
        currentGain: existingPolicy?.gain,
        currentSupport: existingPolicy?.support
      });

      const enhancement = await this.enhancePolicyDraft(signature, promptEvidenceTraces, fallbackDraft);
      if (!enhancement.ok) {
        this.deps.enqueueChange({
          memoryId: source.id,
          namespaceId: sourceNamespaceId,
          kind: "policy",
          op: "skipped",
          entityId: source.id,
          userId: source.userId,
          changeType: "l2_induction_skipped",
          after: { signature, reason: enhancement.reason, traceIds: bucketTraceIds },
          source: "worker.l2_induction.v7",
          createdAt: at
        });
        continue;
      }

      const draft = {
        ...enhancement.draft,
        key: policyKey
      };

      const l2 = this.deps.buildMemory({
        userId: source.userId,
        conversationId: source.conversationId,
        sessionId: source.sessionId,
        agentId: source.agentId,
        appId: source.appId,
        projectId: this.deps.projectIdFromMemory(source),
        profileId: this.deps.profileIdFromMemory(source),
        layer: "L2",
        kind: "policy",
        lifecycleStatus: draft.status,
        memoryType: "LongTermMemory",
        key: draft.key,
        value: draft.body,
        tags: draft.tags,
        info: {
          signature,
          support: draft.support,
          gain: draft.gain,
          raw_gain: draft.rawGain,
          policy_confidence: draft.confidence,
          status: draft.status,
          source_memory_ids: draft.sourceTraceIds
        },
        internal: {
          source: "worker.l2_induction.v7",
          plugin_algorithm: "l2.induction.v7",
          source_memory_ids: draft.sourceTraceIds,
          source_l1_memory_ids: draft.sourceTraceIds,
          title: draft.title,
          trigger: draft.trigger,
          procedure: draft.procedure,
          verification: draft.verification,
          boundary: draft.boundary,
          support: draft.support,
          gain: draft.gain,
          raw_gain: draft.rawGain,
          policy_confidence: draft.confidence,
          status: draft.status,
          source_episode_ids: draft.sourceEpisodeIds,
          source_trace_ids: draft.sourceTraceIds,
          policy: {
            title: draft.title,
            trigger: draft.trigger,
            procedure: draft.procedure,
            verification: draft.verification,
            boundary: draft.boundary,
            support: draft.support,
            gain: draft.gain,
            raw_gain: draft.rawGain,
            policy_confidence: draft.confidence,
            status: draft.status,
            experience_type: "success_pattern",
            evidence_polarity: "positive",
            skill_eligible: true,
            signature,
            source_episode_ids: draft.sourceEpisodeIds,
            source_trace_ids: draft.sourceTraceIds,
            vec: draft.vec
          }
        },
        createdAt: at
      });

      const upsert = this.deps.upsertEvolutionMemory(l2);
      for (const episodeId of draft.sourceEpisodeIds) {
        this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", upsert.memory.id, at);
      }
      for (const trace of bucket) {
        this.deps.repos.runtime.insertTracePolicyLink({
          userId: source.userId,
          l1MemoryId: trace.id,
          l2MemoryId: upsert.memory.id,
          relation: "supports",
          strength: Math.max(0, trace.value),
          createdAt: at
        });
      }
      this.markCandidatePoolPromoted(source.userId, signature, bucketTraceIds, upsert.memory.id, at);

      this.deps.enqueueChange({
        memoryId: upsert.memory.id,
        namespaceId: this.deps.namespaceIdFromMemory(upsert.memory),
        kind: kindFromMemory(upsert.memory),
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId: source.userId,
        changeType: upsert.created ? "create" : "update",
        before: upsert.previous,
        after: upsert.memory,
        source: "worker.l2_induction.v7",
        createdAt: at
      });
      if (this.deps.config.algorithm.capture.embedAfterCapture) {
        this.deps.enqueueJob({
          jobType: "embedding",
          userId: source.userId,
          sessionId: source.sessionId,
          episodeId: sourceTrace.episodeId,
          targetMemoryId: upsert.memory.id,
          payload: { reason: "l2.upserted" },
          createdAt: at
        });
      }
      this.deps.enqueueJob({
        jobType: "l3_abstraction",
        userId: source.userId,
        sessionId: source.sessionId,
        episodeId: sourceTrace.episodeId,
        payload: {
          targetKind: "policy_cluster",
          seedPolicyId: upsert.memory.id,
          policyIds: [upsert.memory.id],
          signature
        },
        createdAt: at
      });
      this.deps.enqueueJob({
        jobType: "skill_crystallization",
        userId: source.userId,
        sessionId: source.sessionId,
        episodeId: sourceTrace.episodeId,
        targetMemoryId: upsert.memory.id,
        payload: { signature },
        createdAt: at
      });
    }
  }

  l2InductionSourceForJob(job: EvolutionJobRecord): MemoryRow | undefined {
    const payloadSourceMemoryId = typeof job.payload?.sourceMemoryId === "string"
      ? job.payload.sourceMemoryId
      : typeof job.payload?.l1MemoryId === "string"
      ? job.payload.l1MemoryId
      : undefined;
    const payloadSource = payloadSourceMemoryId ? this.deps.repos.memories.get(payloadSourceMemoryId) : undefined;
    if (payloadSource && this.deps.traceMeta(payloadSource)) {
      return payloadSource;
    }
    const legacyTarget = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    if (legacyTarget && this.deps.traceMeta(legacyTarget)) {
      return legacyTarget;
    }
    return payloadSource ?? legacyTarget;
  }

  associateL2(job: EvolutionJobRecord): void {
    const source = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    if (!source) return;
    const trace = this.deps.traceMeta(source);
    if (!trace || !this.isTraceEligibleForL2(trace)) return;
    const signature = signatureFromTrace(trace);
    const policies = this.deps.repos.memories
      .list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 1000)
      .map((policyMemory) => policyMetaFromMemory(policyMemory))
      .filter((policy): policy is PolicyMeta => Boolean(policy));

    const at = this.deps.nowIso();
    let best: { policy: PolicyMeta; similarity: ReturnType<typeof tracePolicySimilarity> } | null = null;
    for (const policy of policies) {
      const similarity = tracePolicySimilarity(trace, policy);
      if (!best || similarity.score > best.similarity.score) {
        best = { policy, similarity };
      }
    }
    if (!best || best.similarity.score < this.deps.config.algorithm.l2Induction.minSimilarity) {
      return;
    }

    const matchedPolicy = best.policy;
    this.deps.repos.runtime.insertTracePolicyLink({
      userId: source.userId,
      l1MemoryId: source.id,
      l2MemoryId: matchedPolicy.id,
      relation: matchedPolicy.signature === signature ? "matches_signature" : "similar_pattern",
      strength: best.similarity.cosine,
      createdAt: at
    });
    if (trace.episodeId) {
      this.deps.repos.runtime.appendEpisodeDerivedMemory(trace.episodeId, "L2", matchedPolicy.id, at);
    }
    this.recomputePolicyStats(matchedPolicy.id, source.userId, at, trace.episodeId);
  }

  async enhancePolicyDraft(
    signature: string,
    evidenceTraces: TraceMeta[],
    fallback: PolicyDraft
  ): Promise<PolicyEnhancementResult> {
    if (!this.deps.config.algorithm.l2Induction.useLlm || !this.deps.skillLlm.isConfigured()) {
      return { ok: false, reason: "llm_disabled" };
    }

    try {
      const result = await this.deps.skillLlm.completeJson<{
        title?: unknown;
        trigger?: unknown;
        action?: unknown;
        procedure?: unknown;
        verification?: unknown;
        boundary?: unknown;
        rationale?: unknown;
        caveats?: unknown;
        confidence?: unknown;
        support_trace_ids?: unknown;
        tags?: unknown;
      }>([
        {
          role: "system",
          content: L2_INDUCTION_PROMPT.system
        },
        {
          role: "system",
          content: languageSteeringLine(detectDominantLanguage(evidenceTraces.flatMap((trace) => [
            trace.userText,
            trace.agentText,
            trace.reflection
          ])))
        },
        {
          role: "user",
          content: packL2InductionTraces(
            evidenceTraces,
            this.deps.config.algorithm.l2Induction.traceCharCap,
            signature
          )
        }
      ], {
        operation: `${L2_INDUCTION_PROMPT.id}.v${L2_INDUCTION_PROMPT.version}`,
        thinkingMode: "enabled",
        temperature: 0.1,
        maxTokens: 1200
      });

      const invalidReason = l2InductionInvalidReason(result);
      if (invalidReason) {
        return { ok: false, reason: invalidReason };
      }

      const boundary = typeof result.boundary === "string" ? skillMarkdown(result.boundary) : "";
      const procedure = skillMarkdown(firstString(result.procedure, result.action));
      const verification = typeof result.verification === "string" ? skillMarkdown(result.verification) : "";
      const next = {
        ...fallback,
        title: skillText(result.title),
        trigger: skillMarkdown(result.trigger),
        procedure,
        verification,
        boundary,
        confidence: clampNumber(numberOr(result.confidence, fallback.confidence), 0, 1)
      };

      return {
        ok: true,
        draft: {
          ...next,
          body: renderPolicyBody(next)
        }
      };
    } catch (error) {
      return {
        ok: false,
        reason: `llm-failed: ${errorMessageFromUnknown(error) ?? "unknown"}`
      };
    }
  }

  private findExistingPolicyForL2Bucket(
    signature: string,
    evidenceTraces: TraceMeta[],
    userId: string
  ): PolicyMeta | null {
    if (evidenceTraces.length === 0) return null;
    const policies = this.deps.repos.memories
      .list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 1000)
      .map((policy) => policyMetaFromMemory(policy))
      .filter((policy): policy is PolicyMeta => Boolean(policy));

    let best: { policy: PolicyMeta; score: number } | null = null;

    for (const policy of policies) {
      const scores = evidenceTraces
        .map((trace) => {
          if (policy.signature === signature) return 1;
          const similarity = tracePolicySimilarity(trace, policy);
          return similarity.score >= this.deps.config.algorithm.l2Induction.minSimilarity ? similarity.score : 0;
        })
        .filter((score) => score > 0);
      if (scores.length === 0) continue;
      const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      if (!best || avgScore > best.score) {
        best = { policy, score: avgScore };
      }
    }

    return best?.policy ?? null;
  }

  recomputePolicyStats(policyId: string, userId: string, at: string, triggerEpisodeId?: string): void {
    const memory = this.deps.repos.memories.get(policyId);
    if (!memory || memory.memoryLayer !== "L2") return;
    const policy = policyMetaFromMemory(memory);
    if (!policy) return;

    const linkedTraceIds = new Set(
      this.deps.repos.runtime
        .listTracePolicyLinks({ userId, l2MemoryId: policy.id, limit: 1000 })
        .map((link) => link.l1MemoryId)
    );

    const allTraces = this.deps.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .map((memory) => this.deps.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace && this.isTraceEligibleForL2(trace))
      );

    const linkedTraces = allTraces.filter((trace) => linkedTraceIds.has(trace.id));
    const evidenceTraces = linkedTraces;
    if (evidenceTraces.length === 0) return;

    const gainReferenceTraces = this.l2GainReferenceTraces(evidenceTraces, triggerEpisodeId);
    const stats = buildPolicyDraft({
      signature: policy.signature,
      evidenceTraces,
      allTraces: gainReferenceTraces,
      minSupport: this.deps.config.algorithm.l2Induction.minEpisodesForInduction,
      minGain: this.deps.config.algorithm.l2Induction.minGain,
      archiveGain: this.deps.config.algorithm.l2Induction.archiveGain,
      tauSoftmax: this.deps.config.algorithm.l2Induction.tauSoftmax,
      gainEmaAlpha: this.deps.config.algorithm.l2Induction.gainEmaAlpha,
      currentStatus: policy.status,
      currentGain: policy.gain,
      currentSupport: policy.support
    });

    const previous = memory;
    const next = updatePolicyStats(memory, {
      support: stats.support,
      gain: stats.gain,
      rawGain: stats.rawGain,
      status: stats.status,
      sourceEpisodeIds: stats.sourceEpisodeIds,
      sourceTraceIds: stats.sourceTraceIds,
      updatedAt: at
    });

    const saved = this.deps.repos.memories.update(next);
    for (const episodeId of stats.sourceEpisodeIds) {
      this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", saved.id, at);
    }

    this.deps.enqueueChange({
      memoryId: saved.id,
      namespaceId: this.deps.namespaceIdFromMemory(saved),
      kind: kindFromMemory(saved),
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "policy_stats_update",
      before: previous,
      after: saved,
      source: "worker.l2_association.v7",
      createdAt: at
    });

    const savedPolicy = policyMetaFromMemory(saved);
    if (savedPolicy) {
      if (savedPolicy.status === "active") {
        this.deps.enqueueJob({
          jobType: "l3_abstraction",
          userId: saved.userId,
          sessionId: saved.sessionId,
          episodeId: triggerEpisodeId,
          payload: {
            reason: "l2.policy.updated",
            targetKind: "policy_cluster",
            seedPolicyId: saved.id,
            policyIds: [saved.id],
            previousStatus: policy.status,
            status: savedPolicy.status
          },
          createdAt: at
        });
        this.deps.enqueueJob({
          jobType: "skill_crystallization",
          userId: saved.userId,
          sessionId: saved.sessionId,
          episodeId: triggerEpisodeId,
          targetMemoryId: saved.id,
          payload: {
            reason: "l2.policy.updated",
            previousStatus: policy.status,
            status: savedPolicy.status
          },
          createdAt: at
        });
      }
      this.deps.onSkillRewardDrift(savedPolicy, at);
    }
  }

  private l2GainReferenceTraces(evidenceTraces: TraceMeta[], triggerEpisodeId?: string): TraceMeta[] {
    const episodeIds = new Set(
      evidenceTraces
        .map((trace) => trace.episodeId)
        .filter((episodeId): episodeId is string => Boolean(episodeId))
    );
    if (triggerEpisodeId) {
      episodeIds.add(triggerEpisodeId);
    }

    const byId = new Map<string, TraceMeta>();
    for (const trace of evidenceTraces) {
      byId.set(trace.id, trace);
    }

    if (episodeIds.size === 0) {
      return [...byId.values()];
    }

    for (const trace of this.deps.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 2000)
      .map((memory) => this.deps.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace && trace.episodeId && episodeIds.has(trace.episodeId) && Number.isFinite(trace.value))
      )) {
      byId.set(trace.id, trace);
    }

    return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  recordCandidatePoolTrace(
    trace: TraceMeta,
    signature: string,
    at: string
  ): void {
    const id = l2CandidateIdFor(signature, trace.id);
    this.deps.repos.runtime.upsertCandidatePoolTrace({
      id,
      userId: trace.userId,
      sessionId: trace.sessionId,
      sourceMemoryId: trace.id,
      candidateKey: signature,
      candidateValue: trace.summary,
      score: trace.priority,
      evidence: {
        traceId: trace.id,
        episodeId: trace.episodeId,
        value: trace.value,
        priority: trace.priority,
        tags: trace.tags
      },
      createdAt: at,
      updatedAt: at,
      expiresAt: this.candidateExpiresAt(at)
    });
  }

  isTraceEligibleForL2(trace: TraceMeta): boolean {
    return trace.value >= this.deps.config.algorithm.l2Induction.minTraceValue &&
      Boolean(trace.vecSummary ?? trace.vecAction);
  }

  private markCandidatePoolPromoted(
    userId: string,
    signature: string,
    sourceMemoryIds: string[],
    policyId: string,
    at: string
  ): void {
    this.deps.repos.runtime.markCandidatePoolPromoted({
      userId,
      candidateKey: signature,
      sourceMemoryIds,
      policyId,
      at
    });
  }

  private candidateExpiresAt(at: string): string {
    const ttlMs = this.deps.config.algorithm.l2Induction.candidateTtlDays * 24 * 60 * 60 * 1000;
    return new Date(Date.parse(at) + ttlMs).toISOString();
  }

  private isArchivedEvolutionMemory(memory: MemoryRow): boolean {
    if (memory.status === "archived") return true;
    if (memory.memoryLayer === "L2") {
      return policyMetaFromMemory(memory)?.status === "archived";
    }
    if (memory.memoryLayer === "Skill") {
      return skillMetaFromMemory(memory)?.status === "archived";
    }
    return false;
  }
}

export function updatePolicyStats(memory: MemoryRow, input: {
  support: number;
  gain: number;
  rawGain: number;
  status: PolicyLifecycleStatus;
  sourceEpisodeIds: string[];
  sourceTraceIds: string[];
  updatedAt: string;
}): MemoryRow {
  const currentPolicy = policyMetaFromMemory(memory);
  const internalPolicy = isRecord(memory.properties.internal_info.policy)
    ? memory.properties.internal_info.policy
    : {};

  const status = memoryStatusForLifecycleStatus(input.status);
  const nextPolicy = {
    ...internalPolicy,
    support: input.support,
    gain: input.gain,
    raw_gain: input.rawGain,
    status: input.status,
    source_episode_ids: input.sourceEpisodeIds,
    source_trace_ids: input.sourceTraceIds
  };

  const body = currentPolicy
    ? renderPolicyBody({
        title: currentPolicy.title,
        trigger: currentPolicy.trigger,
        procedure: currentPolicy.procedure,
        verification: currentPolicy.verification,
        boundary: currentPolicy.boundary,
        support: input.support,
        gain: input.gain,
        rawGain: input.rawGain,
        confidence: currentPolicy.confidence,
        sourceTraceIds: input.sourceTraceIds
      })
    : memory.memoryValue;

  return {
    ...memory,
    status,
    memoryValue: body,
    info: {
      ...memory.info,
      support: input.support,
      gain: input.gain,
      raw_gain: input.rawGain,
      policy_confidence: currentPolicy?.confidence,
      status: input.status,
      source_memory_ids: input.sourceTraceIds
    },
    properties: {
      ...memory.properties,
      status,
      info: {
        ...(memory.properties?.info ?? {}),
        support: input.support,
        gain: input.gain,
        raw_gain: input.rawGain,
        policy_confidence: currentPolicy?.confidence,
        status: input.status,
        source_memory_ids: input.sourceTraceIds
      },
      internal_info: {
        ...(memory.properties?.internal_info ?? {}),
        source_memory_ids: input.sourceTraceIds,
        source_l1_memory_ids: input.sourceTraceIds,
        support: input.support,
        gain: input.gain,
        raw_gain: input.rawGain,
        policy_confidence: currentPolicy?.confidence,
        status: input.status,
        source_episode_ids: input.sourceEpisodeIds,
        source_trace_ids: input.sourceTraceIds,
        policy: nextPolicy
      }
    },
    updatedAt: input.updatedAt
  };
}

function renderPolicyBody(draft: Pick<PolicyDraft, "title" | "trigger" | "procedure" | "verification" | "boundary" | "support" | "gain" | "rawGain" | "confidence" | "sourceTraceIds">): string {
  return [
    draft.title,
    `Trigger: ${draft.trigger}`,
    `Procedure: ${draft.procedure}`,
    `Verification: ${draft.verification}`,
    `Boundary: ${draft.boundary}`,
    `Support: ${draft.support}`,
    `Gain: ${roundNumber(draft.gain)}`,
    `Raw gain: ${roundNumber(draft.rawGain)}`,
    `Confidence: ${roundNumber(draft.confidence)}`,
    `Evidence: ${draft.sourceTraceIds.join(", ")}`
  ].join("\n");
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function l2InductionInvalidReason(result: unknown): string | null {
  if (!isRecord(result)) return "llm-failed: l2.induction.invalid: non-object output";
  if (!firstString(result.title)) return "llm-failed: l2.induction.invalid: missing title";
  if (!firstString(result.trigger)) return "llm-failed: l2.induction.invalid: missing trigger";
  if (!firstString(result.procedure, result.action)) {
    return "llm-failed: l2.induction.invalid: missing procedure";
  }
  return null;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}


function skillText(value: unknown): string {
  return stripDangerousMarkdownLinks(stripUnsafeHtml(skillRawString(value)))
    .replace(SKILL_CONTROL_RE, "")
    .trim();
}

function skillMarkdown(value: unknown): string {
  return stripDangerousMarkdownLinks(stripDangerousHtmlBlocks(skillRawString(value)))
    .replace(SKILL_CONTROL_RE, "")
    .trim();
}

function skillRawString(value: unknown): string {
  return value == null ? "" : String(value);
}

const SKILL_HTML_BLOCK_RE = /<\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SKILL_DANGEROUS_TAG_RE = /<\/?\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>/gi;
const SKILL_HTML_TAG_RE = /<\/?[a-z][a-z0-9:-]*(?:\s+[^<>]*)?>/gi;
const SKILL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SKILL_MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(((?:\\.|[^()\n]|\([^()\n]*\))+\))/g;

function stripUnsafeHtml(text: string): string {
  return text
    .replace(SKILL_HTML_BLOCK_RE, "")
    .replace(SKILL_HTML_TAG_RE, "");
}

function stripDangerousHtmlBlocks(text: string): string {
  return text.replace(SKILL_HTML_BLOCK_RE, "").replace(SKILL_DANGEROUS_TAG_RE, "");
}

function stripDangerousMarkdownLinks(text: string): string {
  return text.replace(
    SKILL_MARKDOWN_LINK_RE,
    (_match, bang: string, label: string, rawUrl: string) => {
      const url = rawUrl.trim();
      const firstToken = url.split(/\s+/)[0] ?? "";
      if (!isSafeLinkTarget(firstToken)) return `${bang}${label}`;
      return `${bang}[${label}](${url})`;
    }
  );
}

function isSafeLinkTarget(raw: string): boolean {
  const target = raw.trim().replace(/^['"<]+|[>"']+$/g, "");
  if (!target) return false;
  if (target.startsWith("#") || target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) {
    return true;
  }
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function roundNumber(value: number, digits = 4): number {
  const base = Math.pow(10, digits);
  return Math.round(value * base) / base;
}

function memoryStatusForLifecycleStatus(status: PolicyLifecycleStatus): "activated" | "resolving" | "archived" {
  if (status === "archived") return "archived";
  return status === "candidate" ? "resolving" : "activated";
}

function errorMessageFromUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const message = value.error ?? value.message;
    if (typeof message === "string") return message;
  }
  return undefined;
}
