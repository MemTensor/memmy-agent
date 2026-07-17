import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function useConfigFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-settings-api-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  setConfigPath(file);
  return file;
}

afterEach(() => {
  setConfigPath(path.join(os.tmpdir(), "memmy-agent-empty-config.yaml"));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("webui settings api", () => {
  it("creates a model configuration, writes its label, and selects it", () => {
    const file = useConfigFile();
    const config = new Config();
    config.agents.defaults.model = "openai/gpt-4o";
    config.agents.defaults.provider = "openai";
    config.providers.openai.apiKey = config.providers.openai.api_key = "sk-test";
    saveConfig(config, file);

    const payload = createModelConfiguration({
      label: ["Fast writing"],
      provider: ["openai"],
      model: ["openai/gpt-4.1-mini"],
    });

    expect(payload.agent.model_preset).toBe("fast-writing");
    expect(payload.agent.model).toBe("openai/gpt-4.1-mini");
    const rows = Object.fromEntries(payload.model_presets.map((row: any) => [row.name, row]));
    expect(rows["fast-writing"].label).toBe("Fast writing");

    const saved = loadConfig(file);
    expect(saved.agents.defaults.modelPreset).toBe("fast-writing");
    expect(saved.modelPresets["fast-writing"].label).toBe("Fast writing");
    expect(saved.modelPresets["fast-writing"].model).toBe("openai/gpt-4.1-mini");
    expect(saved.modelPresets["fast-writing"].provider).toBe("openai");

    expect(() => createModelConfiguration({
      label: ["Fast writing"],
      provider: ["openai"],
      model: ["openai/gpt-4.1-mini"],
    })).toThrow(WebUISettingsError);
    try {
      createModelConfiguration({ label: ["Fast writing"], provider: ["openai"], model: ["openai/gpt-4.1-mini"] });
    } catch (error) {
      expect((error as WebUISettingsError).status).toBe(409);
    }
  });

  it("rejects unconfigured providers", () => {
    const file = useConfigFile();
    saveConfig(new Config(), file);

    expect(() => createModelConfiguration({
      label: ["Deep"],
      provider: ["openai"],
      model: ["openai/gpt-4.1"],
    })).toThrow(/provider is not configured/);
  });

  it("updates agent settings with validation and restart metadata", () => {
    const file = useConfigFile();
    saveConfig(new Config(), file);

    const payload = updateAgentSettings({
      model: ["anthropic/claude-sonnet-4-5"],
      provider: ["auto"],
      timezone: ["Asia/Shanghai"],
      botName: ["memmy"],
      toolHintMaxLength: ["80"],
    });

    expect(payload.requires_restart).toBe(true);
    expect(payload.agent.timezone).toBe("Asia/Shanghai");
    expect(payload.agent.bot_name).toBe("memmy");
    expect(payload.agent.tool_hint_max_length).toBe(80);
    const saved = loadConfig(file);
    expect(saved.agents.defaults.timezone).toBe("Asia/Shanghai");
    expect(saved.agents.defaults.botName).toBe("memmy");
    expect(() => updateAgentSettings({ timezone: ["Mars/Base"] })).toThrow(/invalid timezone/);
  });

  it("updates provider settings through the WebUI query surface", () => {
    const file = useConfigFile();
    saveConfig(new Config(), file);

    const payload = updateProviderSettings({
      provider: ["openai"],
      apiKey: ["sk-webui-secret"],
      apiBase: ["https://example.test/v1"],
      api_type: ["responses"],
    });

    expect(payload.providers.find((row: any) => row.name === "openai").api_key_hint).toBe("sk-w....cret");
    const saved = loadConfig(file);
    expect(saved.providers.openai.apiKey).toBe("sk-webui-secret");
    expect(saved.providers.openai.apiBase).toBe("https://example.test/v1");
    expect(saved.providers.openai.apiType).toBe("responses");
  });

  it("preserves session DAG and compaction config while saving existing settings", () => {
    const file = useConfigFile();
    saveConfig(new Config({
      sessionDag: {
        enabled: true,
        maxBuilderContextNodes: 64,
        maxUpdateAttempts: 7,
        retryBackoffMs: [1000, 5000, 30000],
        maxConcurrentSessionQueues: 6,
        compactionCatchupTimeoutMs: 180000,
      },
      contextCompaction: {
        summaryMode: "dag",
      },
    }), file);

    updateProviderSettings({
      provider: ["openai"],
      apiKey: ["sk-webui-secret"],
      apiBase: ["https://example.test/v1"],
    });

    const saved = loadConfig(file);
    expect(saved.sessionDag.toObject()).toEqual({
      enabled: true,
      debugLog: true,
      maxBuilderContextNodes: 64,
      maxUpdateAttempts: 7,
      retryBackoffMs: [1000, 5000, 30000],
      maxConcurrentSessionQueues: 6,
      compactionCatchupTimeoutMs: 180000,
    });
    expect(saved.contextCompaction.summaryMode).toBe("dag");
  });

  it("updates web search settings and exposes settings payload sections", () => {
    const file = useConfigFile();
    saveConfig(new Config(), file);

    const payload = updateWebSearchSettings({
      provider: ["searxng"],
      baseUrl: ["https://search.example"],
      maxResults: ["7"],
      timeout: ["45"],
      useJinaReader: ["false"],
    });

    expect(payload.web_search.provider).toBe("searxng");
    expect(payload.web_search.base_url).toBe("https://search.example");
    expect(payload.web.search.max_results).toBe(7);
    expect(payload.web.fetch.use_jina_reader).toBe(false);
    expect(payload.requires_restart).toBe(true);
    const current = settingsPayload();
    expect(current.runtime.config_path).toBe(file);
    expect(current.runtime.dream).toHaveProperty("max_batch_size");
    expect(current.runtime.dream).toHaveProperty("max_iterations");
    expect(current.runtime.dream).toHaveProperty("annotate_line_ages");
    expect(current.runtime.dream).not.toHaveProperty("maxBatchSize");
    expect(current.advanced).toMatchObject({
      restrict_to_workspace: false,
      ssrf_whitelist_count: 0,
    });
  });

  it("updates image generation settings and rejects unconfigured enabled providers", () => {
    const file = useConfigFile();
    saveConfig(new Config(), file);

    const payload = updateImageGenerationSettings({
      provider: ["openrouter"],
      enabled: ["true"],
      model: ["google/gemini-2.5-flash-image-preview"],
      apiKey: ["sk-image-secret"],
      apiBase: ["https://openrouter.ai/api/v1"],
      defaultAspectRatio: ["16:9"],
      defaultImageSize: ["2K"],
      maxImagesPerTurn: ["2"],
      saveDir: ["generated/webui"],
      extraHeaders: [JSON.stringify({ "X-Test": "1" })],
      extraBody: [JSON.stringify({ quality: "low" })],
    });

    expect(payload.requires_restart).toBe(true);
    expect(payload.image_generation.enabled).toBe(true);
    expect(payload.image_generation.provider_configured).toBe(true);
    expect(payload.image_generation.api_key_hint).toBe("sk-i....cret");
    expect(payload.image_generation.api_base).toBe("https://openrouter.ai/api/v1");
    expect(payload.image_generation.default_aspect_ratio).toBe("16:9");
    expect(payload.image_generation.save_dir).toBe("generated/webui");
    expect(payload.image_generation.extra_headers).toEqual({ "X-Test": "1" });
    expect(payload.image_generation.extra_body).toEqual({ quality: "low" });
    expect(payload.image_generation.providers.map((row: any) => row.name)).not.toEqual(
      expect.arrayContaining(["doubao", "baidu", "qwen"]),
    );
    const saved = loadConfig(file);
    expect(saved.tools.imageGeneration.apiKey).toBe("sk-image-secret");
    expect(saved.tools.imageGeneration.apiBase).toBe("https://openrouter.ai/api/v1");
    expect(saved.tools.imageGeneration.maxImagesPerTurn).toBe(2);
    expect(saved.tools.imageGeneration.extraHeaders).toEqual({ "X-Test": "1" });
    expect(saved.tools.imageGeneration.extraBody).toEqual({ quality: "low" });

    saved.tools.imageGeneration.apiKey = "";
    saved.providers.openrouter.apiKey = "sk-shared-chat-key";
    saveConfig(saved, file);
    expect(() => updateImageGenerationSettings({ enabled: ["true"] })).toThrow(/provider is not configured/);
  });

  it("round trips finite and unlimited image turn limits", () => {
    const file = useConfigFile();
    saveConfig(new Config(), file);

    expect(settingsPayload().image_generation.max_images_per_turn).toBeNull();

    const finite = updateImageGenerationSettings({ max_images_per_turn: ["24"] });
    expect(finite.image_generation.max_images_per_turn).toBe(24);
    expect(loadConfig(file).tools.imageGeneration.maxImagesPerTurn).toBe(24);

    const unlimited = updateImageGenerationSettings({ maxImagesPerTurn: ["null"] });
    expect(unlimited.image_generation.max_images_per_turn).toBeNull();
    expect(loadConfig(file).tools.imageGeneration.maxImagesPerTurn).toBeNull();

    const aliasPriority = updateImageGenerationSettings({
      max_images_per_turn: ["7"],
      maxImagesPerTurn: ["8"],
    });
    expect(aliasPriority.image_generation.max_images_per_turn).toBe(7);
  });

  it("strictly validates image turn limits without writing partial changes", () => {
    const file = useConfigFile();
    saveConfig(new Config({ tools: { imageGeneration: { maxImagesPerTurn: 6 } } }), file);
    const message = "max_images_per_turn must be null or a safe integer >= 1";

    for (const value of ["", "NULL", "-1", "0", "1.5", "100abc", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => updateImageGenerationSettings({
        max_images_per_turn: [value],
        save_dir: ["generated/changed"],
      })).toThrow(message);
      const saved = loadConfig(file).tools.imageGeneration;
      expect(saved.maxImagesPerTurn).toBe(6);
      expect(saved.saveDir).toBe("generated");
    }
  });

  it("rejects account image profile connection edits from settings", () => {
    const file = useConfigFile();
    saveConfig(new Config({
      tools: {
        imageGeneration: {
          enabled: true,
          activeProfile: "account",
          profiles: {
            account: {
              provider: "memmy_account",
              model: "image_gen",
              apiKey: "cloud-login-uuid",
              apiBase: "https://cloud.example.com/api/agentExternal/v1",
            },
            byok: {
              provider: "openai",
              model: "gpt-image-1",
              apiKey: "sk-byok",
              apiBase: "https://api.openai.com/v1",
            },
          },
        },
      },
    }), file);

    const payload = settingsPayload();
    expect(payload.image_generation.active_profile).toBe("account");
    expect(payload.image_generation.provider).toBe("memmy_account");
    expect(payload.image_generation.model).toBe("image_gen");

    expect(() => updateImageGenerationSettings({ apiKey: ["sk-should-not-write"] })).toThrow(
      /account image profile is managed by account login/,
    );
    expect(loadConfig(file).tools.imageGeneration.profiles.account?.apiKey).toBe("cloud-login-uuid");
  });

  it("updates only byok image profile when active profile is byok", () => {
    const file = useConfigFile();
    saveConfig(new Config({
      tools: {
        imageGeneration: {
          enabled: true,
          activeProfile: "byok",
          profiles: {
            account: {
              provider: "memmy_account",
              model: "image_gen",
              apiKey: "cloud-login-uuid",
              apiBase: "https://cloud.example.com/api/agentExternal/v1",
            },
          },
        },
      },
    }), file);

    const payload = updateImageGenerationSettings({
      provider: ["openai"],
      model: ["gpt-image-1"],
      apiKey: ["sk-byok-image"],
      apiBase: ["https://api.openai.com/v1"],
      extraHeaders: [JSON.stringify({ "X-Byok": "1" })],
    });

    expect(payload.image_generation.active_profile).toBe("byok");
    expect(payload.image_generation.provider).toBe("openai");
    expect(payload.image_generation.api_key_hint).toBe("sk-b....mage");
    const saved = loadConfig(file);
    expect(saved.tools.imageGeneration.profiles.account?.apiKey).toBe("cloud-login-uuid");
    expect(saved.tools.imageGeneration.profiles.byok?.toObject()).toMatchObject({
      provider: "openai",
      model: "gpt-image-1",
      apiKey: "sk-byok-image",
      apiBase: "https://api.openai.com/v1",
      extraHeaders: { "X-Byok": "1" },
    });
  });

  it("rejects unknown image generation fields without writing config", () => {
    const file = useConfigFile();
    const config = new Config({
      tools: {
        imageGeneration: {
          enabled: false,
          provider: "openai",
          model: "gpt-image-2",
          apiKey: "sk-before",
        },
      },
    });
    saveConfig(config, file);

    expect(() => updateImageGenerationSettings({
      apiKey: ["sk-after"],
      unexpected: ["value"],
    })).toThrow(/unknown image generation setting/);

    expect(loadConfig(file).tools.imageGeneration.apiKey).toBe("sk-before");
  });
});
