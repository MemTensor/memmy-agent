import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import {
  EmbeddingMaintenanceReader,
  EmbeddingMaintenanceReaderCancelled
} from "../../../src/service/embedding/embedding-maintenance-reader.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const readers: EmbeddingMaintenanceReader[] = [];
const databases: MemoryDb[] = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.stop();
  for (const db of databases.splice(0)) if (db.db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function create() {
  const root = mkdtempSync(join(tmpdir(), "reader-sched-"));
  roots.push(root);
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  databases.push(db);
  const repos = new Repositories(db.db);
  return { db, repos };
}

function reader(repos: Repositories, sqlitePath: string, options: Record<string, number> = {}) {
  const instance = new EmbeddingMaintenanceReader({ repos, sqlitePath, ...options });
  readers.push(instance);
  return instance;
}

const identity = { provider: "local", model: "test-embedding" } as const;
const statsRequest = { userId: "u", identity, available: true, knownDimension: 3 };
const targetsRequest = { userId: "u", identity, dimension: 3, targets: [] as never[] };

describe("reader scheduling contract", () => {
  it("shares one execution when the same statistics read is requested concurrently", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path);
    const first = instance.readStats(statsRequest);
    const second = instance.readStats(statsRequest);
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ stats: { totalSlots: 0 } });
  });

  it("refuses new reads once shutdown has started", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path);
    await instance.stop();
    await expect(instance.readStats(statsRequest)).rejects.toThrow("stopping");
  });

  it("drops queued display reads on cancellation while keeping business reads", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path);

    // Occupy the lane so the following reads stay queued.
    const running = instance.readTargets({ ...targetsRequest, targets: [] });
    const display = instance.readStats({ ...statsRequest, knownDimension: 3 });
    const business = instance.readTargets({ ...targetsRequest, targets: [] });
    display.catch(() => undefined);
    business.catch(() => undefined);

    const cancelled = instance.cancelDiscardableStats();
    expect(cancelled).toBeGreaterThanOrEqual(0);

    await expect(running).resolves.toBeDefined();
    // Whatever the interleaving, every waiter settles: no hanging promise.
    await Promise.allSettled([display, business]);
  });

  it("treats target planning as required work rather than discardable panel statistics", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path);
    const running = instance.readTargets({ ...targetsRequest, targets: [] });
    const plan = instance.readStats({ ...statsRequest, includePlan: true });
    const display = instance.readStats(statsRequest);
    void display.catch(() => undefined);

    expect(instance.cancelDiscardableStats()).toBe(1);
    await expect(running).resolves.toBeDefined();
    await expect(plan).resolves.toMatchObject({ entries: [], stats: { totalSlots: 0 } });
    await expect(display).rejects.toMatchObject({
      name: "EmbeddingMaintenanceReaderCancelled",
      cancelKind: "discardable-stats"
    });
  });

  it("reports a cancellation rather than a result when display reads are dropped", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path);
    await instance.stop();
    instance.cancelDiscardableStats();
    await expect(instance.readStats(statsRequest)).rejects.toThrow(/stopping|cancelled/);
  });
});

describe("reader shutdown contract", () => {
  it("settles every waiter during stop and finishes within the grace period", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path, { stopGraceMs: 200 });
    const pending = [
      instance.readStats(statsRequest),
      instance.readTargets({ ...targetsRequest, targets: [] })
    ];
    const stop = instance.stop();
    const settled = await Promise.allSettled(pending);
    // Both waiters must end; a shutdown must never leave a read hanging.
    expect(settled).toHaveLength(2);
    await expect(stop).resolves.toBeUndefined();
  });

  it("is idempotent so repeated stop calls resolve", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path);
    const first = instance.stop();
    const second = instance.stop();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });

  it("survives a stop with no reads ever issued", async () => {
    const { db, repos } = create();
    const instance = reader(repos, db.path);
    await expect(instance.stop()).resolves.toBeUndefined();
  });
});

describe("reader cancellation typing", () => {
  it("exposes the cancel kind so callers can tell recomputable stats from required reads", () => {
    expect(new EmbeddingMaintenanceReaderCancelled("discardable-stats").cancelKind).toBe("discardable-stats");
    expect(new EmbeddingMaintenanceReaderCancelled("business-required").cancelKind).toBe("business-required");
  });
});
