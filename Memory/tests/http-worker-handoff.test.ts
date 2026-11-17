import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer } from "../src/index.js";
import { closeMemoryHttpServer } from "../src/server/http.js";
import { Repositories } from "../src/storage/repositories.js";
import type { WorkerConcurrencyController } from "../src/service/worker/worker-concurrency.js";
import type { EvolutionJobRecord } from "../src/storage/repositories.js";
import { createBatchReflectionLlm, createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture(), servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeMemoryHttpServer));
  fixture.cleanup(); vi.restoreAllMocks();
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for worker handoff");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}
function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("HTTP automatic worker handoff", () => {
  it("resumes queued work after an automatic request is interleaved between several manual requests", async () => {
    const { service, db, root } = fixture.createTestService({ llm: createBatchReflectionLlm([]),
      fetchAppMemoryBudget: async () => ({ dailyUsed: 0, lifetimeUsed: 0 }) });
    const repos = new Repositories(db.db);
    const gates = new Map(["first", "manual-1", "manual-2", "manual-3"].map(id => [id, deferred()]));
    const starts: string[] = [], automaticResults: number[] = [];
    let active = 0, peak = 0, peakJobs = 0, peakLeased = 0;
    const internal = service as unknown as { workerRunner: { concurrency: WorkerConcurrencyController;
      deps: { jobHandlers: { processJob(job: EvolutionJobRecord): Promise<void> } } } };
    internal.workerRunner.deps.jobHandlers.processJob = async job => {
      starts.push(job.id); peak = Math.max(peak, ++active);
      peakJobs = Math.max(peakJobs, internal.workerRunner.concurrency.snapshot().activeJobs);
      peakLeased = Math.max(peakLeased, Number((db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get() as { n: number }).n));
      try { await gates.get(job.id)?.promise; } finally { active--; }
    };
    for (const id of ["first", "tail", ...[...gates.keys()].filter(id => id !== "first")]) {
      const at = new Date().toISOString();
      repos.runtime.enqueueJob({ id, jobType: "trace_summary", targetMemoryId: id, userId: "handoff-user",
        payload: {}, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
      if (id.startsWith("manual")) db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id=?").run("2100-01-01T00:00:00.000Z", id);
    }
    const original = service.runWorkerOnce.bind(service);
    const run = vi.spyOn(service, "runWorkerOnce").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[2]?.continuous) automaticResults.push(result.leased);
      return result;
    });
    const base = await listen(createMemoryHttpServer({ service, configPath: join(root, "config.yaml"), workerStartupFallbackMs: 60_000 }));
    const automaticCalls = () => run.mock.calls.filter(([, , execution]) => execution?.continuous).length;
    const pending: Array<Promise<Response>> = [];
    const manual = async (id: string) => {
      db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE id=?").run(id);
      pending.push(post(base, "/api/v1/worker/run", { limit: 1, targetMemoryIds: [id] }));
      await waitFor(() => run.mock.calls.some(([, request, execution]) => !execution?.continuous && request?.targetMemoryIds?.[0] === id));
    };
    try {
      expect((await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: [] })).status).toBe(200);
      await waitFor(() => starts.includes("first"));
      await manual("manual-1"); await manual("manual-2");
      gates.get("first")!.resolve();
      await waitFor(() => starts.includes("manual-1") && automaticCalls() >= 2);
      // auto#2 is now behind manual#2. Queue manual#3 behind auto#2 so its
      // legitimate yield must not be mistaken for an empty durable queue.
      await manual("manual-3");
      gates.get("manual-1")!.resolve(); await waitFor(() => starts.includes("manual-2"));
      gates.get("manual-2")!.resolve(); await waitFor(() => starts.includes("manual-3") && automaticResults.length >= 2);
      expect(repos.runtime.getJob("tail")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      gates.get("manual-3")!.resolve();
      const responses = await Promise.all(pending);
      expect(responses.every(response => response.status === 200)).toBe(true);
      for (const response of responses) expect(await response.json()).toMatchObject({ leased: 1, succeeded: 1 });
      await waitFor(() => repos.runtime.getJob("tail")?.status === "succeeded");
      expect(starts).toEqual(["first", "manual-1", "manual-2", "manual-3", "tail"]);
      expect(automaticResults.slice(0, 2)).toEqual([1, 0]);
      expect(peak).toBe(1); expect(peakJobs).toBeLessThanOrEqual(4); expect(peakLeased).toBe(1);
      await waitFor(() => internal.workerRunner.concurrency.snapshot().activeJobs === 0);
      await waitFor(() => automaticResults.length === automaticCalls() && automaticResults.at(-1) === 0);
      const settledCalls = automaticCalls();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(automaticCalls()).toBe(settledCalls);
      expect(settledCalls).toBeLessThanOrEqual(5);
      expect(internal.workerRunner.concurrency.snapshot().providers).toEqual({});
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get()).toEqual({ n: 0 });
    } finally { for (const gate of gates.values()) gate.resolve(); await Promise.allSettled(pending); }
  });
});
