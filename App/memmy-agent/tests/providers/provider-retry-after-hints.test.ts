import { describe, expect, it, vi } from "vitest";
import { LLMProvider, LLMResponse } from "../../src/providers/base.js";

describe("retry-after hints", () => {
  it("extracts retry-after values from response text", () => {
    expect(LLMProvider.extractRetryAfter('{"error":{"retry_after":20}}')).toBe(20);
    expect(LLMProvider.extractRetryAfter("Rate limit reached, please try again in 20s")).toBe(20);
    expect(LLMProvider.extractRetryAfter("please wait 2 minutes before retry")).toBe(120);
    expect(LLMProvider.extractRetryAfter("retry-after: 250ms")).toBe(0.25);
  });

  it("extracts retry-after values from headers", () => {
    expect(LLMProvider.extractRetryAfterFromHeaders({ "retry-after-ms": "250" })).toBe(0.25);
    expect(LLMProvider.extractRetryAfterFromHeaders({ "Retry-After": "20" })).toBe(20);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T00:00:00Z"));
    try {
      expect(
        LLMProvider.extractRetryAfterFromHeaders({
          "retry-after": "Thu, 28 May 2026 00:00:10 GMT",
        }),
      ).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers structured response retry hints", () => {
    expect(LLMProvider.extractRetryAfterFromResponse(new LLMResponse({ content: "retry after 30s", retryAfter: 5 }))).toBe(5);
    expect(
      LLMProvider.extractRetryAfterFromResponse(
        new LLMResponse({ content: "retry after 30s", errorRetryAfterS: 0.5 }),
      ),
    ).toBe(0.5);
  });
});
