import type {
  MemoryApiLogToolName,
  PanelItemsInput,
  PanelItemsOutput,
  PanelOverviewOutput,
  PanelAnalysisOutput,
  MemoryApiLogsOutput
} from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import type { MessageKey, MessageValues, ResolvedLanguage } from "../../i18n/messages.js";
import {
  memoryPanelCacheKey,
  memoryPanelLatestCacheKey,
  writeMemoryPanelCache,
  writeMemoryPanelCaches
} from "./memory-panel-cache.js";
import { normalizePage } from "./memory-pagination.js";
import { loadTasksData, type MemoryTasksOutput } from "./tasks-sub-page.js";

type Translate = (key: MessageKey, values?: MessageValues) => string;
type PrefetchLogger = Pick<Console, "warn">;

interface MemoryPanelPrefetchTask {
  name: string;
  run: () => Promise<void>;
}

export interface PrefetchMemoryPanelCachesInput {
  client: MemoryRuntimeClient;
  language: ResolvedLanguage;
  t: Translate;
  logger?: PrefetchLogger;
}

export interface ScheduleMemoryPanelCachePrefetchInput extends PrefetchMemoryPanelCachesInput {
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

const PANEL_FIRST_PAGE = 1;
const LOGS_PAGE_SIZE = 20;
const LOG_TOOLS: MemoryApiLogToolName[] = ["memory_add", "memory_search"];
const DEFAULT_PREFETCH_DELAY_MS = 800;

let activePrefetch: Promise<void> | null = null;

export function scheduleMemoryPanelCachePrefetch(input: ScheduleMemoryPanelCachePrefetchInput): void {
  const schedule = input.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  schedule(() => {
    void prefetchMemoryPanelCaches(input).catch((error) => {
      (input.logger ?? console).warn("memory panel cache prefetch failed", error);
    });
  }, input.delayMs ?? DEFAULT_PREFETCH_DELAY_MS);
}

export function prefetchMemoryPanelCaches(input: PrefetchMemoryPanelCachesInput): Promise<void> {
  if (activePrefetch) {
    return activePrefetch;
  }

  activePrefetch = runMemoryPanelPrefetch(input).finally(() => {
    activePrefetch = null;
  });
  return activePrefetch;
}

async function runMemoryPanelPrefetch(input: PrefetchMemoryPanelCachesInput): Promise<void> {
  const logger = input.logger ?? console;
  await runPrefetchTasks([
    panelOverviewTask(input.client),
    panelItemsTask(input.client, "memories", { layer: "L1", page: PANEL_FIRST_PAGE })
  ], logger);

  await runPrefetchTasks([
    panelAnalysisTask(input.client),
    panelItemsTask(input.client, "policies", { layer: "L2", page: PANEL_FIRST_PAGE }),
    panelItemsTask(input.client, "world-model", { layer: "L3", page: PANEL_FIRST_PAGE }),
    panelItemsTask(input.client, "skills", { layer: "Skill", page: PANEL_FIRST_PAGE }),
    tasksTask(input.client, input.language, input.t),
    logsTask(input.client)
  ], logger);
}

async function runPrefetchTasks(tasks: readonly MemoryPanelPrefetchTask[], logger: PrefetchLogger): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => task.run()));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.warn(`memory panel cache prefetch task failed: ${tasks[index]?.name ?? "unknown"}`, result.reason);
    }
  });
}

function panelOverviewTask(client: MemoryRuntimeClient): MemoryPanelPrefetchTask {
  return {
    name: "overview",
    async run() {
      const data: PanelOverviewOutput = await client.getPanelOverview();
      writeMemoryPanelCache(memoryPanelCacheKey("overview"), data);
    }
  };
}

function panelAnalysisTask(client: MemoryRuntimeClient): MemoryPanelPrefetchTask {
  return {
    name: "analytics",
    async run() {
      const data: PanelAnalysisOutput = await client.getPanelAnalysis();
      writeMemoryPanelCache(memoryPanelCacheKey("analytics"), data);
    }
  };
}

function panelItemsTask(client: MemoryRuntimeClient, section: "memories" | "policies" | "world-model" | "skills", input: PanelItemsInput): MemoryPanelPrefetchTask {
  return {
    name: section,
    async run() {
      const page = normalizePage(input.page);
      const query = input.q?.trim() ?? "";
      const sourceAgent = input.excludedSourceAgents?.length ? "__other__" : input.sourceAgent?.trim() ?? "";
      const data: PanelItemsOutput = await client.listPanelItems({ ...input, page });
      writeMemoryPanelCaches(section === "memories"
        ? [memoryPanelCacheKey(section, query, sourceAgent, page)]
        : [memoryPanelCacheKey(section, query, page), memoryPanelLatestCacheKey(section)], data);
    }
  };
}

function tasksTask(client: MemoryRuntimeClient, language: ResolvedLanguage, t: Translate): MemoryPanelPrefetchTask {
  return {
    name: "tasks",
    async run() {
      const data: MemoryTasksOutput = await loadTasksData(client, "", PANEL_FIRST_PAGE, t);
      writeMemoryPanelCache(memoryPanelCacheKey("tasks", language, "", PANEL_FIRST_PAGE), data);
    }
  };
}

function logsTask(client: MemoryRuntimeClient): MemoryPanelPrefetchTask {
  return {
    name: "logs",
    async run() {
      const data: MemoryApiLogsOutput = await client.listMemoryLogs({
        tools: LOG_TOOLS,
        limit: LOGS_PAGE_SIZE,
        offset: 0
      });
      writeMemoryPanelCaches([
        memoryPanelCacheKey("logs", "", "", PANEL_FIRST_PAGE),
        memoryPanelLatestCacheKey("logs")
      ], data);
    }
  };
}
