/** Model config tester tests. */
import { describe, expect, it } from "vitest";
import { createHttpModelConfigTester, DEFAULT_PROBE_TIMEOUT_MS } from "../model-config-tester.js";

describe("model config tester", () => {
  it("gives slow aggregation gateways at least 30s before the probe aborts", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("sends a minimal OpenAI-compatible chat request and hides secrets in result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-5.5",
      apiKey: "sk-test-secret"
    });

    expect(result).toEqual({
      ok: true,
      message: "连接成功",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer sk-test-secret",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "gpt-5.5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }]
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("keeps explicit versioned chat base URLs when probing OpenAI-compatible models", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "baidu",
      baseUrl: "https://qianfan.baidubce.com/v2",
      modelId: "ernie-x1.1",
      apiKey: "bce-v3-test-secret"
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://qianfan.baidubce.com/v2/chat/completions");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "ernie-x1.1",
      max_tokens: 64,
      messages: [{ role: "user", content: "ping" }]
    });
  });

  it("does not duplicate chat completions paths when the user enters a full endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v2/chat/completions",
      modelId: "custom-model",
      apiKey: "sk-custom-secret"
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/v2/chat/completions");
  });

  it("sends a minimal OpenAI-compatible embedding request when testing embedding models", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      modelId: "text-embedding-3-small",
      apiKey: "sk-test-secret",
      capability: "embedding"
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "text-embedding-3-small",
      input: "ping"
    });
  });

  it("sends a minimal OpenAI-compatible audio request when testing ASR models", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelId: "qwen3-asr-flash",
      apiKey: "sk-asr-secret",
      capability: "asr"
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer sk-asr-secret",
      "content-type": "application/json",
      "dashscope-plugin": "memmy"
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "qwen3-asr-flash",
      stream: false,
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: {
            data: "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
          }
        }]
      }],
      asr_options: {
        enable_itn: false
      }
    });
  });

  it("sends a lightweight model-list request when testing image models", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ id: "doubao-seedream-4-0-250828" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seedream-4-0-250828",
      apiKey: "sk-image-secret",
      capability: "image"
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ark.cn-beijing.volces.com/api/v3/models");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer sk-image-secret" });
  });

  it("sends a Google model-list request when testing Gemini image models", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ models: [{ name: "models/imagen-4.0-generate-001" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelId: "imagen-4.0-generate-001",
      apiKey: "AIza-image",
      capability: "image"
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toMatchObject({ "x-goog-api-key": "AIza-image" });
  });

  it("keeps Qwen image connection test as lightweight model-list probe", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ id: "qwen-image" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "qwen",
      baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
      modelId: "qwen-image-2.0-pro",
      apiKey: "sk-qwen-image",
      capability: "image"
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("does not rewrite custom Qwen proxy image probe bases", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ id: "qwen-image-2.0-pro" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "qwen",
      baseUrl: "https://proxy.example.com/api/v1",
      modelId: "qwen-image-2.0-pro",
      apiKey: "sk-qwen-image",
      capability: "image"
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://proxy.example.com/api/v1/models");
  });

  it("returns a failed result when image model probe is unauthorized", async () => {
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
    });

    const result = await tester.test({
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seedream-4-0-250828",
      apiKey: "sk-bad",
      capability: "image"
    });

    expect(result.ok).toBe(false);
  });

  it("sends a minimal Google embedding request when testing Gemini embedding models", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ embedding: { values: [0.1] } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await tester.test({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      modelId: "text-embedding-004",
      apiKey: "gemini-secret",
      capability: "embedding"
    });

    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent");
    expect(calls[0]?.init.headers).toMatchObject({
      "content-type": "application/json",
      "x-goog-api-key": "gemini-secret"
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      content: { parts: [{ text: "ping" }] }
    });
  });

  it("retries with max_completion_tokens when the model rejects max_tokens", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if ("max_tokens" in body) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                type: "invalid_request_error",
                param: "max_tokens",
                code: "unsupported_parameter"
              }
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "openai_compatible",
      baseUrl: "https://ctcai.openai.azure.com/openai/v1",
      modelId: "gpt-5.5",
      apiKey: "sk-test-secret"
    });

    expect(result).toEqual({
      ok: true,
      message: "连接成功",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
    expect(calls).toHaveLength(2);
    const retryBody = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(retryBody).toMatchObject({
      model: "gpt-5.5",
      max_completion_tokens: 128,
      messages: [{ role: "user", content: "ping" }]
    });
    expect(retryBody).not.toHaveProperty("max_tokens");
  });

  it("does not retry when a 400 error is unrelated to max_tokens", async () => {
    const calls: string[] = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input) => {
        calls.push(input.toString());
        return new Response(JSON.stringify({ error: { message: "model not found" } }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(
      tester.test({
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-5.5",
        apiKey: "sk-test-secret"
      })
    ).resolves.toEqual({
      ok: false,
      message: "model not found",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
    expect(calls).toHaveLength(1);
  });

  it("surfaces the retry failure when max_completion_tokens is also rejected", async () => {
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const param = "max_tokens" in body ? "max_tokens" : "max_completion_tokens";
        return new Response(
          JSON.stringify({ error: { message: `Unsupported parameter: '${param}' is not supported with this model.` } }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
    });

    await expect(
      tester.test({
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-5.5",
        apiKey: "sk-test-secret"
      })
    ).resolves.toEqual({
      ok: false,
      message: "Unsupported parameter: 'max_completion_tokens' is not supported with this model.",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
  });

  it("returns a failed result when provider rejects the request", async () => {
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key sk-test-secret" } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
    });

    await expect(
      tester.test({
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-5.5",
        apiKey: "sk-test-secret"
      })
    ).resolves.toEqual({
      ok: false,
      message: "invalid api key [redacted]",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
  });

  it("probes the user-entered base URL verbatim without appending /v1", async () => {
    const calls: Array<{ url: string }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input) => {
        calls.push({ url: input.toString() });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await tester.test({
      provider: "openai_compatible",
      baseUrl: "https://api-int.memtensor.cn",
      modelId: "gpt-4.1-mini",
      apiKey: "sk-test"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api-int.memtensor.cn/chat/completions");
  });

  it("does not strip a duplicate /v1 from Anthropic base URLs and guides the user on 404", async () => {
    const calls: Array<{ url: string }> = [];
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async (input) => {
        calls.push({ url: input.toString() });
        return new Response(JSON.stringify({ error: { message: "not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await tester.test({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      modelId: "claude-sonnet-4",
      apiKey: "sk-ant-test"
    });

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/v1/messages");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不应包含 /v1");
    expect(result.message).toContain("https://api.anthropic.com");
  });

  it("guides OpenAI-compatible users toward a /v1 base URL on 404", async () => {
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async () => new Response("not found", { status: 404 })
    });

    const result = await tester.test({
      provider: "openai_compatible",
      baseUrl: "https://api-int.memtensor.cn",
      modelId: "gpt-4.1-mini",
      apiKey: "sk-test"
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("以 /v1 结尾");
    expect(result.message).toContain("https://api.openai.com/v1");
  });

  it("treats a 2xx HTML management page as a failed probe with base URL guidance", async () => {
    const tester = createHttpModelConfigTester({
      now: () => "2026-06-05T10:00:00.000Z",
      fetch: async () =>
        new Response("<!doctype html><title>MemtensorAPI</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })
    });

    const result = await tester.test({
      provider: "openai_compatible",
      baseUrl: "https://api-int.memtensor.cn",
      modelId: "gpt-4.1-mini",
      apiKey: "1"
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("API 返回格式不符合模型接口");
    expect(result.message).toContain("以 /v1 结尾");
    expect(result.message).toContain("https://api.openai.com/v1");
  });
});
