import { describe, expect, it } from "vitest";
import { Config, ProvidersConfig } from "../../src/config/schema.js";
import { PROVIDERS, findByName } from "../../src/providers/registry.js";

describe("LongCat provider", () => {
  it("has a LongCat config field", () => {
    const config = new ProvidersConfig();

    expect(config.longcat).toBeDefined();
  });

  it("registers LongCat as an OpenAI-compatible provider", () => {
    const specs = Object.fromEntries(PROVIDERS.map((spec) => [spec.name, spec]));

    expect(specs.longcat).toBeDefined();
    expect(specs.longcat.backend).toBe("openai_compat");
    expect(specs.longcat.envKey).toBe("LONGCAT_API_KEY");
    expect(specs.longcat.defaultApiBase).toBe("https://api.longcat.chat/openai/v1");
  });

  it("finds LongCat by provider name", () => {
    const spec = findByName("longcat");

    expect(spec).not.toBeNull();
    expect(spec?.name).toBe("longcat");
  });

  it("detects LongCat models and supplies the default API base", () => {
    const config = new Config({
      agents: { defaults: { provider: "auto", model: "longcat/LongCat-Flash-Chat" } },
      providers: { longcat: { apiKey: "key" } },
    });

    expect(config.getProviderName()).toBe("longcat");
    expect(config.getApiBase()).toBe("https://api.longcat.chat/openai/v1");
  });
});
