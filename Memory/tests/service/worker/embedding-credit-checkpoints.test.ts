import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { SCHEMA_VERSION } from "../../../src/storage/schema.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createEmbedder } from "../../../src/model/embedder.js";
import type { WorkerRunner, WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { accountRuntimeConfig, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => { vi.unstubAllGlobals(); fixture.cleanup(); });

function setup(db?: MemoryDb, cache = false) {
  const config = accountRuntimeConfig();
  config.embedding = { ...config.embedding, cache, maxRetries: 0 };
  const embedder = createEmbedder(config.embedding);
  const current = db
    ? { db, service: fixture.createTestMemoryService({ db, config, embedder, mode: "dev" }) }
    : fixture.createTestService({ config, embedder });
  const runner: WorkerRunner = (current.service as any).workerRunner;
  const deps = (runner as unknown as { deps: WorkerRunnerDeps }).deps;
  const { embeddingJobs } = deps;
  const runtime = new Repositories(current.db.db).runtime;
  vi.spyOn(embeddingJobs, "prepareEmbeddingJob").mockImplementation(job => ({
    job, memory: {} as any, text: String(job.payload.text), role: "document", vectorField: "vec_summary"
  }));
  vi.spyOn(embeddingJobs, "applyEmbeddingVector").mockImplementation(() => {});
  return { ...current, runner, runtime, embeddingJobs, deps };
}

function job(runtime: Repositories["runtime"], id: string, text = "same text", userId = "user-a") {
  return runtime.enqueueJob({ id, jobType: "embedding", status: "queued", userId,
    payload: { text }, attempts: 0, maxAttempts: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

function embeddingResponse(body: string) {
  const inputs = JSON.parse(body).input as unknown[];
  return Response.json({ data: inputs.map(() => ({ embedding: [0.3, 0.4] })), usage: { prompt_tokens: 1 } });
}

describe("durable paid embedding steps", () => {
  it("migrates an existing v9 retry queue without losing pending work", () => {
    const first = setup();
    first.runtime.enqueueEmbeddingRetry({ id: "old-retry", targetKind: "trace", targetId: "old-memory", vectorField: "vec_summary", sourceText: "saved input" });
    first.db.db.exec(`ALTER TABLE embedding_retry_queue DROP COLUMN model_steps_json;
      UPDATE schema_migrations SET id='009_token_usage_outbox', version=9 WHERE version=${SCHEMA_VERSION};`);
    const path = first.db.path;
    first.db.close();
    const restarted = setup(new MemoryDb({ path }));
    expect(restarted.db.schemaVersion().version).toBe(SCHEMA_VERSION);
    expect(restarted.runtime.getEmbeddingRetry("old-retry")).toMatchObject({ sourceText: "saved input", status: "pending" });
    expect(restarted.runtime.getEmbeddingRetryModelSteps("old-retry")).toBeUndefined();
  });

  it("keeps a successful vector through a local write failure and restart, isolated by job/user", async () => {
    const first = setup();
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => embeddingResponse(String(options?.body)));
    vi.stubGlobal("fetch", fetch);
    job(first.runtime, "job-a");
    job(first.runtime, "job-b", "same text", "user-b");
    vi.mocked(first.embeddingJobs.applyEmbeddingVector).mockImplementationOnce(() => { throw new Error("database is locked"); });
    await first.runner.runLeasedEmbeddingJobs(first.runtime.leaseQueuedJobs(10));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Object.keys(first.runtime.getJob("job-a")!.payload.modelSteps as object)).toHaveLength(2);
    expect(first.runtime.getJob("job-b")!.status).toBe("succeeded");

    const path = first.db.path;
    first.db.close();
    const restarted = setup(new MemoryDb({ path }));
    restarted.runtime.requeueFailedJobs();
    const result = await restarted.runner.runLeasedEmbeddingJobs(restarted.runtime.leaseQueuedJobs(10));
    expect(result[0]?.succeeded).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(restarted.embeddingJobs.applyEmbeddingVector).toHaveBeenCalledWith(expect.anything(), [0.3, 0.4]);
    expect(restarted.runtime.getJob("job-a")!.payload.modelSteps).toBeUndefined();
  });

  it("does not reopen a completed job when its success notification fails", async () => {
    const current = setup();
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => embeddingResponse(String(options?.body))));
    job(current.runtime, "completed");
    vi.spyOn(current.deps, "appendJobChange").mockImplementation((_job, op) => {
      if (op === "succeeded") throw new Error("database is locked");
    });
    const results = await current.runner.runLeasedEmbeddingJobs(current.runtime.leaseQueuedJobs(10));
    expect(results[0]?.succeeded).toBe(1);
    expect(current.runtime.getJob("completed")!.status).toBe("succeeded");
    expect(current.runtime.requeueFailedJobs()).toEqual([]);
  });

  it("persists cache-hit vectors before applying them locally", async () => {
    const first = setup(undefined, true);
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => embeddingResponse(String(options?.body)));
    vi.stubGlobal("fetch", fetch);
    job(first.runtime, "cached-a");
    job(first.runtime, "cached-b");
    vi.mocked(first.embeddingJobs.applyEmbeddingVector).mockImplementation(item => {
      if (item.job.id === "cached-b") throw new Error("database is locked");
    });
    await first.runner.runLeasedEmbeddingJobs(first.runtime.leaseQueuedJobs(10));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(first.runtime.getJob("cached-b")!.payload.modelSteps as object)).toHaveLength(1);
    const path = first.db.path;
    first.db.close();
    const restarted = setup(new MemoryDb({ path }));
    restarted.runtime.requeueFailedJobs();
    await restarted.runner.runLeasedEmbeddingJobs(restarted.runtime.leaseQueuedJobs(10));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(restarted.runtime.getJob("cached-b")!.status).toBe("succeeded");
  });

  it("resumes only the unfinished HTTP batch after a credit pause and restart", async () => {
    const first = setup();
    // Exceeds the real planner's 290,000-token HTTP batch limit.
    job(first.runtime, "chunked", "word ".repeat(300_000));
    let funded = false;
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const body = String(options?.body);
      bodies.push(body);
      return bodies.length === 2 && !funded
        ? Response.json({ code: "CREDIT_INSUFFICIENT", message: "insufficient" }, { status: 422 })
        : embeddingResponse(body);
    });
    vi.stubGlobal("fetch", fetch);
    await first.runner.runLeasedEmbeddingJobs(first.runtime.leaseQueuedJobs(10));
    expect(bodies).toHaveLength(2);
    expect(first.runtime.getJob("chunked")!.payload.creditState).toBe("PAUSED_CREDIT");
    expect(Object.keys(first.runtime.getJob("chunked")!.payload.modelSteps as object)).toHaveLength(1);

    const path = first.db.path;
    first.db.close();
    const restarted = setup(new MemoryDb({ path }));
    funded = true;
    restarted.runtime.resumeCreditJob("chunked");
    await restarted.runner.runLeasedEmbeddingJobs(restarted.runtime.leaseQueuedJobs(10));
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toBe(bodies[1]);
    expect(restarted.runtime.getJob("chunked")!.status).toBe("succeeded");
  }, 30_000);

  it("persists legacy retry responses across a failed apply and restart, and clears them on success", async () => {
    const first = setup();
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => embeddingResponse(String(options?.body)));
    vi.stubGlobal("fetch", fetch);
    first.runtime.enqueueEmbeddingRetry({ id: "retry-a", targetKind: "trace", targetId: "memory-a", vectorField: "vec_summary", sourceText: "retry text" });
    vi.spyOn(first.runner, "applyEmbeddingRetryVector").mockImplementation(() => { throw new Error("database is locked"); });
    await first.runner.runEmbeddingRetryOnce(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(first.runtime.getEmbeddingRetryModelSteps("retry-a")!)).toHaveLength(2);

    const path = first.db.path;
    first.db.close();
    const restarted = setup(new MemoryDb({ path }));
    restarted.db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=0 WHERE id='retry-a'").run();
    vi.spyOn(restarted.runner, "applyEmbeddingRetryVector").mockImplementation((retry, claim, vector) => {
      expect(vector).toEqual([0.3, 0.4]);
      const completed = restarted.runtime.markEmbeddingRetrySucceededClaimed(retry.id, { ...claim, now: Date.now() });
      expect(completed?.status).toBe("succeeded");
      expect(restarted.runtime.getEmbeddingRetryModelSteps(retry.id)).toBeUndefined();
      return { succeeded: 1, failed: 0, item: null };
    });
    await restarted.runner.runEmbeddingRetryOnce(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(restarted.runtime.getEmbeddingRetry("retry-a")!.status).toBe("succeeded");
  });

  it("rejects stale retry checkpoint writers and discards checkpoints when the source changes", () => {
    const { runtime } = setup();
    const now = Date.now();
    const input = { id: "retry-a", targetKind: "trace" as const, targetId: "memory-a", vectorField: "vec_summary" as const, sourceText: "first", now };
    runtime.enqueueEmbeddingRetry(input);
    const claim = { workerId: "worker", leaseUntil: now + 1000 };
    runtime.claimDueEmbeddingRetries({ ...claim, now });
    const key = `${"a".repeat(64)}_0`;
    expect(() => runtime.saveEmbeddingRetryModelStep("retry-a", { ...claim, workerId: "stale" }, key, { data: [] }, now)).toThrow(/lease/);
    runtime.saveEmbeddingRetryModelStep("retry-a", claim, key, { data: [] }, now);
    expect(runtime.getEmbeddingRetryModelSteps("retry-a")?.[key]).toEqual({ data: [] });
    runtime.enqueueEmbeddingRetry({ ...input, sourceText: "different" });
    expect(runtime.getEmbeddingRetryModelSteps("retry-a")).toBeUndefined();
    expect(() => runtime.saveEmbeddingRetryModelStep("retry-a", claim, key, { data: [] }, now)).toThrow(/lease/);
  });
});
