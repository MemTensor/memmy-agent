import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../src/config/index.js";
import { createLlmClient } from "../src/model/llm.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memory LLM thinking configuration", () => {
  it("overrides account Qwen per operation and omits incompatible JSON mode while thinking", async () => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig({
      vendor: "qwen",
      endpoint: "https://account-gateway.example/v1",
      model: "memory_evolution",
      enableThinking: true,
      thinkingBudget: 1_000
    }));

    await client.completeJson([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      enable_thinking: false,
      response_format: { type: "json_object" }
    });
    expect(requestBody(fetchMock)).not.toHaveProperty("thinking_budget");

    fetchMock.mockClear();
    await client.completeJson([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      enable_thinking: true,
      thinking_budget: 1_000
    });
    expect(requestBody(fetchMock)).not.toHaveProperty("response_format");
  });

  it("does not add a thinking budget to user-configured Qwen requests", async () => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig({
      vendor: "qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.7-plus",
      enableThinking: true
    }));

    await client.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });

    expect(requestBody(fetchMock)).toMatchObject({ enable_thinking: true });
    expect(requestBody(fetchMock)).not.toHaveProperty("thinking_budget");
  });

  it.each([
    ["DeepSeek", "deepseek", "https://api.deepseek.com", "deepseek-v4-pro"],
    ["Zhipu", "zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-5.1"],
    ["Kimi", "kimi", "https://api.moonshot.cn/v1", "kimi-k2.6"],
    ["Baidu", "baidu", "https://api.baiduqianfan.ai/v1", "deepseek-v3.2"],
    ["Doubao", "doubao", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2.0-lite"]
  ] as const)("maps %s thinking.type for online and evolution calls", async (_label, vendor, endpoint, model) => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig({ vendor, endpoint, model, enableThinking: true }));

    await client.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ thinking: { type: "disabled" } });

    fetchMock.mockClear();
    await client.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ thinking: { type: "enabled" } });
  });

  it.each([
    "ernie-5.0-thinking-preview",
    "qwen3-32b"
  ])("uses Baidu enable_thinking for %s", async (model) => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig({
      vendor: "baidu",
      endpoint: "https://api.baiduqianfan.ai/v1",
      model,
      enableThinking: true
    }));

    await client.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ enable_thinking: false });
  });

  it("uses gateway semantics before the retained model vendor", async () => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);
    const dashscopeDeepSeek = createLlmClient(llmConfig({
      vendor: "deepseek",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "deepseek-v4-pro"
    }));
    await dashscopeDeepSeek.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ enable_thinking: false });
    expect(requestBody(fetchMock)).not.toHaveProperty("thinking");

    fetchMock.mockClear();
    const dashscopeMiniMax = createLlmClient(llmConfig({
      vendor: "minimax",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "MiniMax-M3"
    }));
    await dashscopeMiniMax.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ thinking: { type: "disabled" } });

    fetchMock.mockClear();
    await dashscopeMiniMax.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ thinking: { type: "adaptive" } });
  });

  it("keeps thinking enabled when the selected model cannot disable it", async () => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);

    const directMiniMax = createLlmClient(llmConfig({
      vendor: "minimax",
      endpoint: "https://minimax-proxy.example/v1",
      model: "MiniMax-M2.7"
    }));
    await directMiniMax.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ reasoning_split: true });

    for (const model of ["kimi-k2.7-code", "deepseek-r1", "qwen3-30b-a3b-thinking-2507"]) {
      fetchMock.mockClear();
      const client = createLlmClient(llmConfig({
        endpoint: "https://compatible.example/v1",
        model
      }));
      await client.complete([{ role: "user", content: "filter" }], {
        operation: "retrieval.filter",
        thinkingMode: "disabled"
      });
      expect(requestBody(fetchMock)).not.toHaveProperty("thinking");
      expect(requestBody(fetchMock)).not.toHaveProperty("enable_thinking");
    }
  });

  it("disables direct MiniMax M3 but keeps direct MiniMax M2 thinking", async () => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);
    const m3 = createLlmClient(llmConfig({
      vendor: "minimax",
      endpoint: "https://minimax-proxy.example/v1",
      model: "MiniMax-M3"
    }));

    await m3.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ thinking: { type: "disabled" } });
    expect(requestBody(fetchMock)).not.toHaveProperty("reasoning_split");

    fetchMock.mockClear();
    await m3.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      thinking: { type: "adaptive" },
      reasoning_split: true
    });
  });

  it("maps OpenRouter and OpenAI reasoning controls without disabling mandatory reasoning", async () => {
    const fetchMock = openAiFetch();
    vi.stubGlobal("fetch", fetchMock);
    const openRouter = createLlmClient(llmConfig({
      endpoint: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4"
    }));
    await openRouter.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ reasoning: { effort: "none" } });

    fetchMock.mockClear();
    const mandatoryOpenRouter = createLlmClient(llmConfig({
      endpoint: "https://openrouter.ai/api/v1",
      model: "google/gemini-3.5-flash"
    }));
    await mandatoryOpenRouter.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ reasoning: { effort: "medium" } });

    fetchMock.mockClear();
    const gpt51 = createLlmClient(llmConfig({ vendor: "openai_compatible", model: "gpt-5.1-mini" }));
    await gpt51.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ reasoning_effort: "none" });

    fetchMock.mockClear();
    const o3 = createLlmClient(llmConfig({ vendor: "openai_compatible", model: "o3-mini" }));
    await o3.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ reasoning_effort: "medium" });
    expect(requestBody(fetchMock)).not.toHaveProperty("temperature");

    fetchMock.mockClear();
    await createLlmClient(llmConfig({ model: "gpt-4.1-mini", enableThinking: true }))
      .complete([{ role: "user", content: "ordinary" }], { operation: "test.ordinary" });
    expect(requestBody(fetchMock)).not.toHaveProperty("reasoning_effort");
    expect(requestBody(fetchMock)).toMatchObject({ temperature: 0.2 });
  });

  it("omits immutable temperature for Moonshot Kimi K2 models", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      choices: [{ message: { content: "ok" } }]
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createLlmClient(llmConfig({
      vendor: "kimi",
      endpoint: "https://compatible.example/v1",
      model: "kimi-k2.5",
      temperature: 0.2
    })).complete([{ role: "user", content: "summarize" }], {
      operation: "test.kimi",
      temperature: 0
    });

    expect(requestBody(fetchMock)).toMatchObject({ model: "kimi-k2.5" });
    expect(requestBody(fetchMock)).not.toHaveProperty("temperature");
  });

  it("maps Gemini controls and keeps non-disableable Gemini models thinking", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }]
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createLlmClient(llmConfig({
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash",
      enableThinking: false
    })).complete([{ role: "user", content: "summarize" }], { operation: "test.gemini" });

    expect(requestBody(fetchMock)).toMatchObject({
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    });

    fetchMock.mockClear();
    await createLlmClient(llmConfig({
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-pro",
      enableThinking: false
    })).complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });

    expect(requestBody(fetchMock)).toMatchObject({
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: -1
        }
      }
    });

    fetchMock.mockClear();
    await createLlmClient(llmConfig({
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.1-pro-preview"
    })).complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: "high" } }
    });

    fetchMock.mockClear();
    await createLlmClient(llmConfig({
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-1.5-flash",
      enableThinking: true
    })).complete([{ role: "user", content: "ordinary" }], { operation: "test.gemini-old" });
    expect(requestBody(fetchMock).generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("maps Anthropic disabled, manual, adaptive, and always-on thinking modes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      content: [{ type: "text", text: "ok" }]
    }));
    vi.stubGlobal("fetch", fetchMock);

    const manual = createLlmClient(llmConfig({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      model: "claude-sonnet-4",
      maxTokens: 1600,
      enableThinking: true
    }));
    await manual.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ thinking: { type: "disabled" }, max_tokens: 1600 });

    fetchMock.mockClear();
    await manual.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });

    expect(requestBody(fetchMock)).toMatchObject({
      thinking: {
        type: "enabled",
        budget_tokens: 4096
      },
      temperature: 1,
      max_tokens: 8192
    });

    fetchMock.mockClear();
    const adaptive = createLlmClient(llmConfig({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      model: "claude-sonnet-4-6",
      enableThinking: true
    }));
    await adaptive.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      max_tokens: 8192
    });

    fetchMock.mockClear();
    await createLlmClient(llmConfig({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      model: "claude-opus-4-7"
    })).complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ thinking: { type: "disabled" } });
    expect(requestBody(fetchMock)).not.toHaveProperty("temperature");

    fetchMock.mockClear();
    const alwaysOn = createLlmClient(llmConfig({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      model: "claude-mythos-5",
      enableThinking: false
    }));
    await alwaysOn.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" }
    });
  });

  it("maps Bedrock manual/adaptive controls and host per-call overrides", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/model/")) {
        return jsonResponse({ output: { message: { content: [{ text: "ok" }] } } });
      }
      return jsonResponse({ text: "ok" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bedrock = createLlmClient(llmConfig({
      provider: "bedrock",
      endpoint: "https://bedrock-runtime.test",
      model: "anthropic.claude-sonnet-4-v1:0",
      enableThinking: true
    }));
    await bedrock.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      additionalModelRequestFields: { thinking: { type: "disabled" } }
    });

    fetchMock.mockClear();
    await bedrock.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });

    expect(requestBody(fetchMock)).toMatchObject({
      additionalModelRequestFields: {
        thinking: {
          type: "enabled",
          budget_tokens: 4096
        }
      },
      inferenceConfig: { maxTokens: 8192 }
    });

    fetchMock.mockClear();
    await createLlmClient(llmConfig({
      provider: "bedrock",
      endpoint: "https://bedrock-runtime.test",
      model: "anthropic.claude-opus-4-7-v1:0",
      enableThinking: false
    })).complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({
      additionalModelRequestFields: {
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" }
      },
      inferenceConfig: { maxTokens: 8192 }
    });

    fetchMock.mockClear();
    const host = createLlmClient(llmConfig({
      provider: "host",
      endpoint: "https://host-llm.test/complete",
      model: "host-model",
      enableThinking: true
    }));
    await host.complete([{ role: "user", content: "filter" }], {
      operation: "retrieval.filter",
      thinkingMode: "disabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ enableThinking: false });

    fetchMock.mockClear();
    await host.complete([{ role: "user", content: "evolve" }], {
      operation: "evolution.induction",
      thinkingMode: "enabled"
    });
    expect(requestBody(fetchMock)).toMatchObject({ enableThinking: true });
  });
});

function openAiFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => jsonResponse({
    choices: [{ message: { content: "{\"ok\":true}" } }]
  }));
}

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai_compatible",
    endpoint: "https://api.example.test/v1",
    model: "summary-model",
    apiKey: "sk-test",
    enableThinking: false,
    temperature: 0.2,
    maxTokens: 1200,
    timeoutMs: 60_000,
    maxRetries: 0,
    malformedRetries: 0,
    ...overrides
  };
}

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [Parameters<typeof fetch>[0], RequestInit | undefined];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
