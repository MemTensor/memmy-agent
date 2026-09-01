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
