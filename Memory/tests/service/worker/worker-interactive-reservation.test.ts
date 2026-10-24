import { describe, expect, it } from "vitest";
import { WorkerConcurrencyController, type WorkerPermit, type WorkerRequirements } from "../../../src/service/worker/worker-concurrency.js";

const requirements = (queueLane?: string, extra: Partial<WorkerRequirements> = {}): WorkerRequirements =>
  ({ resourceClass: "summary", providers: [], scopeKeys: [], queueLane, ...extra });

describe("interactive global slot reservation", () => {
  it("leaves one global slot for interactive work when background jobs remain blocked", async () => {
    const c = new WorkerConcurrencyController({}, {});
    const background = Array.from({ length: 3 }, () => c.tryAcquire(requirements("import"))!);
    const before = c.snapshot();
    const denied = c.tryAcquire(requirements("maintenance", {
      providers: [{ key: "must-not-reserve", limit: 1 }], scopeKeys: ["must-not-reserve"]
    }));
    let interactive: WorkerPermit | undefined;
    try {
      expect(background.every(Boolean)).toBe(true);
      expect(denied).toBeUndefined();
      expect(c.snapshot()).toEqual(before);
      interactive = c.tryAcquire(requirements("interactive"))!;
      expect(interactive).toBeDefined();
      expect(c.snapshot()).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3 });
      expect(c.tryAcquire(requirements("interactive"))).toBeUndefined();
      interactive.release();
      expect(c.tryAcquire(requirements("import"))).toBeUndefined();
    } finally {
      interactive?.release(); denied?.release(); background.forEach(p => p?.release());
    }
    expect(c.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0 });
    await c.close();
  });

  it.each([undefined, "unregistered", "repair_retry", "evolution", "maintenance"])("treats lane %s as background", lane => {
    const c = new WorkerConcurrencyController({}, {});
    const p = c.tryAcquire(requirements("import"), 3)!;
    expect(c.tryAcquire(requirements(lane))).toBeUndefined();
    p.release(); p.release();
    const next = c.tryAcquire(requirements(lane))!;
    expect(next).toBeDefined(); next.release();
    expect(c.snapshot().backgroundActiveJobs).toBe(0);
  });

  it("allows interactive jobs to use all global slots", () => {
    const c = new WorkerConcurrencyController({}, {});
    const p = c.tryAcquire(requirements("interactive"), 4)!;
    expect(p).toBeDefined(); expect(c.availableJobs()).toBe(0);
    expect(c.snapshot().backgroundActiveJobs).toBe(0); p.release();
  });

  it.each([1, 2, 4, 8])("retains background progress at global limit %s", limit => {
    const c = new WorkerConcurrencyController({ maxActiveJobs: limit, resourceLimits: { summary: limit } }, {});
    const backgroundLimit = Math.max(1, limit - 1);
    const p = c.tryAcquire(requirements("import"), backgroundLimit)!;
    expect(p).toBeDefined(); expect(c.tryAcquire(requirements("import"))).toBeUndefined();
    expect(c.limits.maxBackgroundJobs).toBe(backgroundLimit);
    expect(c.limits.interactiveReservedSlots).toBe(limit === 1 ? 0 : 1);
    p.release();
  });

  it("charges mixed embedding group members individually and cannot borrow interactive privilege", () => {
    const c = new WorkerConcurrencyController({}, {});
    const extra = { resourceClass: "embedding" as const, embedding: true, providers: [{ key: "model", limit: 1 }] };
    const a = c.tryAcquire(requirements("interactive", extra))!;
    const b = c.tryAcquire(requirements("import", extra), 3, a)!;
    expect(b).toBeDefined();
    a.release();
    expect(c.snapshot()).toMatchObject({ activeJobs: 3, backgroundActiveJobs: 3, embeddingRequests: 1 });
    expect(c.tryAcquire(requirements("import", extra), 1, b)).toBeUndefined();
    const d = c.tryAcquire(requirements("interactive", extra), 1, b)!;
    expect(d).toBeDefined();
    b.release(); b.release(); d.release();
    expect(c.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0, embeddingRequests: 0, providers: {} });
  });

  it("does not bypass provider limits to use the reserved slot", () => {
    const c = new WorkerConcurrencyController({}, {});
    const p = c.tryAcquire(requirements("import", { providers: [{ key: "local", limit: 1 }] }))!;
    expect(c.tryAcquire(requirements("interactive", { providers: [{ key: "local", limit: 1 }] }))).toBeUndefined();
    p.release();
    const next = c.tryAcquire(requirements("interactive", { providers: [{ key: "local", limit: 1 }] }))!;
    expect(next).toBeDefined(); next.release();
  });

  it("keeps foreground requests independent from logical global reservation", async () => {
    const c = new WorkerConcurrencyController({}, {});
    const p = c.tryAcquire(requirements("import"), 3)!;
    expect(await c.runRequest({ providers: [{ key: "foreground", limit: 1 }], local: true }, async () => "done")).toBe("done");
    expect(c.snapshot()).toMatchObject({ activeJobs: 3, backgroundActiveJobs: 3, providers: {} });
    p.release(); await c.close();
  });
});
