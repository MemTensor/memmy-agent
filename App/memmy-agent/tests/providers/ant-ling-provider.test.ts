import { describe, expect, it } from "vitest";
import { Config, ProvidersConfig } from "../../src/config/schema.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { PROVIDERS, findByName } from "../../src/providers/registry.js";

describe("Ant Ling provider", () => {
  it("has an Ant Ling config field", () => {
    const config = new ProvidersConfig();

    expect(config.ant_ling).toBeDefined();
  });

  it("registers Ant Ling as an OpenAI-compatible provider", () => {
    const specs = Object.fromEntries(PROVIDERS.map((spec) => [spec.name, spec]));

    expect(specs.ant_ling).toBeDefined();
    expect(specs.ant_ling.backend).toBe("openai_compat");
    expect(specs.ant_ling.envKey).toBe("ANT_LING_API_KEY");
    expect(specs.ant_ling.displayName).toBe("Ant Ling");
    expect(specs.ant_ling.defaultApiBase).toBe("https://api.ant-ling.com/v1");
  });

  it("finds Ant Ling by snake, kebab, and camel case names", () => {
    const spec = findByName("ant_ling");

    expect(spec).not.toBeNull();
    expect(findByName("ant-ling")).toBe(spec);
    expect(findByName("antLing")).toBe(spec);
  });

  it("auto-matches Ling models with the default API base", () => {
    const config = Config.fromObject({
      providers: {
        antLing: {
          apiKey: "ling-key",
        },
      },
      agents: {
        defaults: {
          model: "Ling-2.6-flash",
        },
      },
    });

    expect(config.getProviderName("Ling-2.6-flash")).toBe("ant_ling");
    expect(config.getApiKey("Ling-2.6-flash")).toBe("ling-key");
    expect(config.getApiBase("Ling-2.6-flash")).toBe("https://api.ant-ling.com/v1");
  });

  it("preserves the official Ant Ling model name", () => {
    const spec = findByName("ant_ling");
    const provider = new OpenAICompatProvider("ling-key", null, "Ling-2.6-flash", spec);

    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      tools: null,
      model: "Ling-2.6-flash",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
      toolChoice: null,
    });

    expect(kwargs.model).toBe("Ling-2.6-flash");
  });
});
