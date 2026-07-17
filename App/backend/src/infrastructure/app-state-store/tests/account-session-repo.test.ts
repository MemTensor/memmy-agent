/** Account session repo tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("account session repository", () => {
  it("tracks send-code timestamps by hashed identifier before login", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-account-session-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    store.repositories.accountSession.markCodeSent("email:hello@example.com", "2026-06-02T10:00:00.000Z");
    const same = store.repositories.accountSession.getLastCodeSentAt("email:hello@example.com");
    const other = store.repositories.accountSession.getLastCodeSentAt("phone:13800138000");
    const rows = store.db.prepare("SELECT * FROM verification_code_throttle").all() as Record<string, unknown>[];
    store.close();

    expect(same).toBe("2026-06-02T10:00:00.000Z");
    expect(other).toBeNull();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("hello@example.com");
    expect(rows[0]?.channel).toBe("email");
  });

  it("stores cloud accounts by uuid and switches the active account", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-account-session-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    const session = store.repositories.accountSession.upsert({
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "hello",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: {
          id: "user-1",
          email: "hello@example.com",
          userName: "hello",
          createdAt: "2026-06-02T10:00:00.000Z"
        }
      },
      uuid: "cloud-account-a",
      cloudUuid: "cloud.login.uuid.a"
    });
    const updated = store.repositories.accountSession.upsert({
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "Memmy User",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: true,
        region: null,
        registeredAt: null,
        rawProfile: {
          id: "user-1",
          email: "hello@example.com",
          userName: "Memmy User"
        }
      }
    });
    store.repositories.accountSession.upsert({
      profile: {
        userId: "user-2",
        email: "other@example.com",
        phoneNumber: null,
        nickname: "Other User",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-03T10:00:00.000Z",
        rawProfile: {
          id: "user-2",
          email: "other@example.com",
          userName: "Other User"
        }
      },
      uuid: "cloud-account-b"
    });
    const activeB = store.repositories.accountSession.get();
    store.repositories.accountSession.upsert({
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "Memmy User",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: true,
        region: null,
        registeredAt: null,
        rawProfile: {
          id: "user-1",
          email: "hello@example.com",
          userName: "Memmy User"
        }
      },
      uuid: "cloud-account-a"
    });
    const row = store.db.prepare("SELECT * FROM cloud_accounts WHERE uuid = ?").get("cloud-account-a") as Record<string, unknown>;
    const activeUuid = store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as { active_uuid: string | null };
    const storedUuid = store.secretStore.get("account:cloud-account-a:cloud-uuid");
    const reloaded = store.repositories.accountSession.get();
    const activeCloudUuid = store.repositories.accountSession.getCloudUuid();

    store.db.prepare("UPDATE app_settings SET active_uuid = NULL WHERE id = 'default'").run();
    const localModeSession = store.repositories.accountSession.get();
    const fallbackCloudUuid = store.repositories.accountSession.getLatestCloudUuid();
    const accountAAfterClear = store.db.prepare("SELECT uuid FROM cloud_accounts WHERE uuid = ?").get("cloud-account-a");
    store.close();

    expect(session).toMatchObject({
      authenticated: true,
      isNewUser: true,
      profile: {
        userId: "user-1",
        nickname: "hello",
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    });
    expect(updated).toMatchObject({
      authenticated: true,
      profile: {
        nickname: "Memmy User",
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    });
    expect(activeB).toMatchObject({
      authenticated: true,
      profile: {
        userId: "user-2",
        email: "other@example.com"
      }
    });
    expect(reloaded).toMatchObject({
      authenticated: true,
      profile: {
        userId: "user-1",
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    });
    expect(row.registered_at).toBe("2026-06-02T10:00:00.000Z");
    expect(JSON.stringify(session)).not.toContain("cloud-account-a");
    expect(activeUuid.active_uuid).toBe("cloud-account-a");
    expect(row.cloud_uuid_ref).toBe("account:cloud-account-a:cloud-uuid");
    expect(storedUuid).toBe("cloud.login.uuid.a");
    expect(activeCloudUuid).toBe("cloud.login.uuid.a");
    expect(localModeSession).toEqual({ authenticated: false });
    expect(fallbackCloudUuid).toBe("cloud.login.uuid.a");
    expect(accountAAfterClear).toBeDefined();
  });

  it("uses cloud new-user flag instead of local first-seen heuristic", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-account-session-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    const session = store.repositories.accountSession.upsert({
      profile: {
        userId: "registered-user-1",
        email: "registered@example.com",
        phoneNumber: null,
        nickname: "registered",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: {
          id: "registered-user-1",
          email: "registered@example.com",
          userName: "registered"
        }
      },
      isNewUser: false,
      uuid: "registered-user-1",
      cloudUuid: "cloud.login.uuid"
    });
    store.close();

    expect(session).toMatchObject({
      authenticated: true,
      isNewUser: false,
      profile: {
        userId: "registered-user-1",
        email: "registered@example.com"
      }
    });
  });

  it("activates only an existing account whose encrypted cloud uuid matches", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-account-session-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    store.repositories.accountSession.upsert({
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "hello",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: {
          id: "user-1",
          email: "hello@example.com",
          userName: "hello"
        }
      },
      uuid: "cloud-account-a",
      cloudUuid: "cloud.login.uuid.a"
    });
    store.repositories.accountSession.upsert({
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

    expect(store.repositories.accountSession.activateByCloudUuid("cloud.login.uuid.a")).toBe(true);
    const activeA = store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as { active_uuid: string | null };
    const sessionA = store.repositories.accountSession.get();

    expect(store.repositories.accountSession.activateByCloudUuid("missing-cloud-login-uuid")).toBe(false);
    const activeMissing = store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as { active_uuid: string | null };
    const fabricatedAccount = store.db.prepare("SELECT uuid FROM cloud_accounts WHERE uuid = ?").get("missing-cloud-login-uuid");
    store.close();

    expect(activeA.active_uuid).toBe("cloud-account-a");
    expect(sessionA).toMatchObject({
      authenticated: true,
      profile: {
        userId: "user-1"
      }
    });
    expect(activeMissing.active_uuid).toBeNull();
    expect(fabricatedAccount).toBeUndefined();
  });

  it("repairs missing phone column from raw cloud profile", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-account-session-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    store.repositories.accountSession.upsert({
      profile: {
        userId: "phone-user-1",
        email: null,
        phoneNumber: null,
        nickname: "喜乐松鼠",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-09T10:00:00.000Z",
        rawProfile: {
          id: "phone-user-1",
          phone: "13800138000",
          userName: "喜乐松鼠",
          createdAt: "2026-06-09T10:00:00.000Z"
        }
      },
      uuid: "phone-user-1"
    });
    const before = store.db.prepare("SELECT phone FROM cloud_accounts WHERE uuid = ?").get("phone-user-1") as { phone: string | null };
    const session = store.repositories.accountSession.get();
    const after = store.db.prepare("SELECT phone FROM cloud_accounts WHERE uuid = ?").get("phone-user-1") as { phone: string | null };
    store.close();

    expect(before.phone).toBeNull();
    expect(session).toMatchObject({
      authenticated: true,
      profile: {
        phoneNumber: "13800138000"
      }
    });
    expect(after.phone).toBe("13800138000");
  });
});
