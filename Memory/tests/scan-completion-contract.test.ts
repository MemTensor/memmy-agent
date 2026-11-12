import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const executors: ReturnType<typeof createAgentSourceExecutor>[] = [];
afterEach(async () => {
  for (const scan of executors.splice(0)) await scan.dispose();
  vi.restoreAllMocks();
  fixture.cleanup();
});
function setup(scheduleWorker?: () => void) {
  const { root, service, db } = fixture.createTestService();
  const messages: ConversationMessage[] = (["user", "assistant"] as const).map((role, index) => ({
    sourceId: "fixture", conversationId: "conversation", messageId: `message-${index}`, role,
    content: index ? "The task is complete." : "Remember the scan completion contract.",
    createdAt: `2026-10-20T01:00:0${index}.000Z`, workspacePath: null, gitRoot: null, rawMeta: {}
  }));
  const source: SourceAdapter = {
    descriptor: { sourceId: "fixture", displayName: "Fixture", dataPath: root, builtin: true },
    detect: async () => true, async *scan() { yield* messages; }
  };
  const create = () => {
    const scan = createAgentSourceExecutor({
      service, sourceRegistry: createSourceRegistry([source]), configPath: join(root, "config.yaml"),
      statePath: join(root, "state.json"), scanStoreDirectory: join(root, "scans"),
      resolveAgentSkillRoot: () => null, scheduleWorker
    });
    executors.push(scan); return scan;
  };
  const sourceState = () => existsSync(join(root, "state.json"))
    ? JSON.parse(readFileSync(join(root, "state.json"), "utf8")).sources.fixture
    : undefined;
  const checkpointCount = () => {
    const connection = new Database(join(root, "state.json.checkpoints.sqlite"), { readonly: true });
    try { return (connection.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n; }
    finally { connection.close(); }
  };
  return { root, service, db, create, sourceState, checkpointCount };
}
async function finish(scan: ReturnType<typeof createAgentSourceExecutor>) {
  await vi.waitFor(() => expect(scan.scanStatus().completedAt).not.toBeNull(), { timeout: 5000 });
  expect(scan.scanStatus().running).toBe(false);
  return scan.scanStatus();
}

describe("CR-002 durable enqueue defines scan completion", () => {
  it.each(["summary_pending", "summarizing", "embedding", "failed"] as const)(
    "completes with background state %s even for a legacy wait request", async processingState => {
      const f = setup();
      const enqueue = f.service.enqueuePendingImportSummaries.bind(f.service);
      vi.spyOn(f.service, "enqueuePendingImportSummaries").mockImplementation((...args) => {
        const result = enqueue(...args);
        f.db.db.prepare("UPDATE memory_processing_state SET state=?, error_message=?")
          .run(processingState, processingState === "failed" ? "fixture model failure" : null);
        return result;
      });
      const worker = vi.spyOn(f.service, "runWorkerOnce");
      const statusRead = vi.spyOn(f.service, "memoryProcessingStatus");
      const scan = f.create();
      await scan.startScan({ sourceId: "fixture", mode: "full", waitForProcessing: true });
      const completed = await finish(scan);
      expect(completed.error).toBeNull();
      expect(completed.results?.[0]?.errorCount).toBe(0);
      expect(worker).not.toHaveBeenCalled();
      expect(statusRead).not.toHaveBeenCalled();
      expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='import_summary'").get()).toEqual({ n: 1 });
      expect(f.db.db.prepare("SELECT state FROM memory_processing_state").get()).toEqual({ state: processingState });
      expect(f.checkpointCount()).toBe(1);
      expect(f.sourceState().latestSeenAt).toBe("2026-10-20T01:00:01.000Z");
    }
  );

  it("does not wait for an independently scheduled worker that has not finished", async () => {
    let release!: () => void;
    const blockedWorker = new Promise<void>(resolve => { release = resolve; });
    let workerStarted = false, workerFinished = false;
    const scheduled = vi.fn(() => {
      workerStarted = true;
      void blockedWorker.then(() => { workerFinished = true; });
    });
    const f = setup(scheduled);
    try {
      const scan = f.create();
      await scan.startScan({ sourceId: "fixture", mode: "full", waitForProcessing: true });
      expect((await finish(scan)).error).toBeNull();
      expect(workerStarted).toBe(true);
      expect(workerFinished).toBe(false);
      expect(f.checkpointCount()).toBe(1);
    } finally { release(); await blockedWorker; }
  });

  it("does not publish completion when job creation fails, and retries the saved raw memory without duplication", async () => {
    const f = setup();
    f.db.db.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON evolution_jobs WHEN NEW.job_type='import_summary' BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
    const scan = f.create();
    const first = await scan.startScan({ sourceId: "fixture", mode: "full" });
    expect((await finish(scan)).error).toContain("queue unavailable");
    expect(f.checkpointCount()).toBe(0);
    expect(f.sourceState()?.latestSeenAt ?? null).toBeNull();
    expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='import_summary'").get()).toEqual({ n: 0 });
    const raw = f.db.db.prepare("SELECT id FROM memories ORDER BY id").all();
    expect(raw).toHaveLength(1);
    f.db.db.exec("DROP TRIGGER reject_summary");
    const retried = await scan.startScan({ sourceId: "fixture", mode: "full", waitForProcessing: true });
    expect(retried.jobId).toBe(first.jobId);
    expect(retried.attemptId).not.toBe(first.attemptId);
    expect(retried.version!.sequence).toBeGreaterThan(first.version!.sequence);
    expect((await finish(scan)).error).toBeNull();
    expect(f.db.db.prepare("SELECT id FROM memories ORDER BY id").all()).toEqual(raw);
    expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='import_summary'").get()).toEqual({ n: 1 });
    expect(f.checkpointCount()).toBe(1);
    expect(f.sourceState().latestSeenAt).toBe("2026-10-20T01:00:01.000Z");
  });

  it("keeps persisted scan success when a background job fails later and the executor restarts", async () => {
    const f = setup();
    const scan = f.create();
    await scan.startScan({ sourceId: "fixture", mode: "full" });
    const completed = await finish(scan);
    expect(completed.error).toBeNull();
    f.db.db.exec("UPDATE evolution_jobs SET status='failed',last_error='fixture later model failure'");
    f.db.db.exec("UPDATE memory_processing_state SET state='failed',error_message='fixture later model failure'");
    await scan.dispose();
    const restored = f.create();
    expect(restored.scanStatus()).toMatchObject({
      completedAt: completed.completedAt, attemptId: completed.attemptId, error: null, running: false
    });
    expect(restored.scanStatus().version!.generation).toBeGreaterThan(completed.version!.generation);
    expect(restored.scanStatus()).toEqual(restored.scanStatus());
    await restored.startScan({ sourceId: "fixture", mode: "incremental", waitForProcessing: true });
    expect((await finish(restored)).error).toBeNull();
    expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs").get()).toEqual({ n: 1 });
    expect(f.db.db.prepare("SELECT state FROM memory_processing_state").get()).toEqual({ state: "failed" });
  });
});
