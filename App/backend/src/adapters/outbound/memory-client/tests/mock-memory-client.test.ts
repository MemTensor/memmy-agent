/** Mock memory client tests. */
import { describe, expect, it } from "vitest";
import {
  AddMemoryOutputSchema,
  CloseSessionOutputSchema,
  CompleteTurnOutputSchema,
  DeleteMemoryOutputSchema,
  GetMemoryOutputSchema,
  MemoryApiLogsOutputSchema,
  MemoryHealthSnapshotSchema,
  MemoryReloadConfigOutputSchema,
  OpenSessionOutputSchema,
  PanelAnalysisOutputSchema,
  PanelItemsOutputSchema,
  PanelOverviewOutputSchema,
  SearchOutputSchema,
  StartTurnOutputSchema
} from "@memmy/local-api-contracts";
import { createMockMemoryClient } from "../../../../tests/support/mock-memory-client.js";

const NOW = "2026-05-29T10:00:00.000Z";

describe("createMockMemoryClient", () => {
  it("returns schema-valid values for the final MemoryClient methods", async () => {
    const client = createMockMemoryClient({ now: () => NOW });

    expect(MemoryHealthSnapshotSchema.parse(await client.health()).ok).toBe(true);
    expect(MemoryReloadConfigOutputSchema.parse(await client.reloadConfig()).activeProfile).toBe("byok");
    expect(OpenSessionOutputSchema.parse(await client.openSession(openSessionInput())).status).toBe("open");
    expect(CloseSessionOutputSchema.parse(await client.closeSession(closeSessionInput())).status).toBe("closed");
    expect(StartTurnOutputSchema.parse(await client.startTurn(startTurnInput())).status).toEqual([]);
    expect(CompleteTurnOutputSchema.parse(await client.completeTurn(completeTurnInput())).jobs).toEqual([]);
    const search = SearchOutputSchema.parse(await client.search({ ...searchInput(), verbose: true }));
    expect(search.debug.hits).toEqual([]);
    expect(AddMemoryOutputSchema.parse(await client.addMemory(addMemoryInput())).id).toBeTruthy();
    expect(GetMemoryOutputSchema.parse(await client.getMemory({ memoryId: "memory-1" })).item.id).toBe("memory-1");
    expect(DeleteMemoryOutputSchema.parse(await client.deleteMemory({ memoryId: "memory-1" })).status).toBe("deleted");
    expect(MemoryApiLogsOutputSchema.parse(await client.memoryApiLogs({ limit: 20, offset: 0 })).logs).toEqual([]);
    expect(PanelOverviewOutputSchema.parse(await client.panelOverview()).counts.memories).toBe(0);
    expect(PanelAnalysisOutputSchema.parse(await client.panelAnalysis()).metrics.avgRecallScore).toBe(0);
    expect(PanelItemsOutputSchema.parse(await client.panelItems(panelItemsInput())).items).toEqual([]);
  });

  it("throws MemoryLayerError for every final method when failureRate is 1", async () => {
    const client = createMockMemoryClient({ failureRate: 1, now: () => NOW });
    const calls: Array<() => Promise<unknown>> = [
      () => client.health(),
      () => client.reloadConfig(),
      () => client.openSession(openSessionInput()),
      () => client.closeSession(closeSessionInput()),
      () => client.startTurn(startTurnInput()),
      () => client.completeTurn(completeTurnInput()),
      () => client.search(searchInput()),
      () => client.addMemory(addMemoryInput()),
      () => client.getMemory({ memoryId: "memory-1" }),
      () => client.deleteMemory({ memoryId: "memory-1" }),
      () => client.memoryApiLogs({ limit: 20, offset: 0 }),
      () => client.panelOverview(),
      () => client.panelAnalysis(),
      () => client.panelItems(panelItemsInput())
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: "internal",
        status: 500,
        message: "mock-induced failure"
      });
    }
  });

  it("exposes exactly the final MemoryClient methods", () => {
    const client = createMockMemoryClient();

    expect(Object.keys(client).sort()).toEqual([
      "addMemory",
      "closeSession",
      "completeTurn",
      "deleteMemory",
      "enqueueImportSummaries",
      "getMemory",
      "getMemoryProcessingStatus",
      "health",
      "memoryApiLogs",
      "openSession",
      "panelAnalysis",
      "panelItems",
      "panelOverview",
      "reloadConfig",
      "retryMemoryProcessing",
      "runWorker",
      "search",
      "startTurn"
    ].sort());
  });
});

/** Handles open session input. */
function openSessionInput() {
  return { sessionId: "host-session-1", workspacePath: "/tmp/project" };
}

/** Closes close session input. */
function closeSessionInput() {
  return { sessionId: "session-1" };
}

/** Starts start turn input. */
function startTurnInput() {
  return { sessionId: "session-1", query: "question", turnId: "turn-1" };
}

/** Handles complete turn input. */
function completeTurnInput() {
  return { turnId: "turn-1", sessionId: "session-1", query: "question", answer: "answer" };
}

/** Handles search input. */
function searchInput() {
  return { query: "retry" };
}

/** Handles add memory input. */
function addMemoryInput() {
  return { content: "remember this", source: "codex" };
}

/** Handles panel items input. */
function panelItemsInput() {
  return { layer: "L1" as const, status: "activated" as const, page: 1 };
}
