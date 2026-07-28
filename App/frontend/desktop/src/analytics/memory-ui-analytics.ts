import type { AgentSourceScanMode } from "@memmy/local-api-contracts";
import type {
  MemoryUiAnalyticsEvent,
  MemoryUiDetailOpenedEvent,
  MemoryUiDeletedEvent,
  MemoryUiPanelRefreshedEvent,
  MemoryUiSearchSubmittedEvent,
  MemoryUiSourceScanCompletedEvent,
  MemoryUiSourceScanFailedEvent,
  MemoryUiSourceScanStartedEvent
} from "./analytics-events.js";
import { gtagEvent } from "./gtag-init.js";
import { resolveMemorySubPagePath } from "./page-view.js";
import type { MemorySubPageId } from "../pages/memory-page.js";

export const MEMORY_UI_ANALYTICS_EVENTS = {
  searchSubmitted: "memory_ui_search_submitted",
  detailOpened: "memory_detail_opened",
  deleted: "memory_deleted",
  panelRefreshed: "memory_panel_refreshed",
  sourceScanStarted: "memory_source_scan_started",
  sourceScanCompleted: "memory_source_scan_completed",
  sourceScanFailed: "memory_source_scan_failed"
} as const;

export type MemoryUiSubPage = MemorySubPageId | "onboarding";

export interface MemoryUiBaseParamsInput {
  subPage: MemoryUiSubPage;
  filterLayer: string;
  pagePath?: string;
}

export interface MemoryUiScanAnalyticsContext {
  sourceId: string;
  scanMode: AgentSourceScanMode;
  pagePath: string;
  subPage: MemoryUiSubPage;
  startedAt: number;
}

const DEFAULT_SCAN_MODE: AgentSourceScanMode = "incremental";
const scanContextByJobId = new Map<string, MemoryUiScanAnalyticsContext>();
const trackedScanOutcomeJobIds = new Set<string>();

export function buildMemoryUiFilterLayer(base: string, suffix?: string): string {
  if (!suffix) {
    return base;
  }
  return `${base}:${suffix}`;
}

export function buildLogsFilterLayer(
  tool: "" | "memory_add" | "memory_search",
  sourceAgent = ""
): string {
  let layer = "logs";
  if (tool) {
    layer = buildMemoryUiFilterLayer(layer, tool);
  }
  if (sourceAgent) {
    layer = buildMemoryUiFilterLayer(layer, sourceAgent);
  }
  return layer;
}

export function resolveMemoryUiPagePath(subPage: MemoryUiSubPage): string {
  if (subPage === "onboarding") {
    return "/onboarding";
  }
  return resolveMemorySubPagePath(subPage);
}

function buildMemoryUiBaseParams(input: MemoryUiBaseParamsInput): {
  page_path: string;
  sub_page: string;
  filter_layer: string;
} {
  return {
    page_path: input.pagePath ?? resolveMemoryUiPagePath(input.subPage),
    sub_page: input.subPage,
    filter_layer: input.filterLayer
  };
}

function compactAnalyticsParams(
  params: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
  );
}

export function buildMemoryUiSearchSubmittedEvent(input: MemoryUiBaseParamsInput & {
  resultCount: number;
}): MemoryUiSearchSubmittedEvent {
  return {
    name: MEMORY_UI_ANALYTICS_EVENTS.searchSubmitted,
    params: compactAnalyticsParams({
      ...buildMemoryUiBaseParams(input),
      result_count: input.resultCount
    }),
    consentTier: "basic"
  };
}

export function buildMemoryUiDetailOpenedEvent(input: MemoryUiBaseParamsInput): MemoryUiDetailOpenedEvent {
  return {
    name: MEMORY_UI_ANALYTICS_EVENTS.detailOpened,
    params: buildMemoryUiBaseParams(input),
    consentTier: "basic"
  };
}

export function buildMemoryUiDeletedEvent(input: MemoryUiBaseParamsInput): MemoryUiDeletedEvent {
  return {
    name: MEMORY_UI_ANALYTICS_EVENTS.deleted,
    params: buildMemoryUiBaseParams(input),
    consentTier: "basic"
  };
}

export function buildMemoryUiPanelRefreshedEvent(input: MemoryUiBaseParamsInput & {
  resultCount: number;
}): MemoryUiPanelRefreshedEvent {
  return {
    name: MEMORY_UI_ANALYTICS_EVENTS.panelRefreshed,
    params: compactAnalyticsParams({
      ...buildMemoryUiBaseParams(input),
      result_count: input.resultCount
    }),
    consentTier: "basic"
  };
}

export function normalizeScanMode(mode?: AgentSourceScanMode): AgentSourceScanMode {
  return mode ?? DEFAULT_SCAN_MODE;
}

export function recordScanStarted(jobId: string, input: {
  sourceId: string;
  scanMode?: AgentSourceScanMode;
  pagePath: string;
  subPage: MemoryUiSubPage;
}): void {
  scanContextByJobId.set(jobId, {
    sourceId: input.sourceId,
    scanMode: normalizeScanMode(input.scanMode),
    pagePath: input.pagePath,
    subPage: input.subPage,
    startedAt: Date.now()
  });
}

export function resolveScanAnalyticsContext(jobId: string): MemoryUiScanAnalyticsContext | undefined {
  const context = scanContextByJobId.get(jobId);
  if (!context) {
    return undefined;
  }
  scanContextByJobId.delete(jobId);
  return context;
}

function buildScanEventParams(input: {
  pagePath: string;
  subPage: MemoryUiSubPage;
  sourceId: string;
  scanMode: AgentSourceScanMode;
  durationMs?: number;
}): Record<string, string | number | boolean> {
  return compactAnalyticsParams({
    page_path: input.pagePath,
    sub_page: input.subPage,
    filter_layer: input.subPage === "sources" ? "sources" : "onboarding",
    source_id: input.sourceId,
    scan_mode: input.scanMode,
    duration_ms: input.durationMs
  });
}

export function buildMemorySourceScanStartedEvent(input: {
  pagePath: string;
  subPage: MemoryUiSubPage;
  sourceId: string;
  scanMode?: AgentSourceScanMode;
}): MemoryUiSourceScanStartedEvent {
  return {
    name: MEMORY_UI_ANALYTICS_EVENTS.sourceScanStarted,
    params: buildScanEventParams({
      pagePath: input.pagePath,
      subPage: input.subPage,
      sourceId: input.sourceId,
      scanMode: normalizeScanMode(input.scanMode)
    }),
    consentTier: "basic"
  };
}

export function buildMemorySourceScanCompletedEvent(input: {
  jobId: string;
  sourceId: string;
  durationMs?: number;
}): MemoryUiSourceScanCompletedEvent {
  const context = resolveScanAnalyticsContext(input.jobId);
  return {
    name: MEMORY_UI_ANALYTICS_EVENTS.sourceScanCompleted,
    params: buildScanEventParams({
      pagePath: context?.pagePath ?? resolveMemoryUiPagePath("sources"),
      subPage: context?.subPage ?? "sources",
      sourceId: input.sourceId,
      scanMode: context?.scanMode ?? DEFAULT_SCAN_MODE,
      durationMs: input.durationMs ?? (context ? Date.now() - context.startedAt : undefined)
    }),
    consentTier: "basic"
  };
}

export function buildMemorySourceScanFailedEvent(input: {
  jobId?: string;
  pagePath?: string;
  subPage?: MemoryUiSubPage;
  sourceId: string;
  scanMode?: AgentSourceScanMode;
  durationMs?: number;
}): MemoryUiSourceScanFailedEvent {
  const context = input.jobId ? resolveScanAnalyticsContext(input.jobId) : undefined;
  return {
    name: MEMORY_UI_ANALYTICS_EVENTS.sourceScanFailed,
    params: buildScanEventParams({
      pagePath: input.pagePath ?? context?.pagePath ?? resolveMemoryUiPagePath("sources"),
      subPage: input.subPage ?? context?.subPage ?? "sources",
      sourceId: input.sourceId,
      scanMode: input.scanMode ?? context?.scanMode ?? DEFAULT_SCAN_MODE,
      durationMs: input.durationMs ?? (context ? Date.now() - context.startedAt : 0)
    }),
    consentTier: "basic"
  };
}

export function trackMemoryUiEvent(event: MemoryUiAnalyticsEvent): void {
  gtagEvent(event.name, event.params);
}

export function trackAgentSourceScanOutcome(input: {
  jobId: string;
  sourceId: string;
  succeeded: boolean;
}): void {
  const jobId = input.jobId.trim();
  if (!jobId || trackedScanOutcomeJobIds.has(jobId)) {
    return;
  }
  trackedScanOutcomeJobIds.add(jobId);

  if (input.succeeded) {
    trackMemoryUiEvent(buildMemorySourceScanCompletedEvent(input));
    return;
  }
  trackMemoryUiEvent(buildMemorySourceScanFailedEvent({
    jobId: input.jobId,
    sourceId: input.sourceId
  }));
}

/** Test helper to reset in-memory scan context between cases. */
export function resetMemoryUiScanAnalyticsForTests(): void {
  scanContextByJobId.clear();
  trackedScanOutcomeJobIds.clear();
}
