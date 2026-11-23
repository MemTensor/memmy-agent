import { initialSkillEtaContributions } from "./skill-eta-contributions.js";
import { revisionInputHash, episodeRewardInputVersion } from "./episode-revision.js";
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
  languageSteeringLine,
  skillOutputLanguageFor,
  steeredPromptLanguage,
  skillMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import { kindFromMemory, type EpisodeRecord, type EvolutionJobRecord, type Repositories, type SkillClusterRecord } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { newId, stableHash } from "../../utils/id.js";
import { generatedSkillTitle } from "../../algorithm/skill-display.js";
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

class RejectedDirectSkillDraftError extends Error {}
class StaleDirectSkillInputError extends Error {}

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
    const inputVersion = this.featureVersion(episode);
    const features = await this.featuresForEpisode(episode);
    let selected = this.deps.repos.runtime.getSkillClusterForEpisode(episode.id);
    if (!selected) {
      const candidates = this.deps.repos.runtime.listSkillClustersByScope({ userId: episode.userId, projectId: episode.projectId });
      const decision = decideClusterAssignment(features, candidates.map(clusterFeatures), this.clusteringConfig());
      if (decision.action === "join" && decision.clusterId) selected = this.deps.repos.runtime.getSkillCluster(decision.clusterId);
    }
    const memberIds = selected ? this.deps.repos.runtime.listSkillClusterMembers(selected.id).map(member => member.episodeId).sort() : [];
    const inputs = new Map<string, { version: string; features: EpisodeSkillFeatures }>();
    inputs.set(episode.id, { version: inputVersion, features });
    for (const memberId of memberIds) {
      if (memberId === episode.id) continue;
      const member = this.deps.repos.runtime.getEpisode(memberId);
      if (!member) throw new Error("skill cluster member disappeared before assignment");
      const version = this.featureVersion(member);
      inputs.set(memberId, { version, features: await this.featuresForEpisode(member) });
    }
    this.deps.repos.transaction(() => {
      for (const [id, input] of inputs) {
        const current = this.deps.repos.runtime.getEpisode(id);
        if (!current || this.featureVersion(current) !== input.version) throw new Error("skill cluster inputs changed during assignment");
      }
      const currentCluster = selected && this.deps.repos.runtime.getSkillCluster(selected.id);
      if (selected && (!currentCluster || currentCluster.updatedAt !== selected.updatedAt
        || JSON.stringify(this.deps.repos.runtime.listSkillClusterMembers(selected.id).map(member => member.episodeId).sort()) !== JSON.stringify(memberIds))) {
        throw new Error("skill cluster membership changed during assignment");
      }
      const currentFeatures = [...inputs.values()].map(input => input.features);
      const vectors = currentFeatures.flatMap(input => input.queryVec?.length ? [input.queryVec] : []);
      const dimensions = new Set(vectors.map(vector => vector.length));
      if (dimensions.size > 1) throw new Error("skill cluster vectors have incompatible dimensions");
      const centroid = vectors.length ? vectors[0]!.map((_, index) =>
        vectors.reduce((sum, vector) => sum + vector[index]!, 0) / vectors.length) : null;
      const aggregate = {
        tools: uniqSorted(currentFeatures.flatMap(input => input.tools)),
        artifacts: uniqSorted(currentFeatures.flatMap(input => input.artifacts)),
        toolBigrams: uniqSorted(currentFeatures.flatMap(input => input.toolBigrams)),
        centroid, memberCount: inputs.size, updatedAt: at
      };
      const cluster = currentCluster
        ? this.deps.repos.runtime.updateSkillCluster({ ...currentCluster, ...aggregate })
        : this.createCluster(episode, features, at);
      for (const [id, input] of inputs) this.deps.repos.runtime.setKv(`skill-member-features:v1:${id}`, input, at);
      this.deps.repos.runtime.upsertSkillClusterMember({ clusterId: cluster.id, episodeId: episode.id,
        outcome: features.outcome, rTask: episode.rTask, assignedAt: at });
      this.deps.repos.runtime.updateEpisodeMeta(episode.id, { skill_cluster_id: cluster.id }, at);
      this.deps.enqueueJob({ jobType: "skill_batch_evolve", userId: episode.userId, sessionId: episode.sessionId,
        episodeId: episode.id, payload: { reason: "skill_cluster_assign", clusterId: cluster.id }, createdAt: at });
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

    const referencedSkill = cluster.skillMemoryId ? this.deps.repos.memories.getIncludingDeleted(cluster.skillMemoryId) : undefined;
    const referencedRaw = referencedSkill?.properties.internal_info.skill;
    const retirement = isRecord(referencedRaw) && isRecord(referencedRaw.source_retirement) ? referencedRaw.source_retirement : undefined;
    const autoRetired = Boolean(referencedSkill?.status === "archived" && retirement?.clusterId === cluster.id &&
      retirement.retiredVersion === referencedSkill.version && retirement.bodyHash === revisionInputHash(referencedSkill.memoryValue) &&
      ["activated", "resolving"].includes(String(retirement.previousStatus)));
    if (cluster.skillMemoryId && (!referencedSkill || referencedSkill.deletedAt ||
        (referencedSkill.status === "archived" && !autoRetired) || referencedSkill.status === "deleted")) {
      logEvolutionDecision(job, "skill_batch_evolve", "user_retired_cluster_skill", { clusterId: cluster.id });
      return;
    }
    const completionKey = `skill-evolution:v1:${cluster.id}`;
    const completed = this.deps.repos.runtime.getKv(completionKey)?.value;
    if (referencedSkill && isRecord(completed) && completed.skillId === referencedSkill.id &&
        (completed.bodyHash !== revisionInputHash(referencedSkill.memoryValue) ||
          (typeof completed.procedureHash === "string" && completed.procedureHash !== this.procedureVersion(referencedSkill)))) {
      throw new Error("Direct skill has user edits; preserve it for review");
    }
    const members = this.deps.repos.runtime.listSkillClusterMembers(cluster.id);
    const scoredMembers = members.flatMap((member) => {
      const episode = this.deps.repos.runtime.getEpisode(member.episodeId);
      if (!episode || episode.status !== "closed" || typeof episode.rTask !== "number") return [];
      return [{
        episodeId: episode.id,
        outcome: classifySkillOutcome(episode.rTask, this.outcomeThresholds()),
        rTask: episode.rTask,
        updatedAt: episode.updatedAt
      }];
    });
    if (referencedSkill && !scoredMembers.some(member => member.outcome === "success")) {
      if (!autoRetired) this.retireClusterSkill(cluster, referencedSkill, "no_current_success_anchor");
      logEvolutionDecision(job, "skill_batch_evolve", "no_current_success_anchor", { clusterId: cluster.id });
      return;
    }
    const sourceVersions = Object.fromEntries(members.map(member => {
      const episode = this.deps.repos.runtime.getEpisode(member.episodeId);
      return [member.episodeId, revisionInputHash({ status: episode?.status, reward: episode?.rTask,
        input: episode ? episodeRewardInputVersion(this.deps.repos, episode) : null })];
    }));
    const previousSources = isRecord(completed) && isRecord(completed.sourceVersions) ? completed.sourceVersions : undefined;
    // A revised dependency invalidates the old procedure, even when it introduces no new episode ID.
    const replaceProcedure = Boolean(referencedSkill && (previousSources
      ? Object.entries(previousSources).some(([id, version]) => (sourceVersions[id] ?? null) !== version)
      : isRecord(completed) && completed.inputVersion !== this.evolutionInputVersion(cluster)));
    if (replaceProcedure && referencedSkill && !autoRetired) {
      this.retireClusterSkill(cluster, referencedSkill, "source_revision");
      // Re-read the owned retirement version before generation and its eventual conditional restore.
      return this.evolveCluster(job);
    }
    const selected = selectTop6Members(scoredMembers, this.clusteringConfig());
    const dependencyIds = new Set(previousSources ? Object.keys(previousSources) : cluster.processedEpisodeIds);
    const top6 = replaceProcedure
      ? scoredMembers.filter(member => dependencyIds.has(member.episodeId) || selected.some(item => item.episodeId === member.episodeId))
      : selected;
    if (top6.length === 0) {
      logEvolutionDecision(job, "skill_batch_evolve", "empty_batch", { clusterId: cluster.id });
      return;
    }

    const batch = top6.map((member) => this.packEpisode(member.episodeId, member.outcome, member.rTask));
    const existingSkill = autoRetired && referencedSkill ? skillMetaFromMemory(referencedSkill) : this.clusterSkill(cluster);
    const inputVersion = this.evolutionInputVersion(cluster);
    if (existingSkill && isRecord(completed) && completed.skillId === existingSkill.id) {
      if (completed.bodyHash !== revisionInputHash(existingSkill.memory.memoryValue)) {
        throw new Error("Direct skill has user edits; preserve it for review");
      }
      if (completed.inputVersion === inputVersion && !autoRetired) return;
    }
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
      replaceProcedure ? "workflow" : branch.action === "rebuild" ? branch.rebuildScope ?? "retrieval" : branch.action === "crystallize" ? "crystallize" : branch.action;

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
        existing: replaceProcedure ? null : skillBefore,
        rebuildScope: replaceProcedure ? undefined : branch.action === "rebuild" ? branch.rebuildScope ?? "retrieval" : undefined
      });
      const merged = !replaceProcedure && skillBefore && branch.rebuildScope
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
        this.recordDirectSkillFailure(startedAt, cluster, existingSkill?.id, "verification", rejectReason, gate);
        await this.updateMetaSkill(job, cluster, {
          accepted: false,
          rejectReason,
          skillBefore,
          skillAfter: merged,
          batch,
          rebuildScope
        });
        throw new RejectedDirectSkillDraftError(`direct skill draft rejected: ${rejectReason}`);
      }

      const { upserted, withSkill } = this.deps.repos.transaction(() => {
        const current = this.deps.repos.runtime.getSkillCluster(cluster.id);
        const currentSkill = existingSkill ? this.deps.repos.memories.get(existingSkill.id) : undefined;
        if (!current || this.evolutionInputVersion(current) !== inputVersion ||
            current.skillMemoryId !== cluster.skillMemoryId ||
            (existingSkill && currentSkill?.version !== existingSkill.memory.version)) {
          throw new StaleDirectSkillInputError("Direct skill inputs changed during generation");
        }
        if (autoRetired && currentSkill) {
          const status = retirement?.previousStatus === "resolving" ? "resolving" : "activated";
          this.deps.repos.memories.updateIfVersion({ ...currentSkill, status,
            properties: { ...currentSkill.properties, status } }, currentSkill.version);
        }
        const upserted = this.upsertSkill({
          job,
          cluster,
          episode: this.anchorEpisode(batch, job),
          name,
          displayTitle: draft.displayTitle,
          draftName: draft.name,
          outputLanguage: draft.outputLanguage,
          procedure: stripDirectSkillStepEvidenceIds(merged),
          verification: gate,
          existing: existingSkill?.memory,
          replaceEvidence: replaceProcedure,
          successEpisodeIds: batch.filter((item) => item.outcome === "success").map((item) => item.episode_id),
          at
        });
        skillAfter = merged;
        const withSkill = {
          ...this.markProcessed(cluster, top6.map((item) => item.episodeId), at),
          skillMemoryId: upserted.memory.id
        };
        this.deps.repos.runtime.updateSkillCluster(withSkill);
        this.deps.repos.runtime.setKv(completionKey, { inputVersion, skillId: upserted.memory.id,
          bodyHash: revisionInputHash(upserted.memory.memoryValue), procedureHash: this.procedureVersion(upserted.memory),
          sourceVersions: { ...Object.fromEntries(Object.keys(previousSources ?? {}).map(id =>
              [id, sourceVersions[id] ?? null])),
            ...Object.fromEntries(top6.map(member => [member.episodeId, sourceVersions[member.episodeId]])) } }, at);
        return { upserted, withSkill };
      });
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
      if (error instanceof RejectedDirectSkillDraftError || error instanceof StaleDirectSkillInputError) throw error;
      rejectReason = error instanceof Error ? error.message : String(error);
      logEvolutionDecision(job, "skill_batch_evolve", "llm-failed", {
        clusterId: cluster.id,
        error: rejectReason
      });
      this.recordDirectSkillFailure(startedAt, cluster, existingSkill?.id, "llm_transport", rejectReason);
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

  private procedureVersion(memory: MemoryRow): string {
    const raw = memory.properties.internal_info.skill;
    return revisionInputHash([memory.properties.internal_info.procedure_json,
      isRecord(raw) ? raw.procedure_json : undefined]);
  }

  private retireClusterSkill(cluster: SkillClusterRecord, memory: MemoryRow, reason: string): void {
    const at = nowIso();
    const raw = memory.properties.internal_info.skill;
    this.deps.repos.transaction(() => {
      const retired = this.deps.repos.memories.updateIfVersion({ ...memory, status: "archived", updatedAt: at,
        properties: { ...memory.properties, status: "archived", internal_info: { ...memory.properties.internal_info,
          skill: { ...(isRecord(raw) ? raw : {}), source_retirement: {
            clusterId: cluster.id, retiredVersion: memory.version + 1, bodyHash: revisionInputHash(memory.memoryValue),
            previousStatus: memory.status, reason
          } } } } }, memory.version);
      this.deps.repos.runtime.appendChange({ memoryId: retired.id, namespaceId: this.deps.namespaceIdFromMemory(retired),
        kind: "skill", op: "updated", entityId: retired.id, userId: retired.userId, changeType: "skill_source_retired",
        before: memory, after: retired, source: DIRECT_SKILL_SOURCE, createdAt: at });
    });
  }

  /** First-time failures have no Skill yet, so they key on the cluster; rebuilds also carry the real skillId. */
  private recordDirectSkillFailure(
    startedAt: number,
    cluster: SkillClusterRecord,
    skillId: string | undefined,
    failureKind: "verification" | "llm_transport",
    reason: string,
    verification?: ReturnType<typeof verifyDirectSkillDraft>
  ): void {
    recordApiLog(
      this.deps.repos.runtime,
      skillId ? "skill_evolve" : "skill_generate",
      { phase: "failed", clusterId: cluster.id, ...(skillId ? { skillId } : {}), failureKind, reason },
      {
        kind: "skill.direct.failed",
        clusterId: cluster.id,
        ...(skillId ? { skillId } : {}),
        failureKind,
        reason,
        ...(verification ? { verification } : {}),
        source: DIRECT_SKILL_SOURCE
      },
      elapsedApiLogMs(startedAt),
      false,
      nowIso()
    );
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

  private featureVersion(episode: EpisodeRecord): string {
    return stableHash(JSON.stringify([episodeRewardInputVersion(this.deps.repos, episode), episode.rTask,
      this.deps.config.embedding.provider, this.deps.config.embedding.model]));
  }

  private async featuresForEpisode(episode: EpisodeRecord): Promise<EpisodeSkillFeatures> {
    const cached = this.deps.repos.runtime.getKv(`skill-member-features:v1:${episode.id}`)?.value;
    if (isRecord(cached) && cached.version === this.featureVersion(episode) && isRecord(cached.features)
      && cached.features.episodeId === episode.id && Array.isArray(cached.features.tools)
      && Array.isArray(cached.features.artifacts) && Array.isArray(cached.features.toolBigrams)
      && (cached.features.queryVec === null || Array.isArray(cached.features.queryVec))) {
      return cached.features as unknown as EpisodeSkillFeatures;
    }
    const turns = this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, Number.MAX_SAFE_INTEGER);
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
    const turns = this.deps.repos.runtime.listRawTurnsByEpisode(episodeId, Number.MAX_SAFE_INTEGER);
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

  private evolutionInputVersion(cluster: SkillClusterRecord): string {
    const members = this.deps.repos.runtime.listSkillClusterMembers(cluster.id)
      .map(member => {
        const episode = this.deps.repos.runtime.getEpisode(member.episodeId);
        return { id: member.episodeId, status: episode?.status, reward: episode?.rTask,
          input: episode ? episodeRewardInputVersion(this.deps.repos, episode) : null };
      }).sort((a, b) => a.id.localeCompare(b.id));
    return revisionInputHash({ version: 1, members, tools: cluster.tools,
      artifacts: cluster.artifacts, bigrams: cluster.toolBigrams, centroid: cluster.centroid,
      config: this.deps.config.algorithm.skill, language: this.deps.config.language,
      model: [this.deps.skillLlm.config.provider, this.deps.skillLlm.config.model] });
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
  }): Promise<{ name: string; outputLanguage: string; displayTitle?: string; procedure: DirectSkillProcedureJson; changedSections: string[] }> {
    const languageSamples = input.batch.flatMap((item) => item.turns.flatMap((turn) => [turn.user, turn.assistant]));
    const steeredLanguage = steeredPromptLanguage(this.deps.config.language, languageSamples);
    const outputLanguage = skillOutputLanguageFor(this.deps.config.algorithm.skill.outputLanguageMode, steeredLanguage);
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
        content: languageSteeringLine(outputLanguage)
      },
      {
        role: "system",
        content: "Return display_title as a separate readable localized title in the requested output language. Keep name as the stable snake_case invocation identifier."
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
      outputLanguage,
      displayTitle: typeof result.display_title === "string" ? result.display_title.trim() || undefined
        : typeof result.displayTitle === "string" ? result.displayTitle.trim() || undefined : undefined,
      procedure,
      changedSections
    };
  }

  private upsertSkill(input: {
    job: EvolutionJobRecord;
    cluster: SkillClusterRecord;
    episode?: EpisodeRecord;
    name: string;
    displayTitle?: string;
    draftName: string;
    outputLanguage: string;
    procedure: DirectSkillProcedureJson;
    verification: ReturnType<typeof verifyDirectSkillDraft>;
    existing?: MemoryRow;
    successEpisodeIds: string[];
    replaceEvidence: boolean;
    at: string;
  }): { memory: MemoryRow; created: boolean; previous?: MemoryRow } {
    const title = generatedSkillTitle(input.outputLanguage, [input.name, input.draftName],
      input.displayTitle, input.existing?.info.title, input.procedure.summary);
    const invocationGuide = renderDirectSkillGuide(title, input.procedure);
    const evidenceAnchorIds = uniqSorted([
      ...((!input.replaceEvidence && input.existing ? skillMetaFromMemory(input.existing)?.evidenceAnchorIds : []) ?? []),
      ...input.successEpisodeIds
    ]);
    const seed = input.existing ?? input.episode;
    const existingMeta = input.existing ? skillMetaFromMemory(input.existing) : null;
    const existingInternal: Record<string, unknown> = input.existing?.properties.internal_info ?? {};
    const existingRaw = isRecord(existingInternal.skill) ? existingInternal.skill : {};
    const bodyChanged = Boolean(input.existing && input.existing.memoryValue !== invocationGuide);
    const previousRevision = typeof existingRaw.content_revision === "number" && Number.isSafeInteger(existingRaw.content_revision)
      ? existingRaw.content_revision : 1;
    const bodyFields = bodyChanged ? { content_revised_at: input.at, content_revision: previousRevision + 1,
      trials_attempted: 0, trials_passed: 0, success_rate: 0, beta_posterior: { alpha: 1, beta: 1, mean: 0.5 } }
      : { content_revision: previousRevision };
    const eta = bodyChanged ? 0.6 : existingMeta?.eta ?? 0.6;
    const status = bodyChanged ? "active" : existingMeta?.status ?? "active";
    const gain = typeof existingRaw.gain === "number" && Number.isFinite(existingRaw.gain) ? existingRaw.gain : 0.4;
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
        ...input.existing?.info,
        ...bodyFields,
        name: input.name,
        title,
        eta,
        status,
        source_memory_ids: []
      },
      internal: {
        ...existingInternal,
        ...bodyFields,
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
        verification: input.verification,
        eta,
        support: evidenceAnchorIds.length,
        gain,
        skill: {
          ...existingRaw,
          source_retirement: undefined,
          ...bodyFields,
          ...(!input.existing || bodyChanged ? { eta_contributions: initialSkillEtaContributions(
            `direct:${bodyFields.content_revision}`, { eta, attempts: 0, passes: 0 }) } : {}),
          name: input.name,
          eta,
          status,
          support: evidenceAnchorIds.length,
          gain,
          source_policy_ids: [],
          source_world_model_ids: [],
          evidence_anchor_ids: evidenceAnchorIds,
          invocation_guide: invocationGuide,
          procedure_json: input.procedure,
          verification: input.verification
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
    // The model wait must not restore an old centroid, member list or completion marker.
    const current = this.deps.repos.runtime.getSkillCluster(cluster.id);
    if (!current || current.updatedAt !== cluster.updatedAt) return;
    this.deps.repos.runtime.updateSkillCluster({
      ...current,
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

function stripDirectSkillStepEvidenceIds(procedure: DirectSkillProcedureJson): DirectSkillProcedureJson {
  return {
    ...procedure,
    steps: procedure.steps.map((step) => {
      const { evidenceIds: _evidenceIds, ...rest } = step;
      return rest;
    })
  };
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
