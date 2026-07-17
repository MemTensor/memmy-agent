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
});
