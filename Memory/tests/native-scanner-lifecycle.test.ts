import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexRollout, sourceTurnFromMessages, buildSourceTurnRequest, type RawCodexMessage } from "@memmy/agent-source-core";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";
import { DEFAULT_MEMMY_CONFIG } from "../src/index.js";
import { Repositories } from "../src/storage/repositories.js";

const fixture = createMemoryServiceFixture();
afterEach(() => { vi.restoreAllMocks(); fixture.cleanup(); });
const at = "2099-09-09T10:00:00.000Z";
const event = (type: string, payload: Record<string, unknown>) => ({ type, timestamp: at, payload });
function records(complete: boolean) {
  return [event("session_meta", { id: "native-session" }), event("event_msg", { type: "task_started", turn_id: "native-turn" }),
    event("response_item", { type: "message", role: "user", content: [{ text: "Inspect the issue and run tests." }] }),
    event("response_item", { type: "function_call", call_id: "read", name: "read_file", arguments: { path: "src/main.ts" } }),
    event("response_item", { type: "function_call_output", call_id: "read", output: "source contents ".repeat(3000) }),
    event("response_item", { type: "message", role: "assistant", content: [{ text: "The issue is fixed and all tests passed." }] }),
    ...(complete ? [event("event_msg", { type: "task_complete", turn_id: "native-turn" })] : [])];
}
async function wait(executor: ReturnType<typeof createAgentSourceExecutor>) {
  await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false));
}

describe("Codex scan and Hook share the actual Memory lifecycle", () => {
  it.each(["hook", "scan"])("keeps one RawTurn, L1 and capture job when %s arrives first", async first => {
    const { service, db, root } = fixture.createTestService({ config: { ...DEFAULT_MEMMY_CONFIG, userId: "scan-owner" } });
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, records(true).map(record => JSON.stringify(record)).join("\n") + "\n");
    const messages: RawCodexMessage[] = []; for await (const value of readCodexRollout(path)) messages.push(value);
    const turn = sourceTurnFromMessages(messages)!;
    const hook = () => service.completeSourceTurn({ ...buildSourceTurnRequest(turn, "hook"), namespace: { source: "codex", profileId: "default", userId: "scan-owner" } });
    const add = vi.spyOn(service, "addMemory");
    const executor = createAgentSourceExecutor({ service, configPath: join(root, "config.yaml"),
      resolveAgentSkillRoot: () => null,
      sourceRegistry: createSourceRegistry([{ descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: root },
        detect: async () => true, async *scan() { for (const message of messages) yield { ...message, sourceId: "codex", workspacePath: null, gitRoot: null }; } }]) });
    try {
      if (first === "hook") expect(hook().status).toBe("stored");
      await executor.startScan({ sourceId: "codex", mode: "full" }); await wait(executor);
      expect(executor.scanStatus().error).toBeNull();
      expect(hook().status).toBe("existing");
      expect(add).not.toHaveBeenCalled();
      for (const table of ["raw_turns", "source_turn_captures"]) expect(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ n: 1 });
      const captured = hook().result!;
      const repos = new Repositories(db.db);
      expect(repos.runtime.getSession(captured.sessionId)?.userId).toBe(null);
      expect(repos.memories.get(captured.l1MemoryId)?.userId).toBe(null);
      expect(repos.runtime.getEpisode(captured.episodeId)?.l1MemoryIds).toEqual([captured.l1MemoryId]);
      expect(repos.runtime.getRawTurn(captured.rawTurnId)?.toolCalls[0]).toMatchObject({ id: "read", input: { path: "src/main.ts" }, output: expect.stringContaining("source contents") });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'import_summary'").get()).toEqual({ n: 0 });
      for (const scan of [{ sourceId: "codex" }, { sourceId: "all" }, { sourceId: "all", mode: "full" as const }]) {
        const previousId = hook().result!.l1MemoryId;
        await executor.clearAllData();
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM source_turn_captures").get()).toEqual({ n: 0 });
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
        await executor.startScan(scan); await wait(executor);
        expect(executor.scanStatus().error).toBeNull();
        expect(hook().status).toBe("existing");
        expect(hook().result!.l1MemoryId).not.toBe(previousId);
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ n: 1 });
        await executor.startScan(scan); await wait(executor);
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM source_turn_captures").get()).toEqual({ n: 1 });
      }
    } finally { await executor.dispose(); }
  });

  it("holds the watermark at an unfinished turn, then captures after task_complete is appended", async () => {
    const { service, db, root } = fixture.createTestService();
    const path = join(root, "rollout.jsonl"); const statePath = join(root, "scan-state.json");
    const write = (complete: boolean) => writeFileSync(path, records(complete).map(record => JSON.stringify(record)).join("\n") + "\n");
    write(false);
    const executor = createAgentSourceExecutor({ service, configPath: join(root, "config.yaml"), statePath,
      resolveAgentSkillRoot: () => null,
      sourceRegistry: createSourceRegistry([{ descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: root },
        detect: async () => true, async *scan() { for await (const message of readCodexRollout(path)) yield { ...message, sourceId: "codex", workspacePath: null, gitRoot: null }; } }]) });
    try {
      await executor.startScan({ sourceId: "codex", mode: "incremental" }); await wait(executor);
      expect(executor.scanStatus().error).toBeNull();
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex).toMatchObject({ lastScannedAt: expect.any(String), latestSeenAt: at });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 0 });
      write(true);
      await executor.startScan({ sourceId: "codex", mode: "incremental" }); await wait(executor);
      expect(executor.scanStatus().error).toBeNull();
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex.latestSeenAt).toBe(at);
    } finally { await executor.dispose(); }
  });

  it("advances the scan cursor when a cancelled turn sits next to a complete sibling", async () => {
    const { service, root } = fixture.createTestService();
    const statePath = join(root, "scan-state.json");
    const completePath = join(root, "rollout-complete.jsonl");
    const cancelledPath = join(root, "rollout-cancelled.jsonl");
    writeFileSync(completePath, records(true).map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(cancelledPath, [
      event("session_meta", { id: "cancelled-session" }),
      event("event_msg", { type: "task_started", turn_id: "cancelled-turn" }),
      event("response_item", { type: "message", role: "user", content: [{ text: "Stop this turn." }] }),
      event("event_msg", { type: "task_aborted", turn_id: "cancelled-turn" })
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const executor = createAgentSourceExecutor({
      service,
      configPath: join(root, "config.yaml"),
      statePath,
      resolveAgentSkillRoot: () => null,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: root },
        detect: async () => true,
        async *scan() {
          for (const path of [completePath, cancelledPath]) {
            for await (const message of readCodexRollout(path)) {
              yield { ...message, sourceId: "codex", workspacePath: null, gitRoot: null };
            }
          }
        }
      }])
    });
    try {
      await executor.startScan({ sourceId: "codex", mode: "incremental" });
      await wait(executor);
      expect(executor.scanStatus().error).toBeNull();
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex.latestSeenAt).toBe(at);
    } finally {
      await executor.dispose();
    }
  });

  it("moves to incremental scans when the only unfinished turn was abandoned long ago", async () => {
    const { service, db, root } = fixture.createTestService();
    const statePath = join(root, "scan-state.json");
    const completePath = join(root, "rollout-complete.jsonl");
    const abandonedPath = join(root, "rollout-abandoned.jsonl");
    const abandonedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(completePath, records(true).map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(abandonedPath, [
      { type: "session_meta", timestamp: abandonedAt, payload: { id: "abandoned-session" } },
      { type: "event_msg", timestamp: abandonedAt, payload: { type: "task_started", turn_id: "abandoned-turn" } },
      { type: "response_item", timestamp: abandonedAt, payload: { type: "message", role: "user", content: [{ text: "This turn never finished." }] } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const scans: Array<{ fullHistory?: boolean; since?: string }> = [];
    const executor = createAgentSourceExecutor({ service, configPath: join(root, "config.yaml"), statePath,
      resolveAgentSkillRoot: () => null,
      sourceRegistry: createSourceRegistry([{ descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: root },
        detect: async () => true,
        async *scan(options) {
          scans.push({ fullHistory: options.fullHistory, since: options.since });
          for (const path of [abandonedPath, completePath]) {
            for await (const message of readCodexRollout(path)) yield { ...message, sourceId: "codex", workspacePath: null, gitRoot: null };
          }
        } }]) });
    try {
      for (let run = 0; run < 2; run += 1) {
        await executor.startScan({ sourceId: "codex" }); await wait(executor);
        expect(executor.scanStatus().error).toBeNull();
      }
      expect(scans).toEqual([{ fullHistory: true, since: undefined }, { fullHistory: false, since: at }]);
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex).toMatchObject({ lastScannedAt: expect.any(String), latestSeenAt: at });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
    } finally { await executor.dispose(); }
  });

  it("keeps the whole source retryable when Memory refuses captures", async () => {
    const { service, root } = fixture.createTestService();
    const path = join(root, "rollout.jsonl"); const statePath = join(root, "scan-state.json");
    writeFileSync(path, records(true).map((record) => JSON.stringify(record)).join("\n") + "\n");
    vi.spyOn(service, "completeSourceTurn").mockReturnValue({ status: "pending", reason: "memory_add_disabled" });
    const executor = createAgentSourceExecutor({ service, configPath: join(root, "config.yaml"), statePath,
      resolveAgentSkillRoot: () => null,
      sourceRegistry: createSourceRegistry([{ descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: root },
        detect: async () => true, async *scan() { for await (const message of readCodexRollout(path)) yield { ...message, sourceId: "codex", workspacePath: null, gitRoot: null }; } }]) });
    try {
      await executor.startScan({ sourceId: "codex" }); await wait(executor);
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex).toMatchObject({ lastScannedAt: null, latestSeenAt: null });
    } finally { await executor.dispose(); }
  });
});
