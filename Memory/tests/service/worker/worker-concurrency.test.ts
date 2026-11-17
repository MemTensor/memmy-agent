import { describe, expect, it } from "vitest";
import { WorkerConcurrencyController, providerDescriptor, workerModelBatchKey, type WorkerRequirements } from "../../../src/service/worker/worker-concurrency.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { createLlmClient } from "../../../src/model/llm.js";
import { createEmbedder } from "../../../src/model/embedder.js";
import { MemoryModelTaskRouter } from "../../../src/model/task-routing.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";
const req = (changes: Partial<WorkerRequirements> = {}): WorkerRequirements => ({ resourceClass: "summary", providers: [], scopeKeys: [], ...changes });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
describe("atomic worker admission and real model requests", () => {
  it("shares the Mistral service root across native embeddings and compatible chat without merging other bases", () => {
    const chat = providerDescriptor({ provider: "openai_compatible", endpoint: "https://api.mistral.ai/v1", model: "chat" });
    const native = providerDescriptor({ provider: "mistral", model: "mistral-embed" });
    const explicit = providerDescriptor({ provider: "mistral", endpoint: "https://api.mistral.ai/v1/embeddings", model: "mistral-embed" });
    expect(native.providers[0]).toEqual(chat.providers[0]);
    expect(explicit.providers[0]).toEqual(chat.providers[0]);
    expect(native.providers[1]!.key).not.toBe(chat.providers[1]!.key);
    const custom = providerDescriptor({ provider: "mistral", endpoint: "https://proxy.example.test/tenant/v1/embeddings" });
    expect(custom.providers[0]).toEqual(providerDescriptor({ provider: "openai_compatible", endpoint: "https://proxy.example.test/tenant/v1" }).providers[0]);
    expect(custom.providers[0]).not.toEqual(chat.providers[0]);
    expect(custom.providers[0]).not.toEqual(providerDescriptor({ provider: "openai_compatible", endpoint: "https://proxy.example.test/other/v1" }).providers[0]);
  });

  it.each([undefined, "https://api.mistral.ai/v1/embeddings"])("caps real Mistral chat and native embedding calls together (embedding endpoint %s)", async endpoint => {
    const summary = createLlmClient({ ...DEFAULT_MEMMY_CONFIG.summary, provider: "openai_compatible",
      sourceProvider: "mistral", endpoint: "https://api.mistral.ai/v1", model: "mistral-small-latest",
      apiKey: "synthetic-test-key", maxRetries: 0, malformedRetries: 0 });
    const embedding = createEmbedder({ ...DEFAULT_MEMMY_CONFIG.embedding, provider: "mistral", mode: "custom",
      endpoint, model: "mistral-embed", apiKey: "synthetic-test-key", maxRetries: 0, cache: false });
    const c = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => ({ config: DEFAULT_MEMMY_CONFIG, summary, evolution: summary, embedding }), c);
    let active = 0, maximum = 0;
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => {
      const url = String(input);
      urls.push(url); maximum = Math.max(maximum, ++active);
      await tick(); active--;
      const response = url.endsWith("/embeddings") ? { data: [{ embedding: [1, 0, 0] }] }
        : { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await Promise.all([
        router.client("summary").complete([{ role: "user", content: "first" }], { operation: "test.provider-limit" }),
        router.client("summary").complete([{ role: "user", content: "second" }], { operation: "test.provider-limit" }),
        router.embedder().embed(["document"])
      ]);
      expect(urls.filter(url => url === "https://api.mistral.ai/v1/chat/completions")).toHaveLength(2);
      expect(urls.filter(url => url === "https://api.mistral.ai/v1/embeddings")).toHaveLength(1);
      expect(maximum).toBe(c.limits.cloudModelConcurrency);
      expect(c.snapshot()).toMatchObject({ providers: {}, embeddingRequests: 0 });
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([router.stop(), c.close()]);
    }
  });

  it("shares Anthropic admission for equivalent actual request URLs", () => {
    const missing = providerDescriptor({ provider: "anthropic", model: "same" });
    const bare = providerDescriptor({ provider: "anthropic", model: "same", endpoint: "https://api.anthropic.com" });
    const full = providerDescriptor({ provider: "anthropic", model: "same", endpoint: "https://api.anthropic.com/v1/messages" });
    expect(missing.providers).toEqual(bare.providers);
    expect(missing.providers).toEqual(full.providers);
    // HttpLlmClient appends /v1/messages unless already present. A /v1
    // endpoint therefore really sends /v1/v1/messages and must stay distinct.
    expect(providerDescriptor({ provider: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "same" }).providers)
      .not.toEqual(missing.providers);
  });

  it("caps real Anthropic calls across default and explicit base endpoints at cloud concurrency", async () => {
    const config = { ...DEFAULT_MEMMY_CONFIG.summary, provider: "anthropic" as const,
      model: "claude-3-haiku-20240307", apiKey: "synthetic-test-key", maxRetries: 0, malformedRetries: 0 };
    const summary = createLlmClient({ ...config, endpoint: undefined });
    const evolution = createLlmClient({ ...config, endpoint: "https://api.anthropic.com" });
    const c = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => ({ config: DEFAULT_MEMMY_CONFIG, summary, evolution,
      embedding: createCapturingEmbedder([]) }), c);
    let active = 0, maximum = 0;
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => {
      urls.push(String(input)); maximum = Math.max(maximum, ++active);
      await tick(); active--;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await Promise.all((["summary", "evolution", "summary", "evolution"] as const).map(role =>
        router.client(role).complete([{ role: "user", content: "test" }], { operation: "test.provider-limit", maxTokens: 64 })));
      expect([...new Set(urls)]).toEqual(["https://api.anthropic.com/v1/messages"]);
      expect(maximum).toBe(c.limits.cloudModelConcurrency);
      expect(c.snapshot().providers).toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([router.stop(), c.close()]);
    }
  });

  it("separates batches after credential/header reload without exposing secret values", () => {
    const first = { endpoint: "https://example.test/v1", model: "same", apiKey: "private-key-one",
      extraHeaders: { Authorization: "Bearer private-header-one", "X-Account": "first" }, extraBody: { nested: { beta: 2, alpha: 1 } } };
    const hash = workerModelBatchKey([first]);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("private");
    expect(workerModelBatchKey([{ ...first, apiKey: "private-key-two" }])).not.toBe(hash);
    expect(workerModelBatchKey([{ ...first, extraHeaders: { ...first.extraHeaders, Authorization: "Bearer private-header-two" } }])).not.toBe(hash);
    expect(workerModelBatchKey([{ ...first, extraBody: { nested: { alpha: 1, beta: 3 } } }])).not.toBe(hash);
    expect(workerModelBatchKey([{ ...first, extraBody: { nested: { alpha: 1, beta: 2 } } }])).toBe(hash);
  });
  it("hashes complete credentials/configuration without length or entry truncation", () => {
    const prefix = "x".repeat(25_000);
    expect(workerModelBatchKey([{ apiKey: `${prefix}a` }])).not.toBe(workerModelBatchKey([{ apiKey: `${prefix}b` }]));
    const headers = Object.fromEntries(Array.from({ length: 1_100 }, (_, index) => [`key-${index}`, "same"]));
    expect(workerModelBatchKey([{ extraHeaders: headers }])).not.toBe(workerModelBatchKey([{ extraHeaders: { ...headers, "key-1099": "changed" } }]));
  });
  it("never holds partial resources when provider, scope, resource or global admission fails", () => {
    const c = new WorkerConcurrencyController({}, {});
    const first = c.tryAcquire(req({ providers: [{ key: "root", limit: 1 }], scopeKeys: ["a"] }))!;
    expect(c.tryAcquire(req({ providers: [{ key: "other", limit: 1 }, { key: "root", limit: 1 }], scopeKeys: ["b"] }))).toBeUndefined();
    expect(c.availableJobs()).toBe(3); expect(c.snapshot().providers).toEqual({ root: 1 });
    expect(c.tryAcquire(req({ scopeKeys: ["a"] }))).toBeUndefined();
    const other = c.tryAcquire(req({ providers: [{ key: "other", limit: 1 }], scopeKeys: ["b"] }))!;
    first.release(); first.release(); other.release();
    expect(c.availableJobs()).toBe(4); expect(c.snapshot().activeJobs).toBe(0);
  });
  it("counts logical microbatch members independently while sharing one provider/request reservation", () => {
    const c = new WorkerConcurrencyController({}, {});
    const r = req({ resourceClass: "embedding", embedding: true, providers: [{ key: "root", limit: 1 }] });
    const a = c.tryAcquire({ ...r, scopeKeys: ["a"] })!;
    const b = c.tryAcquire({ ...r, scopeKeys: ["b"] }, 1, a)!;
    expect(c.snapshot()).toMatchObject({ activeJobs: 2, embeddingRequests: 1, providers: { root: 1 } });
    a.release(); a.release();
    expect(c.snapshot()).toMatchObject({ activeJobs: 1, embeddingRequests: 1, providers: { root: 1 } });
    expect(c.tryAcquire(r)).toBeUndefined();
    b.release(); expect(c.snapshot()).toMatchObject({ activeJobs: 0, embeddingRequests: 0, providers: {} });
    expect(c.limits.embeddingBatchSize).toBe(16);
  });
  it("rejects sharing other resources/providers or released permits without consuming anything", () => {
    const c = new WorkerConcurrencyController({}, {});
    const r = req({ resourceClass: "embedding", embedding: true, providers: [{ key: "root", limit: 1 }] });
    const p = c.tryAcquire(r)!;
    expect(c.tryAcquire({ ...r, resourceClass: "summary" }, 1, p)).toBeUndefined();
    expect(c.tryAcquire({ ...r, providers: [{ key: "another", limit: 1 }] }, 1, p)).toBeUndefined();
    p.release(); expect(c.tryAcquire(r, 1, p)).toBeUndefined(); expect(c.availableJobs()).toBe(4);
  });
  it("enforces resource and global job limits before a request starts", () => {
    const c = new WorkerConcurrencyController({ resourceLimits: { summary: 1 } }, {});
    const p = c.tryAcquire(req())!;
    expect(c.tryAcquire(req())).toBeUndefined();
    const other = c.tryAcquire(req({ resourceClass: "embedding", queueLane: "interactive" }), 3)!;
    expect(c.availableJobs()).toBe(0); expect(c.tryAcquire(req({ resourceClass: "database" }))).toBeUndefined();
    p.release(); other.release();
  });
  it.each([0, -1, 1.2, NaN, Infinity, 1025])("rejects invalid limits %s", value => {
    expect(() => new WorkerConcurrencyController({ maxActiveJobs: value }, {})).toThrow();
  });
  it("rejects bad environment JSON, unknown resources and invalid provider limits", () => {
    expect(() => new WorkerConcurrencyController({}, { MEMMY_WORKER_RESOURCE_LIMITS: "invalid" })).toThrow();
    expect(() => new WorkerConcurrencyController({}, { MEMMY_WORKER_MAX_ACTIVE_JOBS: "2x" })).toThrow();
    expect(() => new WorkerConcurrencyController({ resourceLimits: { unknown: 1 } as never }, {})).toThrow();
    expect(new WorkerConcurrencyController({}, { MEMMY_WORKER_CLOUD_MODEL_CONCURRENCY: "3" }).limits.cloudModelConcurrency).toBe(3);
    expect(() => new WorkerConcurrencyController({}, {}).tryAcquire(req({ providers: [{ key: "p", limit: 0 }] }))).toThrow();
  });
  it("uses a common local root across models and omits endpoint credentials from identities", () => {
    const c = new WorkerConcurrencyController({}, {});
    const a = providerDescriptor({ provider: "openai_compatible", sourceProvider: "lmstudio", endpoint: "http://user:secret@localhost:1234/v1?api_key=secret", model: "a" }, c.limits);
    const b = providerDescriptor({ provider: "openai_compatible", sourceProvider: "another-label", endpoint: "http://127.0.0.1:1234/v1/", model: "b" }, c.limits);
    expect(a.providers[0]).toEqual(b.providers[0]); expect(a.providers[0]!.limit).toBe(1);
    expect(a.providers[1]!.key).not.toBe(b.providers[1]!.key); expect(JSON.stringify(a)).not.toContain("secret");
    expect(providerDescriptor({ provider: "openai_compatible", endpoint: "https://api.example.test/v1", model: "a" }, c.limits).providers[0]!.limit).toBe(2);
  });
  it("resolves real default endpoints and normalizes explicit model operation paths", () => {
    const defaulted = providerDescriptor({ provider: "openai_compatible", sourceProvider: "openai", model: "a" });
    const explicit = providerDescriptor({ provider: "openai_compatible", endpoint: "https://api.openai.com/v1/embeddings", model: "b" });
    const chat = providerDescriptor({ provider: "openai_compatible", endpoint: "https://api.openai.com/v1/chat/completions", model: "c" });
    expect(defaulted.providers[0]).toEqual(explicit.providers[0]);
    expect(defaulted.providers[0]).toEqual(chat.providers[0]);
    const account = providerDescriptor({ provider: "openai_compatible", endpoint: "http://localhost:19000/proxy", model: "cloud", actualModelContext: { source: "account" } });
    expect(account.local).toBe(false); expect(account.providers[0]!.limit).toBe(2);
  });
  it("serializes actual parallel calls inside a reserved provider without reacquiring its own slot", async () => {
    const c = new WorkerConcurrencyController({}, {}), d = providerDescriptor({ provider: "local", model: "a" });
    const p = c.tryAcquire(req({ providers: d.providers }))!;
    let active = 0, maximum = 0;
    const invoke = () => c.runRequest(d, async () => { maximum = Math.max(maximum, ++active); await tick(); active--; return 7; });
    expect(await p.run(() => Promise.all([invoke(), invoke(), invoke()]))).toEqual([7, 7, 7]);
    expect(maximum).toBe(1); expect(c.snapshot().activeJobs).toBe(1); p.release();
  });
  it("shares internal serialization between embedding group members", async () => {
    const c = new WorkerConcurrencyController({}, {}), d = providerDescriptor({ provider: "local", model: "a" });
    const r = req({ resourceClass: "embedding", providers: d.providers, embedding: true });
    const a = c.tryAcquire(r)!, b = c.tryAcquire(r, 1, a)!;
    let active = 0, maximum = 0;
    const invoke = () => c.runRequest(d, async () => { maximum = Math.max(maximum, ++active); await tick(); active--; }, true);
    await Promise.all([a.run(invoke), b.run(invoke)]); expect(maximum).toBe(1); a.release(); b.release();
  });
  it("caps actual non-worker embedding requests and releases on rejection without taking logical job slots", async () => {
    const c = new WorkerConcurrencyController({}, {}), d = providerDescriptor({ provider: "openai_compatible", endpoint: "https://example.test", model: "e" });
    let active = 0, maximum = 0;
    const invoke = () => c.runRequest(d, async () => { maximum = Math.max(maximum, ++active); await tick(); active--; }, true);
    await Promise.all([invoke(), invoke(), invoke()]); expect(maximum).toBe(1);
    await expect(c.runRequest(d, async () => { throw new Error("remote failed"); }, true)).rejects.toThrow("remote failed");
    expect(c.snapshot()).toMatchObject({ activeJobs: 0, embeddingRequests: 0, providers: {} });
  });
  it("permits exactly two actual cloud requests across independent tasks", async () => {
    const c = new WorkerConcurrencyController({}, {}), d = providerDescriptor({ provider: "openai_compatible", endpoint: "https://example.test", model: "chat" });
    let active = 0, maximum = 0;
    const invoke = () => c.runRequest(d, async () => { maximum = Math.max(maximum, ++active); await tick(); active--; });
    await Promise.all([invoke(), invoke(), invoke(), invoke()]);
    expect(maximum).toBe(2); expect(c.snapshot().providers).toEqual({});
  });
  it("refuses a model that was not part of the worker admission snapshot", async () => {
    const c = new WorkerConcurrencyController({}, {});
    const a = providerDescriptor({ provider: "local", model: "a" }), b = providerDescriptor({ provider: "local", model: "b" });
    const p = c.tryAcquire(req({ providers: a.providers }))!; let called = false;
    await expect(p.run(() => c.runRequest(b, async () => { called = true; }))).rejects.toThrow(/admitted/);
    expect(called).toBe(false); p.release();
  });
  it("enforces the microbatch upper bound even when logical capacity is larger", () => {
    const c = new WorkerConcurrencyController({ maxActiveJobs: 32, resourceLimits: { embedding: 32 } }, {});
    const r = req({ resourceClass: "embedding", embedding: true });
    expect(c.tryAcquire(r, 17)).toBeUndefined();
    const p = c.tryAcquire(r, 16)!;
    expect(c.tryAcquire(r, 1, p)).toBeUndefined(); p.release();
  });
  it("notifies subscribers on release and supports unsubscribe and idempotent release", () => {
    const c = new WorkerConcurrencyController({}, {}); let calls = 0;
    const off = c.subscribe(() => { calls++; });
    const p = c.tryAcquire(req())!; p.release(); p.release(); expect(calls).toBe(1);
    off(); c.tryAcquire(req())!.release(); expect(calls).toBe(1);
  });
  it("does not start a queued request after its own permit has been released", async () => {
    const c = new WorkerConcurrencyController({}, {}), d = providerDescriptor({ provider: "local", model: "a" });
    const p = c.tryAcquire(req({ providers: d.providers }))!; let called = false;
    const request = p.run(() => c.runRequest(d, async () => { called = true; }));
    p.release(); await expect(request).rejects.toThrow(/released/); expect(called).toBe(false);
  });
  it("keeps the provider reserved until an already started request settles after early task release", async () => {
    const c = new WorkerConcurrencyController({}, {}), d = providerDescriptor({ provider: "local", model: "a" });
    const r = req({ providers: d.providers });
    const p = c.tryAcquire(r)!;
    let finish!: () => void;
    const request = p.run(() => c.runRequest(d, () => new Promise<void>(resolve => { finish = resolve; })));
    await tick(); p.release();
    expect(c.availableJobs()).toBe(4);
    expect(c.tryAcquire(r)).toBeUndefined();
    finish(); await request;
    const next = c.tryAcquire(r)!; expect(next).toBeDefined(); next.release();
  });
  it("closes foreground admission, rejects waiters, and waits for admitted work to finish", async () => {
    const c = new WorkerConcurrencyController({}, {}), d = providerDescriptor({ provider: "local", model: "a" });
    const p = c.tryAcquire(req({ providers: d.providers }))!;
    let called = false, closed = false;
    const waiting = c.runRequest(d, async () => { called = true; });
    const rejected = expect(waiting).rejects.toThrow(/clos/i);
    const close = c.close().then(() => { closed = true; });
    await tick(); expect(called).toBe(false); expect(closed).toBe(false);
    expect(c.tryAcquire(req())).toBeUndefined();
    expect(await p.run(() => c.runRequest(d, async () => "admitted-finishes"))).toBe("admitted-finishes");
    p.release(); await Promise.all([close, rejected]);
    expect(closed).toBe(true); expect(c.snapshot().providers).toEqual({});
    await expect(c.runRequest(d, async () => {})).rejects.toThrow(/clos/i);
  });
});
