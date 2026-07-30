/** Agent source auto scan service module. */
import type { ScanPreferences } from "@memmy/local-api-contracts";

export const DEFAULT_AGENT_SOURCE_AUTO_SCAN_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_AGENT_SOURCE_AUTO_SCAN_INITIAL_DELAY_MS = 5 * 60 * 1000;

type Timer = ReturnType<typeof setTimeout>;
type ScanTrigger = "startup" | "recurring";

export interface AgentSourceAutoScanService {
  start(): void;
  close(): void;
}

export interface CreateAgentSourceAutoScanServiceOptions {
  baseUrl: string;
  localToken: string;
  intervalMs?: number;
  initialDelayMs?: number;
  fetchFn?: typeof fetch;
  getScanPreferences: () => ScanPreferences;
}

/** Creates create agent source auto scan service. */
export function createAgentSourceAutoScanService(
  options: CreateAgentSourceAutoScanServiceOptions
): AgentSourceAutoScanService {
  const intervalMs = options.intervalMs ?? DEFAULT_AGENT_SOURCE_AUTO_SCAN_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_AGENT_SOURCE_AUTO_SCAN_INITIAL_DELAY_MS;
  const fetchFn = options.fetchFn ?? fetch;
  let timer: Timer | null = null;
  let abortController: AbortController | null = null;
  let closed = false;
  let running = false;

  const schedule = (delayMs: number, trigger: ScanTrigger) => {
    if (closed) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      void runScan(trigger).finally(() => schedule(intervalMs, "recurring"));
    }, delayMs);
    timer.unref?.();
  };

  const runScan = async (trigger: ScanTrigger) => {
    if (running || closed) {
      return;
    }

    running = true;
    try {
      const preferences = options.getScanPreferences();
      const enabled = trigger === "startup"
        ? preferences.autoScanKnownAgents
        : preferences.watchFileChanges;
      if (!enabled) {
        return;
      }

      abortController = new AbortController();
      await fetchFn(`${options.baseUrl}/api/agent-sources/scan`, {
        method: "POST",
        headers: {
          "x-memmy-local-token": options.localToken
        },
        signal: abortController.signal
      });
    } catch {
      // Auto scan is best-effort. Manual scans and the next scheduled tick remain available.
    } finally {
      running = false;
      abortController = null;
    }
  };

  return {
    start() {
      if (timer || closed) {
        return;
      }

      const startupScanEnabled = options.getScanPreferences().autoScanKnownAgents;
      schedule(
        startupScanEnabled ? initialDelayMs : intervalMs,
        startupScanEnabled ? "startup" : "recurring"
      );
    },

    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      abortController?.abort();
      abortController = null;
    }
  };
}
