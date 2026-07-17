import { describe, expect, it } from "vitest";
import { Config, ProvidersConfig } from "../../src/config/schema.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { PROVIDERS, findByName } from "../../src/providers/registry.js";

describe("Novita provider", () => {
  it("has a Novita config field", () => {
    const config = new ProvidersConfig();

    expect(config.novita).toBeDefined();
  });

  it("registers Novita as an OpenAI-compatible gateway", () => {
    const specs = Object.fromEntries(PROVIDERS.map((spec) => [spec.name, spec]));

    expect(specs.novita).toBeDefined();
    expect(specs.novita.backend).toBe("openai_compat");
    expect(specs.novita.envKey).toBe("NOVITA_API_KEY");
    expect(specs.novita.displayName).toBe("Novita AI");
    expect(specs.novita.isGateway).toBe(true);
    expect(specs.novita.detectByBaseKeyword).toBe("novita");
    expect(specs.novita.defaultApiBase).toBe("https://api.novita.ai/openai");
    expect(specs.novita.stripModelPrefix).toBe(false);
  });

  it("finds Novita by provider name", () => {
    const spec = findByName("novita");

    expect(spec).not.toBeNull();
    expect(spec?.name).toBe("novita");
  });

  it("uses the default API base when Novita is forced", () => {
    const config = Config.fromObject({
      providers: {
        novita: {
          apiKey: "novita-key",
        },
      },
      agents: {
        defaults: {
          model: "deepseek-v4-pro",
          provider: "novita",
        },
      },
    });

    expect(config.getProviderName("deepseek-v4-pro")).toBe("novita");
    expect(config.getApiKey("deepseek-v4-pro")).toBe("novita-key");
    expect(config.getApiBase("deepseek-v4-pro")).toBe("https://api.novita.ai/openai");
  });

  it("routes unprefixed models through the Novita gateway when configured", () => {
    const config = Config.fromObject({
      providers: {
        novita: {
          apiKey: "novita-key",
        },
      },
      agents: {
        defaults: {
          model: "deepseek-v4-pro",
        },
      },
    });

    expect(config.getProviderName("deepseek-v4-pro")).toBe("novita");
    expect(config.getApiKey("deepseek-v4-pro")).toBe("novita-key");
    expect(config.getApiBase("deepseek-v4-pro")).toBe("https://api.novita.ai/openai");
  });

  it("preserves the Novita model API id in OpenAI-compatible kwargs", () => {
    const spec = findByName("novita");
    const provider = new OpenAICompatProvider("novita-key", null, "deepseek-v4-pro", spec);

    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      tools: null,
      model: "deepseek-v4-pro",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
      toolChoice: null,
    });

    expect(kwargs.model).toBe("deepseek-v4-pro");
    expect(kwargs.max_tokens).toBe(1024);
    expect(kwargs).not.toHaveProperty("max_completion_tokens");
  });
});
