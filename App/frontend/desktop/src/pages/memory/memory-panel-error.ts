/** Shared classification and retry policy for memory panel reads. */
import { ApiRequestError } from "../../api/http.js";
import type { MessageKey } from "../../i18n/messages.js";

/**
 * Backoff schedule for a panel that failed to load.
 *
 * The Memory service is a local child process. When it is still installing,
 * migrating, or restarting, the backend answers every panel read with
 * `memory_layer_unavailable` (the raw "memory layer network error" copy). The
 * service usually settles within a few seconds, so the first retries are
 * quick and later ones back off to avoid hammering a service mid-restart.
 */
export const MEMORY_PANEL_RETRY_DELAYS_MS = [1_500, 4_000, 10_000, 20_000] as const;

export type MemoryPanelErrorKind =
  | "not-ready"
  | "unavailable"
  | "unauthorized"
  | "unknown";

export interface MemoryPanelErrorInfo {
  kind: MemoryPanelErrorKind;
  /** Raw message for diagnostics only; never the primary user-facing copy. */
  detail: string;
  requestId: string | null;
  /** Whether another attempt can plausibly succeed without user action. */
  retryable: boolean;
}

/**
 * Classifies a failed memory panel read.
 *
 * A missing client is a render/bootstrap problem, not a service outage, so it
 * is reported separately and never retried.
 */
export function classifyMemoryPanelError(error: unknown, hasClient = true): MemoryPanelErrorInfo {
  if (!hasClient) {
    return {
      kind: "not-ready",
      detail: error instanceof Error ? error.message : String(error),
      requestId: null,
      retryable: false
    };
  }

  if (error instanceof ApiRequestError) {
    if (error.code === "memory_layer_unavailable" || error.status === 502 || error.status === 503 || error.status === 504) {
      return { kind: "unavailable", detail: error.message, requestId: error.requestId, retryable: true };
    }
    if (error.code === "unauthorized" || error.code === "forbidden" || error.status === 401 || error.status === 403) {
      return { kind: "unauthorized", detail: error.message, requestId: error.requestId, retryable: false };
    }
    return { kind: "unknown", detail: error.message, requestId: error.requestId, retryable: false };
  }

  // A bare TypeError from fetch means the local backend itself is unreachable,
  // which happens while Memmy boots. Treat it as transient.
  if (error instanceof TypeError) {
    return {
      kind: "unavailable",
      detail: error.message,
      requestId: null,
      retryable: true
    };
  }

  return {
    kind: "unknown",
    detail: error instanceof Error ? error.message : String(error),
    requestId: null,
    retryable: false
  };
}

/** Resolves the retry delay for the given attempt index, or null when retries are exhausted. */
export function memoryPanelRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MEMORY_PANEL_RETRY_DELAYS_MS.length) {
    return null;
  }
  return MEMORY_PANEL_RETRY_DELAYS_MS[attempt]!;
}

/** Title key describing a failed panel read, phrased as what the user can do about it. */
export function memoryPanelErrorTitleKey(info: MemoryPanelErrorInfo): MessageKey {
  switch (info.kind) {
    case "not-ready":
      return "memory.clientNotReady";
    case "unauthorized":
      return "memory.panelError.unauthorized";
    case "unavailable":
      return "memory.panelError.unavailable";
    default:
      return "memory.panelError.generic";
  }
}
