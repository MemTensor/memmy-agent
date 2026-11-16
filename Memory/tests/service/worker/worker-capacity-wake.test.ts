import { describe, expect, it, vi } from "vitest";
import { WorkerConcurrencyController, workerCapacityKey, type WorkerConcurrencyOptions, type WorkerRequirements } from "../../../src/service/worker/worker-concurrency.js";
import { WorkerAdmissionWaitSet } from "../../../src/service/worker/worker-admission-wait-set.js";
import type { SchedulingCandidate } from "../../../src/storage/queue-scheduling-store.js";

const requirements = (changes: Partial<WorkerRequirements> = {}): WorkerRequirements => ({
  resourceClass: "summary", providers: [], scopeKeys: [], queueLane: "interactive", ...changes
});

describe("resource-specific worker wakeups", () => {
  it.each([
    { kind: "global", jobs: 4 },
    { kind: "background", jobs: 3, held: { queueLane: "import" }, waiting: { queueLane: "import" } },
    { kind: "resource", key: "summary", options: { resourceLimits: { summary: 1 } } },
    { kind: "scope", key: "same-target", held: { scopeKeys: ["same-target"] }, waiting: { scopeKeys: ["same-target"] } },
    { kind: "embedding_request", held: { resourceClass: "embedding", embedding: true }, waiting: { resourceClass: "embedding", embedding: true } },
    { kind: "provider", key: "A", held: { providers: [{ key: "A", limit: 1 }] }, waiting: { providers: [{ key: "A", limit: 1 }, { key: "B", limit: 1 }] } }
  ] satisfies Array<{ kind: Parameters<typeof workerCapacityKey>[0]; key?: string; jobs?: number;
    options?: WorkerConcurrencyOptions; held?: Partial<WorkerRequirements>; waiting?: Partial<WorkerRequirements> }>)
  ("wakes only on the actual released $kind capacity", async row => {
    const spec: { kind: Parameters<typeof workerCapacityKey>[0]; key?: string; jobs?: number;
      options?: WorkerConcurrencyOptions; held?: Partial<WorkerRequirements>; waiting?: Partial<WorkerRequirements> } = row;
    const c = new WorkerConcurrencyController(spec.options, {});
    const held = c.tryAcquire(requirements(spec.held), spec.jobs ?? 1)!;
    const releases: string[][] = [];
    const unsubscribe = c.subscribe(keys => releases.push([...keys]));
    const blocked: string[] = [];
    const before = c.snapshot();
    expect(c.tryAcquire(requirements(spec.waiting), 1, undefined, key => blocked.push(key))).toBeUndefined();
    expect(blocked).toEqual([workerCapacityKey(spec.kind, spec.key)]);
    expect(c.snapshot()).toEqual(before); // No partial permit, including Provider B.
    await c.runRequest({ local: false, providers: [{ key: "unrelated", limit: 1 }] }, async () => {});
    expect(releases.flat()).not.toContain(blocked[0]);
    held.release();
    expect(releases.at(-1)).toContain(blocked[0]);
    const permit = c.tryAcquire(requirements(spec.waiting));
    expect(permit).toBeDefined();
    permit!.release();
    expect(c.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0, providers: {}, scopeKeys: [], embeddingRequests: 0 });
    unsubscribe(); await c.close();
  });

  it("does not announce a shared Provider or Embedding slot before its last active request ends", async () => {
    const c = new WorkerConcurrencyController({}, {});
    const descriptor = { local: false, providers: [{ key: "embedding-model", limit: 1 }] };
    const req = requirements({ resourceClass: "embedding", embedding: true, providers: descriptor.providers });
    const first = c.tryAcquire(req)!, second = c.tryAcquire(req, 1, first)!;
    const releases: string[][] = [];
    c.subscribe(keys => releases.push([...keys]));
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const running = first.run(() => c.runRequest(descriptor, async () => { started(); await gate; }, true));
    try {
      await entered;
      first.release(); second.release();
      expect(releases.flat()).not.toContain(workerCapacityKey("provider", "embedding-model"));
      expect(releases.flat()).not.toContain(workerCapacityKey("embedding_request"));
      expect(c.tryAcquire(req)).toBeUndefined();
    } finally { finish(); await running; first.release(); second.release(); }
    expect(releases.at(-1)).toEqual(expect.arrayContaining([
      workerCapacityKey("provider", "embedding-model"), workerCapacityKey("embedding_request")
    ]));
    await c.close();
  });

  it("bounds stale-head cleanup across many resources and continues it on later fills", () => {
    const waiting = new WorkerAdmissionWaitSet();
    for (let i = 0; i < 200; i++) waiting.park({ id: `job-${i}`, queue: "main", jobType: "trace_summary",
      lane: "import", enqueueSeq: i + 1, basePriority: 2 }, `provider-${i}`);
    const pending = vi.fn(() => true);
    waiting.pruneHeads(pending, 64);
    expect(pending).toHaveBeenCalledTimes(64);
    pending.mockImplementation(() => false);
    for (let i = 0; i < 6; i++) {
      pending.mockClear(); waiting.pruneHeads(pending, 64);
      expect(pending.mock.calls.length).toBeLessThanOrEqual(64);
    }
    expect(waiting.size).toBe(0);
    expect(waiting.release(["provider-0"])).toEqual(new Set());
  });

  it("merges reawakened main and retry rows by their original FIFO sequence, including repeated blocking", () => {
    const waiting = new WorkerAdmissionWaitSet();
    const candidates: SchedulingCandidate[] = Array.from({ length: 257 }, (_, i) => ({
      id: `job-${i}`, queue: i % 2 ? "main" : "embedding_retry", jobType: "embedding", lane: "import",
      enqueueSeq: i + 1, basePriority: 2, firstQueuedAt: "2000-01-01T00:00:00.000Z"
    }));
    // A permutation forces out-of-order insertion, as when a second limiter blocks a woken row.
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[(i * 31) % candidates.length]!;
      waiting.park(candidate, candidate.enqueueSeq % 2 ? "A" : "B");
    }
    expect(waiting.heads()).toEqual([]);
    expect(waiting.release(["unrelated"]).size).toBe(0);
    expect(waiting.release(["A"])).toEqual(new Set(["import"]));
    const oldest = waiting.heads()[0]!;
    expect(oldest.enqueueSeq).toBe(1);
    waiting.take(oldest); waiting.park(oldest, "C");
    expect(waiting.isBlocked(oldest)).toBe(true);
    waiting.release(["B", "C"]);
    const order: number[] = [];
    while (waiting.heads().length) {
      const candidate = waiting.heads()[0]!;
      order.push(candidate.enqueueSeq); waiting.take(candidate);
    }
    expect(order).toEqual(candidates.map(candidate => candidate.enqueueSeq));
    expect(waiting.size).toBe(0);
  });
});
