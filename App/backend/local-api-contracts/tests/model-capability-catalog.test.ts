import { describe, expect, it } from "vitest";
import {
  CloudModelCapabilitySchema,
  ModelCapabilityCatalogSchema,
  ModelCapabilityCatalogRefreshResultSchema,
  MODEL_CAPABILITY_CATALOG_MAX_SAFE_INTEGER,
  MODEL_CAPABILITY_CATALOG_MAX_TOKENS
} from "../src/model-capability-catalog.js";

const thinking = {
  switchable: true,
  defaultEnabled: true,
  levels: ["low", "medium", "high", "xhigh", "max"],
  defaultLevel: "medium"
} as const;

describe("model catalog refresh result", () => {
  it.each([
    { status: "synced", hasValidCatalog: true, catalogVersion: 21 },
    { status: "retries-exhausted", hasValidCatalog: true, catalogVersion: 21 },
    { status: "retries-exhausted", hasValidCatalog: false },
    { status: "unauthenticated", hasValidCatalog: false },
    { status: "stopped", hasValidCatalog: false }
  ])("accepts an explicit synchronization outcome: %j", (result) => {
    expect(ModelCapabilityCatalogRefreshResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    { status: "synced", hasValidCatalog: false },
    { status: "retries-exhausted", hasValidCatalog: true },
    { status: "retries-exhausted", hasValidCatalog: false, catalogVersion: 21 },
    { status: "retries-exhausted", hasValidCatalog: true, catalogVersion: 0 }
  ])("rejects inconsistent availability and version: %j", (result) => {
    expect(ModelCapabilityCatalogRefreshResultSchema.safeParse(result).success).toBe(false);
  });
});

const catalog = {
  catalogVersion: 1,
  models: {
    "gpt-6-astra": {
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_050_000,
      maxTokens: 128_000,
      thinking: { ...thinking, switchable: false }
    },
    "gpt-6-sol": {
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_050_000,
      maxTokens: 128_000,
      thinking
    },
    "gpt-5.6-sol": {
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_050_000,
      maxTokens: 128_000,
      thinking: { ...thinking, defaultLevel: "high" }
    },
    "gpt-5.5": {
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_050_000,
      maxTokens: 128_000,
      thinking: { ...thinking, levels: ["low", "medium", "high", "xhigh"] }
    },
    "gpt-5.4-mini": {
      inputModalities: ["text", "image"],
      contextWindowTokens: 400_000,
      maxTokens: 128_000,
      thinking: { ...thinking, levels: ["low", "medium", "high"] }
    },
    "gpt-4.1": {
      inputModalities: ["text", "image"],
      contextWindowTokens: 1_047_576,
      maxTokens: 32_768
    },
    "gpt-4o": {
      inputModalities: ["text", "image"],
      contextWindowTokens: 128_000,
      maxTokens: 16_384
    }
  }
};

describe("model capability catalog contract", () => {
  it("accepts the seven real GPT seed configurations and preserves omissions", () => {
    const parsed = ModelCapabilityCatalogSchema.parse(catalog);
    expect(Object.keys(parsed.models)).toHaveLength(7);
    expect(parsed.models["gpt-6-astra"]?.thinking?.switchable).toBe(false);
    expect(parsed.models["gpt-4o"]).not.toHaveProperty("thinking");
  });

  it("accepts toggle-only thinking without a default level", () => {
    expect(CloudModelCapabilitySchema.parse({
      inputModalities: ["text"],
      contextWindowTokens: 32_768,
      maxTokens: 4_096,
      thinking: { switchable: true, defaultEnabled: true, levels: [] }
    }).thinking).toEqual({ switchable: true, defaultEnabled: true, levels: [] });
  });

  it.each([
    ["thinking: null", { thinking: null }],
    ["thinking unknown field", { thinking: { ...thinking, supported: true } }],
    ["default level null", { thinking: { ...thinking, defaultLevel: null } }],
    ["default level not listed", { thinking: { ...thinking, levels: ["low"], defaultLevel: "medium" } }],
    ["empty levels with default", { thinking: { ...thinking, levels: [], defaultLevel: "medium" } }],
    ["always-on disabled", { thinking: { ...thinking, switchable: false, defaultEnabled: false } }],
    ["invalid level", { thinking: { ...thinking, levels: ["off"] } }],
    ["numeric token string", { maxTokens: "128000" }],
    ["fractional token", { maxTokens: 1.5 }],
    ["max token is not below context", { contextWindowTokens: 4_096, maxTokens: 4_096 }],
    ["invalid input modality", { inputModalities: ["audio"] }],
    ["empty input modalities", { inputModalities: [] }]
  ])("rejects %s", (_label, patch) => {
    const model = { ...catalog.models["gpt-6-sol"], ...patch };
    expect(CloudModelCapabilitySchema.safeParse(model).success).toBe(false);
  });

  it("rejects an invalid model name key or any invalid model in the whole package", () => {
    expect(ModelCapabilityCatalogSchema.safeParse({
      ...catalog,
      models: { ...catalog.models, " gpt-invalid": catalog.models["gpt-4o"] }
    }).success).toBe(false);
    expect(ModelCapabilityCatalogSchema.safeParse({
      ...catalog,
      models: { ...catalog.models, broken: { ...catalog.models["gpt-4o"], maxTokens: 128_000 } }
    }).success).toBe(false);
  });

  it("enforces the unsigned token and JavaScript-safe version bounds", () => {
    expect(ModelCapabilityCatalogSchema.safeParse({
      catalogVersion: MODEL_CAPABILITY_CATALOG_MAX_SAFE_INTEGER,
      models: {
        boundary: {
          inputModalities: ["text"],
          contextWindowTokens: MODEL_CAPABILITY_CATALOG_MAX_TOKENS,
          maxTokens: MODEL_CAPABILITY_CATALOG_MAX_TOKENS - 1
        }
      }
    }).success).toBe(true);
    expect(ModelCapabilityCatalogSchema.safeParse({ ...catalog, catalogVersion: MODEL_CAPABILITY_CATALOG_MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(CloudModelCapabilitySchema.safeParse({
      inputModalities: ["text"],
      contextWindowTokens: MODEL_CAPABILITY_CATALOG_MAX_TOKENS,
      maxTokens: MODEL_CAPABILITY_CATALOG_MAX_TOKENS
    }).success).toBe(false);
  });
});
