import { describe, expect, it } from "vitest";
import { Config, ProvidersConfig } from "../../src/config/schema.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { PROVIDERS, findByName } from "../../src/providers/registry.js";

describe("Skywork provider", () => {
  it("has a Skywork config field", () => {
    const config = new ProvidersConfig();

    expect(config.skywork).toBeDefined();
  });

  it("registers Skywork as an OpenAI-compatible gateway", () => {
    const specs = Object.fromEntries(PROVIDERS.map((spec) => [spec.name, spec]));

    expect(specs.skywork).toBeDefined();
    expect(specs.skywork.backend).toBe("openai_compat");
    expect(specs.skywork.envKey).toBe("SKYWORK_API_KEY");
    expect(specs.skywork.envExtras).toContainEqual(["APIFREE_API_KEY", "{apiKey}"]);
    expect(specs.skywork.displayName).toBe("Skywork");
    expect(specs.skywork.isGateway).toBe(true);
    expect(specs.skywork.detectByBaseKeyword).toBe("apifree.ai");
    expect(specs.skywork.defaultApiBase).toBe("https://api.apifree.ai/agent/v1");
    expect(specs.skywork.supportsMaxCompletionTokens).toBe(false);
  });

  it("finds Skywork by provider name", () => {
    const spec = findByName("skywork");

    expect(spec).not.toBeNull();
    expect(spec?.name).toBe("skywork");
  });

  it("auto-matches Skywork models with the default API base", () => {
    const config = Config.fromObject({
      providers: {
        skywork: {
          apiKey: "sky-key",
        },
      },
      agents: {
        defaults: {
          model: "skywork-ai/skyclaw-v1",
        },
      },
    });

    expect(config.getProviderName("skywork-ai/skyclaw-v1")).toBe("skywork");
    expect(config.getApiKey("skywork-ai/skyclaw-v1")).toBe("sky-key");
    expect(config.getApiBase("skywork-ai/skyclaw-v1")).toBe("https://api.apifree.ai/agent/v1");
  });

  it("preserves the model id and uses chat completion max_tokens", () => {
    const spec = findByName("skywork");
    const provider = new OpenAICompatProvider("sky-key", null, "skywork-ai/skyclaw-v1", spec);

    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      tools: null,
      model: "skywork-ai/skyclaw-v1",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
      toolChoice: null,
    });

    expect(kwargs.model).toBe("skywork-ai/skyclaw-v1");
    expect(kwargs.max_tokens).toBe(1024);
    expect(kwargs).not.toHaveProperty("max_completion_tokens");
  });
});
