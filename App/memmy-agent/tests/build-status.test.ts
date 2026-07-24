import { describe, expect, it } from "vitest";
import { CONTEXT_SAFETY_BUFFER_TOKENS, DEFAULT_MAX_TOKENS } from "../src/token-budget.js";
import { buildStatusContent } from "../src/utils/helpers.js";

describe("build status content", () => {
  it("uses the shared default completion reserve and safety margin", () => {
    const content = buildStatusContent({
      version: "0.1.0",
      model: "test",
      startTime: 1_000_000,
      lastUsage: {},
      contextWindowTokens: 200_000,
      sessionMsgCount: 0,
      contextTokensEstimate: 130_368,
    });

    expect(DEFAULT_MAX_TOKENS).toBe(65_536);
    expect(CONTEXT_SAFETY_BUFFER_TOKENS).toBe(4_096);
    expect(content).toContain("(100% of input budget)");
  });

  it("shows cache hit rate when cached tokens are present", () => {
    const content = buildStatusContent({
      version: "0.1.0",
      model: "glm-4-plus",
      startTime: 1_000_000,
      lastUsage: { prompt_tokens: 2000, completion_tokens: 300, cached_tokens: 1200 },
      contextWindowTokens: 128_000,
      sessionMsgCount: 10,
      contextTokensEstimate: 5000,
    });

    expect(content).toContain("60% cached");
    expect(content).toContain("2000 in / 300 out");
    expect(content).toContain("Tasks: 0 active");
  });

  it("omits cache info when cached tokens are missing", () => {
    const content = buildStatusContent({
      version: "0.1.0",
      model: "glm-4-plus",
      startTime: 1_000_000,
      lastUsage: { prompt_tokens: 2000, completion_tokens: 300 },
      contextWindowTokens: 128_000,
      sessionMsgCount: 10,
      contextTokensEstimate: 5000,
    });

    expect(content.toLowerCase()).not.toContain("cached");
    expect(content).toContain("2000 in / 300 out");
    expect(content).toContain("Tasks: 0 active");
  });

  it("omits cache info when cached tokens are zero", () => {
    const content = buildStatusContent({
      version: "0.1.0",
      model: "glm-4-plus",
      startTime: 1_000_000,
      lastUsage: { prompt_tokens: 2000, completion_tokens: 300, cached_tokens: 0 },
      contextWindowTokens: 128_000,
      sessionMsgCount: 10,
      contextTokensEstimate: 5000,
    });

    expect(content.toLowerCase()).not.toContain("cached");
  });

  it("shows 100 percent cached when all prompt tokens are cached", () => {
    const content = buildStatusContent({
      version: "0.1.0",
      model: "glm-4-plus",
      startTime: 1_000_000,
      lastUsage: { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 1000 },
      contextWindowTokens: 128_000,
      sessionMsgCount: 5,
      contextTokensEstimate: 3000,
    });

    expect(content).toContain("100% cached");
  });

  it("calculates context percentage against input budget", () => {
    const content = buildStatusContent({
      version: "0.1.0",
      model: "test",
      startTime: 1_000_000,
      lastUsage: { prompt_tokens: 2000, completion_tokens: 300 },
      contextWindowTokens: 128_000,
      sessionMsgCount: 10,
      contextTokensEstimate: 120_000,
      maxCompletionTokens: 8192,
    });

    expect(content).toContain("(103% of input budget)");
  });

  it("caps extreme context percentages at 999", () => {
    const content = buildStatusContent({
      version: "0.1.0",
      model: "test",
      startTime: 1_000_000,
      lastUsage: { prompt_tokens: 2000, completion_tokens: 300 },
      contextWindowTokens: 10_000,
      sessionMsgCount: 10,
      contextTokensEstimate: 100_000,
      maxCompletionTokens: 4096,
    });

    expect(content).toContain("(999% of input budget)");
  });
});
