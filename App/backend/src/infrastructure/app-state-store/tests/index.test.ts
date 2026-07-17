import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore } from "../index.js";
import { createSqliteSecretStore } from "../secret-store.js";
import { LOCAL_BYOK_ACCOUNT_UUID } from "../account-context.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("app state store migrations", () => {
  it("creates initial tables and seed rows idempotently", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");

    const firstStore = createAppStateStore({ databasePath });
    const onboarding = firstStore.repositories.bootstrap.getOnboardingState();
    const firstMigrationCount = getMigrationCount(firstStore.db);
    firstStore.close();

    const secondStore = createAppStateStore({ databasePath });
    const secondMigrationCount = getMigrationCount(secondStore.db);
    const settings = secondStore.repositories.bootstrap.getAppSettings();
    const agentSources = secondStore.repositories.agentSources.listSources();
    secondStore.close();

    expect(onboarding).toMatchObject({
      completed: false,
      currentStep: "scan_permission_required",
      scanPermission: "unset"
    });
    expect(settings.userMode).toBe("unset");
    expect(settings.menuBarIconEnabled).toBe(true);
    expect(agentSources).toEqual([]);
    expect(firstMigrationCount).toBe(23);
    expect(secondMigrationCount).toBe(23);
  });

  it("recovers when the ASR migration columns already exist but its migration record is missing", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const initialStore = createAppStateStore({ databasePath });

    initialStore.db.prepare("DELETE FROM _migrations WHERE name = ?").run("0015-asr-model-config.sql");
    initialStore.close();

    const recoveredStore = createAppStateStore({ databasePath });
    const accountModelConfigColumns = listColumnNames(recoveredStore.db, "account_model_config");
    const migration = recoveredStore.db
      .prepare("SELECT name FROM _migrations WHERE name = ?")
      .get("0015-asr-model-config.sql");
    recoveredStore.close();

    expect(accountModelConfigColumns).toEqual(expect.arrayContaining([
      "asr_provider",
      "asr_base_url",
      "asr_model_id",
      "asr_api_key_ref"
    ]));
    expect(migration).toEqual({ name: "0015-asr-model-config.sql" });
  });

  it("recovers when scan preference columns already exist but its migration record is missing", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const initialStore = createAppStateStore({ databasePath });

    initialStore.db.prepare("DELETE FROM _migrations WHERE name = ?").run("0020-scan-preferences.sql");
    initialStore.close();

    const recoveredStore = createAppStateStore({ databasePath });
    const appSettingsColumns = listColumnNames(recoveredStore.db, "app_settings");
    const migration = recoveredStore.db
      .prepare("SELECT name FROM _migrations WHERE name = ?")
      .get("0020-scan-preferences.sql");
    recoveredStore.close();

    expect(appSettingsColumns).toEqual(expect.arrayContaining([
      "auto_scan_known_agents",
      "watch_file_changes",
      "auto_inject_skill"
    ]));
    expect(migration).toEqual({ name: "0020-scan-preferences.sql" });
  });

  it("treats the historical ASR migration filename as the current migration", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const initialStore = createAppStateStore({ databasePath });

    initialStore.db
      .prepare("UPDATE _migrations SET name = ? WHERE name = ?")
      .run("0015-asr-config.sql", "0015-asr-model-config.sql");
    initialStore.close();

    const recoveredStore = createAppStateStore({ databasePath });
    const currentMigration = recoveredStore.db
      .prepare("SELECT name FROM _migrations WHERE name = ?")
      .get("0015-asr-model-config.sql");
    const historicalMigration = recoveredStore.db
      .prepare("SELECT name FROM _migrations WHERE name = ?")
      .get("0015-asr-config.sql");
    recoveredStore.close();

    expect(currentMigration).toEqual({ name: "0015-asr-model-config.sql" });
    expect(historicalMigration).toBeUndefined();
  });

  it("repairs missing default seed rows when reopening an existing database", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const initialStore = createAppStateStore({ databasePath });

    initialStore.db.exec("DELETE FROM app_settings;");
    initialStore.close();

    const repairedStore = createAppStateStore({ databasePath });
    const onboarding = repairedStore.repositories.bootstrap.getOnboardingState();
    const session = repairedStore.repositories.accountSession.get();
    repairedStore.close();

    expect(onboarding).toMatchObject({
      completed: false,
      currentStep: "scan_permission_required"
    });
    expect(session).toEqual({ authenticated: false });
  });

  it("scopes BYOK onboarding to the local scope even when a stale cloud account stays active", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });
    const { bootstrap } = store.repositories;

    const now = new Date().toISOString();
    store.db
      .prepare("INSERT OR IGNORE INTO cloud_accounts (uuid, created_at, updated_at) VALUES (?, ?, ?)")
      .run("acct-stale", now, now);
    store.db
      .prepare("INSERT OR IGNORE INTO account_onboarding_state (uuid, created_at, updated_at) VALUES (?, ?, ?)")
      .run("acct-stale", now, now);
    store.db.prepare("UPDATE app_settings SET active_uuid = ? WHERE id = 'default'").run("acct-stale");

    bootstrap.updateAppSettings({ userMode: "byok" });
    bootstrap.updateOnboarding({ completed: true, currentStep: "completed" });

    const onboarding = bootstrap.getOnboardingState();
    const byokRow = store.db
      .prepare("SELECT has_finished_guide FROM account_onboarding_state WHERE uuid = ?")
      .get(LOCAL_BYOK_ACCOUNT_UUID) as { has_finished_guide: number } | undefined;
    const staleAccountRow = store.db
      .prepare("SELECT has_finished_guide FROM account_onboarding_state WHERE uuid = ?")
      .get("acct-stale") as { has_finished_guide: number } | undefined;
    store.close();

    expect(onboarding.completed).toBe(true);
    expect(byokRow?.has_finished_guide).toBe(1);
    expect(staleAccountRow?.has_finished_guide ?? 0).toBe(0);
  });

  it("keeps pure BYOK onboarding completion after closing and reopening the database", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");

    const first = createAppStateStore({ databasePath });
    first.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
    first.repositories.bootstrap.updateOnboarding({ completed: true, currentStep: "completed" });
    const firstActiveUuid = (
      first.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as {
        active_uuid: string | null;
      }
    ).active_uuid;
    first.close();

    const second = createAppStateStore({ databasePath });
    const settings = second.repositories.bootstrap.getAppSettings();
    const onboarding = second.repositories.bootstrap.getOnboardingState();
    second.close();

    expect(firstActiveUuid).toBeNull();
    expect(settings.userMode).toBe("byok");
    expect(onboarding.completed).toBe(true);
    expect(onboarding.currentStep).toBe("completed");
  });

  it("persists BYOK privacy toggle to the local scope and survives reopen without a cloud account", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");

    const first = createAppStateStore({ databasePath });
    first.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
    const saved = first.repositories.bootstrap.updatePrivacy({ allowMemoryImprovementUpload: true });
    const firstActiveUuid = (
      first.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as {
        active_uuid: string | null;
      }
    ).active_uuid;
    const byokRow = first.db
      .prepare("SELECT allow_memory_improvement_upload FROM account_privacy_settings WHERE uuid = ?")
      .get(LOCAL_BYOK_ACCOUNT_UUID) as { allow_memory_improvement_upload: number } | undefined;
    first.close();

    const second = createAppStateStore({ databasePath });
    const privacy = second.repositories.bootstrap.getPrivacySettings();
    second.close();

    expect(firstActiveUuid).toBeNull();
    expect(saved.allowMemoryImprovementUpload).toBe(true);
    expect(byokRow?.allow_memory_improvement_upload).toBe(1);
    expect(privacy.allowMemoryImprovementUpload).toBe(true);
  });

  it("creates app-state schema exactly from docs/数据库设计.md", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    const appSettingsColumns = listColumnNames(store.db, "app_settings");
    const secretStoreColumns = listColumnNames(store.db, "secret_store");
    const cloudAccountColumns = listColumnNames(store.db, "cloud_accounts");
    const accountOnboardingColumns = listColumnNames(store.db, "account_onboarding_state");
    const accountPrivacyColumns = listColumnNames(store.db, "account_privacy_settings");
    const accountModelConfigColumns = listColumnNames(store.db, "account_model_config");
    const byokTokenUsageColumns = listColumnNames(store.db, "byok_token_usage_events");
    const byokTokenUsageIndexes = listIndexNames(store.db, "byok_token_usage_events");
    const ingestionForeignKeys = listForeignKeys(store.db, "account_ingestion_seen");
    const idempotencyColumns = listColumnNames(store.db, "idempotency_keys");
    const tables = listTableNames(store.db);
    const settings = store.repositories.bootstrap.getAppSettings();
    store.close();

    expect(appSettingsColumns).toEqual([
      "id",
      "user_mode",
      "language",
      "theme",
      "auto_update_enabled",
      "created_at",
      "updated_at",
      "default_launch_mode",
      "avatar",
      "skin",
      "active_uuid",
      "last_launch_mode",
      "task_done_notification_enabled",
      "notification_sound_enabled",
      "menu_bar_icon_enabled",
      "auto_scan_known_agents",
      "watch_file_changes",
      "auto_inject_skill"
    ]);
    expect(settings).toMatchObject({
      defaultLaunchMode: "last",
      lastLaunchMode: "full",
      avatarId: "memmy-default",
      skinId: "default",
      taskDoneNotificationEnabled: true,
      notificationSoundEnabled: true,
      menuBarIconEnabled: true
    });
    expect(cloudAccountColumns).toEqual([
      "uuid",
      "user_id",
      "email",
      "phone",
      "nickname",
      "avatar",
      "plan_type",
      "has_finished_guide",
      "region",
      "registered_at",
      "cloud_uuid_ref",
      "raw_profile_json",
      "last_login_at",
      "created_at",
      "updated_at"
    ]);
    expect(secretStoreColumns).toEqual(expect.arrayContaining(["ref", "uuid", "purpose", "ciphertext", "iv", "auth_tag", "updated_at"]));
    expect(accountOnboardingColumns).toContain("has_finished_guide");
    expect(accountOnboardingColumns).not.toContain("completed");
    expect(accountPrivacyColumns).toEqual([
      "uuid",
      "allow_memory_improvement_upload",
      "local_only_mode",
      "created_at",
      "updated_at"
    ]);
    expect(accountModelConfigColumns).toEqual(expect.arrayContaining([
      "uuid",
      "provider",
      "base_url",
      "model_id",
      "api_key_ref",
      "memory_provider",
      "memory_base_url",
      "memory_model_id",
      "memory_api_key_ref",
      "skill_provider",
      "skill_base_url",
      "skill_model_id",
      "skill_api_key_ref",
      "asr_provider",
      "asr_base_url",
      "asr_model_id",
      "asr_api_key_ref"
    ]));
    expect(byokTokenUsageColumns).toEqual([
      "id",
      "kind",
      "source",
      "operation_id",
      "dedupe_key",
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "cached_input_tokens",
      "cache_creation_input_tokens",
      "metadata_json",
      "usage_json",
      "created_at"
    ]);
    expect(byokTokenUsageIndexes).toEqual(expect.arrayContaining([
      "idx_byok_token_usage_events_created",
      "idx_byok_token_usage_events_kind_created",
      "idx_byok_token_usage_events_source_created"
    ]));
    expect(idempotencyColumns).toContain("uuid");
    expect(ingestionForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "account_agent_sources", from: "uuid", to: "uuid" }),
        expect.objectContaining({ table: "account_agent_sources", from: "source_id", to: "source_id" })
      ])
    );
    expect(tables).not.toEqual(
      expect.arrayContaining([
        "account_session",
        "onboarding_state",
        "privacy_settings",
        "token_usage_cache",
        "model_config",
        "agent_sources",
        "ingestion_seen",
        "account_idempotency_keys"
      ])
    );
  });

  it("stores secrets encrypted in a dedicated table", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });
    const secretStore = createSqliteSecretStore(store.db, { keyMaterial: "test-key-material" });

    secretStore.set("model:default:api-key", "sk-live-secret");
    const row = store.db
      .prepare("SELECT ciphertext, iv, auth_tag FROM secret_store WHERE ref = ?")
      .get("model:default:api-key") as { ciphertext: string; iv: string; auth_tag: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.ciphertext).not.toContain("sk-live-secret");
    expect(secretStore.get("model:default:api-key")).toBe("sk-live-secret");

    secretStore.delete("model:default:api-key");
    expect(secretStore.get("model:default:api-key")).toBeNull();
    store.close();
  });

  it("keeps the model row current secret when normalizing conflicting secret refs", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const initialStore = createAppStateStore({ databasePath });
    const uuid = "local-byok-onboarding";
    const currentRef = "legacy:model-api-key";
    const targetRef = `account:${uuid}:model-api-key`;

    initialStore.repositories.modelConfig.get();
    initialStore.secretStore.set(currentRef, "sk-current-secret", { uuid, purpose: "model_api_key" });
    initialStore.secretStore.set(targetRef, "sk-stale-secret", { uuid, purpose: "model_api_key" });
    initialStore.db.prepare("UPDATE account_model_config SET api_key_ref = ? WHERE uuid = ?").run(currentRef, uuid);
    initialStore.close();

    const repairedStore = createAppStateStore({ databasePath });
    const row = repairedStore.db
      .prepare("SELECT api_key_ref FROM account_model_config WHERE uuid = ?")
      .get(uuid) as { api_key_ref: string };

    expect(row.api_key_ref).toBe(targetRef);
    expect(repairedStore.secretStore.get(targetRef)).toBe("sk-current-secret");
    expect(repairedStore.secretStore.get(currentRef)).toBeNull();
    repairedStore.close();
  });
});

describe("bootstrap repository writes", () => {
  it("persists onboarding completion without an active cloud account for BYOK users", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    const onboarding = store.repositories.bootstrap.updateOnboarding({
      currentStep: "completed",
      completed: true,
      completedAt: "2026-06-09T10:00:00.000Z"
    });
    const session = store.repositories.accountSession.get();
    store.close();

    const reloadedStore = createAppStateStore({ databasePath });
    const reloadedOnboarding = reloadedStore.repositories.bootstrap.getOnboardingState();
    reloadedStore.close();

    expect(session).toEqual({ authenticated: false });
    expect(onboarding).toMatchObject({
      completed: true,
      currentStep: "completed",
      completedAt: "2026-06-09T10:00:00.000Z"
    });
    expect(reloadedOnboarding).toMatchObject({
      completed: true,
      currentStep: "completed",
      completedAt: "2026-06-09T10:00:00.000Z"
    });
  });

  it("persists the explicit product tour onboarding step", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    const onboarding = store.repositories.bootstrap.updateOnboarding({
      currentStep: "product_tour_required",
      scanPermission: "scan_only"
    });
    store.close();

    const reloadedStore = createAppStateStore({ databasePath });
    const reloadedOnboarding = reloadedStore.repositories.bootstrap.getOnboardingState();
    reloadedStore.close();

    expect(onboarding).toMatchObject({
      completed: false,
      currentStep: "product_tour_required",
      scanPermission: "scan_only"
    });
    expect(reloadedOnboarding).toMatchObject({
      completed: false,
      currentStep: "product_tour_required",
      scanPermission: "scan_only"
    });
  });

  it("patches app settings, privacy, and onboarding without overwriting omitted fields", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    const app = store.repositories.bootstrap.updateAppSettings({
      language: "zh-CN",
      defaultLaunchMode: "pet",
      menuBarIconEnabled: false
    });
    store.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });
    const privacy = store.repositories.bootstrap.updatePrivacy({
      telemetryOptIn: true,
      localOnlyMode: true
    });
    const onboarding = store.repositories.bootstrap.updateOnboarding({
      currentStep: "completed",
      completed: true,
      completedAt: "2026-06-02T10:00:00.000Z"
    });
    store.close();

    expect(app).toMatchObject({
      userMode: "unset",
      language: "zh-CN",
      theme: "system",
      defaultLaunchMode: "pet",
      menuBarIconEnabled: false
    });
    expect(privacy).toMatchObject({
      telemetryOptIn: false,
      crashReportOptIn: false,
      localOnlyMode: true
    });
    expect(onboarding).toMatchObject({
      completed: true,
      currentStep: "completed",
      scanPermission: "unset",
      completedAt: "2026-06-02T10:00:00.000Z"
    });
  });

  it("updates avatar and skin selection without changing other app settings", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    const updated = store.repositories.bootstrap.setAvatarSkin({
      avatarId: "memmy-focus",
      skinId: "midnight"
    });
    store.close();

    expect(updated).toMatchObject({
      userMode: "unset",
      language: "system",
      avatarId: "memmy-focus",
      skinId: "midnight"
    });
  });

  it("records the last used launch mode so a 'last' default can resolve it after restart", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    const updated = store.repositories.bootstrap.recordLastLaunchMode("pet");
    store.close();

    const reloadedStore = createAppStateStore({ databasePath });
    const reloaded = reloadedStore.repositories.bootstrap.getAppSettings();
    reloadedStore.close();

    expect(updated.lastLaunchMode).toBe("pet");
    expect(reloaded.lastLaunchMode).toBe("pet");
  });

  it("persists token usage snapshots from cloud refreshes", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    store.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });
    const updated = store.repositories.bootstrap.updateTokenUsage({
      planName: "体验 Token",
      totalTokens: 35000000,
      usedTokens: 1000000,
      remainingTokens: 34000000,
      expiresAt: null,
      lastSyncedAt: "2026-06-05T10:00:00.000Z"
    });
    const reloaded = store.repositories.bootstrap.getTokenUsage();
    store.close();

    expect(updated).toEqual(reloaded);
    expect(reloaded).toMatchObject({
      totalTokens: 35000000,
      remainingTokens: 34000000,
      lastSyncedAt: "2026-06-05T10:00:00.000Z"
    });
  });

  it("keeps onboarding, privacy, and token usage isolated per active cloud account", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    store.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });
    store.repositories.bootstrap.updateOnboarding({
      currentStep: "completed",
      completed: true,
      completedAt: "2026-06-08T10:00:00.000Z"
    });
    store.repositories.bootstrap.updatePrivacy({ localOnlyMode: true });
    store.repositories.bootstrap.updateTokenUsage({
      planName: "Account A Plan",
      totalTokens: 100,
      usedTokens: 40,
      remainingTokens: 60,
      expiresAt: null,
      lastSyncedAt: "2026-06-08T10:00:00.000Z"
    });

    store.repositories.accountSession.upsert({
      profile: accountProfile("user-b", "b@example.com", "Account B"),
      uuid: "cloud-account-b"
    });
    const accountBOnboarding = store.repositories.bootstrap.getOnboardingState();
    const accountBPrivacy = store.repositories.bootstrap.getPrivacySettings();
    const accountBTokenUsage = store.repositories.bootstrap.getTokenUsage();

    store.repositories.bootstrap.updatePrivacy({ localOnlyMode: false, allowMemoryImprovementUpload: true });
    store.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });
    const accountAOnboarding = store.repositories.bootstrap.getOnboardingState();
    const accountAPrivacy = store.repositories.bootstrap.getPrivacySettings();
    const accountATokenUsage = store.repositories.bootstrap.getTokenUsage();
    store.close();

    expect(accountBOnboarding).toMatchObject({ completed: false, currentStep: "scan_permission_required" });
    expect(accountBPrivacy).toMatchObject({ localOnlyMode: false, allowMemoryImprovementUpload: false });
    expect(accountBTokenUsage.planName).not.toBe("Account A Plan");
    expect(accountAOnboarding).toMatchObject({ completed: true, currentStep: "completed" });
    expect(accountAPrivacy).toMatchObject({ localOnlyMode: true, allowMemoryImprovementUpload: false });
    expect(accountATokenUsage).toMatchObject({ planName: "Account A Plan", remainingTokens: 60 });
  });
});

function getMigrationCount(db: { prepare(sql: string): { get(): unknown } }): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM _migrations").get() as { count: number };
  return row.count;
}

function listColumnNames(db: { prepare(sql: string): { all(): unknown[] } }, tableName: string): string[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => (row as { name: string }).name);
}

function listTableNames(db: { prepare(sql: string): { all(): unknown[] } }): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function listIndexNames(db: { prepare(sql: string): { all(): unknown[] } }, tableName: string): string[] {
  return db.prepare(`PRAGMA index_list(${tableName})`).all().map((row) => (row as { name: string }).name);
}

function listForeignKeys(db: { prepare(sql: string): { all(): unknown[] } }, tableName: string): Array<{ table: string; from: string; to: string }> {
  return db.prepare(`PRAGMA foreign_key_list(${tableName})`).all().map((row) => {
    const value = row as { table: string; from: string; to: string };
    return {
      table: value.table,
      from: value.from,
      to: value.to
    };
  });
}

function accountProfile(userId: string, email: string, nickname: string) {
  return {
    userId,
    email,
    phoneNumber: null,
    nickname,
    avatarUrl: null,
    planType: "free",
    hasFinishedGuide: false,
    region: null,
    registeredAt: "2026-06-08T10:00:00.000Z",
    rawProfile: { id: userId, email, userName: nickname }
  };
}
