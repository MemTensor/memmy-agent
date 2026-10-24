import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";

const now = Date.parse("2026-10-23T00:00:00.000Z");
const counters = ["lease_count", "lease_recovery_count"] as const;

function usingDatabase(run: (repos: Repositories, db: MemoryDb) => void) {
  const root = mkdtempSync(join(tmpdir(), "memmy-retry-counters-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try { run(new Repositories(db.db), db); }
  finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

function enqueue(repos: Repositories, id: string) {
  return repos.runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: id,
    vectorField: "vec_summary", sourceText: `source-${id}`, now });
}

describe("Embedding retry lease counters", () => {
  it.each(["id", "batch"] as const)("counts %s claims and expired takeovers without spending business attempts or weakening fencing", api => {
    usingDatabase(repos => {
      enqueue(repos, "takeover");
      const claim = (at: number, workerId: string, leaseUntil: number) => api === "id"
        ? repos.runtime.claimEmbeddingRetryById("takeover", { now: at, workerId, leaseUntil })
        : repos.runtime.claimDueEmbeddingRetries({ now: at, workerId, leaseUntil, targetMemoryIds: ["takeover"] })[0];
      const first = claim(now, "A", now + 1000)!;
      expect(first).toMatchObject({ attempts: 0, leaseCount: 1, leaseRecoveryCount: 0 });
      expect(claim(now + 500, "B", now + 5000)).toBeUndefined();
      const second = claim(now + 1001, "B", now + 5000)!;
      expect(second).toMatchObject({ attempts: 0, leaseCount: 2, leaseRecoveryCount: 1 });
      const stale = { workerId: "A", leaseUntil: first.leaseUntil!, leaseToken: first.leaseToken!, now: now + 1002 };
      expect(repos.runtime.markEmbeddingRetrySucceededClaimed("takeover", stale)).toBeUndefined();
      expect(repos.runtime.markEmbeddingRetryFailedClaimed("takeover", { ...stale, attempts: 1, error: "late failure" })).toBeUndefined();
      expect(repos.runtime.renewEmbeddingRetryClaim("takeover", stale, now + 9000, now + 1002)).toBeUndefined();
      expect(repos.runtime.getEmbeddingRetry("takeover")).toMatchObject({ leaseToken: second.leaseToken,
        attempts: 0, leaseCount: 2, leaseRecoveryCount: 1 });
    });
  });

  it("counts each restart recovery once, retains valid leases, and does not count the following claim as another recovery", () => {
    usingDatabase(repos => {
      enqueue(repos, "expired"); enqueue(repos, "valid");
      repos.runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 1000, targetMemoryIds: ["expired"] });
      repos.runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 9000, targetMemoryIds: ["valid"] });
      expect(repos.runtime.requeueEmbeddingRetriesAfterRestart(now + 1001).map(item => item.after.id)).toEqual(["expired"]);
      expect(repos.runtime.requeueEmbeddingRetriesAfterRestart(now + 1001)).toEqual([]);
      expect(repos.runtime.getEmbeddingRetry("expired")).toMatchObject({ status: "pending", attempts: 0, leaseCount: 1, leaseRecoveryCount: 1 });
      expect(repos.runtime.getEmbeddingRetry("valid")).toMatchObject({ status: "in_progress", attempts: 0, leaseCount: 1, leaseRecoveryCount: 0 });
      const next = repos.runtime.claimDueEmbeddingRetries({ now: now + 1001, workerId: "B", leaseUntil: now + 9000, targetMemoryIds: ["expired"] })[0]!;
      expect(next).toMatchObject({ attempts: 0, leaseCount: 2, leaseRecoveryCount: 1 });
      expect(repos.runtime.releaseClaimedEmbeddingRetries([next], now + 1002)[0]!.after)
        .toMatchObject({ attempts: 0, leaseCount: 2, leaseRecoveryCount: 1 });
    });
  });

  it("preserves cumulative lease counters across business failures, duplicate deliveries and changed input", () => {
    usingDatabase(repos => {
      enqueue(repos, "cumulative");
      const claimed = repos.runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 5000 })[0]!;
      repos.runtime.markEmbeddingRetryRetryClaimed(claimed.id, { workerId: "A", leaseUntil: claimed.leaseUntil!,
        leaseToken: claimed.leaseToken!, attempts: 1, nextAttemptAt: now + 3000, error: "temporary", now: now + 1 });
      expect(enqueue(repos, "cumulative")).toMatchObject({ attempts: 1, leaseCount: 1, leaseRecoveryCount: 0, nextAttemptAt: now + 3000 });
      const changed = repos.runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "cumulative",
        vectorField: "vec_summary", sourceText: "changed source", now: now + 2 });
      expect(changed).toMatchObject({ attempts: 0, leaseCount: 1, leaseRecoveryCount: 0 });
      const configured = repos.runtime.claimEmbeddingRetryById(changed.id, { now: now + 3, workerId: "B", leaseUntil: now + 5000 })!;
      repos.runtime.markEmbeddingRetryConfigurationBlockedClaimed(configured.id, { workerId: "B", leaseUntil: configured.leaseUntil!,
        leaseToken: configured.leaseToken!, error: "missing credentials", now: now + 4 });
      expect(repos.runtime.resumeConfigurationBlockedEmbeddingRetries(now + 5)[0]!.after)
        .toMatchObject({ attempts: 0, leaseCount: 2, leaseRecoveryCount: 0 });
    });
  });

  it("rolls back a failed claim transaction without consuming lease or recovery counters", () => {
    usingDatabase(repos => {
      enqueue(repos, "rollback");
      expect(() => repos.transaction(() => {
        repos.runtime.claimEmbeddingRetryById("rollback", { now, workerId: "A", leaseUntil: now + 5000 });
        throw new Error("abort claim");
      })).toThrow("abort claim");
      expect(repos.runtime.getEmbeddingRetry("rollback")).toMatchObject({ status: "pending", attempts: 0,
        leaseCount: 0, leaseRecoveryCount: 0, leaseToken: null });
    });
  });
});

function downgradeTo(db: MemoryDb, version: 9 | 12) {
  const columns = () => (db.db.prepare("PRAGMA table_info(embedding_retry_queue)").all() as Array<{ name: string }>).map(row => row.name);
  for (const column of counters) if (columns().includes(column)) db.db.exec(`ALTER TABLE embedding_retry_queue DROP COLUMN ${column}`);
  if (version === 9) {
    for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
      for (const suffix of ["enqueue_sequence", "policy_dirty"]) db.db.exec(`DROP TRIGGER ${table}_${suffix}`);
      for (const suffix of ["enqueue_seq", "lane_due", "lane_fifo", "policy_dirty"]) db.db.exec(`DROP INDEX ${table}_${suffix}`);
    }
    for (const suffix of ["dirty", "insert", "delete"]) db.db.exec(`DROP TRIGGER memories_worker_policy_${suffix}`);
    for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
      for (const column of ["queue_lane", "resource_class", "enqueue_seq", "first_queued_at", "base_priority", "policy_version"])
        db.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    db.db.exec("DROP TABLE worker_enqueue_counter");
    db.db.exec("DROP INDEX idx_evolution_jobs_available");
    for (const column of ["lease_owner", "lease_token", "available_at", "blocked_reason", "failure_count", "lease_count", "lease_recovery_count"])
      db.db.exec(`ALTER TABLE evolution_jobs DROP COLUMN ${column}`);
    for (const column of ["blocked_reason", "lease_token"]) db.db.exec(`ALTER TABLE embedding_retry_queue DROP COLUMN ${column}`);
  }
  db.db.exec("DELETE FROM schema_migrations");
  db.db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,'legacy')")
    .run(version === 9 ? "009_token_usage_outbox" : "012_queue_scheduling_metadata", version, new Date(now).toISOString());
}

describe("Embedding retry counter schema upgrade", () => {
  it.each([9, 12] as const)("upgrades v%s with a backup, a documented historical lower bound and stable subsequent reopens", version => {
    const root = mkdtempSync(join(tmpdir(), "memmy-retry-counter-upgrade-")), path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined, backup: Database.Database | undefined;
    try {
      db = new MemoryDb({ path }); downgradeTo(db, version);
      const insert = db.db.prepare(`INSERT INTO embedding_retry_queue
        (id,target_kind,target_id,vector_field,source_text,status,attempts,max_attempts,next_attempt_at,claimed_by,lease_until,created_at,updated_at)
        VALUES (?,'trace',?,'vec_summary','retained',?,?,6,?,?,?, ?,?)`);
      for (const [status, attempts] of [["pending", 2], ["in_progress", 3], ["succeeded", 1], ["failed", 4]] as const) {
        insert.run(status, status, status, attempts, now, status === "in_progress" ? "old-worker" : null,
          status === "in_progress" ? now + 1000 : null, now, now);
      }
      if (version === 12) db.db.prepare("UPDATE embedding_retry_queue SET lease_token='old-token' WHERE id='in_progress'").run();
      db.close(); db = new MemoryDb({ path });
      expect(db.schemaVersion().version).toBe(13);
      expect(SCHEMA_VERSION).toBe(13);
      const repos = new Repositories(db.db);
      // Failures prove prior claims; an active/succeeded row proves one more.
      // Historical lease losses are unknowable, so recovery starts at zero.
      for (const [id, attempts, lowerBound] of [["pending", 2, 2], ["in_progress", 3, 4], ["succeeded", 1, 2], ["failed", 4, 4]] as const)
        expect(repos.runtime.getEmbeddingRetry(id)).toMatchObject({ attempts, leaseCount: lowerBound, leaseRecoveryCount: 0 });
      expect(repos.runtime.requeueEmbeddingRetriesAfterRestart(now)).toEqual([]);
      if (version === 12) expect(repos.runtime.isEmbeddingRetryClaimHeld("in_progress", {
        workerId: "old-worker", leaseUntil: now + 1000, leaseToken: "old-token"
      }, now)).toBe(true);
      expect(repos.runtime.claimEmbeddingRetryById("in_progress", { now, workerId: "B", leaseUntil: now + 9000 })).toBeUndefined();
      const recovered = repos.runtime.claimEmbeddingRetryById("in_progress", { now: now + 1001, workerId: "B", leaseUntil: now + 9000 })!;
      expect(recovered).toMatchObject({ attempts: 3, leaseCount: 5, leaseRecoveryCount: 1, leaseToken: expect.any(String) });
      expect(repos.runtime.markEmbeddingRetrySucceededClaimed("in_progress", { workerId: "old-worker",
        leaseUntil: now + 1000, leaseToken: "old-token", now: now + 1002 })).toBeUndefined();
      const backupPath = `${path}.pre-v13.bak`;
      expect(existsSync(backupPath)).toBe(true);
      const originalBackup = readFileSync(backupPath);
      backup = new Database(backupPath, { readonly: true });
      const backupColumns = (backup.prepare("PRAGMA table_info(embedding_retry_queue)").all() as Array<{ name: string }>).map(row => row.name);
      for (const column of counters) expect(backupColumns).not.toContain(column);
      expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version });
      backup.close(); backup = undefined;
      db.close(); db = new MemoryDb({ path });
      expect(new Repositories(db.db).runtime.getEmbeddingRetry("in_progress")).toMatchObject({ attempts: 3,
        leaseCount: 5, leaseRecoveryCount: 1, leaseToken: recovered.leaseToken });
      expect(readFileSync(backupPath)).toEqual(originalBackup);
    } finally {
      backup?.close(); if (db?.db.open) db.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls a failed v12 migration back completely and keeps its original backup for the successful retry", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-retry-counter-rollback-")), path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined, raw: Database.Database | undefined;
    try {
      db = new MemoryDb({ path }); downgradeTo(db, 12);
      db.db.prepare(`INSERT INTO embedding_retry_queue
        (id,target_kind,target_id,vector_field,source_text,status,attempts,max_attempts,next_attempt_at,
         claimed_by,lease_until,lease_token,created_at,updated_at)
        VALUES ('retained','trace','retained','vec_summary','unchanged','in_progress',2,6,?,
          'old-owner',?,'old-token',?,?)`).run(now, now + 9000, now, now);
      db.db.exec(`CREATE TRIGGER refuse_counter_upgrade BEFORE INSERT ON schema_migrations
        WHEN NEW.version=13 BEGIN SELECT RAISE(ABORT,'reject counter upgrade'); END`);
      db.close(); db = undefined;
      expect(() => { db = new MemoryDb({ path }); }).toThrow("reject counter upgrade");
      const backupPath = `${path}.pre-v13.bak`, originalBackup = readFileSync(backupPath);
      raw = new Database(path);
      const columns = (raw.prepare("PRAGMA table_info(embedding_retry_queue)").all() as Array<{ name: string }>).map(row => row.name);
      for (const column of counters) expect(columns).not.toContain(column);
      expect(raw.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 12 });
      expect(raw.prepare("SELECT status,attempts,claimed_by,lease_token,source_text FROM embedding_retry_queue WHERE id='retained'").get())
        .toEqual({ status: "in_progress", attempts: 2, claimed_by: "old-owner", lease_token: "old-token", source_text: "unchanged" });
      raw.exec("DROP TRIGGER refuse_counter_upgrade"); raw.close(); raw = undefined;
      db = new MemoryDb({ path }); expect(db.schemaVersion().version).toBe(13);
      expect(new Repositories(db.db).runtime.getEmbeddingRetry("retained")).toMatchObject({ status: "in_progress",
        attempts: 2, claimedBy: "old-owner", leaseToken: "old-token", leaseCount: 3, leaseRecoveryCount: 0 });
      expect(readFileSync(backupPath)).toEqual(originalBackup);
    } finally {
      raw?.close(); if (db?.db.open) db.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
