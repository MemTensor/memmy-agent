import { describe, expect, it } from "vitest";
import { normalizeByokTokenUsage } from "../../../src/integrations/byok-token-usage/normalizer.js";

describe("normalizeByokTokenUsage", () => {
  it("normalizes prompt, completion, total, cache read, and cache creation tokens", () => {
    const usage = normalizeByokTokenUsage({
      prompt_tokens: 123.9,
      completion_tokens: "45",
      total_tokens: 200,
      cached_tokens: 67,
      cache_creation_input_tokens: "8",
    });

    expect(usage).toMatchObject({
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 200,
      cachedInputTokens: 67,
      cacheCreationInputTokens: 8,
    });
    expect(usage?.rawUsage).toMatchObject({
      prompt_tokens: 123.9,
      completion_tokens: "45",
    });
  });

  it("falls back total tokens to input plus output", () => {
    expect(normalizeByokTokenUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
    })).toMatchObject({
      totalTokens: 15,
    });
  });

  it("prefers cached_tokens and falls back to cache_read_input_tokens when cached_tokens is empty", () => {
    expect(normalizeByokTokenUsage({
      prompt_tokens: 1,
      cached_tokens: 12,
      cache_read_input_tokens: 34,
    })).toMatchObject({
      cachedInputTokens: 12,
    });
    expect(normalizeByokTokenUsage({
      prompt_tokens: 1,
      cached_tokens: 0,
      cache_read_input_tokens: 34,
    })).toMatchObject({
      cachedInputTokens: 34,
    });
  });

  it("returns null when every normalized token field is zero", () => {
    expect(normalizeByokTokenUsage({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      cache_creation_input_tokens: 0,
    })).toBeNull();
  });
});
