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
    expect(embeddingInference).toHaveBeenCalledWith({ texts: ["section query", "evidence document"], role: "document" });
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
