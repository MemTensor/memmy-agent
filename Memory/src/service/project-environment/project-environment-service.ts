import { pathToFileURL } from "node:url";
import type { MemoryLanguage } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import type {
  EvolutionJobRecord,
  Repositories,
  SessionRecord
} from "../../storage/repositories.js";
import { newId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { scanLocalProject } from "./local-scanner.js";
import { parseDeterministicProjectFacts } from "./manifest-parsers.js";
import {
  ProjectEnvironmentProfilePipeline,
  projectEnvironmentProfileJobPayload,
  summarizeProjectProfile
} from "./profile-pipeline.js";
import { classifyProjectInventory } from "./project-classifier.js";
import { buildCompactFileTree, projectFingerprint } from "./scan-policy.js";
import type { ProjectEnvironmentDerivedEvidence } from "./types.js";

interface ProjectEnvironmentServiceDeps {
  repos: Repositories;
  readonly llm: LlmClient;
  readonly language?: MemoryLanguage;
}

const L3_FIELD_MODE = "l3_field";
/** A project is scanned for its new-L3 profile at most this often; each session open asks for one. */
const L3_UNIT_PROFILE_INTERVAL_MS = 10 * 60_000;

export class ProjectEnvironmentService {
  private readonly profilePipeline: ProjectEnvironmentProfilePipeline;

  constructor(private readonly deps: ProjectEnvironmentServiceDeps) {
    this.profilePipeline = new ProjectEnvironmentProfilePipeline(deps);
  }

  requestSessionScan(session: SessionRecord): { job: EvolutionJobRecord; enqueued: boolean } | null {
    if (!session.projectId) return null;
    const scope = this.deps.repos.l3WorldModels.getScope(session.userId, session.projectId);
    if (!scope?.workspaceUri) return null;
    return this.deps.repos.projectEnvironments.requestScan({
      userId: session.userId,
      projectId: session.projectId,
      sessionId: session.id,
      trigger: "session_start",
      dedupeKey: ["project_environment_profile", session.userId, session.projectId, "session", session.id].join(":")
    });
  }

  requestCompactionScan(
    session: SessionRecord,
    throughTraceSeq: number
  ): { job: EvolutionJobRecord; enqueued: boolean } | null {
    if (!session.projectId) return null;
    const scope = this.deps.repos.l3WorldModels.getScope(session.userId, session.projectId);
    if (!scope?.workspaceUri) return null;
    return this.deps.repos.projectEnvironments.requestScan({
      userId: session.userId,
      projectId: session.projectId,
      sessionId: session.id,
      trigger: "token_compaction",
      dedupeKey: [
        "project_environment_profile",
        session.userId,
        session.projectId,
        "compaction",
        session.id,
        throughTraceSeq
      ].join(":")
    });
  }

  /**
   * New L3: queue a profile scan of one checkout of a project unit. At most one
   * such job is pending per unit, and a unit scanned in the last ten minutes is
   * not scanned again; such a request is a no-op.
   */
  requestL3UnitProfile(input: { userId: string; unitKey: string; checkoutRoot: string; at?: string }): boolean {
    const at = input.at ?? nowIso();
    const recent = this.deps.repos.db.prepare(
      `SELECT 1 FROM evolution_jobs
       WHERE job_type = 'project_environment_profile'
         AND json_extract(payload_json, '$.mode') = ?
         AND json_extract(payload_json, '$.unitKey') = ?
         AND (status IN ('queued', 'leased', 'failed') OR (status = 'succeeded' AND updated_at >= ?))
       LIMIT 1`
    ).get(L3_FIELD_MODE, input.unitKey, new Date(Date.parse(at) - L3_UNIT_PROFILE_INTERVAL_MS).toISOString());
    if (recent) return false;
    const scanId = newId("l3scan");
    // The immutable dedupe index never frees a key, so each request carries its own scan id.
    const dedupeKey = ["project_environment_profile", L3_FIELD_MODE, input.unitKey, scanId].join(":");
    this.deps.repos.l3WorldModels.insertImmutableJob({
      id: newId("job"),
      jobType: "project_environment_profile",
      status: "queued",
      dedupeKey,
      userId: input.userId,
      payload: {
        mode: L3_FIELD_MODE,
        userId: input.userId,
        unitKey: input.unitKey,
        checkoutRoot: input.checkoutRoot,
        scanId
      },
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });
    return true;
  }

  async processProfileJob(job: EvolutionJobRecord): Promise<void> {
    if (job.payload.mode === L3_FIELD_MODE) {
      await this.processL3UnitProfileJob(job);
      return;
    }
    const payload = projectEnvironmentProfileJobPayload(job.payload);
    if (job.userId !== payload.userId) throw new Error("project_environment_job_owner_mismatch");
    if (!this.deps.repos.projectEnvironments.beginScan(payload.userId, payload.projectId, payload.scanId)) return;
    try {
      const scope = this.deps.repos.l3WorldModels.getScope(payload.userId, payload.projectId);
      if (!scope?.workspaceUri) throw new Error("project_environment_workspace_uri_missing");
      const derived = await deriveScanEvidence(scope.workspaceUri);
      const state = this.deps.repos.projectEnvironments.getState(payload.userId, payload.projectId);
      if (!state || state.currentScanId !== payload.scanId) return;
      const currentProfile = this.deps.repos.l3WorldModels.fields(
        payload.userId,
        payload.projectId
      ).projectEnvironmentProfile;
      const memory = this.deps.repos.l3WorldModels.getMemory(payload.userId, payload.projectId);
      const appliedByMemory = typeof memory?.info.project_environment_applied_scan_id === "string"
        ? memory.info.project_environment_applied_scan_id
        : undefined;
      const provenanceMatches = currentProfile !== null && state.appliedScanId === appliedByMemory;
      if (
        state.fingerprint === derived.fingerprint &&
        state.appliedScanId &&
        provenanceMatches
      ) {
        this.deps.repos.projectEnvironments.markCleanWithoutModel({
          userId: payload.userId,
          projectId: payload.projectId,
          scanId: payload.scanId,
          projectKind: derived.projectKind
        });
        return;
      }
      if (!this.deps.repos.projectEnvironments.markSummarizing(payload.userId, payload.projectId, payload.scanId)) return;
      await this.profilePipeline.process(job, derived);
    } catch (error) {
      this.deps.repos.projectEnvironments.failCurrentScan(
        payload.userId,
        payload.projectId,
        payload.scanId,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * New L3 project profile. Only what the project itself declares goes in:
   * runtime versions probed on this computer belong to the machine profile.
   * The result is written only if the unit still exists and nobody changed
   * its profile while the model was running.
   */
  private async processL3UnitProfileJob(job: EvolutionJobRecord): Promise<void> {
    const userId = typeof job.payload.userId === "string" ? job.payload.userId : "";
    const unitKey = typeof job.payload.unitKey === "string" ? job.payload.unitKey : "";
    const checkoutRoot = typeof job.payload.checkoutRoot === "string" ? job.payload.checkoutRoot : "";
    if (!userId || !unitKey || !checkoutRoot || job.userId !== userId) {
      throw new Error("invalid l3 field profile job payload");
    }
    const unit = this.deps.repos.l3Field.getUnit(unitKey);
    if (!unit || unit.userId !== userId || unit.kind !== "project") return;
    // A job queued before the unit was reset (deleted) must not bring old results back.
    if (unit.deletedAt && job.createdAt <= unit.deletedAt) return;
    // Runtime versions probed on this machine belong to the machine profile, so they are neither
    // shown to the model nor part of the fingerprint: upgrading node does not re-profile every project.
    const derived = await deriveScanEvidence(pathToFileURL(checkoutRoot).href, { withRuntimeProbes: false });
    // Unchanged since the last summary, including one that found nothing worth a profile.
    if (unit.profileFingerprint === derived.fingerprint) return;
    const currentProfile = unit.profileText ?? null;
    const output = await summarizeProjectProfile(this.deps, derived, currentProfile);
    const latest = this.deps.repos.l3Field.getUnit(unitKey);
    if (
      !latest ||
      (latest.deletedAt && job.createdAt <= latest.deletedAt) ||
      (latest.profileText ?? null) !== currentProfile
    ) return;
    const nextProfile = output.op === "noop" ? currentProfile : (output.profile || null);
    this.deps.repos.transaction(() => {
      this.deps.repos.l3Field.setProfile(unitKey, { text: nextProfile, fingerprint: derived.fingerprint });
      if (nextProfile !== currentProfile) this.deps.repos.l3Field.refreshSnapshot(unitKey);
    });
  }
}

async function deriveScanEvidence(
  workspaceUri: string,
  options: { withRuntimeProbes?: boolean } = {}
): Promise<ProjectEnvironmentDerivedEvidence> {
  const scan = await scanLocalProject(workspaceUri, options);
  const classification = classifyProjectInventory(scan.entries);
  const facts = parseDeterministicProjectFacts({
    entries: scan.entries,
    textFiles: scan.textFiles,
    runtimeProbes: scan.runtimeProbes
  });
  return {
    projectKind: classification.kind,
    compactFileTree: buildCompactFileTree(scan.entries),
    omittedCount: scan.omittedCount,
    deterministicFacts: facts,
    fingerprint: projectFingerprint({
      kind: classification.kind,
      entries: scan.entries,
      omittedCount: scan.omittedCount,
      deterministicFacts: facts
    })
  };
}
