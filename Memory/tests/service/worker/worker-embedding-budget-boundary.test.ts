import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelHttpError } from "../../../src/model/http.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const epoch = Date.parse("2026-10-22T00:00:00.000Z");
const at = new Date(epoch).toISOString();
const resources: Array<{ root: string; db: MemoryDb }> = [];
type HarnessOptions = { algorithm?: "wrr" | "legacy"; process?: (job: EvolutionJobRecord) => Promise<void> };

/** Real SQLite and claim transitions; business/model work is a local substitute. */
function harness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-fairness-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  const executed: string[] = [];
  const deps: WorkerRunnerDeps = {
    repos, embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: true },
    embeddingRetryWorkerId: "fairness-test", memoryAddEnabled: () => true,
    memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(), summaryModelConfigured: () => true,
    schedulingShadow: { enabled: false },
    ...(options.algorithm ? { scheduling: { algorithm: options.algorithm } } : {}),
    nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "synthetic",
    runWorkerNoWrite: async () => { throw new Error("unexpected disabled worker"); },
    restartFailedProcessing: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    reconcileOrphanedPolicies: () => 0,
    enqueueJob: () => { throw new Error("unexpected startup enqueue"); },
    enqueueEmbeddingRetry: () => { throw new Error("unexpected replacement retry"); },
    appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob: async (job) => { executed.push(job.id); await options.process?.(job); } },
    embeddingJobs: {
      prepareEmbeddingJob: () => { throw new Error("unexpected main embedding job"); },
      applyEmbeddingVector: () => {}, enqueueEmbeddingRetryAfterFailure: () => false,
      persistEmbeddingVector: (input) => {
        const memory = repos.memories.get(input.memoryId)!;
        executed.push(`retry:${input.memoryId}`);
        input.finalize?.(memory, false, new Date().toISOString());
        return memory;
      }
    }
  };
  const runner = new WorkerRunner(deps);
  function memory(id: string, createdAt = at, tags: string[] = ["agent-source"]) {
    db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,tags_json,created_at,updated_at)
      VALUES (?,?,'user','synthetic','L1',?,?,?)`).run(id, createdAt, JSON.stringify(tags), createdAt, createdAt);
  }
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "reflection", input: {
    target?: string; source?: string; createdAt?: string; payload?: Record<string, unknown>;
    scopeKey?: string; scopeSeq?: number;
  } = {}) {
    return repos.runtime.enqueueJob({ id, jobType, userId: "user", targetMemoryId: input.target,
      scopeKey: input.scopeKey, scopeSeq: input.scopeSeq,
      payload: { ...input.payload, ...(input.source ? { source: input.source } : {}) },
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: input.createdAt ?? at, updatedAt: at });
  }
  function retry(id: string, createdAt = at) {
    memory(id, createdAt);
    return repos.runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: id,
      vectorField: "vec_summary", sourceText: "synthetic", now: epoch });
  }
  return { root, db, repos, deps, runner, job, memory, retry, executed };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
  vi.stubEnv("MEMMY_WORKER_SCHEDULER_ALGORITHM", "wrr");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  for (const { root, db } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function embeddingRoleHarness(algorithm: "wrr" | "legacy", roles: Array<"document" | "query">) {
  const h = harness({ algorithm });
  const calls: Array<{ role: "document" | "query" | undefined; texts: string[] }> = [];
  const applied: string[] = [];
  h.deps.embeddingJobs.prepareEmbeddingJob = (job) => ({
    job, memory: h.repos.memories.get(job.targetMemoryId!)!, text: job.id,
    role: job.payload.role as "document" | "query", vectorField: "vec_summary"
  });
  h.deps.embeddingJobs.applyEmbeddingVector = (item) => { applied.push(item.job.id); };
  h.deps.embedder.embed = async (texts, role) => {
    calls.push({ role, texts: [...texts] });
    return texts.map(() => [1, 0, 0]);
  };
  roles.forEach((role, index) => {
    const id = `embedding-${index}`;
    h.memory(id, at, []);
    h.job(id, "embedding", { target: id, payload: { role } });
  });
  return { ...h, calls, applied };
}


function inputTooLong() {
  return new ModelHttpError("maximum context length exceeded", "openai_compatible", 400,
    "context_length_exceeded", "maximum input length exceeded");
}
function saveProcessing(h: ReturnType<typeof harness>, id: string, attemptCount = 0) {
  h.repos.processing.save({ memoryId: id, state: "embedding_pending", stage: "embedding",
    activeJobId: id, attemptCount, manualRetryCount: 0, retryAction: "retry", updatedAt: at });
}

describe("Embedding budget checks between requests", () => {
  it("preserves legacy SQL admission order while holding subsequent main roles after a pause", async () => {
    const h = embeddingRoleHarness("legacy", ["query", "document", "query"]);
    let paused = false;
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "embedding";
    for (let i = 0; i < 3; i++) saveProcessing(h, `embedding-${i}`);
    const originalEmbed = h.deps.embedder.embed;
    h.deps.embedder.embed = async (texts, role) => {
      const result = await originalEmbed(texts, role);
      paused = true;
      return result;
    };
    expect(await h.runner.runWorkerOnce(3)).toMatchObject({ leased: 3, succeeded: 1, failed: 0 });
    expect(h.calls).toEqual([{ role: "query", texts: ["embedding-0"] }]);
    for (const id of ["embedding-1", "embedding-2"]) {
      expect(h.repos.runtime.getJob(id)).toMatchObject({ status: "queued", attempts: 0, failureCount: 0 });
      expect(h.repos.processing.get(id)).toMatchObject({ state: "embedding_pending", attemptCount: 0 });
    }
  });

  it("preserves legacy document-first retry ordering while holding the next role after a pause", async () => {
    const h = harness({ algorithm: "legacy" });
    let paused = false;
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "embedding";
    h.retry("document-retry");
    const query = h.retry("query-retry");
    h.db.db.prepare("UPDATE embedding_retry_queue SET embed_role = 'query' WHERE id = ?").run(query.id);
    const roles: Array<"document" | "query" | undefined> = [];
    h.deps.embedder.embed = async (texts, role) => { roles.push(role); paused = true; return texts.map(() => [1, 0, 0]); };
    expect(await h.runner.runEmbeddingRetryOnce(2)).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(roles).toEqual(["document"]);
    expect(h.repos.runtime.getEmbeddingRetry(query.id)).toMatchObject({ status: "pending", attempts: 0,
      enqueueSeq: query.enqueueSeq, nextAttemptAt: query.nextAttemptAt, claimedBy: null, leaseToken: null, leaseUntil: null });
  });

  it("returns later role batches to their original FIFO and waiting processing state, then resumes", async () => {
    const h = embeddingRoleHarness("wrr", ["query", "document", "query"]);
    let paused = false;
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "embedding";
    for (let i = 0; i < 3; i++) {
      saveProcessing(h, `embedding-${i}`, 2);
      h.db.db.prepare("UPDATE evolution_jobs SET attempts = 2, failure_count = 1 WHERE id = ?").run(`embedding-${i}`);
    }
    const originals = [1, 2].map(i => h.repos.runtime.getJob(`embedding-${i}`)!);
    const originalEmbed = h.deps.embedder.embed;
    h.deps.embedder.embed = async (texts, role) => {
      const result = await originalEmbed(texts, role);
      if (h.calls.length === 1) paused = true;
      return result;
    };
    const first = await h.runner.runWorkerOnce(3);
    expect(h.calls).toEqual([{ role: "query", texts: ["embedding-0"] }]);
    expect(first).toMatchObject({ leased: 3, succeeded: 1, failed: 0 });
    expect(first.jobs.map(job => job.status)).toEqual(["succeeded", "queued", "queued"]);
    for (const original of originals) {
      expect(h.repos.runtime.getJob(original.id)).toMatchObject({ status: "queued", attempts: 2,
        failureCount: 1, enqueueSeq: original.enqueueSeq, firstQueuedAt: original.firstQueuedAt,
        leasedUntil: null, leaseOwner: null, leaseToken: null });
      expect(h.repos.processing.get(original.targetMemoryId!)).toMatchObject({ state: "embedding_pending",
        stage: "embedding", activeJobId: original.id, attemptCount: 2 });
    }
    paused = false;
    expect(await h.runner.runWorkerOnce(3)).toMatchObject({ leased: 2, succeeded: 2, failed: 0 });
    expect(h.applied).toEqual(["embedding-0", "embedding-1", "embedding-2"]);
  });

  it.each([false, true])("checks main item fallback boundaries when pause starts before first item=%s", async pauseBeforeFirst => {
    const h = embeddingRoleHarness("wrr", ["document", "document", "document"]);
    let paused = false;
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "embedding";
    for (let i = 0; i < 3; i++) saveProcessing(h, `embedding-${i}`);
    h.deps.embedder.embed = async () => { paused = pauseBeforeFirst; throw inputTooLong(); };
    const singles: string[] = [];
    h.deps.embedder.embedOne = async text => { singles.push(text); paused = true; return [1, 0, 0]; };
    const result = await h.runner.runWorkerOnce(3);
    expect(singles).toEqual(pauseBeforeFirst ? [] : ["embedding-0"]);
    expect(result).toMatchObject({ leased: 3, succeeded: pauseBeforeFirst ? 0 : 1, failed: 0 });
    for (let i = pauseBeforeFirst ? 0 : 1; i < 3; i++) {
      expect(h.repos.runtime.getJob(`embedding-${i}`)).toMatchObject({ status: "queued", attempts: 0, failureCount: 0 });
      expect(h.repos.processing.get(`embedding-${i}`)).toMatchObject({ state: "embedding_pending", attemptCount: 0 });
    }
  });

  it.each([false, true])("checks retry item fallback boundaries when pause starts before first item=%s", async pauseBeforeFirst => {
    const h = harness();
    let paused = false;
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "embedding";
    const originals = [0, 1, 2].map(i => h.retry(`retry-${i}`));
    h.deps.embedder.embed = async () => { paused = pauseBeforeFirst; throw inputTooLong(); };
    const singles: string[] = [];
    h.deps.embedder.embedOne = async text => { singles.push(text); paused = true; return [1, 0, 0]; };
    const result = await h.runner.runWorkerOnce(3);
    expect(singles).toHaveLength(pauseBeforeFirst ? 0 : 1);
    expect(result.embeddingRetries).toMatchObject({ leased: 3, succeeded: pauseBeforeFirst ? 0 : 1, failed: 0 });
    for (const original of originals.slice(pauseBeforeFirst ? 0 : 1)) {
      expect(h.repos.runtime.getEmbeddingRetry(original.id)).toMatchObject({ status: "pending", attempts: 0,
        enqueueSeq: original.enqueueSeq, nextAttemptAt: original.nextAttemptAt,
        claimedBy: null, leaseToken: null, leaseUntil: null });
    }
  });

  it("does not restore processing owned by a replacement lease when returning a later role", async () => {
    const h = embeddingRoleHarness("wrr", ["query", "document"]);
    let paused = false;
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "embedding";
    saveProcessing(h, "embedding-1");
    h.job("replacement-job", "embedding", { target: "embedding-1" });
    const originalEmbed = h.deps.embedder.embed;
    h.deps.embedder.embed = async (texts, role) => {
      const result = await originalEmbed(texts, role);
      h.db.db.prepare("UPDATE evolution_jobs SET lease_owner = 'replacement', lease_token = 'replacement-token' WHERE id = 'embedding-1'").run();
      h.repos.processing.update("embedding-1", { activeJobId: "replacement-job", state: "embedding" });
      paused = true;
      return result;
    };
    await h.runner.runWorkerOnce(2);
    expect(h.calls).toHaveLength(1);
    expect(h.repos.runtime.getJob("embedding-1")).toMatchObject({ status: "leased", leaseOwner: "replacement", leaseToken: "replacement-token" });
    expect(h.repos.processing.get("embedding-1")).toMatchObject({ activeJobId: "replacement-job", state: "embedding" });
  });
});
