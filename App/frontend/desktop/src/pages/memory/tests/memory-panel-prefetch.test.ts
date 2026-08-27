/** Memory panel prefetch tests. */
import type { MemoryApiLogsOutput, PanelItemsInput } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, MessageValues } from "../../../i18n/messages.js";
import { readMemoryPanelCache, memoryPanelCacheKey, memoryPanelLatestCacheKey } from "../memory-panel-cache.js";
import { prefetchMemoryPanelCaches, scheduleMemoryPanelCachePrefetch } from "../memory-panel-prefetch.js";
import { createMemoryRuntimeClientStub, memoryDetailFixture, panelAnalysisFixture, panelItemsOutput, panelOverviewFixture } from "./fixtures.js";
import { mockMemoryItems } from "./memory-runtime-fixtures.js";

const t = (key: MessageKey, values?: MessageValues) => {
  const suffix = values ? ` ${JSON.stringify(values)}` : "";
  return `${key}${suffix}`;
};

describe("memory panel cache prefetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefetches default memory management views into sessionStorage cache", async () => {
    vi.stubGlobal("window", { sessionStorage: createMemoryStorage() });
    const client = createMemoryRuntimeClientStub({
      getPanelOverview: vi.fn(async () => panelOverviewFixture),
      getPanelAnalysis: vi.fn(async () => panelAnalysisFixture),
      listPanelItems: vi.fn(async (input: PanelItemsInput) => {
        const layer = input.layer ?? "L1";
        return panelItemsOutput(mockMemoryItems.filter((item) => item.memoryLayer === layer));
      }),
      getMemory: vi.fn(async () => memoryDetailFixture),
      listPanelTasks: vi.fn(async () => ({
        tasks: [],
        page: 1,
        pageSize: 20 as const,
        total: 0,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
        serverTime: "2026-06-03T10:00:00.000Z"
      })),
      listMemoryLogs: vi.fn(async () => memoryApiLogsFixture())
    });

    await prefetchMemoryPanelCaches({ client, language: "en-US", t });

    expect(readMemoryPanelCache(memoryPanelCacheKey("overview"))).toEqual(panelOverviewFixture);
    expect(readMemoryPanelCache(memoryPanelCacheKey("analytics"))).toEqual(panelAnalysisFixture);
    expect(readMemoryPanelCache(memoryPanelCacheKey("memories", "", "", 1))).toMatchObject({ items: [expect.objectContaining({ memoryLayer: "L1" })] });
    expect(readMemoryPanelCache(memoryPanelLatestCacheKey("memories"))).toBeNull();
    expect(readMemoryPanelCache(memoryPanelCacheKey("policies", "", 1))).toMatchObject({ items: [expect.objectContaining({ memoryLayer: "L2" })] });
    expect(readMemoryPanelCache(memoryPanelCacheKey("world-model", "", 1))).toMatchObject({ items: [expect.objectContaining({ memoryLayer: "L3" })] });
    expect(readMemoryPanelCache(memoryPanelCacheKey("skills", "", 1))).toMatchObject({ items: [expect.objectContaining({ memoryLayer: "Skill" })] });
    expect(readMemoryPanelCache(memoryPanelCacheKey("tasks", "en-US", "", 1))).toMatchObject({ tasks: expect.any(Array) });
    expect(readMemoryPanelCache(memoryPanelLatestCacheKey("tasks:en-US"))).toBeNull();
    expect(readMemoryPanelCache(memoryPanelCacheKey("logs", "", "", 1))).toMatchObject({ logs: expect.any(Array) });
    expect(readMemoryPanelCache(memoryPanelLatestCacheKey("logs"))).toMatchObject({ logs: expect.any(Array) });
  });

  it("schedules prefetch without blocking the caller", () => {
    const scheduled: Array<() => void> = [];
    const client = createMemoryRuntimeClientStub();

    scheduleMemoryPanelCachePrefetch({
      client,
      language: "zh-CN",
      t,
      delayMs: 123,
      schedule(callback, delayMs) {
        expect(delayMs).toBe(123);
        scheduled.push(callback);
      }
    });

    expect(scheduled).toHaveLength(1);
  });
});

function memoryApiLogsFixture(): MemoryApiLogsOutput {
  return {
    logs: [],
    total: 0,
    limit: 20,
    offset: 0,
    serverTime: "2026-06-03T10:00:00.000Z"
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}
