/** Mock memory client tests. */
import { describe, expect, it } from "vitest";
import {
  AddMemoryOutputSchema,
  CloseSessionOutputSchema,
  CompleteTurnOutputSchema,
  DeleteMemoryOutputSchema,
  DeletePanelTaskOutputSchema,
  GetMemoryOutputSchema,
  MemoryApiLogsOutputSchema,
  MemoryHealthSnapshotSchema,
  MemoryReloadConfigOutputSchema,
  OpenSessionOutputSchema,
  PanelAnalysisOutputSchema,
  PanelItemsOutputSchema,
  PanelOverviewOutputSchema,
  PanelLogsOutputSchema,
  PanelStatsOutputSchema,
  PanelOverviewStatsOutputSchema,
  PanelBrowseOutputSchema,
  PanelTasksOutputSchema,
  PanelTaskSummariesOutputSchema,
  PanelTaskCheckOutputSchema,
  RecallEvidenceOutputSchema,
  SearchOutputSchema,
  StartTurnOutputSchema
} from "@memmy/local-api-contracts";
import { createMockMemoryClient } from "../../../../tests/support/mock-memory-client.js";

const NOW = "2026-05-29T10:00:00.000Z";

describe("createMockMemoryClient", () => {
  it("implements the synchronized panel and recall contracts without inventing missing detail records", async () => {
    const client = createMockMemoryClient({ now: () => NOW });
    expect(PanelLogsOutputSchema.parse(await client.panelLogs({ limit: 7, offset: 2 })))
      .toMatchObject({ logs: [], total: 0, limit: 7, offset: 2, serverTime: NOW });
    expect(PanelStatsOutputSchema.parse(await client.panelStats()))
      .toMatchObject({ status: "ready", data: { overview: { counts: { memories: 0 } } }, serverTime: NOW });
    expect(PanelOverviewStatsOutputSchema.parse(await client.panelOverviewStats()))
      .toMatchObject({ status: "ready", data: { counts: { memories: 0 } }, serverTime: NOW });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "create" })))
      .toMatchObject({ items: [], total: 0, serverTime: NOW });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "page", viewId: "mock-view", filter: { section: "tasks" } })))
      .toMatchObject({ tasks: [], total: 0, serverTime: NOW });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "check", viewId: "mock-view" })))
      .toMatchObject({ viewId: "mock-view", updated: false, serverTime: NOW });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "release", viewId: "mock-view" })))
      .toEqual({ ok: true });
    expect(PanelTaskSummariesOutputSchema.parse(await client.panelTaskSummaries({ page: 1 })))
      .toMatchObject({ tasks: [], total: 0, serverTime: NOW });
    expect(PanelTaskCheckOutputSchema.parse(await client.panelTaskCheck("task-1")))
      .toEqual({ serverTime: NOW });
    await expect(client.panelLogDetail(1)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(client.panelTaskDetail("task-1")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(client.panelTaskField("task-1", "turn-1", { field: "userText" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(RecallEvidenceOutputSchema.parse(await client.recallEvidence("query-1")))
      .toMatchObject({ queryId: "query-1", hits: [], serverTime: NOW });
    expect(PanelTasksOutputSchema.parse(await client.panelTasks({ page: 1 })))
      .toMatchObject({ tasks: [], total: 0, pageSize: 20, serverTime: NOW });
    expect(DeletePanelTaskOutputSchema.parse(await client.deletePanelTask("task-1")))
      .toEqual({ ok: true, id: "task-1", deletedMemoryIds: [], serverTime: NOW });
  });

  it("keeps failure simulation on every synchronized panel and recall method", async () => {
    const client = createMockMemoryClient({ now: () => NOW, failureRate: 1 });
    const reads = [
      () => client.panelLogs({}), () => client.panelLogDetail(1), () => client.panelStats(),
      () => client.panelOverviewStats(), () => client.panelBrowse({ op: "create" }),
      () => client.panelTaskSummaries({ page: 1 }), () => client.panelTaskCheck("task-1"),
      () => client.panelTaskDetail("task-1"), () => client.panelTaskField("task-1", "turn-1", { field: "userText" }),
      () => client.recallEvidence("query-1"), () => client.panelTasks({ page: 1 }), () => client.deletePanelTask("task-1")
    ];
    for (const read of reads) await expect(read()).rejects.toMatchObject({ code: "internal", status: 500, message: "mock-induced failure" });
  });

  it("returns schema-valid values for the final MemoryClient methods", async () => {
    const client = createMockMemoryClient({ now: () => NOW });

    expect(MemoryHealthSnapshotSchema.parse(await client.health()).ok).toBe(true);
    expect(MemoryReloadConfigOutputSchema.parse(await client.reloadConfig()).models.summary.routing).toBe("fixed");
    expect(OpenSessionOutputSchema.parse(await client.openSession(openSessionInput())).status).toBe("open");
    expect(CloseSessionOutputSchema.parse(await client.closeSession(closeSessionInput())).status).toBe("closed");
    expect(StartTurnOutputSchema.parse(await client.startTurn(startTurnInput())).status).toEqual([]);
    expect(CompleteTurnOutputSchema.parse(await client.completeTurn(completeTurnInput())).jobs).toEqual([]);
    const search = SearchOutputSchema.parse(await client.search({ ...searchInput(), verbose: true }));
    expect(search).toHaveProperty("debug.hits", []);
    expect(AddMemoryOutputSchema.parse(await client.addMemory(addMemoryInput())).id).toBeTruthy();
    expect(GetMemoryOutputSchema.parse(await client.getMemory({ memoryId: "memory-1" })).item.id).toBe("memory-1");
    expect(DeleteMemoryOutputSchema.parse(await client.deleteMemory({ memoryId: "memory-1" })).status).toBe("deleted");
    expect(await client.approveObservedSkill("skill-1")).toEqual({ id: "skill-1", status: "activated", serverTime: NOW });
    expect(await client.updateObservedSkill("skill-1", { body: "Updated guide", expectedVersion: 1 })).toEqual({
      id: "skill-1", status: "activated", version: 2, serverTime: NOW
    });
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
      () => client.approveObservedSkill("skill-1"),
      () => client.updateObservedSkill("skill-1", { body: "Updated guide", expectedVersion: 1 }),
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
      "approveObservedSkill",
      "closeSession",
      "completeTurn",
      "completeSourceTurn",
      "deleteMemory",
      "deletePanelTask",
      "enqueueImportSummaries",
      "getMemory",
      "getMemoryProcessingStatus",
      "getMemoryTokenBudget",
      "health",
      "memoryApiLogs",
      "openSession",
      "panelAnalysis",
      "panelItems",
      "panelOverview",
      "panelLogs",
      "panelLogDetail",
      "panelStats",
      "panelOverviewStats",
      "panelBrowse",
      "panelTaskSummaries",
      "panelTaskCheck",
      "panelTaskDetail",
      "panelTaskField",
      "panelTasks",
      "recallEvidence",
      "reloadConfig",
      "retryMemoryProcessing",
      "runWorker",
      "search",
      "startTurn",
      "updateObservedSkill"
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
