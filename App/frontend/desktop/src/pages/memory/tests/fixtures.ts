/** Fixtures tests. */
import type { MemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import type { PanelItemsOutput } from "@memmy/local-api-contracts";
import {
  mockMemoryDetails,
  mockMemoryItems,
  mockPanelAnalysis,
  mockPanelOverview
} from "./memory-runtime-fixtures.js";

export const memoryListItemFixture = mockMemoryItems[1]!;
export const panelItemsFixture = panelItemsOutput([memoryListItemFixture]);
export const memoryDetailFixture = mockMemoryDetails["trace:memory-trace-1"]!;
export const skillPanelItemsFixture = panelItemsOutput([mockMemoryItems[3]!]);
export const skillPanelDetailFixture = mockMemoryDetails["skill:skill-memory-1"]!;
export const panelOverviewFixture = mockPanelOverview;
export const panelAnalysisFixture = mockPanelAnalysis;

export function panelItemsOutput(items: PanelItemsOutput["items"]): PanelItemsOutput {
  return {
    items,
    page: 1,
    pageSize: 20,
    total: items.length,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    serverTime: "2026-06-03T10:00:00.000Z"
  };
}

/** Creates create memory runtime client stub. */
export function createMemoryRuntimeClientStub(overrides: Partial<MemoryRuntimeClient> = {}): MemoryRuntimeClient {
  const notImplemented = async () => {
    throw new Error("test client method is not implemented");
  };

  return {
    health: notImplemented,
    reloadConfig: notImplemented,
    openSession: notImplemented,
    closeSession: notImplemented,
    startTurn: notImplemented,
    completeTurn: notImplemented,
    search: notImplemented,
    addMemory: notImplemented,
    getMemory: notImplemented,
    deleteMemory: notImplemented,
    listMemoryLogs: notImplemented,
    getPanelOverview: notImplemented,
    getPanelAnalysis: notImplemented,
    listPanelItems: notImplemented,
    ...overrides
  } as MemoryRuntimeClient;
}
