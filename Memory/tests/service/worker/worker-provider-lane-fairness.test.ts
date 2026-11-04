import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { providerDescriptor, WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

type ModelLane = "import" | "evolution";
const providerCompletions = 60;
const waveSize = 20;

/** Real claims and timers: fast database work must not reset a busy model's turn. */
async function runSharedProvider(options: {
  delayMs: number;
  replenishMaintenance: boolean;
  waitForMaintenance?: boolean;
  cloud?: boolean;
  blockedInteractive?: boolean;
  blockedInteractiveScope?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-provider-lane-fairness-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  const concurrency = new WorkerConcurrencyController({ maxActiveJobs: 4 }, {});
  const abort = new AbortController();
  const starts: ModelLane[] = [];
  const completed: ModelLane[] = [];
  const descriptor = providerDescriptor({ provider: "openai_compatible", model: "shared-model",
    endpoint: options.cloud ? "https://shared.example.test/v1" : "http://127.0.0.1:1234/v1",
    mode: options.cloud ? "cloud" : "local" }, concurrency.limits);
  const providers = descriptor.providers;
  const providerLimit = options.cloud ? 2 : 1;
  const blockedProvider = [{ key: "independent-blocked-model", limit: 1 }];
  const held = options.blockedInteractiveScope
    ? concurrency.tryAcquire({ queueLane: "interactive", resourceClass: "summary", providers: [], scopeKeys: [JSON.stringify(["target", "busy-scope"])] })!
    : options.blockedInteractive
      ? concurrency.tryAcquire({ queueLane: "interactive", resourceClass: "summary", providers: blockedProvider, scopeKeys: [] })! : undefined;
  const maintenanceWaiters = new Set<() => void>();
  const wakeMaintenance = () => { for (const wake of maintenanceWaiters) wake(); maintenanceWaiters.clear(); };
  abort.signal.addEventListener("abort", wakeMaintenance);
  let maintenanceCompleted = 0, maintenanceSequence = 0, activeModelRequests = 0, peakModelRequests = 0;
  const unexpected = () => { throw new Error("Unexpected startup or embedding operation"); };
  function enqueue(id: string, jobType: EvolutionJobRecord["jobType"]) {
    const at = new Date().toISOString();
    repos.runtime.enqueueJob({ id, jobType, userId: "provider-fairness", episodeId: `episode-${id}`,
      targetMemoryId: options.blockedInteractiveScope && jobType === "trace_summary" ? "busy-scope" : `memory-${id}`,
      payload: {}, status: "queued", attempts: 0, maxAttempts: 3,
      createdAt: at, updatedAt: at });
  }
  function enqueueMaintenance() { enqueue(`maintenance-${maintenanceSequence++}`, "episode_idle_close"); }
  function enqueueBlockedInteractive() { enqueue(`interactive-${maintenanceSequence}`, "trace_summary"); }
  const deps: WorkerRunnerDeps = {
    repos, concurrency, scheduling: { algorithm: "wrr" }, schedulingShadow: { enabled: false },
    embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: false }, embeddingRetryWorkerId: "provider-fairness",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "provider-fairness", runWorkerNoWrite: async () => unexpected(),
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: unexpected, enqueueEmbeddingRetry: unexpected, appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    prepareExecution: work => ({
      providers: work.queue === "main" && work.job.jobType === "episode_idle_close" ? []
        : work.queue === "main" && work.job.jobType === "trace_summary" && !options.blockedInteractiveScope ? blockedProvider : providers,
      run: operation => operation()
    }),
    jobHandlers: { processJob: async job => {
      if (job.jobType === "episode_idle_close") {
        maintenanceCompleted++;
        wakeMaintenance();
        if (!abort.signal.aborted) {
          // Both synchronous refills are visible before model continuations run.
          repos.transaction(() => {
            enqueueMaintenance();
            if (options.blockedInteractive || options.blockedInteractiveScope) enqueueBlockedInteractive();
          });
        }
        return;
      }
      if (job.jobType === "trace_summary") unexpected();
      const lane: ModelLane = job.jobType === "import_summary" ? "import" : "evolution";
      const maintenanceAtStart = maintenanceCompleted;
      starts.push(lane);
      activeModelRequests++;
      peakModelRequests = Math.max(peakModelRequests, activeModelRequests);
      try {
        await new Promise<void>(resolve => setTimeout(resolve, options.delayMs));
        // Exercise the real interleaving that caused starvation: the next model
        // permit becomes free after unrelated database work advanced its lane.
        if (options.waitForMaintenance && maintenanceCompleted <= maintenanceAtStart && !abort.signal.aborted) {
          await new Promise<void>(resolve => maintenanceWaiters.add(resolve));
        }
        completed.push(lane);
        if (completed.length >= providerCompletions) abort.abort();
      } finally { activeModelRequests--; }
    } },
    embeddingJobs: { prepareEmbeddingJob: unexpected, applyEmbeddingVector: unexpected,
      persistEmbeddingVector: unexpected, enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps);
  // Both queues remain nonempty throughout all measured Provider opportunities.
  repos.transaction(() => {
    for (let i = 0; i < 200; i++) {
      enqueue(`import-${i}`, "import_summary");
      enqueue(`evolution-${i}`, "reflection");
    }
    if (options.replenishMaintenance) enqueueMaintenance();
    if (options.blockedInteractive || options.blockedInteractiveScope) enqueueBlockedInteractive();
  });
  // A broken scheduler must still terminate and release every permit/lease.
  const emergencyStop = setTimeout(() => abort.abort(), 5000);
  try {
    const result = await runner.runWorkerOnce(4, { priorityCohortOnly: true }, { continuous: true, signal: abort.signal });
    expect(result.failed).toBe(0);
    expect(completed.length).toBeGreaterThanOrEqual(providerCompletions);
    expect(completed.length).toBeLessThanOrEqual(providerCompletions + providerLimit - 1);
    expect([...starts].sort()).toEqual([...completed].sort());
    expect(peakModelRequests).toBe(providerLimit);
    expect(activeModelRequests).toBe(0);
    held?.release();
    expect(concurrency.snapshot()).toEqual({ activeJobs: 0, availableJobs: 4, backgroundActiveJobs: 0, maxBackgroundJobs: 3, interactiveReservedSlots: 1, resources: {}, providers: {}, scopeKeys: [], embeddingRequests: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get()).toEqual({ n: 0 });
    const waiting = db.db.prepare("SELECT attempts,lease_token FROM evolution_jobs WHERE status='queued'").all() as Array<{ attempts: number; lease_token: string | null }>;
    expect(waiting.every(row => row.attempts === 0 && row.lease_token === null)).toBe(true);
    return { starts, completed, maintenanceCompleted };
  } finally {
    clearTimeout(emergencyStop);
    abort.abort();
    wakeMaintenance();
    await runner.stop();
    held?.release();
    await concurrency.close();
    abort.signal.removeEventListener("abort", wakeMaintenance);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function expectRepeatedModelProgress(completed: readonly ModelLane[]) {
  // Do not demand an exact WRR ratio or accept one lucky start at the beginning.
  // Each successive set of real Provider completions must make both lanes progress.
  for (let offset = 0; offset < providerCompletions; offset += waveSize) {
    const wave = completed.slice(offset, offset + waveSize);
    expect(wave, `Provider completions ${offset + 1}-${offset + waveSize}`).toContain("import");
    expect(wave, `Provider completions ${offset + 1}-${offset + waveSize}`).toContain("evolution");
  }
}

describe("shared Provider lane fairness under fast database maintenance", () => {
  it("makes repeated progress in both model lanes without maintenance as a control", async () => {
    const result = await runSharedProvider({ delayMs: 10, replenishMaintenance: false });
    expect(result.maintenanceCompleted).toBe(0);
    expectRepeatedModelProgress(result.completed);
  }, 10_000);

  it.each([5, 10])("keeps both model lanes moving while maintenance replenishes with %s ms model work", async delayMs => {
    const result = await runSharedProvider({ delayMs, replenishMaintenance: true });
    expect(result.maintenanceCompleted).toBeGreaterThan(0);
    expectRepeatedModelProgress(result.completed);
  }, 10_000);

  it("preserves model opportunities when a local request completes after maintenance", async () => {
    const result = await runSharedProvider({ delayMs: 5, replenishMaintenance: true, waitForMaintenance: true });
    expect(result.maintenanceCompleted).toBeGreaterThan(0);
    expectRepeatedModelProgress(result.completed);
  }, 10_000);

  it.each([false, true])("keeps the cloud Provider moving with an independent blocked interactive Provider=%s", async blockedInteractive => {
    const result = await runSharedProvider({ delayMs: 10, replenishMaintenance: true,
      waitForMaintenance: true, cloud: true, blockedInteractive });
    expect(result.maintenanceCompleted).toBeGreaterThan(0);
    expectRepeatedModelProgress(result.completed);
  }, 10_000);

  it("skips a held business scope without withholding the shared cloud Provider from other lanes", async () => {
    const result = await runSharedProvider({ delayMs: 10, replenishMaintenance: true,
      waitForMaintenance: true, cloud: true, blockedInteractiveScope: true });
    expect(result.maintenanceCompleted).toBeGreaterThan(0);
    expectRepeatedModelProgress(result.completed);
  }, 10_000);
});
