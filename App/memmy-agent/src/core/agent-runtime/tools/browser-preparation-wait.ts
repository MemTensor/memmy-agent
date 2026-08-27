import {
  BROWSER_PREPARATION_IDLE_TIMEOUT_MS,
  BROWSER_PREPARATION_TOTAL_TIMEOUT_MS,
  type BrowserPreparationState,
} from "./browser-setup.js";

const DEFAULT_POLL_INTERVAL_MS = 250;

export type BrowserPreparationWaitOptions = {
  loadState: () => BrowserPreparationState | null;
  isExecutableReady: () => boolean;
  abortSignal?: AbortSignal | null;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>;
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  expectedAttemptId?: string | null;
};

function abortError(): Error {
  const error = new Error("browser tool call cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortError();
}

function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal | null,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => finish(abortError());
    function finish(error?: Error): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parsedTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function waitForBrowserPreparation(
  {
    loadState,
    isExecutableReady,
    abortSignal = null,
    now = Date.now,
    sleep = abortableSleep,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    idleTimeoutMs = BROWSER_PREPARATION_IDLE_TIMEOUT_MS,
    totalTimeoutMs = BROWSER_PREPARATION_TOTAL_TIMEOUT_MS,
    expectedAttemptId = null,
  }: BrowserPreparationWaitOptions,
): Promise<void> {
  const localStartedAt = now();
  while (true) {
    throwIfAborted(abortSignal);
    if (isExecutableReady()) return;

    const loadedState = loadState();
    const state = expectedAttemptId
      && loadedState?.attemptId !== expectedAttemptId
      ? null
      : loadedState;
    if (state?.status === "unavailable") {
      throw new Error(
        `浏览器组件准备失败${state.error ? `：${state.error}` : ""}`,
      );
    }

    const currentTime = now();
    const stateUpdatedAt = parsedTimestamp(state?.updatedAt, localStartedAt);
    const startedAt = parsedTimestamp(state?.startedAt, stateUpdatedAt);
    const lastProgressAt = parsedTimestamp(
      state?.lastProgressAt,
      stateUpdatedAt,
    );
    if (currentTime - startedAt >= totalTimeoutMs) {
      throw new Error("浏览器组件下载超时，准备失败");
    }
    if (currentTime - lastProgressAt >= idleTimeoutMs) {
      throw new Error("浏览器组件下载无进度，准备失败");
    }

    await sleep(pollIntervalMs, abortSignal);
  }
}
