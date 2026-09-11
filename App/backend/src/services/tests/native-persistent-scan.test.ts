import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexRollout } from "@memmy/agent-source-core";
import { createAgentSourceService } from "../agent-source-service.js";
import { createIngestionService } from "../ingestion-service.js";
import { createSourceRegistry } from "../../adapters/outbound/agent-source/source-registry.js";
import { createCodexSourceAdapter } from "../../adapters/outbound/agent-source/codex/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";

const roots: string[] = []; const stores: AppStateStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe("persistent Codex scan", () => {
  it("does not checkpoint a lost response; retries the same source turn without import splitting", async () => {
    const root = mkdtempSync(join(tmpdir(), "native-backend-scan-")); roots.push(root);
    const store = createAppStateStore({ databasePath: join(root, "app.sqlite") }); stores.push(store);
    const repository = store.repositories.agentSources;
    const file = join(root, "rollout.jsonl");
    const at = "2099-09-09T10:00:00.000Z";
    const event = (type: string, payload: Record<string, unknown>) => ({ type, timestamp: at, payload });
    writeFileSync(file, [event("session_meta", { id: "source-session" }), event("event_msg", { type: "task_started", turn_id: "turn-1" }),
      event("response_item", { type: "message", role: "user", content: [{ text: "Run tests" }] }),
      event("response_item", { type: "custom_tool_call", call_id: "call-1", name: "test", input: "npm test" }),
      event("response_item", { type: "custom_tool_call_output", call_id: "call-1", output: "passed ".repeat(4000) }),
      event("response_item", { type: "message", role: "assistant", content: [{ text: "Tests passed" }] }),
      event("event_msg", { type: "task_complete", turn_id: "turn-1" })].map(value => JSON.stringify(value)).join("\n") + "\n");
    const client = createMockMemoryClient();
    const addMemory = vi.spyOn(client, "addMemory"); const enqueue = vi.spyOn(client, "enqueueImportSummaries");
    const complete = vi.spyOn(client, "completeSourceTurn").mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({ status: "existing", result: {
      turnId: "turn-1", sessionId: "session", episodeId: "episode", rawTurnId: "raw", l1MemoryId: "same-l1", l1MemoryIds: ["same-l1"], closedEpisodeIds: [], scheduledEvolution: false, jobs: [], serverTime: at
    } });
    const service = createAgentSourceService({ sourceRegistry: createSourceRegistry([{ descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: root },
      detect: async () => true, async *scan() { for await (const message of readCodexRollout(file)) yield { ...message, sourceId: "codex", workspacePath: null, gitRoot: null }; } }]),
      memoryClient: client, agentSourceRepository: repository, ingestionService: createIngestionService({ memoryClient: client, agentSourceRepository: repository }),
      skillDistributionService: { install: async () => undefined, uninstall: async () => undefined, installPlugin: async () => undefined, uninstallPlugin: async () => undefined },
      scanStoreDirectory: join(root, "scans") });
    const failed = await service.scanOne("codex", { scanJobId: "same-job", mode: "incremental" });
    expect(failed.errors[0]?.reason).toBe("response lost");
    expect(repository.getConversationCheckpoint("codex", "source-session")).toBeNull();
    expect(repository.getScanWatermark("codex")).toBeNull();
    const retried = await service.scanOne("codex", { scanJobId: "same-job", mode: "incremental" });
    expect(retried.errors).toEqual([]); expect(retried.memoryIdCount).toBe(0);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0]).toEqual(complete.mock.calls[1]?.[0]);
    expect(complete.mock.calls[0]?.[0].toolCalls).toEqual([expect.objectContaining({ id: "call-1", input: "npm test", output: "passed ".repeat(4000) })]);
    expect(repository.getConversationCheckpoint("codex", "source-session")).not.toBeNull();
    expect(addMemory).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
});


describe("nonpersistent Codex scan window", () => {
  it.each([undefined, 2])("keeps a complete new turn across since without reselecting old conversations (maxMessages=%s)", async maxMessages => {
    const root = mkdtempSync(join(tmpdir(), "native-backend-window-")); roots.push(root);
    const store = createAppStateStore({ databasePath: join(root, "app.sqlite") }); stores.push(store);
    const repository = store.repositories.agentSources;
    const writeTurn = (file: string, conversationId: string, start: string, end: string) => {
      const event = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload });
      writeFileSync(join(root, file), [
        event(start, "session_meta", { id: conversationId }),
        event(start, "event_msg", { type: "task_started", turn_id: `${conversationId}-turn` }),
        event(start, "response_item", { type: "message", role: "user", content: [{ text: "Inspect the complete source before changing it." }] }),
        event(start, "response_item", { type: "function_call", call_id: "read-call", name: "read", arguments: { path: "source.ts" } }),
        event(end, "response_item", { type: "function_call_output", call_id: "read-call", output: "Complete source contents" }),
        event(end, "response_item", { type: "message", role: "assistant", content: [{ text: "I inspected the complete source and fixed it." }] }),
        event(end, "event_msg", { type: "task_complete", turn_id: `${conversationId}-turn` })
      ].map(record => JSON.stringify(record)).join("\n") + "\n");
    };
    writeTurn("rollout-a-old.jsonl", "old-conversation", "2099-09-09T09:00:00.000Z", "2099-09-09T09:01:00.000Z");
    writeTurn("rollout-b-new.jsonl", "new-conversation", "2099-09-09T10:01:00.000Z", "2099-09-09T10:03:00.000Z");
    const client = createMockMemoryClient();
    const complete = vi.spyOn(client, "completeSourceTurn");
    const add = vi.spyOn(client, "addMemory");
    const service = createAgentSourceService({
      sourceRegistry: createSourceRegistry([createCodexSourceAdapter({ sessionsRoot: root })]),
      memoryClient: client, agentSourceRepository: repository,
      ingestionService: createIngestionService({ memoryClient: client, agentSourceRepository: repository }),
      skillDistributionService: { install: async () => undefined, uninstall: async () => undefined, installPlugin: async () => undefined, uninstallPlugin: async () => undefined }
    });
    const options = { mode: "incremental" as const, since: "2099-09-09T10:02:00.000Z", maxMessages };
    const collected = await service.collectOne("codex", options);
    expect(collected.conversationIds).toEqual(["new-conversation"]);
    expect(collected.messages).toHaveLength(5);
    expect(collected.messages[0]?.content).toBe("Inspect the complete source before changing it.");
    expect(collected.messages.at(-1)).toMatchObject({ role: "system", content: "Codex task_complete" });
    const result = await service.scanOne("codex", options);
    expect(result.errors).toEqual([]);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      sourceTurn: expect.objectContaining({ conversationId: "new-conversation", turnId: "new-conversation-turn", startedAt: "2099-09-09T10:01:00.000Z", completedAt: "2099-09-09T10:03:00.000Z" }),
      query: "Inspect the complete source before changing it.", answer: "I inspected the complete source and fixed it.",
      toolCalls: [{ id: "read-call", name: "read", input: { path: "source.ts" }, output: "Complete source contents" }],
      toolResults: [{ id: "read-call", output: "Complete source contents" }]
    }));
    expect(add).not.toHaveBeenCalled();
    expect(repository.getConversationCheckpoint("codex", "old-conversation")).toBeNull();
  });
});
