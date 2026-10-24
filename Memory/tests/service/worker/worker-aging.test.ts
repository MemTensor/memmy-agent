import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { claimFairWorkerBatch, type FairClaimedWork } from "../../../src/service/worker/fair-worker-queue.js";
import { resolveWorkerSchedulingOptions } from "../../../src/service/worker/worker-scheduling-options.js";
import { QUEUE_LANES } from "../../../src/service/worker/job-policy-registry.js";
import { DEFAULT_LANE_WEIGHTS } from "../../../src/service/worker/lane-queue-selector.js";

const at = "2026-10-23T00:00:00.000Z", now = Date.parse(at);
const roots: Array<{ root: string; db: MemoryDb }> = [];
const types = { interactive: "trace_summary", repair_retry: "decision_repair", import: "import_summary",
  evolution: "reflection", maintenance: "episode_idle_close" } as const;
function harness() {
  const root = mkdtempSync(join(tmpdir(), "worker-aging-")), db = new MemoryDb({ path: join(root, "memory.sqlite") });
  roots.push({ root, db });
  const repos = new Repositories(db.db);
  function job(id: string, type: EvolutionJobRecord["jobType"], ageMs = 0) {
    repos.runtime.enqueueJob({ id, jobType: type, targetMemoryId: id, userId: "aging", payload: {},
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    db.db.prepare("UPDATE evolution_jobs SET first_queued_at=? WHERE id=?").run(new Date(now - ageMs).toISOString(), id);
  }
  function claim(admit: (work: FairClaimedWork) => { release(): void } | undefined = () => ({ release() {} }), algorithm: "wrr" | "legacy" = "wrr") {
    return claimFairWorkerBatch(repos, { at, limit: 1, includeRetries: true, owner: "aging-worker", retryOwner: "aging-retry",
      leaseSeconds: 60, retryLeaseMs: 60_000, options: resolveWorkerSchedulingOptions({ algorithm }, {}), admit });
  }
  function finish(work: FairClaimedWork[]) {
    for (const item of work) { if (item.queue === "main") repos.runtime.completeJob(item.job.id, at, item.job); item.admission?.release(); }
  }
  return { root, db, repos, job, claim, finish };
}
afterEach(() => { vi.restoreAllMocks(); for (const { root, db } of roots.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); } });

describe("bounded runnable queue aging", () => {
  it("advances one overdue FIFO lane head at the configured five-minute threshold", () => {
    const h = harness(); h.job("current", "decision_repair"); h.job("old", "reflection", 300_000);
    const work = h.claim();
    expect(work[0]?.queue === "main" && work[0].job.id).toBe("old"); h.finish(work);
    expect(work[0]?.selectionReason).toBe("aging");
  });

  it("does not age a task before the threshold or replace lane FIFO by timestamp ordering", () => {
    const h = harness(); h.job("current", "decision_repair"); h.job("head", "reflection", 299_999); h.job("older-tail", "reflection", 900_000);
    const first = h.claim(); expect(first[0]?.queue === "main" && first[0].job.id).toBe("current"); h.finish(first);
    const second = h.claim(); expect(second[0]?.queue === "main" && second[0].job.id).toBe("head"); h.finish(second);
  });

  it("reorders at most one assigned ticket per complete round and retains the 4/3/2/2/1 shares", () => {
    const h = harness();
    for (const lane of QUEUE_LANES) for (let i = 0; i < 20; i++) h.job(`${lane}-${i}`, types[lane], lane === "maintenance" ? 900_000 : 400_000);
    const sequence: string[] = [];
    for (let i = 0; i < 24; i++) { const work = h.claim(); sequence.push(work[0]!.queue === "main" ? work[0]!.job.queueLane! : "repair_retry"); h.finish(work); }
    expect(sequence[4]).toBe("maintenance"); expect(sequence[16]).toBe("maintenance");
    for (const chunk of [sequence.slice(0, 12), sequence.slice(12)]) {
      expect(Object.fromEntries(QUEUE_LANES.map(lane => [lane, chunk.filter(item => item === lane).length]))).toEqual(DEFAULT_LANE_WEIGHTS);
      expect(chunk.slice(0, 4)).toEqual(Array(4).fill("interactive"));
    }
  });

  it("spends neither the aging opportunity nor a lane ticket when the old candidate cannot acquire a permit", () => {
    const h = harness(); h.job("current", "decision_repair"); h.job("old", "reflection", 900_000);
    const first = h.claim(work => work.queue === "main" && work.job.id === "old" ? undefined : { release() {} });
    expect(first[0]?.queue === "main" && first[0].job.id).toBe("current"); h.finish(first);
    expect(h.repos.runtime.getJob("old")).toMatchObject({ status: "queued", attempts: 0 });
    const second = h.claim(); expect(second[0]?.queue === "main" && second[0].job.id).toBe("old"); h.finish(second);
  });

  it("retains the aging opportunity when the promoted candidate loses its lease CAS", () => {
    const h = harness(); h.job("current", "decision_repair"); h.job("old", "reflection", 900_000);
    const original = h.repos.runtime.claimQueuedJob.bind(h.repos.runtime);
    vi.spyOn(h.repos.runtime, "claimQueuedJob").mockImplementationOnce(() => undefined).mockImplementation(original);
    const first = h.claim(); expect(first[0]?.queue === "main" && first[0].job.id).toBe("current"); h.finish(first);
    const second = h.claim(); expect(second[0]?.queue === "main" && second[0].job.id).toBe("old"); h.finish(second);
  });

  it("persists the used promotion across a reconstructed repository and does not spend it twice", () => {
    const h = harness(); h.job("current", "decision_repair"); h.job("old-0", "reflection", 900_000); h.job("old-1", "reflection", 900_000);
    const first = h.claim(); expect(first[0]?.queue === "main" && first[0].job.id).toBe("old-0"); h.finish(first);
    const restored = new Repositories(h.db.db);
    const second = claimFairWorkerBatch(restored, { at, limit: 1, includeRetries: true, owner: "restarted", retryOwner: "retry",
      leaseSeconds: 60, retryLeaseMs: 60_000, options: resolveWorkerSchedulingOptions({}, {}), admit: () => ({ release() {} }) });
    expect(second[0]?.queue === "main" && second[0].job.id).toBe("current"); h.finish(second);
  });

  it.each(["future", "configuration"] as const)("does not promote a %s-blocked old task", reason => {
    const h = harness(); h.job("current", "decision_repair"); h.job("old", "reflection", 900_000);
    if (reason === "future") h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='old'").run(new Date(now + 1).toISOString());
    else h.db.db.prepare("UPDATE evolution_jobs SET blocked_reason='configuration' WHERE id='old'").run();
    const work = h.claim(); expect(work[0]?.queue === "main" && work[0].job.id).toBe("current"); h.finish(work);
    expect(h.repos.runtime.getJob("old")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("includes the oldest independent embedding retry in the same bounded aging policy", () => {
    const h = harness(); h.job("current", "reflection");
    h.repos.runtime.enqueueEmbeddingRetry({ id: "old-retry", targetKind: "trace", targetId: "target", vectorField: "vec_summary",
      sourceText: "synthetic", now: now - 900_000 });
    h.db.db.prepare("UPDATE embedding_retry_queue SET first_queued_at=? WHERE id='old-retry'").run(new Date(now - 900_000).toISOString());
    const work = h.claim(); expect(work[0]?.queue === "embedding_retry" && work[0].retry.id).toBe("old-retry"); h.finish(work);
  });

  it("rolls both the promoted claim and the used opportunity back on KV failure", () => {
    const h = harness(); h.job("current", "decision_repair"); h.job("old", "reflection", 900_000);
    vi.spyOn(h.repos.runtime, "setKv").mockImplementationOnce(() => { throw new Error("disk failed"); });
    expect(() => h.claim()).toThrow("disk failed");
    expect(h.repos.runtime.getJob("old")).toMatchObject({ status: "queued", attempts: 0 });
    const work = h.claim(); expect(work[0]?.queue === "main" && work[0].job.id).toBe("old"); h.finish(work);
  });

  it("does not enable aging in the explicit legacy rollback", () => {
    const h = harness(); h.job("current", "trace_summary"); h.job("old", "reflection", 900_000);
    const work = h.claim(undefined, "legacy"); expect(work[0]?.queue === "main" && work[0].job.id).toBe("current"); h.finish(work);
    expect(work[0]?.selectionReason).toBe("legacy");
  });

  it("honors explicit aging disable and resets saved aging state when weights change", () => {
    const h = harness(); h.job("current", "decision_repair"); h.job("old-0", "reflection", 900_000); h.job("old-1", "reflection", 900_000);
    const first = h.claim(); expect(first[0]?.queue === "main" && first[0].job.id).toBe("old-0"); h.finish(first);
    const disabled = claimFairWorkerBatch(h.repos, { at, limit: 1, includeRetries: true, owner: "disabled", retryOwner: "retry",
      leaseSeconds: 60, retryLeaseMs: 60_000, options: resolveWorkerSchedulingOptions({ aging: { enabled: false } }, {}),
      admit: () => ({ release() {} }) });
    expect(disabled[0]?.queue === "main" && disabled[0].job.id).toBe("current"); h.finish(disabled);
    h.job("new-current", "decision_repair");
    const changed = claimFairWorkerBatch(h.repos, { at, limit: 1, includeRetries: true, owner: "changed", retryOwner: "retry",
      leaseSeconds: 60, retryLeaseMs: 60_000, options: resolveWorkerSchedulingOptions({ laneWeights: { ...DEFAULT_LANE_WEIGHTS, interactive: 5 } }, {}),
      admit: () => ({ release() {} }) });
    expect(changed[0]?.queue === "main" && changed[0].job.id).toBe("old-1"); h.finish(changed);
  });
});
