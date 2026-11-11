import { describe, expect, it } from "vitest";
import { CatalogEndpointInputSchema, CatalogEndpointViewSchema, ModelConfigTestInputSchema } from "../src/index.js";
import { resolveAssignedModel, type RuntimeModelCatalog } from "../src/model-catalog-resolver.js";
import { resolveAssignedModel as resolveMemoryModel } from "../../../../Memory/src/contracts/model-catalog-resolver.js";

function catalog(): RuntimeModelCatalog {
  return {
    providers: { openai: {
      apiKey: "unrelated-cloud-key", extraHeaders: { Authorization: "unrelated-header", "X-Cloud": "cloud" },
      extraBody: { model: "unrelated-model", temperature: 0.9 },
      endpoints: { memory: { apiBase: "http://127.0.0.1:1234/v1", protocol: "openai-chat-completions" } }
    } },
    modelPresets: { memory: { provider: "openai", endpoint: "memory", model: "own-model", source: "byok", capabilities: ["memory_summary"] } },
    modelAssignments: { byok: { memorySummary: "memory" } }
  };
}

describe.each([["shared", resolveAssignedModel], ["standalone Memory", resolveMemoryModel]] as const)("%s endpoint inheritance", (_label, resolve) => {
  it.each([undefined, "", "own-key"])("keeps an independent endpoint's own credential (%s) and request options", key => {
    const c = catalog(), e = c.providers!.openai!.endpoints!.memory!;
    Object.assign(e, { inheritProviderDefaults: false, extraHeaders: { "X-Own": "own" }, extraBody: { seed: 7 } });
    if (key !== undefined) e.apiKey = key;
    const before = structuredClone(c);
    const r = resolve({ catalog: c, mode: "byok", capability: "memory_summary" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.apiKey).toBe(key || undefined);
    expect(r.provider.extraHeaders).toEqual({ "X-Own": "own" });
    expect(r.provider.extraBody).toEqual({ seed: 7 });
    expect(c).toEqual(before);
    c.providers!.openai!.apiKey = "rotated-cloud-key";
    c.providers!.openai!.extraHeaders = { Authorization: "rotated-header" };
    expect(resolve({ catalog: c, mode: "byok", capability: "memory_summary" })).toEqual(r);
  });

  it.each([undefined, true])("preserves inherited defaults and later credential rotation (%s)", flag => {
    const c = catalog(), e = c.providers!.openai!.endpoints!.memory!;
    if (flag !== undefined) Object.assign(e, { inheritProviderDefaults: flag });
    e.extraHeaders = { "X-Own": "own" }; e.extraBody = { seed: 7 };
    const r = resolve({ catalog: c, mode: "byok", capability: "memory_summary" });
    expect(r.ok && r.provider.apiKey).toBe("unrelated-cloud-key");
    expect(r.ok && r.provider.extraHeaders).toEqual({ Authorization: "unrelated-header", "X-Cloud": "cloud", "X-Own": "own" });
    expect(r.ok && r.provider.extraBody).toEqual({ model: "unrelated-model", temperature: 0.9, seed: 7 });
    c.providers!.openai!.apiKey = "rotated-key";
    const rotated = resolve({ catalog: c, mode: "byok", capability: "memory_summary" });
    expect(rotated.ok && rotated.provider.apiKey).toBe("rotated-key");
  });

  it.each([null, "false", 0])("rejects malformed inheritance configuration (%s)", flag => {
    const c = catalog(); Object.assign(c.providers!.openai!.endpoints!.memory!, { inheritProviderDefaults: flag });
    expect(resolve({ catalog: c, mode: "byok", capability: "memory_summary" })).toEqual({ ok: false, code: "model_selection_unavailable" });
  });
});

it("retains the optional false flag in catalog and connection-test API round trips", () => {
  const endpoint = { endpointId: "memory", apiBase: "http://127.0.0.1:1234/v1", protocol: "openai-chat-completions", inheritProviderDefaults: false };
  expect(CatalogEndpointInputSchema.parse(endpoint)).toHaveProperty("inheritProviderDefaults", false);
  expect(CatalogEndpointViewSchema.parse({ ...endpoint, hasApiKey: false, apiKeyMasked: "" })).toHaveProperty("inheritProviderDefaults", false);
  expect(ModelConfigTestInputSchema.parse({ ...endpoint, provider: "openai_compatible", modelId: "own-model" })).toHaveProperty("inheritProviderDefaults", false);
  expect(CatalogEndpointInputSchema.safeParse({ ...endpoint, inheritProviderDefaults: "false" }).success).toBe(false);
});
