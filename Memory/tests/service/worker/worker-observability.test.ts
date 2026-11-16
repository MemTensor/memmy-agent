import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { MemoryModelTaskRouter, type MemoryModelTaskContext } from "../../../src/model/task-routing.js";
import { ModelHttpError } from "../../../src/model/http.js";
import { WorkerConcurrencyController, providerDescriptor, type WorkerRequirements } from "../../../src/service/worker/worker-concurrency.js";
import { observeWorker, readWorkerQueueMetrics, WorkerObservability, type WorkerObservation, type WorkerObserver } from "../../../src/service/worker/worker-observability.js";
import { createBatchReflectionLlm, createCapturingEmbedder, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fixture.cleanup(); });
const at = Date.parse("2026-10-23T00:00:00Z");
const work = { lane: "import", queue: "main" as const, firstQueuedAt: new Date(at - 1_000).toISOString() };
const req = (changes: Partial<WorkerRequirements> = {}): WorkerRequirements => ({ resourceClass: "summary", providers: [], scopeKeys: [], ...changes });
const asSnapshot = (metrics: WorkerObservability) => metrics.snapshot() as any;
function routed(metrics: WorkerObserver, c: WorkerConcurrencyController) {
  const summary = createBatchReflectionLlm([]);
  const context: MemoryModelTaskContext = { config: DEFAULT_MEMMY_CONFIG, summary, evolution: summary, embedding: createCapturingEmbedder([]) };
  const router = new MemoryModelTaskRouter(() => context, c, metrics);
  return { router, context };
}

describe("bounded worker diagnostics", () => {
  it("reports background occupancy, reservation and admission rejection without a full queue census", () => {
    let now = at;
    const metrics = new WorkerObservability({ now: () => now });
    const c = new WorkerConcurrencyController({}, {}), detach = c.observe(metrics);
    const background = c.tryAcquire(req({ queueLane: "import" }), 3)!;
    expect(c.tryAcquire(req({ queueLane: "maintenance" }))).toBeUndefined();
    const interactive = c.tryAcquire(req({ queueLane: "interactive" }))!;
    expect(asSnapshot(metrics).concurrency).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3,
      maxBackgroundJobs: 3, interactiveReservedSlots: 1, peaks: { global: 4, background: 3 } });
    expect(asSnapshot(metrics).counters["admission_rejected.background"]).toBe(1);
    // Unchanged occupancy must remain visible after the event's original window expires.
    now += 310_001;
    expect(asSnapshot(metrics).concurrency.peaks.background).toBe(3);
    background.release(); background.release(); interactive.release();
    expect(asSnapshot(metrics).concurrency).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0 });
    detach(); metrics.stop();
  });

  it("reports started wait percentiles, completion rate and time-due counts without claiming they are runnable", () => {
    let now = at;
    const metrics = new WorkerObservability({ now: () => now, queueSnapshot: () => [{ lane: "import", queued: 7, failed: 1,
      leased: 2, dueTimeOnly: 6, oldestWaitingAt: new Date(at - 100_000).toISOString() }] });
    for (const wait of [100, 200, 300, 400, 900]) {
      const item = { ...work, firstQueuedAt: new Date(now - wait).toISOString() };
      metrics.record({ type: "claimed", work: item }); metrics.record({ type: "started", work: item });
      metrics.record({ type: "finished", work: item, outcome: "succeeded" });
    }
    metrics.record({ type: "skipped", lane: "import", reason: "scope" }); now += 60_000;
    const result = asSnapshot(metrics);
    expect(result.lanes.import).toMatchObject({ queued: 7, failed: 1, leased: 2, dueTimeOnly: 6,
      oldestWaitingAgeMs: 160_000, waitMs: { sampleCount: 5, p50: 300, p95: 900 }, admitted: 5, succeeded: 5, completedPerMinute: 5 });
    expect(result.dueBasis).toContain("not_dependency"); expect(result.runnableBasis).toContain("not_a_full_queue");
    expect(result.counters["skip.import.scope"]).toBe(1);
  });

  it("bounds lane samples and model cardinality, then expires old samples and counters", () => {
    let now = at; const metrics = new WorkerObservability({ now: () => now });
    for (let i = 0; i < 2_000; i++) metrics.record({ type: "started", work });
    for (let i = 0; i < 100; i++) metrics.record({ type: "model_request", providerKey: `provider-secret-${i}`,
      modelKey: `model-secret-${i}`, kind: "embedding", durationMs: i, outcome: "succeeded", batchSize: 16 });
    let result = asSnapshot(metrics);
    expect(result.lanes.import.waitMs.sampleCount).toBe(512); expect(result.models).toHaveLength(33);
    expect(result.models.find((model: any) => model.id === "overflow").latencyMs.sampleCount).toBe(68);
    expect(JSON.stringify(result)).not.toMatch(/provider-secret|model-secret/);
    now += 310_001; result = asSnapshot(metrics);
    expect(result.lanes.import.waitMs.sampleCount).toBe(0); expect(result.counters).toEqual({});
    expect(result.models.every((model: any) => model.latencyMs.sampleCount === 0)).toBe(true);
  });

  it("reuses time buckets across two thousand wall-clock reversals and excludes future observations", () => {
    let now = at; const metrics = new WorkerObservability({ now: () => now });
    for (let i = 0; i < 2_000; i++) { now = at + (i % 2) * 10_000; metrics.record({ type: "claimed", work }); }
    expect((metrics as unknown as { buckets: unknown[] }).buckets).toHaveLength(2);
    expect(asSnapshot(metrics).counters["lane.import.claimed"]).toBe(2_000);
    now = at; expect(asSnapshot(metrics).counters["lane.import.claimed"]).toBe(1_000);
    // Many distinct backwards positions also obey the hard capacity.
    for (let i = 0; i < 1_000; i++) { now = at - i * 10_000; metrics.record({ type: "claimed", work }); }
    expect((metrics as unknown as { buckets: unknown[] }).buckets.length).toBeLessThanOrEqual(32);
  });

  it.each([0, -1, NaN, Infinity, 0.5, 3_600_001])("rejects invalid metrics timer/window configuration %s", invalid => {
    expect(() => new WorkerObservability({ windowMs: invalid })).toThrow(RangeError);
    expect(() => new WorkerObservability({ logIntervalMs: invalid })).toThrow(RangeError);
  });

  it("logs at most once per interval, flushes final once, and removes its unref timer", () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const write = vi.fn(); const before = vi.getTimerCount(); const metrics = new WorkerObservability({ write });
    metrics.start(); metrics.start(); expect(vi.getTimerCount()).toBe(before + 1);
    metrics.flush(); expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000); expect(write).toHaveBeenCalledTimes(1);
    metrics.stop(); metrics.stop(); expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toMatchObject({ final: true }); expect(vi.getTimerCount()).toBe(before);
    vi.advanceTimersByTime(60_000); expect(write).toHaveBeenCalledTimes(2);
  });

  it("isolates snapshot, writer and observer failures from business execution", async () => {
    const metrics = new WorkerObservability({ queueSnapshot: () => { throw Error("private body"); }, write: () => { throw Error("private key"); } });
    expect(asSnapshot(metrics)).toMatchObject({ queueSnapshotError: true, queueSnapshotAvailable: false,
      lanes: { import: { queued: null, dueTimeOnly: null } } }); expect(() => metrics.stop()).not.toThrow();
    const c = new WorkerConcurrencyController({}, {}); c.observe({ record: () => { throw Error("observer failed"); } });
    const { router } = routed({ record: () => { throw Error("observer failed"); } }, c);
    const permit = c.tryAcquire(req())!; expect(permit).toBeDefined(); permit.release();
    await expect(router.embedder().embed(["safe synthetic text"])).resolves.toEqual([[1, 0, 0]]);
    expect(() => observeWorker({ record: () => { throw Error("observer failed"); } }, { type: "started", work })).not.toThrow();
    await Promise.all([router.stop(), c.close()]); expect(c.snapshot()).toMatchObject({ activeJobs: 0, providers: {}, embeddingRequests: 0 });
  });

  it("records lease transitions separately from claims with a historical recovery count", () => {
    const metrics = new WorkerObservability({ now: () => at });
    metrics.record({ type: "claimed", work: { ...work, queue: "embedding_retry", leaseCount: 8, leaseRecoveryCount: 3 } });
    for (const action of ["renewed", "renew_failed", "fenced", "expired", "recovered"] as const) metrics.record({ type: "lease", queue: "embedding_retry", action });
    const counters = asSnapshot(metrics).counters;
    expect(counters["queue.embedding_retry.claimed"]).toBe(1); expect(counters["queue.embedding_retry.claims_with_recovery_history"]).toBe(1);
    expect(counters["lease.embedding_retry.recovered"]).toBe(1);
  });

  it("aggregates finite selection reasons only from committed claim observations", () => {
    const metrics = new WorkerObservability();
    for (const selectionReason of ["wrr", "aging", "interactive", "legacy"] as const) {
      metrics.record({ type: "claimed", work: { ...work, selectionReason } });
      metrics.record({ type: "started", work: { ...work, selectionReason } });
    }
    const counters = asSnapshot(metrics).counters;
    for (const reason of ["wrr", "aging", "interactive", "legacy"]) expect(counters[`selection.import.${reason}`]).toBe(1);
    expect(counters["lane.import.claimed"]).toBe(4);
  });

  it.each([
    ["global", { maxActiveJobs: 1 }, req(), req()],
    ["resource", { resourceLimits: { summary: 1 } }, req(), req()],
    ["scope", {}, req({ scopeKeys: ["secret-scope"] }), req({ scopeKeys: ["secret-scope"] })],
    ["provider", {}, req({ providers: [{ key: "secret-provider", limit: 1 }] }), req({ providers: [{ key: "secret-provider", limit: 1 }] })],
    ["embedding_request", {}, req({ embedding: true }), req({ embedding: true })]
  ] as const)("reports exact %s denial without holding partial permits or private identities", async (reason, options, first, second) => {
    const c = new WorkerConcurrencyController(options, {}), metrics = new WorkerObservability(); c.observe(metrics);
    const permit = c.tryAcquire(first)!; expect(c.tryAcquire(second)).toBeUndefined(); let result = asSnapshot(metrics);
    expect(result.counters[`admission_rejected.${reason}`]).toBe(1);
    expect(result.concurrency.activeJobs).toBe(1); expect(result.concurrency.peaks.global).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/secret-scope|secret-provider/);
    permit.release(); await c.close(); result = asSnapshot(metrics);
    expect(result.concurrency.activeJobs).toBe(0); expect(result.concurrency.resources).toMatchObject({ summary: 0 });
    expect(result.concurrency.maxActiveJobs).toBe(c.limits.maxActiveJobs);
  });

  it("reports batch, invalid sharing and closing as separate rejection reasons", async () => {
    const c = new WorkerConcurrencyController({ embeddingBatchSize: 1 }, {}), events: WorkerObservation[] = []; c.observe({ record: event => events.push(event) });
    const permit = c.tryAcquire(req({ resourceClass: "embedding", embedding: true }))!;
    expect(c.tryAcquire(req({ resourceClass: "embedding", embedding: true }), 1, permit)).toBeUndefined();
    expect(c.tryAcquire(req(), 1, permit)).toBeUndefined(); permit.release(); await c.close(); expect(c.tryAcquire(req())).toBeUndefined();
    expect(events.filter(event => event.type === "admission_rejected").map(event => event.reason)).toEqual(["batch", "share_invalid", "closing"]);
  });

  it("keeps active occupancy in the window peak even without transitions during a long-running job", async () => {
    let now = at; const metrics = new WorkerObservability({ now: () => now }), c = new WorkerConcurrencyController({}, {});
    c.observe(metrics); const permit = c.tryAcquire(req())!;
    now += 310_001;
    expect(asSnapshot(metrics).concurrency).toMatchObject({ activeJobs: 1, peaks: { global: 1, "resource.summary": 1 },
      utilization: { global: 0.25, resources: { summary: 0.25 } } });
    permit.release(); await c.close();
  });

  it("bounds provider labels across repeated endpoint changes, including the rolling peak map", async () => {
    const metrics = new WorkerObservability(), c = new WorkerConcurrencyController({}, {}); c.observe(metrics);
    for (let i = 0; i < 100; i++) {
      const permit = c.tryAcquire(req({ providers: [{ key: `private-endpoint-${i}`, limit: 2 }] }))!;
      permit.release();
    }
    const snapshot = asSnapshot(metrics);
    expect(Object.keys(snapshot.concurrency.peaks).filter(key => key.startsWith("provider."))).toHaveLength(33);
    expect(JSON.stringify(snapshot)).not.toContain("private-endpoint"); await c.close();
  });

  it("starts model latency only after physical admission, then records failures without error messages", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const metrics = new WorkerObservability(), c = new WorkerConcurrencyController({}, {}); const { router, context } = routed(metrics, c);
    let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; }); let calls = 0;
    context.summary.complete = async () => { calls++; if (calls === 1) { await held; clock += 5; return "synthetic"; }
      clock += 7; throw new ModelHttpError("private response and credential", "host", 429, undefined, "private detail"); };
    const descriptor = providerDescriptor(context.summary.config, c.limits);
    const p = c.tryAcquire(req({ providers: descriptor.providers.map(provider => ({ ...provider, limit: 1 })) }))!;
    const first = p.run(() => router.runWith(context, () => router.client("summary").complete([], { operation: "isolated" })));
    await Promise.resolve(); await Promise.resolve();
    const second = router.client("summary").complete([], { operation: "isolated" }); const rejected = expect(second).rejects.toMatchObject({ httpStatus: 429 });
    clock = 1_000; finish(); await first; p.release(); await rejected;
    const result = asSnapshot(metrics), model = result.models[0];
    expect(model.latencyMs).toMatchObject({ sampleCount: 2, p50: 7, p95: 1_005 }); expect(model.rateLimited).toBe(1);
    expect(model.failed).toBe(1); expect(model.reportedTokens).toBeNull(); expect(JSON.stringify(result)).not.toMatch(/private response|private detail|credential/);
    await Promise.all([router.stop(), c.close()]);
  });

  it("records per-slice batch sizes, reported tokens and timeout outcomes", async () => {
    const metrics = new WorkerObservability(), c = new WorkerConcurrencyController({}, {}); const { router, context } = routed(metrics, c);
    context.embedding.embed = async texts => texts.map(() => [1]);
    await router.embedder().embed(Array.from({ length: 37 }, () => "private text"), "query"); const descriptor = providerDescriptor(context.embedding.config, c.limits);
    metrics.record({ type: "tokens", providerKey: descriptor.providers[0]!.key, modelKey: descriptor.providers.at(-1)!.key,
      kind: "embedding", inputTokens: 12, outputTokens: 0, totalTokens: 12 });
    context.embedding.embedOne = async () => { throw new DOMException("private endpoint", "TimeoutError"); };
    await expect(router.embedder().embedOne("private text")).rejects.toMatchObject({ name: "TimeoutError" }); const result = asSnapshot(metrics);
    expect(result.models[0]).toMatchObject({ requests: 4, usageReports: 1, reportedTokens: { input: 12, output: 0, total: 12 },
      timedOut: 1, embeddingBatchSize: { sampleCount: 4, p50: 5, p95: 16 } }); expect(JSON.stringify(result)).not.toMatch(/private text|private endpoint/);
    await Promise.all([router.stop(), c.close()]);
  });

  it("reads queue counts and oldest timestamps without hydrating bodies or claiming blocked jobs", async () => {
    const root = fixture.createTestRoot(), db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = fixture.createTestMemoryService({ db, observability: new WorkerObservability({ write: () => {} }) }); const repos = new Repositories(db.db);
    const job = repos.runtime.enqueueJob({ id: "isolated", jobType: "import_summary", userId: "isolated", status: "queued", payload: {},
      attempts: 0, maxAttempts: 3, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() });
    db.db.prepare("UPDATE evolution_jobs SET blocked_reason='configuration', available_at=? WHERE id=?").run(new Date(at).toISOString(), job.id);
    const retry = repos.runtime.enqueueEmbeddingRetry({ id: "isolated-retry", targetKind: "trace", targetId: "missing-target",
      vectorField: "vec_summary", sourceText: "PRIVATE_LARGE_BODY", now: at + 60_000 });
    const get = vi.spyOn(repos.memories, "get").mockImplementation(() => { throw Error("must not hydrate"); });
    const prepare = vi.spyOn(db.db, "prepare"); const result = readWorkerQueueMetrics(db.db, at);
    expect(prepare.mock.calls.map(([sql]) => sql).join(" ")).not.toMatch(/memory_value|source_text|payload_json|properties_json|embedding_json/);
    expect(result.find(row => row.lane === job.queueLane)).toMatchObject({ queued: 1, dueTimeOnly: 1, oldestWaitingAt: job.firstQueuedAt });
    expect(result.find(row => row.lane === retry.queueLane)).toMatchObject({ queued: 1, dueTimeOnly: 0 }); expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_LARGE_BODY"); expect(repos.runtime.getJob(job.id)).toMatchObject({ status: "queued", leaseToken: null }); await service.stop();
  });

  it("collects actual client usage through MemoryService and flushes before the DB closes", async () => {
    const root = fixture.createTestRoot(), db = new MemoryDb({ path: join(root, "memory.sqlite") }); const writes: Record<string, unknown>[] = [];
    const metrics = new WorkerObservability({ queueSnapshot: at => readWorkerQueueMetrics(db.db, at), write: snapshot => writes.push(snapshot) });
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.summary = { ...config.summary, provider: "openai_compatible", sourceProvider: undefined, endpoint: "https://isolated.test/v1",
      model: "isolated-summary", apiKey: "PRIVATE_TEST_KEY", maxRetries: 0, malformedRetries: 0 }; config.algorithm.capture.embedAfterCapture = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "Synthetic build", summary: "Use a reproducible build pipeline." }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }), { status: 200, headers: { "content-type": "application/json" } })));
    const service = fixture.createTestMemoryService({ db, config, observability: metrics });
    service.addMemory({ namespace: { userId: "isolated", source: "codex", profileId: "default" }, adapterId: "agent-source:codex",
      requestId: "isolated", layer: "L1", source: "codex", tags: ["agent-source", "codex"], turnId: "isolated-turn",
      content: "## user\n\nUse a reproducible build pipeline.\n\n## assistant\n\nPipeline documented." });
    expect(await service.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 1, failed: 0 }); const snapshot = asSnapshot(metrics);
    expect(snapshot.models).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "summary", requests: 1,
      usageReports: 1, reportedTokens: { input: 11, output: 7, total: 18 } })]));
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_TEST_KEY|isolated.test|reproducible build/); await service.stop();
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ final: true, queueSnapshotError: false });
    expect(asSnapshot(metrics).concurrency.activeJobs).toBe(0);
  });

  it("fixture cleanup waits for services and only closes the resources captured before its await", async () => {
    const local = createMemoryServiceFixture();
    const first = local.createTestService();
    const stop = first.service.stop.bind(first.service);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(first.service, "stop").mockImplementation(async () => { await stop(); await gate; });
    const cleaning = local.cleanup();
    const next = local.createTestService();
    try {
      await Promise.resolve(); expect(first.db.db.open).toBe(true); expect(next.db.db.open).toBe(true);
      release(); await cleaning;
      expect(first.db.db.open).toBe(false); expect(next.db.db.open).toBe(true);
    } finally { release(); await cleaning; await local.cleanup(); }
  });

  it("fixture cleanup reports a failed stop after closing its captured resources", async () => {
    const local = createMemoryServiceFixture(), first = local.createTestService();
    const stop = first.service.stop.bind(first.service), failure = new Error("isolated stop failure");
    vi.spyOn(first.service, "stop").mockImplementation(async () => { await stop(); throw failure; });
    await expect(local.cleanup()).rejects.toBe(failure); expect(first.db.db.open).toBe(false);
  });

  it("fixture cleanup still stops other services if one stop throws synchronously", async () => {
    const local = createMemoryServiceFixture(), first = local.createTestService(), next = local.createTestService();
    await first.service.stop(); const failure = new Error("isolated synchronous stop failure");
    vi.spyOn(first.service, "stop").mockImplementation(() => { throw failure; });
    const nextStop = vi.spyOn(next.service, "stop");
    await expect(local.cleanup()).rejects.toBe(failure);
    expect(nextStop).toHaveBeenCalledOnce(); expect(first.db.db.open).toBe(false); expect(next.db.db.open).toBe(false);
  });

  it("fixture shutdown completes with fake timers without requiring clock advancement", async () => {
    vi.stubEnv("MEMMY_LOG_LEVEL", "silent"); vi.useFakeTimers(); vi.setSystemTime(at);
    const timers = vi.getTimerCount(), local = createMemoryServiceFixture(); local.createTestService();
    await local.cleanup(); expect(Date.now()).toBe(at);
    // RuntimeRepository schedules a pre-existing best-effort compaction
    // immediate on construction. It notices the closed DB and returns; this
    // zero-time turn must not hide any leaked 30s metrics interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(Date.now()).toBe(at); expect(vi.getTimerCount()).toBe(timers);
  });
});
