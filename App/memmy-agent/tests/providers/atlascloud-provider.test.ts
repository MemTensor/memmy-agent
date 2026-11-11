import { describe, expect, it } from "vitest";
import { Config, ProvidersConfig } from "../../src/config/schema.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { PROVIDERS, findByName } from "../../src/providers/registry.js";

describe("Atlas Cloud provider", () => {
  it("has a Atlas Cloud config field", () => {
    const config = new ProvidersConfig();

    expect(config.atlascloud).toBeDefined();
  });

  it("registers Atlas Cloud as an OpenAI-compatible gateway", () => {
    const specs = Object.fromEntries(PROVIDERS.map((spec) => [spec.name, spec]));

    expect(specs.atlascloud).toBeDefined();
    expect(specs.atlascloud.backend).toBe("openai_compat");
    expect(specs.atlascloud.envKey).toBe("ATLASCLOUD_API_KEY");
    expect(specs.atlascloud.displayName).toBe("Atlas Cloud");
    expect(specs.atlascloud.isGateway).toBe(true);
    expect(specs.atlascloud.detectByBaseKeyword).toBe("atlascloud");
    expect(specs.atlascloud.defaultApiBase).toBe("https://api.atlascloud.ai/v1");
    expect(specs.atlascloud.stripModelPrefix).toBe(false);
  });

  it("finds Atlas Cloud by provider name", () => {
    const spec = findByName("atlascloud");

    expect(spec).not.toBeNull();
    expect(spec?.name).toBe("atlascloud");
  });

  it("uses the default API base when Atlas Cloud is forced", () => {
    const config = Config.fromObject({
      providers: {
        atlascloud: {
          apiKey: "atlascloud-key",
        },
      },
      agents: {
        defaults: {
          model: "deepseek-ai/deepseek-v4-flash",
          provider: "atlascloud",
        },
      },
    });

    expect(config.getProviderName("deepseek-ai/deepseek-v4-flash")).toBe("atlascloud");
    expect(config.getApiKey("deepseek-ai/deepseek-v4-flash")).toBe("atlascloud-key");
    expect(config.getApiBase("deepseek-ai/deepseek-v4-flash")).toBe("https://api.atlascloud.ai/v1");
  });

  it("routes unprefixed models through the Atlas Cloud gateway when configured", () => {
    const config = Config.fromObject({
      providers: {
        atlascloud: {
          apiKey: "atlascloud-key",
        },
      },
      agents: {
        defaults: {
          model: "deepseek-ai/deepseek-v4-flash",
        },
      },
    });

    expect(config.getProviderName("deepseek-ai/deepseek-v4-flash")).toBe("atlascloud");
    expect(config.getApiKey("deepseek-ai/deepseek-v4-flash")).toBe("atlascloud-key");
    expect(config.getApiBase("deepseek-ai/deepseek-v4-flash")).toBe("https://api.atlascloud.ai/v1");
  });

  it("preserves the Atlas Cloud model API id in OpenAI-compatible kwargs", () => {
    const spec = findByName("atlascloud");
    const provider = new OpenAICompatProvider(
      "atlascloud-key",
      null,
      "deepseek-ai/deepseek-v4-flash",
      spec,
    );

    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      tools: null,
      model: "deepseek-ai/deepseek-v4-flash",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
      toolChoice: null,
    });

    expect(kwargs.model).toBe("deepseek-ai/deepseek-v4-flash");
    expect(kwargs.max_tokens).toBe(1024);
    expect(kwargs).not.toHaveProperty("max_completion_tokens");
  });
});
