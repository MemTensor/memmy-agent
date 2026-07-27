import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore } from "../index.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("device identity repository", () => {
  it("creates one installation UUID in app.sqlite and reuses it", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-device-identity-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    const first = store.repositories.deviceIdentity.getOrCreateInstallationId();
    const second = store.repositories.deviceIdentity.getOrCreateInstallationId();
    const row = store.db
      .prepare("SELECT installation_id FROM app_settings WHERE id = 'default'")
      .get();
    store.close();

    expect(first).toMatch(UUID_PATTERN);
    expect(second).toBe(first);
    expect(row).toEqual({ installation_id: first });
  });

  it("replaces an invalid stored installation ID with a UUID", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-device-identity-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });
    store.db
      .prepare("UPDATE app_settings SET installation_id = ? WHERE id = 'default'")
      .run(" not-a-uuid ");

    const installationId = store.repositories.deviceIdentity.getOrCreateInstallationId();
    const row = store.db
      .prepare("SELECT installation_id FROM app_settings WHERE id = 'default'")
      .get();
    store.close();

    expect(installationId).toMatch(UUID_PATTERN);
    expect(installationId).not.toContain("not-a-uuid");
    expect(row).toEqual({ installation_id: installationId });
  });

  it("keeps the installation UUID after logout and database reopen", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-device-identity-"));
    const databasePath = join(tempDir, "app.sqlite");
    const firstStore = createAppStateStore({ databasePath });
    const installationId =
      firstStore.repositories.deviceIdentity.getOrCreateInstallationId();
    firstStore.repositories.accountSession.upsert({
      uuid: "account-1",
      profile: {
        userId: "user-1",
        email: "user@example.com",
        phoneNumber: null,
        nickname: "User",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-07-27T00:00:00.000Z",
        rawProfile: {
          id: "user-1",
          email: "user@example.com",
          userName: "User"
        }
      }
    });
    firstStore.repositories.accountSession.clear();
    firstStore.close();

    const reopenedStore = createAppStateStore({ databasePath });
    const reopenedInstallationId =
      reopenedStore.repositories.deviceIdentity.getOrCreateInstallationId();
    reopenedStore.close();

    expect(reopenedInstallationId).toBe(installationId);
  });
});
