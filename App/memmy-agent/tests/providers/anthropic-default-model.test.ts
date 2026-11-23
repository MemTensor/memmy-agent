import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";

// Anthropic retired claude-sonnet-4-20250514 on 2026-06-15:
// https://platform.claude.com/docs/en/about-claude/model-deprecations
const RETIRED = ["claude-sonnet-4-20250514", "claude-opus-4-20250514"];

describe("AnthropicProvider default model", () => {
  it("falls back to a model Anthropic still serves when none is configured", () => {
    const provider = new AnthropicProvider("test-key");
    expect(RETIRED).not.toContain(provider.getDefaultModel());
  });

  it("keeps a configured model", () => {
    const provider = new AnthropicProvider({ apiKey: "test-key", defaultModel: "claude-opus-5-5" });
    expect(provider.getDefaultModel()).toBe("claude-opus-5-5");
  });
});
