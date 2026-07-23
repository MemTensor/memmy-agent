import {
  skillEtaAfterTrial,
  skillMetaFromMemory,
  skillStatusAfterTrial,
  traceMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import { isRecord } from "../../utils/json.js";
import {
  type MemmyConfig
} from "../../config/index.js";
import {
  Repositories,
  type EpisodeRecord,
  type EvolutionJobRecord,
  type FeedbackRecord,
  type RawTurnRecord,
  type SessionRecord,
  type SkillTrialRecord
} from "../../storage/repositories.js";
import type {
  MemoryRow,
  RuntimeNamespace,
  SkillUseRequest,
  ToolCallPayload
} from "../../types.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../../types.js";
import { MemoryServiceError } from "../../utils/error.js";
import { nowIso } from "../../utils/time.js";
import { recordApiLog } from "../model-audit/model-call-audit.js";
import {
  namespaceForMemory
} from "../namespace/namespace-scope.js";
import {
  skillBetaPosterior,
  skillSuccessRate
} from "../read-model/skill.js";


type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;

export interface SkillTrialResolverDeps {
  repos: Repositories;
  readonly config: MemmyConfig;
  requireRawTurn(id: string): RawTurnRecord;
  assertRawTurnInScope(rawTurn: RawTurnRecord, namespace?: RuntimeNamespace): void;
  requireExistingMemory(id: string): MemoryRow;
  assertMemoryInScope(memory: MemoryRow, namespace?: RuntimeNamespace): void;
  traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null;
  feedbackTargetFromRawTurn(rawTurn: RawTurnRecord): MemoryRow | undefined;
}

export class SkillTrialResolver {
  constructor(private readonly deps: SkillTrialResolverDeps) {}

resolveSkillTrial(job: EvolutionJobRecord): void {
    const trialId = typeof job.payload.trialId === "string" ? job.payload.trialId : undefined;
    const trial = trialId ? this.deps.repos.runtime.getSkillTrial(trialId) : undefined;
    if (!trial || trial.status !== "pending") {
      return;
    }
    const feedback = this.feedbackForTrial(trial, job.payload);
    const outcome = this.outcomeForSkillTrial(trial, job.payload, feedback);
    if (!outcome) {
      return;
    }
    const at = nowIso();
    const updatedTrial = this.deps.repos.runtime.updateSkillTrial({
      ...trial,
      status: skillTrialStatusFromOutcome(outcome),
      outcome,
      feedbackId: feedback?.id,
      resolvedAt: at
    });
    const skillMemoryForTrial = this.deps.repos.memories.get(updatedTrial.skillMemoryId);
    this.deps.repos.runtime.appendChange({
      memoryId: updatedTrial.skillMemoryId,
      namespaceId: skillMemoryForTrial
        ? namespaceIdFromMemory(skillMemoryForTrial)
        : namespaceIdFromContext({ source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", userId: updatedTrial.userId }),
      kind: "skill_trial",
      op: "updated",
      entityId: updatedTrial.id,
      userId: updatedTrial.userId,
      changeType: "skill_trial_resolved",
      before: trial,
      after: updatedTrial,
      source: "worker.skill_trial_resolve",
      createdAt: at
    });
    if (outcome !== "unknown") {
      this.updateSkillTrialStats(updatedTrial, at);
    }
  }

feedbackForTrial(
    trial: SkillTrialRecord,
    payload: Record<string, unknown>
  ): FeedbackRecord | undefined {
    const feedbackId = typeof payload.feedbackId === "string" ? payload.feedbackId : undefined;
    if (feedbackId) {
      return this.deps.repos.runtime.getFeedback(feedbackId);
    }
    if (trial.rawTurnId) {
      const direct = this.deps.repos.runtime.listFeedback({
        userId: trial.userId,
        rawTurnId: trial.rawTurnId,
        limit: 1
      })[0];
      if (direct) return direct;
    }
    if (trial.episodeId) {
      return this.deps.repos.runtime.listFeedback({
        userId: trial.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        limit: 1
      })[0];
    }
    return undefined;
  }

pendingTrialsForFeedback(feedback: FeedbackRecord): SkillTrialRecord[] {
    if (feedback.rawTurnId) {
      return this.deps.repos.runtime.listSkillTrials({
        userId: feedback.userId,
        rawTurnId: feedback.rawTurnId,
        status: "pending",
        limit: 20
      });
    }
    if (feedback.episodeId) {
      return this.deps.repos.runtime.listSkillTrials({
        userId: feedback.userId,
        sessionId: feedback.sessionId,
        episodeId: feedback.episodeId,
        status: "pending",
        limit: 20
      });
    }
    return [];
  }

updateSkillTrialStats(trial: SkillTrialRecord, at: string): void {
    const memory = this.deps.repos.memories.get(trial.skillMemoryId);
    if (!memory || memory.memoryLayer !== "Skill") {
      return;
    }
    const trials = this.deps.repos.runtime
      .listSkillTrials({ skillMemoryId: trial.skillMemoryId, limit: 1000 })
      .filter((item) => item.outcome !== "unknown");
    const attempted = trials.length;
    const passed = trials.filter((item) => item.outcome === "success").length;
    const currentSkill = skillMetaFromMemory(memory);
    const eta = attempted > 0
      ? skillEtaAfterTrial({
          currentEta: currentSkill?.eta ?? 0,
          previousAttempts: currentSkill?.trialsAttempted ?? 0,
          previousPasses: currentSkill?.trialsPassed ?? 0,
          nextAttempts: attempted,
          nextPasses: passed
        })
      : currentSkill?.eta ?? 0;
    const status = skillStatusAfterTrial({
      currentStatus: currentSkill?.status ?? "candidate",
      eta,
      trialsAttempted: attempted,
      candidateTrials: this.deps.config.algorithm.skill.candidateTrials,
      minEtaForRetrieval: this.deps.config.algorithm.skill.minEtaForRetrieval,
      repairCandidateMinEta: this.deps.config.algorithm.skill.repairCandidateMinEta,
      repairOrigin: currentSkill?.repairOrigin ?? false,
      archiveEta: this.deps.config.algorithm.skill.archiveEta
    });
    const previous = memory;
    const next = updateSkillStats(memory, {
      trialsAttempted: attempted,
      trialsPassed: passed,
      eta,
      status,
      updatedAt: at
    });
    const saved = this.deps.repos.memories.update(next);
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: namespaceIdFromMemory(saved),
      kind: "skill",
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "skill_trial_update",
      before: previous,
      after: saved,
      source: "worker.skill_trial_resolve",
      createdAt: at
    });
    recordApiLog(this.deps.repos.runtime,
      "skill_evolve",
      { phase: "done", skillId: saved.id, trialId: trial.id, reason: "skill_trial_update" },
      {
        skillId: saved.id,
        kind: status !== currentSkill?.status ? "skill.status.changed" : "skill.eta.updated",
        name: saved.memoryKey ?? saved.id,
        status,
        eta,
        reason: "skill trial update"
      },
      0,
      true,
      at
    );
  }

resolvePendingSkillTrialsForReward(input: {
    userId: string;
    episodeId: string;
    rHuman: number;
    feedbackId?: string;
    at: string;
  }): void {
    const trials = this.deps.repos.runtime.listSkillTrials({
      userId: input.userId,
      episodeId: input.episodeId,
      status: "pending",
      limit: 100
    });
    for (const trial of trials) {
      const outcome = this.outcomeForSkillTrial(trial, {
        rHuman: input.rHuman,
        feedbackId: input.feedbackId
      });
      if (!outcome) {
        continue;
      }
      const before = trial;
      const updatedTrial = this.deps.repos.runtime.updateSkillTrial({
        ...trial,
        status: skillTrialStatusFromOutcome(outcome),
        outcome,
        feedbackId: input.feedbackId,
        resolvedAt: input.at
      });
      const skillMemoryForTrial = this.deps.repos.memories.get(updatedTrial.skillMemoryId);
      this.deps.repos.runtime.appendChange({
        memoryId: updatedTrial.skillMemoryId,
        namespaceId: skillMemoryForTrial
          ? namespaceIdFromMemory(skillMemoryForTrial)
          : namespaceIdFromContext({ source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", userId: updatedTrial.userId }),
        kind: "skill_trial",
        op: "updated",
        entityId: updatedTrial.id,
        userId: updatedTrial.userId,
        changeType: "skill_trial_resolved",
        before,
        after: updatedTrial,
        source: "worker.reward.updated",
        createdAt: input.at
      });
      if (outcome !== "unknown") {
        this.updateSkillTrialStats(updatedTrial, input.at);
      }
    }
  }

outcomeForSkillTrial(
    trial: SkillTrialRecord,
    payload: Record<string, unknown>,
    feedback?: FeedbackRecord
  ): SkillTrialRecord["outcome"] | undefined {
    const baseOutcome = typeof payload.rHuman === "number"
      ? outcomeFromReward(payload.rHuman, this.deps.config.algorithm.skill)
      : feedback
      ? outcomeFromFeedback(feedback)
      : undefined;
    if (baseOutcome !== "success") {
      return baseOutcome;
    }
    const skill = this.deps.repos.memories.get(trial.skillMemoryId);
    const skillMeta = skill ? skillMetaFromMemory(skill) : null;
    if (!skillMeta?.strictTrial) {
      return baseOutcome;
    }
    const explicitVerifier = firstBoolean(
      payload.verifierPassed,
      payload.fullPass,
      payload.passed,
      payload.verifier_passed,
      payload.full_pass
    );
    if (explicitVerifier === true) return "success";
    if (explicitVerifier === false) return "failure";
    const rawTurn = trial.rawTurnId ? this.deps.repos.runtime.getRawTurn(trial.rawTurnId) : undefined;
    return rawTurn?.status === "succeeded" ? "success" : "unknown";
  }

resolveSkillTrialEvidence(
    request: SkillUseRequest,
    session: SessionRecord,
    episode: EpisodeRecord
  ): {
    l1MemoryId?: string;
    rawTurnId?: string;
  } {
    let rawTurn = request.rawTurnId ? this.deps.requireRawTurn(request.rawTurnId) : undefined;
    if (rawTurn) {
      this.deps.assertRawTurnInScope(rawTurn, request.namespace);
      if (rawTurn.sessionId !== session.id) {
        throw new MemoryServiceError("conflict", "skill trial raw turn does not belong to the requested session");
      }
      if (rawTurn.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "skill trial raw turn does not belong to the requested episode");
      }
    }

    if (request.l1MemoryId) {
      const memory = this.deps.requireExistingMemory(request.l1MemoryId);
      this.deps.assertMemoryInScope(memory, request.namespace);
      const trace = this.deps.traceMeta(memory);
      if (!trace) {
        throw new MemoryServiceError("invalid_argument", "skill trial l1MemoryId must reference an L1 trace memory");
      }
      if (memory.sessionId && memory.sessionId !== session.id) {
        throw new MemoryServiceError("conflict", "skill trial memory does not belong to the requested session");
      }
      if (trace.episodeId && trace.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "skill trial memory does not belong to the requested episode");
      }
      const traceRawTurnId = rawTurnIdFromMemory(memory);
      if (rawTurn && traceRawTurnId && traceRawTurnId !== rawTurn.id) {
        throw new MemoryServiceError("conflict", "skill trial memory does not belong to the requested raw turn");
      }
      return {
        l1MemoryId: memory.id,
        rawTurnId: rawTurn?.id ?? traceRawTurnId
      };
    }

    const rawTurnTarget = rawTurn ? this.deps.feedbackTargetFromRawTurn(rawTurn) : undefined;
    if (rawTurn && rawTurnTarget) {
      return {
        l1MemoryId: rawTurnTarget.id,
        rawTurnId: rawTurn.id
      };
    }

    return {};
  }
}

function updateSkillStats(memory: MemoryRow, input: {
  trialsAttempted: number;
  trialsPassed: number;
  eta: number;
  status: "candidate" | "active" | "archived";
  updatedAt: string;
}): MemoryRow {
  const internalSkill = isRecord(memory.properties.internal_info.skill)
    ? memory.properties.internal_info.skill
    : {};
  const currentProcedure = isRecord(internalSkill.procedure_json)
    ? internalSkill.procedure_json
    : {};
  const successRate = skillSuccessRate(input.trialsAttempted, input.trialsPassed);
  const betaPosterior = skillBetaPosterior(input.trialsAttempted, input.trialsPassed);
  return {
    ...memory,
    info: {
      ...memory.info,
      eta: input.eta,
      trials_attempted: input.trialsAttempted,
      trials_passed: input.trialsPassed,
      skill_status: input.status
    },
    status: memoryStatusForSkillStatus(input.status),
    properties: {
      ...memory.properties,
      status: memoryStatusForSkillStatus(input.status),
      internal_info: {
        ...memory.properties.internal_info,
        status: input.status,
        eta: input.eta,
        trials_attempted: input.trialsAttempted,
        trials_passed: input.trialsPassed,
        success_rate: successRate,
        beta_posterior: betaPosterior,
        procedure_json: {
          ...currentProcedure,
          reliability: {
            ...(isRecord(currentProcedure.reliability) ? currentProcedure.reliability : {}),
            supportCount: numberOr(internalSkill.support, 0),
            successRate,
            betaPosterior
          }
        },
        skill: {
          ...internalSkill,
          status: input.status,
          eta: input.eta,
          trials_attempted: input.trialsAttempted,
          trials_passed: input.trialsPassed,
          success_rate: successRate,
          beta_posterior: betaPosterior,
          procedure_json: {
            ...currentProcedure,
            reliability: {
              ...(isRecord(currentProcedure.reliability) ? currentProcedure.reliability : {}),
              supportCount: numberOr(internalSkill.support, 0),
              successRate,
              betaPosterior
            }
          }
        }
      }
    },
    updatedAt: input.updatedAt
  };
}

function memoryStatusForSkillStatus(status: "candidate" | "active" | "archived"): "activated" | "resolving" | "archived" {
  return memoryStatusForLifecycleStatus(status);
}

function memoryStatusForLifecycleStatus(status: "candidate" | "active" | "archived"): "activated" | "resolving" | "archived" {
  if (status === "archived") return "archived";
  return status === "candidate" ? "resolving" : "activated";
}

function outcomeFromFeedback(feedback: FeedbackRecord): SkillTrialRecord["outcome"] | undefined {
  if (feedback.polarity === "positive" && feedback.magnitude > 0) {
    return "success";
  }
  if (feedback.polarity === "negative" && feedback.magnitude > 0) {
    return "failure";
  }
  return undefined;
}

function outcomeFromReward(
  rHuman: number,
  config: { outcomeRTaskSuccessThreshold: number; outcomeRTaskFailureThreshold: number }
): SkillTrialRecord["outcome"] {
  if (rHuman >= config.outcomeRTaskSuccessThreshold) return "success";
  if (rHuman <= config.outcomeRTaskFailureThreshold) return "failure";
  return "unknown";
}

function skillTrialStatusFromOutcome(outcome: SkillTrialRecord["outcome"]): SkillTrialRecord["status"] {
  if (outcome === "success") return "pass";
  if (outcome === "failure" || outcome === "cancelled") return "fail";
  return "unknown";
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

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}


function isToolCallPayload(value: unknown): value is ToolCallPayload {
  return isRecord(value) && typeof value.name === "string";
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "pass", "passed", "success", "succeeded", "ok"].includes(normalized)) return true;
      if (["false", "fail", "failed", "failure", "error"].includes(normalized)) return false;
    }
  }
  return undefined;
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
