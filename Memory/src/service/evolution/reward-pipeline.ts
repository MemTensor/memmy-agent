import {
  REWARD_R_HUMAN_PROMPT,
  backpropagateTraces,
  combineRewardAxes,
  heuristicHumanScore,
  signatureFromTrace,
  traceMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import { createMemoryLogger,memoryErrorFields } from "../../logging/logger.js";
import type { LlmClient } from "../../model/types.js";
import type {
  EpisodeRecord,
  EvolutionJobRecord,
  RawTurnRecord,
  Repositories
} from "../../storage/repositories.js";
import { kindFromMemory } from "../../storage/repositories.js";
import type { MemoryRow,ToolCallPayload } from "../../types.js";
import { stableHash,stableStringify } from "../../utils/id.js";
import { clip } from "../../utils/text.js";
import type {
  DecisionRepairLlmDraft,
  DecisionRepairSynthesisRequest,
  DecisionRepairTraceSource,
  SynthesizeDecisionRepairDraft
} from "../feedback/feedback-experience.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type HumanScoreResult = ReturnType<typeof heuristicHumanScore>;

const pipelineLogger = createMemoryLogger("pipeline");

export interface DecisionRepairSummary {
  repairId?: string;
  contextHash?: string;
  skipped?: boolean;
  reason?: string;
  attachedPolicyIds?: string[];
}

export interface RewardPipelineDeps {
  config: MemmyConfig;
  repos: Repositories;
  skillLlm: LlmClient;
  nowIso(): string;
  newId(prefix: string): string;
  traceMeta(memory: MemoryRow | null | undefined): TraceMeta | null;
  namespaceIdFromMemory(memory: MemoryRow): string;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  finalizeClosedEpisode(episode: EpisodeRecord, at: string, trigger: "episode_rewarded"): EvolutionJobRecord[];
  resolvePendingSkillTrialsForReward(input: {
    userId: string;
    episodeId: string;
    rHuman: number;
    feedbackId?: string;
    at: string;
  }): void;
  decisionRepairTraceSources(memories: MemoryRow[]): DecisionRepairTraceSource[];
  synthesizeDecisionRepairDraft: SynthesizeDecisionRepairDraft;
  attachRepairToPolicies(
    repairId: string,
    policyIds: string[],
    preference: string | undefined,
    antiPattern: string | undefined,
    at: string
  ): string[];
  isTraceEligibleForL2(trace: TraceMeta): boolean;
  recordCandidatePoolTrace(trace: TraceMeta, signature: string, at: string): void;
  repairEvidenceValueDiff(highValue: MemoryRow[], lowValue: MemoryRow[]): number;
}

export class RewardPipeline {
  constructor(private readonly deps: RewardPipelineDeps) {}

  async applyReward(job: EvolutionJobRecord): Promise<void> {
    const rewardSource = this.rewardSourceForJob(job);
    if (!rewardSource) return;
    const { source, trace } = rewardSource;
    const hasFeedbackSignal =
      typeof job.payload.polarity === "string" ||
      typeof job.payload.magnitude === "number" ||
      typeof job.payload.rationale === "string";
    const fallbackFeedback = heuristicHumanScore(hasFeedbackSignal
      ? [{
          channel: job.payload.channel === "implicit" ? "implicit" : "explicit",
          polarity: job.payload.polarity === "negative"
            ? "negative"
            : job.payload.polarity === "neutral"
            ? "neutral"
            : "positive",
          magnitude: typeof job.payload.magnitude === "number" ? job.payload.magnitude : 1,
          rationale: typeof job.payload.rationale === "string" ? job.payload.rationale : undefined
        }]
      : []);
    const episodeTraces = this.deps.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .map((memory) => this.deps.traceMeta(memory))
      .filter((item): item is TraceMeta => Boolean(item && item.episodeId === trace.episodeId))
      .sort((a, b) => a.ts - b.ts);
    const skipReason = hasFeedbackSignal
      ? null
      : rewardSkipReason(episodeTraces, this.deps.config.algorithm.reward);
    if (skipReason && trace.episodeId) {
      const previousEpisode = this.deps.repos.runtime.getEpisode(trace.episodeId);
      const scoredAt = this.deps.nowIso();
      const rewardDetail = {
        rHuman: 0,
        source: "heuristic",
        axes: { goalAchievement: 0, processQuality: 0, userSatisfaction: 0 },
        reason: skipReason,
        scoredAt,
        trigger: typeof job.payload.trigger === "string" ? job.payload.trigger : job.jobType,
        skipped: true,
        traceCount: 0,
        traceIds: []
      };
      const savedEpisode = this.deps.repos.runtime.updateEpisodeReward(trace.episodeId, {
        rTask: 0,
        rewardDetail,
        metaPatch: {
          ...(previousEpisode?.meta.closeReason === "finalized"
            ? {}
            : { closeReason: "abandoned", abandonReason: skipReason }),
          reward: rewardDetail
        }
      });
      if (savedEpisode) {
        this.deps.repos.runtime.appendChange({
          memoryId: savedEpisode.id,
          namespaceId: this.deps.namespaceIdFromMemory(source),
          kind: "episode",
          op: "updated",
          entityId: savedEpisode.id,
          userId: savedEpisode.userId,
          changeType: "episode_reward_skipped",
          before: previousEpisode,
          after: savedEpisode,
          source: "worker.reward.skip.v7",
          createdAt: savedEpisode.updatedAt
        });
      }
      return;
    }

    const feedback = await this.scoreFeedbackWithLlm({
      source,
      trace,
      episodeTraces,
      fallback: fallbackFeedback,
      payload: job.payload
    });
    let rewardedEpisode: EpisodeRecord | undefined;
    if (trace.episodeId) {
      const previousEpisode = this.deps.repos.runtime.getEpisode(trace.episodeId);
      const rewardDetail = {
        rHuman: feedback.rHuman,
        source: feedback.source,
        axes: feedback.axes,
        reason: feedback.reason,
        scoredAt: this.deps.nowIso(),
        trigger: typeof job.payload.trigger === "string"
          ? job.payload.trigger
          : typeof job.payload.reason === "string"
          ? job.payload.reason
          : job.jobType,
        traceCount: episodeTraces.length,
        traceIds: episodeTraces.map((item) => item.id)
      };
      const savedEpisode = this.deps.repos.runtime.updateEpisodeReward(trace.episodeId, {
        rTask: feedback.rHuman,
        rewardDetail,
        metaPatch: { reward: rewardDetail }
      });
      rewardedEpisode = savedEpisode;
      if (savedEpisode) {
        this.deps.repos.runtime.appendChange({
          memoryId: savedEpisode.id,
          namespaceId: this.deps.namespaceIdFromMemory(source),
          kind: "episode",
          op: "updated",
          entityId: savedEpisode.id,
          userId: savedEpisode.userId,
          changeType: "episode_reward_update",
          before: previousEpisode,
          after: savedEpisode,
          source: "worker.reward.backprop.v7",
          createdAt: savedEpisode.updatedAt
        });
      }
      this.deps.resolvePendingSkillTrialsForReward({
        userId: source.userId,
        episodeId: trace.episodeId,
        rHuman: feedback.rHuman,
        feedbackId: typeof job.payload.feedbackId === "string" ? job.payload.feedbackId : undefined,
        at: savedEpisode?.updatedAt ?? this.deps.nowIso()
      });
    }

    const updates = backpropagateTraces({
      traces: episodeTraces,
      rHuman: feedback.rHuman,
      gamma: this.deps.config.algorithm.reward.gamma,
      lambda: this.deps.config.algorithm.reward.lambda,
      delta: this.deps.config.algorithm.reward.delta,
      decayHalfLifeDays: this.deps.config.algorithm.reward.decayHalfLifeDays
    });
    const at = this.deps.nowIso();
    const l2Eligible: Array<{ memory: MemoryRow; trace: TraceMeta }> = [];
    for (const update of updates) {
      const current = this.deps.repos.memories.get(update.traceId);
      if (!current) continue;
      const previous = current;
      const saved = this.deps.repos.memories.update(updateTraceScore(current, {
        value: update.value,
        alpha: update.alpha,
        priority: update.priority,
        rHuman: feedback.rHuman,
        rewardReason: feedback.reason,
        sourceFeedbackId: typeof job.payload.feedbackId === "string" ? job.payload.feedbackId : undefined,
        updatedAt: at
      }));
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: this.deps.namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "reward_update",
        before: previous,
        after: saved,
        source: "worker.reward.backprop.v7",
        createdAt: at
      });
      const savedTrace = this.deps.traceMeta(saved);
      if (job.payload.downstreamScheduled !== true && savedTrace && this.deps.isTraceEligibleForL2(savedTrace)) {
        this.deps.recordCandidatePoolTrace(savedTrace, signatureFromTrace(savedTrace), at);
        l2Eligible.push({ memory: saved, trace: savedTrace });
        this.deps.enqueueJob({
          jobType: "l2_association",
          userId: saved.userId,
          sessionId: saved.sessionId,
          episodeId: trace.episodeId,
          targetMemoryId: saved.id,
          payload: { reason: "reward.updated" },
          createdAt: at
        });
      }
      await this.maybeCreateValueDistributionRepair(saved, at);
    }
    const inductionSeed = l2Eligible[0];
    if (job.payload.downstreamScheduled !== true && inductionSeed) {
      this.deps.enqueueJob({
        jobType: "l2_induction",
        userId: inductionSeed.memory.userId,
        sessionId: inductionSeed.memory.sessionId,
        episodeId: trace.episodeId,
        targetMemoryId: inductionSeed.memory.id,
        payload: {
          reason: "reward.updated",
          targetKind: "episode_candidate_pool",
          sourceMemoryId: inductionSeed.memory.id,
          episodeTraceIds: l2Eligible.map((item) => item.memory.id)
        },
        createdAt: at
      });
    }
    if (rewardedEpisode) this.deps.finalizeClosedEpisode(rewardedEpisode, at, "episode_rewarded");
  }

  async scoreFeedbackWithLlm(input: {
    source: MemoryRow;
    trace: TraceMeta;
    episodeTraces: TraceMeta[];
    fallback: HumanScoreResult;
    payload: Record<string, unknown>;
  }): Promise<HumanScoreResult> {
    if (!this.deps.config.algorithm.reward.llmScoring || !this.deps.skillLlm.isConfigured()) return input.fallback;
    try {
      const rawTurnId = rawTurnIdFromMemory(input.source);
      const rawTurn = rawTurnId ? this.deps.repos.runtime.getRawTurn(rawTurnId) : undefined;
      const episode = input.trace.episodeId ? this.deps.repos.runtime.getEpisode(input.trace.episodeId) : undefined;
      const rawTurns = episode
        ? this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, 100)
        : rawTurn ? [rawTurn] : [];
      const hostAgentContext = {
        hostAgentKind: input.source.agentId ?? undefined,
        hostAppId: input.source.appId ?? undefined,
        hostSessionId: input.source.sessionId ?? rawTurn?.sessionId,
        hostConversationId: input.source.conversationId ?? rawTurn?.conversationId
      };
      const result = await this.deps.skillLlm.completeJson<{
        goal_achievement?: unknown;
        process_quality?: unknown;
        user_satisfaction?: unknown;
        goalAchievement?: unknown;
        processQuality?: unknown;
        userSatisfaction?: unknown;
        label?: unknown;
        reason?: unknown;
      }>([
        { role: "system", content: REWARD_R_HUMAN_PROMPT.system },
        { role: "user", content: [
          "HOST_AGENT_CONTEXT:", stableStringify(hostAgentContext), "", "TASK_SUMMARY:",
          buildRewardTaskSummary({
            source: input.source,
            trace: input.trace,
            episode,
            rawTurns,
            episodeTraces: input.episodeTraces,
            maxChars: this.deps.config.algorithm.reward.summaryMaxChars,
            evaluator: {
              scorerProvider: this.deps.skillLlm.config.provider,
              scorerModel: this.deps.skillLlm.config.model
            }
          }),
          "", "FEEDBACK:", stableStringify(input.payload)
        ].join("\n\n") }
      ], {
        operation: `reward.${REWARD_R_HUMAN_PROMPT.id}.v${REWARD_R_HUMAN_PROMPT.version}`,
        thinkingMode: "disabled",
        temperature: 0,
        maxTokens: 700
      });
      const rawGoalAchievement = result.goal_achievement ?? result.goalAchievement;
      const rawProcessQuality = result.process_quality ?? result.processQuality;
      const rawUserSatisfaction = result.user_satisfaction ?? result.userSatisfaction;
      if (
        typeof rawGoalAchievement !== "number" || !Number.isFinite(rawGoalAchievement) ||
        typeof rawProcessQuality !== "number" || !Number.isFinite(rawProcessQuality) ||
        typeof rawUserSatisfaction !== "number" || !Number.isFinite(rawUserSatisfaction)
      ) {
        throw new Error("reward response missing valid scoring axes");
      }
      const goalAchievement = clampNumber(rawGoalAchievement, -1, 1);
      const processQuality = clampNumber(rawProcessQuality, -1, 1);
      const userSatisfaction = clampNumber(rawUserSatisfaction, -1, 1);
      return {
        rHuman: combineRewardAxes({ goalAchievement, processQuality, userSatisfaction }),
        axes: { goalAchievement, processQuality, userSatisfaction },
        reason: stringOr(result.reason, input.fallback.reason),
        source: "llm"
      };
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: `reward.${REWARD_R_HUMAN_PROMPT.id}.v${REWARD_R_HUMAN_PROMPT.version}`,
        pipeline: "reward.scoring",
        fallback: "heuristic_score",
        sourceMemoryId: input.source.id,
        ...memoryErrorFields(error)
      });
      return input.fallback;
    }
  }

  rewardSourceForJob(job: EvolutionJobRecord): { source: MemoryRow; trace: TraceMeta } | undefined {
    const direct = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    const directTrace = direct ? this.deps.traceMeta(direct) : null;
    if (direct && directTrace) return { source: direct, trace: directTrace };
    const payloadL1MemoryId = typeof job.payload.l1MemoryId === "string" ? job.payload.l1MemoryId : undefined;
    const payloadMemory = payloadL1MemoryId ? this.deps.repos.memories.get(payloadL1MemoryId) : undefined;
    const payloadTrace = payloadMemory ? this.deps.traceMeta(payloadMemory) : null;
    if (payloadMemory && payloadTrace) return { source: payloadMemory, trace: payloadTrace };
    if (!job.episodeId) return undefined;
    const episode = this.deps.repos.runtime.getEpisode(job.episodeId);
    const episodeMemories = episode?.l1MemoryIds.length
      ? this.deps.repos.memories.getMany(episode.l1MemoryIds)
      : this.deps.repos.memories.list({ memoryLayer: "L1", status: "activated" }, 1000);
    return episodeMemories
      .map((memory) => ({ source: memory, trace: this.deps.traceMeta(memory) }))
      .filter((item): item is { source: MemoryRow; trace: TraceMeta } => Boolean(item.trace && item.trace.episodeId === job.episodeId))
      .sort((a, b) => a.trace.ts - b.trace.ts)[0];
  }

  async maybeCreateValueDistributionRepair(triggerMemory: MemoryRow, at: string): Promise<DecisionRepairSummary | undefined> {
    const triggerTrace = this.deps.traceMeta(triggerMemory);
    if (!triggerTrace?.signature) return undefined;
    const evidence = this.valueDistributionRepairEvidence(triggerTrace, this.deps.config.algorithm.feedback.evidenceLimit);
    if (evidence.highValueMemories.length === 0 || evidence.lowValueMemories.length === 0) return undefined;
    const valueDiff = this.deps.repairEvidenceValueDiff(evidence.highValueMemories, evidence.lowValueMemories);
    if (valueDiff < this.deps.config.algorithm.feedback.valueDelta) return undefined;
    const contextHash = stableHash(`value-distribution:${triggerTrace.userId}:${triggerTrace.signature}`).slice(0, 16);
    const cooldownMs = this.deps.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(at) - cooldownMs).toISOString();
      const recent = this.deps.repos.runtime.listDecisionRepairs({ userId: triggerTrace.userId, contextHash, since, limit: 1 });
      if (recent.length > 0) return { contextHash, skipped: true, reason: "cooldown" };
    }
    const llmDraft = await this.maybeSynthesizeValueDistributionDecisionRepair(contextHash, triggerTrace, evidence);
    const preference = llmDraft?.preference ?? valueDistributionPreference(evidence.highValueMemories[0]);
    const antiPattern = llmDraft?.antiPattern ?? valueDistributionAntiPattern(evidence.lowValueMemories[0]);
    const session = triggerTrace.sessionId ? this.deps.repos.runtime.getSession(triggerTrace.sessionId) : undefined;
    const repair = this.deps.repos.runtime.insertDecisionRepair({
      id: this.deps.newId("repair"),
      sessionId: triggerTrace.sessionId,
      episodeId: triggerTrace.episodeId,
      rawTurnId: rawTurnIdFromMemory(triggerMemory),
      userId: triggerTrace.userId,
      projectId: session?.projectId ?? session?.workspaceId,
      contextHash,
      issue: `Divergent outcomes for context signature ${clip(triggerTrace.signature, 160)}`,
      suggestion: preference,
      preference,
      antiPattern,
      highValueMemoryIds: evidence.highValueMemories.map((memory) => memory.id),
      lowValueMemoryIds: evidence.lowValueMemories.map((memory) => memory.id),
      attachedPolicyMemoryIds: evidence.policyIds,
      validated: false,
      source: {
        source: "worker.reward.value_distribution_repair.v7",
        trigger: "value-distribution",
        ...(llmDraft ? { synthesis: "llm" } : {}),
        signature: triggerTrace.signature,
        valueDiff,
        triggerTraceId: triggerTrace.id
      },
      meta: {
        trigger: "value-distribution",
        severity: llmDraft?.severity ?? "warn",
        confidence: llmDraft?.confidence ?? (evidence.highValueMemories.length > 0 && evidence.lowValueMemories.length > 0 ? 0.6 : 0.4),
        valueDiff
      },
      createdAt: at
    });
    if (triggerTrace.episodeId) this.deps.repos.runtime.appendEpisodeDecisionRepair(triggerTrace.episodeId, repair.id, at);
    const attachedPolicyIds = evidence.policyIds.length > 0
      ? this.deps.attachRepairToPolicies(repair.id, evidence.policyIds, repair.preference, repair.antiPattern, at)
      : [];
    this.deps.repos.runtime.appendChange({
      memoryId: repair.id,
      namespaceId: this.deps.namespaceIdFromMemory(triggerMemory),
      userId: triggerTrace.userId,
      kind: "repair",
      op: "created",
      entityId: repair.id,
      changeType: "decision_repair_created",
      after: repair,
      source: "worker.reward.value_distribution_repair.v7",
      createdAt: at
    });
    return { repairId: repair.id, contextHash, skipped: false, attachedPolicyIds };
  }

  valueDistributionRepairEvidence(trace: TraceMeta, limit: number): {
    highValueMemories: MemoryRow[];
    lowValueMemories: MemoryRow[];
    policyIds: string[];
  } {
    const highValueMemories: MemoryRow[] = [];
    const lowValueMemories: MemoryRow[] = [];
    const policyIds = new Set<string>();
    const memories = this.deps.repos.memories.list({ userId: trace.userId, memoryLayer: "L1", status: "activated" }, 1000);
    for (const memory of memories) {
      const candidate = this.deps.traceMeta(memory);
      if (!candidate || candidate.signature !== trace.signature) continue;
      if (candidate.value > 0 && highValueMemories.length < limit) highValueMemories.push(memory);
      if (candidate.value < -this.deps.config.algorithm.feedback.minLowValueThreshold && lowValueMemories.length < limit) lowValueMemories.push(memory);
      if (highValueMemories.includes(memory) || lowValueMemories.includes(memory)) {
        for (const link of this.deps.repos.runtime.listTracePolicyLinks({ userId: trace.userId, l1MemoryId: memory.id, limit: 20 })) {
          policyIds.add(link.l2MemoryId);
        }
      }
    }
    highValueMemories.sort((a, b) => (this.deps.traceMeta(b)?.value ?? 0) - (this.deps.traceMeta(a)?.value ?? 0));
    lowValueMemories.sort((a, b) => (this.deps.traceMeta(a)?.value ?? 0) - (this.deps.traceMeta(b)?.value ?? 0));
    return {
      highValueMemories: highValueMemories.slice(0, limit),
      lowValueMemories: lowValueMemories.slice(0, limit),
      policyIds: [...policyIds].slice(0, limit)
    };
  }

  private async maybeSynthesizeValueDistributionDecisionRepair(
    contextHash: string,
    trace: TraceMeta,
    evidence: { highValueMemories: MemoryRow[]; lowValueMemories: MemoryRow[]; policyIds: string[] }
  ): Promise<DecisionRepairLlmDraft | undefined> {
    const request: DecisionRepairSynthesisRequest = {
      trigger: "value-distribution",
      contextHash,
      feedbackText: `Same context signature has divergent outcomes: ${trace.signature}`,
      classification: { shape: "negative", confidence: 0.6, avoid: trace.summary, text: trace.summary },
      highValue: this.deps.decisionRepairTraceSources(evidence.highValueMemories),
      lowValue: this.deps.decisionRepairTraceSources(evidence.lowValueMemories),
      traceCharCap: this.deps.config.algorithm.feedback.traceCharCap,
      diagnostics: {
        pipeline: "decision_repair.value_distribution",
        sourceMemoryId: trace.id
      }
    };
    return this.deps.synthesizeDecisionRepairDraft(request);
  }

}

export function buildRewardTaskSummary(input: {
  source: MemoryRow;
  trace: TraceMeta;
  episode?: EpisodeRecord;
  rawTurns: readonly RawTurnRecord[];
  episodeTraces: readonly TraceMeta[];
  maxChars: number;
  evaluator?: { scorerProvider?: string; scorerModel?: string };
}): string {
  const pairs = input.rawTurns.length
    ? input.rawTurns.map(rewardPairFromRawTurn).filter((pair): pair is RewardExchangePair => Boolean(pair))
    : input.episodeTraces.map(rewardPairFromTrace).filter((pair): pair is RewardExchangePair => Boolean(pair));
  const userQuery = pairs[0]?.userText || input.trace.userText || "(no user text)";
  const outcome = pairs[pairs.length - 1]?.agentText || input.trace.agentText || "(no agent text)";
  const hostContext = rewardHostAgentContext(input);
  const pairText = pairs.length
    ? pairs.map((pair, index) => rewardFormatPair(pair, index, index === pairs.length - 1)).join("\n\n")
    : "(no recorded exchanges)";
  const agentActions = input.episodeTraces.map((trace, index) => rewardTraceOneLiner(trace, index)).filter(Boolean).join("\n");
  const body = [
    hostContext ? "HOST_AGENT_CONTEXT:" : "", hostContext, hostContext ? "" : "",
    "EPISODE_MISSION:", rewardOneLine(rewardEpisodeMission(input.episode, userQuery), 800), "",
    `USER_ASKS_AND_AGENT_REPLIES (${pairs.length}, in order):`, pairText, "",
    `AGENT_STEPS (${input.episodeTraces.length}):`, agentActions || "(no recorded steps)", "",
    "MOST_RECENT_USER_ASK:", rewardOneLine(pairs[pairs.length - 1]?.userText || userQuery, 500), "",
    "MOST_RECENT_AGENT_REPLY:", rewardClampAgentText(pairs[pairs.length - 1]?.agentText || outcome), "",
    rewardExecutionOutcome(input.episodeTraces)
  ].join("\n");
  return rewardClampHeadTail(body, input.maxChars);
}

function rewardEpisodeMission(episode: EpisodeRecord | undefined, fallback: string): string {
  const meta = episode?.meta ?? {};
  const canonicalGoal = typeof meta.canonicalGoal === "string" ? meta.canonicalGoal.trim() : "";
  if (canonicalGoal) return canonicalGoal;
  const initialUserText = typeof meta.initialUserText === "string" ? meta.initialUserText.trim() : "";
  return initialUserText || fallback;
}

interface RewardExchangePair { userText: string; agentText: string; toolHint?: string }

function rewardPairFromRawTurn(rawTurn: RawTurnRecord): RewardExchangePair | null {
  const userText = rawTurn.userText?.trim() ?? "";
  const agentText = rawTurn.assistantText?.trim() ?? "";
  if (!userText && !agentText) return null;
  const toolHint = rawTurn.toolCalls.length
    ? rawTurn.toolCalls.map((call) => objectField(call, "name") ?? "tool").join(", ")
    : undefined;
  return { userText, agentText, toolHint };
}

function rewardPairFromTrace(trace: TraceMeta): RewardExchangePair | null {
  const userText = trace.userText.trim();
  const agentText = trace.agentText.trim();
  if (!userText && !agentText) return null;
  const toolHint = trace.toolCalls.length
    ? trace.toolCalls.map((call) => call.error ? `${call.name}[ERR:${call.error}]` : call.name).join(", ")
    : undefined;
  return { userText, agentText, toolHint };
}

function rewardFormatPair(pair: RewardExchangePair, index: number, isLast: boolean): string {
  const lines = [`[${index + 1}] USER: ${rewardOneLine(pair.userText, 300)}`];
  if (pair.toolHint) lines.push(`    TOOLS: ${pair.toolHint}`);
  lines.push(`    AGENT: ${isLast ? rewardClampAgentText(pair.agentText) : rewardOneLine(pair.agentText, 400)}`);
  return lines.join("\n");
}

function rewardTraceOneLiner(trace: TraceMeta, index: number): string {
  const toolNames = trace.toolCalls
    .map((call) => call.error ? `${call.name}[ERR:${call.error}]` : call.name)
    .filter(Boolean)
    .join(", ");
  const action = toolNames || rewardOneLine(trace.agentText, 120) || "(text only)";
  return `  ${index + 1}. ${action}`;
}

function rewardExecutionOutcome(traces: readonly TraceMeta[]): string {
  let totalToolCalls = 0;
  let successCount = 0;
  let errorCount = 0;
  let lastToolCall: ToolCallPayload | undefined;
  for (const trace of [...traces].sort((a, b) => a.ts - b.ts)) {
    for (const call of trace.toolCalls) {
      totalToolCalls += 1;
      if (call.error || call.errorCode || call.success === false) errorCount += 1;
      else successCount += 1;
      lastToolCall = call;
    }
  }
  const lines = ["EXECUTION_OUTCOME:"];
  if (!lastToolCall) {
    lines.push("  total_tool_calls: 0", "  last_tool_result: NONE", "  task_completed_by_tool: unknown");
    return lines.join("\n");
  }
  const failed = Boolean(lastToolCall.error || lastToolCall.errorCode || lastToolCall.success === false);
  lines.push(`  total_tool_calls: ${totalToolCalls}  (success: ${successCount}, error: ${errorCount})`);
  lines.push(`  last_tool_result: ${failed ? "ERROR" : "SUCCESS"}  [tool: ${lastToolCall.name}]${lastToolCall.errorCode ? `, code: ${lastToolCall.errorCode}` : ""}`);
  lines.push(`  task_completed_by_tool: ${failed ? "no" : "yes"}`);
  return lines.join("\n");
}

function rewardHostAgentContext(input: {
  source: MemoryRow;
  episode?: EpisodeRecord;
  evaluator?: { scorerProvider?: string; scorerModel?: string };
}): string {
  const meta = input.episode?.meta ?? {};
  const hints = isRecord(meta.contextHints) ? meta.contextHints : {};
  const fields: Array<[string, unknown]> = [
    ["agent", input.source.agentId],
    ["agentIdentity", hints.agentIdentity ?? meta.agentIdentity],
    ["hostProvider", hints.hostProvider ?? meta.hostProvider],
    ["hostModel", hints.hostModel ?? meta.hostModel],
    ["hostApiMode", hints.hostApiMode ?? meta.hostApiMode],
    ["scorerProvider", input.evaluator?.scorerProvider],
    ["scorerModel", input.evaluator?.scorerModel]
  ];
  const lines = fields
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key}: ${rewardOneLine(String(value), 240)}`);
  if (lines.length === 0) return "";
  lines.push("gradingInstruction: Evaluate the host agent's answer in this host context; do not project the evaluator model's own identity, provider, or capabilities onto the host agent.");
  return lines.join("\n");
}

export function rewardSkipReason(traces: readonly TraceMeta[], cfg: MemmyConfig["algorithm"]["reward"]): string | null {
  let userTurns = 0;
  let assistantTurns = 0;
  let toolTurns = 0;
  let contentChars = 0;
  const userContents: string[] = [];
  const assistantContents: string[] = [];
  for (const trace of traces) {
    const userText = trace.userText ?? "";
    const agentText = trace.agentText ?? "";
    if (userText.length > 0) { userTurns += 1; contentChars += userText.length; userContents.push(userText); }
    if (agentText.length > 0) { assistantTurns += 1; contentChars += agentText.length; assistantContents.push(agentText); }
    if (trace.toolCalls.length > 0) toolTurns += trace.toolCalls.length;
  }
  const exchanges = Math.min(userTurns, assistantTurns);
  if (exchanges < cfg.minExchangesForCompletion) return `对话轮次不足（${exchanges} 轮），需要至少 ${cfg.minExchangesForCompletion} 轮完整的问答交互才能生成摘要。`;
  if (userTurns === 0) return "该任务没有用户消息，仅包含系统或工具自动生成的内容。";
  const allText = (userContents.join("") + assistantContents.join("")).slice(0, 4000);
  const hasCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(allText);
  const minContentLen = hasCjk ? cfg.minContentCharsForCompletion : cfg.minContentCharsForCompletion * 2;
  if (contentChars < minContentLen) return `对话内容过短（${contentChars} 字符），信息量不足以生成有意义的摘要。`;
  const allUserText = userContents.join("\n");
  if (rewardLooksLikeTrivialContent(allUserText)) return "对话内容为简单问候或测试数据（如 hello、test、ok），无需生成摘要。";
  const allAssistantText = assistantContents.join("\n");
  if (rewardLooksLikeTrivialContent(`${allUserText}\n${allAssistantText}`)) return "对话内容（用户和助手双方）为简单问候或测试数据，无需生成摘要。";
  const totalTurns = userTurns + assistantTurns + toolTurns;
  const assistantContentChars = assistantContents.reduce((sum, value) => sum + value.length, 0);
  if (toolTurns > 0 && totalTurns > 0 && toolTurns >= totalTurns * cfg.toolHeavyRatio && userTurns <= 1 && assistantContentChars < cfg.minAssistantCharsForToolHeavy) {
    return `该任务主要由工具执行结果组成（${toolTurns}/${totalTurns} 条），缺少足够的用户交互内容。`;
  }
  if (userContents.length >= 3) {
    const uniqueUserMessages = new Set(userContents.map((value) => value.trim().toLowerCase()));
    if (uniqueUserMessages.size / userContents.length < 0.4) {
      return `对话中存在大量重复内容（${uniqueUserMessages.size} 条独立消息 / ${userContents.length} 条用户消息），无法提取有效信息。`;
    }
  }
  return null;
}

const REWARD_TRIVIAL_PATTERNS = [
  /^(test|testing|hello|hi|hey|ok|okay|yes|no|yeah|nope|sure|thanks|thank you|thx|ping|pong|哈哈|好的|嗯|是的|不是|谢谢|你好|测试)\s*[.!?。！？]*$/i,
  /^(aaa+|bbb+|xxx+|zzz+|123+|asdf+|qwer+|haha+|lol+|hmm+)\s*$/i,
  /^[\s\p{P}\p{S}]*$/u
];

function rewardLooksLikeTrivialContent(text: string): boolean {
  const lines = text.toLowerCase().split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  let trivialChars = 0;
  let nonTrivialChars = 0;
  for (const line of lines) {
    if (REWARD_TRIVIAL_PATTERNS.some((pattern) => pattern.test(line))) trivialChars += line.length;
    else nonTrivialChars += line.length;
  }
  if (nonTrivialChars >= 30) return false;
  const total = trivialChars + nonTrivialChars;
  return total === 0 || trivialChars / total > 0.7;
}

export function updateTraceScore(memory: MemoryRow, input: {
  value: number;
  alpha: number;
  priority: number;
  rHuman: number;
  rewardReason: string;
  sourceFeedbackId?: string;
  updatedAt: string;
}): MemoryRow {
  const trace = memory.properties.internal_info.trace;
  const sourceFeedbackIds = uniq([
    ...stringArray(memory.properties.internal_info.source_feedback_ids),
    ...(trace && typeof trace === "object" ? stringArray((trace as Record<string, unknown>).source_feedback_ids) : []),
    ...(input.sourceFeedbackId ? [input.sourceFeedbackId] : [])
  ]);
  const nextTrace = trace && typeof trace === "object"
    ? { ...(trace as Record<string, unknown>), value: input.value, alpha: input.alpha, priority: input.priority, r_human: input.rHuman, reward_reason: input.rewardReason, ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {}) }
    : { value: input.value, alpha: input.alpha, priority: input.priority, r_human: input.rHuman, reward_reason: input.rewardReason, ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {}) };
  return {
    ...memory,
    memoryValue: memory.memoryValue.replace(/Alpha: [^\n]+\nValue: [^\n]+\nPriority: [^\n]+$/, `Alpha: ${input.alpha}\nValue: ${input.value}\nPriority: ${input.priority}`),
    info: { ...memory.info, value: input.value, priority: input.priority, r_human: input.rHuman, ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {}) },
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {}),
        value: input.value,
        alpha: input.alpha,
        priority: input.priority,
        r_human: input.rHuman,
        trace: nextTrace
      }
    },
    updatedAt: input.updatedAt
  };
}

export function valueDistributionPreference(memory: MemoryRow | undefined): string {
  const trace = memory ? traceMetaFromMemory(memory) : null;
  const text = trace?.reflection ?? trace?.agentText ?? trace?.summary;
  return text ? `Prefer: ${clip(text, 200)}` : "Prefer the approach used by high-value traces in this context.";
}

export function valueDistributionAntiPattern(memory: MemoryRow | undefined): string {
  const trace = memory ? traceMetaFromMemory(memory) : null;
  const text = trace?.reflection ?? trace?.agentText ?? trace?.summary;
  return text ? `Avoid: ${clip(text, 200)}` : "Avoid repeating the low-value approach observed in this context.";
}

function rawTurnIdFromMemory(memory: MemoryRow): string | undefined {
  const sourceRawTurnId = memory.properties.internal_info.source_raw_turn_id;
  if (typeof sourceRawTurnId === "string" && sourceRawTurnId) return sourceRawTurnId;
  const rawTurnId = memory.properties.internal_info.raw_turn_id;
  if (typeof rawTurnId === "string" && rawTurnId) return rawTurnId;
  const trace = memory.properties.internal_info.trace;
  return isRecord(trace) && typeof trace.raw_turn_id === "string" ? trace.raw_turn_id : undefined;
}

function objectField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === "string" ? value[field] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rewardOneLine(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 3).trimEnd()}...`;
}

function rewardClampHeadTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length + 20) return value.slice(0, Math.max(0, maxChars - 3)) + "...";
  const headChars = Math.floor((maxChars - marker.length) * 0.55);
  const tailChars = Math.max(0, maxChars - marker.length - headChars);
  return `${value.slice(0, headChars).trimEnd()}${marker}${value.slice(value.length - tailChars).trimStart()}`;
}

function rewardClampAgentText(value: string): string { return rewardOneLine(value || "(no agent text)", 800); }
function clampNumber(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function stringOr(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function uniq<T>(values: T[]): T[] { return [...new Set(values)]; }
