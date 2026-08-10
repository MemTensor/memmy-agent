import { createHash } from "node:crypto";
import {
  compactAnalyticsParams,
  createQueuedAnalytics,
  elapsedMs,
  errorCodeFromUnknown,
  type AnalyticsParams,
  type QueuedAnalytics,
} from "./cloud-analytics.js";

export type { AnalyticsParams };

export const MEMORY_ANALYTICS_ENTRYPOINTS = {
  cli: "memmy-cli",
  desktop: "memmy-desktop",
} as const;

export type MemoryAnalyticsEntrypoint =
  (typeof MEMORY_ANALYTICS_ENTRYPOINTS)[keyof typeof MEMORY_ANALYTICS_ENTRYPOINTS];

/** Local Memory HTTP service used by memmy-agent. */
export const MEMORY_OP_STORAGE_BACKEND = "memmy-memory";

export const MEMORY_OP_MODES = {
  turnStart: "turn_start",
  tool: "tool",
  turnComplete: "turn_complete",
  /** Agent-source scan ingestion via memory add (Desktop local backend). */
  agentSourceScan: "agent_source_scan",
} as const;

export type MemoryOpMode = (typeof MEMORY_OP_MODES)[keyof typeof MEMORY_OP_MODES];

export const MEMORY_SESSION_CLOSE_TRIGGERS = {
  reset: "reset",
  quit: "quit",
  interrupt: "interrupt",
} as const;

export type MemorySessionCloseTrigger =
  (typeof MEMORY_SESSION_CLOSE_TRIGGERS)[keyof typeof MEMORY_SESSION_CLOSE_TRIGGERS];

export type MemoryLifecycleEventKey =
  | "sessionOpened"
  | "sessionClosed"
  | "turnStarted"
  | "turnCompleted"
  | "turnFailed"
  | "searchStarted"
  | "searchSucceeded"
  | "searchFailed"
  | "addStarted"
  | "addSucceeded"
  | "addFailed"
  | "getStarted"
  | "getSucceeded"
  | "getFailed";

const EVENT_SUFFIXES: Record<MemoryLifecycleEventKey, string> = {
  sessionOpened: "session_opened",
  sessionClosed: "session_closed",
  turnStarted: "turn_started",
  turnCompleted: "turn_completed",
  turnFailed: "turn_failed",
  searchStarted: "search_started",
  searchSucceeded: "search_succeeded",
  searchFailed: "search_failed",
  addStarted: "add_started",
  addSucceeded: "add_succeeded",
  addFailed: "add_failed",
  getStarted: "get_started",
  getSucceeded: "get_succeeded",
  getFailed: "get_failed",
};

/** CLI event names (`memory_*`). */
export const MEMORY_ANALYTICS_EVENTS = memoryAnalyticsEventsFor(
  MEMORY_ANALYTICS_ENTRYPOINTS.cli,
);

/** Desktop webui event names (`memory_desktop_*`). */
export const MEMORY_DESKTOP_ANALYTICS_EVENTS = memoryAnalyticsEventsFor(
  MEMORY_ANALYTICS_ENTRYPOINTS.desktop,
);

export type MemoryAnalyticsEventName = string;

export type MemoryLifecycleAnalytics = QueuedAnalytics;

export function memoryAnalyticsEventsFor(
  entrypoint: MemoryAnalyticsEntrypoint,
): Record<MemoryLifecycleEventKey, string> {
  const prefix =
    entrypoint === MEMORY_ANALYTICS_ENTRYPOINTS.desktop ? "memory_desktop_" : "memory_";
  return Object.fromEntries(
    (Object.keys(EVENT_SUFFIXES) as MemoryLifecycleEventKey[]).map((key) => [
      key,
      `${prefix}${EVENT_SUFFIXES[key]}`,
    ]),
  ) as Record<MemoryLifecycleEventKey, string>;
}

/**
 * Desktop dialog path uses websocket session keys / webui metadata.
 * Everything else (CLI TUI / classic) is memmy-cli.
 */
export function resolveMemoryAnalyticsEntrypoint(input: {
  sessionKey?: string | null;
  channel?: string | null;
  webui?: unknown;
} = {}): MemoryAnalyticsEntrypoint {
  if (input.webui === true) return MEMORY_ANALYTICS_ENTRYPOINTS.desktop;
  if (input.channel === "websocket") return MEMORY_ANALYTICS_ENTRYPOINTS.desktop;
  if (typeof input.sessionKey === "string" && input.sessionKey.startsWith("websocket:")) {
    return MEMORY_ANALYTICS_ENTRYPOINTS.desktop;
  }
  return MEMORY_ANALYTICS_ENTRYPOINTS.cli;
}

export function hashId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function normalizeSessionCloseTrigger(
  value: string | null | undefined,
): MemorySessionCloseTrigger | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "reset" || trimmed === "quit" || trimmed === "interrupt") return trimmed;
  return undefined;
}

export function createMemoryLifecycleAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  source?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
} = {}): MemoryLifecycleAnalytics {
  return createQueuedAnalytics({
    source: options.source ?? "memmy-agent",
    getClientId: options.getClientId,
    getUserId: options.getUserId,
    getUserMode: options.getUserMode,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  });
}

export function hasInjectedContextValue(injectedContext: unknown): boolean {
  if (typeof injectedContext === "string") return Boolean(injectedContext.trim());
  if (!injectedContext || typeof injectedContext !== "object" || Array.isArray(injectedContext)) {
    return false;
  }
  const markdown = (injectedContext as { markdown?: unknown }).markdown;
  return typeof markdown === "string" && Boolean(markdown.trim());
}

export function sourceMemoryCountFromResponse(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const ids = (response as { sourceMemoryIds?: unknown }).sourceMemoryIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.trim()).length : 0;
}

/** Shared params for search / add / get op events. */
export function memoryOperationBaseParams(input: {
  entrypoint: MemoryAnalyticsEntrypoint;
  adapterId: string;
  mode: MemoryOpMode;
  layer?: string | null;
  sessionIdHash?: string;
  turnIdHash?: string;
  episodeIdHash?: string;
}): AnalyticsParams {
  return compactAnalyticsParams({
    entrypoint: input.entrypoint,
    adapter_id: input.adapterId,
    storage_backend: MEMORY_OP_STORAGE_BACKEND,
    mode: input.mode,
    ...(input.layer?.trim() ? { layer: input.layer.trim() } : {}),
    ...(input.sessionIdHash ? { session_id_hash: input.sessionIdHash } : {}),
    ...(input.turnIdHash ? { turn_id_hash: input.turnIdHash } : {}),
    ...(input.episodeIdHash ? { episode_id_hash: input.episodeIdHash } : {}),
  });
}

export function formatMemoryLayers(layers: unknown): string | undefined {
  if (typeof layers === "string" && layers.trim()) return layers.trim();
  if (!Array.isArray(layers)) return undefined;
  const values = layers
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
  return values.length ? values.join(",") : undefined;
}

/** Prefer sourceMemoryIds; fall back to hits arrays on search responses. */
export function hitCountFromSearchResponse(response: unknown): number {
  const fromIds = sourceMemoryCountFromResponse(response);
  if (fromIds > 0) return fromIds;
  if (!response || typeof response !== "object") return 0;
  const record = response as { hits?: unknown; debug?: { hits?: unknown } };
  const hits = Array.isArray(record.hits)
    ? record.hits
    : Array.isArray(record.debug?.hits)
      ? record.debug.hits
      : [];
  return hits.length;
}

export function hitCountFromGetResponse(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? 1 : 0;
}

export function storedCountFromCompleteTurn(response: unknown): number {
  if (!response || typeof response !== "object") return 0;
  const record = response as { l1MemoryIds?: unknown; l1MemoryId?: unknown };
  if (Array.isArray(record.l1MemoryIds)) {
    const count = record.l1MemoryIds.filter((id) => typeof id === "string" && id.trim()).length;
    if (count > 0) return count;
  }
  return typeof record.l1MemoryId === "string" && record.l1MemoryId.trim() ? 1 : 0;
}

export { compactAnalyticsParams, elapsedMs, errorCodeFromUnknown };
