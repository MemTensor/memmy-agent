import { useEffect } from "react";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { useApiClients } from "./providers.js";

const RECONCILE_INTERVAL_MS = 1_000;
const RECONCILE_TIMEOUT_MS = 5_000;

/** Keeps restart and post-clear scan-state reconciliation alive across route unmounts. */
export function AgentSourceScanReconciler() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { memoryServiceRestarting, memoryDataClearing, scanStateSyncGeneration, scanStateSyncReason, scanStateSyncRequired } = state.agentSources;

  useEffect(() => {
    if (!clients || !scanStateSyncRequired || !scanStateSyncReason || memoryServiceRestarting || memoryDataClearing) return undefined;

    let active = true;
    let pending = false;
    let inFlight: AbortController | null = null;
    const reconcile = async () => {
      if (!active || pending) return;
      pending = true;
      const controller = new AbortController();
      inFlight = controller;
      const timeout = window.setTimeout(() => controller.abort(), RECONCILE_TIMEOUT_MS);
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Memory service reconciliation was cancelled"));
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const raceWithAbort = <T,>(promise: Promise<T>) => Promise.race([promise, aborted]);
      try {
        if (scanStateSyncReason === "restart") {
          const health = await raceWithAbort(clients.memoryRuntime.health(controller.signal));
          if (!active || controller.signal.aborted || !health.ok || !health.storage.ready) return;
        }
        const status = await raceWithAbort(clients.agentSources.getScanStatus({ signal: controller.signal }));
        if (!active || controller.signal.aborted) return;
        dispatch(appActions.agentSourceScanAvailability(status.unavailable ?? null));
        if (status.unavailable) return;
        const sources = scanStateSyncReason === "clear"
          ? await raceWithAbort(clients.agentSources.listSources())
          : undefined;
        if (!active || controller.signal.aborted) return;
        dispatch(appActions.agentSourceScanStateSynchronized(scanStateSyncGeneration, status, sources));
      } catch {
        // Keep scan actions locked until the required post-operation snapshot succeeds.
      } finally {
        window.clearTimeout(timeout);
        if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
        if (inFlight === controller) inFlight = null;
        pending = false;
      }
    };

    void reconcile();
    const interval = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
      inFlight?.abort();
    };
  }, [clients, dispatch, memoryDataClearing, memoryServiceRestarting, scanStateSyncGeneration, scanStateSyncReason, scanStateSyncRequired]);

  return null;
}
