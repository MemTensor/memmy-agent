import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor, type AgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../src/server/http.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";
import { WorkerConcurrencyController } from "../src/service/worker/worker-concurrency.js";

const fixture = createMemoryServiceFixture();
const releases: Array<() => void> = [];
const executors: AgentSourceExecutor[] = [];
const closeServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await Promise.all(closeServers.splice(0).map(close => close()));
  await Promise.all(executors.splice(0).map(executor => executor.dispose()));
  vi.restoreAllMocks();
  fixture.cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}

async function harness(run: (source: string, call: number) => Promise<void>,
  concurrency = new WorkerConcurrencyController({}, {})) {
  const { service, root } = fixture.createTestService({ concurrency });
  let active = 0, peak = 0;
  const calls: string[] = [];
  const createExecutor = (name = "primary") => {
    const created = createAgentSourceExecutor({ service,
      configPath: join(root, name, "config.yaml"), resolveAgentSkillRoot: () => null,
      sourceRegistry: createSourceRegistry(["fixture-one", "fixture-two"].map(sourceId => ({
        descriptor: { sourceId, displayName: sourceId, builtin: true, dataPath: root },
        async detect() { return true; },
        async *scan() {
          active++; peak = Math.max(peak, active); calls.push(sourceId);
          try { await run(sourceId, calls.length); } finally { active--; }
        }
      }))) });
    executors.push(created);
    return created;
  };
  const executor = createExecutor();
  const server = createMemoryHttpServer({ service, agentSourceExecutor: executor,
    auth: { mode: "dev", localServiceToken: "isolated-scan-test-token" } });
  closeServers.push(() => closeMemoryHttpServer(server));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const post = (entry: "local" | "viewer", suffix = "", body: unknown = { sourceId: "fixture-one", mode: "full" }) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1/agent-sources/scan${suffix}`, {
      method: "POST", headers: { "content-type": "application/json",
        ...(entry === "local" ? { authorization: "Bearer isolated-scan-test-token" } : { "x-memmy-viewer": "1" }) },
      body: JSON.stringify(body)
    });
  const done = async () => {
    await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false));
    return executor.scanStatus();
  };
  return { service, concurrency, executor, createExecutor, post, done, calls, peak: () => peak, active: () => active };
}

describe("Memory-owned scan admission after Desktop scanner consolidation", () => {
  it.each([["all", "fixture-one"], ["fixture-one", "all"]] as const)(
    "reserves overlapping sources atomically across executors: %s then %s", async (firstSource, secondSource) => {
      const entered = deferred(), finish = deferred();
      const h = await harness(async (_source, call) => { if (call === 1) { entered.resolve(); await finish.promise; } },
        new WorkerConcurrencyController({ resourceLimits: { scan: 2 } }, {}));
      const second = h.createExecutor("secondary");
      await h.executor.startScan({ sourceId: firstSource, mode: "full" }); await entered.promise;
      await second.startScan({ sourceId: secondSource, mode: "full" });
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      expect(h.calls).toEqual(["fixture-one"]);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 1, resources: { scan: 1 }, providers: {} });
      expect(h.concurrency.snapshot().scopeKeys.sort()).toEqual(firstSource === "all"
        ? ["agent-source-scan:fixture-one", "agent-source-scan:fixture-two"] : ["agent-source-scan:fixture-one"]);
      finish.resolve();
      await vi.waitFor(() => expect(second.scanStatus().running).toBe(false));
      await h.done();
      expect(second.scanStatus().error).toBeNull();
      expect(h.calls).toEqual(firstSource === "all"
        ? ["fixture-one", "fixture-two", "fixture-one"] : ["fixture-one", "fixture-one", "fixture-two"]);
      expect(h.peak()).toBe(1);
      await vi.waitFor(() => expect(h.concurrency.snapshot().activeJobs).toBe(0));
      expect(h.concurrency.snapshot().scopeKeys).toEqual([]);
    }
  );

  it("admits different sources from different executors when scan capacity is two", async () => {
    const finish = deferred();
    const h = await harness(async () => { await finish.promise; },
      new WorkerConcurrencyController({ resourceLimits: { scan: 2 } }, {}));
    const second = h.createExecutor("secondary");
    await h.executor.startScan({ sourceId: "fixture-one", mode: "full" });
    await second.startScan({ sourceId: "fixture-two", mode: "full" });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.peak()).toBe(2);
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 2, resources: { scan: 2 }, providers: {} });
    finish.resolve(); await h.done();
    await vi.waitFor(() => expect(second.scanStatus().running).toBe(false));
    await vi.waitFor(() => expect(h.concurrency.snapshot().activeJobs).toBe(0));
  });

  it("cancels an overlapping scan-all waiter without releasing the holder, then admits a fresh scan after release", async () => {
    const entered = deferred(), finish = deferred();
    const h = await harness(async (_source, call) => { if (call === 1) { entered.resolve(); await finish.promise; } },
      new WorkerConcurrencyController({ resourceLimits: { scan: 2 } }, {}));
    const second = h.createExecutor("secondary");
    await h.executor.startScan({ sourceId: "fixture-one", mode: "full" }); await entered.promise;
    await second.startScan({ sourceId: "all", mode: "full" });
    await new Promise<void>(resolve => setImmediate(resolve));
    await second.cancelScan();
    expect(h.calls).toEqual(["fixture-one"]);
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 1, resources: { scan: 1 },
      scopeKeys: ["agent-source-scan:fixture-one"] });
    finish.resolve(); await h.done();
    await second.startScan({ sourceId: "all", mode: "full" });
    await vi.waitFor(() => expect(second.scanStatus().running).toBe(false));
    expect(second.scanStatus().error).toBeNull();
    expect(h.calls).toEqual(["fixture-one", "fixture-one", "fixture-two"]);
    await vi.waitFor(() => expect(h.concurrency.snapshot().activeJobs).toBe(0));
    expect(h.concurrency.snapshot().scopeKeys).toEqual([]);
  });

  it("counts a scan in the shared background and global budgets while retaining the interactive slot", async () => {
    const entered = deferred(), finish = deferred();
    const h = await harness(async () => { entered.resolve(); await finish.promise; });
    expect((await h.post("local")).status).toBe(202); await entered.promise;
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 1, resources: { scan: 1 } });
    const held = Array.from({ length: 2 }, (_, index) => h.concurrency.tryAcquire({
      resourceClass: "summary", queueLane: "import", providers: [], scopeKeys: [`worker-${index}`]
    }));
    let interactive: ReturnType<WorkerConcurrencyController["tryAcquire"]>;
    try {
      expect(held.every(Boolean)).toBe(true);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 3, backgroundActiveJobs: 3, availableJobs: 1 });
      expect(h.concurrency.tryAcquire({ resourceClass: "summary", queueLane: "import", providers: [], scopeKeys: [] })).toBeUndefined();
      interactive = h.concurrency.tryAcquire({ resourceClass: "summary", queueLane: "interactive", providers: [], scopeKeys: [] });
      expect(interactive).toBeDefined();
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3, availableJobs: 0 });
      expect(h.concurrency.tryAcquire({ resourceClass: "summary", queueLane: "interactive", providers: [], scopeKeys: [] })).toBeUndefined();
    } finally {
      interactive?.release(); held.forEach(permit => permit?.release());
      finish.resolve(); await h.done();
    }
    await vi.waitFor(() => expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0 }));
  });

  it("keeps a scan waiting behind three background jobs, admits interactive work, and starts the scan when a background slot opens", async () => {
    const concurrency = new WorkerConcurrencyController({}, {}), entered = deferred(), finish = deferred();
    const held = Array.from({ length: 3 }, (_, index) => concurrency.tryAcquire({
      resourceClass: "summary", queueLane: "import", providers: [], scopeKeys: [`worker-${index}`]
    })!);
    const h = await harness(async () => { entered.resolve(); await finish.promise; }, concurrency);
    let interactive: ReturnType<WorkerConcurrencyController["tryAcquire"]>;
    try {
      expect(held.every(Boolean)).toBe(true);
      expect((await h.post("viewer")).status).toBe(202);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(h.calls).toEqual([]);
      expect(h.active()).toBe(0);
      expect(concurrency.snapshot()).toMatchObject({ activeJobs: 3, backgroundActiveJobs: 3, availableJobs: 1 });
      expect(concurrency.snapshot().scopeKeys).not.toContain("agent-source-scan:fixture-one");
      interactive = concurrency.tryAcquire({ resourceClass: "summary", queueLane: "interactive", providers: [], scopeKeys: ["fresh"] });
      expect(interactive).toBeDefined();
      expect(concurrency.snapshot()).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3 });
      expect(h.calls).toEqual([]);
      held[0]!.release();
      await entered.promise;
      expect(h.calls).toEqual(["fixture-one"]);
      expect(concurrency.snapshot()).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3, resources: { summary: 3, scan: 1 } });
      expect(concurrency.snapshot().scopeKeys).toContain("fresh");
      expect(concurrency.snapshot().scopeKeys).toContain("agent-source-scan:fixture-one");
    } finally {
      interactive?.release(); held.forEach(permit => permit?.release());
      finish.resolve(); await h.done();
    }
    await vi.waitFor(() => expect(concurrency.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0, scopeKeys: [] }));
  });

  it("cancels a scan waiting for global capacity without starting its adapter or releasing another task", async () => {
    const concurrency = new WorkerConcurrencyController({ maxActiveJobs: 1 }, {});
    const occupied = concurrency.tryAcquire({ resourceClass: "summary", providers: [], scopeKeys: [] })!;
    const h = await harness(async () => {}, concurrency);
    expect((await h.post("viewer")).status).toBe(202);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.calls).toEqual([]);
    await h.executor.cancelScan();
    expect(h.calls).toEqual([]);
    expect(concurrency.snapshot().activeJobs).toBe(1);
    occupied.release();
    expect((await h.post("local")).status).toBe(202);
    expect((await h.done()).error).toBeNull();
    expect(h.calls).toEqual(["fixture-one"]);
    await vi.waitFor(() => expect(concurrency.snapshot().activeJobs).toBe(0));
  });

  it.each([
    ["local", "viewer", "fixture-one"], ["viewer", "local", "all"],
    ["local", "viewer", "fixture-two"]
  ] as const)("shares the executor between %s and %s starts (second source %s)", async (first, second, sourceId) => {
    const entered = deferred(), finish = deferred();
    const h = await harness(async () => { entered.resolve(); await finish.promise; });
    expect((await h.post(first)).status).toBe(202);
    await entered.promise;
    expect((await h.post(second, "", { sourceId, mode: "full" })).status).toBe(409);
    expect(h.calls).toEqual(["fixture-one"]);
    expect(h.peak()).toBe(1);
    finish.resolve();
    expect((await h.done()).error).toBeNull();
  });

  it("retains admission while cancellation waits for the old writer, then permits a replacement", async () => {
    const entered = deferred(), finish = deferred();
    const h = await harness(async (_source, call) => { if (call === 1) { entered.resolve(); await finish.promise; } });
    expect((await h.post("viewer")).status).toBe(202); await entered.promise;
    const cancellation = h.executor.cancelScan();
    const denied = await h.post("local");
    expect(denied.status).toBe(409);
    expect(await denied.text()).toContain("Canceling");
    expect(h.calls).toHaveLength(1);
    expect(h.active()).toBe(1);
    finish.resolve(); await cancellation;
    expect((await h.post("local")).status).toBe(202);
    expect((await h.done()).error).toBeNull();
    expect(h.calls).toHaveLength(2);
    expect(h.peak()).toBe(1);
  });

  it("keeps a paused scan exclusive and resumes it without opening a second adapter", async () => {
    const entered = deferred(), finish = deferred();
    const h = await harness(async () => { entered.resolve(); await finish.promise; });
    expect((await h.post("local")).status).toBe(202); await entered.promise;
    expect((await h.post("viewer", "/stop", {})).status).toBe(200);
    expect(h.executor.scanStatus()).toMatchObject({ running: false, progress: { phase: "stopped" } });
    expect((await h.post("local", "", { sourceId: "fixture-two", mode: "full" })).status).toBe(409);
    expect((await h.post("viewer")).status).toBe(202);
    expect(h.calls).toHaveLength(1);
    finish.resolve();
    expect((await h.done()).error).toBeNull();
    expect(h.peak()).toBe(1);
  });

  it("releases admission after adapter failure so the next API scan can succeed", async () => {
    const h = await harness(async (_source, call) => { if (call === 1) throw new Error("isolated adapter failure"); });
    expect((await h.post("local")).status).toBe(202);
    expect((await h.done()).error).toContain("isolated adapter failure");
    expect(h.active()).toBe(0);
    expect((await h.post("viewer")).status).toBe(202);
    expect((await h.done()).error).toBeNull();
    expect(h.calls).toHaveLength(2);
    expect(h.peak()).toBe(1);
  });

  it("serializes sources within scan-all and rejects another scan while its first source is running", async () => {
    const entered = deferred(), finish = deferred();
    const h = await harness(async (source, call) => { if (source === "fixture-one" && call === 1) { entered.resolve(); await finish.promise; } });
    expect((await h.post("viewer", "", { sourceId: "all", mode: "full" })).status).toBe(202);
    await entered.promise;
    expect((await h.post("local", "", { sourceId: "fixture-two", mode: "full" })).status).toBe(409);
    expect(h.calls).toEqual(["fixture-one"]);
    finish.resolve(); expect((await h.done()).error).toBeNull();
    expect(h.calls).toEqual(["fixture-one", "fixture-two"]);
    expect(h.peak()).toBe(1);
  });

  it("waits for its active adapter on disposal and refuses starts during shutdown", async () => {
    const entered = deferred(), finish = deferred();
    const h = await harness(async () => { entered.resolve(); await finish.promise; });
    expect((await h.post("local")).status).toBe(202); await entered.promise;
    let disposed = false;
    const disposal = Promise.resolve(h.executor.dispose()).then(() => { disposed = true; });
    const denied = await h.post("viewer");
    expect(denied.status).toBe(409);
    expect(await denied.text()).toContain("shutting down");
    expect(disposed).toBe(false);
    finish.resolve(); await disposal;
    expect(h.active()).toBe(0);
  });
});
