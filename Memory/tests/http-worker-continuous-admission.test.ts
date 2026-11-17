import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer, type LlmClient, type LlmCompletionOptions, type LlmMessage } from "../src/index.js";
import { closeMemoryHttpServer } from "../src/server/http.js";
import { addAgentSourceImport, createBatchReflectionLlm, createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const servers: Server[] = [];
const namespace = { source: "codex", profileId: "continuous-http", userId: "continuous-http-user" };
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeMemoryHttpServer));
  fixture.cleanup(); vi.restoreAllMocks();
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected local TCP address");
  return `http://127.0.0.1:${address.port}`;
}
async function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function waitFor(check: () => boolean, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for continuous worker progress");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function controlledCloudLlm(): LlmClient {
  const base = createBatchReflectionLlm([], "Controlled cloud summary");
  return {
    ...base,
    config: { ...base.config, provider: "openai_compatible", endpoint: "https://controlled-cloud.invalid/v1", model: "controlled-cloud-model" },
    status: () => ({ provider: "openai_compatible", model: "controlled-cloud-model", configured: true, remote: true })
  };
}

// Actual HTTP auto scheduling, MemoryService, SQLite and default provider caps.
// The model is an in-process substitute: no network model or desktop data.
describe("HTTP automatic continuous admission", () => {
  it("continues after fast imports and embedding finish while the first cloud summary is still slow", async () => {
    const gate = deferred(), context = new AsyncLocalStorage<string>();
    const llm = controlledCloudLlm(), complete = llm.completeJson.bind(llm);
    let slowId = "", active = 0, peak = 0, maximumLeased = 0;
    const summaryStarted: string[] = [];
    llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
      active++; peak = Math.max(peak, active);
      try { if (context.getStore() === slowId) await gate.promise; return await complete<T>(messages, options); }
      finally { active--; }
    };
    const { service, db } = fixture.createTestService({ llm, skillLlm: llm });
    const targets = Array.from({ length: 8 }, (_, i) => addAgentSourceImport(service, namespace, `cloud import ${i}`, `continuous-cloud-${i}`).id);
    slowId = targets[0]!;
    const internal = service as unknown as { workerRunner: { deps: { jobHandlers: { processJob: (job: { jobType: string; targetMemoryId?: string }) => Promise<void> } } } };
    const handlers = internal.workerRunner.deps.jobHandlers, original = handlers.processJob.bind(handlers);
    handlers.processJob = job => {
      if (job.jobType === "import_summary") summaryStarted.push(job.targetMemoryId!);
      const leased = (db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get() as { n: number }).n;
      maximumLeased = Math.max(maximumLeased, leased);
      return context.run(job.targetMemoryId ?? "", () => original(job));
    };
    const base = await listen(createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000 }));
    try {
      expect((await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: targets })).status).toBe(200);
      await waitFor(() => summaryStarted.includes(targets[4]!));
      expect(service.memoryProcessingStatus([slowId], { namespace }).items[0]?.state).toBe("summarizing");
      expect(active).toBeGreaterThanOrEqual(1);
      expect(peak).toBe(2);
      expect(maximumLeased).toBeLessThanOrEqual(4);
    } finally { gate.resolve(); }
    await waitFor(() => targets.every(id => service.memoryProcessingStatus([id], { namespace }).items[0]?.state === "ready"));
  });

  it("preserves the manual HTTP budget and target filter without turning it into an automatic drain", async () => {
    const { service, db } = fixture.createTestService({ llm: controlledCloudLlm() });
    const targets = Array.from({ length: 3 }, (_, i) => addAgentSourceImport(service, namespace, `manual target ${i}`, `manual-bound-${i}`).id);
    const base = await listen(createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000 }));
    const response = await post(base, "/api/v1/worker/run", { limit: 1, targetMemoryIds: [targets[1]] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ leased: 1, succeeded: 1, embeddingRetries: { leased: 0 } });
    const rows = db.db.prepare("SELECT target_memory_id,status,attempts FROM evolution_jobs WHERE job_type='import_summary' ORDER BY enqueue_seq").all();
    expect(rows).toEqual([
      { target_memory_id: targets[0], status: "queued", attempts: 0 },
      { target_memory_id: targets[1], status: "succeeded", attempts: 1 },
      { target_memory_id: targets[2], status: "queued", attempts: 0 }
    ]);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get() as { n: number }).n).toBe(0);
  });

  it("stops automatic admission on HTTP shutdown while allowing admitted cloud requests to finish", async () => {
    const gate = deferred(), llm = controlledCloudLlm(), complete = llm.completeJson.bind(llm);
    let active = 0;
    llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
      active++;
      try { await gate.promise; return await complete<T>(messages, options); } finally { active--; }
    };
    const { service, db } = fixture.createTestService({ llm, skillLlm: llm });
    const targets = Array.from({ length: 3 }, (_, i) => addAgentSourceImport(service, namespace, `shutdown import ${i}`, `continuous-stop-${i}`).id);
    const server = createMemoryHttpServer({ service, workerStartupFallbackMs: 60_000 });
    const base = await listen(server);
    let closed = false, closing: Promise<void> | undefined;
    try {
      await post(base, "/api/v1/worker/import-summaries/enqueue", { memoryIds: targets });
      await waitFor(() => active === 2);
      closing = closeMemoryHttpServer(server).then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(closed).toBe(false);
    } finally { gate.resolve(); await closing; }
    expect(closed).toBe(true);
    expect(active).toBe(0);
    const rows = db.db.prepare("SELECT status,attempts,lease_token FROM evolution_jobs WHERE job_type='import_summary' ORDER BY enqueue_seq").all();
    expect(rows).toEqual([
      { status: "succeeded", attempts: 1, lease_token: null },
      { status: "succeeded", attempts: 1, lease_token: null },
      { status: "queued", attempts: 0, lease_token: null }
    ]);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get() as { n: number }).n).toBe(0);
  });
});
