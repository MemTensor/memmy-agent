import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { JOB_POLICY_VERSION, jobPolicyRegistry } from "../../src/service/worker/job-policy-registry.js";
import { pendingPolicyIndex } from "../../src/storage/queue-scheduling-schema.js";

const at = "2026-10-25T00:00:00.000Z", now = Date.parse(at);
const resources: Array<{ db: MemoryDb; root: string }> = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-policy-maintenance-"));
  const h = { db: new MemoryDb({ path: join(root, "memory.sqlite") }), root };
  resources.push(h);
  const runtime = () => new Repositories(h.db.db).runtime;
  return {
    get db() { return h.db.db; }, runtime,
    reopen() { const path = h.db.path; h.db.close(); h.db = new MemoryDb({ path }); },
    memory(id = "target", tags: string[] = []) {
      h.db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,tags_json,created_at,updated_at)
        VALUES (?,?,'user','synthetic','L1',?,?,?)`).run(id, at, JSON.stringify(tags), at, at);
    },
    job(id: string, source = "startup.placeholder_summary_repair", dedupeKey = id) {
      return runtime().enqueueJob({ id, jobType: "import_summary", targetMemoryId: "target", userId: "user",
        status: "queued", payload: { source }, dedupeKey, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    },
    retry(id = "retry", target = "target") {
      return runtime().enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: target,
        vectorField: "vec_summary", sourceText: "synthetic", now });
    }
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of resources.splice(0)) { if (h.db.db.open) h.db.close(); rmSync(h.root, { recursive: true, force: true }); }
});

describe("event-driven policy maintenance", () => {
  it("does no reclassification or scan invalidation on identical delivery or ordinary memory updates", () => {
    const h = harness(); h.memory(); const main = h.job("original"); const retry = h.retry();
    const store = h.runtime().scheduling, revision = store.getSelectionRevision();
    const resolve = vi.spyOn(jobPolicyRegistry, "resolve");
    h.job("duplicate", "startup.placeholder_summary_repair", "original"); h.retry();
    h.db.prepare("UPDATE memories SET properties_json=?, tags_json=tags_json, agent_id=agent_id, memory_layer=memory_layer WHERE id='target'")
      .run(JSON.stringify({ internal_info: { summary: "changed", processing_state: "ready" }, rating: 5 }));
    expect(store.refreshActivePolicies({ maxRows: 64 })).toEqual({ refreshed: 0, unknown: [], hasMore: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(store.getSelectionRevision()).toBe(revision);
    expect(h.runtime().getJob(main.id)).toMatchObject({ enqueueSeq: main.enqueueSeq, firstQueuedAt: main.firstQueuedAt });
    expect(h.runtime().getEmbeddingRetry(retry.id)).toMatchObject({ enqueueSeq: retry.enqueueSeq, firstQueuedAt: retry.firstQueuedAt });
  });

  it.each(["capture_origin", "plugin_algorithm", "project_id", "projectId"])("still refreshes policy/admission when %s changes", field => {
    const h = harness(); h.memory(); h.job("main"); h.retry();
    h.db.prepare("UPDATE memories SET properties_json=? WHERE id='target'")
      .run(JSON.stringify({ internal_info: { [field]: "changed" } }));
    const store = h.runtime().scheduling, revision = store.getSelectionRevision();
    expect(store.refreshActivePolicies({ maxRows: 64 }).refreshed).toBe(2);
    expect(store.getSelectionRevision()).toBe(revision + 2);
  });

  it("uses only the pending indexes when both large queues already have valid classification", () => {
    const h = harness();
    h.db.transaction(() => { for (let i = 0; i < 1_000; i++) { h.job(`main-${i}`); h.retry(`retry-${i}`, `target-${i}`); } })();
    const prepare = h.db.prepare.bind(h.db), plans: string[] = [];
    const spy = vi.spyOn(h.db, "prepare").mockImplementation(sql => {
      if (sql.includes("previous_queue_lane")) {
        const rows = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(64) as Array<{ detail: string }>;
        plans.push(...rows.map(row => row.detail));
      }
      return prepare(sql);
    });
    const store = h.runtime().scheduling;
    for (let i = 0; i < 10; i++) expect(store.refreshActivePolicies({ maxRows: 64 }).refreshed).toBe(0);
    spy.mockRestore();
    expect(plans.filter(plan => plan.startsWith("SCAN q"))).toHaveLength(20);
    expect(plans.filter(plan => plan.startsWith("SCAN q")).every(plan => plan.includes("policy_pending_v") && plan.includes("_active"))).toBe(true);
    expect(plans.some(plan => /TEMP B-TREE|LIST SUBQUERY/.test(plan))).toBe(false);
  });

  it("backfills delayed and blocked old rows in bounded slices, resumes after reopening, and skips terminal history", () => {
    const h = harness();
    h.db.transaction(() => {
      for (let i = 0; i < 80; i++) { h.job(`main-${i}`); h.retry(`retry-${i}`, `target-${i}`); }
      h.db.exec(`UPDATE evolution_jobs SET policy_version=1, available_at='2100-01-01T00:00:00.000Z', blocked_reason='configuration';
        UPDATE embedding_retry_queue SET policy_version=1, next_attempt_at=4102444800000;
        UPDATE evolution_jobs SET status='succeeded' WHERE id='main-79';
        UPDATE embedding_retry_queue SET status='failed' WHERE id='retry-79'`);
    })();
    const identity = h.runtime().getJob("main-0")!;
    expect(h.runtime().scheduling.refreshActivePolicies({ maxRows: 0 })).toMatchObject({ refreshed: 0, hasMore: true });
    expect(h.runtime().scheduling.refreshActivePolicies({ maxRows: 64 })).toMatchObject({ refreshed: 64, hasMore: true });
    h.reopen();
    expect(h.runtime().scheduling.refreshActivePolicies({ maxRows: 64 })).toMatchObject({ refreshed: 64, hasMore: true });
    expect(h.runtime().scheduling.refreshActivePolicies({ maxRows: 64 })).toMatchObject({ refreshed: 30, hasMore: false });
    expect(h.runtime().scheduling.refreshActivePolicies({ maxRows: 64 })).toMatchObject({ refreshed: 0, hasMore: false });
    expect(h.runtime().getJob("main-0")).toMatchObject({ enqueueSeq: identity.enqueueSeq, firstQueuedAt: identity.firstQueuedAt,
      status: "queued", attempts: 0, leaseToken: null, availableAt: "2100-01-01T00:00:00.000Z", blockedReason: "configuration" });
    expect(h.runtime().getJob("main-79")!.policyVersion).toBe(1);
    expect(h.runtime().getEmbeddingRetry("retry-79")!.policyVersion).toBe(1);
    expect(h.runtime().getEmbeddingRetry("retry-0")).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: 4102444800000 });
  });

  it("upgrades installed v2 metadata and broad triggers once without changing FIFO identity", () => {
    const h = harness(); h.memory(); const original = h.job("main"); h.retry();
    for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
      h.db.exec(`DROP TRIGGER ${table}_policy_dirty;
        DROP INDEX ${pendingPolicyIndex(table)}; DROP INDEX ${pendingPolicyIndex(table, true)};
        ALTER TABLE ${table} DROP COLUMN policy_promotion;
        UPDATE ${table} SET policy_version=2;
        CREATE INDEX ${table}_policy_pending_v2 ON ${table}(enqueue_seq) WHERE policy_version IS NULL OR policy_version != 2`);
      const column = table === "evolution_jobs" ? "payload_json" : "source_text";
      h.db.exec(`CREATE TRIGGER ${table}_policy_dirty AFTER UPDATE OF ${column} ON ${table} BEGIN
        UPDATE ${table} SET policy_version=NULL WHERE id=NEW.id; END`);
    }
    h.db.exec(`DROP TRIGGER memories_worker_policy_dirty;
      CREATE TRIGGER memories_worker_policy_dirty AFTER UPDATE OF properties_json ON memories BEGIN
        UPDATE evolution_jobs SET policy_version=NULL WHERE target_memory_id=NEW.id;
        UPDATE embedding_retry_queue SET policy_version=NULL WHERE target_id=NEW.id; END`);
    h.reopen();
    expect(h.runtime().scheduling.refreshActivePolicies({ maxRows: 1 })).toMatchObject({ refreshed: 1, hasMore: true });
    h.reopen();
    expect(h.runtime().scheduling.refreshActivePolicies({ maxRows: 1 })).toMatchObject({ refreshed: 1, hasMore: false });
    expect(h.runtime().getJob("main")).toMatchObject({ policyVersion: JOB_POLICY_VERSION, enqueueSeq: original.enqueueSeq, firstQueuedAt: original.firstQueuedAt });
    expect(h.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%policy_pending_v2%'").all()).toEqual([]);
    h.db.exec("UPDATE memories SET properties_json='{\"summary\":\"ordinary update\"}' WHERE id='target'");
    expect(h.runtime().scheduling.pendingPolicyCount()).toBe(0);
  });

  it("keeps legacy raw writes discoverable, handles an empty retry gate, and resumes a terminal row as new work", () => {
    const h = harness(); h.job("main"); h.retry();
    h.db.exec(`UPDATE evolution_jobs SET payload_json='{"source":"memory.processing.manual_retry"}';
      UPDATE embedding_retry_queue SET source_text='changed'`);
    const store = h.runtime().scheduling;
    expect(store.refreshActivePolicies({ maxRows: 64, includeRetries: false })).toMatchObject({ refreshed: 1, hasMore: false });
    expect(h.runtime().getEmbeddingRetry("retry")!.policyVersion).toBeNull();
    expect(store.refreshActivePolicies({ maxRows: 1 })).toMatchObject({ refreshed: 1, hasMore: false });
    h.db.exec(`UPDATE evolution_jobs SET payload_json='{"source":"startup.placeholder_summary_repair"}';`);
    store.refreshActivePolicies({ maxRows: 64 });
    expect(h.runtime().getJob("main")).toMatchObject({ queueLane: "repair_retry", basePriority: 0 });
    h.db.exec("UPDATE evolution_jobs SET status='succeeded'; UPDATE evolution_jobs SET status='queued'");
    store.refreshActivePolicies({ maxRows: 64 });
    expect(h.runtime().getJob("main")).toMatchObject({ queueLane: "maintenance", basePriority: 90 });
  });
});

describe("unfinished-task promotion lifetime", () => {
  it.each(["queued", "leased", "failed"])("preserves explicit retry through background reuse and restart while %s", status => {
    const h = harness(); h.memory(); const original = h.job("original");
    h.job("manual", "memory.processing.manual_retry", "original");
    h.db.prepare("UPDATE evolution_jobs SET status=?, lease_token='identity', leased_until=? WHERE id='original'")
      .run(status, "2100-01-01T00:00:00.000Z");
    h.job("background", "startup.placeholder_summary_repair", "original");
    h.reopen();
    h.db.prepare("UPDATE evolution_jobs SET policy_version=? WHERE id='original'").run(JOB_POLICY_VERSION - 1);
    h.runtime().scheduling.refreshActivePolicies({ maxRows: 64 });
    expect(h.runtime().getJob(original.id)).toMatchObject({ queueLane: "repair_retry", basePriority: 0,
      status, leaseToken: "identity", enqueueSeq: original.enqueueSeq, firstQueuedAt: original.firstQueuedAt });
  });

  it.each(["succeeded", "dead_letter"])("does not pass urgency to a new main task after %s", status => {
    const h = harness(); h.memory(); h.job("original", "memory.processing.manual_retry", "same");
    h.db.prepare("UPDATE evolution_jobs SET status=? WHERE id='original'").run(status);
    const next = h.job("next", "startup.placeholder_summary_repair", "same");
    expect(next).toMatchObject({ id: "next", queueLane: "maintenance", basePriority: 90 });
    expect(next.enqueueSeq).toBeGreaterThan(h.runtime().getJob("original")!.enqueueSeq!);
  });

  it("preserves first-report urgency over a later manual retry or background reuse in both queues", () => {
    const h = harness(); h.memory(); const original = h.job("main"); const retry = h.retry();
    h.job("manual", "memory.processing.manual_retry", "main");
    h.db.exec(`UPDATE memories SET tags_json='["onboarding-report"]' WHERE id='target'`);
    h.runtime().scheduling.refreshActivePolicies({ maxRows: 64 });
    h.db.exec("UPDATE memories SET tags_json='[]' WHERE id='target'");
    h.job("another-manual", "memory.processing.manual_retry", "main");
    h.job("background", "startup.placeholder_summary_repair", "main"); h.retry();
    h.reopen();
    for (const task of [h.runtime().getJob("main"), h.runtime().getEmbeddingRetry("retry")]) {
      expect(task).toMatchObject({ queueLane: "interactive", basePriority: -100 });
    }
    expect(h.runtime().getJob("main")).toMatchObject({ enqueueSeq: original.enqueueSeq, firstQueuedAt: original.firstQueuedAt });
    expect(h.runtime().getEmbeddingRetry("retry")).toMatchObject({ enqueueSeq: retry.enqueueSeq, firstQueuedAt: retry.firstQueuedAt });
  });

  it.each(["failed", "succeeded"])("clears first-report promotion on a new retry work cycle after %s", status => {
    const h = harness(); h.memory("target", ["onboarding-report"]); h.retry();
    h.db.exec("UPDATE memories SET tags_json='[]' WHERE id='target'");
    h.runtime().scheduling.refreshActivePolicies({ maxRows: 64 });
    h.db.prepare("UPDATE embedding_retry_queue SET status=? WHERE id='retry'").run(status);
    h.retry();
    expect(h.runtime().getEmbeddingRetry("retry")).toMatchObject({ status: "pending", queueLane: "repair_retry", basePriority: 0 });
  });

  it("captures a raw producer's explicit retry before background dedupe overwrites its source", () => {
    const h = harness(); h.job("main");
    h.db.exec(`UPDATE evolution_jobs SET payload_json='{"source":"memory.processing.manual_retry"}', policy_version=NULL WHERE id='main'`);
    h.job("background", "startup.placeholder_summary_repair", "main");
    expect(h.runtime().getJob("main")).toMatchObject({ queueLane: "repair_retry", basePriority: 0 });
  });
});
