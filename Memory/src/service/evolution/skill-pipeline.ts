import {
  SKILL_CRYSTALLIZE_PROMPT,
  SKILL_REBUILD_PROMPT,
  buildSkillDraft,
  cosine,
  detectDominantLanguage,
  extractToolNamesFromTraces,
  languageSteeringLine,
  policyMetaFromMemory,
  skillEtaAfterRewardDrift,
  skillMetaFromMemory,
  skillStatusAfterRewardDrift,
  traceMetaFromMemory,
  verifySkillDraft
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import { kindFromMemory,type EpisodeRecord,type EvolutionJobRecord,type Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { stableHash } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { recordApiLog } from "../model-audit/model-call-audit.js";
import { profileIdFromMemory,projectIdFromMemory } from "../namespace/namespace-scope.js";
import { skillBetaPosterior,skillSuccessRate } from "../read-model/skill.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";

type TraceMeta=NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta=NonNullable<ReturnType<typeof policyMetaFromMemory>>;
type SkillDraft=NonNullable<ReturnType<typeof buildSkillDraft>>;
type SkillEnhancementResult=|{ok:true;draft:SkillDraft}|{ok:false;reason:string};
type SkillRebuildLevel = "L0" | "L1" | "L2";

const SKILL_REFUSAL_PREFIXES = [
  /^i am claude\b/,
  /^i(?:'|’)m claude\b/,
  /^as claude\b/,
  /^as an ai assistant created by anthropic\b/,
  /^as an ai (?:assistant|language model)\b/,
  /^i(?:'|’)m sorry(?:,| but)?\s+(?:i\s+)?(?:can(?:not|(?:'|’)t)|am unable to)\b/,
  /^i apologize(?:,| but)?\s+(?:i\s+)?(?:can(?:not|(?:'|’)t)|am unable to)\b/,
  /^i (?:can(?:not|(?:'|’)t)|am unable to)\s+(?:assist|help|fulfill|process|comply|provide|engage)\b/,
  /^i do not feel comfortable\b/,
  /^i do not actually have the ability\b/
];

export interface SkillPipelineDeps {
 repos: Repositories; config: MemmyConfig; skillLlm: LlmClient;
 traceMeta(memory:MemoryRow|undefined|null):TraceMeta|null;
 buildMemory(input:Record<string,unknown>):MemoryRow;
 upsertEvolutionMemory(memory:MemoryRow):{memory:MemoryRow;created:boolean;previous?:MemoryRow};
 isArchivedEvolutionMemory(memory:MemoryRow):boolean;
 enqueueJob(input:EnqueueJobInput):EvolutionJobRecord;
 namespaceIdFromMemory(memory:MemoryRow):string;
}

export class SkillPipeline {
 private readonly skillCrystallizationRuns=new Map<string,number>();
 constructor(private readonly deps:SkillPipelineDeps){}

  async crystallizeSkill(job: EvolutionJobRecord): Promise<void> {
    const source = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    const userId = source?.userId ?? job.userId;
    const at = nowIso();
    const policyMemories = source?.memoryLayer === "L2"
      ? [source]
      : this.deps.repos.memories
          .list({ memoryLayer: "L2", status: "activated" }, 1000);

    for (const policyMemory of policyMemories) {
      const policy = policyMetaFromMemory(policyMemory);
      if (!policy) continue;
      const evidenceTraces = this.gatherSkillEvidence(policy, userId);
      const counterExamples = this.gatherSkillCounterExamples(policy, userId);
      if (evidenceTraces.length === 0) {
        this.deps.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: this.deps.namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: policyMemory.id,
          userId,
          changeType: "skill_crystallization_skipped",
          after: { policyId: policy.id, reason: "no-evidence" },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      const existingSkill = this.findExistingSkillForPolicy(policy, userId);
      if (this.isSkillCrystallizationInCooldown(policy, at)) {
        this.deps.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: this.deps.namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: existingSkill?.id ?? policyMemory.id,
          userId,
          changeType: "skill_crystallization_skipped",
          after: {
            policyId: policy.id,
            ...(existingSkill ? { skillId: existingSkill.id } : {}),
            reason: "cooldown"
          },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      this.markSkillCrystallizationRun(policy, at);
      const fallbackDraft = buildSkillDraft({
        policy,
        existing: existingSkill,
        minEtaForRetrieval: this.deps.config.algorithm.skill.minEtaForRetrieval,
        minSupport: this.deps.config.algorithm.skill.minSupport,
        minGain: this.deps.config.algorithm.skill.minGain
      });
      const enhancement = fallbackDraft
        ? await this.enhanceSkillDraft(policy, fallbackDraft, evidenceTraces, counterExamples, existingSkill)
        : { ok: false, reason: "not-eligible" } as const;
      if (!enhancement.ok) {
        this.deps.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: this.deps.namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: policyMemory.id,
          userId,
          changeType: "skill_crystallization_skipped",
          after: { policyId: policy.id, reason: enhancement.reason },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      const draft = enhancement.draft;
      const verdict = verifySkillDraft({ draft, evidenceTraces });
      if (!verdict.ok) {
        this.deps.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: this.deps.namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: policyMemory.id,
          userId,
          changeType: "skill_verification_failed",
          after: { policyId: policy.id, verdict },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      const evidenceAnchorIds = evidenceTraces.map((trace) => trace.id).slice(0, 10);
      const verifiedDraft: SkillDraft = {
        ...draft,
        sourceTraceIds: evidenceAnchorIds,
        evidenceAnchorIds: uniq([...evidenceAnchorIds, ...draft.evidenceAnchorIds]).slice(0, 10)
      };
      const skill = this.deps.buildMemory({
        userId,
        conversationId: policyMemory.conversationId,
        sessionId: policyMemory.sessionId ?? job.sessionId,
        agentId: policyMemory.agentId,
        appId: policyMemory.appId,
        projectId: projectIdFromMemory(policyMemory),
        profileId: profileIdFromMemory(policyMemory),
        layer: "Skill",
        kind: "skill",
        lifecycleStatus: verifiedDraft.status,
        memoryType: "SkillMemory",
        key: verifiedDraft.key,
        value: verifiedDraft.invocationGuide,
        tags: verifiedDraft.tags,
        info: {
          name: verifiedDraft.name,
          eta: verifiedDraft.eta,
          status: verifiedDraft.status,
          source_memory_ids: verifiedDraft.sourcePolicyIds
        },
        internal: {
          source: "worker.skill_crystallization.v7",
          plugin_algorithm: "skill.crystallization.v7",
          source_memory_ids: verifiedDraft.sourcePolicyIds,
          source_policy_ids: verifiedDraft.sourcePolicyIds,
          source_world_model_ids: verifiedDraft.sourceWorldModelIds,
          evidence_anchor_ids: verifiedDraft.evidenceAnchorIds,
          name: verifiedDraft.name,
          invocation_guide: verifiedDraft.invocationGuide,
          procedure_json: verifiedDraft.procedureJson,
          eta: verifiedDraft.eta,
          support: verifiedDraft.support,
          gain: verifiedDraft.gain,
          policy_content_hash: skillPolicyContentHash(policy),
          skill: {
            name: verifiedDraft.name,
            eta: verifiedDraft.eta,
            status: verifiedDraft.status,
            support: verifiedDraft.support,
            gain: verifiedDraft.gain,
            policy_content_hash: skillPolicyContentHash(policy),
            source_policy_ids: verifiedDraft.sourcePolicyIds,
            source_world_model_ids: verifiedDraft.sourceWorldModelIds,
            evidence_anchor_ids: verifiedDraft.evidenceAnchorIds,
            invocation_guide: verifiedDraft.invocationGuide,
            procedure_json: verifiedDraft.procedureJson,
            trials_attempted: verifiedDraft.trialsAttempted,
            trials_passed: verifiedDraft.trialsPassed,
            success_rate: verifiedDraft.successRate,
            beta_posterior: verifiedDraft.betaPosterior,
            vec: verifiedDraft.vec,
            verification: verdict
          }
        },
        createdAt: at
      });
      const upsert = this.deps.upsertEvolutionMemory(skill);
      for (const episodeId of uniq(evidenceTraces.map((trace) => trace.episodeId).filter((id): id is string => Boolean(id)))) {
        this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "Skill", upsert.memory.id, at);
      }
      this.deps.repos.runtime.appendChange({
        memoryId: upsert.memory.id,
        namespaceId: this.deps.namespaceIdFromMemory(upsert.memory),
        kind: kindFromMemory(upsert.memory),
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId,
        changeType: upsert.created ? "create" : "update",
        before: upsert.previous,
        after: upsert.memory,
        source: "worker.skill_crystallization.v7",
        createdAt: at
      });
      recordApiLog(this.deps.repos.runtime,
        upsert.created ? "skill_generate" : "skill_evolve",
        { phase: "done", skillId: upsert.memory.id, policyId: policy.id },
        {
          skillId: upsert.memory.id,
          kind: upsert.created ? "skill.crystallized" : "skill.rebuilt",
          name: verifiedDraft.name,
          status: verifiedDraft.status,
          eta: verifiedDraft.eta,
          sourcePolicyIds: verifiedDraft.sourcePolicyIds
        },
        0,
        true,
        at
      );
      if (this.deps.config.algorithm.capture.embedAfterCapture) {
        this.deps.enqueueJob({
          jobType: "embedding",
          userId,
          sessionId: policyMemory.sessionId ?? job.sessionId,
          episodeId: job.episodeId,
          targetMemoryId: upsert.memory.id,
          payload: { reason: "skill.upserted" },
          createdAt: at
        });
      }
    }
  }

  findExistingSkillForPolicy(
    policy: PolicyMeta,
    userId: string
  ): NonNullable<ReturnType<typeof skillMetaFromMemory>> | null {
    const candidates = this.deps.repos.memories
      .list({ memoryLayer: "Skill" }, 1000)
      .map(skillMetaFromMemory)
      .filter((skill): skill is NonNullable<ReturnType<typeof skillMetaFromMemory>> =>
        Boolean(skill &&
          skill.status !== "archived" &&
          skill.sourcePolicyIds.includes(policy.id))
      )
      .sort((a, b) => Date.parse(b.memory.updatedAt) - Date.parse(a.memory.updatedAt));
    return candidates[0] ?? null;
  }

private isSkillCrystallizationInCooldown(policy: PolicyMeta, at: string): boolean {
    const cooldownMs = this.deps.config.algorithm.skill.cooldownMs;
    if (cooldownMs <= 0) return false;
    const lastRunAt = this.skillCrystallizationRuns.get(this.skillCrystallizationCooldownKey(policy));
    if (!lastRunAt) return false;
    const now = Date.parse(at);
    if (!Number.isFinite(now)) return false;
    return now - lastRunAt < cooldownMs;
  }

private markSkillCrystallizationRun(policy: PolicyMeta, at: string): void {
    if (this.deps.config.algorithm.skill.cooldownMs <= 0) return;
    const now = Date.parse(at);
    if (!Number.isFinite(now)) return;
    this.skillCrystallizationRuns.set(this.skillCrystallizationCooldownKey(policy), now);
  }

private skillCrystallizationCooldownKey(policy: PolicyMeta): string {
    return policy.id;
  }

private gatherSkillEvidence(policy: PolicyMeta, userId: string): TraceMeta[] {
    const byId = new Map<string, TraceMeta>();
    const episodeIds = new Set(policy.sourceEpisodeIds);
    const failureEpisodeIds = new Set(
      policy.sourceEpisodeIds.filter((episodeId) => this.isFailureEpisodeForSkillEvidence(episodeId))
    );
    if (episodeIds.size > 0) {
      const candidates = this.deps.repos.memories
        .list({ memoryLayer: "L1", status: "activated" }, 1000)
        .map((memory) => this.deps.traceMeta(memory))
        .filter((trace): trace is TraceMeta =>
          Boolean(trace?.episodeId &&
            episodeIds.has(trace.episodeId) &&
            !failureEpisodeIds.has(trace.episodeId))
        );
      for (const trace of candidates) byId.set(trace.id, trace);
    }
    for (const memory of this.deps.repos.memories.getMany(policy.sourceTraceIds)) {
      const trace = this.deps.traceMeta(memory);
      if (trace && (!trace.episodeId || !failureEpisodeIds.has(trace.episodeId))) byId.set(trace.id, trace);
    }
    const traces = Array.from(byId.values())
      .filter((trace) =>
        trace.userText !== "[REDACTED]" &&
        trace.agentText !== "[REDACTED]" &&
        trace.value > this.deps.config.algorithm.skill.outcomeRTaskFailureThreshold
      )
      .sort((a, b) => {
        const scoreA = this.skillEvidenceScore(a, policy);
        const scoreB = this.skillEvidenceScore(b, policy);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return b.ts - a.ts;
      })
      .slice(0, Math.max(1, this.deps.config.algorithm.skill.evidenceLimit));
    return traces.map((trace) => this.capSkillEvidenceTrace(trace));
  }

private isFailureEpisodeForSkillEvidence(episodeId: string): boolean {
    const episode = this.deps.repos.runtime.getEpisode(episodeId);
    if (!episode) return false;
    if (typeof episode.rTask === "number") {
      return episode.rTask <= this.deps.config.algorithm.skill.outcomeRTaskFailureThreshold;
    }
    return episode.rewardDetail.skipped === true;
  }

private gatherSkillCounterExamples(policy: PolicyMeta, userId: string): TraceMeta[] {
    if (policy.sourceEpisodeIds.length === 0) return [];
    const episodeIds = new Set(policy.sourceEpisodeIds);
    return this.deps.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .map((memory) => this.deps.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace?.episodeId &&
          episodeIds.has(trace.episodeId) &&
          Number.isFinite(trace.value) &&
          trace.value < 0 &&
          trace.userText !== "[REDACTED]" &&
          trace.agentText !== "[REDACTED]")
      )
      .sort((a, b) => a.value - b.value || b.ts - a.ts)
      .slice(0, 5)
      .map((trace) => this.capSkillEvidenceTrace(trace));
  }

private skillEvidenceScore(trace: TraceMeta, policy: PolicyMeta): number {
    const value = Number.isFinite(trace.value) ? trace.value : 0;
    return value + 0.2 * cosine(trace.vecSummary, policy.vec);
  }

private capSkillEvidenceTrace(trace: TraceMeta): TraceMeta {
    const cap = Math.max(1, this.deps.config.algorithm.skill.traceCharCap);
    const userText = capSkillPromptText(trace.userText, cap);
    const agentText = capSkillPromptText(trace.agentText, cap);
    if (userText === trace.userText && agentText === trace.agentText) {
      return trace;
    }
    return { ...trace, userText, agentText };
  }

  applySkillRewardDriftForPolicy(policy: PolicyMeta, at: string): void {
    const skills = this.deps.repos.memories
      .list({ memoryLayer: "Skill" }, 1000)
      .map(skillMetaFromMemory)
      .filter((skill): skill is NonNullable<ReturnType<typeof skillMetaFromMemory>> =>
        Boolean(skill &&
          skill.sourcePolicyIds.includes(policy.id))
      );
    for (const skill of skills) {
      const eta = skillEtaAfterRewardDrift({
        currentEta: skill.eta,
        magnitude: policy.gain
      });
      const status = skillStatusAfterRewardDrift({
        currentStatus: skill.status,
        eta,
        archiveEta: this.deps.config.algorithm.skill.archiveEta
      });
      if (eta === skill.eta && status === skill.status) continue;
      const previous = skill.memory;
      const next = updateSkillStats(skill.memory, {
        trialsAttempted: skill.trialsAttempted,
        trialsPassed: skill.trialsPassed,
        eta,
        status,
        updatedAt: at
      });
      const saved = this.deps.repos.memories.update(next);
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: this.deps.namespaceIdFromMemory(saved),
        kind: "skill",
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "skill_reward_drift",
        before: previous,
        after: saved,
        source: "worker.skill_lifecycle.v7",
        createdAt: at
      });
      recordApiLog(this.deps.repos.runtime,
        "skill_evolve",
        { phase: "done", skillId: saved.id, policyId: policy.id, reason: "reward_drift" },
        {
          skillId: saved.id,
          kind: status !== skill.status ? "skill.status.changed" : "skill.eta.updated",
          name: saved.memoryKey ?? saved.id,
          status,
          eta,
          reason: "reward drift"
        },
        0,
        true,
        at
      );
    }
  }

private async enhanceSkillDraft(
    policy: PolicyMeta,
    fallback: SkillDraft,
    evidenceTraces: TraceMeta[],
    counterExamples: TraceMeta[],
    existingSkill?: NonNullable<ReturnType<typeof skillMetaFromMemory>> | null
  ): Promise<SkillEnhancementResult> {
    if (!this.deps.config.algorithm.skill.useLlm || !this.deps.skillLlm.isConfigured()) {
      return { ok: false, reason: "llm_disabled" };
    }
    try {
      const evidenceTools = Array.from(extractToolNamesFromTraces(evidenceTraces));
      const existingSkillNames = this.deps.repos.memories
        .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 1000)
        .map(skillMetaFromMemory)
        .filter((skill): skill is NonNullable<ReturnType<typeof skillMetaFromMemory>> => Boolean(skill))
        .map((skill) => skill.name);
      const languageSamples = [
        policy.title,
        policy.trigger,
        policy.procedure,
        ...evidenceTraces.flatMap((trace) => [trace.userText, trace.agentText, trace.reflection])
      ];
      const outputLanguage = skillOutputLanguageFor(
        this.deps.config.algorithm.skill.outputLanguageMode,
        detectDominantLanguage(languageSamples)
      );
      const rebuild = existingSkill ? skillRebuildPlan(policy, existingSkill, evidenceTraces) : null;
      const prompt = rebuild ? SKILL_REBUILD_PROMPT : SKILL_CRYSTALLIZE_PROMPT;
      const result = await this.deps.skillLlm.completeJson<{
        name?: unknown;
        retrieval_blurb?: unknown;
        retrievalBlurb?: unknown;
        trigger_context?: unknown;
        triggerContext?: unknown;
        displayTitle?: unknown;
        display_title?: unknown;
        summary?: unknown;
        parameters?: unknown;
        preconditions?: unknown;
        steps?: unknown;
        examples?: unknown;
        decisionGuidance?: unknown;
        decision_guidance?: unknown;
        tools?: unknown;
        procedureJson?: unknown;
        tags?: unknown;
        changed_sections?: unknown;
        changedSections?: unknown;
      }>([
        {
          role: "system",
          content: prompt.system
        },
        {
          role: "system",
          content: languageSteeringLine(detectDominantLanguage(languageSamples))
        },
        {
          role: "user",
          content: JSON.stringify({
            policy: {
              id: policy.id,
              title: policy.title,
              trigger: policy.trigger,
              procedure: policy.procedure,
              verification: policy.verification,
              boundary: policy.boundary,
              support: policy.support,
              gain: policy.gain
            },
            evidence: evidenceTraces.slice(0, this.deps.config.algorithm.skill.evidenceLimit).map((trace) => ({
              id: trace.id,
              episodeId: trace.episodeId,
              episode_outcome: skillEvidenceEpisodeOutcome(skillEvidenceEpisode(this.deps.repos.runtime, trace.episodeId)),
              episode_r_task: skillEvidenceEpisode(this.deps.repos.runtime, trace.episodeId)?.rTask ?? null,
              reflection: trace.reflection,
              user: trace.userText,
              agent: trace.agentText,
              value: trace.value,
              alpha: trace.alpha,
              tags: trace.tags
            })),
            ...(counterExamples.length > 0
              ? {
                  counter_examples: counterExamples.slice(0, 5).map((trace) => ({
                    id: trace.id,
                    episodeId: trace.episodeId,
                    reflection: trace.reflection,
                    user: trace.userText,
                    agent: trace.agentText,
                    value: trace.value,
                    tags: trace.tags
                  }))
                }
              : {}),
            ...(policy.decisionGuidance.preference.length > 0 || policy.decisionGuidance.antiPattern.length > 0
              ? {
                  repair_hints: {
                    preference: policy.decisionGuidance.preference,
                    antiPattern: policy.decisionGuidance.antiPattern
                  }
                }
              : {}),
            evidence_tools: evidenceTools,
            naming_space: existingSkillNames,
            output_language: outputLanguage,
            ...(rebuild
              ? {
                  existing_skill_snapshot: rebuild.snapshot,
                  incremental_evidence: rebuild.incrementalEvidence.map((trace) => ({
                    id: trace.id,
                    episodeId: trace.episodeId,
                    user: trace.userText,
                    agent: trace.agentText,
                    reflection: trace.reflection,
                    value: trace.value,
                    tags: trace.tags
                  })),
                  rebuild_level: rebuild.level,
                  repair_rename_allowed: false
                }
              : {}),
            fallback: {
              name: fallback.name,
              invocationGuide: fallback.invocationGuide,
              procedureJson: fallback.procedureJson,
              tags: fallback.tags
            }
          })
        }
      ], {
        operation: rebuild ? `${prompt.id}.v${prompt.version}` : prompt.id,
        thinkingMode: "enabled",
        temperature: 0.2,
        maxTokens: 1400
      });
      if (detectSkillModelRefusal(result)) {
        return { ok: false, reason: "llm-refusal" };
      }
      const invalidReason = skillCrystallizerInvalidReason(result);
      if (invalidReason) {
        return { ok: false, reason: invalidReason };
      }
      const llmProcedureJson = coerceSkillProcedureJson(result);
      const procedureJson = rebuild
        ? mergeSkillRebuildProcedureJson(
            skillProcedureJsonFromMemory(existingSkill?.memory),
            llmProcedureJson,
            rebuild.level,
            stringArray(result.changed_sections ?? result.changedSections)
          )
        : llmProcedureJson;
      const skillName = rebuild
        ? existingSkill?.name ?? fallback.name
        : coerceSkillName(result.name, `skill_${policy.id.slice(-6)}`);
      const displayTitle = skillText(result.display_title ?? result.displayTitle ?? policy.title ?? skillName) || skillName;
      const invocationGuide = renderSkillInvocationGuide({
        name: skillName,
        displayTitle,
        procedureJson,
        policy
      });
      return {
        ok: true,
        draft: {
          ...fallback,
          name: skillName,
          invocationGuide,
          procedureJson,
          tags: dedupeCaseInsensitiveStrings([...fallback.tags, ...stringArray(result.tags)])
        }
      };
    } catch (error) {
      return { ok: false, reason: `llm-failed: ${errorMessageFromUnknown(error) ?? "unknown"}` };
    }
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

function capSkillPromptText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function coerceSkillProcedureJson(result: Record<string, unknown>): Record<string, unknown> {
  const steps = coerceSkillSteps(result.steps);
  const preconditions = skillMarkdownArray(result.preconditions);
  const parameters = coerceSkillParameters(result.parameters);
  const examples = coerceSkillExamples(result.examples);
  const tags = skillTextArray(result.tags);
  const tools = skillTextArray(result.tools);
  return {
    retrievalBlurb: skillText(result.retrieval_blurb ?? result.retrievalBlurb),
    triggerContext: skillText(result.trigger_context ?? result.triggerContext),
    summary: skillText(result.summary),
    parameters,
    preconditions,
    steps,
    examples,
    decisionGuidance: coerceSkillDecisionGuidance(
      result.decisionGuidance ??
        result.decision_guidance
    ),
    tags: dedupeCaseInsensitiveStrings(tags),
    tools: dedupeCaseInsensitiveStrings(tools)
  };
}

function skillOutputLanguageFor(mode: "follow_policy" | "zh" | "en", detected: "auto" | "zh" | "en"): "zh" | "en" {
  if (mode === "zh" || mode === "en") return mode;
  return detected === "zh" ? "zh" : "en";
}

function skillEvidenceEpisode(
  runtime: Pick<Repositories["runtime"], "getEpisode">,
  episodeId: string | undefined
): EpisodeRecord | undefined {
  return episodeId ? runtime.getEpisode(episodeId) : undefined;
}

function skillEvidenceEpisodeOutcome(episode: EpisodeRecord | undefined): "success" | "failure" | "unknown" {
  const rTask = typeof episode?.rTask === "number" ? episode.rTask : undefined;
  if (rTask === undefined) return "unknown";
  if (rTask >= 0.5) return "success";
  if (rTask <= -0.15) return "failure";
  return "unknown";
}

function skillRebuildPlan(
  policy: PolicyMeta,
  existingSkill: NonNullable<ReturnType<typeof skillMetaFromMemory>>,
  evidenceTraces: TraceMeta[]
): {
  level: SkillRebuildLevel;
  policyHash: string;
  incrementalEvidence: TraceMeta[];
  snapshot: Record<string, unknown>;
} {
  const policyHash = skillPolicyContentHash(policy);
  const previousPolicyHash = storedSkillPolicyContentHash(existingSkill.memory);
  const incrementalEvidence = evidenceTraces.filter((trace) => !existingSkill.evidenceAnchorIds.includes(trace.id));
  const level: SkillRebuildLevel = previousPolicyHash !== policyHash
    ? "L2"
    : incrementalEvidence.length === 0
    ? "L0"
    : incrementalEvidence.length >= 2
    ? "L2"
    : "L1";
  const procedure = skillProcedureJsonFromMemory(existingSkill.memory);
  return {
    level,
    policyHash,
    incrementalEvidence,
    snapshot: {
      name: existingSkill.name,
      retrieval_blurb: procedure.retrievalBlurb,
      trigger_context: procedure.triggerContext,
      summary: procedure.summary,
      step_titles: skillStepsFromProcedure(procedure).map((step) => step.title),
      decision_guidance: procedure.decisionGuidance ?? { preference: [], antiPattern: [] },
      policy_content_hash: previousPolicyHash
    }
  };
}

function skillPolicyContentHash(policy: PolicyMeta): string {
  return stableHash({
    title: policy.title,
    trigger: policy.trigger,
    procedure: policy.procedure,
    verification: policy.verification,
    boundary: policy.boundary,
    decisionGuidance: policy.decisionGuidance
  });
}

function storedSkillPolicyContentHash(memory: MemoryRow): string | null {
  const internal = memory.properties.internal_info;
  const skill = isRecord(internal.skill) ? internal.skill : {};
  const value = skill.policy_content_hash ?? internal.policy_content_hash;
  return typeof value === "string" && value ? value : null;
}

function skillProcedureJsonFromMemory(memory: MemoryRow | undefined): Record<string, unknown> {
  if (!memory) return {};
  const internal = memory.properties.internal_info;
  const skill = isRecord(internal.skill) ? internal.skill : {};
  const fromSkill = skill.procedure_json;
  if (isRecord(fromSkill)) return fromSkill;
  const fromInternal = internal.procedure_json;
  return isRecord(fromInternal) ? fromInternal : {};
}

function mergeSkillRebuildProcedureJson(
  existing: Record<string, unknown>,
  draft: Record<string, unknown>,
  level: SkillRebuildLevel,
  changedSections: string[]
): Record<string, unknown> {
  if (Object.keys(existing).length === 0 || level === "L2") {
    return draft;
  }
  const allowed = skillRebuildAllowedSections(level, changedSections);
  const mergeField = (field: string): unknown =>
    allowed.has(field) ? draft[field] ?? existing[field] : existing[field] ?? draft[field];
  return {
    retrievalBlurb: mergeField("retrievalBlurb"),
    triggerContext: mergeField("triggerContext"),
    summary: mergeField("summary"),
    parameters: mergeField("parameters"),
    preconditions: mergeField("preconditions"),
    steps: mergeField("steps"),
    examples: mergeField("examples"),
    decisionGuidance: mergeField("decisionGuidance"),
    tags: mergeField("tags"),
    tools: mergeField("tools")
  };
}

function skillRebuildAllowedSections(level: SkillRebuildLevel, changedSections: string[]): Set<string> {
  if (level === "L0") {
    return new Set(["retrievalBlurb", "summary"]);
  }
  const normalized = new Set(
    changedSections.map((section) => section.trim().toLowerCase().replace(/_/g, ""))
  );
  if (normalized.size === 0) {
    return new Set(["retrievalBlurb", "summary", "decisionGuidance", "steps"]);
  }
  const mapped = new Set<string>();
  if (normalized.has("retrievalblurb")) mapped.add("retrievalBlurb");
  if (normalized.has("triggercontext")) mapped.add("triggerContext");
  if (normalized.has("summary")) mapped.add("summary");
  if (normalized.has("parameters")) mapped.add("parameters");
  if (normalized.has("preconditions")) mapped.add("preconditions");
  if (normalized.has("steps")) mapped.add("steps");
  if (normalized.has("examples")) mapped.add("examples");
  if (normalized.has("decisionguidance")) mapped.add("decisionGuidance");
  if (normalized.has("tags")) mapped.add("tags");
  if (normalized.has("tools")) mapped.add("tools");
  return mapped.size > 0 ? mapped : new Set(["retrievalBlurb", "summary", "decisionGuidance", "steps"]);
}

function skillStepsFromProcedure(procedure: Record<string, unknown>): Array<{ title: string }> {
  if (!Array.isArray(procedure.steps)) return [];
  return procedure.steps
    .map((step) => isRecord(step) ? { title: skillText(step.title) || "Step" } : null)
    .filter((step): step is { title: string } => Boolean(step));
}

function skillCrystallizerInvalidReason(result: unknown): string | null {
  if (!isRecord(result)) return "llm-failed: skill.crystallize.invalid: non-object output";
  if (!skillText(result.retrieval_blurb ?? result.retrievalBlurb)) {
    return "llm-failed: skill.crystallize.invalid: missing retrieval_blurb";
  }
  if (!skillText(result.trigger_context ?? result.triggerContext)) {
    return "llm-failed: skill.crystallize.invalid: missing trigger_context";
  }
  if (!skillText(result.summary)) return "llm-failed: skill.crystallize.invalid: missing summary";
  if (coerceSkillSteps(result.steps).length === 0) {
    return "llm-failed: skill.crystallize.invalid: missing steps";
  }
  return null;
}

function detectSkillModelRefusal(value: unknown): boolean {
  for (const text of collectSkillStrings(value)) {
    if (detectSkillModelRefusalText(text)) return true;
  }
  return false;
}

function detectSkillModelRefusalText(text: string): boolean {
  const normalized = text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000)
    .replace(/^[\uFEFF\s"'“”‘’`*_>-]+/, "")
    .replace(/[’]/g, "'")
    .toLowerCase();
  return SKILL_REFUSAL_PREFIXES.some((prefix) => prefix.test(normalized));
}

function collectSkillStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectSkillStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectSkillStrings);
}

function coerceSkillSteps(value: unknown): Array<{ title: string; body: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (isRecord(item)) {
        const title = skillText(item.title);
        const body = skillMarkdown(item.body);
        if (!title && !body) return undefined;
        return {
          title: title || body.slice(0, 32),
          body
        };
      }
      return undefined;
    })
    .filter((item): item is { title: string; body: string } => Boolean(item));
}

function coerceSkillParameters(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return undefined;
      const name = skillText(item.name);
      if (!name) return undefined;
      const rawType = skillText(item.type).toLowerCase();
      const type = rawType && ["string", "number", "boolean", "enum"].includes(rawType)
        ? rawType
        : "string";
      const out: Record<string, unknown> = {
        name,
        type,
        required: Boolean(item.required),
        description: skillMarkdown(item.description)
      };
      if (type === "enum") {
        out.enumValues = skillMarkdownArray(item.enum);
      }
      return out;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function coerceSkillExamples(value: unknown): Array<{ input: string; expected: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return undefined;
      const input = skillMarkdown(item.input);
      const expected = skillMarkdown(item.expected);
      if (!input && !expected) return undefined;
      return { input, expected };
    })
    .filter((item): item is { input: string; expected: string } => Boolean(item));
}

function coerceSkillDecisionGuidance(value: unknown): { preference: string[]; antiPattern: string[] } {
  if (!isRecord(value)) return { preference: [], antiPattern: [] };
  return {
    preference: dedupeCaseInsensitiveStrings(skillMarkdownArray(value.preference)).slice(0, 5),
    antiPattern: dedupeCaseInsensitiveStrings(skillMarkdownArray(value.antiPattern ?? value.anti_pattern)).slice(0, 5)
  };
}

const SKILL_HTML_BLOCK_RE = /<\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

const SKILL_DANGEROUS_TAG_RE = /<\/?\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>/gi;

const SKILL_HTML_TAG_RE = /<\/?[a-z][a-z0-9:-]*(?:\s+[^<>]*)?>/gi;

const SKILL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const SKILL_MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(((?:\\.|[^()\n]|\([^()\n]*\))+)\)/g;

function skillTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => skillText(item)).filter(Boolean);
}

function skillMarkdownArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => skillMarkdown(item)).filter(Boolean);
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

function stripUnsafeHtml(text: string): string {
  return text
    .replace(SKILL_HTML_BLOCK_RE, "")
    .replace(SKILL_HTML_TAG_RE, "");
}

function stripDangerousHtmlBlocks(text: string): string {
  return text.replace(SKILL_HTML_BLOCK_RE, "").replace(SKILL_DANGEROUS_TAG_RE, "");
}

function stripDangerousMarkdownLinks(text: string): string {
  return text.replace(SKILL_MARKDOWN_LINK_RE, (_match, bang: string, label: string, rawUrl: string) => {
    const url = rawUrl.trim();
    const firstToken = url.split(/\s+/)[0] ?? "";
    if (!isSafeLinkTarget(firstToken)) return `${bang}${label}`;
    return `${bang}[${label}](${url})`;
  });
}

function isSafeLinkTarget(raw: string): boolean {
  const target = raw.trim().replace(/^["'<]+|[>"']+$/g, "");
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

function coerceSkillName(value: unknown, fallback: string): string {
  const raw = skillRawString(value).trim() || fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return normalized || "skill";
}

function renderSkillInvocationGuide(input: {
  name: string;
  displayTitle?: string;
  procedureJson: Record<string, unknown>;
  policy: PolicyMeta;
}): string {
  const procedure = input.procedureJson;
  const title = skillText(input.displayTitle || input.name);
  const lines: string[] = [`# ${title}`, ""];
  const retrievalBlurb = firstString(procedure.retrievalBlurb, procedure.retrieval_blurb);
  if (retrievalBlurb) {
    lines.push(retrievalBlurb, "");
  }
  const summary = firstString(procedure.summary);
  if (summary) {
    lines.push(summary, "");
  }
  const triggerContext = firstString(procedure.triggerContext, procedure.trigger_context);
  lines.push("**When to use**", triggerContext || input.policy.trigger.trim() || "(derived from policy)", "");

  const preconditions = stringArray(procedure.preconditions);
  if (preconditions.length > 0) {
    lines.push("**Preconditions**");
    for (const item of preconditions) lines.push(`- ${item}`);
    lines.push("");
  }

  const parameters = Array.isArray(procedure.parameters) ? procedure.parameters : [];
  if (parameters.length > 0) {
    lines.push("**Parameters**");
    for (const item of parameters) {
      if (!isRecord(item)) continue;
      const name = firstString(item.name);
      if (!name) continue;
      const type = firstString(item.type) ?? "string";
      const required = Boolean(item.required) ? " (required)" : "";
      const description = firstString(item.description) ?? "";
      lines.push(`- \`${name}\`: ${type}${required}${description ? ` - ${description}` : ""}`);
    }
    lines.push("");
  }

  const steps = coerceSkillSteps(procedure.steps);
  if (steps.length > 0) {
    lines.push("**Procedure**");
    steps.forEach((step, index) => {
      lines.push(`${index + 1}. **${step.title}** - ${step.body}`);
    });
    lines.push("");
  }

  const examples = Array.isArray(procedure.examples) ? procedure.examples : [];
  if (examples.length > 0) {
    lines.push("**Examples**");
    for (const item of examples) {
      if (!isRecord(item)) continue;
      const exampleInput = firstString(item.input);
      const expected = firstString(item.expected);
      if (!exampleInput && !expected) continue;
      lines.push(`- Input: \`${exampleInput ?? ""}\``);
      if (expected) lines.push(`  Expected: ${expected}`);
    }
    lines.push("");
  }

  const tools = stringArray(procedure.tools);
  if (tools.length > 0) {
    lines.push("**Tools used**");
    for (const tool of tools) lines.push(`- \`${tool}\``);
    lines.push("");
  }

  const guidance = coerceSkillDecisionGuidance(procedure.decisionGuidance ?? procedure.decision_guidance);
  if (guidance.preference.length > 0 || guidance.antiPattern.length > 0) {
    lines.push("**Decision guidance**");
    if (guidance.preference.length > 0) {
      lines.push("Prefer:");
      for (const item of guidance.preference) lines.push(`- ${item}`);
    }
    if (guidance.antiPattern.length > 0) {
      lines.push("Avoid:");
      for (const item of guidance.antiPattern) lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function dedupeCaseInsensitiveStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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
