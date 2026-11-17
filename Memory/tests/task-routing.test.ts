import { describe, expect, it } from "vitest";
import { MemoryModelTaskRouter, type MemoryModelTaskContext } from "../src/model/task-routing.js";
import { WorkerConcurrencyController, providerDescriptor } from "../src/service/worker/worker-concurrency.js";
import type { Embedder, LlmClient, LlmCompletionOptions, LlmMessage } from "../src/model/types.js";

function client(name: string): LlmClient {
  return {
    config: {
      provider: "openai_compatible",
      endpoint: "https://example.test/v1",
      model: name,
      apiKey: "test-key",
      sourceProvider: name,
      enableThinking: false,
      temperature: 0.7,
      timeoutMs: 1_000,
      maxRetries: 0,
      malformedRetries: 0
    },
    isConfigured: () => true,
    complete: async (_messages: LlmMessage[], _options: LlmCompletionOptions) => name,
    completeJson: async <T extends Record<string, unknown>>() => ({ name }) as unknown as T,
    status: () => ({
      provider: "openai_compatible",
      model: name,
      configured: true,
      remote: true,
      routing: null
    })
  };
}

function context(name: string): MemoryModelTaskContext {
  return {
    config: { marker: name } as unknown as MemoryModelTaskContext["config"],
    summary: client(`${name}-summary`),
    evolution: client(`${name}-evolution`),
    embedding: embedder(`${name}-embedding`)
  };
}

function embedder(name: string): Embedder {
  return {
    config: {
      provider: "openai_compatible",
      mode: "custom",
      endpoint: "https://example.test/v1",
      model: name,
      apiKey: "test-key",
      batchSize: 10,
      timeoutMs: 1_000,
      maxRetries: 0,
      cache: false,
      normalize: false
    },
    isRemote: () => true,
    embed: async () => [[name.length]],
    embedOne: async () => [name.length],
    status: () => ({
      provider: "openai_compatible",
      model: name,
      configured: true,
      remote: true
    })
  };
}

describe("MemoryModelTaskRouter", () => {
  it.each(["foreground", "worker"] as const)("distinguishes new foreground business from a released %s request callback", async kind => {
    const c = new WorkerConcurrencyController({}, {});
    const task = context("callback");
    const router = new MemoryModelTaskRouter(() => task, c);
    let finish!: (result: { value?: string; error?: unknown }) => void;
    const callback = new Promise<{ value?: string; error?: unknown }>(resolve => { finish = resolve; });
    let calls = 0;
    task.summary.complete = async () => {
      calls++;
      if (calls === 1) setImmediate(() => {
        void router.client("summary").complete([], { operation: "test.new-business" })
          .then(value => finish({ value }), error => finish({ error }));
      });
      return `call-${calls}`;
    };
    const first = () => router.client("summary").complete([], { operation: "test.original" });
    const permit = kind === "worker" ? c.tryAcquire({ resourceClass: "summary",
      providers: providerDescriptor(task.summary.config, c.limits).providers, scopeKeys: [] })! : undefined;
    try {
      expect(await (permit ? permit.run(() => router.runWith(task, first)) : router.run(first))).toBe("call-1");
      permit?.release();
      const result = await callback;
      if (kind === "foreground") {
        expect(result.error).toBeUndefined(); expect(result.value).toBe("call-2"); expect(calls).toBe(2);
      } else {
        // A late callback from a finished worker remains fenced; it cannot turn
        // itself into an unleased foreground model request after token release.
        expect(result.error).toBeInstanceOf(Error); expect(calls).toBe(1);
      }
      expect(c.snapshot()).toMatchObject({ activeJobs: 0, providers: {}, embeddingRequests: 0 });
    } finally { permit?.release(); await Promise.all([router.stop(), c.close()]); }
  });

  it("allows shutdown from an inherited callback after its foreground task completed", async () => {
    const router = new MemoryModelTaskRouter(() => context("completed"));
    let continueCallback!: () => void;
    const gate = new Promise<void>(resolve => { continueCallback = resolve; });
    let completeCallback!: () => void, rejectCallback!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => { completeCallback = resolve; rejectCallback = reject; });
    await router.run(async () => {
      setImmediate(() => {
        void (async () => { await gate; await router.stop(); })().then(completeCallback, rejectCallback);
      });
    });
    continueCallback();
    await expect(completed).resolves.toBeUndefined();
  });

  it("rejects new work from an inherited completed-task callback after shutdown", async () => {
    const router = new MemoryModelTaskRouter(() => context("completed"));
    let continueCallback!: () => void;
    const gate = new Promise<void>(resolve => { continueCallback = resolve; });
    let completeCallback!: (error: unknown) => void;
    const completed = new Promise<unknown>(resolve => { completeCallback = resolve; });
    let invoked = false;
    await router.run(async () => {
      setImmediate(() => {
        void (async () => {
          await gate;
          try { router.run(() => { invoked = true; }); completeCallback(undefined); }
          catch (error) { completeCallback(error); }
        })();
      });
    });
    await router.stop(); continueCallback();
    expect(await completed).toBeInstanceOf(Error);
    expect(invoked).toBe(false);
  });

  it("waits for complete business tasks after model responses while stopping new foreground tasks", async () => {
    const router = new MemoryModelTaskRouter(() => context("closing"));
    let response!: () => void, processed!: () => void;
    const responseGate = new Promise<void>(resolve => { response = resolve; });
    const processingGate = new Promise<void>(resolve => { processed = resolve; });
    let postRequestWrite = false, stopped = false;
    const business = router.run(async () => { await responseGate; await processingGate; postRequestWrite = true; });
    const stop = router.stop().then(() => { stopped = true; });
    response(); await Promise.resolve();
    expect(stopped).toBe(false); expect(postRequestWrite).toBe(false);
    expect(() => router.run(() => "new task")).toThrow(/clos|stop/i);
    processed(); await Promise.all([business, stop]);
    expect(postRequestWrite).toBe(true); expect(stopped).toBe(true);
  });

  it("allows an already admitted worker to enter its queued snapshot after router shutdown begins", async () => {
    const c = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => context("claimed"), c);
    const snapshot = router.snapshot();
    const p = c.tryAcquire({ resourceClass: "summary", providers: providerDescriptor(snapshot.summary.config, c.limits).providers, scopeKeys: [] })!;
    await router.stop(); const close = c.close();
    expect(await p.run(() => router.runWith(snapshot, () => router.client("summary").complete([], { operation: "finish" })))).toBe("claimed-summary");
    p.release(); await close;
  });

  it("runs the admission snapshot after configuration reload without resolving a new provider", async () => {
    let current = context("admitted"), resolutions = 0;
    const controller = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => { resolutions++; return current; }, controller);
    const snapshot = router.snapshot();
    const providers = [snapshot.summary, snapshot.evolution].flatMap(delegate => providerDescriptor(delegate.config, controller.limits).providers);
    const permit = controller.tryAcquire({ resourceClass: "summary", providers, scopeKeys: [] })!;
    current = context("reloaded");
    try {
      const result = await permit.run(() => router.runWith(snapshot, async () => [
        await router.client("summary").complete([], { operation: "test" }),
        await router.client("evolution").complete([], { operation: "test" })
      ]));
      expect(result).toEqual(["admitted-summary", "admitted-evolution"]);
      expect(resolutions).toBe(1); expect(Object.isFrozen(snapshot)).toBe(true);
    } finally { permit.release(); }
  });

  it("guards real routed calls to distinct models sharing a local endpoint", async () => {
    const task = context("shared");
    const controller = new WorkerConcurrencyController({}, {});
    let active = 0, maximum = 0;
    for (const delegate of [task.summary, task.evolution]) {
      delegate.config.endpoint = "http://localhost:1234/v1";
      delegate.complete = async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>(resolve => setImmediate(resolve));
        active--; return "ok";
      };
    }
    const router = new MemoryModelTaskRouter(() => task, controller);
    const providers = [task.summary, task.evolution].flatMap(delegate => providerDescriptor(delegate.config, controller.limits).providers);
    const permit = controller.tryAcquire({ resourceClass: "summary", providers, scopeKeys: [] })!;
    try {
      await permit.run(() => router.runWith(task, () => Promise.all([
        router.client("summary").complete([], { operation: "one" }),
        router.client("evolution").complete([], { operation: "two" })
      ])));
      expect(maximum).toBe(1);
    } finally { permit.release(); }
  });

  it("keeps one immutable model snapshot across all LLM calls in a task", async () => {
    let resolutions = 0;
    const router = new MemoryModelTaskRouter(() => context(`task-${++resolutions}`));
    const summary = router.client("summary");
    const evolution = router.client("evolution");
    const embedding = router.embedder();

    const result = await router.run(async () => {
      const first = await summary.complete([], { operation: "test.summary" });
      await Promise.resolve();
      const second = await evolution.complete([], { operation: "test.evolution" });
      const third = embedding.config.model;
      return [first, second, third];
    });

    expect(result).toEqual(["task-1-summary", "task-1-evolution", "task-1-embedding"]);
    expect(resolutions).toBe(1);
  });

  it("isolates concurrent tasks even when their asynchronous work interleaves", async () => {
    let resolutions = 0;
    const router = new MemoryModelTaskRouter(() => context(`task-${++resolutions}`));
    const summary = router.client("summary");
    const evolution = router.client("evolution");
    const embedding = router.embedder();
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = router.run(async () => {
      const before = await summary.complete([], { operation: "test.summary.first" });
      await firstPaused;
      const after = await evolution.complete([], { operation: "test.evolution.first" });
      return [before, after, embedding.config.model];
    });
    const second = router.run(async () => {
      const before = await summary.complete([], { operation: "test.summary.second" });
      const after = await evolution.complete([], { operation: "test.evolution.second" });
      releaseFirst();
      return [before, after, embedding.config.model];
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      ["task-1-summary", "task-1-evolution", "task-1-embedding"],
      ["task-2-summary", "task-2-evolution", "task-2-embedding"]
    ]);
    expect(resolutions).toBe(2);
  });
});
