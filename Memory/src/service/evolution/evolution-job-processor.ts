import {
  policyMetaFromMemory,
  skillMetaFromMemory,
  traceMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { Embedder, LlmClient } from "../../model/types.js";
import type {
  EpisodeRecord,
  EvolutionJobRecord,
  RawTurnRecord,
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
import { SkillClusterPipeline } from "./skill-cluster-pipeline.js";
import { SkillPipeline } from "./skill-pipeline.js";
import { SpanPipeline } from "./span-pipeline.js";
import type { TraceCaptureSummary, TurnMemoryCaptureDecision } from "./span-pipeline.js";
import type { TurnJudgeSnapshot, TurnJudgment } from "./turn-judge.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;

export interface EvolutionJobProcessorDeps {
  repos: Repositories;
  config: MemmyConfig;
  llm: LlmClient;
  skillLlm: LlmClient;
  embedder: Embedder;
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
  queryVector?(query: string): Promise<number[] | undefined>;
}

export class EvolutionJobProcessor {
  private readonly policy: PolicyInductionEngine;
  private readonly negativeExperience: NegativeExperiencePipeline;
  private readonly reward: RewardPipeline;
  private readonly skill: SkillPipeline;
  private readonly skillCluster: SkillClusterPipeline;
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
    this.skillCluster = new SkillClusterPipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      get skillLlm() { return owner.deps.skillLlm; },
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      queryVector: (query) => owner.deps.queryVector?.(query) ?? Promise.resolve(undefined)
    });
    this.policy = new PolicyInductionEngine({
      get config() { return owner.deps.config; },
      repos: deps.repos,
      nowIso,
      get skillLlm() { return owner.deps.skillLlm; },
      get embedder() { return owner.deps.embedder; },
      traceMeta: deps.traceMeta,
      projectIdFromMemory,
      profileIdFromMemory,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      enqueueChange: deps.repos.runtime.appendChange.bind(deps.repos.runtime),
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      onSkillRewardDrift: this.skill.applySkillRewardDriftForPolicy.bind(this.skill),
      onPolicyRevised: this.skill.suspendForPolicyRevision.bind(this.skill)
    });
    this.l3WorldModel = new L3WorldModelTraceFieldPipeline({
      repos: deps.repos,
      get skillLlm() { return owner.deps.skillLlm; },
      get language() { return owner.deps.config.language; }
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
      get config() { return owner.deps.config; },
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
      recomputePolicyStats: this.policy.recomputePolicyStats.bind(this.policy),
      repairEvidenceValueDiff: deps.repairEvidenceValueDiff
    });
    this.negativeExperience = new NegativeExperiencePipeline({
      repos: deps.repos,
      get config() { return owner.deps.config; },
      skillLlm: deps.skillLlm,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: this.upsertEvolutionMemory.bind(this),
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory
    });
  }

  induceL2(job: EvolutionJobRecord): Promise<void> {
    return this.policy.induceL2(job);
  }

  associateL2(job: EvolutionJobRecord): Promise<void> {
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

  assignSkillCluster(job: EvolutionJobRecord): Promise<void> {
    return this.skillCluster.assignCluster(job);
  }

  evolveSkillCluster(job: EvolutionJobRecord): Promise<void> {
    return this.skillCluster.evolveCluster(job);
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

  materializeNegativeExperience(job: EvolutionJobRecord): Promise<void> {
    return this.negativeExperience.materialize(job);
  }

  summarizeTraceForCapture(input: {
    trace: TraceMeta;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
  }, options: { strict?: boolean } = {}): Promise<TraceCaptureSummary> {
    return this.span.summarizeTraceForCapture(input, options);
  }

  decideTurnMemoryForCapture(input: {
    trace: TraceMeta;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
    mustKeep?: boolean;
  }): Promise<TurnMemoryCaptureDecision> {
    return this.span.decideTurnMemoryForCapture(input);
  }

  buildTurnJudgeSnapshot(input: {
    trace: TraceMeta;
    rawTurn: RawTurnRecord;
    mustKeep: boolean;
    catchUp?: boolean;
    at: string;
  }): TurnJudgeSnapshot {
    return this.span.buildTurnJudgeSnapshot(input);
  }

  judgeTurnForCapture(input: {
    trace: TraceMeta;
    rawTurn: RawTurnRecord;
    snapshot: TurnJudgeSnapshot;
  }): Promise<TurnJudgment> {
    return this.span.judgeTurnForCapture(input);
  }

  findExistingSkillForPolicy(policy: PolicyMeta) {
    return this.skill.findExistingSkillForPolicy(policy);
  }

  invalidateMemoryDependencies(memory: MemoryRow, at: string): void {
    if (memory.memoryLayer === "L1") {
      this.deps.repos.runtime.invalidateUnifiedL2Source(memory.id, memory.userId, at);
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
