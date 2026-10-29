import { describe, expect, it } from "vitest";
import { syncMemoryModelCatalog } from "../src/config/model-catalog.js";
import { resolveAssignedModel, type RuntimeModelCatalog } from "../src/contracts/model-catalog-resolver.js";

describe("Memory settings preserve independent endpoint options", () => {
  it.each(["summary", "evolution", "embedding"] as const)("isolates %s without changing existing cloud defaults", role => {
    const root: Record<string, any> = {
      app: { userMode: "byok" }, providers: { openai: { apiKey: "cloud-key", extraHeaders: { Authorization: "cloud-header" }, extraBody: { model: "cloud-model" },
        endpoints: { cloud: { apiBase: "https://cloud.example.test/v1", protocol: role === "embedding" ? "openai-embeddings" : "openai-chat-completions" } } } },
      modelPresets: {}, modelAssignments: { byok: {} }
    };
    const original = structuredClone(root.providers.openai);
    const connection = { provider: "openai_compatible", endpoint: "http://127.0.0.1:1234/v1", model: "own-model", extraHeaders: { "X-Own": "own" }, extraBody: { seed: 7 }, ...(role === "embedding" ? { mode: "custom" } : {}) };
    const memory: Record<string, any> = { roleRouting: { summary: "fixed", evolution: "fixed" }, [role]: connection };
    syncMemoryModelCatalog(root, memory, { [role]: connection });
    const field = role === "summary" ? "memorySummary" : role === "evolution" ? "memoryEvolution" : "embedding";
    const id = root.modelAssignments.byok[field], preset = root.modelPresets[id];
    const endpoint = root.providers.openai.endpoints[preset.endpoint];
    expect(endpoint.inheritProviderDefaults).toBe(false);
    const r = resolveAssignedModel({ catalog: root as RuntimeModelCatalog, mode: "byok", capability: role === "summary" ? "memory_summary" : role === "evolution" ? "memory_evolution" : "embedding" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider.apiKey).toBeUndefined();
      expect(r.provider.extraHeaders).toEqual(connection.extraHeaders);
      expect(r.provider.extraBody).toEqual(connection.extraBody);
    }
    expect({ ...root.providers.openai, endpoints: original.endpoints }).toEqual(original);
    const once = structuredClone(root);
    syncMemoryModelCatalog(root, memory, { [role]: connection });
    expect(root).toEqual(once);
  });
  it("does not reuse a currently equal inherited endpoint that may rotate later", () => {
    const connection = { provider: "openai_compatible", endpoint: "https://custom.example.test/v1", model: "custom-model", apiKey: "initial-key" };
    const root: Record<string, any> = {
      providers: { openai: { apiKey: "initial-key", endpoints: {
        inherited: { apiBase: connection.endpoint, protocol: "openai-chat-completions" },
      } } },
      modelPresets: { existing: { provider: "openai", endpoint: "inherited", model: connection.model, source: "byok", capabilities: ["memory_summary"] } },
      modelAssignments: { byok: { memorySummary: "existing" } },
    };
    const memory = { roleRouting: { summary: "fixed" }, summary: connection };
    syncMemoryModelCatalog(root, memory, { summary: connection });
    const id = root.modelAssignments.byok.memorySummary;
    expect(id).not.toBe("existing");
    root.providers.openai.apiKey = "rotated-key";
    const saved = resolveAssignedModel({ catalog: root as RuntimeModelCatalog, mode: "byok", capability: "memory_summary" });
    expect(saved.ok && saved.provider.apiKey).toBe("initial-key");
    const inherited = resolveAssignedModel({ catalog: { ...root, modelAssignments: { byok: { memorySummary: "existing" } } } as RuntimeModelCatalog, mode: "byok", capability: "memory_summary" });
    expect(inherited.ok && inherited.provider.apiKey).toBe("rotated-key");
    const once = structuredClone(root);
    syncMemoryModelCatalog(root, memory, { summary: connection });
    expect(root).toEqual(once);
  });

});
