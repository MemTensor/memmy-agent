import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";

describe("worker lease schema migration", () => {
  it("keeps ordinary dedupe enqueues blocked but lets an explicit manual retry resume the original job", () => {
    usingDatabase((runtime) => {
      const at = new Date().toISOString();
      const original = {
        id: "original-summary", jobType: "trace_summary" as const, status: "queued" as const,
        dedupeKey: "summary:same-target", userId: "user", attempts: 0, maxAttempts: 3,
        payload: { source: "automatic" }, createdAt: at, updatedAt: at
      };
      runtime.enqueueJob(original);
      const [claimed] = runtime.leaseQueuedJobs(1);
      runtime.failJob(claimed!.id, "needs configuration", undefined, false, claimed, {
        blockedReason: "configuration", availableAt: new Date(Date.now() + 60_000).toISOString()
      });
      runtime.enqueueJob({ ...original, id: "ordinary-duplicate" });
      expect(runtime.getJob(original.id)).toMatchObject({ status: "failed", blockedReason: "configuration", failureCount: 1 });
      const resumed = runtime.enqueueJob({ ...original, id: "manual-duplicate", payload: { source: "memory.processing.manual_retry" } });
      expect(resumed).toMatchObject({ id: original.id, status: "queued", blockedReason: null,
        availableAt: null, attempts: 0, failureCount: 0, leaseCount: 1 });
    });
  });

  it("keeps an unchanged retry claim and preserves the pending retry deadline on duplicate enqueue", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      const retry = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "same", vectorField: "vec_summary", sourceText: "unchanged", now });
      const [claim] = runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 60_000 });
      runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "same", vectorField: "vec_summary", sourceText: "unchanged", now: now + 100 });
      expect(runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "in_progress", claimedBy: "A", leaseUntil: now + 60_000 });
      expect(runtime.isEmbeddingRetryClaimHeld(retry.id, { workerId: "A", leaseUntil: claim!.leaseUntil!, leaseToken: claim!.leaseToken! }, now + 100)).toBe(true);
      runtime.markEmbeddingRetryRetryClaimed(retry.id, {
        workerId: "A", leaseUntil: now + 60_000, leaseToken: claim!.leaseToken!, attempts: 1, nextAttemptAt: now + 5_000,
        error: "temporary", now: now + 100
      });
      runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "same", vectorField: "vec_summary", sourceText: "unchanged", now: now + 200 });
      expect(runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: now + 5_000 });
      expect(runtime.claimDueEmbeddingRetries({ now: now + 200, workerId: "B", leaseUntil: now + 60_000 })).toEqual([]);
    });
  });

  it("invalidates an active retry claim when its input changes instead of leaving it orphaned in progress", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      const retry = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "changed", vectorField: "vec_summary", sourceText: "old", now });
      const [claim] = runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 60_000 });
      runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "changed", vectorField: "vec_summary", sourceText: "new", now: now + 100 });
      expect(runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "pending", claimedBy: null, leaseUntil: null, sourceText: "new" });
      expect(runtime.markEmbeddingRetrySucceededClaimed(retry.id, { workerId: "A", leaseUntil: now + 60_000, leaseToken: claim!.leaseToken!, now: now + 100 })).toBeUndefined();
      expect(runtime.claimDueEmbeddingRetries({ now: now + 100, workerId: "B", leaseUntil: now + 60_100 })).toHaveLength(1);
    });
  });

  it("resumes configuration-blocked retries without reviving permanent failures or consuming attempts", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      const configurable = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "configurable", vectorField: "vec_summary", sourceText: "configurable", now });
      const terminal = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "terminal", vectorField: "vec_summary", sourceText: "terminal", now });
      const claims = runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 60_000 });
      runtime.markEmbeddingRetryConfigurationBlockedClaimed(configurable.id, { workerId: "A", leaseUntil: now + 60_000, leaseToken: claims.find(c => c.id === configurable.id)!.leaseToken!, now: now + 100, error: "credentials missing" });
      runtime.markEmbeddingRetryFailedClaimed(terminal.id, { workerId: "A", leaseUntil: now + 60_000, leaseToken: claims.find(c => c.id === terminal.id)!.leaseToken!, now: now + 100, error: "invalid input", attempts: 1 });
      expect(runtime.getEmbeddingRetry(configurable.id)).toMatchObject({ status: "failed", blockedReason: "configuration", attempts: 0 });
      expect(runtime.requeueEmbeddingRetriesAfterRestart(now + 100)).toEqual([]);
      const resumed = runtime.resumeConfigurationBlockedEmbeddingRetries(now + 100);
      expect(resumed.map(({ after }) => after.id)).toEqual([configurable.id]);
      expect(runtime.getEmbeddingRetry(configurable.id)).toMatchObject({ status: "pending", blockedReason: null, attempts: 0 });
      expect(runtime.getEmbeddingRetry(terminal.id)).toMatchObject({ status: "failed", attempts: 1 });
    });
  });

  it("rejects every stale completion even when the same worker reclaims changed input in the same millisecond", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      const input = { targetKind: "trace" as const, targetId: "same-clock", vectorField: "vec_summary" as const, sourceText: "old", now };
      const retry = runtime.enqueueEmbeddingRetry(input);
      const [old] = runtime.claimDueEmbeddingRetries({ now, workerId: "worker", leaseUntil: now + 60_000 });
      runtime.enqueueEmbeddingRetry({ ...input, sourceText: "new" });
      const [current] = runtime.claimDueEmbeddingRetries({ now, workerId: "worker", leaseUntil: now + 60_000 });
      expect(current!.leaseToken).toEqual(expect.any(String));
      expect(current!.leaseToken).not.toBe(old!.leaseToken);
      const stale = { workerId: "worker", leaseUntil: old!.leaseUntil!, leaseToken: old!.leaseToken! };
      expect(runtime.isEmbeddingRetryClaimHeld(retry.id, stale, now)).toBe(false);
      expect(runtime.renewEmbeddingRetryClaim(retry.id, stale, now + 90_000, now)).toBeUndefined();
      expect(runtime.markEmbeddingRetrySucceededClaimed(retry.id, { ...stale, now })).toBeUndefined();
      expect(runtime.markEmbeddingRetryFailedClaimed(retry.id, { ...stale, attempts: 1, error: "old failure", now })).toBeUndefined();
      expect(runtime.markEmbeddingRetryRetryClaimed(retry.id, { ...stale, attempts: 1, error: "old failure", now, nextAttemptAt: now + 10_000 })).toBeUndefined();
      expect(runtime.markEmbeddingRetryConfigurationBlockedClaimed(retry.id, { ...stale, error: "old config", now })).toBeUndefined();
      expect(runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "in_progress", sourceText: "new", attempts: 0, leaseToken: current!.leaseToken });
      const fresh = { workerId: "worker", leaseUntil: current!.leaseUntil!, leaseToken: current!.leaseToken! };
      const renewed = runtime.renewEmbeddingRetryClaim(retry.id, fresh, now + 90_000, now + 1)!;
      expect(renewed.leaseToken).toBe(current!.leaseToken);
      expect(runtime.isEmbeddingRetryClaimHeld(retry.id, { ...fresh, leaseUntil: renewed.leaseUntil! }, now + 2)).toBe(true);
      expect(runtime.markEmbeddingRetrySucceededClaimed(retry.id, { ...fresh, leaseUntil: renewed.leaseUntil!, now: now + 2 })).toMatchObject({ status: "succeeded", leaseToken: null });
    });
  });

  it("gives each retry in one batch its own token and keeps that token on duplicate enqueue", () => {
    usingDatabase((runtime) => {
      const now = Date.now();
      for (const targetId of ["one", "two"]) runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId, vectorField: "vec_summary", sourceText: targetId, now });
      const claims = runtime.claimDueEmbeddingRetries({ now, workerId: "worker", leaseUntil: now + 60_000 });
      expect(new Set(claims.map(c => c.leaseToken)).size).toBe(2);
      runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "one", vectorField: "vec_summary", sourceText: "one", now });
      expect(runtime.getEmbeddingRetryByTarget("trace", "one", "vec_summary")!.leaseToken).toBe(claims.find(c => c.targetId === "one")!.leaseToken);
    });
  });

  it("upgrades a v10 retry queue, preserves a valid old lease, and assigns a unique token on recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-retry-token-migration-"));
    const path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      const now = Date.now();
      db = new MemoryDb({ path });
      const runtime = new Repositories(db.db).runtime;
      const retry = runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "legacy-retry", vectorField: "vec_summary", sourceText: "preserved", now });
      runtime.claimDueEmbeddingRetries({ now, workerId: "legacy", leaseUntil: now + 1_000 });
      removeSchedulingSchema(db);
      db.db.exec("ALTER TABLE embedding_retry_queue DROP COLUMN lease_token");
      db.db.exec("DELETE FROM schema_migrations");
      db.db.prepare("INSERT INTO schema_migrations VALUES ('010_worker_lease_safety', 10, ?, 'legacy')").run(new Date(now).toISOString());
      db.close();
      db = new MemoryDb({ path });
      const reopened = new Repositories(db.db).runtime;
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      expect(reopened.getEmbeddingRetry(retry.id)).toMatchObject({ status: "in_progress", sourceText: "preserved", claimedBy: "legacy", leaseToken: null });
      expect(reopened.requeueEmbeddingRetriesAfterRestart(now + 100)).toEqual([]);
      expect(reopened.claimDueEmbeddingRetries({ now: now + 100, workerId: "new", leaseUntil: now + 10_000 })).toEqual([]);
      const [recovered] = reopened.claimDueEmbeddingRetries({ now: now + 1_001, workerId: "new", leaseUntil: now + 10_000 });
      expect(recovered).toMatchObject({ status: "in_progress", sourceText: "preserved", attempts: 0, leaseToken: expect.any(String) });
      expect(existsSync(`${path}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
    } finally {
      if (db?.db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades v9 without losing jobs, separates historic counters, and keeps a pre-migration backup", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-worker-lease-migration-"));
    const path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    let backup: Database.Database | undefined;
    try {
      db = new MemoryDb({ path });
      // Restore the prior v9 task-table shape to exercise an actual old file.
      removeSchedulingSchema(db);
      db.db.exec("DROP INDEX idx_evolution_jobs_available");
      for (const column of ["lease_owner", "lease_token", "available_at", "blocked_reason",
        "failure_count", "lease_count", "lease_recovery_count"]) {
        db.db.exec(`ALTER TABLE evolution_jobs DROP COLUMN ${column}`);
      }
      db.db.exec("ALTER TABLE embedding_retry_queue DROP COLUMN blocked_reason");
      db.db.exec("ALTER TABLE embedding_retry_queue DROP COLUMN lease_token");
      db.db.exec("DELETE FROM schema_migrations");
      const at = "2026-10-22T00:00:00.000Z";
      db.db.prepare("INSERT INTO schema_migrations VALUES ('009_token_usage_outbox', 9, ?, 'legacy')").run(at);
      const insert = db.db.prepare(`INSERT INTO evolution_jobs
        (id, job_type, status, user_id, attempts, max_attempts, leased_until, created_at, updated_at)
        VALUES (?, 'reflection', ?, 'migration-user', ?, 3, ?, ?, ?)`);
      for (const [status, attempts] of [["queued", 2], ["failed", 2], ["leased", 3],
        ["succeeded", 3], ["dead_letter", 3]] as const) {
        insert.run(status, status, attempts, status === "leased" ? "2099-01-01T00:00:00.000Z" : null, at, at);
      }
      db.close();
      db = new MemoryDb({ path });
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      const runtime = new Repositories(db.db).runtime;
      expect(runtime.getJob("queued")).toMatchObject({ attempts: 2, failureCount: 2, leaseCount: 2, leaseRecoveryCount: 0 });
      expect(runtime.getJob("failed")).toMatchObject({ failureCount: 2, leaseCount: 2 });
      expect(runtime.getJob("leased")).toMatchObject({ failureCount: 2, leaseCount: 3, leaseToken: null });
      expect(runtime.getJob("succeeded")).toMatchObject({ failureCount: 2, leaseCount: 3 });
      expect(runtime.getJob("dead_letter")).toMatchObject({ failureCount: 3, leaseCount: 3 });
      // An old lease in the future is retained until it expires.
      expect(runtime.requeueLeasedJobsAfterRestart(at)).toEqual([]);
      const backupPath = `${path}.pre-v${SCHEMA_VERSION}.bak`;
      expect(existsSync(backupPath)).toBe(true);
      backup = new Database(backupPath, { readonly: true });
      expect(backup.prepare("SELECT COUNT(*) AS n FROM evolution_jobs").get()).toEqual({ n: 5 });
      const backupColumns = backup.prepare("PRAGMA table_info(evolution_jobs)").all() as Array<{ name: string }>;
      expect(backupColumns.map((column) => column.name)).not.toContain("failure_count");
    } finally {
      backup?.close();
      if (db?.db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reopens the current schema idempotently without recalculating counters or clearing current lease metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-worker-lease-idempotent-"));
    const path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      db = new MemoryDb({ path });
      db.db.prepare(`INSERT INTO evolution_jobs
        (id, job_type, status, user_id, attempts, max_attempts, lease_owner, lease_token,
         leased_until, failure_count, lease_count, lease_recovery_count, available_at, blocked_reason, created_at, updated_at)
        VALUES ('retained', 'reflection', 'leased', 'user', 2, 3, 'owner', 'token',
          '2099-01-01T00:00:00.000Z', 1, 7, 5, NULL, NULL, '2026-01-01', '2026-01-01')`).run();
      db.close();
      db = new MemoryDb({ path });
      expect(new Repositories(db.db).runtime.getJob("retained")).toMatchObject({
        status: "leased", leaseOwner: "owner", leaseToken: "token", attempts: 2,
        failureCount: 1, leaseCount: 7, leaseRecoveryCount: 5
      });
    } finally {
      if (db?.db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function usingDatabase(run: (runtime: Repositories["runtime"]) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-lease-storage-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try { run(new Repositories(db.db).runtime); }
  finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

function removeSchedulingSchema(db: MemoryDb): void {
  for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
    for (const suffix of ["enqueue_sequence", "policy_dirty"]) db.db.exec(`DROP TRIGGER ${table}_${suffix}`);
    for (const suffix of ["enqueue_seq", "lane_due", "lane_fifo", "policy_dirty"]) db.db.exec(`DROP INDEX ${table}_${suffix}`);
  }
  for (const suffix of ["dirty", "insert", "delete"]) db.db.exec(`DROP TRIGGER memories_worker_policy_${suffix}`);
  for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
    for (const column of ["queue_lane", "resource_class", "enqueue_seq", "first_queued_at", "base_priority", "policy_version"]) {
      db.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  db.db.exec("DROP TABLE worker_enqueue_counter");
}
