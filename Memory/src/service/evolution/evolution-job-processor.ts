import {
  policyMetaFromMemory,
  skillMetaFromMemory,
  traceMetaFromMemory,
  worldModelMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import type {
  EpisodeRecord,
  EvolutionJobRecord,
  Repositories
} from "../../storage/repositories.js";
import type { MemoryRow,ToolCallPayload } from "../../types.js";
import { newId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import type { ScheduleEmbeddingAfterTextUpdateInput } from "../embedding/embedding-job-processor.js";
import type {
  DecisionRepairTraceSource,
  SynthesizeDecisionRepairDraft
} from "../feedback/feedback-experience.js";
import {
  profileIdFromMemory,
  projectIdFromMemory
} from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { L3WorldModelTraceFieldPipeline } from "./l3-world-model-pipeline.js";
import { NegativeExperiencePipeline } from "./negative-experience-pipeline.js";
import { BigTurnSpanPipeline } from "./big-turn-span-pipeline.js";
import { PolicyInductionEngine } from "./policy-induction.js";
import {
  RewardPipeline,
  type DecisionRepairSummary
} from "./reward-pipeline.js";
import { SkillPipeline } from "./skill-pipeline.js";
import { SpanPipeline } from "./span-pipeline.js";
import type { TurnMemoryCaptureDecision } from "./span-pipeline.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;

export interface PolicyEvidencePreflightReport {
  orphanPolicyIds: string[];
  affectedWorldModelIds: string[];
  affectedSkillIds: string[];
  restorablePolicyIds: string[];
}

export interface EvolutionJobProcessorDeps {
  repos: Repositories;
  config: MemmyConfig;
  llm: LlmClient;
  skillLlm: LlmClient;
  traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null;
  namespaceIdFromMemory(memory: MemoryRow): string;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  enqueueEpisodeRewardAfterReflection(
    episode: EpisodeRecord,
    at: string,
    trigger: string
  ): EvolutionJobRecord[];
  finalizeClosedEpisode(
    episode: EpisodeRecord,
    at: string,
    trigger: "episode_rewarded"
  ): EvolutionJobRecord[];
  resolvePendingSkillTrialsForReward(input: {
    userId: string;
    episodeId: string;
    rHuman: number;
    feedbackId?: string;
    at: string;
  }): void;
  decisionRepairTraceSources(memories: MemoryRow[]): DecisionRepairTraceSource[];
  synthesizeDecisionRepairDraft: SynthesizeDecisionRepairDraft;
  scheduleEmbeddingAfterTextUpdate(input: ScheduleEmbeddingAfterTextUpdateInput): void;
  repairEvidenceValueDiff(highValue: MemoryRow[], lowValue: MemoryRow[]): number;
}

export class EvolutionJobProcessor {
  private readonly policy: PolicyInductionEngine;
  private readonly negativeExperience: NegativeExperiencePipeline;
  private readonly reward: RewardPipeline;
  private readonly skill: SkillPipeline;
  private readonly span: SpanPipeline;
  private readonly bigTurnSpan: BigTurnSpanPipeline;
  private readonly l3WorldModel: L3WorldModelTraceFieldPipeline;

  constructor(private readonly deps: EvolutionJobProcessorDeps) {
    const owner = this;
    this.skill = new SkillPipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      get skillLlm() { return owner.deps.skillLlm; },
      traceMeta: deps.traceMeta,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      isArchivedEvolutionMemory: this.isArchivedEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory
    });
    this.policy = new PolicyInductionEngine({
      get config() { return owner.deps.config; },
      repos: deps.repos,
      nowIso,
      get skillLlm() { return owner.deps.skillLlm; },
      traceMeta: deps.traceMeta,
      projectIdFromMemory,
      profileIdFromMemory,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      enqueueChange: deps.repos.runtime.appendChange.bind(deps.repos.runtime),
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      onSkillRewardDrift: this.skill.applySkillRewardDriftForPolicy.bind(this.skill)
    });
    this.l3WorldModel = new L3WorldModelTraceFieldPipeline({
      repos: deps.repos,
      get skillLlm() { return owner.deps.skillLlm; }
    });
    this.span = new SpanPipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      get llm() { return owner.deps.llm; },
      get skillLlm() { return owner.deps.skillLlm; },
      traceMeta: deps.traceMeta,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      enqueueJob: deps.enqueueJob,
      enqueueEpisodeRewardAfterReflection: deps.enqueueEpisodeRewardAfterReflection,
      scheduleEmbeddingAfterTextUpdate: deps.scheduleEmbeddingAfterTextUpdate
    });
    this.bigTurnSpan = new BigTurnSpanPipeline({
      repos: deps.repos,
      get llm() { return owner.deps.llm; },
      buildMemory: deps.buildMemory,
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      embedAfterCapture: () => owner.deps.config.algorithm.capture.embedAfterCapture
    });
    this.reward = new RewardPipeline({
      get config() { return owner.deps.config; },
      repos: deps.repos,
      get llm() { return owner.deps.llm; },
      nowIso,
      newId,
      traceMeta: deps.traceMeta,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      enqueueJob: deps.enqueueJob,
      finalizeClosedEpisode: deps.finalizeClosedEpisode,
      resolvePendingSkillTrialsForReward: deps.resolvePendingSkillTrialsForReward,
      decisionRepairTraceSources: deps.decisionRepairTraceSources,
      synthesizeDecisionRepairDraft: deps.synthesizeDecisionRepairDraft,
      isTraceEligibleForL2: this.policy.isTraceEligibleForL2.bind(this.policy),
      recordCandidatePoolTrace: this.policy.recordCandidatePoolTrace.bind(this.policy),
      repairEvidenceValueDiff: deps.repairEvidenceValueDiff
    });
    this.negativeExperience = new NegativeExperiencePipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory
    });
  }

  induceL2(job: EvolutionJobRecord): Promise<void> {
    return this.policy.induceL2(job);
  }

  associateL2(job: EvolutionJobRecord): void {
    return this.policy.associateL2(job);
  }

  abstractL3(job: EvolutionJobRecord): Promise<void> {
    void job;
    return Promise.resolve();
  }

  updateL3WorldModel(job: EvolutionJobRecord): Promise<void> {
    return this.l3WorldModel.updateField(job);
  }

  crystallizeSkill(job: EvolutionJobRecord): Promise<void> {
    return this.skill.crystallizeSkill(job);
  }

  reflectTrace(job: EvolutionJobRecord): Promise<void> {
    return this.span.reflectTrace(job);
  }

  applyReward(job: EvolutionJobRecord): Promise<void> {
    return this.reward.applyReward(job);
  }

  splitBigTurn(job: EvolutionJobRecord): Promise<void> {
    return this.bigTurnSpan.splitAndStore(job);
  }

  materializeNegativeExperience(job: EvolutionJobRecord): void {
    this.negativeExperience.materialize(job);
  }

  summarizeTraceForCapture(input: {
    trace: TraceMeta;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
  }, options: { strict?: boolean } = {}): Promise<string> {
    return this.span.summarizeTraceForCapture(input, options);
  }

  decideTurnMemoryForCapture(input: {
    trace: TraceMeta;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
  }): Promise<TurnMemoryCaptureDecision> {
    return this.span.decideTurnMemoryForCapture(input);
  }

  findExistingSkillForPolicy(policy: PolicyMeta) {
    return this.skill.findExistingSkillForPolicy(policy);
  }

  previewPolicyEvidenceReconciliation(limit = 10000): PolicyEvidencePreflightReport {
    const orphanPolicyIds: string[] = [];
    const restorablePolicyIds: string[] = [];
    for (const { policy, linkedTraceIds, validTraces } of this.activePolicyEvidenceStates(limit)) {
      if (validTraces.length === 0) {
        orphanPolicyIds.push(policy.id);
      } else if (validTraces.some((trace) => !linkedTraceIds.has(trace.id))) {
        restorablePolicyIds.push(policy.id);
      }
    }

    const orphanIds = new Set(orphanPolicyIds);
    const affectedWorldModelIds = this.deps.repos.memories
      .list({ memoryLayer: "L3", status: ["activated", "resolving"] }, limit)
      .filter((memory) => worldModelMetaFromMemory(memory)?.policyIds.some((id) => orphanIds.has(id)))
      .map((memory) => memory.id);
    const affectedSkillIds = this.deps.repos.memories
      .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, limit)
      .filter((memory) => skillMetaFromMemory(memory)?.sourcePolicyIds.some((id) => orphanIds.has(id)))
      .map((memory) => memory.id);

    return {
      orphanPolicyIds: orphanPolicyIds.sort(),
      affectedWorldModelIds: affectedWorldModelIds.sort(),
      affectedSkillIds: affectedSkillIds.sort(),
      restorablePolicyIds: restorablePolicyIds.sort()
    };
  }

  reconcileOrphanedPolicies(at: string, limit = 10000): number {
    let reconciled = 0;
    for (const { memory, policy, linkedTraceIds, validTraces } of this.activePolicyEvidenceStates(limit)) {
      if (validTraces.length === 0) {
        const updated = this.policy.recomputePolicyStats(policy.id, at);
        if (updated && policyMetaFromMemory(updated)?.status !== "active") {
          this.invalidatePolicyDependencies(policy.id, at);
          reconciled += 1;
        }
        continue;
      }

      let restored = false;
      for (const trace of validTraces) {
        if (linkedTraceIds.has(trace.id)) continue;
        this.deps.repos.runtime.insertTracePolicyLink({
          userId: memory.userId,
          l1MemoryId: trace.id,
          l2MemoryId: policy.id,
          relation: "supports",
          strength: 1,
          createdAt: at
        });
        restored = true;
      }
      if (!restored) continue;
      this.deps.repos.runtime.appendChange({
        memoryId: memory.id,
        namespaceId: this.deps.namespaceIdFromMemory(memory),
        kind: "policy",
        op: "updated",
        entityId: memory.id,
        userId: memory.userId,
        changeType: "policy_evidence_links_restored",
        before: { linkedTraceIds: Array.from(linkedTraceIds) },
        after: { linkedTraceIds: validTraces.map((trace) => trace.id) },
        source: "startup.policy_evidence_reconciliation",
        createdAt: at
      });
      reconciled += 1;
    }
    return reconciled;
  }

  private activePolicyEvidenceStates(limit: number): Array<{
    memory: MemoryRow;
    policy: PolicyMeta;
    linkedTraceIds: Set<string>;
    validTraces: TraceMeta[];
  }> {
    return this.deps.repos.memories
      .list({ memoryLayer: "L2", status: "activated" }, limit)
      .map((memory) => ({ memory, policy: policyMetaFromMemory(memory) }))
      .filter((item): item is { memory: MemoryRow; policy: PolicyMeta } =>
        item.policy?.status === "active"
      )
      .map(({ memory, policy }) => {
        const linkedTraceIds = new Set(this.deps.repos.runtime.listTracePolicyLinks({
          l2MemoryId: policy.id,
          limit: 1000
        }).map((link) => link.l1MemoryId));
        const candidateTraceIds = Array.from(new Set([
          ...policy.sourceTraceIds,
          ...linkedTraceIds
        ]));
        const validTraces = this.deps.repos.memories
          .getMany(candidateTraceIds)
          .map((candidate) => this.deps.traceMeta(candidate))
          .filter((trace): trace is TraceMeta => Boolean(
            trace && this.policy.isTraceEligibleForL2(trace)
          ));
        return { memory, policy, linkedTraceIds, validTraces };
      });
  }

  invalidateMemoryDependencies(memory: MemoryRow, at: string): void {
    if (memory.memoryLayer === "L1") {
      const policyIds = Array.from(new Set(
        this.deps.repos.runtime
          .listTracePolicyLinks({ l1MemoryId: memory.id, limit: 1000 })
          .map((link) => link.l2MemoryId)
      ));
      for (const policyId of policyIds) {
        const updated = this.policy.recomputePolicyStats(policyId, at);
        const updatedPolicy = updated ? policyMetaFromMemory(updated) : null;
        if (updatedPolicy?.status !== "active") {
          this.invalidatePolicyDependencies(policyId, at);
        }
      }
      return;
    }
    if (memory.memoryLayer === "L2") {
      this.invalidatePolicyDependencies(memory.id, at);
    }
  }

  private invalidatePolicyDependencies(policyId: string, at: string): void {
    this.skill.invalidatePolicySource(policyId, at);
  }

  upsertEvolutionMemory(memory: MemoryRow): {
    memory: MemoryRow;
    created: boolean;
    previous?: MemoryRow;
  } {
    const previous = memory.memoryKey
      ? this.deps.repos.memories.getByKey(memory.memoryLayer, memory.memoryKey)
      : undefined;
    if (previous && this.isArchivedEvolutionMemory(previous)) {
      return {
        memory: this.deps.repos.memories.insert(memory),
        created: true
      };
    }
    return this.deps.repos.memories.upsertByKey(memory);
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

export type { DecisionRepairSummary };
