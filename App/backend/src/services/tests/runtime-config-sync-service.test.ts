/** Runtime config sync service tests. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createMemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";
import { createAppConfigService } from "../app-config-service.js";
import { syncRuntimeConfigWithAppState } from "../runtime-config-sync-service.js";

let tempDir: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("syncRuntimeConfigWithAppState", () => {
  it("hydrates BYOK mode without projecting the catalog into legacy SQLite model config", async () => {
    const context = createContext();
    context.writeConfig(currentByokCatalog());
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "account" });
    const legacyBefore = context.store.db.prepare("SELECT * FROM account_model_config ORDER BY uuid").all();

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "phone"
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "byok",
      provider: "openai",
      model: "gpt-5",
      hydratedAppState: true,
      wroteConfig: false
    });

    expect(context.store.db.prepare("SELECT * FROM account_model_config ORDER BY uuid").all()).toEqual(legacyBefore);
  });

  it("hydrates account mode only from a current owner-bound projection", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: "a@example.test", phoneNumber: null, nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "owner-a", email: "a@example.test", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a",
      authChannel: "email"
    });
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "user-b", email: "b@example.test", phoneNumber: null, nickname: "b", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-03T10:00:00.000Z",
        rawProfile: { id: "user-b", email: "b@example.test", userName: "b" }
      },
      uuid: "account-b",
      cloudUuid: "cloud-token-b",
      authChannel: "email"
    });
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({
      source: "runtime_config", mode: "account", hydratedAppState: true, wroteConfig: false
    });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("account");
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "owner-a" }
    });
    expect(context.store.db.prepare("SELECT uuid FROM cloud_accounts WHERE uuid = ?").get("cloud-token-a")).toBeUndefined();
  });

  it("keeps a legacy INTL email session that predates persisted login channels", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: "a@example.test", phoneNumber: null, nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-07-28T10:00:00.000Z",
        rawProfile: { id: "owner-a", email: "a@example.test", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a"
    });
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "account",
      hydratedAppState: true,
      wroteConfig: false,
      reason: "hydrated_account_from_runtime_config"
    });

    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "owner-a" }
    });
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.memmy_account.apiKey).toBe("cloud-token-a");
  });

  it("clears an email session before CN startup hydrates the shared account projection", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: "a@example.test", phoneNumber: null, nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "owner-a", email: "a@example.test", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a",
      authChannel: "email"
    });
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "phone"
    })).resolves.toMatchObject({
      source: "none",
      hydratedAppState: false,
      reason: "account_session_channel_mismatch"
    });

    expect(context.store.repositories.accountSession.get()).toEqual({ authenticated: false });
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.cloudUuid).toBeUndefined();
    expect(saved.app.userId).toBeUndefined();
    expect(saved.providers.memmy_account).toBeUndefined();
  });

  it("clears a phone session before INTL startup hydrates the shared account projection", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: null, phoneNumber: "13800138000", nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "owner-a", phoneNumber: "13800138000", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a",
      authChannel: "phone"
    });
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({
      source: "none",
      hydratedAppState: false,
      reason: "account_session_channel_mismatch"
    });

    expect(context.store.repositories.accountSession.get()).toEqual({ authenticated: false });
  });

  it("clears a mismatched active session even when the account projection is already incomplete", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: "a@example.test", phoneNumber: null, nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "owner-a", email: "a@example.test", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a"
    });
    context.writeConfig({ app: { userMode: "account" } });

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "phone"
    })).resolves.toMatchObject({
      source: "none",
      hydratedAppState: false,
      reason: "account_session_channel_mismatch"
    });

    expect(context.store.repositories.accountSession.get()).toEqual({ authenticated: false });
  });

  it("keeps BYOK active while clearing an untrusted dormant account projection", async () => {
    const context = createContext();
    const byok = currentByokCatalog() as any;
    const account = currentAccountCatalog() as any;
    context.writeConfig({
      ...byok,
      app: { ...account.app, userMode: "byok" },
      providers: { ...byok.providers, ...account.providers },
      modelPresets: { ...byok.modelPresets, ...account.modelPresets },
      modelAssignments: {
        byok: byok.modelAssignments.byok,
        account: account.modelAssignments.account
      }
    });

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "phone"
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "byok",
      provider: "openai",
      model: "gpt-5"
    });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("byok");
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.memmy_account).toBeUndefined();
  });

  it("preserves a dormant account projection owned by the current package channel", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: "a@example.test", phoneNumber: "13800138000", nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "owner-a", email: "a@example.test", phoneNumber: "13800138000", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a",
      authChannel: "email"
    });
    const byok = currentByokCatalog() as any;
    const account = currentAccountCatalog() as any;
    context.writeConfig({
      ...byok,
      app: { ...account.app, userMode: "byok" },
      providers: { ...byok.providers, ...account.providers },
      modelPresets: { ...byok.modelPresets, ...account.modelPresets },
      modelAssignments: { byok: byok.modelAssignments.byok, account: account.modelAssignments.account }
    });

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({ mode: "byok", wroteConfig: false });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.memmy_account.apiKey).toBe("cloud-token-a");
  });

  it("clears an account projection that has no matching local credential", async () => {
    const context = createContext();
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "phone"
    })).resolves.toMatchObject({
      source: "none",
      hydratedAppState: false,
      reason: "account_projection_has_no_matching_local_session",
      wroteConfig: true
    });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.cloudUuid).toBeUndefined();
    expect(saved.providers.memmy_account).toBeUndefined();
  });

  it("clears conflicting app and provider account credentials before startup", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: "a@example.test", phoneNumber: null, nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "owner-a", email: "a@example.test", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a",
      authChannel: "email"
    });
    const config = currentAccountCatalog() as any;
    config.providers.memmy_account.apiKey = "foreign-cloud-token";
    context.writeConfig(config);

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({
      source: "none",
      hydratedAppState: false,
      wroteConfig: true,
      reason: "cleared_conflicting_account_credentials"
    });

    expect(context.store.repositories.accountSession.get()).toEqual({ authenticated: false });
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.cloudUuid).toBeUndefined();
    expect(saved.providers.memmy_account).toBeUndefined();
  });

  it("persists account/BYOK mode switches through settings and honors them after restart", async () => {
    const context = createContext();
    context.store.repositories.accountSession.upsert({
      profile: {
        userId: "owner-a", email: "a@example.test", phoneNumber: null, nickname: "a", avatarUrl: null,
        planType: "free", hasFinishedGuide: false, region: null, registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "owner-a", email: "a@example.test", userName: "a" }
      },
      uuid: "account-a",
      cloudUuid: "cloud-token-a"
    });
    const byok = currentByokCatalog() as any;
    const account = currentAccountCatalog() as any;
    const byokSnapshot = {
      providers: byok.providers,
      modelPresets: byok.modelPresets,
      modelAssignments: byok.modelAssignments.byok,
    };
    context.writeConfig({
      ...byok,
      app: { ...account.app, userMode: "account" },
      providers: { ...byok.providers, ...account.providers },
      modelPresets: { ...byok.modelPresets, ...account.modelPresets },
      modelAssignments: {
        byok: byok.modelAssignments.byok,
        account: account.modelAssignments.account,
      },
    });
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "account" });
    const service = createAppConfigService({
      bootstrapRepository: context.store.repositories.bootstrap,
      memmyConfigWriter: createMemmyConfigWriter({ configPath: context.memmyConfigPath }),
    });

    await service.updateSettings({ userMode: "byok" });
    let saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.userMode).toBe("byok");
    expect({
      providers: { openai: saved.providers.openai, dashscope: saved.providers.dashscope },
      modelPresets: { agent: saved.modelPresets.agent, summary: saved.modelPresets.summary, image: saved.modelPresets.image },
      modelAssignments: saved.modelAssignments.byok,
    }).toEqual(byokSnapshot);
    await expect(syncRuntimeConfigWithAppState(context)).resolves.toMatchObject({ mode: "byok", provider: "openai" });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("byok");

    await service.updateSettings({ userMode: "account" });
    saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.userMode).toBe("account");
    await expect(syncRuntimeConfigWithAppState(context)).resolves.toMatchObject({ mode: "account", provider: "memmy_account" });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("account");
  });

  it("never recreates missing YAML from legacy SQLite app-state", async () => {
    const context = createContext();
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
    context.store.db.prepare(
      `UPDATE account_model_config
       SET provider = 'openai_compatible', base_url = 'https://legacy.example.test/v1', model_id = 'legacy-model'
       WHERE uuid = 'local-byok-onboarding'`
    ).run();

    await expect(syncRuntimeConfigWithAppState(context)).resolves.toEqual({
      source: "none",
      mode: "byok",
      hydratedAppState: false,
      wroteConfig: false,
      reason: "missing_runtime_config_requires_startup_migration"
    });
    expect(existsSync(context.memmyConfigPath)).toBe(false);
  });

  it("rejects invalid runtime YAML without overwriting app-state", async () => {
    const context = createContext();
    context.store.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
    context.writeRaw("agents: [");
    await expect(syncRuntimeConfigWithAppState(context)).rejects.toMatchObject({ code: "invalid_runtime_config" });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("byok");
  });
});

function currentByokCatalog(): Record<string, unknown> {
  return {
    app: { userMode: "byok" },
    agents: { defaults: { modelPreset: "agent" } },
    providers: {
      openai: {
        apiKey: "sk-main",
        endpoints: { chat: { apiBase: "https://api.example.test/v1", protocol: "openai-chat-completions" } }
      },
      dashscope: {
        endpoints: { image: { apiBase: "https://image.example.test/v1", protocol: "dashscope-multimodal-generation", apiKey: "sk-image" } }
      }
    },
    modelPresets: {
      agent: { provider: "openai", endpoint: "chat", model: "gpt-5", source: "byok", capabilities: ["agent", "memory_evolution"] },
      summary: { provider: "openai", endpoint: "chat", model: "gpt-5-mini", source: "byok", capabilities: ["memory_summary"] },
      image: { provider: "dashscope", endpoint: "image", model: "qwen-image", source: "byok", capabilities: ["image_generation"] }
    },
    modelAssignments: {
      byok: {
        agent: { candidates: ["agent"], default: "agent" },
        memorySummary: "summary", memoryEvolution: "agent", embedding: null, asr: null, imageGeneration: "image"
      },
      account: { agent: { candidates: [], default: null } }
    }
  };
}

function currentAccountCatalog(): Record<string, unknown> {
  return {
    app: { cloudUuid: "cloud-token-a", userId: "owner-a", userMode: "account" },
    providers: {
      memmy_account: {
        ownerAccountId: "owner-a",
        apiKey: "cloud-token-a",
        endpoints: { platform: { apiBase: "https://cloud.example.test/api/agentExternal/v1", protocol: "memmy-account" } }
      }
    },
    modelPresets: {
      platform: {
        provider: "memmy_account", endpoint: "platform", model: "agent_chat", source: "account",
        ownerAccountId: "owner-a", capabilities: ["agent"]
      }
    },
    modelAssignments: {
      byok: { agent: { candidates: [], default: null } },
      account: { ownerAccountId: "owner-a", agent: { candidates: ["platform"], default: "platform" } }
    }
  };
}

function createContext(): {
  appStateStore: AppStateStore;
  store: AppStateStore;
  memmyConfigPath: string;
  writeConfig(config: Record<string, unknown>): void;
  writeRaw(content: string): void;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-runtime-sync-"));
  store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });
  const memmyConfigPath = join(tempDir, ".memmy", "config.yaml");
  const writeRaw = (content: string): void => {
    mkdirSync(dirname(memmyConfigPath), { recursive: true });
    writeFileSync(memmyConfigPath, content, "utf8");
  };
  return {
    appStateStore: store,
    store,
    memmyConfigPath,
    writeConfig(config) { writeRaw(YAML.stringify(config)); },
    writeRaw
  };
}
