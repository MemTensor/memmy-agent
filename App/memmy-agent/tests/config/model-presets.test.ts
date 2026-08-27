import { describe, expect, it } from "vitest";
import { Config, ModelEndpointConfig, ModelPresetConfig, ProviderConfig } from "../../src/config/schema.js";

const currentCatalog = () => ({
  providers: {
    openai: {
      apiKey: "sk-test",
      futureProviderField: "keep",
      endpoints: {
        chat: {
          apiBase: "https://api.example.test/v1",
          protocol: "openai-chat-completions",
          futureEndpointField: "keep",
        },
        embedding: {
          apiBase: "https://api.example.test/v1",
          protocol: "openai-embeddings",
        },
      },
    },
  },
  modelPresets: {
    chat: {
      endpoint: "chat",
      model: "gpt-5",
      provider: "openai",
      source: "byok",
      capabilities: ["agent", "memory_summary", "memory_evolution"],
      futurePresetField: "keep",
    },
    embedding: {
      endpoint: "embedding",
      model: "text-embedding-3-small",
      provider: "openai",
      source: "byok",
      capabilities: ["embedding"],
    },
  },
  modelAssignments: {
    byok: {
      agent: { candidates: ["chat"], default: "chat" },
      memorySummary: "chat",
      memoryEvolution: "chat",
      embedding: "embedding",
      asr: null,
      imageGeneration: null,
    },
    account: {
      agent: { candidates: ["chat"], default: "chat" },
      memorySummary: null,
      memoryEvolution: null,
      embedding: null,
      asr: null,
      imageGeneration: null,
    },
  },
});

describe("current model catalog schema", () => {
  it("round-trips endpoints, preset contracts, assignments, and nested future fields", () => {
    const saved = Config.fromObject(currentCatalog()).toObject();
    expect(saved.providers.openai).toMatchObject({
      apiKey: "sk-test",
      futureProviderField: "keep",
      endpoints: {
        chat: {
          apiBase: "https://api.example.test/v1",
          protocol: "openai-chat-completions",
          futureEndpointField: "keep",
        },
      },
    });
    expect(saved.modelPresets.chat).toMatchObject({
      endpoint: "chat",
      provider: "openai",
      source: "byok",
      capabilities: ["agent", "memory_summary", "memory_evolution"],
      futurePresetField: "keep",
    });
    expect(saved.modelAssignments).toEqual(currentCatalog().modelAssignments);
    expect(JSON.stringify(saved.modelPresets)).not.toContain("label");
  });

  it("resolves a current named preset without changing its identity", () => {
    const config = Config.fromObject({
      ...currentCatalog(),
      agents: { defaults: { modelPreset: "chat" } },
    });
    expect(config.resolvePreset()).toMatchObject({
      endpoint: "chat",
      provider: "openai",
      model: "gpt-5",
      source: "byok",
    });
    expect(config.getProviderName(null, { preset: config.resolvePreset() })).toBe("openai");
  });

  it("derives the temporary Provider compatibility projection from a chat endpoint", () => {
    const provider = new ProviderConfig({
      endpoints: { chat: { apiBase: "https://api.example.test/v1", protocol: "openai-responses" } },
    });
    expect(provider.apiBase).toBe("https://api.example.test/v1");
    expect(provider.apiType).toBe("responses");
  });

  it("rejects legacy Provider fields and aliases instead of normalizing them at load", () => {
    for (const value of [
      { api_key: "secret" },
      { api_base: "https://example.test" },
      { apiType: "responses" },
      { extra_headers: { test: "yes" } },
    ]) {
      expect(() => new ProviderConfig(value)).toThrow(/current contract does not accept legacy field/);
    }
    for (const provider of ["openai_compatible", "google", "qwen", "kimi", "baidu", "doubao"]) {
      expect(() => Config.fromObject({ providers: { [provider]: {} } })).toThrow(/canonical Provider ID/);
    }
  });

  it("requires current endpoint fields and a supported protocol", () => {
    expect(() => new ModelEndpointConfig({ protocol: "openai-chat-completions" })).toThrow(/apiBase/);
    expect(() => new ModelEndpointConfig({ apiBase: "https://example.test", protocol: "chat_completions" })).toThrow(/protocol/);
  });

  it("requires endpoint/source/capabilities and never accepts a preset label", () => {
    expect(() => new ModelPresetConfig({ model: "gpt-5", provider: "openai" })).toThrow();
    const preset = new ModelPresetConfig({
      label: "must disappear",
      endpoint: "chat",
      model: "gpt-5",
      provider: "openai",
      source: "byok",
      capabilities: ["agent"],
    });
    expect(preset.toObject()).not.toHaveProperty("label");
  });

  it("rejects a capability that the referenced endpoint protocol cannot execute", () => {
    const data = currentCatalog();
    data.modelPresets.chat.capabilities = ["embedding"] as any;
    expect(() => Config.fromObject(data)).toThrow(/incompatible/);
  });

  it("keeps BYOK assignments source-isolated and validates capability", () => {
    const accountPreset = {
      endpoint: "platform",
      model: "agent_chat",
      provider: "memmy_account",
      source: "account",
      ownerAccountId: "owner-a",
      capabilities: ["agent"],
    };
    const data: any = currentCatalog();
    data.providers.memmy_account = {
      apiKey: "token",
      ownerAccountId: "owner-a",
      endpoints: { platform: { apiBase: "https://cloud.example/v1", protocol: "memmy-account" } },
    };
    data.modelPresets.platform = accountPreset;
    data.modelAssignments.byok.agent = { candidates: ["platform"], default: "platform" };
    expect(() => Config.fromObject(data)).toThrow(/may only reference BYOK/);

    data.modelAssignments.byok.agent = { candidates: ["embedding"], default: "embedding" };
    expect(() => Config.fromObject(data)).toThrow(/lacks capability agent/);
  });

  it("validates account owner and permits owner-bound dormant platform references", () => {
    const data: any = currentCatalog();
    data.modelAssignments.account = {
      ownerAccountId: "owner-a",
      agent: { candidates: ["missing-platform-preset"], default: "missing-platform-preset" },
      memorySummary: null,
      memoryEvolution: null,
      embedding: null,
      asr: null,
      imageGeneration: null,
    };
    expect(() => Config.fromObject(data)).not.toThrow();
    delete data.modelAssignments.account.ownerAccountId;
    expect(() => Config.fromObject(data)).toThrow(/missing preset/);
  });
});
