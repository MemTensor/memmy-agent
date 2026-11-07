import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";

describe("Anthropic request model IDs", () => {
  it.each([
    ["anthropic/claude-sonnet-test", "claude-sonnet-test"],
    ["claude-sonnet-test", "claude-sonnet-test"],
    ["gateway/anthropic/claude-sonnet-test", "gateway/anthropic/claude-sonnet-test"],
    ["deepseek/deepseek-flash", "deepseek/deepseek-flash"],
    ["anthropic/anthropic/claude-sonnet-test", "anthropic/claude-sonnet-test"],
    ["Anthropic/claude-sonnet-test", "Anthropic/claude-sonnet-test"]
  ])("preserves the runtime rule for %s", (model, expected) => {
    const provider = new AnthropicProvider({ apiKey: "fake-test-key", defaultModel: model });
    expect(provider.buildKwargs({ messages: [{ role: "user", content: "OK" }], model }).model).toBe(expected);
    expect(AnthropicProvider.stripPrefix(model)).toBe(expected);
    expect(provider.defaultModel).toBe(model);
  });
});
