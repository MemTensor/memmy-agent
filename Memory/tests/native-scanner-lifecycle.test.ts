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
      expect(repos.runtime.getSession(captured.sessionId)?.userId).toBe("scan-owner");
      expect(repos.memories.get(captured.l1MemoryId)?.userId).toBe("scan-owner");
      expect(repos.runtime.getEpisode(captured.episodeId)?.l1MemoryIds).toEqual([captured.l1MemoryId]);
      expect(repos.runtime.getRawTurn(captured.rawTurnId)?.toolCalls[0]).toMatchObject({ id: "read", input: { path: "src/main.ts" }, output: expect.stringContaining("source contents") });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'import_summary'").get()).toEqual({ n: 0 });
    } finally { await executor.dispose(); }
  });

  it("keeps an incomplete scan retryable, then captures after task_complete is appended", async () => {
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
      expect(executor.scanStatus().error).toContain("turn_incomplete");
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex.latestSeenAt).toBeNull();
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 0 });
      write(true);
      await executor.startScan({ sourceId: "codex", mode: "incremental" }); await wait(executor);
      expect(executor.scanStatus().error).toBeNull();
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex.latestSeenAt).toBe(at);
    } finally { await executor.dispose(); }
  });
});
