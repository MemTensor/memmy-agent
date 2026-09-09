import type { ModelSelectionResolution } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { createPluginModelInferenceService } from "../plugin-model-inference-service.js";

describe("plugin model inference Host service", () => {
  it("uses the current user model without exposing credentials", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-key" });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"summary\":\"grounded\"}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const service = createPluginModelInferenceService({ resolveModel: async () => resolved(), fetch: fetch as typeof globalThis.fetch });
    const result = await service.invoke({
      pluginId: "literature-review", callId: "call-1", conversationId: "conversation-1", service: "model-inference",
      input: { messages: [{ role: "user", content: "Summarize evidence" }], responseFormat: "json", maxOutputTokens: 500 }
    });
    expect(result).toEqual({
      content: "{\"summary\":\"grounded\"}", finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      model: { provider: "openai", model: "current-user-model" }
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(fetch).toHaveBeenCalledWith("https://models.example/v1/chat/completions", expect.any(Object));
  });

  it("bounds Qwen reasoning per call and preserves unconfigured requests and provider defaults", async () => {
    const model = resolved();
    if (!model.ok) throw new Error("fixture");
    model.context.model = "qwen3.8-flash";
    model.provider.extraBody = { reasoning_effort: "xhigh", max_tokens: 8192 };
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { completion_tokens: 800, completion_tokens_details: { reasoning_tokens: 600 } } }));
    });
    const service = createPluginModelInferenceService({ resolveModel: async () => model, fetch: fetch as typeof globalThis.fetch });
    const call = { pluginId: "literature-review", callId: "bounded", conversationId: "v", service: "model-inference" };
    const input = { messages: [{ role: "user", content: "Return JSON" }], maxOutputTokens: 700 };
    const result = await service.invoke({ ...call, input: { ...input, thinkingBudgetTokens: 2048, timeoutMs: 180_000, maxAttempts: 1 } });
    expect(bodies[0]).toMatchObject({ thinking_budget: 2048, max_completion_tokens: 2748 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(result).toMatchObject({ usage: { reasoningTokens: 600 } });
    await service.invoke({ ...call, pluginId: "another-plugin", input });
    expect(bodies[1]).toMatchObject({ reasoning_effort: "xhigh", max_tokens: 8192 });
    expect(bodies[1]).not.toHaveProperty("thinking_budget");
    expect(bodies[1]).not.toHaveProperty("max_completion_tokens");
    expect(model.provider.extraBody).toEqual({ reasoning_effort: "xhigh", max_tokens: 8192 });
    model.context.model = "unrelated-chat-model";
    await service.invoke({ ...call, input: { ...input, thinkingBudgetTokens: 2048 } });
    expect(bodies[2]).toEqual({ ...bodies[1], model: "unrelated-chat-model" });
  });

  it("does not duplicate a timed out paragraph request, and honors the caller deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }));
      const service = createPluginModelInferenceService({ resolveModel: async () => resolved(), fetch: fetch as typeof globalThis.fetch });
      const call = { pluginId: "literature-review", callId: "bounded", conversationId: "v", service: "model-inference",
        input: { messages: [{ role: "user", content: "Write" }], timeoutMs: 180_000, maxAttempts: 1 } };
      let settled = false;
      const pending = service.invoke(call).finally(() => { settled = true; });
      const assertion = expect(pending).rejects.toMatchObject({ code: "model_inference_timeout" });
      await vi.advanceTimersByTimeAsync(120_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
      const deadline = service.invoke({ ...call, deadline: new Date(Date.now() + 1500).toISOString() });
      const deadlineAssertion = expect(deadline).rejects.toMatchObject({ code: "model_inference_timeout" });
      await vi.advanceTimersByTimeAsync(1500);
      await deadlineAssertion;
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("rejects unavailable models and oversized requests before network access", async () => {
    const fetch = vi.fn();
    const unavailable = createPluginModelInferenceService({ resolveModel: async () => null, fetch: fetch as typeof globalThis.fetch });
    await expect(unavailable.invoke({ pluginId: "p", callId: "c", conversationId: "v", service: "model-inference", input: { messages: [{ role: "user", content: "hi" }] } })).rejects.toMatchObject({ code: "model_unavailable" });
    const available = createPluginModelInferenceService({ resolveModel: async () => resolved(), fetch: fetch as typeof globalThis.fetch });
    await expect(available.invoke({ pluginId: "p", callId: "c", conversationId: "v", service: "model-inference", input: { messages: [{ role: "user", content: "x".repeat(200_001) }] } })).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries one transient empty model response before returning success", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "recovered" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = createPluginModelInferenceService({
      resolveModel: async () => resolved(),
      fetch: fetch as typeof globalThis.fetch,
      retryBaseDelayMs: 0
    });

    await expect(service.invoke({
      pluginId: "literature-review", callId: "retry-empty", conversationId: "conversation-1", service: "model-inference",
      input: { messages: [{ role: "user", content: "Check continuity" }], responseFormat: "json" }
    })).resolves.toMatchObject({ content: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(firstBody.response_format).toEqual({ type: "json_object" });
    expect(secondBody.response_format).toBeUndefined();
  });

  it("retries transient gateway failures with the configured retry policy", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "recovered after 502" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = createPluginModelInferenceService({
      resolveModel: async () => resolved(),
      fetch: fetch as typeof globalThis.fetch,
      maxAttempts: 2,
      retryBaseDelayMs: 0
    });
    await expect(service.invoke({
      pluginId: "literature-review", callId: "retry-502", conversationId: "conversation-1", service: "model-inference",
      input: { messages: [{ role: "user", content: "Continue" }] }
    })).resolves.toMatchObject({ content: "recovered after 502" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight model request when the owning plugin run is cancelled", async () => {
    const requestStarted = Promise.withResolvers<void>();
    let receivedSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      requestStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const controller = new AbortController();
    const service = createPluginModelInferenceService({
      resolveModel: async () => resolved(),
      fetch: fetch as typeof globalThis.fetch,
      maxAttempts: 1
    });
    const pending = service.invoke({
      pluginId: "literature-review", callId: "cancel-model", conversationId: "conversation-1", service: "model-inference",
      input: { messages: [{ role: "user", content: "Write" }] }, signal: controller.signal
    });
    await requestStarted.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "plugin_call_cancelled", retryable: false });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("honors a bounded per-request timeout requested by a plugin", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const service = createPluginModelInferenceService({
      resolveModel: async () => resolved(),
      fetch: fetch as typeof globalThis.fetch,
      maxAttempts: 1
    });
    await expect(service.invoke({
      pluginId: "literature-review", callId: "short-timeout", conversationId: "conversation-1", service: "model-inference",
      input: { messages: [{ role: "user", content: "Generate keywords" }], timeoutMs: 1_000 }
    })).rejects.toMatchObject({ code: "model_inference_timeout", retryable: true });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("delegates embedding inference to the Memory-owned current model without exposing configuration", async () => {
    const embeddingInference = vi.fn(async () => ({
      embeddings: [[1, 0], [0, 1]],
      model: { provider: "local", model: "Xenova/all-MiniLM-L6-v2", mode: "local" as const, dimension: 2 }
    }));
    const service = createPluginModelInferenceService({
      resolveModel: async () => null,
      embeddingInference
    });
    const result = await service.invoke({
      pluginId: "literature-review",
      callId: "call-embedding",
      conversationId: "conversation-1",
      service: "embedding-inference",
      input: { texts: ["section query", "evidence document"], role: "document" }
    });
    expect(result).toEqual({
      embeddings: [[1, 0], [0, 1]],
      model: { provider: "local", model: "Xenova/all-MiniLM-L6-v2", mode: "local", dimension: 2 }
    });
    expect(embeddingInference).toHaveBeenCalledWith(
      { texts: ["section query", "evidence document"], role: "document" },
      { signal: undefined }
    );
  });

  it("rejects invalid or unavailable embedding requests", async () => {
    const unavailable = createPluginModelInferenceService({ resolveModel: async () => null });
    await expect(unavailable.invoke({
      pluginId: "p", callId: "c", conversationId: "v", service: "embedding-inference", input: { texts: ["query"] }
    })).rejects.toMatchObject({ code: "embedding_unavailable", retryable: false });

    const embeddingInference = vi.fn();
    const available = createPluginModelInferenceService({ resolveModel: async () => null, embeddingInference });
    await expect(available.invoke({
      pluginId: "p", callId: "c", conversationId: "v", service: "embedding-inference", input: { texts: [] }
    })).rejects.toBeDefined();
    expect(embeddingInference).not.toHaveBeenCalled();
  });
});

function resolved(): ModelSelectionResolution {
  return {
    ok: true,
    context: {
      presetId: "agent-default", provider: "openai", endpointId: "default", protocol: "openai-chat-completions",
      model: "current-user-model", source: "byok", ownerAccountId: null, capability: "agent", capabilities: ["agent"]
    },
    provider: {
      provider: "openai", endpointId: "default", protocol: "openai-chat-completions",
      apiBase: "https://models.example/v1", apiKey: "secret-key", extraHeaders: {}, extraBody: {}
    }
  };
}
