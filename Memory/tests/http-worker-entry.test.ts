import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer, type LlmCompletionOptions, type LlmMessage } from "../src/index.js";
import { closeMemoryHttpServer } from "../src/server/http.js";
import {
  addAgentSourceImport, createBatchReflectionLlm, createMemoryServiceFixture
} from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const servers: Server[] = [];
const namespace = { source: "codex", profileId: "entry-test", userId: "entry-user" };
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeMemoryHttpServer));
  fixture.cleanup();
  vi.restoreAllMocks();
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}
async function post(base: string, path: string, body: unknown, token?: string) {
  return fetch(`${base}${path}`, { method: "POST", headers: {
    "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {})
  }, body: JSON.stringify(body) });
}
async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("timed out waiting for background worker");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Real HTTP, MemoryService, SQLite claims and state transitions. Only model
// requests are local substitutes; no current desktop/user data is involved.
describe("Memory HTTP unified worker entry", () => {
  it("wakes existing queued imports even when enqueue creates no new jobs", async () => {
    const { service } = fixture.createTestService({ llm: createBatchReflectionLlm([]) });
    const added = addAgentSourceImport(service, namespace, "already queued before wake", "already-queued");
    expect(service.enqueuePendingImportSummaries(10_000, [added.id]).enqueued).toBe(0);
    const run = vi.spyOn(service, "runWorkerOnce");
    const base = await listen(createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000 }));
    expect(run).not.toHaveBeenCalled();
    const response = await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: [added.id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enqueued: 0 });
    await waitFor(() => service.memoryProcessingStatus([added.id], { namespace }).items[0]?.state === "ready", 1_000);
    expect(run).toHaveBeenCalledWith(expect.any(Number), { priorityCohortOnly: true },
      expect.objectContaining({ continuous: true, signal: expect.any(AbortSignal) }));
  });

  it("shares one execution boundary between automatic drain and a manual HTTP worker call", async () => {
    let active = 0, peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const llm = createBatchReflectionLlm([]), complete = llm.completeJson.bind(llm);
    llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
      active++; peak = Math.max(peak, active);
      try { await gate; return await complete<T>(messages, options); }
      finally { active--; }
    };
    const { service, db } = fixture.createTestService({ llm });
    const targets = Array.from({ length: 8 }, (_, i) => addAgentSourceImport(service, namespace,
      `parallel entry ${i}`, `parallel-entry-${i}`).id);
    const run = vi.spyOn(service, "runWorkerOnce");
    const base = await listen(createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000 }));
    let manual: Promise<Response> | undefined;
    try {
      expect((await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: targets })).status).toBe(200);
      await waitFor(() => active === 1);
      manual = post(base, "/api/v1/worker/run", { limit: 4, priorityCohortOnly: true });
      await waitFor(() => run.mock.calls.length >= 2);
      // Both routes entered the real service, but only the active scheduler
      // request can claim. The local provider permits one request; the second entry cannot add another.
      expect(active).toBe(1);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get() as { n: number }).n).toBe(1);
    } finally { release(); }
    expect((await manual!).status).toBe(200);
    await waitFor(() => targets.every(id => service.memoryProcessingStatus([id], { namespace }).items[0]?.state === "ready"));
    expect(peak).toBe(1);
  });

  it("waits for an active automatic drain and its queued manual request when closing", async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const llm = createBatchReflectionLlm([]), complete = llm.completeJson.bind(llm);
    llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
      entered++;
      await gate;
      return complete<T>(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm });
    const targets = Array.from({ length: 8 }, (_, i) => addAgentSourceImport(service, namespace,
      `shutdown entry ${i}`, `shutdown-entry-${i}`).id);
    const run = vi.spyOn(service, "runWorkerOnce");
    const server = createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000 });
    const base = await listen(server);
    let manual: Promise<Response | Error> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: targets });
      await waitFor(() => entered === 1);
      // Closing sockets may reject the client, but accepted server work must
      // still settle before cleanup completes.
      const pending = db.db.prepare("SELECT target_memory_id FROM evolution_jobs WHERE job_type='import_summary' AND status='queued'").all() as Array<{ target_memory_id: string }>;
      manual = post(base, "/api/v1/worker/run", { limit: 4, targetMemoryIds: pending.map(row => row.target_memory_id) }).catch(error => error as Error);
      await waitFor(() => run.mock.calls.length >= 2);
      let closed = false;
      closing = closeMemoryHttpServer(server).then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closed).toBe(false);
      expect(entered).toBe(1);
    } finally { release(); }
    await closing;
    await manual;
    const completedRuns = await Promise.all(run.mock.results.map(result => result.value));
    const automaticIndex = run.mock.calls.findIndex(([, , execution]) => execution?.continuous === true);
    const manualIndex = run.mock.calls.findIndex(([, , execution]) => execution?.continuous !== true);
    expect(automaticIndex).toBeGreaterThanOrEqual(0);
    expect(manualIndex).toBeGreaterThanOrEqual(0);
    // Shutdown cancels further automatic admission. Its sole active local-model
    // task settles, and the already accepted manual request retains budget four.
    const automatic = completedRuns[automaticIndex]!;
    const manualResult = completedRuns[manualIndex]!;
    expect(automatic.leased + automatic.embeddingRetries.leased).toBe(1);
    expect(manualResult.leased + manualResult.embeddingRetries.leased).toBe(4);
    expect(entered).toBeGreaterThan(1);
    const completedSummaries = db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='import_summary' AND status='succeeded'").get() as { n: number };
    expect(completedSummaries.n).toBe(entered);
    // Every admitted execution settles; work not admitted before cancellation
    // or beyond the finite manual budget stays queued without lease history.
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get() as { n: number }).n).toBe(0);
    const waiting = db.db.prepare("SELECT attempts,lease_token FROM evolution_jobs WHERE status='queued'").all();
    expect(waiting.every(row => (row as { attempts: number; lease_token: string | null }).attempts === 0
      && (row as { lease_token: string | null }).lease_token === null)).toBe(true);
  });

  it("retains manual retry wake-up through the same background scheduler", async () => {
    let rejectRequest = true;
    const llm = createBatchReflectionLlm([]), complete = llm.completeJson.bind(llm);
    llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
      if (rejectRequest) throw new Error("unauthorized API key");
      return complete<T>(messages, options);
    };
    const { service } = fixture.createTestService({ llm });
    const added = addAgentSourceImport(service, namespace, "retry from HTTP", "http-manual-retry");
    await service.runWorkerOnce(1);
    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]?.state).toBe("failed");
    rejectRequest = false;
    const base = await listen(createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000 }));
    const response = await post(base, `/api/v1/memory/${added.id}/processing/retry`, { namespace });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    await waitFor(() => service.memoryProcessingStatus([added.id], { namespace }).items[0]?.state === "ready");
  });

  it("does not wake the worker on an unauthenticated enqueue request", async () => {
    const calls: Parameters<typeof createBatchReflectionLlm>[0] = [];
    const { service } = fixture.createTestService({ llm: createBatchReflectionLlm(calls) });
    const added = addAgentSourceImport(service, namespace, "authentication before wake", "authenticated-wake");
    const run = vi.spyOn(service, "runWorkerOnce");
    const base = await listen(createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000,
      auth: { localServiceToken: "entry-test-token" } }));
    expect((await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: [added.id] })).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
    expect((await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: [added.id] }, "entry-test-token")).status).toBe(200);
    await waitFor(() => service.memoryProcessingStatus([added.id], { namespace }).items[0]?.state === "ready");
  });
});
