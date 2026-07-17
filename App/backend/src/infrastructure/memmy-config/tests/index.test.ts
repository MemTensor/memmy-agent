/** Index tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearAccountModelProjectionFromMemmyConfig,
  createMemmyConfigWriter,
  mapModelProtocol,
  readAgentGatewayBootstrapSecret,
  readRuntimeMemmyConfigState,
  resolveDefaultMemmyConfigPath,
  writeAccountModelProjectionToMemmyConfig,
  writeAppCloudUuidToMemmyConfig,
  writeAppLoginFieldsToMemmyConfig,
  writeByokModelProjectionToMemmyConfig
} from "../index.js";

const ACCOUNT_API_BASE = `${process.env.MEMMY_CLOUD_SERVICE}/api/agentExternal/v1`;

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("writeAppCloudUuidToMemmyConfig", () => {
  it("writes cloudUuid into app config with owner-only permissions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);

    await writeAppCloudUuidToMemmyConfig("cloud-login-uuid", configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as {
      app?: { cloudUuid?: unknown };
      agents?: { defaults?: { provider?: unknown; model?: unknown } };
      providers?: { memmy_account?: { apiBase?: unknown; apiKey?: unknown } };
      uuid?: unknown;
    };
    expect(parsed.app?.cloudUuid).toBe("cloud-login-uuid");
    expect(parsed.agents?.defaults).toMatchObject({
      provider: "memmy_account",
      model: "agent_chat"
    });
    expect(parsed.providers?.memmy_account).toMatchObject({
      apiBase: ACCOUNT_API_BASE,
      apiKey: "cloud-login-uuid"
    });
    expect(parsed.uuid).toBeUndefined();
    expect(statSync(join(tempDir, ".memmy")).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("preserves existing object fields while replacing app.cloudUuid and removing legacy top-level uuid", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "storage:",
        "  endpoint: http://127.0.0.1:18888",
        "uuid: old-top-level-cloud-login-uuid",
        "app:",
        "  locale: zh-CN",
        "  cloudUuid: old-app-cloud-login-uuid",
        ""
      ].join("\n"),
      "utf8"
    );

    await writeAppCloudUuidToMemmyConfig("cloud-login-uuid", configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as {
      app?: { cloudUuid?: unknown; locale?: unknown };
      storage?: { endpoint?: unknown };
      uuid?: unknown;
    };
    expect(parsed.app?.cloudUuid).toBe("cloud-login-uuid");
    expect(parsed.app?.locale).toBe("zh-CN");
    expect(parsed.uuid).toBeUndefined();
    expect(parsed.storage?.endpoint).toBe("http://127.0.0.1:18888");
  });
});

describe("readRuntimeMemmyConfigState", () => {
  it("distinguishes missing, empty, invalid, and packaged skeleton configs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);

    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "missing"
    });

    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(configPath, "", "utf8");
    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "empty"
    });

    writeFileSync(configPath, "agents: [\n", "utf8");
    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "invalid_yaml"
    });

    writeFileSync(
      configPath,
      [
        "agents:",
        "  defaults:",
        "    provider: custom",
        "    model: custom/memmy-desktop",
        "memmyMemory:",
        "  storage:",
        "    endpoint: http://127.0.0.1:18888",
        ""
      ].join("\n"),
      "utf8"
    );
    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "no_model_config"
    });
  });

  it("derives account runtime config from account projection YAML", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "app:",
        "  cloudUuid: cloud-login-uuid",
        "  userId: user-1",
        "agents:",
        "  defaults:",
        "    provider: memmy_account",
        "    model: agent_chat",
        "memmyMemory:",
        "  activeProfile: account",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "valid_account",
      cloudUuid: "cloud-login-uuid",
      userId: "user-1"
    });
  });

  it("derives BYOK runtime config from active byok YAML", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "agents:",
        "  defaults:",
        "    provider: openai",
        "    model: gpt-4o",
        "providers:",
        "  openai:",
        "    apiBase: https://api.openai.example/v1",
        "    apiKey: sk-main",
        "memmyMemory:",
        "  activeProfile: byok",
        "  profiles:",
        "    byok:",
        "      summary:",
        "        provider: anthropic",
        "        endpoint: https://api.anthropic.example",
        "        model: claude-3-5-haiku",
        "        apiKey: sk-memory",
        "      evolution:",
        "        provider: openai_compatible",
        "        endpoint: https://dashscope.example/v1",
        "        model: qwen-plus",
        "        apiKey: sk-skill",
        "tools:",
        "  imageGeneration:",
        "    activeProfile: byok",
        "    profiles:",
        "      byok:",
        "        provider: dashscope",
        "        apiBase: https://dashscope.aliyuncs.com",
        "        model: qwen-image",
        "        apiKey: sk-image",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "valid_byok",
      modelConfig: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.example/v1",
        modelId: "gpt-4o",
        apiKey: "sk-main",
        imageGen: {
          provider: "qwen",
          baseUrl: "https://dashscope.aliyuncs.com",
          modelId: "qwen-image",
          apiKey: "sk-image"
        },
        memmyMemory: {
          summary: {
            provider: "anthropic",
            baseUrl: "https://api.anthropic.example",
            modelId: "claude-3-5-haiku",
            apiKey: "sk-memory"
          },
          evolution: {
            provider: "openai_compatible",
            baseUrl: "https://dashscope.example/v1",
            modelId: "qwen-plus",
            apiKey: "sk-skill"
          }
        }
      }
    });
  });

  it("reports conflicting agent defaults and memory active profile", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "agents:",
        "  defaults:",
        "    provider: memmy_account",
        "    model: agent_chat",
        "providers:",
        "  memmy_account:",
        `    apiBase: `,
        "    apiKey: cloud-login-uuid",
        "memmyMemory:",
        "  activeProfile: byok",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "conflict"
    });
  });
});

describe("writeAppLoginFieldsToMemmyConfig", () => {
  it("writes cloud uuid and user id into app config and mirrors user id into memmyMemory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);

    await writeAppLoginFieldsToMemmyConfig({ cloudUuid: "cloud-login-uuid", userId: "user-1" }, configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as {
      app?: { cloudUuid?: unknown; userId?: unknown };
      memmyMemory?: {
        activeProfile?: unknown;
        profiles?: { account?: { userId?: unknown; summary?: unknown; evolution?: unknown; embedding?: unknown } };
        userId?: unknown;
      };
      agents?: { defaults?: { provider?: unknown; model?: unknown } };
      providers?: { memmy_account?: { apiBase?: unknown; apiKey?: unknown } };
      uuid?: unknown;
      identity?: unknown;
    };
    expect(parsed.app?.cloudUuid).toBe("cloud-login-uuid");
    expect(parsed.app?.userId).toBe("user-1");
    expect(parsed.memmyMemory?.activeProfile).toBe("account");
    expect(parsed.memmyMemory?.userId).toBeUndefined();
    expect(parsed.memmyMemory?.profiles?.account?.userId).toBe("user-1");
    expect(parsed.memmyMemory?.profiles?.account?.summary).toEqual({
      vendor: "qwen",
      endpoint: ACCOUNT_API_BASE,
      model: "memory_summary",
      apiKey: "cloud-login-uuid",
      enableThinking: false
    });
    expect(parsed.memmyMemory?.profiles?.account?.evolution).toEqual({
      vendor: "qwen",
      endpoint: ACCOUNT_API_BASE,
      model: "memory_evolution",
      apiKey: "cloud-login-uuid",
      enableThinking: true
    });
    expect(parsed.memmyMemory?.profiles?.account?.embedding).toEqual({
      endpoint: ACCOUNT_API_BASE,
      model: "embedding",
      apiKey: "cloud-login-uuid"
    });
    expect(parsed.agents?.defaults).toMatchObject({
      provider: "memmy_account",
      model: "agent_chat"
    });
    expect(parsed.providers?.memmy_account).toMatchObject({
      apiBase: ACCOUNT_API_BASE,
      apiKey: "cloud-login-uuid"
    });
    expect(parsed.uuid).toBeUndefined();
    expect(parsed.identity).toBeUndefined();
    expect(statSync(join(tempDir, ".memmy")).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("removes legacy top-level uuid and identity while preserving app fields", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "uuid: old-top-level-cloud-login-uuid",
        "identity:",
        "  userId: old-identity-user",
        "app:",
        "  locale: zh-CN",
        "  cloudUuid: old-app-cloud-login-uuid",
        "memmyMemory:",
        "  enabled: true",
        "  userId: old-memory-user",
        ""
      ].join("\n"),
      "utf8"
    );

    await writeAppLoginFieldsToMemmyConfig({ cloudUuid: "cloud-login-uuid", userId: "user-1" }, configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as {
      app?: { cloudUuid?: unknown; userId?: unknown; locale?: unknown };
      memmyMemory?: {
        enabled?: unknown;
        activeProfile?: unknown;
        userId?: unknown;
        profiles?: { account?: { userId?: unknown } };
      };
      uuid?: unknown;
      identity?: unknown;
    };
    expect(parsed.app).toEqual({ locale: "zh-CN", cloudUuid: "cloud-login-uuid", userId: "user-1" });
    expect(parsed.memmyMemory?.enabled).toBe(true);
    expect(parsed.memmyMemory?.activeProfile).toBe("account");
    expect(parsed.memmyMemory?.userId).toBeUndefined();
    expect(parsed.memmyMemory?.profiles?.account?.userId).toBe("user-1");
    expect(parsed.uuid).toBeUndefined();
    expect(parsed.identity).toBeUndefined();
  });
});

describe("writeAccountModelProjectionToMemmyConfig", () => {
  it("preserves existing app fields while replacing app.cloudUuid", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(configPath, "app:\n  cloudUuid: old-cloud-login-uuid\n  locale: zh-CN\n", "utf8");

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "cloud-login-uuid" }, configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.app).toEqual({
      cloudUuid: "cloud-login-uuid",
      locale: "zh-CN"
    });
    expect(parsed.agents?.defaults).toMatchObject({
      provider: "memmy_account",
      model: "agent_chat"
    });
    expect(parsed.tools.imageGeneration).toMatchObject({
      enabled: true,
      activeProfile: "account",
      profiles: {
        account: {
          provider: "memmy_account",
          model: "image_gen",
          apiBase: ACCOUNT_API_BASE,
          apiKey: "cloud-login-uuid"
        }
      }
    });
  });

  it("clears account runtime credentials without removing BYOK settings", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "app:",
        "  locale: zh-CN",
        "  cloudUuid: cloud-login-uuid",
        "  userId: user-1",
        "agents:",
        "  defaults:",
        "    provider: memmy_account",
        "    model: agent_chat",
        "providers:",
        "  memmy_account:",
        `    apiBase: `,
        "    apiKey: cloud-login-uuid",
        "  openai:",
        "    apiBase: https://api.openai.example/v1",
        "    apiKey: sk-main",
        "memmyMemory:",
        "  activeProfile: account",
        "  storage:",
        "    endpoint: http://127.0.0.1:18888",
        "  profiles:",
        "    account:",
        "      userId: user-1",
        "      summary:",
        "        apiKey: cloud-login-uuid",
        "    byok:",
        "      summary:",
        "        provider: openai_compatible",
        "        endpoint: https://memory.example/v1",
        "        model: memory-model",
        "        apiKey: sk-memory",
        "tools:",
        "  imageGeneration:",
        "    activeProfile: account",
        "    profiles:",
        "      account:",
        "        provider: memmy_account",
        "        model: image_gen",
        `        apiBase: ${ACCOUNT_API_BASE}`,
        "        apiKey: cloud-login-uuid",
        "      byok:",
        "        provider: openai",
        "        model: gpt-image-1",
        "        apiBase: https://api.openai.com/v1",
        "        apiKey: sk-image",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await clearAccountModelProjectionFromMemmyConfig(configPath);
    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;

    expect(result.changed).toBe(true);
    expect(parsed.app).toEqual({ locale: "zh-CN" });
    expect(parsed.agents).toBeUndefined();
    expect(parsed.providers.memmy_account).toBeUndefined();
    expect(parsed.providers.openai.apiKey).toBe("sk-main");
    expect(parsed.memmyMemory.activeProfile).toBe("byok");
    expect(parsed.memmyMemory.storage.endpoint).toBe("http://127.0.0.1:18888");
    expect(parsed.memmyMemory.profiles.account).toBeUndefined();
    expect(parsed.memmyMemory.profiles.byok.summary.apiKey).toBe("sk-memory");
    expect(parsed.tools.imageGeneration.activeProfile).toBeUndefined();
    expect(parsed.tools.imageGeneration.profiles.account).toBeUndefined();
    expect(parsed.tools.imageGeneration.profiles.byok).toMatchObject({
      provider: "openai",
      model: "gpt-image-1",
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-image"
    });
    await expect(readRuntimeMemmyConfigState(configPath)).resolves.toMatchObject({
      status: "no_model_config"
    });
  });
});

describe("writeByokModelProjectionToMemmyConfig", () => {
  it("writes agent and Memory role model projections while preserving unrelated fields", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "channels:",
        "  showReasoning: false",
        "memmyMemory:",
        "  userId: user-1",
        "  storage:",
        "    endpoint: http://127.0.0.1:18888",
        "  algorithm:",
        "    topK: 8",
        ""
      ].join("\n"),
      "utf8"
    );

    await writeByokModelProjectionToMemmyConfig({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.example/v1",
      modelId: "gpt-4o",
      apiKey: "sk-main",
      memmyMemory: {
        summary: {
          provider: "anthropic",
          baseUrl: "https://api.anthropic.example",
          modelId: "claude-3-5-haiku",
          apiKey: "sk-memory"
        },
        evolution: {
          provider: "qwen",
          baseUrl: "https://dashscope.example/v1",
          modelId: "qwen-plus",
          apiKey: "sk-skill"
        }
      },
      embedding: {
        mode: "custom",
        baseUrl: "https://embedding.example/v1",
        modelId: "text-embedding-3-small",
        apiKey: "sk-embedding"
      }
    }, configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.app).toBeUndefined();
    expect(parsed.agents.defaults).toMatchObject({
      provider: "openai",
      model: "gpt-4o"
    });
    expect(parsed.providers.openai).toMatchObject({
      apiBase: "https://api.openai.example/v1",
      apiKey: "sk-main",
      apiType: "chatCompletions"
    });
    expect(parsed.memmyMemory.activeProfile).toBe("byok");
    expect(parsed.memmyMemory.userId).toBeUndefined();
    expect(parsed.memmyMemory.summary).toBeUndefined();
    expect(parsed.memmyMemory.evolution).toBeUndefined();
    expect(parsed.memmyMemory.embedding).toBeUndefined();
    expect(parsed.memmyMemory.profiles.byok.userId).toBe("user-1");
    expect(parsed.memmyMemory.profiles.byok.summary).toEqual({
      provider: "anthropic",
      vendor: "anthropic",
      endpoint: "https://api.anthropic.example",
      model: "claude-3-5-haiku",
      apiKey: "sk-memory",
      enableThinking: false
    });
    expect(parsed.memmyMemory.profiles.byok.evolution).toEqual({
      provider: "openai_compatible",
      vendor: "qwen",
      endpoint: "https://dashscope.example/v1",
      model: "qwen-plus",
      apiKey: "sk-skill",
      enableThinking: true
    });
    expect(parsed.memmyMemory.profiles.byok.embedding).toEqual({
      provider: "openai_compatible",
      endpoint: "https://embedding.example/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-embedding"
    });
    expect(parsed.memmyMemory.storage.endpoint).toBe("http://127.0.0.1:18888");
    expect(parsed.memmyMemory.algorithm.topK).toBe(8);
    expect(parsed.channels.showReasoning).toBe(false);
  });

  it.each([
    "openai_compatible",
    "anthropic",
    "google",
    "deepseek",
    "zhipu",
    "qwen",
    "kimi",
    "minimax",
    "baidu",
    "doubao"
  ] as const)("retains the %s vendor for provider-specific thinking controls", async (provider) => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-vendor-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);

    await writeByokModelProjectionToMemmyConfig({
      provider: "openai_compatible",
      baseUrl: "https://primary.example/v1",
      modelId: "primary-model",
      apiKey: "primary-key",
      memmyMemory: {
        summary: {
          provider,
          baseUrl: `https://${provider}.example/v1`,
          modelId: `${provider}-summary`,
          apiKey: "summary-key"
        },
        evolution: {
          provider,
          baseUrl: `https://${provider}.example/v1`,
          modelId: `${provider}-evolution`,
          apiKey: "evolution-key"
        }
      }
    }, configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as {
      memmyMemory: {
        profiles: {
          byok: {
            summary: { provider: string; vendor: string; enableThinking: boolean };
            evolution: { provider: string; vendor: string; enableThinking: boolean };
          };
        };
      };
    };
    const expectedProtocol = provider === "anthropic"
      ? "anthropic"
      : provider === "google"
        ? "gemini"
        : "openai_compatible";
    expect(parsed.memmyMemory.profiles.byok.summary).toMatchObject({
      provider: expectedProtocol,
      vendor: provider,
      enableThinking: false
    });
    expect(parsed.memmyMemory.profiles.byok.evolution).toMatchObject({
      provider: expectedProtocol,
      vendor: provider,
      enableThinking: true
    });
  });

  it("writes image generation tool projection and maps provider to runtime name", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "channels:",
        "  showReasoning: false",
        "tools:",
        "  imageGeneration:",
        "    defaultAspectRatio: '16:9'",
        "    defaultImageSize: 2K",
        "    maxImagesPerTurn: 3",
        "    saveDir: custom-generated",
        "    extraHeaders:",
        "      X-Image: trace",
        "    extraBody:",
        "      quality: low",
        ""
      ].join("\n"),
      "utf8"
    );

    const baseInput = {
      provider: "openai_compatible" as const,
      baseUrl: "https://api.openai.example/v1",
      modelId: "gpt-4o",
      apiKey: "sk-main",
      memmyMemory: {
        summary: { provider: "openai_compatible" as const, baseUrl: "https://m.example/v1", modelId: "m", apiKey: "sk-m" },
        evolution: { provider: "openai_compatible" as const, baseUrl: "https://s.example/v1", modelId: "s", apiKey: "sk-s" }
      }
    };

    await writeByokModelProjectionToMemmyConfig({
      ...baseInput,
      imageGen: {
        provider: "doubao",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        modelId: "doubao-seedream-4-0-250828",
        apiKey: "sk-image"
      }
    }, configPath);

    let parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.tools.imageGeneration).toMatchObject({
      enabled: true,
      activeProfile: "byok",
      defaultAspectRatio: "16:9",
      defaultImageSize: "2K",
      maxImagesPerTurn: 3,
      saveDir: "custom-generated",
      extraHeaders: { "X-Image": "trace" },
      extraBody: { quality: "low" }
    });
    expect(parsed.tools.imageGeneration.profiles.byok).toMatchObject({
      provider: "volcengine",
      model: "doubao-seedream-4-0-250828",
      apiBase: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "sk-image"
    });
    // The primary LLM provider slot must not be polluted by image-gen credentials.
    expect(parsed.providers.openai.apiKey).toBe("sk-main");

    await writeByokModelProjectionToMemmyConfig({
      ...baseInput,
      imageGen: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-image-1",
        apiKey: "sk-img2"
      }
    }, configPath);
    parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.tools.imageGeneration.profiles.byok.provider).toBe("openai");

    await writeByokModelProjectionToMemmyConfig({
      ...baseInput,
      imageGen: {
        provider: "qwen",
        baseUrl: "https://dashscope.aliyuncs.com",
        modelId: "qwen-image",
        apiKey: "sk-qwen-image"
      }
    }, configPath);
    parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.tools.imageGeneration.profiles.byok.provider).toBe("dashscope");

    await writeByokModelProjectionToMemmyConfig({
      ...baseInput,
      imageGen: {
        provider: "baidu",
        baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop",
        modelId: "sd_xl",
        apiKey: "sk-qianfan-image"
      }
    }, configPath);
    parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.tools.imageGeneration.profiles.byok.provider).toBe("qianfan");
    expect(parsed.tools.imageGeneration.extraBody).toEqual({ quality: "low" });
  });

  it("activates byok image profile without falling back when imageGen is absent", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(configPath, ["channels:", "  showReasoning: false", ""].join("\n"), "utf8");

    await writeByokModelProjectionToMemmyConfig({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.example/v1",
      modelId: "gpt-4o",
      apiKey: "sk-main",
      memmyMemory: {
        summary: { provider: "openai_compatible", baseUrl: "https://m.example/v1", modelId: "m", apiKey: "sk-m" },
        evolution: { provider: "openai_compatible", baseUrl: "https://s.example/v1", modelId: "s", apiKey: "sk-s" }
      }
    }, configPath);

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.tools?.imageGeneration).toEqual({ activeProfile: "byok" });
  });

  it("updates BYOK profile without switching active account profile when activation is disabled", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "agents:",
        "  defaults:",
        "    provider: memmy_account",
        "    model: agent_chat",
        "providers:",
        "  memmy_account:",
        `    apiBase: `,
        "    apiKey: cloud-login-uuid",
        "memmyMemory:",
        "  activeProfile: account",
        "  profiles:",
        "    account:",
        "      userId: user-1",
        "      summary:",
        `        endpoint: `,
        "        model: memory_summary",
        "        apiKey: cloud-login-uuid",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await writeByokModelProjectionToMemmyConfig({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.example/v1",
      modelId: "gpt-4o",
      apiKey: "sk-main",
      memmyMemory: {
        summary: {
          provider: "openai_compatible",
          baseUrl: "https://memory.example/v1",
          modelId: "memory-model",
          apiKey: "sk-memory"
        },
        evolution: {
          provider: "openai_compatible",
          baseUrl: "https://skill.example/v1",
          modelId: "skill-model",
          apiKey: "sk-skill"
        }
      },
      embedding: {
        mode: "local"
      }
    }, configPath, { activate: false });

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(result.activeProfile).toBe("account");
    expect(result.activeProfileAffected).toBe(false);
    expect(parsed.agents.defaults).toEqual({
      provider: "memmy_account",
      model: "agent_chat"
    });
    expect(parsed.memmyMemory.activeProfile).toBe("account");
    expect(parsed.memmyMemory.profiles.account.summary.model).toBe("memory_summary");
    expect(parsed.memmyMemory.profiles.byok.summary).toEqual({
      provider: "openai_compatible",
      vendor: "openai_compatible",
      endpoint: "https://memory.example/v1",
      model: "memory-model",
      apiKey: "sk-memory",
      enableThinking: false
    });
    expect(parsed.providers.openai).toMatchObject({
      apiBase: "https://api.openai.example/v1",
      apiKey: "sk-main",
      apiType: "chatCompletions"
    });
  });

  it("switches agent defaults and active profile when BYOK activation is enabled", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "agents:",
        "  defaults:",
        "    provider: memmy_account",
        "    model: agent_chat",
        "memmyMemory:",
        "  activeProfile: account",
        "  profiles:",
        "    account:",
        "      userId: user-1",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await writeByokModelProjectionToMemmyConfig({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.example/v1",
      modelId: "gpt-4o",
      apiKey: "sk-main",
      memmyMemory: {
        summary: {
          provider: "openai_compatible",
          baseUrl: "https://memory.example/v1",
          modelId: "memory-model",
          apiKey: "sk-memory"
        },
        evolution: {
          provider: "openai_compatible",
          baseUrl: "https://skill.example/v1",
          modelId: "skill-model",
          apiKey: "sk-skill"
        }
      }
    }, configPath, { activate: true });

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(result.activeProfile).toBe("byok");
    expect(result.activeProfileChanged).toBe(true);
    expect(parsed.agents.defaults).toEqual({
      provider: "openai",
      model: "gpt-4o"
    });
    expect(parsed.memmyMemory.activeProfile).toBe("byok");
    expect(parsed.memmyMemory.profiles.account.userId).toBe("user-1");
    expect(parsed.memmyMemory.profiles.byok.evolution.model).toBe("skill-model");
  });
});

describe("patchChannelConfig", () => {
  it("creates a channel section without changing model projections", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "agents:",
        "  defaults:",
        "    provider: openai",
        "    model: gpt-4o",
        "providers:",
        "  openai:",
        "    apiBase: https://api.example/v1",
        "    apiKey: sk-test",
        ""
      ].join("\n"),
      "utf8"
    );

    await createMemmyConfigWriter({ configPath }).patchChannelConfig("feishu", {
      enabled: true,
      appId: "cli_a",
      appSecret: "secret",
      domain: "feishu",
      streaming: true
    });

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.agents.defaults).toEqual({
      provider: "openai",
      model: "gpt-4o"
    });
    expect(parsed.providers.openai.apiKey).toBe("sk-test");
    expect(parsed.channels.feishu).toEqual({
      enabled: true,
      appId: "cli_a",
      appSecret: "secret",
      domain: "feishu",
      streaming: true
    });
  });

  it("patches only supplied fields and preserves existing channel fields", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "channels:",
        "  sendProgress: true",
        "  weixin:",
        "    enabled: false",
        "    baseUrl: http://127.0.0.1:9090",
        "    stateDir: /tmp/weixin-state",
        ""
      ].join("\n"),
      "utf8"
    );

    await createMemmyConfigWriter({ configPath }).patchChannelConfig("weixin", {
      enabled: true
    });

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.channels.sendProgress).toBe(true);
    expect(parsed.channels.weixin).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:9090",
      stateDir: "/tmp/weixin-state"
    });
  });

  it("preserves image generation config while patching unrelated tool and channel sections", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "tools:",
        "  imageGeneration:",
        "    enabled: true",
        "    provider: qianfan",
        "    model: sd_xl",
        "    apiKey: sk-image",
        "    extraBody:",
        "      secret_key: sk-secret",
        ""
      ].join("\n"),
      "utf8"
    );
    const writer = createMemmyConfigWriter({ configPath });

    await writer.patchChannelConfig("feishu", { enabled: true });
    await writer.patchMcpServerConfig("composio", {
      type: "streamableHttp",
      url: "http://127.0.0.1:18900/mcp"
    });

    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.tools.imageGeneration).toMatchObject({
      enabled: true,
      provider: "qianfan",
      model: "sd_xl",
      apiKey: "sk-image",
      extraBody: { secret_key: "sk-secret" }
    });
    expect(parsed.channels.feishu.enabled).toBe(true);
    expect(parsed.tools.mcpServers.composio.url).toBe("http://127.0.0.1:18900/mcp");
  });

  it("rejects blank or unsafe channel names", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    const writer = createMemmyConfigWriter({ configPath });

    await expect(writer.patchChannelConfig("", { enabled: true })).rejects.toThrow("channel name is required");
    await expect(writer.patchChannelConfig("../feishu", { enabled: true })).rejects.toThrow("invalid channel name");
  });
});

describe("readAgentGatewayBootstrapSecret", () => {
  it("returns tokenIssueSecret when present", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(configPath, YAML.stringify({ channels: { websocket: { tokenIssueSecret: "gw-secret" } } }), "utf8");

    await expect(readAgentGatewayBootstrapSecret(configPath)).resolves.toBe("gw-secret");
  });

  it("falls back to token when tokenIssueSecret is absent", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(configPath, YAML.stringify({ channels: { websocket: { token: "gw-token" } } }), "utf8");

    await expect(readAgentGatewayBootstrapSecret(configPath)).resolves.toBe("gw-token");
  });

  it("returns null when no secret is configured", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(configPath, YAML.stringify({ channels: { websocket: { enabled: true } } }), "utf8");

    await expect(readAgentGatewayBootstrapSecret(configPath)).resolves.toBeNull();
  });

  it("returns null when the config file is missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-config-"));
    const configPath = resolveDefaultMemmyConfigPath(tempDir);

    await expect(readAgentGatewayBootstrapSecret(configPath)).resolves.toBeNull();
  });
});

describe("mapModelProtocol", () => {
  it("maps local API providers to agent and Memory providers", () => {
    expect(mapModelProtocol("google")).toEqual({
      agentProvider: "gemini",
      agentApiType: "auto",
      memoryProvider: "gemini"
    });
    expect(mapModelProtocol("qwen")).toEqual({
      agentProvider: "dashscope",
      agentApiType: "auto",
      memoryProvider: "openai_compatible"
    });
  });
});
