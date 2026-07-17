import { describe, expect, it } from "vitest";
import { Config, ProvidersConfig } from "../../src/config/schema.js";
import { findByName, PROVIDERS } from "../../src/providers/registry.js";

describe("Mistral provider", () => {
  it("exposes a mistral provider config field", () => {
    expect(new ProvidersConfig().mistral).toBeDefined();
  });

  it("registers the Mistral provider spec", () => {
    const specs = Object.fromEntries(PROVIDERS.map((spec) => [spec.name, spec]));

    expect(specs.mistral).toBeDefined();
    expect(specs.mistral.envKey).toBe("MISTRAL_API_KEY");
    expect(specs.mistral.defaultApiBase).toBe("https://api.mistral.ai/v1");
  });

  it("matches Mistral models and default endpoint", () => {
    const config = new Config({
      agents: { defaults: { model: "mistral/mistral-large-latest" } },
      providers: { mistral: { apiKey: "key" } },
    });

    expect(config.getProviderName()).toBe("mistral");
    expect(config.getApiBase()).toBe("https://api.mistral.ai/v1");
    expect(findByName("mistral")?.envKey).toBe("MISTRAL_API_KEY");
  });
});
