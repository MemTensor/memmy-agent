import { withUnrestrictedScanPermit } from "./fixtures/scan-admission-fixture.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexRollout } from "@memmy/agent-source-core";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import type { SourceAdapter, ConversationMessage } from "../src/agent-source/adapters/types.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { openMemoryAgentSourceScanStore } from "../src/agent-source/scan-store.js";
import { readLegacyScanState } from "../src/agent-source/legacy-state.js";
import type { MemoryService } from "../src/service/memory-service.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const roots: string[] = [];
const executors: ReturnType<typeof createAgentSourceExecutor>[] = [];
const fixture = createMemoryServiceFixture();
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.dispose();
  fixture.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const value = mkdtempSync(join(tmpdir(), "memmy-533-")); roots.push(value); return value; }
function turn(id: string, at = "2026-09-01T10:00:00.000Z"): ConversationMessage[] {
  return ["user", "assistant"].map((role, index) => ({ messageId: `${id}-${role}`, sourceId: "fixture", conversationId: id, role: role as "user" | "assistant", content: index ? "Completed the requested test." : "Please remember the test result.", createdAt: new Date(Date.parse(at) + index * 1000).toISOString(), workspacePath: null, gitRoot: null, rawMeta: {} }));
}
function adapter(messages = turn("one")): SourceAdapter {
  return { descriptor: { sourceId: "fixture", displayName: "Fixture", dataPath: "/fixture", builtin: true }, detect: async () => true, async *scan() { yield* messages; } };
}
function service(overrides: Record<string, unknown> = {}): MemoryService {
  return { withAgentSourceScanPermit: withUnrestrictedScanPermit, addMemory: vi.fn(() => ({ id: "memory-one", duplicate: false })), enqueuePendingImportSummaries: vi.fn(), ...overrides } as unknown as MemoryService;
}
function executor(directory: string, source = adapter(), memory = service(), extra = {}) {
  const result = createAgentSourceExecutor({ service: memory, sourceRegistry: createSourceRegistry([source]), configPath: join(directory, "config.yaml"), statePath: join(directory, "state.json"), scanStoreDirectory: join(directory, "scans"), resolveAgentSkillRoot: () => null, ...extra });
  executors.push(result); return result;
}
async function done(scan: ReturnType<typeof executor>) {
  await vi.waitFor(() => expect(scan.scanStatus().running).toBe(false), { timeout: 5000 });
  return scan.scanStatus();
}
function seedLegacy(path: string, unfinished = false) {
  const db = new Database(path);
  db.exec(`CREATE TABLE account_agent_sources (uuid TEXT, source_id TEXT, builtin INTEGER, last_scanned_at TEXT);
    INSERT INTO account_agent_sources VALUES ('local-agent-sources','fixture',1,'2026-10-01T00:00:00.000Z');
    CREATE TABLE account_agent_source_conversation_checkpoints (uuid TEXT, source_id TEXT);
    INSERT INTO account_agent_source_conversation_checkpoints VALUES ('local-agent-sources','fixture');
    CREATE TABLE account_agent_source_scan_jobs (uuid TEXT, source_id TEXT);`);
  if (unfinished) db.exec("INSERT INTO account_agent_source_scan_jobs VALUES ('local-agent-sources','fixture')");
  db.close();
}

describe("unified scan behavior", () => {
  it("uses the real memory idempotency store when replaying generic history", async () => {
    const { service: memory } = fixture.createTestService();
    const added = vi.spyOn(memory, "addMemory");
    const scan = executor(root(), adapter(), memory);
    await scan.startScan({ sourceId: "all", mode: "full" }); expect((await done(scan)).error).toBeNull();
    await scan.startScan({ sourceId: "all", mode: "full" }); expect((await done(scan)).error).toBeNull();
    expect(added).toHaveBeenCalledTimes(2);
    expect(added.mock.results[0]!.value.id).toBe(added.mock.results[1]!.value.id);
    expect(added.mock.results[1]!.value.duplicate).toBe(true);
  });

  it("keeps legacy data intact, replays incomplete checkpoints and does not remigrate after restart", async () => {
    const directory = root(), legacy = join(directory, "app.sqlite"); seedLegacy(legacy, true);
    const before = readFileSync(legacy);
    expect(readLegacyScanState(legacy)[0]).toMatchObject({ checkpointCount: 1, unfinished: true });
    const scan = executor(directory, adapter(), service(), { legacyDatabasePath: legacy });
    await scan.startScan({ sourceId: "fixture" }); expect((await done(scan)).error).toBeNull();
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    expect(state.legacyRecoveryChecked).toBe(true);
    expect(state.sources.fixture.recoveryPending).toBe(false);
    expect(readFileSync(legacy).equals(before)).toBe(true);
    await scan.dispose();
    const next = executor(directory, adapter(), service(), { legacyDatabasePath: legacy });
    await next.list();
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8"))).toEqual(state);
  });

  it("keeps cleared import progress cleared across restart even when legacy rows remain", async () => {
    const directory = root();
    const legacy = join(directory, "app.sqlite");
    seedLegacy(legacy);
    const scanOptions: Array<Parameters<SourceAdapter["scan"]>[0]> = [];
    const source: SourceAdapter = {
      ...adapter(),
      async *scan(options) {
        scanOptions.push(options);
        yield* turn("one");
      }
    };
    let memoryId = 0;
    const addMemory = vi.fn(() => ({ id: "memory-" + (++memoryId), duplicate: false }));
    const clearAllData = vi.fn(() => ({ ok: true as const, cleared: { memories: 1 }, clearedAt: new Date().toISOString(), serverTime: new Date().toISOString() }));
    const memory = service({ addMemory, clearAllData });
    const first = executor(directory, source, memory, { legacyDatabasePath: legacy });

    await first.list();
    await first.startScan({ sourceId: "fixture", mode: "full" });
    expect((await done(first)).error).toBeNull();
    expect(addMemory).toHaveBeenCalledOnce();
    const oldGeneration = first.scanStatus().version!.generation;

    await first.clearAllData();
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8"))).toMatchObject({
      legacyRecoveryChecked: true,
      sources: { fixture: { messageCount: 0, lastScannedAt: null, latestSeenAt: null } }
    });
    await first.dispose();

    const restarted = executor(directory, source, memory, { legacyDatabasePath: legacy });
    expect(restarted.scanStatus()).toMatchObject({ status: "idle", running: false, version: { generation: oldGeneration + 1 } });
    await restarted.list();
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).sources.fixture).not.toHaveProperty("recoveryPending");
    await restarted.startScan({ sourceId: "fixture" });
    expect((await done(restarted)).error).toBeNull();
    expect(addMemory).toHaveBeenCalledTimes(2);
    expect(scanOptions[1]).toMatchObject({ fullHistory: true, order: "recent_first" });
    expect(scanOptions[1]?.since).toBeUndefined();
  });

  it("does not overwrite newer Memory source state during legacy inspection", async () => {
    const directory = root(), legacy = join(directory, "app.sqlite"); seedLegacy(legacy);
    const source = { status: "not_connected", messageCount: 88, lastScannedAt: "2099-01-01T00:00:00.000Z", latestSeenAt: "2099-01-01T00:00:00.000Z", contentHash: "newer" };
    writeFileSync(join(directory, "state.json"), JSON.stringify({ version: 2, sources: { fixture: source } }));
    await executor(directory, adapter(), service(), { legacyDatabasePath: legacy }).list();
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).sources.fixture).toEqual(source);
  });

  it("preserves native turn identity after a lost response and retries without splitting", async () => {
    const directory = root(), file = join(directory, "rollout.jsonl"), at = "2099-09-09T10:00:00.000Z";
    const event = (type: string, payload: Record<string, unknown>) => ({ type, timestamp: at, payload });
    writeFileSync(file, [event("session_meta", { id: "native-session" }), event("event_msg", { type: "task_started", turn_id: "turn-1" }),
      event("response_item", { type: "message", role: "user", content: [{ text: "Run tests" }] }),
      event("response_item", { type: "custom_tool_call", call_id: "call-1", name: "test", input: "npm test" }),
      event("response_item", { type: "custom_tool_call_output", call_id: "call-1", output: "passed ".repeat(4000) }),
      event("response_item", { type: "message", role: "assistant", content: [{ text: "Tests passed" }] }),
      event("event_msg", { type: "task_complete", turn_id: "turn-1" })].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const complete = vi.fn().mockImplementationOnce(() => { throw new Error("response lost"); }).mockReturnValue({ status: "existing", result: { l1MemoryId: "same-l1", l1MemoryIds: ["same-l1"] } });
    const memory = service({ completeSourceTurn: complete });
    const source = { ...adapter(), descriptor: { ...adapter().descriptor, sourceId: "codex" }, async *scan() { for await (const message of readCodexRollout(file)) yield { ...message, sourceId: "codex", workspacePath: null, gitRoot: null }; } };
    const scan = executor(directory, source, memory);
    await scan.startScan({ sourceId: "codex", mode: "full" }); await done(scan);
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).sources.codex.latestSeenAt).toBeNull();
    await scan.startScan({ sourceId: "codex", mode: "full" }); await done(scan);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0]).toEqual(complete.mock.calls[1]![0]);
    expect(complete.mock.calls[0]![0].toolCalls).toEqual([expect.objectContaining({ id: "call-1", output: "passed ".repeat(4000) })]);
    expect(memory.addMemory).not.toHaveBeenCalled();
  });

  it("completes after durable handoff even with legacy waitForProcessing requests", async () => {
    const worker = vi.fn();
    const processing = vi.fn(() => { throw new Error("model unavailable"); });
    const memory = service({ runWorkerOnce: worker, memoryProcessingStatus: processing });
    const scan = executor(root(), adapter(), memory);
    await scan.startScan({ sourceId: "all", waitForProcessing: true });
    expect((await done(scan)).error).toBeNull();
    expect(memory.enqueuePendingImportSummaries).toHaveBeenCalledWith(1000, ["memory-one"]);
    expect(worker).not.toHaveBeenCalled();
    expect(processing).not.toHaveBeenCalled();
  });

  it("does not advance the watermark when creating background jobs fails", async () => {
    const directory = root();
    const memory = service({ enqueuePendingImportSummaries: () => { throw new Error("queue unavailable"); } });
    const scan = executor(directory, adapter(), memory);
    await scan.startScan({ sourceId: "all" });
    expect((await done(scan)).error).toContain("queue unavailable");
    expect((await scan.list()).sources[0]!.lastScannedAt).toBeNull();
  });

  it("hands off replayed skills without waiting for indexing and preserves immutable provenance", async () => {
    const directory = root();
    mkdirSync(join(directory, "skills", "sample"), { recursive: true });
    writeFileSync(join(directory, "skills", "sample", "SKILL.md"), "---\nname: Sample\nversion: 1\n---\nA sample skill.");
    const reconcile = vi.fn(() => ({ skills: [{ sourceSkillId: "sample", outcome: "unchanged", memoryId: "skill-one" }] }));
    const worker = vi.fn(async () => ({}));
    const memory = service({ reconcileAgentSkills: reconcile, agentSkillsDisconnected: () => false, runWorkerOnce: worker, memoryProcessingStatus: () => ({ items: [{ memoryId: "skill-one", state: "ready" }] }) });
    const scan = executor(directory, adapter([]), memory, { resolveAgentSkillRoot: () => directory });
    await scan.startScan({ sourceId: "fixture", waitForProcessing: true });
    expect((await done(scan)).error).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ sourceAgentId: "fixture", skills: [expect.objectContaining({ sourceSkillId: "sample", version: "1", sourceSkillPath: join(directory, "skills", "sample", "SKILL.md") })] }));
    expect(worker).not.toHaveBeenCalled();
  });

  it("reports a skill write failure without holding back the conversation watermark", async () => {
    const directory = root();
    mkdirSync(join(directory, "skills", "sample"), { recursive: true });
    writeFileSync(join(directory, "skills", "sample", "SKILL.md"), "A sample skill.");
    // Every scan reconciles the whole skill directory, so a failing skill is retried without replaying conversations.
    const reconcile = vi.fn(() => ({ skills: [{ sourceSkillId: "sample", outcome: "failed", error: "skill storage failed" }] }));
    const scan = executor(directory, adapter(), service({ reconcileAgentSkills: reconcile, agentSkillsDisconnected: () => false }), { resolveAgentSkillRoot: () => directory });
    await scan.startScan({ sourceId: "fixture" });
    expect((await done(scan)).error).toContain("skill storage failed");
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).sources.fixture.latestSeenAt).not.toBeNull();
  });

  it("keeps background summary failure separate from scan success", async () => {
    const directory = root();
    const scan = executor(directory, adapter(), service({ runWorkerOnce: async () => ({}), memoryProcessingStatus: () => ({ items: [{ memoryId: "memory-one", state: "failed", errorMessage: "embedding rejected" }] }) }));
    await scan.startScan({ sourceId: "all", waitForProcessing: true });
    expect((await done(scan)).error).toBeNull();
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).sources.fixture.latestSeenAt).not.toBeNull();
  });

  it("restores an interrupted job after restart and lets the user cancel it", async () => {
    const directory = root();
    const store = await openMemoryAgentSourceScanStore(join(directory, "scans", "interrupted.sqlite"), { jobId: "interrupted", sourceId: "fixture", mode: "full", phase: "ingest", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); store.close();
    const scan = executor(directory);
    expect(scan.scanStatus()).toMatchObject({ jobId: "interrupted", progress: { phase: "stopped" } });
    await expect(scan.startScan({ sourceId: "all" })).rejects.toThrow(/recovered/);
    await scan.cancelScan();
    expect(scan.scanStatus()).toMatchObject({ status: "cancelled", jobId: expect.any(String), attemptId: expect.any(String), progress: null });
    await scan.startScan({ sourceId: "all" }); expect((await done(scan)).error).toBeNull();
  });

  it("keeps completed details readable by both desktop and Viewer", async () => {
    const scan = executor(root());
    const { jobId } = await scan.startScan({ sourceId: "all" }); await done(scan);
    const first = await scan.scanResults!(jobId);
    expect(first.items).toHaveLength(1);
    expect(await scan.scanResults!(jobId)).toEqual(first);
    await expect(scan.scanResults!("../other")).rejects.toThrow("Invalid scan job");
  });
});

describe("scan repair regressions", () => {
  it("keeps retries isolated, resolves only successful items, and restores completion", async () => {
    const directory = root();
    let fail = true;
    const memory = service({ addMemory: (input: { requestId: string }) => {
      if (fail) throw new Error("fixture write failure");
      return { id: input.requestId, duplicate: false };
    } });
    const scan = executor(directory, adapter([...turn("one"), ...turn("two")]), memory);
    const first = await scan.startScan({ sourceId: "fixture", mode: "full" });
    expect((await done(scan)).results?.[0]?.errorCount).toBe(2);
    const page = await scan.scanResults!(first.jobId, "0", 1);
    expect(page.nextCursor).not.toBeNull();
    fail = false;
    const second = await scan.startScan({ sourceId: "fixture", mode: "full" });
    expect(second.jobId).toBe(first.jobId);
    expect(second.attemptId).not.toBe(first.attemptId);
    const completed = await done(scan);
    expect(completed.error).toBeNull();
    expect(completed.results?.[0]).toMatchObject({ errorCount: 0, errors: [], memoryIdCount: 2 });
    expect((await scan.scanResults!(first.jobId)).items.every((item) => !item.error)).toBe(true);
    await expect(scan.scanResults!(first.jobId, page.nextCursor!)).rejects.toThrow("attempt changed");
    const db = new Database(join(directory, "scans", `${first.jobId}.sqlite`), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM scan_results WHERE error IS NOT NULL AND active=0").get()).toEqual({ count: 2 });
    db.close();
    await scan.dispose();
    const restored = executor(directory);
    expect(restored.scanStatus()).toMatchObject({ jobId: first.jobId, attemptId: second.attemptId, running: false, error: null, completedAt: expect.any(String) });
  });

  it("never clears another turn's unresolved error in the same conversation", async () => {
    const store = await openMemoryAgentSourceScanStore(join(root(), "scan.sqlite"), { jobId: "retry", sourceId: "fixture", mode: "full", phase: "ingest", createdAt: "2026-10-20", updatedAt: "2026-10-20" });
    try {
      store.beginAttempt("first");
      store.saveResult({ sourceId: "fixture", conversationId: "shared", itemKey: "turn:one", error: "failed one" });
      store.saveResult({ sourceId: "fixture", conversationId: "shared", itemKey: "turn:two", error: "failed two" });
      store.beginAttempt("second");
      expect(store.resultSummary("fixture").errors).toBe(2);
      store.saveResult({ sourceId: "fixture", conversationId: "shared", itemKey: "turn:one", memoryId: "memory-one" });
      expect(store.resultSummary("fixture").errors).toBe(1);
      expect([...store.results("fixture")].filter((item) => item.error)).toMatchObject([{ error: "failed two" }]);
    } finally { store.close(); }
  });

  it("yields during ingestion so pause and cancel run before the full dataset finishes", async () => {
    const directory = root();
    let writes = 0;
    let pauseRequested = false;
    const memory = service({ addMemory: () => {
      if (++writes === 1) setTimeout(() => { pauseRequested = true; void scan.pauseScan(); }, 0);
      return { id: `memory-${writes}`, duplicate: false };
    } });
    const scan = executor(directory, adapter(Array.from({ length: 500 }, (_, i) => turn(String(i))).flat()), memory);
    const first = await scan.startScan({ sourceId: "all", mode: "full" });
    await vi.waitFor(() => expect(pauseRequested && !scan.scanStatus().running).toBe(true));
    expect(writes).toBeLessThan(500);
    expect(scan.scanStatus().progress?.phase).toBe("stopped");
    const resumed = await scan.startScan({ sourceId: "all", mode: "full" });
    expect(resumed.attemptId).toBe(first.attemptId);
    await scan.cancelScan();
    expect(scan.scanStatus()).toMatchObject({ status: "cancelled", jobId: expect.any(String), attemptId: expect.any(String), progress: null });
  });

  it("counts all staged messages, with duplicate skips measured in messages", async () => {
    const scan = executor(root(), adapter(Array.from({ length: 1001 }, (_, i) => turn(String(i))).flat()), service({ addMemory: () => ({ id: "duplicate", duplicate: true }) }));
    await scan.startScan({ sourceId: "fixture", mode: "initial_subset" });
    expect((await done(scan)).results?.[0]).toMatchObject({ emittedMessages: 2002, skipped: 2000 });
  });

  it("persists real background jobs and commits the watermark without running the worker", async () => {
    const { service: memory, db } = fixture.createTestService();
    const worker = vi.spyOn(memory, "runWorkerOnce");
    const directory = root();
    const scan = executor(directory, adapter(), memory);
    await scan.startScan({ sourceId: "fixture", waitForProcessing: true });
    const status = await done(scan);
    expect(status.error).toBeNull();
    const ids = status.results![0]!.memoryIds!;
    expect(memory.memoryProcessingStatus(ids).items[0]?.state).toBe("summary_pending");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type='import_summary'").get()).toEqual({ count: 1 });
    expect(worker).not.toHaveBeenCalled();
    expect((await scan.list()).sources[0]!.lastScannedAt).not.toBeNull();
  });
});

it("ignores a persisted legacy wait flag while recovering the same interrupted attempt", async () => {
  const directory = root();
  const store = await openMemoryAgentSourceScanStore(join(directory, "scans", "legacy.sqlite"), { jobId: "legacy", sourceId: "fixture", mode: "full", phase: "ingest", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" });
  store.beginAttempt("interrupted", "2026-10-20T01:00:00.000Z");
  store.setWaitForProcessing();
  store.close();
  const memory = service({ runWorkerOnce: vi.fn(), memoryProcessingStatus: vi.fn() });
  const scan = executor(directory, adapter(), memory);
  const resumed = await scan.startScan({ sourceId: "fixture", mode: "full", waitForProcessing: true });
  expect(resumed).toMatchObject({ jobId: "legacy", attemptId: "interrupted", attemptStartedAt: "2026-10-20T01:00:00.000Z" });
  expect((await done(scan)).error).toBeNull();
  expect(memory.runWorkerOnce).not.toHaveBeenCalled();
  expect(memory.memoryProcessingStatus).not.toHaveBeenCalled();
});

it("does not hide unresolved errors when the failed source disappears before retry", async () => {
  const source = adapter();
  const scan = executor(root(), source, service({ addMemory: () => { throw new Error("write failed"); } }));
  await scan.startScan({ sourceId: "all", mode: "full" });
  expect((await done(scan)).error).not.toBeNull();
  source.detect = async () => false;
  await scan.startScan({ sourceId: "all", mode: "full" });
  expect((await done(scan)).results?.[0]?.errorCount).toBe(1);
  expect(scan.scanStatus().error).not.toBeNull();
});

it("rolls back Skill capture if its embedding job cannot be created, then retries cleanly", async () => {
  const { service: memory, db } = fixture.createTestService();
  const directory = root();
  mkdirSync(join(directory, "skills", "sample"), { recursive: true });
  writeFileSync(join(directory, "skills", "sample", "SKILL.md"), "# Sample\nRun a sample procedure.");
  db.db.exec("CREATE TRIGGER reject_scan_embedding BEFORE INSERT ON evolution_jobs WHEN NEW.job_type='embedding' BEGIN SELECT RAISE(ABORT, 'queue rejected'); END");
  const scan = executor(directory, adapter([]), memory, { resolveAgentSkillRoot: () => directory });
  await scan.startScan({ sourceId: "fixture" });
  expect((await done(scan)).error).toContain("queue rejected");
  expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_layer='Skill'").get()).toEqual({ count: 0 });
  db.db.exec("DROP TRIGGER reject_scan_embedding");
  await scan.startScan({ sourceId: "fixture" });
  expect((await done(scan)).error).toBeNull();
  expect(db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type='embedding'").get()).toEqual({ count: 1 });
});

it("services pause during preparation before any ingestion and preserves the execution identity", async () => {
  const memory = service();
  const scan = executor(root(), adapter(Array.from({ length: 300 }, (_, i) => turn(String(i))).flat()), memory);
  const started = await scan.startScan({ sourceId: "fixture", mode: "full" });
  let paused = false;
  const timer = setInterval(() => {
    if (!paused && scan.scanStatus().progress?.phase === "prepare") {
      paused = true;
      void scan.pauseScan();
    }
  }, 0);
  try {
    await vi.waitFor(() => expect(paused).toBe(true));
    expect(memory.addMemory).not.toHaveBeenCalled();
    expect(scan.scanStatus()).toMatchObject({ running: false, attemptId: started.attemptId, progress: { phase: "stopped" } });
    await scan.cancelScan();
    expect(scan.scanStatus()).toMatchObject({ status: "cancelled", jobId: expect.any(String), attemptId: expect.any(String), progress: null });
  } finally { clearInterval(timer); }
});

it("does not restart an already failed summary when rescanning identical raw history", async () => {
  const { service: memory, db } = fixture.createTestService();
  const scan = executor(root(), adapter(), memory);
  await scan.startScan({ sourceId: "fixture", mode: "full" });
  const completed = await done(scan);
  const memoryId = completed.results![0]!.memoryIds![0]!;
  db.db.prepare("UPDATE evolution_jobs SET status='failed', last_error='model rejected' WHERE target_memory_id=?").run(memoryId);
  db.db.prepare("UPDATE memory_processing_state SET state='failed', error_message='model rejected', failed_at=? WHERE memory_id=?").run(new Date().toISOString(), memoryId);
  await scan.startScan({ sourceId: "fixture", mode: "full", waitForProcessing: true });
  expect((await done(scan)).error).toBeNull();
  expect(memory.memoryProcessingStatus([memoryId]).items[0]).toMatchObject({ state: "failed", errorMessage: "model rejected" });
  expect(db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs WHERE target_memory_id=?").get(memoryId)).toEqual({ count: 1 });
});

it("returns every error below the shared 500-detail cap", async () => {
  const scan = executor(root(), adapter(Array.from({ length: 101 }, (_, i) => turn(String(i))).flat()), service({ addMemory: () => { throw new Error("write failed"); } }));
  await scan.startScan({ sourceId: "fixture", mode: "full" });
  const result = (await done(scan)).results![0]!;
  expect(result.errorCount).toBe(101);
  expect(result.errors).toHaveLength(101);
  expect(result.detailsTruncated).toBe(false);
});

it("does not turn an infrastructure exception with an empty message into success", async () => {
  const directory = root();
  const scan = executor(directory, adapter(), service({ enqueuePendingImportSummaries: () => { throw new Error(""); } }));
  await scan.startScan({ sourceId: "fixture" });
  const completed = await done(scan);
  expect(completed.error).toBe("Agent source import failed");
  await scan.dispose();
  expect(executor(directory).scanStatus().error).toBe(completed.error);
});
