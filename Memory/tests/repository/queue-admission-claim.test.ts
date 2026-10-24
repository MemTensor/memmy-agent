import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../src/storage/repositories.js";
import { claimFairWorkerBatch, createFairWorkerScan, FAIR_SCAN_CANDIDATE_LIMIT, type FairWorkerScan, type FairClaimedWork } from "../../src/service/worker/fair-worker-queue.js";
import { resolveWorkerSchedulingOptions } from "../../src/service/worker/worker-scheduling-options.js";

const at = "2026-10-22T00:00:00.000Z", now = Date.parse(at);
const resources: Array<{ db: MemoryDb; root: string }> = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-admission-claim-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ db, root });
  const repos = new Repositories(db.db), runtime = repos.runtime;
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "trace_summary", targetMemoryId = id, dedupeKey?: string) {
    return runtime.enqueueJob({ id, jobType, targetMemoryId, dedupeKey, userId: "user", status: "queued", payload: {},
      attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  function retry(id: string) {
    return runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: id, vectorField: "vec_summary", sourceText: id, now });
  }
  function claim(limit: number, admit: (work: FairClaimedWork) => { release(): void } | undefined,
    algorithm: "wrr" | "legacy" = "wrr", priorityCohortOnly = false, scan?: FairWorkerScan) {
    return claimFairWorkerBatch(repos, { at, limit, includeRetries: true, owner: "main", retryOwner: "retry",
      leaseSeconds: 60, retryLeaseMs: 60_000, options: resolveWorkerSchedulingOptions({ algorithm }, {}),
      admit, priorityCohortOnly, scan });
  }
  return { db, repos, runtime, job, retry, claim };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, root } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("atomic resource admission before queue claims", () => {
  it.each(["wrr", "legacy"] as const)("resumes %s scans across bounded slices and still reaches the tail", algorithm => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 551; i++) h.job(`blocked-${i}`);
    h.job("ready", "user_memory_embedding");
    const seen: string[] = [];
    const admit = (work: FairClaimedWork) => {
      const id = work.queue === "main" ? work.job.id : work.retry.id;
      seen.push(id);
      return id === "ready" ? { release() {} } : undefined;
    };
    const work: FairClaimedWork[] = [];
    do {
      work.push(...h.claim(1, admit, algorithm, false, scan));
      expect(scan.inspected).toBeLessThanOrEqual(FAIR_SCAN_CANDIDATE_LIMIT);
    } while (scan.more);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["ready"]);
    expect(new Set(seen).size).toBe(552);
    expect(seen).toHaveLength(552);
    work[0]!.admission!.release();
  });

  it.each(["delete", "ineligible"] as const)("keeps legacy tail reachable when examined rows become %s between slices", change => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 200; i++) h.job(`blocked-${i}`);
    h.job("ready", "user_memory_embedding");
    const seen: string[] = [];
    const admit = (work: FairClaimedWork) => {
      const id = work.queue === "main" ? work.job.id : work.retry.id;
      seen.push(id);
      return id === "ready" ? { release() {} } : undefined;
    };
    expect(h.claim(1, admit, "legacy", false, scan)).toEqual([]);
    if (change === "delete") h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='blocked-0'").run();
    else h.db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE id='blocked-0'").run();
    const work: FairClaimedWork[] = [];
    do { work.push(...h.claim(1, admit, "legacy", false, scan)); } while (scan.more);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["ready"]);
    expect(seen).toHaveLength(201);
    work[0]!.admission!.release();
  });

  it("rechecks new legacy main jobs while continuing a blocked retry scan", () => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 130; i++) h.retry(`blocked-${i}`);
    h.retry("tail-retry");
    const admit = (work: FairClaimedWork) => work.queue === "main" || work.retry.id === "tail-retry" ? { release() {} } : undefined;
    expect(h.claim(1, admit, "legacy", false, scan)).toEqual([]);
    expect(scan.more).toBe(true);
    h.job("new-summary");
    const work = h.claim(1, admit, "legacy", false, scan);
    expect(work.map(item => item.queue === "main" ? item.job.id : item.retry.id)).toEqual(["new-summary"]);
    work[0]!.admission!.release();
  });

  it("uses refreshed lane metadata when a deduped enqueue moves a buffered candidate", () => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 66; i++) h.job(`job-${i}`, "trace_summary", `job-${i}`, `dedupe-${i}`);
    const admit = (work: FairClaimedWork) => work.queue === "main" && Number(work.job.id.split("-")[1]) < 64
      ? undefined : { release() {} };
    expect(h.claim(1, admit, "wrr", false, scan)).toEqual([]);
    const previous = h.runtime.getJob("job-64")!;
    const changed = h.runtime.enqueueJob({ ...previous, id: "new-id", payload: { source: "memory.processing.manual_retry" } });
    expect(changed.queueLane).toBe("repair_retry");
    const work: FairClaimedWork[] = [];
    do { work.push(...h.claim(1, admit, "wrr", false, scan)); } while (!work.length && scan.more);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["job-65"]);
    expect(h.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value).toMatchObject({ cursor: 1 });
    work[0]!.admission!.release();
  });

  it("rewinds the lane heads when a buffered row moves before an already buffered new-lane head", () => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 66; i++) {
      const job = h.job(`job-${i}`, "trace_summary", `job-${i}`, `dedupe-${i}`);
      h.runtime.enqueueJob({ ...job, id: `deduped-${i}`, payload: { source: "memory.processing.manual_retry" } });
    }
    h.job("later-interactive");
    // This case isolates metadata rewinds in an already spent modern round;
    // cursor-only legacy state intentionally gets one upgrade advance instead.
    h.runtime.setKv("worker.scheduler.wrr_cursor.v1", { weightsKey: "4/3/2/2/1", cursor: 4,
      turns: { version: 1, interactive: { spent: true }, lanes: [
        { lane: "repair_retry", remaining: 3 }, { lane: "import", remaining: 2 }, { lane: "evolution", remaining: 2 },
        { lane: "maintenance", remaining: 1 }, { lane: "interactive", remaining: 4 }
      ] } }, at);
    const admit = (work: FairClaimedWork) => work.queue === "main" && Number(work.job.id.split("-")[1]) < 64
      ? undefined : { release() {} };
    expect(h.claim(1, admit, "wrr", false, scan)).toEqual([]);
    h.runtime.enqueueJob({ ...h.runtime.getJob("job-64")!, id: "new-id", payload: { source: "turn.complete.capture" } });
    const work: FairClaimedWork[] = [];
    do { work.push(...h.claim(1, admit, "wrr", false, scan)); } while (!work.length && scan.more);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["job-65"]);
    expect(h.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value).toMatchObject({ cursor: 5 });
    work[0]!.admission!.release();
  });

  it("reconsiders an already examined old sequence moved into another lane", () => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 64; i++) h.job(`interactive-${i}`, "trace_summary", `interactive-${i}`, `dedupe-${i}`);
    for (let i = 0; i < 100; i++) h.job(`repair-${i}`, "decision_repair");
    h.job("maintenance-ready", "episode_idle_close");
    let changed = false;
    const admit = (work: FairClaimedWork) => work.queue === "main" &&
      (work.job.id === "maintenance-ready" || (changed && work.job.id === "interactive-0")) ? { release() {} } : undefined;
    expect(h.claim(1, admit, "wrr", false, scan)).toEqual([]);
    new Repositories(h.db.db).runtime.enqueueJob({ ...h.runtime.getJob("interactive-0")!, id: "deduped", payload: { source: "memory.processing.manual_retry" } });
    changed = true;
    const work: FairClaimedWork[] = [];
    do { work.push(...h.claim(1, admit, "wrr", false, scan)); } while (!work.length && scan.more);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["interactive-0"]);
    work[0]!.admission!.release();
  });

  it("keeps deep keyset progress while new enqueues receive their initial policy", () => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 551; i++) h.job(`blocked-${i}`);
    h.job("ready", "user_memory_embedding");
    const seen: string[] = [], work: FairClaimedWork[] = [];
    const admit = (item: FairClaimedWork) => {
      const id = item.queue === "main" ? item.job.id : item.retry.id;
      seen.push(id);
      return id === "ready" ? { release() {} } : undefined;
    };
    for (let slice = 0; slice < 12 && !work.length; slice++) {
      work.push(...h.claim(1, admit, "wrr", false, scan));
      h.job(`new-${slice}`);
    }
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["ready"]);
    expect(seen).toHaveLength(552);
    expect(new Set(seen).size).toBe(552);
    work[0]!.admission!.release();
  });

  it("revalidates buffered rows by ID-CAS and returns permits for stale candidates", () => {
    const h = harness(), scan = createFairWorkerScan();
    for (let i = 0; i < 100; i++) h.job(`job-${i}`);
    expect(h.claim(1, () => undefined, "wrr", false, scan)).toEqual([]);
    expect(scan.more).toBe(true);
    h.db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE id='job-64'").run();
    const release = vi.fn();
    const work = h.claim(1, () => ({ release }), "wrr", false, scan);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["job-65"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.runtime.getJob("job-64")).toMatchObject({ status: "succeeded", attempts: 0 });
    work[0]!.admission!.release();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("persists unspent model turns while maintenance wraps the compatible legacy cursor", () => {
    const h = harness();
    for (let i = 0; i < 4; i++) { h.job(`import-${i}`, "import_summary"); h.job(`evolution-${i}`, "reflection"); }
    function finish(work: FairClaimedWork[]) {
      for (const item of work) {
        if (item.queue === "main") h.runtime.completeJob(item.job.id, at, item.job);
        item.admission?.release();
      }
    }
    for (let i = 0; i < 2; i++) {
      const work = h.claim(1, () => ({ release() {} }));
      expect(work[0]?.queue === "main" && work[0].job.id).toBe(`import-${i}`);
      finish(work);
    }
    for (let i = 0; i < 10; i++) {
      h.job(`maintenance-${i}`, "episode_idle_close");
      const work = h.claim(1, item => item.queue === "main" && item.job.jobType === "episode_idle_close" ? { release() {} } : undefined);
      expect(work[0]?.queue === "main" && work[0].job.id).toBe(`maintenance-${i}`);
      finish(work);
    }
    const saved = h.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value;
    expect(saved).toMatchObject({ cursor: 0, turns: { version: 1 } });
    const restored = new Repositories(h.db.db);
    const work = claimFairWorkerBatch(restored, { at, limit: 1, includeRetries: true, owner: "restored", retryOwner: "retry",
      leaseSeconds: 60, retryLeaseMs: 60_000, options: resolveWorkerSchedulingOptions({}, {}), admit: () => ({ release() {} }) });
    expect(work[0]?.queue === "main" && work[0].job.id).toBe("evolution-0");
    finish(work);
  });

  it.each([undefined, null, {}, { version: 9, lanes: [] }, { version: 1, lanes: [] }])(
    "accepts old cursor state and ignores malformed optional lane turns: %j", turns => {
      const h = harness(); h.job("import", "import_summary"); h.job("evolution", "reflection");
      h.runtime.setKv("worker.scheduler.wrr_cursor.v1", { weightsKey: "4/3/2/2/1", cursor: 8, turns }, at);
      const work = h.claim(1, () => ({ release() {} }));
      expect(work[0]?.queue === "main" && work[0].job.id).toBe("import");
      expect(h.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value).toMatchObject({ cursor: 9, turns: { version: 1 } });
      work[0]!.admission!.release();
    }
  );

  it("discards turns saved with a different weight configuration", () => {
    const h = harness(); h.job("interactive"); h.job("import", "import_summary");
    h.runtime.setKv("worker.scheduler.wrr_cursor.v1", { weightsKey: "1/1/1/1/1", cursor: 8,
      turns: { version: 1, lanes: ["import", "evolution", "maintenance", "interactive", "repair_retry"]
        .map(lane => ({ lane, remaining: 1 })) } }, at);
    const work = h.claim(1, () => ({ release() {} }));
    expect(work[0]?.queue === "main" && work[0].job.id).toBe("interactive");
    work[0]!.admission!.release();
  });

  it("does not claim, count an attempt or advance WRR when all permits are busy", () => {
    const h = harness(); const before = h.job("busy"); h.retry("retry-busy");
    const admit = vi.fn((_work: FairClaimedWork) => undefined);
    expect(h.claim(2, admit)).toEqual([]);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(h.runtime.getJob("busy")).toEqual(before);
    expect(h.runtime.getEmbeddingRetry("retry-busy")).toMatchObject({ status: "pending", claimedBy: null });
    expect(h.runtime.listKv("worker.scheduler.wrr_cursor")).toEqual([]);
  });

  it("finds a different resource beyond more than five hundred blocked heads in the same lane", () => {
    const h = harness();
    for (let i = 0; i < 551; i++) h.job(`blocked-${i}`);
    const before = h.job("free-embedding", "user_memory_embedding");
    const release = vi.fn();
    const admit = vi.fn((work: FairClaimedWork) => work.queue === "main" && work.job.jobType === "user_memory_embedding" ? { release } : undefined);
    const work = h.claim(1, admit);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["free-embedding"]);
    expect(work[0]?.admission).toBeDefined();
    expect(admit).toHaveBeenCalledTimes(552);
    expect(h.runtime.getJob("blocked-0")).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.runtime.getJob("free-embedding")?.enqueueSeq).toBe(before.enqueueSeq);
    expect(release).not.toHaveBeenCalled();
    work[0]!.admission!.release();
    work[0]!.admission!.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns an acquired permit after main CAS loses and leaves the round intact", () => {
    const h = harness(); h.job("lost-cas");
    vi.spyOn(h.runtime, "claimQueuedJob").mockReturnValueOnce(undefined);
    const release = vi.fn();
    const admit = vi.fn((work: FairClaimedWork) => {
      expect(work.queue === "main" && work.job).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      return { release };
    });
    expect(h.claim(1, admit)).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.runtime.getJob("lost-cas")?.status).toBe("queued");
    expect(h.runtime.listKv("worker.scheduler.wrr_cursor")).toEqual([]);
  });

  it("keeps FIFO across both backing tables while paging past busy resources", () => {
    const h = harness();
    for (let i = 0; i < 401; i++) { h.job(`repair-${i}`, "decision_repair"); h.retry(`blocked-retry-${i}`); }
    h.retry("ready-retry");
    const seen: number[] = [];
    const work = h.claim(1, item => {
      seen.push((item.queue === "main" ? item.job.enqueueSeq : item.retry.enqueueSeq)!);
      return item.queue === "embedding_retry" && item.retry.id === "ready-retry" ? { release() {} } : undefined;
    });
    expect(work.map(item => item.queue === "embedding_retry" && item.retry.id)).toEqual(["ready-retry"]);
    expect(seen).toHaveLength(803);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("returns a retry permit after retry CAS loses", () => {
    const h = harness(); h.retry("lost-cas");
    vi.spyOn(h.runtime, "claimEmbeddingRetryById").mockReturnValueOnce(undefined);
    const release = vi.fn();
    expect(h.claim(1, () => ({ release }))).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.runtime.getEmbeddingRetry("lost-cas")?.status).toBe("pending");
  });

  it("returns every acquired permit and rolls back every claim on a cursor write failure", () => {
    const h = harness(); h.job("one"); h.job("two");
    const releases = [vi.fn(), vi.fn()]; let index = 0;
    vi.spyOn(h.runtime, "setKv").mockImplementation(() => { throw new Error("cursor disk failure"); });
    expect(() => h.claim(2, () => ({ release: releases[index++]! }))).toThrow("cursor disk failure");
    expect(releases.map(release => release.mock.calls.length)).toEqual([1, 1]);
    for (const id of ["one", "two"]) expect(h.runtime.getJob(id)).toMatchObject({ status: "queued", attempts: 0, leaseCount: 0 });
  });

  it("rolls back earlier permits and claims if admission itself throws", () => {
    const h = harness(); h.job("one"); h.job("two");
    const release = vi.fn(); let calls = 0;
    expect(() => h.claim(2, () => {
      if (calls++ > 0) throw new Error("admission failure");
      return { release };
    })).toThrow("admission failure");
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.runtime.getJob("one")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("uses legacy priority order rather than WRR when admission is enabled in rollback mode", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) { h.job(`summary-${i}`); h.job(`repair-${i}`, "decision_repair"); }
    const work = h.claim(5, () => ({ release() {} }), "legacy");
    expect(work.map(item => item.queue === "main" && item.job.jobType)).toEqual(Array(5).fill("trace_summary"));
    expect(h.runtime.listKv("worker.scheduler.wrr_cursor")).toEqual([]);
  });

  it("scans legacy pages past blocked resources and keeps unclaimed retry surplus available", () => {
    const h = harness();
    for (let i = 0; i < 551; i++) h.job(`blocked-${i}`);
    h.job("free-main", "user_memory_embedding"); h.retry("free-retry"); h.retry("surplus");
    const release = vi.fn();
    const work = h.claim(2, item => item.queue === "embedding_retry" || item.job.id === "free-main" ? { release } : undefined, "legacy");
    expect(work.map(item => item.queue === "main" ? item.job.id : item.retry.id)).toEqual(["free-main", "free-retry"]);
    expect(h.runtime.getEmbeddingRetry("surplus")?.status).toBe("pending");
    expect(h.runtime.getJob("blocked-550")?.status).toBe("queued");
  });

  it("does not skip a later legacy page when earlier admitted rows leave the eligible result set", () => {
    const h = harness();
    for (let i = 0; i < 199; i++) h.job(`blocked-before-${i}`);
    h.job("free-one");
    for (let i = 0; i < 201; i++) h.job(`blocked-after-${i}`);
    h.job("free-two");
    const work = h.claim(2, item => item.queue === "main" && item.job.id.startsWith("free-") ? { release() {} } : undefined, "legacy");
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["free-one", "free-two"]);
  });

  it("sets the legacy cohort from its first admitted main job and then uses spare capacity for retry", () => {
    const h = harness(); h.job("blocked-summary"); h.job("free-import", "import_summary"); h.job("other-priority", "reflection"); h.retry("retry");
    const work = h.claim(3, item => item.queue === "main" && item.job.id === "blocked-summary" ? undefined : { release() {} }, "legacy", true);
    expect(work.map(item => item.queue === "main" ? item.job.id : item.retry.id)).toEqual(["free-import", "retry"]);
    expect(h.runtime.getJob("other-priority")?.status).toBe("queued");
    expect(h.runtime.getJob("blocked-summary")?.status).toBe("queued");
  });
});
