import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../src/config/index.js";
import { MemoryModelTaskRouter, type MemoryModelTaskContext } from "../src/model/task-routing.js";
import { WorkerConcurrencyController, providerDescriptor } from "../src/service/worker/worker-concurrency.js";
import type { Embedder, LlmClient } from "../src/model/types.js";
import { Repositories } from "../src/storage/repositories.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

function context(embed: Embedder["embed"]): MemoryModelTaskContext {
  const llm: LlmClient = {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "openai_compatible", endpoint: "https://isolated.test/v1", model: "summary" },
    isConfigured: () => true, complete: async () => "unused",
    completeJson: async <T extends Record<string, unknown>>() => ({}) as T,
    status: () => ({ provider: "openai_compatible", model: "summary", configured: true, remote: true })
  };
  const embedding: Embedder = {
    config: { ...DEFAULT_MEMMY_CONFIG.embedding, provider: "openai_compatible", mode: "custom",
      endpoint: "https://isolated.test/v1", model: "embedding", cache: false },
    isRemote: () => true, embed,
    embedOne: async (text, role) => (await embed([text], role))[0]!,
    status: () => ({ provider: "openai_compatible", model: "embedding", configured: true, remote: true })
  };
  return { config: DEFAULT_MEMMY_CONFIG, summary: llm, evolution: llm, embedding };
}

describe("routed embedding request batches", () => {
  it.each(["query", "document", undefined] as const)("caps every request at 16 and preserves %s role and vector order", async role => {
    const calls: Array<{ texts: string[]; role?: string }> = [];
    let active = 0, peak = 0;
    const task = context(async (texts, requestRole) => {
      calls.push({ texts: [...texts], role: requestRole }); peak = Math.max(peak, ++active);
      await new Promise<void>(resolve => setImmediate(resolve)); active--;
      return texts.map(text => [Number(text)]);
    });
    const controller = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => task, controller);
    try {
      expect(await router.embedder().embed(Array.from({ length: 37 }, (_, i) => String(i)), role))
        .toEqual(Array.from({ length: 37 }, (_, i) => [i]));
      expect(calls.map(call => call.texts.length)).toEqual([16, 16, 5]);
      expect(calls.map(call => call.role)).toEqual([role, role, role]);
      expect(peak).toBe(1);
      expect(controller.snapshot()).toMatchObject({ activeJobs: 0, providers: {}, embeddingRequests: 0 });
    } finally { await Promise.all([router.stop(), controller.close()]); }
  });

  it("honors a configured batch limit without charging text count as worker jobs", async () => {
    const sizes: number[] = [], logical: number[] = [];
    const controller = new WorkerConcurrencyController({ embeddingBatchSize: 3 }, {});
    const task = context(async texts => {
      sizes.push(texts.length); logical.push(controller.snapshot().activeJobs);
      return texts.map(text => [Number(text)]);
    });
    const router = new MemoryModelTaskRouter(() => task, controller);
    const permit = controller.tryAcquire({ resourceClass: "summary", embedding: true,
      providers: providerDescriptor(task.embedding.config, controller.limits).providers, scopeKeys: [] })!;
    try {
      expect(await permit.run(() => router.runWith(task, () => router.embedder().embed(["0", "1", "2", "3", "4", "5", "6"], "query"))))
        .toEqual([[0], [1], [2], [3], [4], [5], [6]]);
      expect(sizes).toEqual([3, 3, 1]); expect(logical).toEqual([1, 1, 1]);
    } finally { permit.release(); await Promise.all([router.stop(), controller.close()]); }
  });

  it("does not call a provider for empty input", async () => {
    let calls = 0;
    const task = context(async () => { calls++; return []; });
    const controller = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => task, controller);
    try { expect(await router.embedder().embed([], "document")).toEqual([]); expect(calls).toBe(0); }
    finally { await Promise.all([router.stop(), controller.close()]); }
  });

  it("stops before later slices after an error and releases request permits", async () => {
    const sizes: number[] = [];
    const task = context(async texts => {
      sizes.push(texts.length);
      if (sizes.length === 2) throw new Error("isolated second batch failure");
      return texts.map(() => [1]);
    });
    const controller = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => task, controller);
    try {
      await expect(router.embedder().embed(Array.from({ length: 37 }, (_, i) => String(i))))
        .rejects.toThrow("isolated second batch failure");
      expect(sizes).toEqual([16, 16]);
      expect(controller.snapshot()).toMatchObject({ activeJobs: 0, providers: {}, embeddingRequests: 0 });
    } finally { await Promise.all([router.stop(), controller.close()]); }
  });

  it("shares the single request limit across simultaneous business calls and their slices", async () => {
    let active = 0, peak = 0;
    const sizes: number[] = [];
    const task = context(async texts => {
      peak = Math.max(peak, ++active); sizes.push(texts.length);
      await new Promise<void>(resolve => setImmediate(resolve)); active--;
      return texts.map(text => [Number(text)]);
    });
    const controller = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => task, controller);
    try {
      const input = Array.from({ length: 33 }, (_, i) => String(i));
      const results = await Promise.all([router.embedder().embed(input, "query"), router.embedder().embed(input, "document")]);
      for (const vectors of results) expect(vectors).toEqual(input.map(text => [Number(text)]));
      expect(sizes).toHaveLength(6); expect(Math.max(...sizes)).toBe(16); expect(peak).toBe(1);
    } finally { await Promise.all([router.stop(), controller.close()]); }
  });

  it("batches actual Work Memory candidate retrieval while running one logical worker job", async () => {
    const sizes: number[] = [], roles: unknown[] = [], logical: number[] = [];
    const concurrency = new WorkerConcurrencyController({}, {});
    const task = context(async (texts, role) => {
      sizes.push(texts.length); roles.push(role); logical.push(concurrency.snapshot().activeJobs);
      return texts.map(() => [1, 0, 0]);
    });
    task.summary.completeJson = async <T extends Record<string, unknown>>(_messages: unknown, options: { operation: string }) => {
      if (options.operation === "capture.work_memory_extract") return { work_memories: Array.from({ length: 37 }, (_, i) => ({
        requirement: `Requirement ${i}`, reason: `Reproducibility reason ${i}` })) } as unknown as T;
      if (options.operation === "capture.work_memory_merge") return { decisions: Array.from({ length: 37 }, (_, i) => ({
        candidate_ref: `new_${i + 1}`, action: "create", matched_memory_ref: null, work_topic: `Topic ${i}` })) } as unknown as T;
      throw new Error(`Unexpected test LLM operation ${options.operation}`);
    };
    const config = structuredClone(DEFAULT_MEMMY_CONFIG); config.algorithm.capture.embedAfterCapture = false;
    const { service, db } = fixture.createTestService({ config, llm: task.summary, skillLlm: task.summary,
      embedder: task.embedding, concurrency });
    const namespace = { source: "codex", profileId: "default", userId: "isolated-work-memory-batch", sessionKey: "batch-session" };
    const opened = service.openSession({ namespace, l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/isolated-work-memory-batch", workspaceHostId: "a".repeat(64) });
    const completed = service.completeTurn("batch-turn", { sessionId: opened.sessionId,
      query: "Use the reproducible build pipeline.", answer: "The build pipeline is documented." });
    service.l3WorldModelBoundary(opened.sessionId, { requestId: "isolated-batch-boundary", adapterId: "codex-memory", source: "codex",
      namespace: { ...namespace, projectId: opened.projectId ?? undefined }, trigger: "token_compaction", throughL1MemoryId: completed.l1MemoryId });
    db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE job_type != 'work_memory_extract'").run();
    const result = await service.runWorkerOnce(1);
    expect(result).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(result.jobs[0]?.jobType).toBe("work_memory_extract");
    expect(sizes).toEqual([16, 16, 5]); expect(roles).toEqual(["query", "query", "query"]);
    expect(logical).toEqual([1, 1, 1]);
    const repos = new Repositories(db.db);
    expect(repos.memories.list({ memoryLayer: "L1", memoryKind: "work_memory" }, 100)).toHaveLength(37);
    expect(concurrency.snapshot()).toMatchObject({ activeJobs: 0, providers: {}, embeddingRequests: 0 });
  });
});
