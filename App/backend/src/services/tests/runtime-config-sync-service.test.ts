/** Runtime config sync service tests. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import * as memmyConfig from "../../infrastructure/memmy-config/index.js";
import {
  createMemmyConfigWriter,
  writeAccountModelProjectionToMemmyConfig
} from "../../infrastructure/memmy-config/index.js";
import { createAppConfigService } from "../app-config-service.js";
import { syncRuntimeConfigWithAppState } from "../runtime-config-sync-service.js";

let tempDir: string | undefined;
let store: AppStateStore | undefined;
const originalCloudService = process.env.MEMMY_CLOUD_SERVICE;

beforeEach(() => {
  process.env.MEMMY_CLOUD_SERVICE = "https://cloud.example.test";
});

afterEach(() => {
  vi.restoreAllMocks();
  store?.close();
  store = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  if (originalCloudService === undefined) delete process.env.MEMMY_CLOUD_SERVICE;
  else process.env.MEMMY_CLOUD_SERVICE = originalCloudService;
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

  it("restores built-in models when an authenticated account has an unset runtime projection", async () => {
    const context = createContext();
    seedAccountSession(context, "phone");
    const config = currentByokCatalog() as any;
    config.app.userMode = "unset";
    config.modelAssignments.account = {
      ownerAccountId: "owner-a",
      agent: { candidates: ["missing-account-preset"], default: "missing-account-preset" }
    };
    context.writeConfig(config);

    const writeProjection = vi.spyOn(memmyConfig, "writeAccountModelProjectionToMemmyConfig");
    const activateSession = vi.spyOn(context.store.repositories.accountSession, "activateByCloudUuid");
    const updateSettings = vi.spyOn(context.store.repositories.bootstrap, "updateAppSettings");

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "phone"
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "account",
      provider: "memmy_account",
      model: "agent_chat",
      hydratedAppState: true,
      wroteConfig: true,
      reason: "restored_account_projection_and_hydrated_account"
    });
    expect(writeProjection).toHaveBeenCalledTimes(1);
    expect(activateSession).toHaveBeenCalledWith("cloud-token-a", "phone");
    expect(updateSettings).toHaveBeenCalledWith({ userMode: "account" });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.userMode).toBe("account");
    expect(saved.providers.memmy_account).toMatchObject({
      ownerAccountId: "owner-a",
      apiKey: "cloud-token-a"
    });
    expect(saved.modelAssignments.account.agent.candidates).toContainEqual(
      expect.stringMatching(/^memmy-account-.+-agent$/)
    );

    const repairedConfig = readFileSync(context.memmyConfigPath, "utf8");
    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "phone"
    })).resolves.toMatchObject({
      mode: "account",
      hydratedAppState: true,
      wroteConfig: false,
      reason: "hydrated_account_from_runtime_config"
    });
    // A normal restart still refreshes the projection, but makes no redundant changes.
    expect(writeProjection).toHaveBeenCalledTimes(2);
    expect(readFileSync(context.memmyConfigPath, "utf8")).toBe(repairedConfig);
  });

  it("validates the session after repairing a missing account projection", async () => {
    const context = createContext();
    seedAccountSession(context);
    const config = currentByokCatalog() as any;
    config.app.userMode = "unset";
    context.writeConfig(config);
    const writeProjection = vi.spyOn(memmyConfig, "writeAccountModelProjectionToMemmyConfig");
    vi.spyOn(context.store.repositories.accountSession, "activateByCloudUuid").mockReturnValue(false);
    const updateSettings = vi.spyOn(context.store.repositories.bootstrap, "updateAppSettings");

    await expect(syncRuntimeConfigWithAppState({ ...context, accountChannel: "email" }))
      .resolves.toMatchObject({
        source: "none",
        hydratedAppState: false,
        wroteConfig: true,
        reason: "account_projection_has_no_matching_local_session"
      });
    expect(writeProjection).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.memmy_account).toBeUndefined();
  });

  it("refreshes a different account if its projection replaces the repaired config before hydration", async () => {
    const context = createContext();
    seedAccountSession(context);
    const session = context.store.repositories.accountSession.get();
    if (!session.authenticated) throw new Error("Expected the seeded account session");
    context.store.repositories.accountSession.upsert({
      profile: { ...session.profile, userId: "owner-b" },
      uuid: "account-b",
      cloudUuid: "cloud-token-b",
      authChannel: "email"
    });
    context.store.repositories.accountSession.activateByCloudUuid("cloud-token-a", "email");
    const config = currentByokCatalog() as any;
    config.app.userMode = "unset";
    context.writeConfig(config);
    const originalWrite = memmyConfig.writeAccountModelProjectionToMemmyConfig;
    const writeProjection = vi.spyOn(memmyConfig, "writeAccountModelProjectionToMemmyConfig")
      .mockImplementationOnce(async (...args) => {
        const result = await originalWrite(...args);
        // Model a concurrent account switch while the repaired config is being re-read.
        context.writeRaw(YAML.stringify(currentAccountCatalog())
          .replaceAll("owner-a", "owner-b")
          .replaceAll("cloud-token-a", "cloud-token-b"));
        return result;
      });

    await expect(syncRuntimeConfigWithAppState({ ...context, accountChannel: "email" }))
      .resolves.toMatchObject({ mode: "account", hydratedAppState: true, wroteConfig: true });
    expect(writeProjection).toHaveBeenCalledTimes(2);
    expect(writeProjection).toHaveBeenLastCalledWith({
      cloudUuid: "cloud-token-b", userId: "owner-b", preserveAccountByokSelection: true
    }, context.memmyConfigPath);
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true, profile: { userId: "owner-b" }
    });
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.memmy_account.ownerAccountId).toBe("owner-b");
    expect(saved.modelAssignments.account.ownerAccountId).toBe("owner-b");
    expect(saved.modelPresets[saved.modelAssignments.account.memorySummary]).toMatchObject({
      source: "account", ownerAccountId: "owner-b", capabilities: ["memory_summary"]
    });
  });

  it("keeps an explicit BYOK runtime selection while the account remains authenticated", async () => {
    const context = createContext();
    seedAccountSession(context);
    context.writeConfig(currentByokCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "byok",
      provider: "openai",
      model: "gpt-5"
    });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.memmy_account).toBeUndefined();
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
      source: "runtime_config", mode: "account", hydratedAppState: true, wroteConfig: true
    });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("account");
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "owner-a" }
    });
    expect(context.store.db.prepare("SELECT uuid FROM cloud_accounts WHERE uuid = ?").get("cloud-token-a")).toBeUndefined();
  });

  it("refreshes local BYOK Agent candidates into an already authenticated account during startup", async () => {
    const context = createContext();
    seedAccountSession(context);
    context.writeConfig(currentByokCatalog());
    await writeAccountModelProjectionToMemmyConfig({
      cloudUuid: "cloud-token-a",
      userId: "owner-a"
    }, context.memmyConfigPath);

    const stale = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    stale.app.userMode = "account";
    stale.app.accountByokLocalSelectionBaseline = {
      ownerAccountId: "owner-a",
      candidates: ["agent"]
    };
    stale.modelAssignments.account.agent.candidates = stale.modelAssignments.account.agent.candidates
      .filter((presetId: string) => stale.modelPresets[presetId]?.source === "account");
    stale.modelAssignments.account.agent.default = stale.modelAssignments.account.agent.candidates[0];
    context.writeConfig(stale);

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "account",
      hydratedAppState: true,
      wroteConfig: true,
      reason: "refreshed_account_projection_and_hydrated_account"
    });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.modelAssignments.account.agent.candidates).toContain("agent");
    expect(saved.app.accountByokLocalSelectionBaseline).toBeUndefined();
  });

  it("keeps an account-only custom Agent candidate across a normal restart", async () => {
    const context = createContext();
    seedAccountSession(context);
    context.writeConfig(currentByokCatalog());
    await writeAccountModelProjectionToMemmyConfig({
      cloudUuid: "cloud-token-a",
      userId: "owner-a"
    }, context.memmyConfigPath);
    const configured = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    configured.app.userMode = "account";
    configured.modelPresets.accountOnly = {
      provider: "openai",
      endpoint: "chat",
      model: "qwen3.8-flash",
      source: "byok",
      capabilities: ["agent"]
    };
    configured.modelAssignments.account.agent.candidates.push("accountOnly");
    configured.modelAssignments.account.agent.default = "accountOnly";
    context.writeConfig(configured);

    await syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    });

    const restarted = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(restarted.modelAssignments.account.agent).toEqual({
      candidates: [
        expect.stringMatching(/^memmy-account-.+-agent$/),
        "agent",
        "accountOnly"
      ],
      default: "accountOnly"
    });
    expect(restarted.modelAssignments.byok.agent).toEqual({
      candidates: ["agent"],
      default: "agent"
    });
  });

  it("keeps an unmarked legacy email session when the INTL package starts", async () => {
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
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email"
    })).resolves.toMatchObject({
      source: "runtime_config", mode: "account", hydratedAppState: true, wroteConfig: true
    });
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "owner-a" }
    });
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

  it("restores the account model projection from an authoritative migrated session without losing BYOK", async () => {
    const context = createContext();
    seedAccountSession(context);
    const byok = currentByokCatalog() as any;
    context.writeConfig({
      ...byok,
      app: { ...byok.app, userMode: "account" }
    });

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email",
      migrationConsistency: {
        accountSourceIsAuthoritative: true,
        runtimeSourceWasMigrated: false,
        categorySourcesShareGeneration: false
      }
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "account",
      provider: "memmy_account",
      hydratedAppState: true
    });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.openai).toEqual(byok.providers.openai);
    expect(saved.modelAssignments.byok).toEqual(byok.modelAssignments.byok);
    expect(saved.providers.memmy_account).toMatchObject({
      ownerAccountId: "owner-a",
      apiKey: "cloud-token-a"
    });
    expect(saved.modelAssignments.account.ownerAccountId).toBe("owner-a");
  });

  it.each([false, true])("preserves explicit BYOK while repairing a migrated account projection (runtime migrated: %s)", async (runtimeSourceWasMigrated) => {
    const context = createContext();
    seedAccountSession(context);
    const byok = currentByokCatalog() as any;
    context.writeConfig({ ...byok, app: { ...byok.app, userMode: "byok" } });

    const options = {
      ...context,
      accountChannel: "email" as const,
      migrationConsistency: {
        accountSourceIsAuthoritative: true,
        runtimeSourceWasMigrated,
        categorySourcesShareGeneration: false
      }
    };
    await expect(syncRuntimeConfigWithAppState(options)).resolves.toMatchObject({
      mode: "byok", provider: "openai", model: "gpt-5", hydratedAppState: true
    });
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.userMode).toBe("byok");
    expect(saved.providers.openai).toEqual(byok.providers.openai);
    expect(saved.modelAssignments.byok).toEqual(byok.modelAssignments.byok);
    expect(saved.providers.memmy_account).toMatchObject({ ownerAccountId: "owner-a", apiKey: "cloud-token-a" });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("byok");
    expect(context.store.repositories.accountSession.get()).toMatchObject({ authenticated: true });
    const snapshot = readFileSync(context.memmyConfigPath, "utf8");
    await expect(syncRuntimeConfigWithAppState(options)).resolves.toMatchObject({ mode: "byok", wroteConfig: false });
    expect(readFileSync(context.memmyConfigPath, "utf8")).toBe(snapshot);
  });

  it("restores the active account after an upgrade left active_uuid empty", async () => {
    const context = createContext();
    seedAccountSession(context);
    context.store.db.prepare("UPDATE app_settings SET active_uuid = NULL WHERE id = 'default'").run();
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email",
      migrationConsistency: {
        accountSourceIsAuthoritative: true,
        runtimeSourceWasMigrated: true,
        categorySourcesShareGeneration: false
      }
    })).resolves.toMatchObject({
      source: "runtime_config",
      mode: "account",
      hydratedAppState: true
    });

    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "owner-a" }
    });
    expect(context.store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get())
      .toMatchObject({ active_uuid: "account-a" });
  });

  it("uses an authoritative migrated account database to replace only a stale account projection", async () => {
    const context = createContext();
    seedAccountSession(context);
    const byok = currentByokCatalog() as any;
    const staleAccount = currentAccountCatalog() as any;
    staleAccount.app.cloudUuid = "stale-cloud-token";
    staleAccount.app.userId = "stale-owner";
    staleAccount.providers.memmy_account.apiKey = "stale-cloud-token";
    staleAccount.providers.memmy_account.ownerAccountId = "stale-owner";
    staleAccount.modelPresets.platform.ownerAccountId = "stale-owner";
    staleAccount.modelAssignments.account.ownerAccountId = "stale-owner";
    context.writeConfig({
      ...byok,
      app: { ...staleAccount.app, userMode: "account" },
      providers: { ...byok.providers, ...staleAccount.providers },
      modelPresets: { ...byok.modelPresets, ...staleAccount.modelPresets },
      modelAssignments: {
        byok: byok.modelAssignments.byok,
        account: staleAccount.modelAssignments.account
      }
    });

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email",
      migrationConsistency: {
        accountSourceIsAuthoritative: true,
        runtimeSourceWasMigrated: false,
        categorySourcesShareGeneration: false
      }
    })).resolves.toMatchObject({ mode: "account", hydratedAppState: true });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.openai).toEqual(byok.providers.openai);
    expect(saved.modelAssignments.byok).toEqual(byok.modelAssignments.byok);
    expect(saved.providers.memmy_account.ownerAccountId).toBe("owner-a");
    expect(saved.modelAssignments.account.ownerAccountId).toBe("owner-a");
    expect(JSON.stringify(saved)).not.toContain("stale-owner");
  });

  it("fills a missing migrated account owner from the authoritative account database", async () => {
    const context = createContext();
    seedAccountSession(context);
    const config = currentAccountCatalog() as any;
    delete config.app.userId;
    delete config.providers.memmy_account.ownerAccountId;
    delete config.modelPresets.platform.ownerAccountId;
    delete config.modelAssignments.account.ownerAccountId;
    context.writeConfig(config);

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email",
      migrationConsistency: {
        accountSourceIsAuthoritative: true,
        runtimeSourceWasMigrated: false,
        categorySourcesShareGeneration: false
      }
    })).resolves.toMatchObject({ mode: "account", hydratedAppState: true });

    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.app.userId).toBe("owner-a");
    expect(saved.providers.memmy_account.ownerAccountId).toBe("owner-a");
    expect(saved.modelAssignments.account.ownerAccountId).toBe("owner-a");
  });

  it("rejects a same-generation migrated account owner mismatch without clearing either side", async () => {
    const context = createContext();
    seedAccountSession(context);
    const config = currentAccountCatalog() as any;
    config.app.cloudUuid = "foreign-token";
    config.app.userId = "foreign-owner";
    config.providers.memmy_account.apiKey = "foreign-token";
    config.providers.memmy_account.ownerAccountId = "foreign-owner";
    config.modelPresets.platform.ownerAccountId = "foreign-owner";
    config.modelAssignments.account.ownerAccountId = "foreign-owner";
    context.writeConfig(config);

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email",
      migrationConsistency: {
        accountSourceIsAuthoritative: true,
        runtimeSourceWasMigrated: true,
        categorySourcesShareGeneration: true
      }
    })).rejects.toMatchObject({ code: "windows_data_migration_inconsistent" });

    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "owner-a" }
    });
    const saved = YAML.parse(readFileSync(context.memmyConfigPath, "utf8"));
    expect(saved.providers.memmy_account.ownerAccountId).toBe("foreign-owner");
  });

  it("rejects a migrated authentication-channel mismatch without logging the user out", async () => {
    const context = createContext();
    seedAccountSession(context, "phone");
    context.writeConfig(currentAccountCatalog());

    await expect(syncRuntimeConfigWithAppState({
      ...context,
      accountChannel: "email",
      migrationConsistency: {
        accountSourceIsAuthoritative: true,
        runtimeSourceWasMigrated: true,
        categorySourcesShareGeneration: true
      }
    })).rejects.toMatchObject({ code: "windows_data_migration_inconsistent" });
    expect(context.store.repositories.accountSession.get()).toMatchObject({ authenticated: true });
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

function seedAccountSession(
  context: ReturnType<typeof createContext>,
  authChannel: "email" | "phone" = "email"
): void {
  context.store.repositories.accountSession.upsert({
    profile: {
      userId: "owner-a",
      email: authChannel === "email" ? "a@example.test" : null,
      phoneNumber: authChannel === "phone" ? "13800138000" : null,
      nickname: "a",
      avatarUrl: null,
      planType: "free",
      hasFinishedGuide: false,
      region: null,
      registeredAt: "2026-06-02T10:00:00.000Z",
      rawProfile: { id: "owner-a", userName: "a" }
    },
    uuid: "account-a",
    cloudUuid: "cloud-token-a",
    authChannel
  });
  context.store.repositories.bootstrap.updateAppSettings({ userMode: "account" });
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
