/** Model config tester tests. */
import type { ModelConfigTestInput, ModelEndpointProtocol, ModelProvider } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { createHttpModelConfigTester, DEFAULT_PROBE_TIMEOUT_MS } from "../model-config-tester.js";

const checkedAt = "2026-06-05T10:00:00.000Z";

describe("model config tester", () => {
  it("keeps a long enough network-only timeout", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it.each([
    ["openai_compatible", "openai-chat-completions"],
    ["deepseek", "openai-chat-completions"],
    ["zhipu", "openai-chat-completions"],
    ["qwen", "openai-chat-completions"],
    ["kimi", "openai-chat-completions"],
    ["minimax", "openai-chat-completions"],
    ["baidu", "openai-chat-completions"],
    ["doubao", "openai-chat-completions"],
    ["openai_compatible", "openai-responses"],
    ["openai_compatible", "openai-embeddings"],
    ["doubao", "openai-images"]
  ] as Array<[ModelProvider, ModelEndpointProtocol]>) (
    "uses only GET /models for %s %s",
    async (provider, protocol) => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const tester = createHttpModelConfigTester({
        now: () => checkedAt,
        fetch: async (input, init) => {
          calls.push({ url: input.toString(), init: init ?? {} });
          return json({ data: [{ id: "model-a" }] });
        }
      });

      await expect(tester.test(input({ provider, protocol }))).resolves.toEqual({
        ok: true,
        message: "连接成功",
        checkedAt,
        modelListed: true
      });
      expect(calls).toEqual([{
        url: "https://endpoint-a.example/v1/models",
        init: expect.objectContaining({
          method: "GET",
          headers: { Authorization: "Bearer sk-secret" }
        })
      }]);
      expect(calls[0]?.init.body).toBeUndefined();
      expect(calls[0]?.url).not.toMatch(/chat\/completions|messages|generateContent|embeddings|audio|images\/generations/u);
    }
  );

  it("uses the exact selected endpoint URL and never another endpoint from the provider", async () => {
    const calls: string[] = [];
    const tester = createHttpModelConfigTester({
      fetch: async (request) => {
        calls.push(request.toString());
        return json({ data: [{ id: "model-a" }] });
      }
    });

    await tester.test(input({
      endpointId: "embedding-eu",
      apiBase: "https://eu-only.example/custom/v9",
      protocol: "openai-embeddings"
    }));

    expect(calls).toEqual(["https://eu-only.example/custom/v9/models"]);
  });

  it("uses Anthropic GET /v1/models headers without a request body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => checkedAt,
      fetch: async (request, init) => {
        calls.push({ url: request.toString(), init: init ?? {} });
        return json({ data: [{ id: "model-a" }] });
      }
    });

    await tester.test(input({
      provider: "anthropic",
      protocol: "anthropic-messages",
      apiBase: "https://api.anthropic.com"
    }));

    expect(calls[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/models",
      init: {
        method: "GET",
        headers: {
          "x-api-key": "sk-secret",
          "anthropic-version": "2023-06-01"
        }
      }
    });
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("uses Google GET /v1beta/models headers without a request body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => checkedAt,
      fetch: async (request, init) => {
        calls.push({ url: request.toString(), init: init ?? {} });
        return json({ models: [{ name: "models/model-a" }] });
      }
    });

    await tester.test(input({
      provider: "google",
      protocol: "gemini-generate-content",
      apiBase: "https://generativelanguage.googleapis.com/v1beta"
    }));

    expect(calls[0]).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      init: {
        method: "GET",
        headers: { "x-goog-api-key": "sk-secret" }
      }
    });
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("treats a missing configured model as advisory while the list connection succeeds", async () => {
    const tester = createHttpModelConfigTester({
      now: () => checkedAt,
      fetch: async () => json({ data: [{ id: "another-model" }] })
    });

    await expect(tester.test(input())).resolves.toEqual({
      ok: true,
      message: "连接成功",
      checkedAt,
      modelListed: false
    });
  });

  it.each([
    "dashscope-input-audio-chat",
    "dashscope-multimodal-generation",
    "memmy-account"
  ] as ModelEndpointProtocol[])("fails closed for %s without issuing any HTTP request", async (protocol) => {
    const fetch = vi.fn();
    const tester = createHttpModelConfigTester({ now: () => checkedAt, fetch });

    await expect(tester.test(input({ protocol }))).resolves.toEqual({
      ok: false,
      message: "当前 endpoint 协议不支持模型列表连接测试",
      checkedAt
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a 2xx body that is not a model list", async () => {
    const tester = createHttpModelConfigTester({
      now: () => checkedAt,
      fetch: async () => json({ choices: [{ message: { content: "inference response" } }] })
    });

    const response = await tester.test(input());
    expect(response.ok).toBe(false);
    expect(response.message).toContain("模型列表接口");
  });

  it.each([401, 403])("redacts secrets from HTTP %s failures", async (status) => {
    const tester = createHttpModelConfigTester({
      now: () => checkedAt,
      fetch: async () => json({ error: { message: "bad sk-secret" } }, status)
    });

    const response = await tester.test(input());
    expect(response).toMatchObject({ ok: false, message: "bad [redacted]", checkedAt });
    expect(JSON.stringify(response)).not.toContain("sk-secret");
  });

  it("keeps actionable Base URL guidance on 404", async () => {
    const tester = createHttpModelConfigTester({
      now: () => checkedAt,
      fetch: async () => json({ error: { message: "not found" } }, 404)
    });

    const response = await tester.test(input());
    expect(response.ok).toBe(false);
    expect(response.message).toContain("/v1");
  });

  it("normalizes timeout errors without exposing the key", async () => {
    const tester = createHttpModelConfigTester({
      now: () => checkedAt,
      fetch: async () => {
        throw new DOMException("The operation timed out: sk-secret", "TimeoutError");
      }
    });

    await expect(tester.test(input())).resolves.toEqual({
      ok: false,
      message: "连接超时，请检查 API 地址或网络",
      checkedAt
    });
  });
});

function input(overrides: Partial<ModelConfigTestInput> = {}): ModelConfigTestInput & { apiKey: string } {
  return {
    provider: "openai_compatible",
    endpointId: "chat-a",
    protocol: "openai-chat-completions",
    apiBase: "https://endpoint-a.example/v1",
    modelId: "model-a",
    apiKey: "sk-secret",
    capability: "chat",
    ...overrides
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
