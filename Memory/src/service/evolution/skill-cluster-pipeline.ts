import {
  DEFAULT_DIRECT_SKILL_CLUSTERING,
  DIRECT_SKILL_META_PROMPT,
  DIRECT_SKILL_PLUGIN,
  DIRECT_SKILL_SOURCE,
  SEED_META_SKILL_MD,
  classifySkillOutcome,
  clusterHasUsableSkill,
  coerceDirectSkillName,
  coerceDirectSkillProcedure,
  decideClusterAssignment,
  decideEvolveBranch,
  evidenceToolNames,
  extractEpisodeSkillFeatures,
  firstUserQuery,
  isEvalSplitTest,
  mergeCentroid,
  mergeProcedureByScope,
  packRawTurnEvidence,
  procedureJsonFromUnknown,
  renderDirectSkillCrystallizeSystem,
  renderDirectSkillGuide,
  renderDirectSkillRebuildSystem,
  selectTop6Members,
  verifyDirectSkillDraft,
  type DirectSkillClusteringConfig,
  type DirectSkillProcedureJson,
  type DirectSkillRebuildScope,
  type EpisodeSkillFeatures,
  type OutcomeThresholds,
  type PackedEpisodeEvidence,
  type SkillClusterFeatures
} from "../../algorithm/trace-direct-skill.js";
import {
  detectDominantLanguage,
  languageSteeringLine,
  skillMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import { kindFromMemory, type EpisodeRecord, type EvolutionJobRecord, type Repositories, type SkillClusterRecord } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { newId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { elapsedApiLogMs, recordApiLog } from "../model-audit/model-call-audit.js";
import { profileIdFromMemory } from "../namespace/namespace-scope.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { logEvolutionDecision } from "./evolution-logging.js";

export interface SkillClusterPipelineDeps {
  repos: Repositories;
  config: MemmyConfig;
  skillLlm: LlmClient;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertEvolutionMemory(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string;
  queryVector?(query: string): Promise<number[] | undefined>;
}

export class SkillClusterPipeline {
  constructor(private readonly deps: SkillClusterPipelineDeps) {}

  async assignCluster(job: EvolutionJobRecord): Promise<void> {
    const episodeId = job.episodeId;
    if (!episodeId) {
      logEvolutionDecision(job, "skill_cluster_assign", "missing_episode");
      return;
    }
    const episode = this.deps.repos.runtime.getEpisode(episodeId);
    if (!episode) {
      logEvolutionDecision(job, "skill_cluster_assign", "episode_not_found", { episodeId });
      return;
    }
    if (isEvalSplitTest(episode.meta)) {
      logEvolutionDecision(job, "skill_cluster_assign", "test_episode_skipped", { episodeId });
      return;
    }
    if (typeof episode.rTask !== "number") {
      logEvolutionDecision(job, "skill_cluster_assign", "unscored_episode", { episodeId });
      return;
    }

    const at = nowIso();
    const features = await this.featuresForEpisode(episode);
    const existing = this.deps.repos.runtime.getSkillClusterForEpisode(episode.id);
    let cluster: SkillClusterRecord;
    if (existing) {
      cluster = this.refreshClusterFeatures(existing, features, at);
      this.deps.repos.runtime.upsertSkillClusterMember({
        clusterId: cluster.id,
        episodeId: episode.id,
        outcome: features.outcome,
        rTask: episode.rTask,
        assignedAt: at
      });
    } else {
      const candidates = this.deps.repos.runtime.listSkillClustersByScope({
        userId: episode.userId,
        projectId: episode.projectId
      });
      const decision = decideClusterAssignment(features, candidates.map(clusterFeatures), this.clusteringConfig());
      logEvolutionDecision(job, "skill_cluster_assign", decision.reason, {
        episodeId: episode.id,
        clusterId: decision.clusterId,
        score: decision.score,
        stage: decision.stage,
        tools: features.tools,
        artifacts: features.artifacts,
        hasQueryVec: Boolean(features.queryVec?.length)
      });
      if (decision.action === "join" && decision.clusterId) {
        const joined = this.deps.repos.runtime.getSkillCluster(decision.clusterId);
        if (!joined) {
          cluster = this.createCluster(episode, features, at);
        } else {
          cluster = this.refreshClusterFeatures(joined, features, at);
        }
      } else {
        cluster = this.createCluster(episode, features, at);
      }
      this.deps.repos.runtime.upsertSkillClusterMember({
        clusterId: cluster.id,
        episodeId: episode.id,
        outcome: features.outcome,
        rTask: episode.rTask,
        assignedAt: at
      });
    }

    this.deps.repos.runtime.updateEpisodeMeta(episode.id, { skill_cluster_id: cluster.id }, at);
    this.deps.enqueueJob({
      jobType: "skill_batch_evolve",
      userId: episode.userId,
      sessionId: episode.sessionId,
      episodeId: episode.id,
      payload: {
        reason: "skill_cluster_assign",
        clusterId: cluster.id
      },
      createdAt: at
    });
  }

  async evolveCluster(job: EvolutionJobRecord): Promise<void> {
    const clusterId = typeof job.payload.clusterId === "string"
      ? job.payload.clusterId
      : this.clusterIdFromJob(job);
    if (!clusterId) {
      logEvolutionDecision(job, "skill_batch_evolve", "missing_cluster");
      return;
    }
    const cluster = this.deps.repos.runtime.getSkillCluster(clusterId);
    if (!cluster) {
      logEvolutionDecision(job, "skill_batch_evolve", "cluster_not_found", { clusterId });
      return;
    }

    const members = this.deps.repos.runtime.listSkillClusterMembers(cluster.id);
    const scoredMembers = members.flatMap((member) => {
      const episode = this.deps.repos.runtime.getEpisode(member.episodeId);
      if (!episode || typeof episode.rTask !== "number") return [];
      return [{
        episodeId: episode.id,
        outcome: classifySkillOutcome(episode.rTask, this.outcomeThresholds()),
        rTask: episode.rTask,
        updatedAt: episode.updatedAt
      }];
    });
    const top6 = selectTop6Members(scoredMembers, this.clusteringConfig());
    if (top6.length === 0) {
      logEvolutionDecision(job, "skill_batch_evolve", "empty_batch", { clusterId: cluster.id });
      return;
    }

    const batch = top6.map((member) => this.packEpisode(member.episodeId, member.outcome, member.rTask));
    const existingSkill = this.clusterSkill(cluster);
    const hasSkill = Boolean(existingSkill);
    const processed = new Set(cluster.processedEpisodeIds);
    const newEpisodeIds = top6
      .map((item) => item.episodeId)
      .filter((id) => !processed.has(id));
    const newSuccessTools = batch
      .filter((item) => item.outcome === "success" && newEpisodeIds.includes(item.episode_id))
      .flatMap((item) => item.turns.flatMap((turn) => turn.tools.map((tool) => tool.name)));
    const branch = decideEvolveBranch({
      hasSkill,
      batch: batch.map((item) => ({ outcome: item.outcome, episodeId: item.episode_id })),
      newEpisodeIds,
      existingTools: existingSkill
        ? procedureJsonFromUnknown(existingSkill.memory.properties.internal_info.procedure_json).tools
        : [],
      newSuccessTools
    });

    const at = nowIso();
    const startedAt = performance.now();
    let rejectReason: string | undefined;
    let skillBefore = existingSkill
      ? procedureJsonFromUnknown(existingSkill.memory.properties.internal_info.skill && isRecord(existingSkill.memory.properties.internal_info.skill)
        ? existingSkill.memory.properties.internal_info.skill.procedure_json
        : existingSkill.memory.properties.internal_info.procedure_json)
      : null;
    if (!skillBefore && existingSkill) {
      skillBefore = procedureJsonFromUnknown(
        isRecord(existingSkill.memory.properties.internal_info.skill)
          ? existingSkill.memory.properties.internal_info.skill.procedure_json
          : undefined
      );
    }
    let skillAfter: DirectSkillProcedureJson | null = skillBefore;
    let rebuildScope: DirectSkillRebuildScope | "crystallize" | "skip_no_success_anchor" | "skip_unknown_only" =
      branch.action === "rebuild" ? branch.rebuildScope ?? "retrieval" : branch.action === "crystallize" ? "crystallize" : branch.action;

    if (branch.action === "skip_unknown_only") {
      logEvolutionDecision(job, "skill_batch_evolve", branch.reason, { clusterId: cluster.id });
      await this.updateMetaSkill(job, cluster, {
        accepted: false,
        rejectReason: branch.reason,
        skillBefore,
        skillAfter,
        batch,
        rebuildScope
      });
      return;
    }

    if (branch.action === "skip_no_success_anchor") {
      logEvolutionDecision(job, "skill_batch_evolve", branch.reason, { clusterId: cluster.id });
      const next = this.markProcessed(cluster, top6.map((item) => item.episodeId), at);
      await this.updateMetaSkill(job, next, {
        accepted: false,
        rejectReason: branch.reason,
        skillBefore,
        skillAfter,
        batch,
        rebuildScope: "skip_no_success_anchor"
      });
      return;
    }

    if (!this.deps.config.algorithm.skill.useLlm || !this.deps.skillLlm.isConfigured()) {
      rejectReason = "llm_disabled";
      logEvolutionDecision(job, "skill_batch_evolve", rejectReason, { clusterId: cluster.id });
      await this.updateMetaSkill(job, cluster, {
        accepted: false,
        rejectReason,
        skillBefore,
        skillAfter,
        batch,
        rebuildScope
      });
      return;
    }

    try {
      const draft = await this.generateProcedure({
        cluster,
        batch,
        existing: skillBefore,
        rebuildScope: branch.action === "rebuild" ? branch.rebuildScope ?? "retrieval" : undefined
      });
      const merged = skillBefore && branch.rebuildScope
        ? mergeProcedureByScope(skillBefore, draft.procedure, branch.rebuildScope)
        : draft.procedure;
      const name = skillBefore && existingSkill
        ? existingSkill.name
        : coerceDirectSkillName(draft.name, `cluster_${cluster.id.slice(0, 8)}`);
      const gate = verifyDirectSkillDraft({ name, procedure: merged, batch });
      if (!gate.ok) {
        rejectReason = gate.reasons.join(",");
        logEvolutionDecision(job, "skill_batch_evolve", "verification_failed", {
          clusterId: cluster.id,
          reasons: gate.reasons
        });
        await this.updateMetaSkill(job, this.markProcessed(cluster, top6.map((item) => item.episodeId), at), {
          accepted: false,
          rejectReason,
          skillBefore,
          skillAfter: merged,
          batch,
          rebuildScope
        });
        return;
      }

      const upserted = this.upsertSkill({
        job,
        cluster,
        episode: this.anchorEpisode(batch, job),
        name,
        procedure: merged,
        existing: existingSkill?.memory,
        successEpisodeIds: batch.filter((item) => item.outcome === "success").map((item) => item.episode_id),
        at
      });
      skillAfter = merged;
      const withSkill = {
        ...this.markProcessed(cluster, top6.map((item) => item.episodeId), at),
        skillMemoryId: upserted.memory.id
      };
      this.deps.repos.runtime.updateSkillCluster(withSkill);
      await this.updateMetaSkill(job, withSkill, {
        accepted: true,
        skillBefore,
        skillAfter,
        batch,
        rebuildScope
      });
      recordApiLog(
        this.deps.repos.runtime,
        upserted.created ? "skill_generate" : "skill_evolve",
        { phase: "done", skillId: upserted.memory.id, clusterId: cluster.id },
        {
          skillId: upserted.memory.id,
          kind: upserted.created ? "skill.direct_crystallized" : "skill.direct_rebuilt",
          name,
          source: DIRECT_SKILL_SOURCE
        },
        elapsedApiLogMs(startedAt),
        true,
        nowIso()
      );
    } catch (error) {
      rejectReason = error instanceof Error ? error.message : String(error);
      logEvolutionDecision(job, "skill_batch_evolve", "llm-failed", {
        clusterId: cluster.id,
        error: rejectReason
      });
      await this.updateMetaSkill(job, cluster, {
        accepted: false,
        rejectReason,
        skillBefore,
        skillAfter,
        batch,
        rebuildScope
      });
      throw error;
    }
  }

  private clusteringConfig(): DirectSkillClusteringConfig {
    const skill = this.deps.config.algorithm.skill;
    return {
      ...DEFAULT_DIRECT_SKILL_CLUSTERING,
      joinThreshold: skill.clusterJoinThreshold,
      joinThresholdEmpty: skill.clusterJoinThresholdEmpty,
      toolJaccardFloor: skill.toolJaccardFloor,
      artifactJaccardFloor: skill.artifactJaccardFloor,
      batchSuccessLimit: skill.batchSuccessLimit,
      batchFailureLimit: skill.batchFailureLimit
    };
  }

  private outcomeThresholds(): OutcomeThresholds {
    return {
      success: this.deps.config.algorithm.skill.outcomeRTaskSuccessThreshold,
      failure: this.deps.config.algorithm.skill.outcomeRTaskFailureThreshold
    };
  }

  private async featuresForEpisode(episode: EpisodeRecord): Promise<EpisodeSkillFeatures> {
    const turns = this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, 1000);
    const queryText = firstUserQuery(turns);
    let queryVec: number[] | null = null;
    if (queryText && this.deps.queryVector) {
      try {
        queryVec = (await this.deps.queryVector(queryText)) ?? null;
      } catch {
        queryVec = null;
      }
    }
    return extractEpisodeSkillFeatures({
      episodeId: episode.id,
      userId: episode.userId,
      projectId: episode.projectId,
      rTask: episode.rTask,
      turns,
      queryVec,
      thresholds: this.outcomeThresholds()
    });
  }

  private createCluster(episode: EpisodeRecord, features: EpisodeSkillFeatures, at: string): SkillClusterRecord {
    return this.deps.repos.runtime.insertSkillCluster({
      id: newId("skc"),
      userId: episode.userId,
      projectId: episode.projectId,
      tools: features.tools,
      artifacts: features.artifacts,
      toolBigrams: features.toolBigrams,
      centroid: features.queryVec,
      metaSkillMd: SEED_META_SKILL_MD,
      processedEpisodeIds: [],
      memberCount: 1,
      createdAt: at,
      updatedAt: at
    });
  }

  private refreshClusterFeatures(
    cluster: SkillClusterRecord,
    features: EpisodeSkillFeatures,
    at: string
  ): SkillClusterRecord {
    const alreadyMember = this.deps.repos.runtime
      .listSkillClusterMembers(cluster.id)
      .some((member) => member.episodeId === features.episodeId);
    const next: SkillClusterRecord = {
      ...cluster,
      tools: uniqSorted([...cluster.tools, ...features.tools]),
      artifacts: uniqSorted([...cluster.artifacts, ...features.artifacts]),
      toolBigrams: uniqSorted([...cluster.toolBigrams, ...features.toolBigrams]),
      centroid: mergeCentroid(cluster.centroid, features.queryVec, cluster.memberCount),
      memberCount: alreadyMember ? cluster.memberCount : cluster.memberCount + 1,
      updatedAt: at
    };
    return this.deps.repos.runtime.updateSkillCluster(next);
  }

  private clusterSkill(cluster: SkillClusterRecord) {
    if (!cluster.skillMemoryId) return null;
    const memory = this.deps.repos.memories.get(cluster.skillMemoryId);
    if (!memory) return null;
    if (!clusterHasUsableSkill({
      skillMemoryId: memory.id,
      layer: memory.memoryLayer,
      status: memory.status
    })) {
      return null;
    }
    return skillMetaFromMemory(memory);
  }

  private packEpisode(episodeId: string, outcome: PackedEpisodeEvidence["outcome"], rTask?: number): PackedEpisodeEvidence {
    const turns = this.deps.repos.runtime.listRawTurnsByEpisode(episodeId, 1000);
    return {
      episode_id: episodeId,
      r_task: typeof rTask === "number" ? rTask : null,
      outcome,
      turns: packRawTurnEvidence(turns, this.clusteringConfig().toolOutputClip)
    };
  }

  private clusterIdFromJob(job: EvolutionJobRecord): string | undefined {
    if (job.episodeId) {
      const cluster = this.deps.repos.runtime.getSkillClusterForEpisode(job.episodeId);
      if (cluster) return cluster.id;
      const episode = this.deps.repos.runtime.getEpisode(job.episodeId);
      const fromMeta = episode && typeof episode.meta.skill_cluster_id === "string"
        ? episode.meta.skill_cluster_id
        : undefined;
      if (fromMeta) return fromMeta;
    }
    return undefined;
  }

  private markProcessed(cluster: SkillClusterRecord, episodeIds: string[], at: string): SkillClusterRecord {
    const processedEpisodeIds = uniqSorted([...cluster.processedEpisodeIds, ...episodeIds]);
    const next = { ...cluster, processedEpisodeIds, updatedAt: at };
    return this.deps.repos.runtime.updateSkillCluster(next);
  }

  private async generateProcedure(input: {
    cluster: SkillClusterRecord;
    batch: PackedEpisodeEvidence[];
    existing: DirectSkillProcedureJson | null;
    rebuildScope?: DirectSkillRebuildScope;
  }): Promise<{ name: string; procedure: DirectSkillProcedureJson; changedSections: string[] }> {
    const languageSamples = input.batch.flatMap((item) => item.turns.flatMap((turn) => [turn.user, turn.assistant]));
    const outputLanguage = this.deps.config.algorithm.skill.outputLanguageMode === "zh" ||
      this.deps.config.algorithm.skill.outputLanguageMode === "en"
      ? this.deps.config.algorithm.skill.outputLanguageMode
      : detectDominantLanguage(languageSamples) === "zh" ? "zh" : "en";
    const success = input.batch.filter((item) => item.outcome === "success");
    const failure = input.batch.filter((item) => item.outcome === "failure");
    const result = await this.deps.skillLlm.completeJson<Record<string, unknown>>([
      {
        role: "system",
        content: input.rebuildScope
          ? renderDirectSkillRebuildSystem(input.cluster.metaSkillMd)
          : renderDirectSkillCrystallizeSystem(input.cluster.metaSkillMd)
      },
      {
        role: "system",
        content: languageSteeringLine(detectDominantLanguage(languageSamples))
      },
      {
        role: "user",
        content: JSON.stringify({
          POLICY: {},
          EXISTING_SKILL_SNAPSHOT: input.existing,
          REBUILD_SCOPE: input.rebuildScope ?? "crystallize",
          REPAIR_RENAME_ALLOWED: false,
          EVIDENCE: success,
          COUNTER_EXAMPLES: failure,
          EVIDENCE_TOOLS: evidenceToolNames(input.batch),
          OUTPUT_LANGUAGE: outputLanguage,
          NAMING_SPACE: this.deps.repos.memories
            .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 200)
            .map((memory) => skillMetaFromMemory(memory)?.name)
            .filter((name): name is string => Boolean(name))
        })
      }
    ], {
      operation: input.rebuildScope ? "skill.batch_evolve.rebuild" : "skill.batch_evolve.crystallize",
      jsonMode: true,
      temperature: 0.2
    });
    const procedure = coerceDirectSkillProcedure(result);
    const changedSections = Array.isArray(result.changed_sections)
      ? result.changed_sections.filter((item): item is string => typeof item === "string")
      : Array.isArray(result.changedSections)
        ? result.changedSections.filter((item): item is string => typeof item === "string")
        : [];
    return {
      name: coerceDirectSkillName(result.name, "direct_skill"),
      procedure,
      changedSections
    };
  }

  private upsertSkill(input: {
    job: EvolutionJobRecord;
    cluster: SkillClusterRecord;
    episode?: EpisodeRecord;
    name: string;
    procedure: DirectSkillProcedureJson;
    existing?: MemoryRow;
    successEpisodeIds: string[];
    at: string;
  }): { memory: MemoryRow; created: boolean; previous?: MemoryRow } {
    const invocationGuide = renderDirectSkillGuide(input.name, input.procedure);
    const evidenceAnchorIds = uniqSorted([
      ...((input.existing ? skillMetaFromMemory(input.existing)?.evidenceAnchorIds : []) ?? []),
      ...input.successEpisodeIds
    ]);
    const seed = input.existing ?? input.episode;
    const memory = this.deps.buildMemory({
      id: input.existing?.id,
      userId: input.cluster.userId,
      conversationId: seed && "conversationId" in seed ? seed.conversationId : undefined,
      sessionId: input.episode?.sessionId ?? input.job.sessionId,
      projectId: input.cluster.projectId ?? (input.episode ? input.episode.projectId : undefined),
      profileId: input.existing ? profileIdFromMemory(input.existing) : undefined,
      layer: "Skill",
      kind: "skill",
      lifecycleStatus: "active",
      memoryType: "SkillMemory",
      key: input.existing?.memoryKey ?? `skill:direct:${input.cluster.id}`,
      value: invocationGuide,
      tags: uniqSorted(["skill", "direct-trace", ...input.procedure.tags, ...input.procedure.tools]),
      info: {
        name: input.name,
        eta: 0.6,
        status: "active",
        source_memory_ids: []
      },
      internal: {
        source: DIRECT_SKILL_SOURCE,
        plugin_algorithm: DIRECT_SKILL_PLUGIN,
        read_only: false,
        generated_by_memory_base: true,
        source_memory_ids: [],
        source_policy_ids: [],
        source_world_model_ids: [],
        evidence_anchor_ids: evidenceAnchorIds,
        name: input.name,
        invocation_guide: invocationGuide,
        procedure_json: input.procedure,
        eta: 0.6,
        support: evidenceAnchorIds.length,
        gain: 0.4,
        skill: {
          name: input.name,
          eta: 0.6,
          status: "active",
          support: evidenceAnchorIds.length,
          gain: 0.4,
          source_policy_ids: [],
          source_world_model_ids: [],
          evidence_anchor_ids: evidenceAnchorIds,
          invocation_guide: invocationGuide,
          procedure_json: input.procedure
        }
      },
      createdAt: input.at
    });
    const upsert = this.deps.upsertEvolutionMemory(memory);
    for (const episodeId of input.successEpisodeIds) {
      this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "Skill", upsert.memory.id, input.at);
    }
    this.deps.repos.runtime.appendChange({
      memoryId: upsert.memory.id,
      namespaceId: this.deps.namespaceIdFromMemory(upsert.memory),
      kind: kindFromMemory(upsert.memory),
      op: upsert.created ? "created" : "updated",
      entityId: upsert.memory.id,
      userId: input.cluster.userId,
      changeType: upsert.created ? "create" : "update",
      before: upsert.previous,
      after: upsert.memory,
      source: DIRECT_SKILL_SOURCE,
      createdAt: input.at
    });
    if (this.deps.config.algorithm.capture.embedAfterCapture) {
      this.deps.enqueueJob({
        jobType: "embedding",
        userId: input.cluster.userId,
        sessionId: input.episode?.sessionId ?? input.job.sessionId,
        episodeId: input.successEpisodeIds[0],
        targetMemoryId: upsert.memory.id,
        payload: { reason: "skill.direct_upserted", clusterId: input.cluster.id },
        createdAt: input.at
      });
    }
    return upsert;
  }

  private anchorEpisode(batch: PackedEpisodeEvidence[], job: EvolutionJobRecord): EpisodeRecord | undefined {
    const successId = batch.find((item) => item.outcome === "success")?.episode_id ?? job.episodeId;
    return successId ? this.deps.repos.runtime.getEpisode(successId) : undefined;
  }

  private async updateMetaSkill(
    job: EvolutionJobRecord,
    cluster: SkillClusterRecord,
    input: {
      accepted: boolean;
      rejectReason?: string;
      skillBefore: DirectSkillProcedureJson | null;
      skillAfter: DirectSkillProcedureJson | null;
      batch: PackedEpisodeEvidence[];
      rebuildScope: string;
    }
  ): Promise<void> {
    let nextMd = cluster.metaSkillMd || SEED_META_SKILL_MD;
    if (this.deps.config.algorithm.skill.useLlm && this.deps.skillLlm.isConfigured()) {
      try {
        const result = await this.deps.skillLlm.completeJson<{
          reasoning?: unknown;
          meta_skill_content?: unknown;
        }>([
          { role: "system", content: DIRECT_SKILL_META_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              previous_meta: cluster.metaSkillMd || SEED_META_SKILL_MD,
              skill_before: input.skillBefore,
              skill_after: input.skillAfter,
              accepted: input.accepted,
              reject_reason: input.rejectReason ?? null,
              batch_outcomes: input.batch.map((item) => ({
                episode_id: item.episode_id,
                outcome: item.outcome,
                r_task: item.r_task,
                tools: evidenceToolNames([item])
              })),
              rebuild_scope: input.rebuildScope
            })
          }
        ], {
          operation: "skill.batch_evolve.meta",
          jsonMode: true,
          temperature: 0.2
        });
        const content = typeof result.meta_skill_content === "string" ? result.meta_skill_content.trim() : "";
        if (content) nextMd = content;
      } catch (error) {
        logEvolutionDecision(job, "skill_batch_evolve", "meta_update_failed", {
          clusterId: cluster.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } else if (input.rejectReason) {
      nextMd = `${SEED_META_SKILL_MD}\n\nLast reject: ${input.rejectReason}`;
    }
    this.deps.repos.runtime.updateSkillCluster({
      ...cluster,
      metaSkillMd: nextMd,
      updatedAt: nowIso()
    });
  }
}

function clusterFeatures(cluster: SkillClusterRecord): SkillClusterFeatures {
  return {
    id: cluster.id,
    userId: cluster.userId,
    projectId: cluster.projectId,
    tools: cluster.tools,
    artifacts: cluster.artifacts,
    toolBigrams: cluster.toolBigrams,
    centroid: cluster.centroid
  };
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
