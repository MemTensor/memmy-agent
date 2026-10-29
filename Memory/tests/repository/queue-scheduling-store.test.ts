import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { JOB_POLICY_VERSION, jobPolicyRegistry } from "../../src/service/worker/job-policy-registry.js";
import { pendingPolicyIndex } from "../../src/storage/queue-scheduling-schema.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";
import type { JobType } from "../../src/types.js";

const at = "2026-10-22T00:00:00.000Z";
const now = Date.parse(at);
const resources: Array<{ db: MemoryDb; root: string }> = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-queue-metadata-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ db, root });
  const repos = new Repositories(db.db);
  function memory(id: string, tags: string[] = []) {
    db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,tags_json,created_at,updated_at)
      VALUES (?,?,'user','synthetic','L1',?,?,?)`).run(id, at, JSON.stringify(tags), at, at);
  }
  function job(id: string, type: JobType = "reflection", target?: string, payload: Record<string, unknown> = {}, dedupeKey?: string) {
    return repos.runtime.enqueueJob({ id, jobType: type, status: "queued", userId: "user", targetMemoryId: target,
      dedupeKey, payload, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  function rawJob(id: string, type = "reflection", options: { at?: string; payload?: Record<string, unknown>; target?: string; scopeKey?: string; scopeSeq?: number } = {}) {
    db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,target_memory_id,payload_json,
      scope_key,scope_seq,created_at,updated_at) VALUES (?,?,'queued','user',?,?,?,?,?,?)`)
      .run(id, type, options.target ?? null, JSON.stringify(options.payload ?? {}), options.scopeKey ?? null,
        options.scopeSeq ?? null, options.at ?? at, options.at ?? at);
  }
  function retry(id: string, target = id, stamp = now) {
    return repos.runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: target,
      vectorField: "vec_summary", sourceText: "synthetic", now: stamp });
  }
  function ids(options = {}) {
    return repos.runtime.scheduling.candidates({ at, limit: 50, ...options }).map(c => c.id).sort();
  }
  return { root, db, repos, runtime: repos.runtime, store: repos.runtime.scheduling, memory, job, rawJob, retry, ids };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const { db, root } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function removeSchedulingSchema(db: MemoryDb): void {
  for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
    for (const suffix of ["enqueue_sequence", "policy_dirty"]) db.db.exec(`DROP TRIGGER ${table}_${suffix}`);
    db.db.exec(`DROP INDEX ${pendingPolicyIndex(table)}`);
    db.db.exec(`DROP INDEX ${pendingPolicyIndex(table, true)}`);
    for (const suffix of ["enqueue_seq", "lane_due", "lane_fifo", "policy_dirty"]) db.db.exec(`DROP INDEX ${table}_${suffix}`);
  }
  for (const suffix of ["dirty", "insert", "delete"]) db.db.exec(`DROP TRIGGER memories_worker_policy_${suffix}`);
  for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
    for (const column of ["queue_lane", "resource_class", "enqueue_seq", "first_queued_at", "base_priority", "policy_version", "policy_promotion"]) {
      db.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  db.db.exec("DROP TABLE worker_enqueue_counter");
}

describe("queue scheduling metadata and read-only candidates", () => {
  it("retains a manual promotion when an unfinished task is redelivered by startup repair", () => {
    const h = harness();
    const first = h.job("first", "import_summary", undefined, { source: "startup.placeholder_summary_repair" }, "same");
    h.job("manual", "import_summary", undefined, { source: "memory.processing.manual_retry" }, "same");
    const reused = h.job("background", "import_summary", undefined, { source: "startup.placeholder_summary_repair" }, "same");
    expect(reused).toMatchObject({ id: first.id, queueLane: "repair_retry", basePriority: 0,
      enqueueSeq: first.enqueueSeq, firstQueuedAt: first.firstQueuedAt,
      payload: { source: "startup.placeholder_summary_repair" } });
  });

  it("does not dirty policies for changes to memory content unrelated to scheduling", () => {
    const h = harness(); h.memory("target");
    h.job("summary", "trace_summary", "target"); h.retry("retry", "target");
    h.db.db.prepare("UPDATE memories SET properties_json=? WHERE id='target'")
      .run(JSON.stringify({ internal_info: { processing_state: "ready" }, arbitrary: "updated" }));
    expect(h.store.pendingPolicyCount()).toBe(0);
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 64 }).refreshed).toBe(0);
  });

  it("migrates v11 with chronological order across both queues and remains stable after reopening", () => {
    const h = harness();
    h.rawJob("late-main", "reflection", { at: "2026-10-22T00:00:03.000Z" });
    h.rawJob("first-main", "reflection", { at: "2026-10-22T00:00:01.000Z" });
    h.retry("middle-retry", "target", now + 2_000);
    removeSchedulingSchema(h.db);
    h.db.db.exec("DELETE FROM schema_migrations");
    h.db.db.prepare("INSERT INTO schema_migrations VALUES ('011_embedding_retry_lease_token',11,?,'legacy')").run(at);
    const path = h.db.path;
    h.db.close();
    const reopened = new MemoryDb({ path });
    resources.find(r => r.root === h.root)!.db = reopened;
    const runtime = new Repositories(reopened.db).runtime;
    expect(reopened.schemaVersion().version).toBe(SCHEMA_VERSION);
    expect(existsSync(`${path}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
    expect(runtime.getJob("first-main")).toMatchObject({ enqueueSeq: 1, firstQueuedAt: "2026-10-22T00:00:01.000Z", status: "queued" });
    expect(runtime.getEmbeddingRetry("middle-retry")).toMatchObject({ enqueueSeq: 2, firstQueuedAt: "2026-10-22T00:00:02.000Z", status: "pending" });
    expect(runtime.getJob("late-main")).toMatchObject({ enqueueSeq: 3 });
    const counts = runtime.scheduling.refreshPolicies();
    expect(counts).toEqual({ refreshed: 3, unknown: [] });
    reopened.close();
    const again = new MemoryDb({ path });
    resources.find(r => r.root === h.root)!.db = again;
    expect(new Repositories(again.db).runtime.getJob("first-main")!.enqueueSeq).toBe(1);
    new Repositories(again.db).runtime.enqueueEmbeddingRetry({ id: "after-reopen", targetKind: "trace", targetId: "after", vectorField: "vec_summary", sourceText: "later", now });
    expect(new Repositories(again.db).runtime.getEmbeddingRetry("after-reopen")!.enqueueSeq).toBe(4);
  });

  it("assigns one global monotonic order to raw SQL and repository inserts without reusing a deleted maximum", () => {
    const h = harness();
    const first = h.job("main-one");
    const second = h.retry("retry-two");
    h.rawJob("raw-three");
    const third = h.runtime.getJob("raw-three")!;
    expect([first.enqueueSeq, second.enqueueSeq, third.enqueueSeq]).toEqual([1, 2, 3]);
    expect(third).toMatchObject({ firstQueuedAt: expect.any(String), policyVersion: null });
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id = ?").run(third.id);
    h.db.db.prepare(`INSERT INTO embedding_retry_queue(id,target_kind,target_id,vector_field,source_text,status,next_attempt_at,created_at,updated_at)
      VALUES ('raw-four','trace','raw-target','vec_summary','raw','pending',?,?,?)`).run(now, now, now);
    expect(h.runtime.getEmbeddingRetry("raw-four")).toMatchObject({ enqueueSeq: 4, firstQueuedAt: expect.any(String), policyVersion: null });
    expect(h.store.refreshPolicies().refreshed).toBe(1);
    expect(h.runtime.getJob(first.id)).toMatchObject({ enqueueSeq: 1, queueLane: "evolution" });
    expect(h.runtime.getEmbeddingRetry("raw-four")).toMatchObject({ enqueueSeq: 4, queueLane: "repair_retry" });
  });

  it("starts new waiting age at actual insertion even when a producer backdates creation to an old conversation", () => {
    const h = harness();
    const before = Date.now();
    const old = "2001-01-01T00:00:00.000Z";
    h.rawJob("backdated-main", "import_summary", { at: old });
    h.retry("backdated-retry", "old-target", Date.parse(old));
    const after = Date.now();
    const main = h.runtime.getJob("backdated-main")!;
    const retry = h.runtime.getEmbeddingRetry("backdated-retry")!;
    expect(main.createdAt).toBe(old);
    expect(retry.createdAt).toBe(Date.parse(old));
    for (const record of [main, retry]) {
      expect(Date.parse(record.firstQueuedAt!)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(record.firstQueuedAt!)).toBeLessThanOrEqual(after);
    }
  });

  it("returns no candidates for a zero-sized preview", () => {
    const h = harness(); h.job("main"); h.retry("retry");
    expect(h.store.candidates({ at, limit: 0 })).toEqual([]);
    expect(h.runtime.getJob("main")!.status).toBe("queued");
    expect(h.runtime.getEmbeddingRetry("retry")!.status).toBe("pending");
  });

  it("keeps real enqueues successful and policy metadata dirty when optional projection fails", () => {
    const h = harness();
    const resolve = vi.spyOn(jobPolicyRegistry, "resolve").mockImplementation(() => { throw new Error("projection-only failure"); });
    expect(h.job("main")).toMatchObject({ id: "main", status: "queued", policyVersion: null });
    expect(h.retry("retry")).toMatchObject({ id: "retry", status: "pending", policyVersion: null });
    expect(h.store.pendingPolicyCount()).toBe(2);
    expect(h.ids()).toEqual([]);
    resolve.mockRestore();
    expect(h.store.refreshPolicies()).toEqual({ refreshed: 2, unknown: [] });
    expect(h.ids()).toEqual(["main", "retry"]);
  });

  it("preserves FIFO identity through dedupe, temporary failure, configuration recovery and retry input updates", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const h = harness();
    h.job("original", "trace_summary", undefined, {}, "dedupe");
    const first = h.runtime.getJob("original")!;
    expect(h.job("duplicate", "trace_summary", undefined, { source: "memory.processing.manual_retry" }, "dedupe").id).toBe(first.id);
    const [claim] = h.runtime.leaseQueuedJobs(1);
    h.runtime.failJob(first.id, "configuration", at, false, claim, { blockedReason: "configuration", countFailure: false });
    h.runtime.resumeConfigurationBlockedJobs(at);
    const [secondClaim] = h.runtime.leaseQueuedJobs(1);
    h.runtime.failJob(first.id, "temporary", at, false, secondClaim, { availableAt: new Date(now + 5_000).toISOString() });
    expect(h.runtime.getJob(first.id)).toMatchObject({ enqueueSeq: first.enqueueSeq, firstQueuedAt: first.firstQueuedAt });
    const retry = h.retry("retry");
    h.runtime.claimDueEmbeddingRetries({ now, workerId: "worker", leaseUntil: now + 1_000 });
    h.runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "retry", vectorField: "vec_summary", sourceText: "changed", now: now + 1 });
    h.runtime.claimDueEmbeddingRetries({ now: now + 1, workerId: "worker", leaseUntil: now + 2_000 });
    h.runtime.requeueEmbeddingRetriesAfterRestart(now + 2_001);
    expect(h.runtime.getEmbeddingRetry(retry.id)).toMatchObject({ enqueueSeq: retry.enqueueSeq, firstQueuedAt: retry.firstQueuedAt, status: "pending" });
  });

  it("refreshes policy changes and target Onboarding tags without changing the sequence", () => {
    const h = harness(); h.memory("target", ["agent-source"]);
    const original = h.job("summary", "import_summary", "target");
    h.retry("retry", "target");
    expect(h.runtime.getJob(original.id)).toMatchObject({ queueLane: "import", policyVersion: JOB_POLICY_VERSION });
    h.db.db.prepare("UPDATE memories SET tags_json = ? WHERE id = 'target'").run('["agent-source","onboarding-report"]');
    expect(h.runtime.getJob(original.id)!.policyVersion).toBeNull();
    expect(h.runtime.getEmbeddingRetry("retry")!.policyVersion).toBeNull();
    expect(h.store.refreshPolicies().refreshed).toBe(2);
    expect(h.runtime.getJob(original.id)).toMatchObject({ queueLane: "interactive", basePriority: -100, enqueueSeq: original.enqueueSeq });
    expect(h.runtime.getEmbeddingRetry("retry")).toMatchObject({ queueLane: "interactive", basePriority: -100 });
    h.db.db.prepare("UPDATE memories SET tags_json='[]' WHERE id='target'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json = ? WHERE id='summary'").run('{"source":"startup.placeholder_summary_repair"}');
    h.store.refreshPolicies();
    expect(h.runtime.getJob(original.id)).toMatchObject({ queueLane: "interactive", basePriority: -100, enqueueSeq: original.enqueueSeq });
    h.db.db.prepare("UPDATE evolution_jobs SET policy_version = ? WHERE id='summary'").run(JOB_POLICY_VERSION - 1);
    expect(h.store.pendingPolicyCount()).toBe(1);
    expect(h.store.refreshPolicies(1).refreshed).toBe(1);
  });

  it("projects native historical capture metadata on enqueue for both summary and subsequent embedding", () => {
    const h = harness(); h.memory("native-history", ["database", "test"]); h.memory("live-hook", ["database", "test"]);
    h.db.db.prepare("UPDATE memories SET agent_id='claude_code',properties_json=? WHERE id='native-history'")
      .run(JSON.stringify({ internal_info: { plugin_algorithm: "capture.v7", capture_origin: "agent_source_scan" } }));
    h.db.db.prepare("UPDATE memories SET agent_id='claude_code',properties_json=? WHERE id='live-hook'")
      .run(JSON.stringify({ internal_info: { plugin_algorithm: "capture.v7" } }));
    const summary = h.job("native-summary", "trace_summary", "native-history", { source: "turn.complete.capture", decideCapture: true });
    const embedding = h.job("native-embedding", "embedding", "native-history", { reason: "trace.summary.updated", sourceJobId: summary.id });
    expect(summary).toMatchObject({ jobType: "trace_summary", queueLane: "import", resourceClass: "summary", payload: { source: "turn.complete.capture", decideCapture: true } });
    expect(embedding).toMatchObject({ queueLane: "import", resourceClass: "embedding", payload: { reason: "trace.summary.updated" } });
    expect(h.retry("history-retry", "native-history").queueLane).toBe("repair_retry");
    expect(h.job("live-summary", "trace_summary", "live-hook").queueLane).toBe("interactive");
    expect(h.job("live-embedding", "embedding", "live-hook").queueLane).toBe("interactive");
    const memory = h.repos.memories.get("native-history")!;
    expect(memory.tags).toEqual(["database", "test"]);
    expect(memory.properties.internal_info.plugin_algorithm).toBe("capture.v7");
  });

  it("refreshes an older policy version with explicit native history metadata while preserving FIFO and lease state", () => {
    const h = harness(); h.memory("native-history"); h.memory("unmarked-native");
    h.db.db.prepare("UPDATE memories SET properties_json=? WHERE id='native-history'")
      .run(JSON.stringify({ internal_info: { plugin_algorithm: "capture.v7", capture_origin: "agent_source_scan" } }));
    const summary = h.job("history-summary", "trace_summary", "native-history");
    const unmarked = h.job("unmarked-summary", "trace_summary", "unmarked-native");
    h.db.db.prepare("UPDATE evolution_jobs SET policy_version=?,queue_lane='interactive' WHERE id IN (?,?)")
      .run(JOB_POLICY_VERSION - 1, summary.id, unmarked.id);
    expect(JOB_POLICY_VERSION).toBeGreaterThan(1);
    expect(h.store.refreshPolicies()).toEqual({ refreshed: 2, unknown: [] });
    expect(h.runtime.getJob(summary.id)).toMatchObject({ queueLane: "import", policyVersion: JOB_POLICY_VERSION,
      enqueueSeq: summary.enqueueSeq, firstQueuedAt: summary.firstQueuedAt, status: "queued", attempts: 0, leaseCount: 0, leaseToken: null });
    expect(h.runtime.getJob(unmarked.id)).toMatchObject({ queueLane: "interactive", enqueueSeq: unmarked.enqueueSeq });
    h.db.db.prepare("UPDATE memories SET properties_json=? WHERE id='native-history'")
      .run(JSON.stringify({ internal_info: { plugin_algorithm: "capture.v7" } }));
    expect(h.runtime.getJob(summary.id)!.policyVersion).toBeNull();
    h.store.refreshPolicies();
    expect(h.runtime.getJob(summary.id)).toMatchObject({ queueLane: "interactive", enqueueSeq: summary.enqueueSeq });
  });

  it("marks unknown raw job types as explicitly unregistered and excludes them from lane previews", () => {
    const h = harness(); h.rawJob("unknown", "future_job_type");
    expect(h.store.refreshPolicies()).toEqual({ refreshed: 1, unknown: [{ id: "unknown", jobType: "future_job_type" }] });
    expect(h.runtime.getJob("unknown")).toMatchObject({ queueLane: "unregistered", resourceClass: "unregistered", policyVersion: JOB_POLICY_VERSION, status: "queued" });
    expect(h.ids()).toEqual([]);
    expect(h.store.pendingPolicyCount()).toBe(0);
  });

  it("uses the same main eligibility as legacy preview for future availability, config waits, lease and task filters", () => {
    const h = harness();
    for (const id of ["ready", "future-available", "future-run", "configuration", "leased-valid", "leased-expired", "exhausted"]) h.rawJob(id, "reflection", { target: "target" });
    h.rawJob("future-run-2", "reflection", { payload: { runAfter: new Date(now + 60_000).toISOString() }, target: "target" });
    h.rawJob("different-type", "episode_title", { target: "other" });
    h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='future-available'").run(new Date(now + 60_000).toISOString());
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='future-run'").run(JSON.stringify({ runAfter: new Date(now + 1).toISOString() }));
    h.db.db.prepare("UPDATE evolution_jobs SET blocked_reason='configuration' WHERE id='configuration'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='leased-valid'").run(new Date(now + 60_000).toISOString());
    h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='leased-expired'").run(at);
    h.db.db.prepare("UPDATE evolution_jobs SET failure_count=max_attempts WHERE id='exhausted'").run();
    h.store.refreshPolicies();
    const filters = { allowedJobTypes: ["reflection"], excludedJobTypes: ["episode_title"], targetMemoryIds: ["target"] };
    expect(h.ids(filters)).toEqual(["leased-expired", "ready"]);
    expect(h.runtime.previewQueuedJobs({ at, limit: 50, ...filters }).map(j => j.id).sort()).toEqual(h.ids(filters));
    expect(h.ids({ targetMemoryIds: [] })).toEqual([]);
    expect(h.ids({ allowedJobTypes: [] })).toEqual([]);
    expect(h.runtime.getJob("leased-expired")!.status).toBe("leased");
  });

  it("skips a reward dependency and blocked scope positions, keeping other scopes runnable", () => {
    const h = harness(); h.memory("dependency");
    h.db.db.prepare(`INSERT INTO memory_processing_state(memory_id,state,stage,updated_at) VALUES ('dependency','embedding_pending','embedding',?)`).run(at);
    h.rawJob("reward-wait", "reward", { payload: { l1MemoryId: "dependency", polarity: "positive" } });
    h.rawJob("reward-negative", "reward", { payload: { l1MemoryId: "dependency", polarity: "negative" } });
    h.rawJob("scope-first", "work_memory_extract", { scopeKey: "scope-a", scopeSeq: 1, payload: { runAfter: new Date(now + 60_000).toISOString() } });
    h.rawJob("scope-next", "work_memory_extract", { scopeKey: "scope-a", scopeSeq: 2 });
    h.rawJob("other-scope", "work_memory_extract", { scopeKey: "scope-b", scopeSeq: 1 });
    h.rawJob("missing-scope", "work_memory_extract");
    h.store.refreshPolicies();
    expect(h.ids()).toEqual(["other-scope", "reward-negative"]);
    expect(h.runtime.previewQueuedJobs({ at, limit: 50 }).map(j => j.id).sort()).toEqual(h.ids());
  });

  it("shares retry due and target filtering and keeps previews free of claims", () => {
    const h = harness();
    h.retry("ready", "target"); h.retry("later", "later-target", now + 1_000); h.retry("outside", "other");
    h.retry("valid", "valid-target"); h.retry("expired", "expired-target");
    h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',claimed_by='fixture-worker',lease_until=? WHERE id='valid'").run(now + 1_000);
    h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',claimed_by='fixture-worker',lease_until=? WHERE id='expired'").run(now);
    h.store.refreshPolicies();
    expect(h.ids()).toEqual(["expired", "outside", "ready"]);
    expect(h.ids({ targetMemoryIds: ["target"] })).toEqual(["ready"]);
    expect(h.ids({ includeRetries: false })).toEqual([]);
    expect(h.runtime.previewDueEmbeddingRetries({ now, limit: 50 }).map(j => j.id).sort()).toEqual(h.ids());
    expect(h.runtime.getEmbeddingRetry("ready")!.status).toBe("pending");
  });

  it("uses a target lookup for retry policy invalidation instead of scanning the whole retry backlog", () => {
    const h = harness(); h.retry("target-retry", "target");
    const plan = h.db.db.prepare("EXPLAIN QUERY PLAN UPDATE embedding_retry_queue SET policy_version=NULL WHERE target_id=?")
      .all("target") as Array<{ detail: string }>;
    expect(plan.some(row => row.detail.includes("SEARCH") && row.detail.includes("target_id=?"))).toBe(true);
    h.memory("target", ["onboarding-report"]);
    expect(h.runtime.getEmbeddingRetry("target-retry")!.policyVersion).toBeNull();
    h.store.refreshPolicies();
    expect(h.runtime.getEmbeddingRetry("target-retry")!.queueLane).toBe("interactive");
  });

  it("reads bounded candidates for every lane even behind 10000 imported tasks", () => {
    const h = harness();
    h.db.db.transaction(() => {
      for (let i = 0; i < 10_000; i++) h.rawJob(`import-${i}`, "import_summary");
      h.rawJob("native", "trace_summary");
      h.rawJob("repair", "decision_repair");
      h.rawJob("reflection", "reflection");
      h.rawJob("maintenance", "project_environment_profile");
      h.retry("retry");
    })();
    while (h.store.pendingPolicyCount() > 0) h.store.refreshPolicies(500);
    const candidates = h.store.candidates({ at, limit: 2 });
    expect(candidates.filter(c => c.lane === "import").map(c => c.id)).toEqual(["import-0", "import-1"]);
    expect(candidates.map(c => c.id)).toEqual(expect.arrayContaining(["native", "repair", "reflection", "maintenance", "retry"]));
    expect(candidates).toHaveLength(7);
    expect(h.runtime.getJob("native")!.status).toBe("queued");
    expect(h.runtime.getEmbeddingRetry("retry")!.status).toBe("pending");
  });
});

describe("real-scheduler policy preparation", () => {
  it("does not invalidate selection while initially classifying newly enqueued or raw jobs", () => {
    const h = harness();
    expect(h.store.getSelectionRevision()).toBe(0);
    h.job("new-main"); h.retry("new-retry");
    h.rawJob("raw-new");
    expect(h.store.refreshRunnablePolicies({ at }).refreshed).toBe(1);
    expect(h.store.getSelectionRevision()).toBe(0);
  });

  it("invalidates selection for an existing deduplicated task even after its metadata is current", () => {
    const h = harness();
    const original = h.job("original", "import_summary", undefined, {}, "same-job");
    const revision = h.store.getSelectionRevision();
    const updated = h.job("discarded-id", "import_summary", undefined,
      { source: "startup.placeholder_summary_repair" }, "same-job");
    expect(updated).toMatchObject({ id: original.id, queueLane: "maintenance", policyVersion: JOB_POLICY_VERSION });
    expect(h.store.getSelectionRevision()).toBe(revision + 1);
    h.store.refreshOne("main", original.id);
    // Refreshing unchanged, current metadata must not reset a deep candidate scan.
    expect(h.store.getSelectionRevision()).toBe(revision + 1);
    h.job("another-id", "import_summary", undefined, { scope: "changed" }, "same-job");
    expect(h.store.getSelectionRevision()).toBe(revision + 2);
  });

  it.each(["full", "runnable"] as const)("shares %s refresh invalidations across both tables without counting first projections", mode => {
    const h = harness(); h.job("old-main"); h.retry("old-retry"); h.rawJob("fresh-main");
    h.db.db.prepare("UPDATE evolution_jobs SET policy_version=NULL WHERE id='old-main'").run();
    h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL WHERE id='old-retry'").run();
    expect(h.store.getSelectionRevision()).toBe(0);
    const result = mode === "full" ? h.store.refreshPolicies() : h.store.refreshRunnablePolicies({ at, maxRows: 64 });
    expect(result.refreshed).toBe(3);
    expect(h.store.getSelectionRevision()).toBe(2);
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 64 }).refreshed).toBe(0);
    expect(h.store.getSelectionRevision()).toBe(2);
  });

  it("shares the revision between Repositories using the same SQLite connection", () => {
    const h = harness(), second = new Repositories(h.db.db).runtime.scheduling;
    h.job("shared-main"); h.retry("shared-retry");
    expect(second.getSelectionRevision()).toBe(0);
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json='{\"scope\":\"changed\"}' WHERE id='shared-main'").run();
    second.refreshOne("main", "shared-main");
    expect(h.store.getSelectionRevision()).toBe(1);
    h.db.db.prepare("UPDATE embedding_retry_queue SET source_text='changed' WHERE id='shared-retry'").run();
    h.store.refreshOne("embedding_retry", "shared-retry");
    expect(second.getSelectionRevision()).toBe(2);
    expect(harness().store.getSelectionRevision()).toBe(0);
  });

  it("keeps invalidation monotonic when an outer transaction rolls a policy update back", () => {
    const h = harness(); const original = h.job("rolled-back", "import_summary");
    const before = h.store.getSelectionRevision();
    expect(() => h.repos.transaction(() => {
      h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id=?")
        .run(JSON.stringify({ source: "startup.placeholder_summary_repair" }), original.id);
      h.store.refreshOne("main", original.id);
      expect(h.runtime.getJob(original.id)?.queueLane).toBe("maintenance");
      throw new Error("fixture transaction rollback");
    })).toThrow("fixture transaction rollback");
    expect(h.runtime.getJob(original.id)?.queueLane).toBe("import");
    expect(h.store.getSelectionRevision()).toBeGreaterThan(before);
    const afterRollback = h.store.getSelectionRevision();
    h.store.refreshOne("main", original.id);
    expect(h.store.getSelectionRevision()).toBe(afterRollback);
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json='{\"scope\":\"changed\"}' WHERE id=?").run(original.id);
    h.store.refreshOne("main", original.id);
    expect(h.store.getSelectionRevision()).toBeGreaterThan(afterRollback);
    h.store.refreshOne("main", "missing");
    expect(h.store.getSelectionRevision()).toBe(afterRollback + 1);
  });

  it.each([0, 1, 64])("limits actual policy writes to maxRows=%i across both backing queues", maxRows => {
    const h = harness();
    h.db.db.transaction(() => {
      for (let i = 0; i < 65; i++) h.rawJob(`main-${i}`, "import_summary");
      for (let i = 0; i < 3; i++) h.retry(`retry-${i}`);
      h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL").run();
    })();
    const input = { at, maxRows };
    expect(h.store.refreshRunnablePolicies(input)).toEqual({ refreshed: maxRows, unknown: [], hasMore: true });
    const projected = h.db.db.prepare(`SELECT
      (SELECT COUNT(*) FROM evolution_jobs WHERE policy_version=?) +
      (SELECT COUNT(*) FROM embedding_retry_queue WHERE policy_version=?) AS n`)
      .get(JOB_POLICY_VERSION, JOB_POLICY_VERSION) as { n: number };
    expect(projected.n).toBe(maxRows);
    if (maxRows === 0) {
      expect(h.store.pendingPolicyCount()).toBe(68);
      expect(h.store.refreshRunnablePolicies({ at })).toEqual({ refreshed: 68, unknown: [] });
    } else {
      let total = maxRows;
      for (let round = 0; round < 70; round++) {
        const result = h.store.refreshRunnablePolicies(input);
        expect(result.refreshed).toBeLessThanOrEqual(maxRows);
        total += result.refreshed;
        if (result.hasMore === false) break;
      }
      expect(total).toBe(68);
    }
    expect(h.store.refreshRunnablePolicies(input)).toEqual({ refreshed: 0, unknown: [], hasMore: false });
  });

  it("shares the remaining row budget with retries instead of giving each table a separate allowance", () => {
    const h = harness();
    h.rawJob("main");
    h.retry("retry-first"); h.retry("retry-second");
    h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL").run();
    const result = h.store.refreshRunnablePolicies({ at, maxRows: 2 });
    expect(result).toEqual({ refreshed: 2, unknown: [], hasMore: true });
    expect(h.runtime.getJob("main")?.policyVersion).toBe(JOB_POLICY_VERSION);
    expect(h.runtime.getEmbeddingRetry("retry-first")?.policyVersion).toBe(JOB_POLICY_VERSION);
    expect(h.runtime.getEmbeddingRetry("retry-second")?.policyVersion).toBeNull();
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 2 })).toEqual({ refreshed: 1, unknown: [], hasMore: false });
  });

  it("reports a precise exhausted boundary on the next empty slice and probes zero budget without writes", () => {
    const h = harness();
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 0 })).toEqual({ refreshed: 0, unknown: [], hasMore: false });
    h.rawJob("one");
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 0 })).toEqual({ refreshed: 0, unknown: [], hasMore: true });
    expect(h.runtime.getJob("one")?.policyVersion).toBeNull();
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 1 })).toEqual({ refreshed: 1, unknown: [], hasMore: true });
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 1 })).toEqual({ refreshed: 0, unknown: [], hasMore: false });
  });

  it("preserves due, dependency, scope, configuration, terminal and retry eligibility in bounded slices", () => {
    const h = harness();
    for (const id of ["ready", "due-failed", "future-failed", "configuration", "succeeded", "terminal", "leased-valid", "leased-expired"])
      h.rawJob(id);
    h.rawJob("future-run", "reflection", { payload: { runAfter: new Date(now + 1000).toISOString() } });
    h.db.db.prepare("UPDATE evolution_jobs SET status='failed',available_at=? WHERE id='due-failed'").run(at);
    h.db.db.prepare("UPDATE evolution_jobs SET status='failed',available_at=? WHERE id='future-failed'").run(new Date(now+1000).toISOString());
    h.db.db.prepare("UPDATE evolution_jobs SET blocked_reason='configuration' WHERE id='configuration'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE id='succeeded'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET status='dead_letter' WHERE id='terminal'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='leased-valid'").run(new Date(now+1000).toISOString());
    h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='leased-expired'").run(at);
    h.memory("pending-target");
    h.repos.processing.save({ memoryId: "pending-target", state: "embedding_pending", stage: "embedding", activeJobId: null,
      attemptCount: 0, manualRetryCount: 0, retryAction: "retry", updatedAt: at });
    h.rawJob("reward-blocked", "reward", { payload: { l1MemoryId: "pending-target" } });
    h.rawJob("scope-first", "l3_world_model_update", { scopeKey: "project", scopeSeq: 1 });
    h.rawJob("scope-blocked", "l3_world_model_update", { scopeKey: "project", scopeSeq: 2 });
    h.retry("retry-due"); h.retry("retry-future"); h.retry("retry-terminal");
    h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL").run();
    h.db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=? WHERE id='retry-future'").run(now+1000);
    h.db.db.prepare("UPDATE embedding_retry_queue SET status='succeeded' WHERE id='retry-terminal'").run();
    const input = { at, maxRows: 1, includeDueFailed: true };
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const result = h.store.refreshRunnablePolicies(input); total += result.refreshed;
      expect(result.refreshed).toBeLessThanOrEqual(1);
      if (result.hasMore === false) break;
    }
    expect(total).toBe(5);
    for (const id of ["ready", "due-failed", "leased-expired", "scope-first"])
      expect(h.runtime.getJob(id)?.policyVersion).toBe(JOB_POLICY_VERSION);
    for (const id of ["future-failed", "configuration", "succeeded", "terminal", "leased-valid", "future-run", "reward-blocked", "scope-blocked"])
      expect(h.runtime.getJob(id)?.policyVersion).toBeNull();
    expect(h.runtime.getEmbeddingRetry("retry-due")?.policyVersion).toBe(JOB_POLICY_VERSION);
    expect(h.runtime.getEmbeddingRetry("retry-future")?.policyVersion).toBeNull();
    expect(h.runtime.getEmbeddingRetry("retry-terminal")?.policyVersion).toBeNull();
    expect(h.store.refreshRunnablePolicies({ ...input, maxRows: 0 })).toEqual({ refreshed: 0, unknown: [], hasMore: false });
  });

  it("applies target/type/retry gates to the bounded zero-write probe as well as projection", () => {
    const h = harness();
    h.rawJob("outside", "reflection", { target: "outside" });
    h.rawJob("wrong-type", "episode_title", { target: "selected" });
    h.retry("inside-retry", "selected");
    h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL").run();
    const input = { at, targetMemoryIds: ["selected"], allowedJobTypes: ["reflection"], includeRetries: false, maxRows: 0 };
    expect(h.store.refreshRunnablePolicies(input)).toEqual({ refreshed: 0, unknown: [], hasMore: false });
    expect(h.store.refreshRunnablePolicies({ ...input, includeRetries: true })).toEqual({ refreshed: 0, unknown: [], hasMore: true });
    expect(h.store.refreshRunnablePolicies({ ...input, includeRetries: true, maxRows: 1 })).toEqual({ refreshed: 1, unknown: [], hasMore: true });
    expect(h.runtime.getJob("outside")?.policyVersion).toBeNull();
    expect(h.runtime.getJob("wrong-type")?.policyVersion).toBeNull();
  });

  it("counts unknown-type quarantine against the same row budget and does not warn/project it again", () => {
    const h = harness(); h.rawJob("unknown", "future_new_job"); h.rawJob("next");
    const input = { at, maxRows: 1 };
    expect(h.store.refreshRunnablePolicies(input)).toEqual({ refreshed: 1, unknown: [{ id: "unknown", jobType: "future_new_job" }], hasMore: true });
    expect(h.runtime.getJob("unknown")).toMatchObject({ queueLane: "unregistered", attempts: 0, status: "queued" });
    expect(h.runtime.getJob("next")?.policyVersion).toBeNull();
    expect(h.store.refreshRunnablePolicies(input)).toEqual({ refreshed: 1, unknown: [], hasMore: true });
    expect(h.store.refreshRunnablePolicies(input)).toEqual({ refreshed: 0, unknown: [], hasMore: false });
  });

  it("does not charge already-classified rows, exhausted failures or valid retry leases against a slice", () => {
    const h = harness();
    h.job("already-classified");
    h.rawJob("exhausted");
    h.db.db.prepare("UPDATE evolution_jobs SET failure_count=max_attempts WHERE id='exhausted'").run();
    h.retry("valid-lease"); h.retry("expired-lease");
    h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL,status='in_progress',claimed_by='fixture-worker',lease_until=? WHERE id='valid-lease'").run(now+1000);
    h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL,status='in_progress',claimed_by='fixture-worker',lease_until=? WHERE id='expired-lease'").run(now);
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 1 })).toEqual({ refreshed: 1, unknown: [], hasMore: true });
    expect(h.runtime.getEmbeddingRetry("expired-lease")?.policyVersion).toBe(JOB_POLICY_VERSION);
    expect(h.runtime.getEmbeddingRetry("valid-lease")?.policyVersion).toBeNull();
    expect(h.runtime.getJob("exhausted")?.policyVersion).toBeNull();
    expect(h.store.refreshRunnablePolicies({ at, maxRows: 1 })).toEqual({ refreshed: 0, unknown: [], hasMore: false });
  });

  it("retains type exclusion and the default failed-job gate during zero-write and nonzero slices", () => {
    const h = harness();
    h.rawJob("excluded", "trace_summary"); h.rawJob("failure", "reflection");
    h.db.db.prepare("UPDATE evolution_jobs SET status='failed' WHERE id='failure'").run();
    const input = { at, maxRows: 0, excludedJobTypes: ["trace_summary"] };
    expect(h.store.refreshRunnablePolicies(input)).toEqual({ refreshed: 0, unknown: [], hasMore: false });
    expect(h.store.refreshRunnablePolicies({ ...input, maxRows: 1 })).toEqual({ refreshed: 0, unknown: [], hasMore: false });
    expect(h.store.refreshRunnablePolicies({ ...input, maxRows: 1, includeDueFailed: true }))
      .toEqual({ refreshed: 1, unknown: [], hasMore: true });
    expect(h.runtime.getJob("excluded")?.policyVersion).toBeNull();
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid projection budget %s without writing rows", maxRows => {
    const h = harness(); h.rawJob("untouched");
    expect(() => h.store.refreshRunnablePolicies({ at, maxRows })).toThrow(RangeError);
    expect(h.runtime.getJob("untouched")?.policyVersion).toBeNull();
  });

  it("finishes more than one projection batch before FIFO selection without touching terminal history", () => {
    const h = harness();
    h.db.db.transaction(() => {
      for (let i = 0; i < 501; i++) h.rawJob(`old-${i}`, "import_summary");
      for (const status of ["succeeded", "dead_letter", "failed"] as const) {
        h.rawJob(`terminal-${status}`);
        h.db.db.prepare("UPDATE evolution_jobs SET status=? WHERE id=?").run(status, `terminal-${status}`);
      }
      h.rawJob("future", "reflection", { payload: { runAfter: new Date(now + 1_000).toISOString() } });
      h.job("new-already-classified", "import_summary");
      h.retry("ready-retry");
      h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL WHERE id='ready-retry'").run();
    })();
    expect(h.store.refreshRunnablePolicies({ at })).toEqual({ refreshed: 502, unknown: [] });
    expect(h.store.pendingPolicyCount()).toBe(4);
    const candidates = h.store.candidates({ at, limit: 5 });
    expect(candidates.filter(c => c.lane === "import").map(c => c.id)).toEqual(["old-0", "old-1", "old-2", "old-3", "old-4"]);
    expect(candidates.map(c => c.id)).toContain("ready-retry");
    expect(h.runtime.getJob("terminal-succeeded")!.policyVersion).toBeNull();
    expect(h.store.refreshRunnablePolicies({ at }).refreshed).toBe(0);
    expect(h.store.refreshRunnablePolicies({ at: new Date(now + 1_000).toISOString() }).refreshed).toBe(1);
  });

  it("limits policy preparation to the same runnable targets/types and retry gate", () => {
    const h = harness();
    h.rawJob("inside", "reflection", { target: "selected" });
    h.rawJob("outside", "reflection", { target: "other" });
    h.rawJob("other-type", "episode_title", { target: "selected" });
    h.retry("retry", "selected");
    h.db.db.prepare("UPDATE embedding_retry_queue SET policy_version=NULL WHERE id='retry'").run();
    expect(h.store.refreshRunnablePolicies({ at, targetMemoryIds: ["selected"], allowedJobTypes: ["reflection"], includeRetries: false }).refreshed).toBe(1);
    expect(h.runtime.getJob("outside")!.policyVersion).toBeNull();
    expect(h.runtime.getJob("other-type")!.policyVersion).toBeNull();
    expect(h.runtime.getEmbeddingRetry("retry")!.policyVersion).toBeNull();
    expect(h.store.refreshRunnablePolicies({ at, targetMemoryIds: [], includeRetries: true }).refreshed).toBe(0);
    expect(h.store.refreshRunnablePolicies({ at, allowedJobTypes: [], includeRetries: true }).refreshed).toBe(1);
  });

  it("normalizes valid JSON with malformed metadata shapes so one row cannot poison the runnable set", () => {
    const h = harness(); h.memory("bad-shapes");
    h.db.db.prepare("UPDATE memories SET tags_json=?, properties_json=? WHERE id='bad-shapes'")
      .run('[null,2,"agent-source"]', '{"internal_info":{"plugin_algorithm":42}}');
    h.rawJob("malformed-payload", "embedding", { target: "bad-shapes" });
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json='null' WHERE id='malformed-payload'").run();
    h.rawJob("healthy", "reflection");
    expect(h.store.refreshRunnablePolicies({ at })).toEqual({ refreshed: 2, unknown: [] });
    expect(h.runtime.getJob("malformed-payload")).toMatchObject({ queueLane: "import", policyVersion: JOB_POLICY_VERSION });
    expect(h.ids()).toEqual(["healthy", "malformed-payload"]);
    h.db.db.prepare("UPDATE memories SET tags_json='{}' WHERE id='bad-shapes'").run();
    expect(h.store.refreshRunnablePolicies({ at }).refreshed).toBe(1);
    expect(h.runtime.getJob("malformed-payload")!.queueLane).toBe("interactive");
  });

  it("projects historical origin during dirty runnable refresh and ignores malformed origins", () => {
    const h = harness(); h.memory("native-history"); h.memory("malformed-history");
    h.db.db.prepare("UPDATE memories SET properties_json=? WHERE id='native-history'")
      .run(JSON.stringify({ internal_info: { plugin_algorithm: "capture.v7", capture_origin: "agent_source_scan" } }));
    h.db.db.prepare("UPDATE memories SET properties_json=? WHERE id='malformed-history'")
      .run(JSON.stringify({ internal_info: { plugin_algorithm: "capture.v7", capture_origin: ["agent_source_scan"] } }));
    h.rawJob("raw-native-embedding", "embedding", { target: "native-history" });
    h.rawJob("raw-malformed-summary", "trace_summary", { target: "malformed-history" });
    expect(h.store.refreshRunnablePolicies({ at, includeRetries: false })).toEqual({ refreshed: 2, unknown: [] });
    expect(h.runtime.getJob("raw-native-embedding")).toMatchObject({ queueLane: "import", policyVersion: JOB_POLICY_VERSION });
    expect(h.runtime.getJob("raw-malformed-summary")).toMatchObject({ queueLane: "interactive", policyVersion: JOB_POLICY_VERSION });
  });

  it("exposes unknown jobs only through explicit maintenance quarantine admission", () => {
    const h = harness(); h.rawJob("unknown", "not_registered_yet");
    expect(h.store.refreshRunnablePolicies({ at })).toEqual({ refreshed: 1, unknown: [{ id: "unknown", jobType: "not_registered_yet" }] });
    expect(h.store.candidates({ at, limit: 2 })).toEqual([]);
    expect(h.store.candidates({ at, limit: 2, includeUnregistered: true })).toEqual([
      expect.objectContaining({ id: "unknown", queue: "main", lane: "maintenance", unregistered: true })
    ]);
    expect(h.runtime.getJob("unknown")).toMatchObject({ queueLane: "unregistered", status: "queued", attempts: 0 });
  });
});
