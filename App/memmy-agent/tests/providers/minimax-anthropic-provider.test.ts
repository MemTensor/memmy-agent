import { describe, expect, it } from "vitest";
import { ProvidersConfig } from "../../src/config/schema.js";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { makeProvider } from "../../src/providers/factory.js";
import { findByName, PROVIDERS } from "../../src/providers/registry.js";

describe("MiniMax Anthropic provider", () => {
  it("exposes a minimax_anthropic provider config field", () => {
    expect(new ProvidersConfig().minimax_anthropic).toBeDefined();
  });

  it("registers the MiniMax Anthropic provider spec", () => {
    const specs = Object.fromEntries(PROVIDERS.map((spec) => [spec.name, spec]));

    expect(specs.minimax_anthropic).toBeDefined();
    expect(specs.minimax_anthropic.envKey).toBe("MINIMAX_API_KEY");
    expect(specs.minimax_anthropic.backend).toBe("anthropic");
    expect(specs.minimax_anthropic.defaultApiBase).toBe("https://api.minimax.io/anthropic");
  });

  it("routes minimax_anthropic through the Anthropic backend", () => {
    const spec = findByName("minimax_anthropic");
    const provider = makeProvider("minimax_anthropic", "minimax_anthropic/claude-compatible");

    expect(spec?.backend).toBe("anthropic");
    expect(spec?.defaultApiBase).toBe("https://api.minimax.io/anthropic");
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });
});

describe("MiniMax regional endpoints and thinking", () => {
  it("exposes China provider defaults", () => {
    expect(findByName("minimax_cn")?.defaultApiBase).toBe("https://api.minimaxi.com/v1");
    expect(findByName("minimax_anthropic_cn")?.defaultApiBase).toBe("https://api.minimaxi.com/anthropic");
    expect(findByName("minimax_anthropic_cn")?.backend).toBe("anthropic");
    expect(new ProvidersConfig().minimax_cn).toBeDefined();
    expect(new ProvidersConfig().minimax_anthropic_cn).toBeDefined();
  });
  it.each([["medium", "adaptive"], ["adaptive", "adaptive"], ["none", "disabled"], ["minimal", "disabled"], ["minimum", "disabled"], ["MINIMAL", "disabled"]])("maps %s to %s", (effort, mode) => {
    const provider = new AnthropicProvider({ apiKey: "test-key", defaultModel: "MiniMax-M3" });
    const args = provider.buildKwargs({ messages: [{ role: "user", content: "hi" }], reasoningEffort: effort });
    expect(args.thinking).toEqual({ type: mode });
  });
  it("preserves forced tool choice when thinking is disabled", () => {
    const provider = new AnthropicProvider({ apiKey: "test-key", defaultModel: "MiniMax-M3" });
    const args = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "minimal",
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
      toolChoice: "required",
    });
    expect(args.thinking).toEqual({ type: "disabled" });
    expect(args.tool_choice).toEqual({ type: "any" });
  });
});
