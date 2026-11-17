import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeMemoryHttpServer, createMemoryHttpServer } from "../../../src/server/http.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { SqliteVecStore } from "../../../src/storage/sqlite-vec-store.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});

const identity = { provider: "local", model: "capturing-test-embedding" } as const;
const upgradeKey = "embedding-provenance-upgrade:v1";
const memoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);
let compiledDirectory: string;
let compiledReaderUrl: string;
let controlledWorkerUrl: URL;

interface CompiledReader {
  readStats(request: {
    userId: string;
    identity: typeof identity;
    available: boolean;
    knownDimension: number;
  }): Promise<{
    entries: unknown[];
    health: Record<string, unknown>;
    stats: { totalSlots: number; missing: number };
  }>;
  readTargets(request: {
    userId: string;
    identity: typeof identity;
    dimension: number;
    targets: unknown[];
  }): Promise<{ readAt: string; targets: unknown[] }>;
  readUpgradeCandidates(): Promise<unknown[]>;
  stop(): Promise<void>;
}

async function createCompiledReader(
  repos: Repositories,
  sqlitePath: string,
  options: { statsTimeoutMs?: number; businessTimeoutMs?: number; stopGraceMs?: number; workerUrl?: URL } = {}
): Promise<CompiledReader> {
  const compiled = await import(compiledReaderUrl) as {
    EmbeddingMaintenanceReader: new (options: {
      repos: Repositories;
      sqlitePath: string;
      statsTimeoutMs?: number;
      businessTimeoutMs?: number;
      stopGraceMs?: number;
      workerUrl?: URL;
    }) => CompiledReader;
  };
  return new compiled.EmbeddingMaintenanceReader({ repos, sqlitePath, ...options });
}

beforeAll(async () => {
  compiledDirectory = mkdtempSync(join(memoryRoot, ".tmp-embedding-maintenance-reader-"));
  for (const name of ["embedding-maintenance-reader", "embedding-maintenance-reader-worker"]) {
    await build({
      entryPoints: [join(memoryRoot, "src/service/embedding", `${name}.ts`)],
      outfile: join(compiledDirectory, `${name}.js`),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "silent"
    });
  }
  compiledReaderUrl = pathToFileURL(join(compiledDirectory, "embedding-maintenance-reader.js")).href;
  const controlledWorkerPath = join(compiledDirectory, "controlled-reader-worker.js");
  writeFileSync(controlledWorkerPath, `
    import { parentPort } from "node:worker_threads";
    const port = parentPort;
    const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    port.on("message", message => {
      if (message.type === "close") { port.close(); return; }
      const operation = message.operation;
      if (operation.type === "stats" || operation.type === "upgrade-candidates") block();
      const result = operation.type === "stats"
        ? { readAt: new Date().toISOString(), entries: [], health: {}, stats: {
            dimension: 3, available: true, totalSlots: 0, ready: 0, missing: 0,
            dimMismatch: 0, modelMismatch: 0, contentMismatch: 0, needsRepair: 0,
            retryQueue: { pending: 0, active: 0, stale: 0, failed: 0 }
          } }
        : operation.type === "targets"
          ? { readAt: new Date().toISOString(), targets: [] }
          : [];
      port.postMessage({ type: "response", id: message.id, result });
    });
  `);
  controlledWorkerUrl = pathToFileURL(controlledWorkerPath);
});

afterAll(() => {
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
});

describe("embedding maintenance read isolation", () => {
  it("coalesces identical concurrent global statistics reads", async () => {
    const { service } = fixture.createTestService();
    const scan = vi.spyOn(SqliteVecStore.prototype, "maintenanceEntries");

    const results = await Promise.all([
      service.embeddingMaintenanceStats(),
      service.embeddingMaintenanceStats(),
      service.embeddingMaintenanceStats()
    ]);

    expect(results.map(result => result.totalSlots)).toEqual([0, 0, 0]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("does not read maintenance data again after an automatic upgrade is complete", async () => {
    const { service, db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    repos.runtime.setKv(upgradeKey, {
      runId: "embedding_upgrade_completed",
      mode: "repair",
      purpose: "upgrade",
      identity,
      dimension: 3,
      targets: [],
      candidates: [],
      initialized: true,
      createdAt: "2026-10-30T00:00:00.000Z",
      completedAt: "2026-10-30T00:00:01.000Z"
    });
    const globalScan = vi.spyOn(SqliteVecStore.prototype, "maintenanceEntries");
    const targetScan = vi.spyOn(SqliteVecStore.prototype, "maintenanceEntriesForTargets");
    const candidateScan = vi.spyOn(SqliteVecStore.prototype, "provenanceUpgradeEntries");

    await service.runWorkerOnce();
    await service.runWorkerOnce();
    await service.runWorkerOnce();

    expect(globalScan).not.toHaveBeenCalled();
    expect(targetScan).not.toHaveBeenCalled();
    expect(candidateScan).not.toHaveBeenCalled();
  });

  it("keeps the main event loop responsive while compiled production code scans synthetic data", async () => {
    const { db, root, service } = fixture.createTestService();
    const insert = db.db.prepare(`
      INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value,
        tags_json, info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
    `);
    const at = "2026-10-30T00:00:00.000Z";
    db.db.transaction(() => {
      for (let index = 0; index < 60_000; index += 1) {
        insert.run(
          `synthetic-maintenance-${index}`,
          at,
          "local-user",
          "LongTermMemory",
          "activated",
          "private",
          "repeated synthetic maintenance payload",
          "[]",
          "{}",
          '{"internal_info":{"memory_layer":"L2"}}',
          "L2",
          1,
          at,
          at
        );
      }
    })();

    const reader = await createCompiledReader(new Repositories(db.db), db.path);
    const server = createMemoryHttpServer({
      service,
      configPath: join(root, "config.json"),
      workerStartupFallbackMs: 60_000,
      workerPostHealthDelayMs: 60_000
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
    const healthUrl = `http://127.0.0.1:${address.port}/api/v1/health`;
    let ticks = 0;
    let maxDelayMs = 0;
    let previous = performance.now();
    const interval = setInterval(() => {
      const current = performance.now();
      maxDelayMs = Math.max(maxDelayMs, current - previous);
      previous = current;
      ticks += 1;
    }, 5);
    try {
      const request = { userId: "local-user", identity, available: true, knownDimension: 3 };
      const reads = Promise.all([reader.readStats(request), reader.readStats(request)]);
      const healthClient = execFileAsync(process.execPath, ["--input-type=module", "-e", `
        const url = ${JSON.stringify(healthUrl)};
        const samples = [];
        for (let index = 0; index < 20; index += 1) {
          const started = performance.now();
          const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
          if (response.status !== 200) throw new Error(\`health returned \${response.status}\`);
          await response.arrayBuffer();
          samples.push(performance.now() - started);
        }
        console.log(JSON.stringify(samples));
      `]);
      // Let the scan finish first: these are display reads, which stop() is
      // expected to cancel, so their results must be collected before shutdown.
      const [first, second] = await reads;
      const healthSamples = JSON.parse((await healthClient).stdout) as number[];
      const orderedHealth = [...healthSamples].sort((left, right) => left - right);
      const healthP95 = orderedHealth[Math.floor((orderedHealth.length - 1) * 0.95)]!;
      expect(first.stats).toMatchObject({ totalSlots: 60_000, missing: 60_000 });
      expect(second.stats).toEqual(first.stats);
      expect(first.entries).toEqual([]);
      expect(first.health).toEqual({});
      expect(ticks).toBeGreaterThan(2);
      expect(maxDelayMs).toBeLessThan(200);
      expect(healthP95).toBeLessThan(200);
      expect(Math.max(...healthSamples)).toBeLessThan(500);
      const stopped = reader.stop();
      await expect(reader.readStats(request)).rejects.toThrow("stopping");
      await stopped;
    } finally {
      clearInterval(interval);
      await reader.stop();
      await closeMemoryHttpServer(server);
    }
    await expect(reader.readStats({
      userId: "local-user", identity, available: true, knownDimension: 3
    })).rejects.toThrow("stopping");
  }, 20_000);

  it("rejects every shared waiter and enters backoff when the production worker cannot open SQLite", async () => {
    const { db } = fixture.createTestService();
    const reader = await createCompiledReader(new Repositories(db.db), `${db.path}.missing`);
    const request = { userId: "local-user", identity, available: true, knownDimension: 3 };

    const first = reader.readStats(request);
    const second = reader.readStats(request);
    expect(second).toBe(first);
    const settled = await Promise.allSettled([first, second]);
    expect(settled).toHaveLength(2);
    expect(settled.every(result => result.status === "rejected")).toBe(true);
    await expect(reader.readStats(request)).rejects.toThrow();
    await reader.stop();
  });

  it("preempts a running discardable scan when fixed-target progress arrives", async () => {
    const { db } = fixture.createTestService();
    const reader = await createCompiledReader(new Repositories(db.db), db.path, {
      workerUrl: controlledWorkerUrl,
      statsTimeoutMs: 1_000
    });
    const stats = reader.readStats({ userId: "local-user", identity, available: true, knownDimension: 3 });
    void stats.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 25));

    const started = performance.now();
    await expect(reader.readTargets({
      userId: "local-user", identity, dimension: 3, targets: []
    })).resolves.toMatchObject({ targets: [] });
    expect(performance.now() - started).toBeLessThan(200);
    await expect(stats).rejects.toMatchObject({
      name: "EmbeddingMaintenanceReaderCancelled",
      cancelKind: "discardable-stats"
    });
    await reader.stop();
  });

  it("times out a stuck worker, rejects queued work, and enters backoff", async () => {
    const { db } = fixture.createTestService();
    const reader = await createCompiledReader(new Repositories(db.db), db.path, {
      workerUrl: controlledWorkerUrl,
      statsTimeoutMs: 25
    });
    await expect(reader.readStats({
      userId: "local-user", identity, available: true, knownDimension: 3
    })).rejects.toThrow("timed out");
    await expect(reader.readTargets({
      userId: "local-user", identity, dimension: 3, targets: []
    })).rejects.toThrow("timed out");
    await reader.stop();
  });

  it("settles a required read and waits for its worker to exit during forced stop", async () => {
    const { db } = fixture.createTestService();
    const reader = await createCompiledReader(new Repositories(db.db), db.path, {
      workerUrl: controlledWorkerUrl,
      businessTimeoutMs: 1_000,
      stopGraceMs: 25
    });
    const required = reader.readUpgradeCandidates();
    void required.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 25));
    const stopped = reader.stop();
    await expect(required).rejects.toMatchObject({
      name: "EmbeddingMaintenanceReaderCancelled",
      cancelKind: "business-required"
    });
    await expect(stopped).resolves.toBeUndefined();
  });
});
