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

  it("disables Qwen thinking only for opted-in requests and cannot be overridden by shared defaults", async () => {
    const model = resolved();
    if (!model.ok) throw new Error("fixture");
    model.context.model = "qwen3.8-flash";
    const defaults = { enable_thinking: true, thinking_budget: 32000, reasoning_effort: "xhigh", thinking: { type: "enabled" },
      max_tokens: 32768, max_completion_tokens: 65536, chat_template_kwargs: { enable_thinking: true, keep: "value" } };
    model.provider.extraBody = structuredClone(defaults);
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"paragraph\":\"Synthetic prose\"}" }, finish_reason: "stop" }],
        usage: { completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } } }));
    });
    const service = createPluginModelInferenceService({ resolveModel: async () => model, fetch: fetch as typeof globalThis.fetch });
    const call = { pluginId: "literature-review", callId: "writing", conversationId: "v", service: "model-inference" };
    const input = { messages: [{ role: "user", content: "Write a paragraph" }], maxOutputTokens: 1100 };
    const result = await service.invoke({ ...call, input: { ...input, thinkingMode: "disabled", thinkingBudgetTokens: 2048 } });
    expect(bodies[0]).toMatchObject({ enable_thinking: false, max_completion_tokens: 1100, chat_template_kwargs: { enable_thinking: false, keep: "value" } });
    for (const key of ["thinking_budget", "reasoning_effort", "thinking", "max_tokens"]) expect(bodies[0]).not.toHaveProperty(key);
    expect(result).toMatchObject({ usage: { reasoningTokens: 0 } });
    // Both unrelated work inside the review plugin and other plugins retain their settings.
    await service.invoke({ ...call, input });
    await service.invoke({ ...call, pluginId: "other-plugin", input });
    expect(bodies[1]).toMatchObject(defaults);
    expect(bodies[2]).toEqual(bodies[1]);
    expect(model.provider.extraBody).toEqual(defaults);
    model.context.model = "unrelated-chat-model";
    await service.invoke({ ...call, input: { ...input, thinkingMode: "disabled" } });
    expect(bodies[3]).toMatchObject(defaults);
    model.context.model = "qwen3.6-max";
    await service.invoke({ ...call, input: { ...input, thinkingMode: "disabled" } });
    expect(bodies[4]).toMatchObject(defaults);
  });

  it.each([
    {
      name: "DeepSeek V4",
      provider: "deepseek",
      endpoint: "https://api.deepseek.example/v1",
      model: "deepseek-v4-flash",
      expected: { thinking: { type: "disabled" }, max_tokens: 1100 },
      absent: ["enable_thinking", "reasoning_effort", "max_completion_tokens"]
    },
    {
      name: "GLM",
      provider: "zhipu",
      endpoint: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5-flash",
      expected: { thinking: { type: "disabled" }, max_tokens: 1100 },
      absent: ["enable_thinking", "reasoning_effort", "max_completion_tokens"]
    },
    {
      name: "GPT with disable support",
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5.1",
      expected: { reasoning_effort: "none", max_completion_tokens: 1100 },
      absent: ["enable_thinking", "thinking", "max_tokens", "temperature"]
    },
    {
      name: "OpenRouter",
      provider: "openai",
      endpoint: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
      expected: { reasoning: { effort: "none" }, max_tokens: 1100 },
      absent: ["enable_thinking", "thinking", "reasoning_effort", "max_completion_tokens"]
    }
  ])("translates disabled thinking for $name without leaking shared reasoning defaults", async ({ provider, endpoint, model, expected, absent }) => {
    const selection = resolved();
    if (!selection.ok) throw new Error("fixture");
    selection.context.provider = provider;
    selection.context.model = model;
    selection.provider.provider = provider;
    selection.provider.apiBase = endpoint;
    selection.provider.extraBody = {
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      thinking: { type: "enabled" },
      enable_thinking: true,
      max_tokens: 32_768,
      max_completion_tokens: 65_536
    };
    let body: Record<string, unknown> = {};
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"paragraph\":\"Synthetic prose\"}" }, finish_reason: "stop" }]
      }));
    });
    const service = createPluginModelInferenceService({ resolveModel: async () => selection, fetch: fetch as typeof globalThis.fetch });
    await service.invoke({
      pluginId: "literature-review", callId: "disable-thinking", conversationId: "v", service: "model-inference",
      input: { messages: [{ role: "user", content: "Write" }], thinkingMode: "disabled", maxOutputTokens: 1100 }
    });
    expect(body).toMatchObject(expected);
    for (const key of absent) expect(body).not.toHaveProperty(key);
  });

  it("uses protocol-native disabled thinking controls for Claude, Gemini, and OpenAI Responses", async () => {
    const call = { pluginId: "literature-review", callId: "native-thinking", conversationId: "v", service: "model-inference" };
    const input = { messages: [{ role: "user" as const, content: "Write" }], thinkingMode: "disabled" as const, maxOutputTokens: 900 };

    const anthropic = resolved();
    if (!anthropic.ok) throw new Error("fixture");
    anthropic.context.protocol = "anthropic-messages";
    anthropic.context.model = "claude-sonnet-4";
    anthropic.provider.protocol = "anthropic-messages";
    anthropic.provider.extraBody = { thinking: { type: "enabled", budget_tokens: 4000 }, max_tokens: 8000 };
    let anthropicBody: Record<string, unknown> = {};
    const anthropicFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      anthropicBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }));
    });
    await createPluginModelInferenceService({
      resolveModel: async () => anthropic,
      fetch: anthropicFetch as typeof globalThis.fetch
    }).invoke({ ...call, input });
    expect(anthropicBody).toMatchObject({ max_tokens: 900, thinking: { type: "disabled" } });

    const gemini = resolved();
    if (!gemini.ok) throw new Error("fixture");
    gemini.context.protocol = "gemini-generate-content";
    gemini.context.model = "gemini-2.5-flash";
    gemini.provider.protocol = "gemini-generate-content";
    gemini.provider.extraBody = { generationConfig: { topP: 0.8, thinkingConfig: { thinkingBudget: 4000 } } };
    let geminiBody: Record<string, unknown> = {};
    const geminiFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      geminiBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }]
      }));
    });
    await createPluginModelInferenceService({
      resolveModel: async () => gemini,
      fetch: geminiFetch as typeof globalThis.fetch
    }).invoke({ ...call, input });
    expect(geminiBody).toMatchObject({
      generationConfig: { topP: 0.8, maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } }
    });

    const responses = resolved();
    if (!responses.ok) throw new Error("fixture");
    responses.context.protocol = "openai-responses";
    responses.context.model = "gpt-5.1";
    responses.provider.protocol = "openai-responses";
    responses.provider.extraBody = { reasoning: { effort: "high" } };
    let responsesBody: Record<string, unknown> = {};
    const responsesFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      responsesBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: "done", status: "completed" }));
    });
    await createPluginModelInferenceService({
      resolveModel: async () => responses,
      fetch: responsesFetch as typeof globalThis.fetch
    }).invoke({ ...call, input });
    expect(responsesBody).toMatchObject({
      max_output_tokens: 900,
      reasoning: { effort: "none" }
    });
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

  it("uses one JSON compatibility fallback even when the plugin disables ordinary retries", async () => {
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
      input: { messages: [{ role: "user", content: "Check continuity" }], responseFormat: "json", maxAttempts: 1 }
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
