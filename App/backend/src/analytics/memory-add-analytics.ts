import { createHash } from "node:crypto";
import {
  compactAnalyticsParams,
  createQueuedAnalytics,
  errorCodeFromUnknown,
  readAnalyticsClientId,
  type AnalyticsAppEdition,
  type AnalyticsAppEnv,
  type AnalyticsParams,
} from "./analytics-transport.js";

/** Matches Desktop memory lifecycle event names (`memory_desktop_*`). */
export const MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS = {
  addStarted: "memory_desktop_add_started",
  addSucceeded: "memory_desktop_add_succeeded",
  addFailed: "memory_desktop_add_failed",
} as const;

export const MEMORY_DESKTOP_ADD_ENTRYPOINT = "memmy-desktop";
export const MEMORY_DESKTOP_ADD_STORAGE_BACKEND = "memmy-memory";
export const MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN = "agent_source_scan";
export const MEMORY_DESKTOP_ADD_LAYER_L1 = "L1";

export type MemoryDesktopAddScanMode = "initial_subset" | "incremental" | "full";

const MEMORY_ADD_ANALYTICS_SOURCE = "memmy-agent";

export type MemoryDesktopAddAnalytics = {
  trackAddStarted: (input: MemoryDesktopScanAddBaseInput) => void;
  trackAddSucceeded: (input: MemoryDesktopScanAddBaseInput & {
    durationMs: number;
    storedCount: number;
  }) => void;
  trackAddFailed: (input: MemoryDesktopScanAddBaseInput & {
    durationMs: number;
    error?: unknown;
    errorCode?: string;
  }) => void;
  flush: () => Promise<void>;
};

export type MemoryDesktopScanAddBaseInput = {
  adapterId: string;
  /** Present for agent-source scan/import paths; omitted when unavailable. */
  scanMode?: MemoryDesktopAddScanMode;
  conversationId?: string | null;
  turnId?: string | null;
};

export function hashAnalyticsId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildMemoryDesktopScanAddParams(input: MemoryDesktopScanAddBaseInput): AnalyticsParams {
  const sessionIdHash = hashAnalyticsId(input.conversationId);
  const turnIdHash = hashAnalyticsId(input.turnId);
  return compactAnalyticsParams({
    entrypoint: MEMORY_DESKTOP_ADD_ENTRYPOINT,
    adapter_id: input.adapterId,
    storage_backend: MEMORY_DESKTOP_ADD_STORAGE_BACKEND,
    mode: MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
    layer: MEMORY_DESKTOP_ADD_LAYER_L1,
    ...(input.scanMode ? { scan_mode: input.scanMode } : {}),
    ...(sessionIdHash ? { session_id_hash: sessionIdHash } : {}),
    ...(turnIdHash ? { turn_id_hash: turnIdHash } : {}),
  });
}

export function createMemoryDesktopAddAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getInstallationId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  appEnv?: AnalyticsAppEnv | null;
  appEdition?: AnalyticsAppEdition | null;
  debugMode?: boolean | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
} = {}): MemoryDesktopAddAnalytics {
  const queued = createQueuedAnalytics({
    source: MEMORY_ADD_ANALYTICS_SOURCE,
    getClientId: options.getClientId ?? (() => readAnalyticsClientId()),
    getInstallationId: options.getInstallationId,
    getUserId: options.getUserId,
    getUserMode: options.getUserMode,
    appEnv: options.appEnv,
    appEdition: options.appEdition,
    debugMode: options.debugMode,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  });

  return {
    trackAddStarted(input) {
      queued.track(MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addStarted, buildMemoryDesktopScanAddParams(input));
    },
    trackAddSucceeded(input) {
      queued.track(
        MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addSucceeded,
        compactAnalyticsParams({
          ...buildMemoryDesktopScanAddParams(input),
          duration_ms: Math.max(0, Math.trunc(input.durationMs)),
          success: true,
          stored_count: Math.max(0, Math.trunc(input.storedCount)),
        }),
      );
    },
    trackAddFailed(input) {
      queued.track(
        MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addFailed,
        compactAnalyticsParams({
          ...buildMemoryDesktopScanAddParams(input),
          duration_ms: Math.max(0, Math.trunc(input.durationMs)),
          success: false,
          error_code: input.errorCode ?? errorCodeFromUnknown(input.error),
        }),
      );
    },
    flush() {
      return queued.flush();
    },
  };
}
