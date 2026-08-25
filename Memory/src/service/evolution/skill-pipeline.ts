import {
  SKILL_CRYSTALLIZE_PROMPT,
  SKILL_REBUILD_PROMPT,
  buildSkillDraft,
  cosine,
  detectDominantLanguage,
  extractToolNamesFromTraces,
  languageSteeringLine,
  policyIsEligibleForDownstream,
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
import { formatZonedTime, nowIso } from "../../utils/time.js";
import { elapsedApiLogMs,recordApiLog } from "../model-audit/model-call-audit.js";
import { profileIdFromMemory,projectIdFromMemory } from "../namespace/namespace-scope.js";
import { skillBetaPosterior,skillSuccessRate } from "../read-model/skill.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { logEvolutionDecision } from "./evolution-logging.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;
type SkillMeta = NonNullable<ReturnType<typeof skillMetaFromMemory>>;
type SkillDraft = NonNullable<ReturnType<typeof buildSkillDraft>>;
type SkillEnhancementResult = { ok: true; draft: SkillDraft } | { ok: false; reason: string };
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

  invalidatePolicySource(policyId: string, at: string): void {
    const affected = this.deps.repos.memories
      .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 1000)
      .map((memory) => ({ memory, skill: skillMetaFromMemory(memory) }))
      .filter((item): item is {
        memory: MemoryRow;
        skill: NonNullable<ReturnType<typeof skillMetaFromMemory>>;
      } => Boolean(
        item.skill?.sourcePolicyIds.includes(policyId) &&
        !isReadOnlySkillMemory(item.memory)
      ));

    for (const { memory, skill } of affected) {
      const activePolicies = skill.sourcePolicyIds
        .map((id) => this.deps.repos.memories.get(id))
        .map((source) => source ? policyMetaFromMemory(source) : null)
        .filter((policy): policy is PolicyMeta => Boolean(
          policy && policyIsEligibleForDownstream(policy)
        ));
      const activePolicyIds = new Set(activePolicies.map((policy) => policy.id));
      const procedure = skillProcedureJsonFromMemory(memory);
      const originalSteps = Array.isArray(procedure.steps) ? procedure.steps.filter(isRecord) : [];
      let removedRequiredStep = false;
      const steps = originalSteps.flatMap((step) => {
        const declaredSources = stringArray(step.supportingPolicyIds ?? step.supporting_policy_ids);
        const effectiveSources = declaredSources.length > 0 ? declaredSources : skill.sourcePolicyIds;
        const supportingPolicyIds = effectiveSources.filter((id) => activePolicyIds.has(id));
        if (supportingPolicyIds.length === 0) {
          if (step.required === true || step.core === true) removedRequiredStep = true;
          return [];
        }
        return [{ ...step, supportingPolicyIds }];
      });
      const shouldArchive = activePolicies.length === 0 || removedRequiredStep ||
        (originalSteps.length > 0 && steps.length === 0);
      const nextStatus = shouldArchive ? "suspended" : skill.status;
      const nextProcedure = { ...procedure, steps };
      const activeTraceIds = new Set(activePolicies.flatMap((policy) => policy.sourceTraceIds));
      const evidenceAnchorIds = skill.evidenceAnchorIds.filter((id) => activeTraceIds.has(id));
      const sourcePolicyIds = activePolicies.map((policy) => policy.id);
      const sourceWorldModelIds = skill.sourceWorldModelIds.filter((id) => {
        const world = this.deps.repos.memories.get(id);
        return Boolean(world && world.status === "activated");
      });
      const internal = memory.properties.internal_info;
      const internalSkill = isRecord(internal.skill) ? internal.skill : {};
      const policyContentHashes = filterRecordByKeys(
        isRecord(internalSkill.policy_content_hashes)
          ? internalSkill.policy_content_hashes
          : isRecord(internal.policy_content_hashes)
            ? internal.policy_content_hashes
            : {},
        activePolicyIds
      );
      const invocationGuide = shouldArchive
        ? skill.invocationGuide
        : renderSkillInvocationGuide({
            name: skill.name,
            procedureJson: nextProcedure,
            policy: activePolicies[0]!
          });
      const memoryStatus = shouldArchive
        ? "archived"
        : nextStatus === "active"
        ? "activated"
        : nextStatus === "candidate"
          ? "resolving"
          : "archived";
      const saved = this.deps.repos.memories.update({
        ...memory,
        status: memoryStatus,
        memoryValue: invocationGuide,
        info: {
          ...memory.info,
          status: nextStatus,
          source_memory_ids: sourcePolicyIds,
          source_policy_ids: sourcePolicyIds
        },
        properties: {
          ...memory.properties,
          status: memoryStatus,
          internal_info: {
            ...internal,
            status: nextStatus,
            source_memory_ids: sourcePolicyIds,
            source_policy_ids: sourcePolicyIds,
            source_world_model_ids: sourceWorldModelIds,
            evidence_anchor_ids: evidenceAnchorIds,
            invocation_guide: invocationGuide,
            procedure_json: nextProcedure,
            policy_content_hashes: policyContentHashes,
            skill: {
              ...internalSkill,
              status: nextStatus,
              source_policy_ids: sourcePolicyIds,
              source_world_model_ids: sourceWorldModelIds,
              evidence_anchor_ids: evidenceAnchorIds,
              invocation_guide: invocationGuide,
              procedure_json: nextProcedure,
              policy_content_hashes: policyContentHashes
            }
          }
        },
        updatedAt: at
      });
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: this.deps.namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: saved.status === "archived" ? "archived" : "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "skill_policy_source_invalidated",
        before: memory,
        after: saved,
        source: "governance.policy_invalidation",
        createdAt: at
      });
      if (!shouldArchive && this.deps.config.algorithm.capture.embedAfterCapture) {
        this.deps.enqueueJob({
          jobType: "embedding",
          userId: saved.userId,
          sessionId: saved.sessionId,
          targetMemoryId: saved.id,
          payload: { reason: "skill.policy_source_invalidated" },
          createdAt: at
        });
      }
    }
  }

  async crystallizeSkill(job: EvolutionJobRecord): Promise<void> {
    const source = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    const userId = source?.userId ?? job.userId;
    const at = nowIso();
    const policyMemories = source?.memoryLayer === "L2"
      ? [source]
      : this.deps.repos.memories
          .list({ memoryLayer: "L2", status: "activated" }, 1000);

    for (const policyMemory of policyMemories) {
      const startedAt = performance.now();
      const policy = policyMetaFromMemory(policyMemory);
      if (!policy || !policyIsEligibleForDownstream(policy)) continue;
      const evidenceTraces = this.gatherSkillEvidence(policy);
      const counterExamples = this.gatherSkillCounterExamples(policy);
      if (evidenceTraces.length === 0) {
        logEvolutionDecision(job, "skill_crystallization", "no_evidence", {
          policyId: policy.id
        });
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
      const requestedSkillId = typeof job.payload.skillId === "string" ? job.payload.skillId : undefined;
      const directSkills = this.mutableSkillsForPolicy(policy)
        .filter((skill) => skill.sourcePolicyIds.includes(policy.id));
      if (!requestedSkillId && directSkills.length > 1) {
        for (const skill of directSkills) {
          this.deps.enqueueJob({
            jobType: "skill_crystallization",
            userId,
            sessionId: policyMemory.sessionId ?? job.sessionId,
            episodeId: job.episodeId,
            targetMemoryId: policy.id,
            payload: {
              ...job.payload,
              reason: "policy.skill_fanout",
              skillId: skill.id
            },
            createdAt: at
          });
        }
        continue;
      }
      const targetSkillId = requestedSkillId ?? directSkills[0]?.id;
      const existingSkill = this.consolidateCompatibleSkillsForPolicy(
        policy,
        at,
        targetSkillId,
        job.payload.reason !== "policy.skill_fanout"
      );
      if (this.isSkillCrystallizationInCooldown(policy, at)) {
        logEvolutionDecision(job, "skill_crystallization", "cooldown", {
          policyId: policy.id,
          existingSkillId: existingSkill?.id
        });
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
        logEvolutionDecision(job, "skill_crystallization", enhancement.reason, {
          policyId: policy.id,
          evidenceCount: evidenceTraces.length,
          counterExampleCount: counterExamples.length
        });
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
        logEvolutionDecision(job, "skill_crystallization", "verification_failed", {
          policyId: policy.id,
          verdict
        });
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
        evidenceAnchorIds: uniq([...evidenceAnchorIds, ...draft.evidenceAnchorIds]).slice(0, 10),
        procedureJson: attachSkillStepPolicySources(
          draft.procedureJson,
          existingSkill?.memory,
          policy.id
        )
      };
      const policyContentHashes = {
        ...storedSkillPolicyContentHashes(existingSkill?.memory),
        [policy.id]: skillPolicyContentHash(policy)
      };
      const skill = this.deps.buildMemory({
        id: existingSkill?.id,
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
        key: existingSkill?.memory.memoryKey ?? stableSkillKey(verifiedDraft, policyMemory),
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
          read_only: false,
          generated_by_memory_base: true,
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
          policy_content_hashes: policyContentHashes,
          skill: {
            name: verifiedDraft.name,
            eta: verifiedDraft.eta,
            status: verifiedDraft.status,
            support: verifiedDraft.support,
            gain: verifiedDraft.gain,
            policy_content_hash: skillPolicyContentHash(policy),
            policy_content_hashes: policyContentHashes,
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
        elapsedApiLogMs(startedAt),
        true,
        nowIso()
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
    policy: PolicyMeta
  ): NonNullable<ReturnType<typeof skillMetaFromMemory>> | null {
    const candidates = this.mutableSkillsForPolicy(policy);
    const direct = candidates
      .filter((skill) => skill.sourcePolicyIds.includes(policy.id))
      .sort(compareSkillMergeTargets)[0];
    return direct ?? candidates
      .filter((skill) => skillPolicyCompatibility(skill, policy) >= 0.8)
      .sort(compareSkillMergeTargets)[0] ?? null;
  }

  private mutableSkillsForPolicy(policy: PolicyMeta): SkillMeta[] {
    return this.deps.repos.memories
      .list({ memoryLayer: "Skill" }, 1000)
      .map(skillMetaFromMemory)
      .filter((skill): skill is SkillMeta => Boolean(
        skill &&
        skill.memory.userId === policy.memory.userId &&
        skill.status !== "archived" &&
        !isReadOnlySkillMemory(skill.memory)
      ));
  }

  private consolidateCompatibleSkillsForPolicy(
    policy: PolicyMeta,
    at: string,
    targetSkillId?: string,
    allowTargetMerge = true
  ): SkillMeta | null {
    const mutableSkills = this.mutableSkillsForPolicy(policy);
    const target = targetSkillId
      ? mutableSkills.find((skill) => skill.id === targetSkillId)
      : undefined;
    if (target && !allowTargetMerge) return target;
    const compatible = mutableSkills
      .filter((skill) => skillPolicyCompatibility(skill, policy) >= 0.8)
      .sort(compareSkillMergeTargets);
    const seed = target ?? compatible[0];
    const mergeable = seed
      ? mutableSkills.filter((skill) =>
          skill.id !== seed.id &&
          skillPolicyCompatibility(skill, policy) >= 0.8 &&
          skillsAreCompatibleForMerge(seed, skill)
        )
      : [];
    const candidates = seed ? [seed, ...mergeable].sort(compareSkillMergeTargets) : [];
    const canonical = candidates[0];
    if (!canonical || candidates.length === 1) return canonical ?? null;

    const aliases = candidates.slice(1);
    const sourcePolicyIds = uniq(candidates.flatMap((skill) => skill.sourcePolicyIds));
    const sourceWorldModelIds = uniq(candidates.flatMap((skill) => skill.sourceWorldModelIds));
    const evidenceAnchorIds = uniq(candidates.flatMap((skill) => skill.evidenceAnchorIds)).slice(0, 20);
    const procedureJson = mergeCompatibleSkillProcedures(candidates.map((skill) => skill.memory));
    const policyContentHashes = Object.assign(
      {},
      ...candidates.map((skill) => storedSkillPolicyContentHashes(skill.memory))
    ) as Record<string, string>;
    const nextStatus = candidates.some((skill) => skill.status === "active") ? "active" : "candidate";
    const internal = canonical.memory.properties.internal_info;
    const internalSkill = isRecord(internal.skill) ? internal.skill : {};
    const saved = this.deps.repos.memories.update({
      ...canonical.memory,
      status: nextStatus === "active" ? "activated" : "resolving",
      tags: uniq(candidates.flatMap((skill) => skill.memory.tags)),
      info: {
        ...canonical.memory.info,
        status: nextStatus,
        source_memory_ids: sourcePolicyIds,
        source_policy_ids: sourcePolicyIds
      },
      properties: {
        ...canonical.memory.properties,
        status: nextStatus === "active" ? "activated" : "resolving",
        internal_info: {
          ...internal,
          status: nextStatus,
          source_memory_ids: sourcePolicyIds,
          source_policy_ids: sourcePolicyIds,
          source_world_model_ids: sourceWorldModelIds,
          evidence_anchor_ids: evidenceAnchorIds,
          procedure_json: procedureJson,
          policy_content_hashes: policyContentHashes,
          skill: {
            ...internalSkill,
            status: nextStatus,
            source_policy_ids: sourcePolicyIds,
            source_world_model_ids: sourceWorldModelIds,
            evidence_anchor_ids: evidenceAnchorIds,
            procedure_json: procedureJson,
            policy_content_hashes: policyContentHashes
          }
        }
      },
      updatedAt: at
    });
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: this.deps.namespaceIdFromMemory(saved),
      kind: kindFromMemory(saved),
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "skill_compatible_merge",
      before: canonical.memory,
      after: saved,
      source: "worker.skill_crystallization.merge.v1",
      createdAt: at
    });

    for (const alias of aliases) {
      const aliasInternal = alias.memory.properties.internal_info;
      const aliasSkill = isRecord(aliasInternal.skill) ? aliasInternal.skill : {};
      const archived = this.deps.repos.memories.update({
        ...alias.memory,
        status: "archived",
        info: {
          ...alias.memory.info,
          status: "archived",
          merged_into_skill_id: saved.id
        },
        properties: {
          ...alias.memory.properties,
          status: "archived",
          internal_info: {
            ...aliasInternal,
            status: "archived",
            merged_into_skill_id: saved.id,
            skill: {
              ...aliasSkill,
              status: "archived",
              merged_into_skill_id: saved.id
            }
          }
        },
        updatedAt: at
      });
      this.deps.repos.runtime.appendChange({
        memoryId: archived.id,
        namespaceId: this.deps.namespaceIdFromMemory(archived),
        kind: kindFromMemory(archived),
        op: "archived",
        entityId: archived.id,
        userId: archived.userId,
        changeType: "skill_merged_into_canonical",
        before: alias.memory,
        after: archived,
        source: "worker.skill_crystallization.merge.v1",
        createdAt: at
      });
    }
    return skillMetaFromMemory(saved);
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

private gatherSkillEvidence(policy: PolicyMeta): TraceMeta[] {
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

private gatherSkillCounterExamples(policy: PolicyMeta): TraceMeta[] {
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
      const startedAt = performance.now();
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
        elapsedApiLogMs(startedAt),
        true,
        nowIso()
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
              captured_at: formatZonedTime(trace.ts, trace.timeZone),
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
                    captured_at: formatZonedTime(trace.ts, trace.timeZone),
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
                    captured_at: formatZonedTime(trace.ts, trace.timeZone),
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
        temperature: 0.2
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

function filterRecordByKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)));
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
  const previousPolicyHash = storedSkillPolicyContentHash(existingSkill.memory, policy.id);
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

function storedSkillPolicyContentHash(memory: MemoryRow, policyId?: string): string | null {
  const internal = memory.properties.internal_info;
  const skill = isRecord(internal.skill) ? internal.skill : {};
  const hashes = isRecord(skill.policy_content_hashes)
    ? skill.policy_content_hashes
    : isRecord(internal.policy_content_hashes)
      ? internal.policy_content_hashes
      : {};
  if (policyId && typeof hashes[policyId] === "string") return hashes[policyId];
  const value = skill.policy_content_hash ?? internal.policy_content_hash;
  return typeof value === "string" && value ? value : null;
}

function storedSkillPolicyContentHashes(memory: MemoryRow | undefined): Record<string, string> {
  if (!memory) return {};
  const internal = memory.properties.internal_info;
  const skill = isRecord(internal.skill) ? internal.skill : {};
  const raw = isRecord(skill.policy_content_hashes)
    ? skill.policy_content_hashes
    : isRecord(internal.policy_content_hashes)
      ? internal.policy_content_hashes
      : {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
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
  if (Object.keys(existing).length === 0) {
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
    steps: allowed.has("steps")
      ? mergeSkillSteps(existing.steps, draft.steps)
      : existing.steps ?? draft.steps,
    examples: mergeField("examples"),
    decisionGuidance: mergeField("decisionGuidance"),
    tags: mergeField("tags"),
    tools: mergeField("tools")
  };
}

function mergeCompatibleSkillProcedures(memories: MemoryRow[]): Record<string, unknown> {
  const [first, ...rest] = memories;
  if (!first) return {};
  let merged = procedureWithPolicySources(first);
  for (const memory of rest) {
    const next = procedureWithPolicySources(memory);
    merged = {
      ...next,
      ...merged,
      steps: mergeCompatibleSkillSteps(merged.steps, next.steps)
    };
  }
  return merged;
}

function procedureWithPolicySources(memory: MemoryRow): Record<string, unknown> {
  const procedure = skillProcedureJsonFromMemory(memory);
  const policyIds = skillMetaFromMemory(memory)?.sourcePolicyIds ?? [];
  const steps = Array.isArray(procedure.steps) ? procedure.steps.filter(isRecord) : [];
  return {
    ...procedure,
    steps: steps.map((step) => ({
      ...step,
      supportingPolicyIds: uniq([
        ...stringArray(step.supportingPolicyIds ?? step.supporting_policy_ids),
        ...(stringArray(step.supportingPolicyIds ?? step.supporting_policy_ids).length === 0 ? policyIds : [])
      ])
    }))
  };
}

function mergeCompatibleSkillSteps(existing: unknown, incoming: unknown): unknown {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) return existing ?? incoming;
  const merged = existing.filter(isRecord).map((step) => ({ ...step }));
  const byId = new Map(merged.flatMap((step) =>
    typeof step.id === "string" && step.id ? [[step.id, step] as const] : []
  ));
  const byTitle = new Map(merged.map((step) => [normalizeSkillStepTitle(step.title), step]));
  for (const step of incoming.filter(isRecord)) {
    const current = (typeof step.id === "string" ? byId.get(step.id) : undefined) ??
      byTitle.get(normalizeSkillStepTitle(step.title));
    if (!current) {
      merged.push({ ...step });
      continue;
    }
    Object.assign(current, {
      ...step,
      ...current,
      supportingPolicyIds: uniq([
        ...stringArray(current.supportingPolicyIds ?? current.supporting_policy_ids),
        ...stringArray(step.supportingPolicyIds ?? step.supporting_policy_ids)
      ])
    });
  }
  return merged;
}

function mergeSkillSteps(existing: unknown, draft: unknown): unknown {
  if (!Array.isArray(existing) || !Array.isArray(draft)) return draft ?? existing;
  const additions = draft.filter(isRecord);
  const byId = new Map(additions.flatMap((step) =>
    typeof step.id === "string" && step.id ? [[step.id, step] as const] : []
  ));
  const byTitle = new Map(additions.map((step) => [normalizeSkillStepTitle(step.title), step]));
  const consumed = new Set<Record<string, unknown>>();
  const merged = existing.filter(isRecord).map((step) => {
    const replacement = (typeof step.id === "string" ? byId.get(step.id) : undefined) ??
      byTitle.get(normalizeSkillStepTitle(step.title));
    if (!replacement) return step;
    consumed.add(replacement);
    return { ...step, ...replacement };
  });
  for (const step of additions) if (!consumed.has(step)) merged.push(step);
  return merged;
}

function attachSkillStepPolicySources(
  procedure: Record<string, unknown>,
  existingMemory: MemoryRow | undefined,
  policyId: string
): Record<string, unknown> {
  const existingProcedure = skillProcedureJsonFromMemory(existingMemory);
  const existingSteps = Array.isArray(existingProcedure.steps)
    ? existingProcedure.steps.filter(isRecord)
    : [];
  const byId = new Map(existingSteps.flatMap((step) =>
    typeof step.id === "string" && step.id ? [[step.id, step] as const] : []
  ));
  const byTitle = new Map(existingSteps.map((step) => [normalizeSkillStepTitle(step.title), step]));
  const steps = Array.isArray(procedure.steps) ? procedure.steps.filter(isRecord) : [];
  return {
    ...procedure,
    steps: steps.map((step) => {
      const title = skillText(step.title) || "Step";
      const body = skillMarkdown(step.body);
      const existing = (typeof step.id === "string" ? byId.get(step.id) : undefined) ??
        byTitle.get(normalizeSkillStepTitle(title));
      const existingBody = existing ? skillMarkdown(existing.body) : "";
      const supportingPolicyIds = uniq([
        ...stringArray(existing?.supportingPolicyIds ?? existing?.supporting_policy_ids),
        ...(!existing || existingBody !== body ? [policyId] : [])
      ]);
      return {
        ...step,
        id: typeof existing?.id === "string" && existing.id
          ? existing.id
          : typeof step.id === "string" && step.id
            ? step.id
            : `step_${stableHash(`${title}\n${body}`).slice(0, 12)}`,
        title,
        body,
        supportingPolicyIds
      };
    })
  };
}

function normalizeSkillStepTitle(value: unknown): string {
  return skillText(value).toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

function isReadOnlySkillMemory(memory: MemoryRow): boolean {
  const internal = memory.properties.internal_info;
  return internal.read_only === true || internal.generated_by_memory_base !== true;
}

function compareSkillMergeTargets(
  left: NonNullable<ReturnType<typeof skillMetaFromMemory>>,
  right: NonNullable<ReturnType<typeof skillMetaFromMemory>>
): number {
  const active = (skill: NonNullable<ReturnType<typeof skillMetaFromMemory>>) => skill.status === "active" ? 1 : 0;
  return active(right) - active(left) ||
    right.trialsPassed - left.trialsPassed ||
    Date.parse(left.memory.createdAt) - Date.parse(right.memory.createdAt) ||
    left.id.localeCompare(right.id);
}

function skillPolicyCompatibility(
  skill: NonNullable<ReturnType<typeof skillMetaFromMemory>>,
  policy: PolicyMeta
): number {
  if (skill.memory.userId !== policy.memory.userId) return 0;
  const skillProject = projectIdFromMemory(skill.memory);
  const policyProject = projectIdFromMemory(policy.memory);
  if (skillProject && policyProject && skillProject !== policyProject) return 0;
  const skillProfile = profileIdFromMemory(skill.memory);
  const policyProfile = profileIdFromMemory(policy.memory);
  if (skillProfile && policyProfile && skillProfile !== policyProfile) return 0;

  const genericTags = new Set(["skill", "policy", "active", "candidate"]);
  const skillTags = new Set(skill.memory.tags.map((tag) => tag.toLowerCase()).filter((tag) => !genericTags.has(tag)));
  const policyTags = new Set(policy.memory.tags.map((tag) => tag.toLowerCase()).filter((tag) => !genericTags.has(tag)));
  const tagCompatible = [...policyTags].some((tag) => skillTags.has(tag));
  const lexical = textTokenOverlap(
    `${skill.name}\n${skill.invocationGuide}`,
    `${policy.title}\n${policy.trigger}\n${policy.procedure}`
  );
  if (!tagCompatible && lexical < 0.25) return 0;
  const vector = skill.vec && policy.vec ? cosine(skill.vec, policy.vec) : 0;
  return Math.max(lexical, vector);
}

function skillsAreCompatibleForMerge(left: SkillMeta, right: SkillMeta): boolean {
  if (left.memory.userId !== right.memory.userId) return false;
  const leftProject = projectIdFromMemory(left.memory);
  const rightProject = projectIdFromMemory(right.memory);
  if (leftProject && rightProject && leftProject !== rightProject) return false;
  const leftProfile = profileIdFromMemory(left.memory);
  const rightProfile = profileIdFromMemory(right.memory);
  if (leftProfile && rightProfile && leftProfile !== rightProfile) return false;

  const genericTags = new Set(["skill", "policy", "active", "candidate"]);
  const leftTags = new Set(left.memory.tags.map((tag) => tag.toLowerCase()).filter((tag) => !genericTags.has(tag)));
  const rightTags = new Set(right.memory.tags.map((tag) => tag.toLowerCase()).filter((tag) => !genericTags.has(tag)));
  if (![...leftTags].some((tag) => rightTags.has(tag))) return false;

  const lexical = textTokenOverlap(
    `${left.name}\n${left.invocationGuide}`,
    `${right.name}\n${right.invocationGuide}`
  );
  const vector = left.vec && right.vec ? cosine(left.vec, right.vec) : 0;
  return lexical >= 0.5 || (lexical >= 0.25 && vector >= 0.8);
}

function textTokenOverlap(left: string, right: string): number {
  const tokens = (value: string) => new Set(
    value.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9_]{3,}/gu) ?? []
  );
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

function stableSkillKey(draft: SkillDraft, policyMemory: MemoryRow): string {
  return `skill:${stableHash({
    userId: policyMemory.userId,
    projectId: projectIdFromMemory(policyMemory),
    profileId: profileIdFromMemory(policyMemory),
    name: draft.name,
    tools: isRecord(draft.procedureJson) ? draft.procedureJson.tools : undefined
  }).slice(0, 20)}`;
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
