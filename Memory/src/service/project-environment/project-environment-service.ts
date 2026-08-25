import type { LlmClient } from "../../model/types.js";
import type {
  EvolutionJobRecord,
  Repositories,
  SessionRecord
} from "../../storage/repositories.js";
import { scanLocalProject } from "./local-scanner.js";
import { parseDeterministicProjectFacts } from "./manifest-parsers.js";
import { ProjectEnvironmentProfilePipeline, projectEnvironmentProfileJobPayload } from "./profile-pipeline.js";
import { classifyProjectInventory } from "./project-classifier.js";
import { buildCompactFileTree, projectFingerprint } from "./scan-policy.js";
import type { ProjectEnvironmentDerivedEvidence } from "./types.js";

interface ProjectEnvironmentServiceDeps {
  repos: Repositories;
  readonly llm: LlmClient;
}

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

  async processProfileJob(job: EvolutionJobRecord): Promise<void> {
    const payload = projectEnvironmentProfileJobPayload(job.payload);
    if (job.userId !== payload.userId) throw new Error("project_environment_job_owner_mismatch");
    if (!this.deps.repos.projectEnvironments.beginScan(payload.userId, payload.projectId, payload.scanId)) return;
    try {
      const scope = this.deps.repos.l3WorldModels.getScope(payload.userId, payload.projectId);
      if (!scope?.workspaceUri) throw new Error("project_environment_workspace_uri_missing");
      const scan = await scanLocalProject(scope.workspaceUri);
      const classification = classifyProjectInventory(scan.entries);
      const facts = parseDeterministicProjectFacts({
        entries: scan.entries,
        textFiles: scan.textFiles,
        runtimeProbes: scan.runtimeProbes
      });
      const derived: ProjectEnvironmentDerivedEvidence = {
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
}
