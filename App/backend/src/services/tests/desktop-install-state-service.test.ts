/** Desktop install state service tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { readRuntimeMemmyConfigState, writeAccountModelProjectionToMemmyConfig } from "../../infrastructure/memmy-config/index.js";
import { resetAccountRuntimeForDesktopInstallChange } from "../desktop-install-state-service.js";
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

describe("resetAccountRuntimeForDesktopInstallChange", () => {
  it("keeps account runtime when the desktop install fingerprint changes", async () => {
    const context = createContext();
    await seedAccountRuntime(context);

    const result = await resetAccountRuntimeForDesktopInstallChange({
      appStateStore: context.store,
      databasePath: context.databasePath,
      memmyConfigPath: context.memmyConfigPath,
      installFingerprint: "0.0.5|darwin|arm64|/Applications/Memmy.app/Contents/MacOS/Memmy|100",
      now: () => new Date("2026-06-20T10:00:00.000Z")
    });

    await expect(syncRuntimeConfigWithAppState(context)).resolves.toMatchObject({
      source: "runtime_config",
      mode: "account"
    });

    expect(result).toMatchObject({
      changedInstall: true,
      resetAccountRuntime: false,
      reason: "new_install_fingerprint"
    });
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: {
        userId: "user-a"
      }
    });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("account");
    expect(await readRuntimeMemmyConfigState(context.memmyConfigPath)).toMatchObject({
      status: "valid_account",
      cloudUuid: "cloud.login.uuid.a"
    });
    expect(readMarker(context.markerPath)).toMatchObject({
      installFingerprint: "0.0.5|darwin|arm64|/Applications/Memmy.app/Contents/MacOS/Memmy|100",
      updatedAt: "2026-06-20T10:00:00.000Z"
    });
  });

  it("keeps the active account across the reinstall marker used by MEMMY-594", async () => {
    const context = createContext();
    await seedAccountRuntime(context);

    const result = await resetAccountRuntimeForDesktopInstallChange({
      appStateStore: context.store,
      databasePath: context.databasePath,
      memmyConfigPath: context.memmyConfigPath,
      installFingerprint: "1.1.8|win32|x64|C:\\Program Files\\Memmy\\Memmy.exe|2",
      now: () => new Date("2026-06-20T10:00:00.000Z")
    });

    expect(result).toMatchObject({ changedInstall: true, resetAccountRuntime: false });
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "user-a" }
    });
    expect(context.store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get())
      .toMatchObject({ active_uuid: "cloud-account-a" });
  });

  it("restores an account whose active session was cleared before an authoritative migration", async () => {
    const context = createContext();
    await seedAccountRuntime(context);
    context.store.repositories.accountSession.clear();

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
      hydratedAppState: true,
      reason: "hydrated_account_from_runtime_config"
    });
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: { userId: "user-a" }
    });
    expect(context.store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get())
      .toMatchObject({ active_uuid: "cloud-account-a" });
  });

  it("keeps account runtime when the desktop install fingerprint is unchanged", async () => {
    const context = createContext();
    await seedAccountRuntime(context);
    writeMarker(context.markerPath, {
      installFingerprint: "0.0.5|darwin|arm64|/Applications/Memmy.app/Contents/MacOS/Memmy|100",
      updatedAt: "2026-06-20T10:00:00.000Z"
    });

    const result = await resetAccountRuntimeForDesktopInstallChange({
      appStateStore: context.store,
      databasePath: context.databasePath,
      memmyConfigPath: context.memmyConfigPath,
      installFingerprint: "0.0.5|darwin|arm64|/Applications/Memmy.app/Contents/MacOS/Memmy|100"
    });

    expect(result).toMatchObject({
      changedInstall: false,
      resetAccountRuntime: false,
      reason: "same_install_fingerprint"
    });
    expect(context.store.repositories.accountSession.get()).toMatchObject({
      authenticated: true,
      profile: {
        userId: "user-a"
      }
    });
    expect(context.store.repositories.bootstrap.getAppSettings().userMode).toBe("account");
    expect(await readRuntimeMemmyConfigState(context.memmyConfigPath)).toMatchObject({
      status: "valid_account",
      cloudUuid: "cloud.login.uuid.a"
    });
  });
});

async function seedAccountRuntime(context: TestContext): Promise<void> {
  context.store.repositories.accountSession.upsert({
    profile: accountProfile("user-a", "a@example.com", "Account A"),
    uuid: "cloud-account-a",
    cloudUuid: "cloud.login.uuid.a"
  });
  context.store.repositories.bootstrap.updateAppSettings({ userMode: "account" });
  await writeAccountModelProjectionToMemmyConfig({
    cloudUuid: "cloud.login.uuid.a",
    userId: "user-a"
  }, context.memmyConfigPath);
}

interface TestContext {
  appStateStore: AppStateStore;
  store: AppStateStore;
  databasePath: string;
  memmyConfigPath: string;
  markerPath: string;
}

function createContext(): TestContext {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-desktop-install-"));
  const databasePath = join(tempDir, "app.sqlite");
  store = createAppStateStore({ databasePath });
  const memmyConfigPath = join(tempDir, ".memmy", "config.yaml");
  const markerPath = join(tempDir, "desktop-install-state.json");
  return {
    appStateStore: store,
    store,
    databasePath,
    memmyConfigPath,
    markerPath
  };
}

function writeMarker(markerPath: string, marker: { installFingerprint: string; updatedAt: string }): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function readMarker(markerPath: string): { installFingerprint: string; updatedAt: string } {
  return JSON.parse(readFileSync(markerPath, "utf8")) as { installFingerprint: string; updatedAt: string };
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
    registeredAt: "2026-06-01T10:00:00.000Z",
    rawProfile: {
      id: userId,
      email,
      userName: nickname
    }
  };
}
