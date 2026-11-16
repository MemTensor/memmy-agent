import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSourceTurnRequest, readClaudeCodeSourceTurn } from "@memmy/agent-source-core";
import { MemoryDb } from "../src/index.js";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createClaudeCodeSourceAdapter } from "../src/agent-source/adapters/claude-code/index.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createMemoryServiceFixture, createBatchReflectionLlm, settleCaptureWork } from "./fixtures/memory-service-fixture.js";
import type { MemoryService } from "../src/service/memory-service.js";

const fixture = createMemoryServiceFixture();
const scans: ReturnType<typeof createAgentSourceExecutor>[] = [];
afterEach(async () => { for (const scan of scans.splice(0)) await scan.dispose(); await fixture.cleanup(); });
function rows(id: string, complete = true, at = "2099-01-01T10:00:00.000Z") {
  const shared = { sessionId: id, timestamp: at };
  return [{ ...shared, type: "user", uuid: `${id}-user`, promptId: `${id}-prompt`, origin: { kind: "human" },
    message: { content: "Fix the login button and preserve the native source identity." } },
  { ...shared, type: "assistant", uuid: `${id}-answer`, timestamp: new Date(Date.parse(at) + 1000).toISOString(),
    message: { stop_reason: complete ? "end_turn" : null, content: [{ type: "text", text: "The login handler is fixed and tested." }] } }];
}
function history(root: string, id: string, complete = true, at?: string) {
  const directory = join(root, "claude", "project"); mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  writeFileSync(path, rows(id, complete, at).map(row => JSON.stringify(row)).join("\n") + "\n"); return path;
}
function executor(root: string, service: MemoryService) {
  const scan = createAgentSourceExecutor({ service,
    sourceRegistry: createSourceRegistry([createClaudeCodeSourceAdapter({ projectsRoot: join(root, "claude") })]),
    configPath: join(root, "config.yaml"), statePath: join(root, "state.json"),
    scanStoreDirectory: join(root, "scans"), resolveAgentSkillRoot: () => null });
  scans.push(scan); return scan;
}
async function run(scan: ReturnType<typeof executor>, mode: "full" | "incremental" = "full") {
  await scan.startScan({ sourceId: "claude_code", mode });
  await vi.waitFor(() => expect(scan.scanStatus().running).toBe(false), { timeout: 10000 });
  expect(scan.scanStatus().error).toBeNull();
}
const captures = (db: MemoryDb) => db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get();
const memories = (db: MemoryDb) => db.db.prepare("SELECT id FROM memories WHERE deleted_at IS NULL ORDER BY id").all();

describe("Claude history scan without turn_duration (MEMMY-726)", () => {
  it("captures completed history through the real service, processes L1, and deduplicates scans, Hook and restart", async () => {
    const llm = createBatchReflectionLlm([]);
    const { root, service, db } = fixture.createTestService({ llm });
    const path = history(root, "completed");
    history(root, "pending", false);
    const scan = executor(root, service);
    await run(scan);
    expect(captures(db)).toEqual({ count: 1 });
    await settleCaptureWork(service);
    const saved = memories(db); expect(saved).toHaveLength(1);
    const processing = service.memoryProcessingStatus(saved.map(row => (row as { id: string }).id));
    expect(processing.items).toEqual([expect.objectContaining({ state: "ready" })]);
    await run(scan, "incremental"); await run(scan);
    const hook = await readClaudeCodeSourceTurn(path, { conversationId: "completed", promptId: "completed-prompt", stop: true });
    expect(hook.turn).not.toBeNull();
    expect((await service.completeSourceTurn(buildSourceTurnRequest(hook.turn!, "hook"))).status).toBe("existing");
    expect(memories(db)).toEqual(saved);
    await scan.dispose();
    await service.stop(); db.close();
    const reopened = new MemoryDb({ path: join(root, "memory.sqlite") });
    const restarted = fixture.createTestMemoryService({ db: reopened, llm });
    const next = executor(root, restarted);
    await run(next); expect(captures(reopened)).toEqual({ count: 1 }); expect(memories(reopened)).toEqual(saved);
    // The previously unfinished history is admitted once a real completion arrives.
    history(root, "pending", true);
    await run(next); await settleCaptureWork(restarted);
    expect(captures(reopened)).toEqual({ count: 2 }); expect(memories(reopened)).toHaveLength(2);
  }, 30000);

  it("recovers older skipped history with a full scan after an incremental watermark", async () => {
    const { root, service, db } = fixture.createTestService({ llm: createBatchReflectionLlm([]) });
    history(root, "recent");
    const scan = executor(root, service); await run(scan);
    expect(captures(db)).toEqual({ count: 1 });
    history(root, "old", true, "2026-10-14T11:00:00.000Z");
    await run(scan, "incremental");
    expect(captures(db)).toEqual({ count: 1 });
    await run(scan); expect(captures(db)).toEqual({ count: 2 });
    await settleCaptureWork(service);
    const saved = memories(db); expect(saved).toHaveLength(2);
    await run(scan); expect(memories(db)).toEqual(saved);
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).sources.claude_code.messageCount).toBe(4);
  }, 30000);
});
