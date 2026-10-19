import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceAdapter } from "../src/agent-source/adapters/types.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { MemoryService } from "../src/service/memory-service.js";

const countCalls = vi.hoisted(() => ({ value: 0 }));

vi.mock("../src/agent-source/scan-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-source/scan-store.js")>();
  return {
    ...actual,
    openMemoryAgentSourceScanStore: (async (...args: Parameters<typeof actual.openMemoryAgentSourceScanStore>) => {
      const store = await actual.openMemoryAgentSourceScanStore(...args);
      const count = store.count.bind(store);
      store.count = (sourceId?: string) => {
        countCalls.value += 1;
        return count(sourceId);
      };
      return store;
    }) as typeof actual.openMemoryAgentSourceScanStore
  };
});

const { createAgentSourceExecutor } = await import("../src/agent-source/runtime.js");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Agent source ingestion progress", () => {
  it("does not recount staged messages for every ingested turn", async () => {
    const small = await countCallsForScan(2);
    const large = await countCallsForScan(40);
    expect(large).toBe(small);
  });
});

async function countCallsForScan(conversations: number): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-ingest-progress-"));
  roots.push(root);
  let nextId = 0;
  const adapter: SourceAdapter = {
    descriptor: {
      sourceId: "fixture-agent",
      displayName: "Fixture Agent",
      builtin: true,
      dataPath: join(root, "history")
    },
    detect: async () => true,
    async *scan() {
      for (let index = 0; index < conversations; index += 1) {
        const conversationId = `conversation-${index}`;
        const at = Date.parse("2026-08-28T01:00:00.000Z") + index * 120_000;
        for (const [offset, role] of [[0, "user"], [60_000, "assistant"]] as const) {
          yield {
            messageId: `${conversationId}-${role}`,
            sourceId: "fixture-agent",
            conversationId,
            role,
            content: `${role} message ${index}`,
            createdAt: new Date(at + offset).toISOString(),
            workspacePath: null,
            gitRoot: null,
            rawMeta: {}
          };
        }
      }
    }
  };
  const executor = createAgentSourceExecutor({
    service: {
      addMemory: vi.fn(() => ({ id: `memory-${nextId++}`, duplicate: false })),
      enqueuePendingImportSummaries: vi.fn()
    } as unknown as MemoryService,
    configPath: join(root, "config.yaml"),
    statePath: join(root, "agent-sources.json"),
    sourceRegistry: createSourceRegistry([adapter])
  });

  countCalls.value = 0;
  await executor.startScan({ sourceId: "fixture-agent", mode: "full" });
  for (let attempt = 0; attempt < 200 && executor.scanStatus().running; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(executor.scanStatus().running).toBe(false);
  return countCalls.value;
}
