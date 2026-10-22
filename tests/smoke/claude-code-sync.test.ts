import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceTurnRequest, readClaudeCodeSourceTurn } from "@memmy/agent-source-core";
import { createMemoryHttpServer, MemoryDb } from "../../Memory/src/index.js";
import {
  createBatchReflectionLlm,
  createMemoryServiceFixture
} from "../../Memory/tests/fixtures/memory-service-fixture.js";
import { createClaudeCodeSourceAdapter } from "../../App/backend/src/adapters/outbound/agent-source/claude-code/index.js";
import { createSourceRegistry } from "../../App/backend/src/adapters/outbound/agent-source/source-registry.js";
import { createHttpMemoryClient } from "../../App/backend/src/adapters/outbound/memory-client/index.js";
import { createAppStateStore } from "../../App/backend/src/infrastructure/app-state-store/index.js";
import { createAgentSourceService } from "../../App/backend/src/services/agent-source-service.js";
import { createIngestionService } from "../../App/backend/src/services/ingestion-service.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

describe("Claude Code native history sync", () => {
  it("imports pre-activation end_turn history into ready L1 memories and preserves scan/Hook identity across repeat scans and a backend restart", async () => {
    const root = fixture.createTestRoot("memmy-claude-history-sync-");
    const projectsRoot = join(root, "claude", "projects");
    const projectDirectory = join(projectsRoot, "synthetic-project");
    mkdirSync(projectDirectory, { recursive: true });
    const historyPath = join(projectDirectory, "synthetic-session.jsonl");
    const firstAt = Date.now() - 7 * 24 * 60 * 60 * 1_000;
    let scanAt = new Date().toISOString();
    writeFileSync(historyPath, nativeTurn(1, firstAt));
    // History already exists before Memory is first initialized and capture is activated.
    const service = fixture.createTestMemoryService({
      db: new MemoryDb({ path: join(root, "memory.sqlite") }),
      mode: "dev",
      llm: createBatchReflectionLlm([], "MEMMY726 synthetic capture summary")
    });
    let appStore = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    const server = createMemoryHttpServer({
      service,
      startAgentSourceAutomation: false,
      workerStartupFallbackMs: 60_000,
      workerPostHealthDelayMs: 60_000,
      auth: { mode: "local", allowAnonymous: true }
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a local test server");
      const memoryClient = createHttpMemoryClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "synthetic-test-token",
        timeoutMs: 10_000,
        maxRetries: 0
      });
      const createSources = () => createAgentSourceService({
        sourceRegistry: createSourceRegistry([createClaudeCodeSourceAdapter({ projectsRoot })]),
        agentSourceRepository: appStore.repositories.agentSources,
        memoryClient,
        ingestionService: createIngestionService({
          memoryClient,
          agentSourceRepository: appStore.repositories.agentSources
        }),
        skillDistributionService: {
          async listSkills() { return []; },
          async install() {},
          async uninstall() {},
          async installPlugin() {},
          async uninstallPlugin() {}
        },
        scanStoreDirectory: join(root, "scans"),
        now: () => scanAt
      });
      let sources = createSources();
      const first = await sources.scanOne("claude_code", { mode: "initial_subset" });
      expect(first.errors).toEqual([]);
      expect(first.memoryIdCount).toBe(1);
      expect(first.memoryIds).toHaveLength(1);
      const firstId = first.memoryIds![0]!;
      await memoryClient.runWorker({ limit: 100, targetMemoryIds: [firstId] });
      expect((await memoryClient.getMemoryProcessingStatus([firstId])).items).toEqual([
        expect.objectContaining({ memoryId: firstId, state: "ready" })
      ]);
      expect((await memoryClient.panelItems({ layer: "L1", status: "activated", page: 1 })).items)
        .toEqual([expect.objectContaining({ id: firstId })]);

      const repeat = await sources.scanOne("claude_code", { mode: "incremental" });
      expect(repeat).toMatchObject({ memoryIdCount: 0, errors: [] });

      const secondAt = Date.now() + 60_000;
      appendFileSync(historyPath, nativeTurn(2, secondAt));
      scanAt = new Date(secondAt + 2_000).toISOString();
      const incremental = await sources.scanOne("claude_code", { mode: "incremental" });
      expect(incremental.errors).toEqual([]);
      expect(incremental.memoryIdCount).toBe(1);
      const secondId = incremental.memoryIds![0]!;
      expect(secondId).not.toBe(firstId);
      await memoryClient.runWorker({ limit: 100, targetMemoryIds: [secondId] });
      expect((await memoryClient.getMemoryProcessingStatus([secondId])).items).toEqual([
        expect.objectContaining({ memoryId: secondId, state: "ready" })
      ]);

      const hook = await readClaudeCodeSourceTurn(historyPath, {
        conversationId: "synthetic-session", promptId: "prompt-2", stop: true
      });
      expect(hook.turn).not.toBeNull();
      const capturedAgain = await memoryClient.completeSourceTurn(buildSourceTurnRequest(hook.turn!, "hook"));
      expect(capturedAgain).toMatchObject({ status: "existing", result: { l1MemoryId: secondId } });

      appStore.close();
      appStore = createAppStateStore({ databasePath: join(root, "app.sqlite") });
      sources = createSources();
      const afterRestart = await sources.scanOne("claude_code", { mode: "incremental" });
      expect(afterRestart).toMatchObject({ memoryIdCount: 0, errors: [] });
      const deep = await sources.scanOne("claude_code", { mode: "full" });
      expect(deep).toMatchObject({ memoryIdCount: 0, errors: [] });
      expect((await memoryClient.panelItems({ layer: "L1", status: "activated", page: 1 })).items
        .map((item) => item.id).sort()).toEqual([firstId, secondId].sort());
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      appStore.close();
    }
  }, 20_000);
});

/** Mirrors VS Code's native human origin and terminal assistant message without turn_duration. */
function nativeTurn(index: number, startedAt: number): string {
  const shared = {
    sessionId: "synthetic-session",
    version: "2.1.304",
    entrypoint: "claude-vscode",
    isSidechain: false
  };
  return [
    {
      ...shared,
      type: "user",
      uuid: `user-${index}`,
      promptId: `prompt-${index}`,
      origin: { kind: "human" },
      timestamp: new Date(startedAt).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `MEMMY726 synthetic task ${index}: preserve the source turn identity.` }] }
    },
    {
      ...shared,
      type: "assistant",
      uuid: `assistant-${index}`,
      timestamp: new Date(startedAt + 1_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `MEMMY726 synthetic task ${index} completed and verified.` }],
        stop_reason: "end_turn"
      }
    }
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";
}
