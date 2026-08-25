import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, setConfigPath } from "../../../src/config/loader.js";
import { Config } from "../../../src/config/schema.js";
import {
  WebUISettingsError,
  createModelConfiguration,
  settingsPayload,
  updateAgentSettings,
  updateImageGenerationSettings,
  updateProviderSettings,
  updateWebSearchSettings,
} from "../../../src/entrypoints/frontend-bridge/settings-api.js";

const roots: string[] = [];

function useConfigFile(initial: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-settings-api-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  setConfigPath(file);
  saveConfig(new Config(initial), file);
  return file;
}

function configuredCatalog() {
  return {
    providers: {
      openai: {
        apiKey: "sk-existing",
        futureProviderField: "keep-provider",
        endpoints: {
          chat: {
            apiBase: "https://api.example.test/v1",
            protocol: "openai-chat-completions",
            futureEndpointField: "keep-endpoint",
          },
          image: {
            apiBase: "https://images.example.test/v1",
            protocol: "openai-images",
          },
        },
      },
    },
    modelPresets: {
      image: {
        provider: "openai",
        endpoint: "image",
        model: "gpt-image-2",
        source: "byok",
        capabilities: ["image_generation"],
      },
    },
    modelAssignments: {
      byok: {
        agent: { candidates: [], default: null },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: "image",
      },
      account: {
        agent: { candidates: [], default: null },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null,
      },
    },
  };
}

afterEach(() => {
  setConfigPath(path.join(os.tmpdir(), "memmy-agent-empty-config.yaml"));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("webui settings api current catalog boundary", () => {
  it("projects mapped token defaults for a BYOK preset missing both fields", () => {
    const file = useConfigFile({
      ...configuredCatalog(),
      agents: { defaults: { modelPreset: "known" } },
      modelPresets: {
        ...configuredCatalog().modelPresets,
        known: {
          provider: "openai",
          endpoint: "chat",
          model: "gpt-5.6",
          source: "byok",
          capabilities: ["agent"],
        },
      },
      modelAssignments: {
        ...configuredCatalog().modelAssignments,
        byok: {
          ...configuredCatalog().modelAssignments.byok,
          agent: { candidates: ["known"], default: "known" },
        },
      },
    });
    const raw = YAML.parse(fs.readFileSync(file, "utf8")) as any;
    delete raw.modelPresets.known.maxTokens;
    delete raw.modelPresets.known.contextWindowTokens;
    fs.writeFileSync(file, YAML.stringify(raw), "utf8");

    const payload = settingsPayload();
    const known = payload.model_presets.find((preset: any) => preset.name === "known");

    expect(payload.agent).toMatchObject({
      model_preset: "known",
      max_tokens: 128_000,
      context_window_tokens: 1_050_000,
    });
    expect(known).toMatchObject({
      max_tokens: 128_000,
      context_window_tokens: 1_050_000,
    });
  });

  it("creates a UUID preset without a label and assigns it to BYOK agent", () => {
    const file = useConfigFile(configuredCatalog());
    const payload = createModelConfiguration({
      provider: ["openai"],
      endpoint_id: ["chat"],
      model: ["gpt-5"],
      capabilities: ["agent,memory_summary"],
    });

    const presetId = payload.agent.model_preset;
    expect(presetId).toMatch(/^[0-9a-f-]{36}$/i);
    const saved = loadConfig(file);
    expect(saved.modelPresets[presetId].toObject()).toMatchObject({
      provider: "openai",
      endpoint: "chat",
      model: "gpt-5",
      source: "byok",
      capabilities: ["agent", "memory_summary"],
    });
    expect(saved.modelPresets[presetId].toObject()).not.toHaveProperty("label");
    expect(saved.modelAssignments.byok.agent).toMatchObject({ candidates: [presetId], default: presetId });
  });

  it("keeps the preset ID stable across endpoint, model, and capability edits", () => {
    useConfigFile(configuredCatalog());
    const created = createModelConfiguration({
      provider: ["openai"], endpoint_id: ["chat"], model: ["gpt-5"], capabilities: ["agent"],
    });
    const presetId = created.agent.model_preset;
    createModelConfiguration({
      preset_id: [presetId], provider: ["openai"], endpoint_id: ["chat"], model: ["gpt-5.1"],
      capabilities: ["agent,memory_evolution"],
    });
    const config = loadConfig();
    expect(Object.keys(config.modelPresets).filter((id) => id === presetId)).toHaveLength(1);
    expect(config.modelPresets[presetId].model).toBe("gpt-5.1");
  });

  it("rejects labels, missing endpoints, and unconfigured Providers", () => {
    useConfigFile();
    expect(() => createModelConfiguration({
      label: ["Legacy"], provider: ["openai"], endpoint_id: ["chat"], model: ["gpt-5"],
    })).toThrow(/labels/);
    expect(() => createModelConfiguration({
      provider: ["openai"], endpoint_id: ["chat"], model: ["gpt-5"],
    })).toThrow(/provider is not configured/);

    useConfigFile(configuredCatalog());
    expect(() => createModelConfiguration({
      provider: ["openai"], endpoint_id: ["missing"], model: ["gpt-5"],
    })).toThrow(/endpoint is not configured/);
  });

  it("updates endpoint protocol fields and retains an existing Key on empty input", () => {
    const file = useConfigFile(configuredCatalog());
    const payload = updateProviderSettings({
      provider: ["openai"], endpoint_id: ["chat"], apiBase: ["https://next.example.test/v1"],
      protocol: ["openai-responses"], apiKey: [""],
    });

    const saved = loadConfig(file);
    expect(saved.providers.openai.apiKey).toBe("sk-existing");
    expect(saved.providers.openai.endpoints.chat.toObject()).toMatchObject({
      apiBase: "https://next.example.test/v1",
      protocol: "openai-responses",
      futureEndpointField: "keep-endpoint",
    });
    expect(payload.providers.find((row: any) => row.name === "openai").endpoints).toContainEqual(
      expect.objectContaining({ endpoint_id: "chat", protocol: "openai-responses" }),
    );
  });

  it("publishes catalog-derived image settings and rejects legacy model writes", () => {
    const file = useConfigFile(configuredCatalog());
    const payload = updateImageGenerationSettings({
      enabled: ["true"], defaultAspectRatio: ["16:9"], maxImagesPerTurn: ["2"], saveDir: ["generated/webui"],
    });
    expect(payload.image_generation).toMatchObject({
      enabled: true,
      preset_id: "image",
      provider: "openai",
      endpoint_id: "image",
      protocol: "openai-images",
      model: "gpt-image-2",
      max_images_per_turn: 2,
    });
    expect(loadConfig(file).tools.imageGeneration.toObject()).not.toHaveProperty("provider");
    expect(() => updateImageGenerationSettings({ provider: ["openai"] })).toThrow(/model catalog/);
  });

  it("isolates account and BYOK image assignments by current user mode and owner", () => {
    const initial: any = configuredCatalog();
    initial.app = { userMode: "account", userId: "account-1", cloudUuid: "cloud-token-1" };
    initial.providers.memmy_account = {
      ownerAccountId: "account-1",
      apiKey: "cloud-token-1",
      endpoints: {
        platform: { apiBase: "https://cloud.example.test/v1", protocol: "memmy-account" },
      },
    };
    initial.modelPresets.accountImage = {
      provider: "memmy_account",
      endpoint: "platform",
      model: "image_gen",
      source: "account",
      ownerAccountId: "account-1",
      capabilities: ["image_generation"],
    };
    initial.modelAssignments.account = {
      ownerAccountId: "account-1",
      agent: { candidates: [], default: null },
      memorySummary: null,
      memoryEvolution: null,
      embedding: null,
      asr: null,
      imageGeneration: "accountImage",
    };
    useConfigFile(initial);

    expect(settingsPayload().image_generation).toMatchObject({
      preset_id: "accountImage",
      provider: "memmy_account",
    });

    const byok = loadConfig();
    byok.app.userMode = "byok";
    saveConfig(byok);
    expect(settingsPayload().image_generation).toMatchObject({ preset_id: "image", provider: "openai" });

    const wrongOwner = loadConfig();
    wrongOwner.app.userMode = "account";
    wrongOwner.app.userId = "account-2";
    saveConfig(wrongOwner);
    expect(settingsPayload().image_generation).toMatchObject({ preset_id: null, provider: null });
  });

  it("does not partially save invalid image settings", () => {
    const file = useConfigFile(configuredCatalog());
    const before = fs.readFileSync(file, "utf8");
    expect(() => updateImageGenerationSettings({ maxImagesPerTurn: ["0"], saveDir: ["changed"] })).toThrow(
      /safe integer >= 1/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("preserves future fields while updating unrelated settings", () => {
    const file = useConfigFile(configuredCatalog());
    const initial = YAML.parse(fs.readFileSync(file, "utf8"));
    initial.futureSection = { keepMe: true };
    fs.writeFileSync(file, YAML.stringify(initial), "utf8");
    updateAgentSettings({ timezone: ["Asia/Shanghai"], botName: ["memmy"] });
    updateWebSearchSettings({ provider: ["searxng"], baseUrl: ["https://search.example"], maxResults: ["7"] });
    const raw = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(raw.futureSection.keepMe).toBe(true);
    expect(raw.providers.openai.futureProviderField).toBe("keep-provider");
    expect(raw.providers.openai.endpoints.chat.futureEndpointField).toBe("keep-endpoint");
    expect(settingsPayload().web_search).toMatchObject({ provider: "searxng", max_results: 7 });
  });

  it("rejects unknown image fields before writing", () => {
    const file = useConfigFile(configuredCatalog());
    const before = fs.readFileSync(file, "utf8");
    expect(() => updateImageGenerationSettings({ unexpected: ["value"] })).toThrow(WebUISettingsError);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
