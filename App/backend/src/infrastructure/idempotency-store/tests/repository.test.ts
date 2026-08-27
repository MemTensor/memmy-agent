/** Repository tests. */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore, runMigrations, type AppStateStore } from "../../app-state-store/index.js";
import { createIdempotencyStore } from "../index.js";

let db: DatabaseSync | undefined;
let tempDir: string | undefined;
let appStateStore: AppStateStore | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  appStateStore?.close();
  appStateStore = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("idempotency store", () => {
  it("loads the idempotency migration through the app migration runner", () => {
    const store = createStore();

    store.save({
      adapterId: "cursor/main",
      requestId: "req-1",
      bodyHash: "hash-1",
      responseJson: "{\"ok\":true}",
      statusCode: 200
    });

    expect(store.lookup("cursor/main", "req-1")).toMatchObject({
      bodyHash: "hash-1",
      responseJson: "{\"ok\":true}",
      statusCode: 200
    });
  });

  it("returns null for lookup misses", () => {
    const store = createStore();

    expect(store.lookup("cursor/main", "missing")).toBeNull();
  });

  it("throws on duplicate save instead of ignoring unique conflicts", () => {
    const store = createStore();
    const input = {
      adapterId: "cursor/main",
      requestId: "req-1",
      bodyHash: "hash-1",
      responseJson: "{\"ok\":true}",
      statusCode: 200
    };

    store.save(input);

    expect(() => store.save(input)).toThrow();
  });

  it("purges rows older than the threshold timestamp", () => {
    const store = createStore();
    store.save({
      adapterId: "cursor/main",
      requestId: "old",
      bodyHash: "hash-old",
      responseJson: "{\"ok\":true}",
      statusCode: 200
    });
    store.save({
      adapterId: "cursor/main",
      requestId: "new",
      bodyHash: "hash-new",
      responseJson: "{\"ok\":true}",
      statusCode: 200
    });
    db?.prepare("UPDATE idempotency_keys SET created_at = ? WHERE request_id = ?").run(
      "2026-01-01T00:00:00.000Z",
      "old"
    );
    db?.prepare("UPDATE idempotency_keys SET created_at = ? WHERE request_id = ?").run(
      "2026-05-29T00:00:00.000Z",
      "new"
    );

    expect(store.purgeBefore("2026-02-01T00:00:00.000Z")).toBe(1);
    expect(store.lookup("cursor/main", "old")).toBeNull();
    expect(store.lookup("cursor/main", "new")).not.toBeNull();
  });

  it("keeps idempotency keys scoped to the active cloud account", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-idempotency-"));
    appStateStore = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    appStateStore.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });
    appStateStore.repositories.idempotency.save({
      adapterId: "cursor/main",
      requestId: "req-shared",
      bodyHash: "hash-a",
      responseJson: "{\"account\":\"a\"}",
      statusCode: 200
    });

    appStateStore.repositories.accountSession.upsert({
      profile: accountProfile("user-b", "b@example.com", "Account B"),
      uuid: "cloud-account-b"
    });
    expect(appStateStore.repositories.idempotency.lookup("cursor/main", "req-shared")).toBeNull();
    appStateStore.repositories.idempotency.save({
      adapterId: "cursor/main",
      requestId: "req-shared",
      bodyHash: "hash-b",
      responseJson: "{\"account\":\"b\"}",
      statusCode: 201
    });

    appStateStore.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });

    expect(appStateStore.repositories.idempotency.lookup("cursor/main", "req-shared")).toMatchObject({
      bodyHash: "hash-a",
      statusCode: 200
    });
  });
});

function createStore() {
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO cloud_accounts (uuid, created_at, updated_at) VALUES (?, ?, ?)").run(
    "cloud-account-a",
    "2026-06-08T10:00:00.000Z",
    "2026-06-08T10:00:00.000Z"
  );
  return createIdempotencyStore(db, { getActiveUuid: () => "cloud-account-a" });
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
