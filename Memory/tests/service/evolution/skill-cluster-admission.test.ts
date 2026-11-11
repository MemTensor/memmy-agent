import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { LlmClient } from "../../../src/model/types.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { SkillClusterPipeline } from "../../../src/service/evolution/skill-cluster-pipeline.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import { WorkerConcurrencyController, providerDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { workerWorkRequirements } from "../../../src/service/worker/worker-work-requirements.js";
import { jobPolicyRegistry } from "../../../src/service/worker/job-policy-registry.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { createMemoryServiceFixture, createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture(), runners: WorkerRunner[] = [];
afterEach(async () => { for (const runner of runners.splice(0)) await runner.stop(); fixture.cleanup(); });
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function harness() {
  const { db, service } = fixture.createTestService();
  const repos = new Repositories(db.db), controller = new WorkerConcurrencyController({}, {});
  const entered = deferred(), finishFirst = deferred(); let metaCalls = 0, nextJob = 0;
  const config = { ...DEFAULT_MEMMY_CONFIG, algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm,
    skill: { ...DEFAULT_MEMMY_CONFIG.algorithm.skill, outcomeRTaskSuccessThreshold: 0.8, outcomeRTaskFailureThreshold: 0.2 } } };
  const modelConfig = { ...config.evolution, provider: "openai_compatible" as const,
    endpoint: "https://cluster.test.invalid/v1", model: "evolve" };
  const embeddingConfig = { ...config.embedding, provider: "openai_compatible" as const,
    endpoint: "https://embedding.test.invalid/v1", model: "embedding" };
  const evolutionProvider = providerDescriptor(modelConfig, controller.limits);
  const embeddingProvider = providerDescriptor(embeddingConfig, controller.limits);
  const llm: LlmClient = { config: modelConfig, isConfigured: () => true, complete: async () => "{}",
    completeJson: async <T extends Record<string, unknown>>(_messages: unknown, options: { operation: string }) => {
      if (options.operation !== "skill.batch_evolve.meta") throw new Error(`Unexpected operation ${options.operation}`);
      return controller.runRequest(evolutionProvider, async () => {
        if (++metaCalls === 1) { entered.resolve(); await finishFirst.promise; }
        return { meta_skill_content: `Reviewed cluster ${metaCalls}` } as unknown as T;
      });
    }, status: () => ({ provider: modelConfig.provider, model: modelConfig.model, configured: true, remote: true }) };
  const enqueueJob: WorkerRunnerDeps["enqueueJob"] = input => repos.runtime.enqueueJob({ ...input,
    id: `cluster-review-${++nextJob}`, payload: input.payload ?? {}, dedupeKey: input.dedupeKey ?? evolutionJobDedupeKey(input), status: "queued",
    attempts: 0, maxAttempts: 3, createdAt: input.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
  const pipeline = new SkillClusterPipeline({ repos, config, skillLlm: llm,
    buildMemory: () => { throw new Error("Unexpected Skill creation for unknown-only evidence"); },
    upsertEvolutionMemory: () => { throw new Error("Unexpected Skill persistence"); },
    enqueueJob, namespaceIdFromMemory: () => "review",
    queryVector: () => controller.runRequest(embeddingProvider, async () => [1, 0], true) });
  const prepare: NonNullable<WorkerRunnerDeps["prepareExecution"]> = work => {
    const roles = jobPolicyRegistry.resolve({ jobType: work.queue === "main" ? work.job.jobType : "embedding_retry" }).concurrency.providerRoles;
    return { providers: roles.flatMap(role => role === "embedding" ? embeddingProvider.providers : evolutionProvider.providers),
      embedding: roles.includes("embedding"), run: operation => operation() };
  };
  const runner = new WorkerRunner({ repos, concurrency: controller, prepareExecution: prepare,
    scheduling: { algorithm: "wrr" }, schedulingShadow: { enabled: false }, embedder: createCapturingEmbedder([]),
    capture: { embedAfterCapture: true }, embeddingRetryWorkerId: "cluster-review",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "review", runWorkerNoWrite: async () => { throw new Error("Unexpected disabled worker"); },
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob, enqueueEmbeddingRetry: () => { throw new Error("Unexpected embedding retry"); },
    appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob: job => job.jobType === "skill_cluster_assign" ? pipeline.assignCluster(job) : pipeline.evolveCluster(job) },
    embeddingJobs: { prepareEmbeddingJob: () => { throw new Error("Unexpected embedding job"); }, applyEmbeddingVector: () => {},
      persistEmbeddingVector: () => { throw new Error("Unexpected vector write"); }, enqueueEmbeddingRetryAfterFailure: () => false }
  }); runners.push(runner);
  async function assignment(index: number, projectId: string) {
    const session = service.openSession({ namespace: { source: "codex", profileId: `review-${index}`, userId: "review-user", projectId } });
    const turn = await service.completeTurn(`review-turn-${index}`, { sessionId: session.sessionId,
      query: "Review this code carefully", answer: "Reviewed this code" });
    expect(turn.episodeId).toBeDefined();
    repos.runtime.updateEpisodeReward(turn.episodeId!, { rTask: 0.5, rewardDetail: { source: "review" } });
    return enqueueJob({ jobType: "skill_cluster_assign", userId: "review-user", sessionId: session.sessionId, episodeId: turn.episodeId, payload: {} });
  }
  async function initialCluster(job: EvolutionJobRecord) {
    const claim = repos.runtime.claimQueuedJob(job.id)!;
    const permit = controller.tryAcquire(workerWorkRequirements({ queue: "main", job: claim }, repos, prepare({ queue: "main", job: claim })))!;
    try { await permit.run(() => pipeline.assignCluster(claim)); repos.runtime.completeJob(claim.id, new Date().toISOString(), claim); }
    finally { permit.release(); }
    return repos.runtime.getSkillClusterForEpisode(job.episodeId!)!;
  }
  return { db, repos, controller, runner, prepare, entered, finishFirst, assignment, initialCluster };
}

describe("Skill cluster assignment/evolution admission", () => {
  it("keeps a new same-project assignment queued during evolution, preserves its new member and permits another project", async () => {
    const h = harness();
    const first = await h.assignment(1, "project-A"); const cluster = await h.initialCluster(first);
    const sameProject = await h.assignment(2, "project-A"), otherProject = await h.assignment(3, "project-B");
    h.db.db.prepare("UPDATE evolution_jobs SET available_at='2100-01-01T00:00:00.000Z' WHERE job_type NOT IN ('skill_cluster_assign','skill_batch_evolve')").run();
    const run = h.runner.runWorkerOnce(100); await h.entered.promise;
    for (let i = 0; i < 500; i++) await Promise.resolve();
    const beforeSame = h.repos.runtime.getJob(sameProject.id), beforeOther = h.repos.runtime.getJob(otherProject.id);
    h.finishFirst.resolve(); const result = await run;
    expect(beforeSame).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    expect(beforeOther?.status).toBe("succeeded");
    expect(result.failed).toBe(0);
    expect(h.repos.runtime.getSkillCluster(cluster.id)?.memberCount).toBe(2);
    expect(h.repos.runtime.listSkillClusterMembers(cluster.id)).toHaveLength(2);
    const evolutions = h.repos.runtime.listJobs(undefined, 100).filter(job => job.jobType === "skill_batch_evolve" && job.payload.clusterId === cluster.id);
    expect(evolutions).toHaveLength(2);
    expect(evolutions.every(job => job.status === "succeeded")).toBe(true);
    expect(h.controller.snapshot()).toEqual({ activeJobs: 0, availableJobs: 4, backgroundActiveJobs: 0, maxBackgroundJobs: 3, interactiveReservedSlots: 1, resources: {}, providers: {}, scopeKeys: [], embeddingRequests: 0 });
  });

  it("resolves Skill scopes from authoritative episode/cluster metadata without a target or current session", async () => {
    const h = harness(); const first = await h.assignment(1, "project-A"), cluster = await h.initialCluster(first);
    const second = await h.assignment(2, "project-A"), other = await h.assignment(3, "project-B");
    const evolution = h.repos.runtime.listJobs(undefined, 100).find(job => job.jobType === "skill_batch_evolve" && job.payload.clusterId === cluster.id)!;
    const evolveWithoutSession = { ...evolution, sessionId: undefined, episodeId: undefined };
    const assignWithoutSession = { ...second, sessionId: undefined };
    const requirements = (job: EvolutionJobRecord) => workerWorkRequirements({ queue: "main", job }, h.repos, h.prepare({ queue: "main", job }));
    const owner = h.controller.tryAcquire(requirements(evolveWithoutSession))!;
    const same = h.controller.tryAcquire(requirements(assignWithoutSession));
    const different = h.controller.tryAcquire(requirements(other));
    same?.release(); different?.release(); owner.release();
    expect(requirements(evolveWithoutSession).scopeKeys).toContain(JSON.stringify(["user_project", "project-A"]));
    expect(requirements(assignWithoutSession).scopeKeys).toContain(JSON.stringify(["user_project", "project-A"]));
    expect(same).toBeUndefined();
    expect(different).toBeDefined();
  });
});
