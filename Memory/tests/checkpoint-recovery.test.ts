import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import * as checkpointModule from "../src/agent-source/source-checkpoints.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const executors: ReturnType<typeof createAgentSourceExecutor>[] = [];
const openCheckpoints = checkpointModule.openSourceCheckpoints;
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.dispose();
  vi.restoreAllMocks();
  fixture.cleanup();
});
function turn(i: number): ConversationMessage[] {
  const id = String(i).padStart(5, "0");
  return (["user", "assistant"] as const).map((role, index) => ({
    sourceId: "fixture", conversationId: id, messageId: `${id}-${role}`, role,
    content: `${role}: checkpoint recovery ${id}`,
    createdAt: new Date(Date.UTC(2026, 9, 20) + i * 2000 + index * 1000).toISOString(),
    workspacePath: null, gitRoot: null, rawMeta: {}
  }));
}
const state = (root: string) => JSON.parse(readFileSync(join(root, "state.json"), "utf8")).sources.fixture;
function checkpointCount(root: string) {
  const db = new Database(join(root, "state.json.checkpoints.sqlite"), { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count; }
  finally { db.close(); }
}

describe("executor recovery at checkpoint publication", () => {
  it.each([
    ["full", "partial"], ["incremental", "partial"], ["initial_subset", "partial"],
    ["full", "last"], ["incremental", "last"], ["initial_subset", "last"], ["full", "resume"]
  ] as const)("pauses %s at the %s batch, then recovers after cancellation or shutdown without duplicate jobs", async (mode, stopAt) => {
    const { root, service, db } = fixture.createTestService();
    const messages = turn(0);
    const source: SourceAdapter = {
      descriptor: { sourceId: "fixture", displayName: "Fixture", dataPath: root, builtin: true },
      detect: async () => true, async *scan() { yield* messages; }
    };
    const create = () => {
      const executor = createAgentSourceExecutor({
        service, sourceRegistry: createSourceRegistry([source]), configPath: join(root, "config.yaml"),
        statePath: join(root, "state.json"), scanStoreDirectory: join(root, "scans"),
        resolveAgentSkillRoot: () => null
      });
      executors.push(executor); return executor;
    };
    let scan = create();
    // Seed an older durable source state. It must not advance on cancellation.
    await scan.startScan({ sourceId: "fixture", mode: "full" });
    await vi.waitFor(() => expect(scan.scanStatus().completedAt).not.toBeNull());
    const previous = state(root);
    const count = mode === "initial_subset" ? 1005 : 205;
    messages.push(...Array.from({ length: count }, (_, i) => turn(i + 1)).flat());
    let written = 0;
    let pause: Promise<unknown> | undefined;
    vi.spyOn(checkpointModule, "openSourceCheckpoints").mockImplementation(path => {
      const checkpoints = openCheckpoints(path);
      const write = checkpoints.saveCheckpointBatch;
      vi.spyOn(checkpoints, "saveCheckpointBatch").mockImplementation(rows => {
        const n = write(rows); written += n;
        if (!pause && (stopAt !== "last" || written === count + 1)) {
          // A real event-loop callback must run before the next batch or final state write.
          setImmediate(() => { pause = scan.pauseScan(); });
        }
        return n;
      });
      return checkpoints;
    });
    const first = await scan.startScan({ sourceId: "fixture", mode });
    await vi.waitFor(() => expect(pause).toBeDefined(), { timeout: 15000 });
    await pause;
    expect(scan.scanStatus()).toMatchObject({ running: false, completedAt: null, progress: { phase: "stopped" } });
    expect(state(root)).toEqual(previous);
    expect(written).toBeGreaterThan(0);
    if (stopAt !== "last") expect(written).toBeLessThan(count + 1);
    else expect(checkpointCount(root)).toBe(count + 1);
    const committed = checkpointCount(root);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(checkpointCount(root)).toBe(committed);
    const memories = () => db.db.prepare("SELECT id FROM memories ORDER BY id").all();
    const jobs = () => db.db.prepare("SELECT id FROM evolution_jobs ORDER BY id").all();
    const savedMemories = memories(), savedJobs = jobs();
    expect(savedMemories).toHaveLength(mode === "initial_subset" ? 1001 : count + 1);
    expect(savedJobs.length).toBeGreaterThan(0);
    if (stopAt === "resume") {
      const resumed = await scan.startScan({ sourceId: "fixture", mode });
      expect(resumed.jobId).toBe(first.jobId);
      expect(resumed.attemptId).toBe(first.attemptId);
    } else {
      if (stopAt === "partial") await scan.cancelScan();
      expect(state(root)).toEqual(previous);
      await scan.dispose();
      vi.restoreAllMocks();
      scan = create();
      // Cancel deletes the job; shutdown retains its staged candidates for recovery.
      const retried = await scan.startScan({ sourceId: "fixture", mode });
      if (stopAt === "partial") expect(retried.jobId).not.toBe(first.jobId);
      else expect(retried.jobId).toBe(first.jobId);
    }
    await vi.waitFor(() => expect(scan.scanStatus().completedAt).not.toBeNull(), { timeout: 15000 });
    expect(scan.scanStatus().error).toBeNull();
    expect(checkpointCount(root)).toBe(count + 1);
    expect(memories()).toEqual(savedMemories);
    expect(jobs()).toEqual(savedJobs);
    expect(state(root).latestSeenAt).toBe(messages.at(-1)!.createdAt);
    expect(state(root).messageCount).toBe(savedMemories.length * 2);
    await scan.startScan({ sourceId: "fixture", mode: "incremental" });
    await vi.waitFor(() => expect(scan.scanStatus().completedAt).not.toBeNull());
    expect(scan.scanStatus().error).toBeNull();
    expect(memories()).toEqual(savedMemories);
    expect(jobs()).toEqual(savedJobs);
  }, 30000);
});
