import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigEnvVars, saveConfig } from "../../src/config/loader.js";
import { Config, ImageGenerationToolConfig } from "../../src/config/schema.js";

const roots: string[] = [];
const envBackup: Record<string, string | undefined> = {};

function tmpConfig(data: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-image-config-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify(data), "utf8");
  return file;
}

function setEnv(name: string, value: string): void {
  if (!(name in envBackup)) envBackup[name] = process.env[name];
  process.env[name] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete envBackup[key];
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ImageGenerationToolConfig", () => {
  it("uses independent OpenAI defaults without enabling the tool", () => {
    const config = new ImageGenerationToolConfig();

    expect(config.enabled).toBe(false);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-image-2");
    expect(config.apiKey).toBe("");
    expect(config.apiBase).toBe("");
    expect(config.maxImagesPerTurn).toBeNull();
  });

  it("accepts null and positive safe integer turn limits", () => {
    expect(new ImageGenerationToolConfig({ max_images_per_turn: null }).maxImagesPerTurn).toBeNull();
    for (const value of [1, 24, 1000, Number.MAX_SAFE_INTEGER]) {
      const config = new ImageGenerationToolConfig({ maxImagesPerTurn: value });
      expect(config.maxImagesPerTurn).toBe(value);
      expect(config.toObject().maxImagesPerTurn).toBe(value);
    }
  });

  it("rejects invalid turn limits with a stable error", () => {
    const message = "tools.imageGeneration.maxImagesPerTurn must be null or a safe integer >= 1";
    for (const value of [0, -1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(() => new ImageGenerationToolConfig({ maxImagesPerTurn: value })).toThrow(message);
    }
  });

  it("round trips an unlimited turn limit through config and effective profiles", () => {
    const file = tmpConfig({
      tools: {
        imageGeneration: {
          enabled: true,
          activeProfile: "byok",
          maxImagesPerTurn: null,
          profiles: {
            byok: {
              provider: "openai",
              model: "gpt-image-2",
              apiKey: "sk-image-test",
              apiBase: "https://api.openai.com/v1",
            },
          },
        },
      },
    });

    const loaded = loadConfig(file);
    expect(loaded.tools.imageGeneration.maxImagesPerTurn).toBeNull();
    expect(loaded.tools.imageGeneration.effectiveImageGenerationConfig().maxImagesPerTurn).toBeNull();
    saveConfig(loaded, file);
    expect(YAML.parse(fs.readFileSync(file, "utf8")).tools.imageGeneration.maxImagesPerTurn).toBeNull();
  });

  it("reads aliases and writes canonical camelCase fields", () => {
    const config = new ImageGenerationToolConfig({
      enabled: true,
      provider: "qwen",
      model: "qwen-image",
      api_key: "${IMAGE_API_KEY}",
      api_base: "https://dashscope.aliyuncs.com",
      default_aspect_ratio: "16:9",
      default_image_size: "2K",
      max_images_per_turn: 2,
      save_dir: "images/generated",
      extra_headers: { "X-Test": "${IMAGE_HEADER}" },
      extra_body: { watermark: false, nested: { token: "${IMAGE_BODY_TOKEN}" } },
    });

    expect(config.provider).toBe("dashscope");
    expect(config.toObject()).toEqual({
      enabled: true,
      provider: "dashscope",
      model: "qwen-image",
      apiKey: "${IMAGE_API_KEY}",
      apiBase: "https://dashscope.aliyuncs.com",
      defaultAspectRatio: "16:9",
      defaultImageSize: "2K",
      maxImagesPerTurn: 2,
      saveDir: "images/generated",
      extraHeaders: { "X-Test": "${IMAGE_HEADER}" },
      extraBody: { watermark: false, nested: { token: "${IMAGE_BODY_TOKEN}" } },
    });
  });

  it("round trips image generation fields through load and save", () => {
    const file = tmpConfig({
      tools: {
        imageGeneration: {
          enabled: true,
          provider: "baidu",
          model: "sd_xl",
          apiKey: "${QIANFAN_TOKEN}",
          apiBase: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop",
          defaultAspectRatio: "4:3",
          defaultImageSize: "1024x768",
          maxImagesPerTurn: 3,
          saveDir: "generated/qianfan",
          extraHeaders: { "X-Trace": "${TRACE_ID}" },
          extraBody: { secret_key: "${QIANFAN_SECRET}", steps: 24 },
        },
      },
    });

    const loaded = loadConfig(file);
    expect(loaded.tools.imageGeneration.provider).toBe("qianfan");
    saveConfig(loaded, file);
    const parsed = YAML.parse(fs.readFileSync(file, "utf8"));

    expect(parsed.tools.imageGeneration).toMatchObject({
      enabled: true,
      provider: "qianfan",
      model: "sd_xl",
      apiKey: "${QIANFAN_TOKEN}",
      apiBase: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop",
      defaultAspectRatio: "4:3",
      defaultImageSize: "1024x768",
      maxImagesPerTurn: 3,
      saveDir: "generated/qianfan",
      extraHeaders: { "X-Trace": "${TRACE_ID}" },
      extraBody: { secret_key: "${QIANFAN_SECRET}", steps: 24 },
    });
  });

  it("uses active image generation profile as the only effective source", () => {
    const config = new ImageGenerationToolConfig({
      enabled: true,
      activeProfile: "account",
      provider: "openai",
      model: "stale-flat",
      apiKey: "sk-flat",
      apiBase: "https://flat.example/v1",
      profiles: {
        account: {
          provider: "memmy_account",
          model: "image_gen",
          apiKey: "cloud-login-uuid",
          apiBase: "https://cloud.example.com/api/agentExternal/v1",
        },
        byok: {
          provider: "doubao",
          model: "seedream",
          apiKey: "sk-byok",
          apiBase: "https://ark.example/api/v3",
        },
      },
    });

    const effective = config.effectiveImageGenerationConfig();

    expect(effective.provider).toBe("memmy_account");
    expect(effective.model).toBe("image_gen");
    expect(effective.apiKey).toBe("cloud-login-uuid");
    expect(effective.apiBase).toBe("https://cloud.example.com/api/agentExternal/v1");
    expect(config.toObject()).toMatchObject({
      activeProfile: "account",
      profiles: {
        account: {
          provider: "memmy_account",
          model: "image_gen",
        },
        byok: {
          provider: "volcengine",
          model: "seedream",
        },
      },
    });
    expect(config.toObject()).not.toHaveProperty("provider");
  });

  it("does not fall back to account profile when active byok profile is missing", () => {
    const config = new ImageGenerationToolConfig({
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
    });

    expect(config.effectiveImageGenerationProfile()).toBeNull();
    expect(config.hasCompleteEffectiveProfile()).toBe(false);
    expect(config.effectiveImageGenerationConfig().enabled).toBe(false);
  });

  it("accepts null extra headers and body in image generation profiles", () => {
    const file = tmpConfig({
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
              extraHeaders: null,
              extraBody: null,
            },
          },
        },
      },
    });

    const loaded = loadConfig(file);
    const profile = loaded.tools.imageGeneration.profiles.account;

    expect(profile?.extraHeaders).toBeNull();
    expect(profile?.extraBody).toBeNull();
    saveConfig(new Config(loaded.toObject()), file);
    const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.tools.imageGeneration.profiles.account).not.toHaveProperty("extraHeaders");
    expect(parsed.tools.imageGeneration.profiles.account).not.toHaveProperty("extraBody");
  });

  it("round trips active profile and profiles through load/save and Config cloning", () => {
    const file = tmpConfig({
      tools: {
        imageGeneration: {
          enabled: true,
          activeProfile: "byok",
          profiles: {
            account: {
              provider: "memmy_account",
              model: "image_gen",
              apiKey: "${ACCOUNT_IMAGE_KEY}",
              apiBase: "https://cloud.example.com/api/agentExternal/v1",
            },
            byok: {
              provider: "openai",
              model: "gpt-image-1",
              apiKey: "${IMAGE_API_KEY}",
              apiBase: "https://api.openai.com/v1",
              extraHeaders: { "X-Profile": "${IMAGE_HEADER}" },
            },
          },
          extraHeaders: { "X-Global": "global" },
          extraBody: { seed: 123 },
        },
      },
    });

    const loaded = loadConfig(file);
    const cloned = new Config(loaded.toObject());
    saveConfig(cloned, file);
    const parsed = YAML.parse(fs.readFileSync(file, "utf8"));

    expect(parsed.tools.imageGeneration.activeProfile).toBe("byok");
    expect(parsed.tools.imageGeneration.profiles.account).toMatchObject({
      provider: "memmy_account",
      model: "image_gen",
      apiKey: "${ACCOUNT_IMAGE_KEY}",
    });
    expect(parsed.tools.imageGeneration.profiles.byok).toMatchObject({
      provider: "openai",
      model: "gpt-image-1",
      apiKey: "${IMAGE_API_KEY}",
      extraHeaders: { "X-Profile": "${IMAGE_HEADER}" },
    });
    expect(parsed.tools.imageGeneration.extraHeaders).toEqual({ "X-Global": "global" });
    expect(parsed.tools.imageGeneration.extraBody).toEqual({ seed: 123 });
  });

  it("resolves env vars inside apiKey apiBase extraHeaders and extraBody", () => {
    setEnv("IMAGE_API_KEY", "resolved-key");
    setEnv("IMAGE_API_BASE", "https://image.example/v1");
    setEnv("IMAGE_HEADER", "header-value");
    setEnv("IMAGE_BODY_TOKEN", "body-token");
    const config = new Config({
      tools: {
        imageGeneration: {
          provider: "custom",
          model: "custom-image",
          apiKey: "${IMAGE_API_KEY}",
          apiBase: "${IMAGE_API_BASE}",
          extraHeaders: { "X-Image": "${IMAGE_HEADER}" },
          extraBody: { token: "${IMAGE_BODY_TOKEN}" },
        },
      },
    });

    const resolved = resolveConfigEnvVars(config);

    expect(resolved.tools.imageGeneration.apiKey).toBe("resolved-key");
    expect(resolved.tools.imageGeneration.apiBase).toBe("https://image.example/v1");
    expect(resolved.tools.imageGeneration.extraHeaders["X-Image"]).toBe("header-value");
    expect(resolved.tools.imageGeneration.extraBody.token).toBe("body-token");
  });
});
