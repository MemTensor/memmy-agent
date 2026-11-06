import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/use-translation.js";
import { clearMemoryPanelCache } from "./memory-panel-cache.js";
import { toErrorMessage } from "./remote-state.js";

export interface MemoryRestartFeedback {
  tone: "success" | "error";
  message: string;
}

export interface UseMemoryServiceRestartResult {
  /** False when the current runtime has no desktop bridge for restarting Memory. */
  canRestart: boolean;
  restarting: boolean;
  feedback: MemoryRestartFeedback | null;
  restart: () => void;
}

/**
 * Restarts the local Memory service from a panel error state.
 *
 * Restart is the only recovery path when the service process itself is wedged,
 * which is the case the issue describes (a restart of the app did not help
 * because the panel never re-read after the service came back). The panel cache
 * is cleared on success so a rebuilt snapshot is not masked for its TTL.
 */
export function useMemoryServiceRestart(onRestarted?: () => void): UseMemoryServiceRestartResult {
  const { t } = useTranslation();
  const translateRef = useRef(t);
  translateRef.current = t;
  const onRestartedRef = useRef(onRestarted);
  onRestartedRef.current = onRestarted;
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<MemoryRestartFeedback | null>(null);
  const restartingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const restart = useCallback(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy?.restartMemoryService;
    if (typeof bridge !== "function" || restartingRef.current) return;

    restartingRef.current = true;
    setRestarting(true);
    setFeedback(null);
    void bridge()
      .then(() => {
        if (!mountedRef.current) return;
        clearMemoryPanelCache();
        setFeedback({ tone: "success", message: translateRef.current("memory.restartServiceDone") });
        onRestartedRef.current?.();
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setFeedback({
          tone: "error",
          message: translateRef.current("memory.restartServiceFailed", { reason: toErrorMessage(error) })
        });
      })
      .finally(() => {
        restartingRef.current = false;
        if (mountedRef.current) setRestarting(false);
      });
  }, []);

  const canRestart = typeof window !== "undefined" && typeof window.memmy?.restartMemoryService === "function";
  return { canRestart, restarting, feedback, restart };
}
