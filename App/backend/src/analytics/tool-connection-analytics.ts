import {
  compactAnalyticsParams,
  createQueuedAnalytics,
  errorCodeFromUnknown,
  readAnalyticsClientId,
  type AnalyticsAppEdition,
  type AnalyticsAppEnv,
  type AnalyticsParams,
} from "./analytics-transport.js";

export const TOOL_CONNECTION_ANALYTICS_EVENTS = {
  connection: "tool_connection",
} as const;

export type ToolConnectionAnalyticsEventName =
  (typeof TOOL_CONNECTION_ANALYTICS_EVENTS)[keyof typeof TOOL_CONNECTION_ANALYTICS_EVENTS];

export type ToolConnectionSurface = "channel" | "integration";
export type ToolConnectionEvent = "connected" | "disconnected" | "failed";

const TOOL_CONNECTION_ANALYTICS_SOURCE = "memmy-backend";

export type ToolConnectionAnalytics = {
  trackConnection: (input: ToolConnectionTrackInput) => void;
  flush: () => Promise<void>;
};

export type ToolConnectionTrackInput = {
  surface: ToolConnectionSurface;
  toolkit: string;
  event: ToolConnectionEvent;
  errorCode?: string;
  occurredAtMs?: number;
  error?: unknown;
};

export function buildToolConnectionParams(input: ToolConnectionTrackInput): AnalyticsParams {
  const toolkit = input.toolkit.trim();
  const errorCode =
    input.errorCode?.trim() ||
    (input.event === "failed" && input.error !== undefined ? errorCodeFromUnknown(input.error) : undefined);
  const occurredAtMs =
    typeof input.occurredAtMs === "number" && Number.isFinite(input.occurredAtMs)
      ? Math.trunc(input.occurredAtMs)
      : Date.now();

  return compactAnalyticsParams({
    surface: input.surface,
    toolkit,
    event: input.event,
    occurred_at_ms: occurredAtMs,
    ...(errorCode ? { error_code: errorCode } : {}),
  });
}

export function createToolConnectionAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getInstallationId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  appEnv?: AnalyticsAppEnv | null;
  appEdition?: AnalyticsAppEdition | null;
  debugMode?: boolean | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
} = {}): ToolConnectionAnalytics {
  const queued = createQueuedAnalytics({
    source: TOOL_CONNECTION_ANALYTICS_SOURCE,
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
    trackConnection(input) {
      const toolkit = input.toolkit.trim();
      if (!toolkit) return;
      queued.track(TOOL_CONNECTION_ANALYTICS_EVENTS.connection, buildToolConnectionParams(input));
    },
    flush() {
      return queued.flush();
    },
  };
}

export function createNoopToolConnectionAnalytics(): ToolConnectionAnalytics {
  return {
    trackConnection() {},
    flush() {
      return Promise.resolve();
    },
  };
}
