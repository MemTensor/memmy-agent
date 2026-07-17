/** Agent source auto scan service module. */
import type { ScanPreferences } from "@memmy/local-api-contracts";

export const DEFAULT_AGENT_SOURCE_AUTO_SCAN_INTERVAL_MS = 60 * 60 * 1000;

type Timer = ReturnType<typeof setTimeout>;

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
  const initialDelayMs = options.initialDelayMs ?? intervalMs;
  const fetchFn = options.fetchFn ?? fetch;
  let timer: Timer | null = null;
  let abortController: AbortController | null = null;
  let closed = false;
  let running = false;

  const schedule = (delayMs: number) => {
    if (closed) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      void runScan().finally(() => schedule(intervalMs));
    }, delayMs);
    timer.unref?.();
  };

  const runScan = async () => {
    if (running || closed) {
      return;
    }

    running = true;
    try {
      if (!options.getScanPreferences().watchFileChanges) {
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

      schedule(initialDelayMs);
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
