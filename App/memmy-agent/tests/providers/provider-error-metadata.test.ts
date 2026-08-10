import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { AzureOpenAIProvider } from "../../src/providers/azure-openai-provider.js";
import {
  OpenAICompatProvider,
  coerceDict,
  deepMerge,
  floatEnv,
  gatewayReasoningExtraBody,
  getOrNull,
  getNestedInt,
  mergeResponsesExtraBody,
  mergeUniqueList,
  modelSlug,
  modelThinkingStyle,
  openaiCompatTimeoutS,
  thinkingExtraBody,
  thinkingStylesFor,
  usesOpenRouterAttribution,
} from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

function providerError(body: Record<string, any>, statusCode?: number): any {
  const error: any = new Error("provider error");
  error.body = body;
  if (statusCode != null) error.statusCode = statusCode;
  return error;
}

describe("provider error metadata", () => {
  it("captures retry and structured metadata from OpenAI-compatible errors", () => {
    const err: any = new Error("boom");
    err.statusCode = 409;
    err.response = {
      statusCode: 409,
      headers: { "retry-after-ms": "250", "x-should-retry": "false" },
      text: '{"error":{"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    };
    err.body = { error: { type: "rate_limit_exceeded", code: "rate_limit_exceeded" } };

    const response = OpenAICompatProvider.handleError(err);

    expect(response.finishReason).toBe("error");
    expect(response.errorStatusCode).toBe(409);
    expect(response.errorType).toBe("rate_limit_exceeded");
    expect(response.errorRetryAfterS).toBe(0.25);
    expect(response.errorShouldRetry).toBe(false);
  });

  it("normalizes retry-after metadata from Azure and Anthropic errors", () => {
    const azure = AzureOpenAIProvider.handleError({
      response: { headers: { "Retry-After": "20" }, text: "{}" },
    });
    const anthropic = AnthropicProvider.handleError({
      response: { headers: { "Retry-After": "20" } },
    });

    expect(azure.retryAfter).toBe(20);
    expect(anthropic.retryAfter).toBe(20);
  });

  it("exposes OpenAI-compatible helper behavior", () => {
    class Serializable {
      toObject() {
        return { x: 1 };
      }
    }

    expect(getOrNull({ a: 1 }, "a")).toBe(1);
    expect(getOrNull({}, "missing")).toBeNull();
    expect(coerceDict(new Serializable())).toEqual({ x: 1 });
    expect(modelSlug("openrouter/moonshotai/kimi-k2.6")).toBe("kimi-k2.6");
    expect(modelThinkingStyle("openrouter/moonshotai/kimi-k2.6")).toBe("thinking_type");
    expect(
      thinkingStylesFor({ thinkingStyle: "enable_thinking" }, "moonshotai/kimi-k2.6"),
    ).toEqual(["enable_thinking", "thinking_type"]);
    expect(thinkingExtraBody("enable_thinking", false)).toEqual({ enable_thinking: false });
    expect(gatewayReasoningExtraBody("reasoning_effort", "high")).toEqual({
      reasoning: { effort: "high" },
    });
    expect(usesOpenRouterAttribution({ name: "openrouter" }, null)).toBe(true);
    expect(deepMerge({ a: { b: 1 }, c: 1 }, { a: { d: 2 } })).toEqual({
      a: { b: 1, d: 2 },
      c: 1,
    });
    expect(mergeUniqueList([1, { a: 1 }], [{ a: 1 }, 2])).toEqual([1, { a: 1 }, 2]);
    expect(
      mergeResponsesExtraBody(
        { include: ["a"], tools: [{ name: "base" }] },
        { include: ["a", "b"], tools: [{ name: "extra" }], metadata: { user: "u" } },
      ),
    ).toEqual({
      include: ["a", "b"],
      tools: [{ name: "base" }, { name: "extra" }],
      metadata: { user: "u" },
    });
    expect(getNestedInt({ usage: { prompt_tokens: "12" } }, ["usage", "prompt_tokens"])).toBe(
      12,
    );
  });

  it("parses OpenAI compat timeout from environment", () => {
    const old = process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S;
    try {
      process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S = "2.5";
      expect(openaiCompatTimeoutS()).toBe(2.5);
      process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S = "-1";
      expect(floatEnv("MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S", 120)).toBe(120);
    } finally {
      if (old == null) delete process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S;
      else process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S = old;
    }
  });

  it.each([
    ["openai", { error: { code: "credit_balance_exhausted" } }, 429],
    [
      "openrouter",
      { error: { metadata: { error_type: "payment_required" } } },
      429,
    ],
    ["openrouter", { error: { type: "provider_error" } }, 402],
    ["deepseek", { error: { type: "provider_error" } }, 402],
    ["dashscope", { error: { code: "AllocationQuota.FreeTierOnly" } }, 403],
    ["zhipu", { error: { code: "1310" } }, 429],
    ["moonshot", { error: { type: "exceeded_current_quota_error" } }, 429],
    ["minimax", { base_resp: { status_code: 1008 } }, 400],
    ["stepfun", { error: { type: "provider_error" } }, 402],
    ["longcat", { error: { code: "insufficient_quota" } }, 429],
    ["qianfan", { error: { code: "account_overdue" } }, 403],
    ["qianfan", { error: { code: "coding_plan_week_quota_exceeded" } }, 429],
  ] as const)("classifies %s structured quota metadata", (provider, body, statusCode) => {
    const response = OpenAICompatProvider.handleError(
      providerError(body, statusCode),
      findByName(provider),
    );

    expect(response.errorCategory).toBe("quota_exhausted");
  });

  it("classifies MiniMax Anthropic nested quota metadata", () => {
    const response = AnthropicProvider.handleError(
      providerError({ base_resp: { status_code: 2056 } }, 400),
      "minimax_anthropic",
    );

    expect(response.errorCategory).toBe("quota_exhausted");
  });

  it("classifies MiniMax Anthropic quota metadata from a JSON body", () => {
    const error = providerError({}, 400);
    error.body = JSON.stringify({ base_resp: { status_code: 1008 } });

    const response = AnthropicProvider.handleError(error, "minimax_anthropic");

    expect(response.errorCategory).toBe("quota_exhausted");
  });

  it.each([
    ["anthropic", { error: { type: "billing_error" } }, 402],
    ["gemini", { error: { type: "RESOURCE_EXHAUSTED" } }, 429],
    ["dashscope", { error: { code: "insufficient_quota" } }, 429],
    ["zhipu", { error: { code: "1302" } }, 429],
    ["qianfan", { error: { code: "rpm_rate_limit_exceeded" } }, 429],
    ["siliconflow", { error: { type: "provider_error" } }, 403],
  ] as const)("does not classify ambiguous %s errors", (provider, body, statusCode) => {
    const response = OpenAICompatProvider.handleError(
      providerError(body, statusCode),
      findByName(provider),
    );

    expect(response.errorCategory).toBeNull();
  });

  it("does not infer a status-only quota signature from error text", () => {
    const error = new Error("provider returned 402 payment required");

    const response = OpenAICompatProvider.handleError(error, findByName("deepseek"));

    expect(response.errorStatusCode).toBe(402);
    expect(response.errorCategory).toBeNull();
  });
});
