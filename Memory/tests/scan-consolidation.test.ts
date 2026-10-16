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
  return { addMemory: vi.fn(() => ({ id: "memory-one", duplicate: false })), enqueuePendingImportSummaries: vi.fn(), ...overrides } as unknown as MemoryService;
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

  it("waits for only the imported generic cohort before declaring desktop completion", async () => {
    const directory = root(); let release!: () => void;
    const worker = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const memory = service({ runWorkerOnce: worker, memoryProcessingStatus: (ids: string[]) => ({ items: ids.map((memoryId) => ({ memoryId, state: "ready" })) }) });
    const scan = executor(directory, adapter(), memory);
    await scan.startScan({ sourceId: "all", waitForProcessing: true });
    await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
    expect(scan.scanStatus().running).toBe(true);
    expect(worker.mock.calls[0]).toEqual([1, { targetMemoryIds: ["memory-one"], priorityCohortOnly: true }]);
    release(); expect((await done(scan)).error).toBeNull();
  });

  it("cancels scanning promptly while an already-started summary worker finishes in the background", async () => {
    let release!: () => void;
    const worker = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const scan = executor(root(), adapter(), service({ runWorkerOnce: worker, memoryProcessingStatus: () => ({ items: [{ memoryId: "memory-one", state: "summarizing" }] }) }));
    try {
      await scan.startScan({ sourceId: "all", waitForProcessing: true });
      await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
      await scan.cancelScan();
      expect(scan.scanStatus().jobId).toBeNull();
      await scan.startScan({ sourceId: "all" });
      expect((await done(scan)).error).toBeNull();
    } finally { release?.(); }
  });

  it("includes replayed skills in targeted processing and preserves immutable provenance", async () => {
    const directory = root();
    mkdirSync(join(directory, "skills", "sample"), { recursive: true });
    writeFileSync(join(directory, "skills", "sample", "SKILL.md"), "---\nname: Sample\nversion: 1\n---\nA sample skill.");
    const add = vi.fn(() => ({ id: "skill-one", duplicate: true }));
    const worker = vi.fn(async () => ({}));
    const memory = service({ addMemory: add, runWorkerOnce: worker, memoryProcessingStatus: () => ({ items: [{ memoryId: "skill-one", state: "ready" }] }) });
    const scan = executor(directory, adapter([]), memory, { resolveAgentSkillRoot: () => directory });
    await scan.startScan({ sourceId: "fixture", waitForProcessing: true });
    expect((await done(scan)).error).toBeNull();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ layer: "Skill", sourceAgentId: "fixture", sourceSkillId: "sample", sourceSkillVersion: "1", sourceSkillPath: join(directory, "skills", "sample", "SKILL.md") }));
    expect(worker).toHaveBeenCalledWith(1, { targetMemoryIds: ["skill-one"], priorityCohortOnly: true });
  });

  it("reports a skill write failure instead of advancing the scan watermark", async () => {
    const directory = root();
    mkdirSync(join(directory, "skills", "sample"), { recursive: true });
    writeFileSync(join(directory, "skills", "sample", "SKILL.md"), "A sample skill.");
    const add = vi.fn((input: { layer: string }) => { if (input.layer === "Skill") throw new Error("skill storage failed"); return { id: "memory-one", duplicate: false }; });
    const scan = executor(directory, adapter(), service({ addMemory: add }), { resolveAgentSkillRoot: () => directory });
    await scan.startScan({ sourceId: "fixture" });
    expect((await done(scan)).error).toContain("skill storage failed");
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).sources.fixture.latestSeenAt).toBeNull();
  });

  it("reports terminal summary failure and leaves the source watermark unchanged", async () => {
    const directory = root();
    const scan = executor(directory, adapter(), service({ runWorkerOnce: async () => ({}), memoryProcessingStatus: () => ({ items: [{ memoryId: "memory-one", state: "failed", errorMessage: "embedding rejected" }] }) }));
    await scan.startScan({ sourceId: "all", waitForProcessing: true });
    expect((await done(scan)).error).toContain("embedding rejected");
    expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).sources.fixture.latestSeenAt).toBeNull();
  });

  it("restores an interrupted job after restart and lets the user cancel it", async () => {
    const directory = root();
    const store = await openMemoryAgentSourceScanStore(join(directory, "scans", "interrupted.sqlite"), { jobId: "interrupted", sourceId: "fixture", mode: "full", phase: "ingest", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); store.close();
    const scan = executor(directory);
    expect(scan.scanStatus()).toMatchObject({ jobId: "interrupted", progress: { phase: "stopped" } });
    await expect(scan.startScan({ sourceId: "all" })).rejects.toThrow(/recovered/);
    await scan.cancelScan();
    expect(scan.scanStatus().jobId).toBeNull();
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
