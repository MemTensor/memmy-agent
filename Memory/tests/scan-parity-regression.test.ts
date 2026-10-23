import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createPiSourceAdapter } from "../src/agent-source/adapters/pi/index.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import type { MemoryService } from "../src/service/memory-service.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

import { openMemoryAgentSourceScanStore } from "../src/agent-source/scan-store.js";

const fixture = createMemoryServiceFixture();
const scans: ReturnType<typeof createAgentSourceExecutor>[] = [];
afterEach(async () => { for (const scan of scans.splice(0)) await scan.dispose(); fixture.cleanup(); });
function turn(id: string, seconds = 0, sourceId = "fixture"): ConversationMessage[] {
  return ["user", "assistant"].map((role, i) => ({ sourceId, conversationId: id, messageId: `${id}-${role}`,
    role: role as "user" | "assistant", content: i ? `Completed ${id}` : `Please remember ${id}`,
    createdAt: new Date(Date.UTC(2026, 8, 1) + seconds * 1000 + i * 100).toISOString(),
    workspacePath: null, gitRoot: null, rawMeta: {} }));
}
function adapter(messages: ConversationMessage[], sourceId = "fixture"): SourceAdapter {
  return { descriptor: { sourceId, displayName: sourceId, dataPath: "/fixture", builtin: true }, detect: async () => true,
    async *scan() { yield* messages; } };
}
function create(root: string, service: MemoryService, sources: SourceAdapter[]) {
  const scan = createAgentSourceExecutor({ service, sourceRegistry: createSourceRegistry(sources), configPath: join(root, "config.yaml"),
    statePath: join(root, "state.json"), scanStoreDirectory: join(root, "scans"), resolveAgentSkillRoot: () => null });
  scans.push(scan); return scan;
}
async function run(scan: ReturnType<typeof create>, sourceId = "fixture", mode: "full" | "incremental" | "initial_subset" = "incremental", waitForProcessing = false) {
  await scan.startScan({ sourceId, mode, waitForProcessing });
  await vi.waitFor(() => expect(scan.scanStatus().running).toBe(false), { timeout: 10000 });
  return scan.scanStatus();
}
const state = (root: string) => JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
const stub = (overrides = {}) => ({ addMemory: vi.fn((input: { requestId: string }) => ({ id: input.requestId, duplicate: false })),
  enqueuePendingImportSummaries: vi.fn(), ...overrides }) as unknown as MemoryService;

describe("backend scan behavior preserved in Memory", () => {
  it("keeps real Pi history counts and memory rows stable across scans and restart", async () => {
    const { root, service, db } = fixture.createTestService();
    const sessions = join(root, "pi"); mkdirSync(sessions);
    for (const [id, seconds] of [["one", 1], ["two", 2]] as const) {
      const records = [{ type: "session", id }, ...turn(id, seconds, "pi").map(message => ({ type: "message", id: message.messageId,
        timestamp: message.createdAt, message: { role: message.role, content: message.content } }))];
      writeFileSync(join(sessions, `${id}.jsonl`), records.map(value => JSON.stringify(value)).join("\n") + "\n");
    }
    const source = createPiSourceAdapter({ rootDirectory: sessions, sessionsRoot: sessions });
    const add = vi.spyOn(service, "addMemory");
    const first = create(root, service, [source]);
    expect((await run(first, "pi", "full")).error).toBeNull();
    expect((await run(first, "pi")).error).toBeNull();
    expect(state(root).sources.pi.messageCount).toBe(4);
    await first.dispose();
    const next = create(root, service, [source]);
    expect((await run(next, "pi")).error).toBeNull();
    expect(state(root).sources.pi.messageCount).toBe(4);
    expect(add).toHaveBeenCalledTimes(2);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get()).toEqual({ count: 2 });
  });

  it("captures same-timestamp messages and content revisions without recounting existing IDs", async () => {
    const root = fixture.createTestRoot(); const messages = turn("one");
    const service = stub(); const scan = create(root, service, [adapter(messages)]);
    expect((await run(scan, "fixture", "full")).error).toBeNull();
    messages[1]!.content = "Revised answer with the same ID and timestamp";
    expect((await run(scan)).error).toBeNull();
    expect(service.addMemory).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("Revised answer") }));
    expect(state(root).sources.fixture.messageCount).toBe(2);
    const boundary = messages[1]!.createdAt;
    messages.push(...turn("new").map((message, index) => ({ ...message, messageId: `${index}-new`, createdAt: boundary })));
    expect((await run(scan)).error).toBeNull();
    expect(state(root).sources.fixture.messageCount).toBe(4);
    const attempts = vi.mocked(service.addMemory).mock.calls.length;
    expect((await run(scan)).error).toBeNull();
    expect(service.addMemory).toHaveBeenCalledTimes(attempts);
    expect(state(root).sources.fixture.messageCount).toBe(4);
  });

  it("deduplicates successful messages when a partial write is retried", async () => {
    const root = fixture.createTestRoot(); let fail = true;
    const service = stub({ addMemory: vi.fn((input: { requestId: string; content: string }) => {
      if (fail && input.content.includes("two")) throw new Error("fixture write failed");
      return { id: input.requestId, duplicate: !fail };
    }) });
    const source = adapter([...turn("one", 1), ...turn("two", 2)]);
    const scan = create(root, service, [source]);
    expect((await run(scan, "fixture", "full")).error).toContain("fixture write failed");
    expect(state(root).sources.fixture).toMatchObject({ messageCount: 2, latestSeenAt: null });
    await scan.dispose(); fail = false;
    const next = create(root, service, [source]);
    expect((await run(next, "fixture", "full")).error).toBeNull();
    expect(state(root).sources.fixture.messageCount).toBe(4);
    expect((await run(next)).error).toBeNull();
    expect(state(root).sources.fixture.messageCount).toBe(4);
  });

  it("publishes scan checkpoints after enqueue regardless of background indexing outcome", async () => {
    const root = fixture.createTestRoot(); let fail = true;
    const service = stub({ runWorkerOnce: vi.fn(async () => ({})), memoryProcessingStatus: (ids: string[]) => ({
      items: ids.map(memoryId => ({ memoryId, state: fail ? "failed" : "ready", errorMessage: "indexing rejected" })) }) });
    const scan = create(root, service, [adapter(turn("one"))]);
    expect((await run(scan, "fixture", "full", true)).error).toBeNull();
    expect(state(root).sources.fixture.latestSeenAt).not.toBeNull();
    fail = false;
    expect((await run(scan, "fixture", "incremental", true)).error).toBeNull();
    expect(service.addMemory).toHaveBeenCalledTimes(1);
    expect(service.runWorkerOnce).not.toHaveBeenCalled();
    expect(state(root).sources.fixture.messageCount).toBe(2);
  });

  it("reconciles an older untracked count once, retaining recovery after failure", async () => {
    const root = fixture.createTestRoot(); let fail = true;
    const messages = [...turn("old", 1), ...turn("latest", 2)];
    writeFileSync(join(root, "state.json"), JSON.stringify({ version: 2, sources: { fixture: { status: "not_connected",
      messageCount: 99, lastScannedAt: "2026-09-02T00:00:00.000Z", latestSeenAt: messages[3]!.createdAt } } }));
    const source = adapter(messages); const modes: boolean[] = [];
    source.scan = async function* (options) { modes.push(options.fullHistory === true); yield* messages; };
    const service = stub({ addMemory: vi.fn((input: { requestId: string }) => {
      if (fail) throw new Error("fixture failed"); return { id: input.requestId, duplicate: true };
    }) });
    const scan = create(root, service, [source]);
    expect((await run(scan)).error).toContain("fixture failed");
    expect(state(root).sources.fixture.recoveryPending).toBe(true);
    fail = false;
    expect((await run(scan)).error).toBeNull();
    expect(state(root).sources.fixture).toMatchObject({ messageCount: 4, recoveryPending: false });
    expect((await run(scan)).error).toBeNull();
    expect(modes).toEqual([true, true, false]);
    expect(state(root).sources.fixture.messageCount).toBe(4);
  });

  it("preserves initial subset limits and counts only newly covered history in a full replay", async () => {
    const root = fixture.createTestRoot(); const service = stub();
    const recent = Array.from({ length: 1005 }, (_, i) => turn(`r${i}`, 10000 + i, "recent")).flat();
    const older = Array.from({ length: 205 }, (_, i) => turn(`o${i}`, i, "older")).flat();
    recent.push(turn("incomplete", 30000, "recent")[0]!);
    const scan = create(root, service, [adapter(recent, "recent"), adapter(older, "older")]);
    expect((await run(scan, "all", "initial_subset")).error).toBeNull();
    expect(state(root).sources.recent.messageCount).toBe(2000);
    expect(state(root).sources.older.messageCount).toBe(400);
    expect((await run(scan, "all", "full")).error).toBeNull();
    expect(state(root).sources.recent.messageCount).toBe(2010);
    expect(state(root).sources.older.messageCount).toBe(410);
    expect((await run(scan, "all", "full")).error).toBeNull();
    expect(state(root).sources.recent.messageCount).toBe(2010);
    expect(state(root).sources.older.messageCount).toBe(410);
  });

  it("scopes repeated message IDs by source and conversation", async () => {
    const root = fixture.createTestRoot(); const service = stub();
    const messages = [...turn("one"), ...turn("two")].map(message => ({ ...message, messageId: message.role }));
    const scan = create(root, service, [adapter(messages), adapter(messages.map(message => ({ ...message, sourceId: "other" })), "other")]);
    expect((await run(scan, "all", "full")).error).toBeNull();
    expect(state(root).sources.fixture.messageCount).toBe(4);
    expect(state(root).sources.other.messageCount).toBe(4);
  });
});


it.each(["stage", "prepare", "ingest", "failed", "missing"])("retains unavailable staged work in %s and imports it after restart", async phase => {
  const { root, service, db } = fixture.createTestService();
  const messages = turn("unavailable");
  const store = await openMemoryAgentSourceScanStore(join(root, "scans", "interrupted.sqlite"), {
    jobId: "interrupted", sourceId: "all", mode: "full", phase: "ingest",
    createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z"
  });
  store.stageBatch(messages);
  if (phase !== "missing") store.saveSourceState({ sourceId: "fixture", mode: "full", phase: phase as "stage", messageCount: 2, resultCount: 0, errorCount: 0, updatedAt: "2026-10-21T00:00:00Z" });
  store.close();
  const source = adapter(messages); source.detect = async () => false;
  const scan = create(root, service, [source]);
  const failed = await run(scan, "all", "full");
  expect(failed.error).toContain("unfinished unavailable sources: fixture");
  expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 0 });
  await scan.dispose();
  source.detect = async () => true;
  const next = create(root, service, [source]);
  const recovered = await run(next, "all", "full");
  expect(recovered.jobId).toBe("interrupted");
  expect(recovered.error).toBeNull();
  expect(state(root).sources.fixture.messageCount).toBe(2);
  expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get()).toEqual({ count: 1 });
  expect((await run(next, "all", "full")).error).toBeNull();
  expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get()).toEqual({ count: 1 });
});

it("preserves full scope for unstarted sources when resuming the confirmed mode", async () => {
 const {root, service, db} = fixture.createTestService();
 let entered!: () => void; const reached = new Promise<void>(r => entered=r);
 const a=adapter([], "a");
 a.scan=async function*(options) { entered(); await new Promise<void>(r => { if(options.signal?.aborted) r(); else options.signal?.addEventListener("abort", () => r(), {once:true}); }); yield* turn("first",0,"a"); };
 const b=adapter(Array.from({length:1200},(_,i)=>turn(`history-${i}`,i,"b")).flat(),"b");
 const first=create(root,service,[a,b]);
 const started=await first.startScan({sourceId:"all", mode:"full"});
 await reached; await first.dispose();
 a.scan=async function*() {};
 const optionsSeen:unknown[]=[]; const original=b.scan;
 b.scan=async function*(opts) { optionsSeen.push(opts); yield* original(opts); };
 const restored=create(root,service,[a,b]);
 expect(restored.scanStatus()).toMatchObject({jobId:started.jobId, mode:"full", status:"paused"});
 const resumed=await restored.startScan({sourceId:"all", mode: restored.scanStatus().mode, expectedExecution:{jobId:started.jobId,attemptId:started.attemptId}});
 expect(resumed.jobId).toBe(started.jobId);
 await vi.waitFor(()=>expect(restored.scanStatus().running).toBe(false),{timeout:20000});
 expect(restored.scanStatus().error).toBeNull();
 const count=db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL").get();
 expect(optionsSeen).toEqual([expect.objectContaining({ order: "source_default", fullHistory: true })]);
 expect(count).toEqual({n:1200});
},30000);


it("preserves automatic per-source modes after interrupting a new source before a known source", async () => {
  const { root, service, db } = fixture.createTestService();
  let reached!: () => void; const staging = new Promise<void>(resolve => { reached = resolve; });
  const firstSource = adapter([], "new");
  firstSource.scan = async function* (options) {
    reached();
    await new Promise<void>(resolve => { options.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  };
  const messages = turn("old", 0, "known");
  const knownSource = adapter(messages, "known");
  const first = create(root, service, [firstSource, knownSource]);
  expect((await run(first, "known", "full")).error).toBeNull();
  messages.push(...Array.from({ length: 1200 }, (_, i) => turn(`new-${i}`, i + 1, "known")).flat());
  const started = await first.startScan({ sourceId: "all" });
  await staging; await first.dispose();
  firstSource.scan = async function* () {};
  const restored = create(root, service, [firstSource, knownSource]);
  expect(restored.scanStatus()).toMatchObject({ status: "paused", mode: null, jobId: started.jobId });
  await restored.startScan({ sourceId: "all", expectedExecution: { jobId: started.jobId, attemptId: started.attemptId } });
  await vi.waitFor(() => expect(restored.scanStatus().running).toBe(false), { timeout: 20_000 });
  expect(restored.scanStatus().error).toBeNull();
  expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get()).toEqual({ count: 1201 });
}, 30_000);
