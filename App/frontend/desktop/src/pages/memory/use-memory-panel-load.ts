/** Shared load/retry state for read-only memory panels. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import {
  classifyMemoryPanelError,
  memoryPanelRetryDelayMs,
  type MemoryPanelErrorInfo
} from "./memory-panel-error.js";
import { memoryPanelCacheKey, readMemoryPanelCache, writeMemoryPanelCache } from "./memory-panel-cache.js";
import type { RemoteData } from "./remote-state.js";

export interface UseMemoryPanelLoadInput<T> {
  client: MemoryRuntimeClient | null;
  /** Cache section, e.g. "overview" or "analytics". */
  section: string;
  load: (client: MemoryRuntimeClient) => Promise<T>;
  /** Localized copy used when no client has been bootstrapped yet. */
  clientNotReadyMessage: string;
}

export interface UseMemoryPanelLoadResult<T> {
  state: RemoteData<T>;
  errorInfo: MemoryPanelErrorInfo | null;
  /** A request is in flight, including retries. */
  retrying: boolean;
  /** Another automatic attempt is queued. */
  autoRetrying: boolean;
  /** Forces an immediate reload, restarting the backoff schedule. */
  reload: () => void;
}

/**
 * Loads a memory panel, keeping any previously loaded snapshot on screen while
 * the Memory service is unavailable.
 *
 * The Memory layer runs as a local child process and is briefly unreachable
 * while it installs, migrates, or restarts; the backend then answers panel
 * reads with `memory_layer_unavailable`, whose raw text is "memory layer
 * network error". Treating one such response as a terminal page error is what
 * made this page look permanently broken, so instead the last good snapshot is
 * retained and the read is retried on a backoff schedule.
 */
export function useMemoryPanelLoad<T>(input: UseMemoryPanelLoadInput<T>): UseMemoryPanelLoadResult<T> {
  const { client, section, load, clientNotReadyMessage } = input;
  const cacheKey = memoryPanelCacheKey(section);
  const loadRef = useRef(load);
  loadRef.current = load;
  const messageRef = useRef(clientNotReadyMessage);
  messageRef.current = clientNotReadyMessage;

  const [state, setState] = useState<RemoteData<T>>({ status: "loading" });
  const [errorInfo, setErrorInfo] = useState<MemoryPanelErrorInfo | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [autoRetrying, setAutoRetrying] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const dataRef = useRef<T | null>(null);
  const errorRef = useRef<MemoryPanelErrorInfo | null>(null);
  errorRef.current = errorInfo;

  useEffect(() => {
    const cached = readMemoryPanelCache<T>(cacheKey);
    const retained = cached ?? dataRef.current;

    if (retained !== null) {
      dataRef.current = retained;
      setState({ status: "ready", data: retained });
    } else {
      setState({ status: "loading" });
    }
    // Keep the previous notice visible while a reload is in flight so the page
    // never flaps back to a bare view without context.
    if (errorRef.current !== null) setRetrying(true);
    setAutoRetrying(false);

    if (!client) {
      setRetrying(false);
      const info = classifyMemoryPanelError(new Error(messageRef.current), false);
      // Only blank the panel when there is nothing to show; a cached snapshot
      // stays visible with the notice above it.
      if (retained === null) setState({ status: "error", message: info.detail });
      setErrorInfo(info);
      return;
    }

    let cancelled = false;
    let inflight = false;
    let attempt = 0;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const run = async (isRetry: boolean) => {
      if (cancelled || inflight) return;
      inflight = true;
      if (isRetry) setRetrying(true);
      try {
        const next = await loadRef.current(client);
        if (cancelled) return;
        writeMemoryPanelCache(cacheKey, next);
        dataRef.current = next;
        attempt = 0;
        setState({ status: "ready", data: next });
        setErrorInfo(null);
        setAutoRetrying(false);
      } catch (error) {
        if (cancelled) return;
        const info = classifyMemoryPanelError(error, true);
        setErrorInfo(info);
        setState((current) => (current.status === "ready" ? current : { status: "error", message: info.detail }));
        const delay = info.retryable ? memoryPanelRetryDelayMs(attempt) : null;
        if (delay === null) {
          setAutoRetrying(false);
        } else {
          attempt += 1;
          setAutoRetrying(true);
          timer = window.setTimeout(() => {
            timer = null;
            void run(true);
          }, delay);
        }
      } finally {
        inflight = false;
        if (!cancelled) setRetrying(false);
      }
    };

    void run(false);

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [cacheKey, client, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  return { state, errorInfo, retrying, autoRetrying, reload };
}
