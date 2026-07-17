/** Runtime config sync service tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_BYOK_ACCOUNT_UUID } from "../../infrastructure/app-state-store/account-context.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { syncRuntimeConfigWithAppState } from "../runtime-config-sync-service.js";

let tempDir: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("syncRuntimeConfigWithAppState", () => {
  it("hydrates BYOK app-state from valid runtime YAML", async () => {
    const context = createContext();
    context.writeConfig([
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
    ]);
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "account" });

    await expect(syncRuntimeConfigWithAppState(context)).resolves.toMatchObject({
      source: "runtime_config",
      mode: "byok",
      hydratedAppState: true,
      wroteConfig: false
    });

    const settings = context.store.repositories.bootstrap.getAppSettings();
    const modelConfig = context.store.repositories.modelConfig.get();
    const activeUuid = context.store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as {
      active_uuid: string | null;
    };
    const refs = context.store.db
      .prepare("SELECT api_key_ref, memory_api_key_ref, skill_api_key_ref, image_api_key_ref FROM account_model_config WHERE uuid = ?")
      .get(LOCAL_BYOK_ACCOUNT_UUID) as Record<string, unknown>;

    expect(settings.userMode).toBe("byok");
    expect(activeUuid.active_uuid).toBeNull();
    expect(modelConfig).toMatchObject({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.example/v1",
      modelId: "gpt-4o",
      hasApiKey: true,
      imageGen: {
        provider: "qwen",
        baseUrl: "https://dashscope.aliyuncs.com",
        modelId: "qwen-image",
        hasApiKey: true
      },
      memmyMemory: {
        summary: {
          provider: "anthropic",
          baseUrl: "https://api.anthropic.example",
          modelId: "claude-3-5-haiku",
          hasApiKey: true
        },
        evolution: {
          provider: "openai_compatible",
          baseUrl: "https://dashscope.example/v1",
          modelId: "qwen-plus",
          hasApiKey: true
        }
      }
    });
    expect(refs).toEqual({
      api_key_ref: `account:${LOCAL_BYOK_ACCOUNT_UUID}:model-api-key`,
      memory_api_key_ref: `account:${LOCAL_BYOK_ACCOUNT_UUID}:memory-summary-api-key`,
      skill_api_key_ref: `account:${LOCAL_BYOK_ACCOUNT_UUID}:memory-evolution-api-key`,
      image_api_key_ref: `account:${LOCAL_BYOK_ACCOUNT_UUID}:image-gen-api-key`
    });
  });

  it("hydrates account mode without fabricating a cloud account profile", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "user-2",
        email: "other@example.com",
        phoneNumber: null,
        nickname: "other",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-03T10:00:00.000Z",
        rawProfile: {
          id: "user-2",
          email: "other@example.com",
          userName: "other"
        }
      },
      uuid: "cloud-account-b",
      cloudUuid: "cloud.login.uuid.b"
    });
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
    context.writeConfig([
      "app:",
      "  cloudUuid: cloud.login.uuid.a",
      "  userId: user-1",
      "agents:",
      "  defaults:",
      "    provider: memmy_account",
      "    model: agent_chat",
      "providers:",
      "  memmy_account:",
      `    apiBase: ${process.env.MEMMY_CLOUD_SERVICE}/api/agentExternal/v1`,
      "    apiKey: cloud.login.uuid.a",
      "memmyMemory:",
      "  activeProfile: account",
      ""
    ]);

    await expect(syncRuntimeConfigWithAppState(context)).resolves.toMatchObject({
      source: "runtime_config",
      mode: "account",
      hydratedAppState: true
    });

    const settings = context.store.repositories.bootstrap.getAppSettings();
    const activeUuid = context.store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as {
      active_uuid: string | null;
    };
    const fabricatedAccount = context.store.db.prepare("SELECT uuid FROM cloud_accounts WHERE uuid = ?").get("cloud.login.uuid.a");

    expect(settings.userMode).toBe("account");
    expect(activeUuid.active_uuid).toBeNull();
    expect(fabricatedAccount).toBeUndefined();
  });

  it("initializes missing runtime YAML from valid BYOK app-state", async () => {
    const context = createContext();
    context.store.repositories.modelConfig.upsert({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1-mini",
      apiKey: "sk-main",
      memmyMemory: {
        summary: {
          provider: "openai_compatible",
          baseUrl: "https://memory.example.com/v1",
          modelId: "memory-model",
          apiKey: "sk-memory"
        },
        evolution: {
          provider: "openai_compatible",
          baseUrl: "https://skill.example.com/v1",
          modelId: "skill-model",
          apiKey: "sk-skill"
        }
      },
      imageGen: {
        provider: "doubao",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        modelId: "doubao-seedream-4-0-250828",
        apiKey: "sk-image"
      }
    });
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "byok" });

    await expect(syncRuntimeConfigWithAppState(context)).resolves.toMatchObject({
      source: "app_state_fallback",
      mode: "byok",
      wroteConfig: true
    });

    const parsed = YAML.parse(readFileSync(context.memmyConfigPath, "utf8")) as any;
    expect(parsed.agents.defaults).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini"
    });
    expect(parsed.providers.openai).toMatchObject({
      apiBase: "https://api.example.com/v1",
      apiKey: "sk-main"
    });
    expect(parsed.memmyMemory.activeProfile).toBe("byok");
    expect(parsed.memmyMemory.profiles.byok.summary).toMatchObject({
      endpoint: "https://memory.example.com/v1",
      model: "memory-model",
      apiKey: "sk-memory"
    });
    expect(parsed.tools.imageGeneration).toMatchObject({
      activeProfile: "byok",
      profiles: {
        byok: {
          provider: "volcengine",
          model: "doubao-seedream-4-0-250828",
          apiBase: "https://ark.cn-beijing.volces.com/api/v3",
          apiKey: "sk-image"
        }
      }
    });
  });

  it("rejects invalid runtime YAML without overwriting app-state", async () => {
    const context = createContext();
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
    context.writeConfig(["agents: ["]);

    await expect(syncRuntimeConfigWithAppState(context)).rejects.toMatchObject({
      code: "invalid_runtime_config"
    });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("byok");
  });
});

function createContext(): {
  appStateStore: AppStateStore;
  store: AppStateStore;
  memmyConfigPath: string;
  writeConfig(lines: string[]): void;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-runtime-sync-"));
  store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });
  const memmyConfigPath = join(tempDir, ".memmy", "config.yaml");
  return {
    appStateStore: store,
    store,
    memmyConfigPath,
    writeConfig(lines) {
      mkdirSync(dirname(memmyConfigPath), { recursive: true });
      writeFileSync(memmyConfigPath, lines.join("\n"), "utf8");
    }
  };
}
