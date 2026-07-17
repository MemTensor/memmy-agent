import { describe, expect, it } from "vitest";
import { ProvidersConfig } from "../../src/config/schema.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { PROVIDERS } from "../../src/providers/registry.js";

function spec(name: string): any {
  const found = PROVIDERS.find((item) => item.name === name);
  if (!found) throw new Error(`missing provider spec: ${name}`);
  return found;
}

function mimoProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    apiKey: "test-key",
    defaultModel: "mimo-v2.5-pro",
    spec: spec("xiaomi_mimo"),
  });
}

function openrouterProvider(defaultModel: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    apiKey: "sk-or-test",
    defaultModel,
    spec: spec("openrouter"),
  });
}

function simpleMessages(): Array<Record<string, any>> {
  return [{ role: "user", content: "hello" }];
}

function build(provider: OpenAICompatProvider, reasoningEffort: string | null): Record<string, any> {
  return provider.buildKwargs({
    messages: simpleMessages(),
    tools: null,
    model: null,
    maxTokens: 100,
    temperature: 0.7,
    reasoningEffort: reasoningEffort,
    toolChoice: null,
  });
}

describe("Xiaomi MiMo thinking", () => {
  it("exposes a xiaomi_mimo provider config field", () => {
    expect(new ProvidersConfig()).toHaveProperty("xiaomi_mimo");
  });

  it("declares MiMo's hosted thinking_type wire format", () => {
    const mimo = spec("xiaomi_mimo");

    expect(mimo.thinkingStyle).toBe("thinking_type");
    expect(mimo.backend).toBe("openai_compat");
    expect(mimo.defaultApiBase).toBe("https://api.xiaomimimo.com/v1");
  });

  it("declares OpenRouter's gateway reasoning style", () => {
    const openrouter = spec("openrouter");

    expect(openrouter.thinkingStyle).toBe("");
    expect(openrouter.gatewayReasoningStyle).toBe("reasoning_effort");
  });

  it("turns MiMo thinking off for reasoning_effort none", () => {
    const kwargs = build(mimoProvider(), "none");

    expect(kwargs).not.toHaveProperty("reasoning_effort");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "disabled" } });
  });

  it("turns MiMo thinking on for reasoning_effort medium", () => {
    const kwargs = build(mimoProvider(), "medium");

    expect(kwargs.reasoning_effort).toBe("medium");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" } });
  });

  it("turns MiMo thinking on for reasoning_effort low", () => {
    const kwargs = build(mimoProvider(), "low");

    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" } });
  });

  it("preserves MiMo provider defaults when reasoning_effort is unset", () => {
    const kwargs = build(mimoProvider(), null);

    expect(kwargs).not.toHaveProperty("reasoning_effort");
    expect(kwargs).not.toHaveProperty("extra_body");
  });

  it("sends both upstream MiMo and OpenRouter disable signals for MiMo via OpenRouter", () => {
    const kwargs = build(openrouterProvider("xiaomi/mimo-v2.5-pro"), "none");

    expect(kwargs).not.toHaveProperty("reasoning_effort");
    expect(kwargs.extra_body).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
  });

  it("sends both upstream MiMo and OpenRouter enable signals for MiMo via OpenRouter", () => {
    const kwargs = build(openrouterProvider("xiaomi/mimo-v2.5-pro"), "medium");

    expect(kwargs.reasoning_effort).toBe("medium");
    expect(kwargs.extra_body).toEqual({
      thinking: { type: "enabled" },
      reasoning: { effort: "medium" },
    });
  });

  it("matches bare MiMo model slugs on the OpenRouter path", () => {
    const kwargs = build(openrouterProvider("mimo-v2.5-pro"), "none");

    expect(kwargs.extra_body).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
  });

  it("does not inject thinking controls for MiMo flash via OpenRouter", () => {
    const kwargs = build(openrouterProvider("xiaomi/mimo-v2-flash"), "none");

    expect(kwargs).not.toHaveProperty("extra_body");
  });

  it("leaves unrelated OpenRouter models untouched for reasoning_effort none", () => {
    const kwargs = build(openrouterProvider("openai/gpt-4o"), "none");

    expect(kwargs).not.toHaveProperty("extra_body");
  });

  it("also injects OpenRouter reasoning controls for Kimi thinking models", () => {
    const kwargs = build(openrouterProvider("moonshotai/kimi-k2.5"), "none");

    expect(kwargs.extra_body).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
  });
});
