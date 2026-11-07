import { describe, expect, it, vi, afterEach } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { createLlmClient } from "../../../src/model/llm.js";
import { MemoryModelTaskRouter } from "../../../src/model/task-routing.js";
import { WorkerConcurrencyController, providerDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

afterEach(() => vi.unstubAllGlobals());
describe("Responses and Chat share actual Provider capacity after upstream protocol integration", () => {
  it.each([undefined, "https://api.openai.com/v1", "https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses/"])("normalizes the Responses endpoint %s to the actual shared service", endpoint => {
    const chat = providerDescriptor({ provider: "openai_compatible", model: "same" });
    expect(providerDescriptor({ provider: "openai_responses", model: "same", endpoint }).providers).toEqual(chat.providers);
    expect(providerDescriptor({ provider: "openai_responses", endpoint: "https://proxy.test/other/v1/responses", model: "same" }).providers[0])
      .not.toEqual(chat.providers[0]);
  });

  it("caps mixed real protocol calls at cloud concurrency instead of creating independent pools", async () => {
    const common = { ...DEFAULT_MEMMY_CONFIG.summary, apiKey: "synthetic-key", endpoint: undefined, model: "synthetic",
      maxRetries: 0, malformedRetries: 0 };
    const summary = createLlmClient({ ...common, provider: "openai_responses" });
    const evolution = createLlmClient({ ...common, provider: "openai_compatible" });
    const c = new WorkerConcurrencyController({}, {});
    const router = new MemoryModelTaskRouter(() => ({ config: DEFAULT_MEMMY_CONFIG, summary, evolution, embedding: createCapturingEmbedder([]) }), c);
    let active = 0, peak = 0;
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input); urls.push(url); peak = Math.max(peak, ++active);
      await new Promise<void>(resolve => setImmediate(resolve)); active--;
      return new Response(JSON.stringify(url.endsWith("/responses")
        ? { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }
        : { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), { status: 200 });
    });
    try {
      await Promise.all((["summary", "evolution", "summary", "evolution"] as const).map(role =>
        router.client(role).complete([{ role: "user", content: "synthetic" }], { operation: "test.protocol-admission" })));
      expect(urls.filter(url => url.endsWith("/responses"))).toHaveLength(2);
      expect(urls.filter(url => url.endsWith("/chat/completions"))).toHaveLength(2);
      expect(peak).toBe(2);
      expect(c.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0, providers: {} });
    } finally { await router.stop(); await c.close(); }
  });
});
