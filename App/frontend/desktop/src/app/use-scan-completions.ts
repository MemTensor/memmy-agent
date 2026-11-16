import { useEffect, useRef } from "react";
import { agentSourceScanExecutionKey } from "@memmy/local-api-contracts";
import type { AgentSourceClient } from "../api/agent-source-client.js";
import { trackAgentSourceScanOutcome } from "../analytics/memory-ui-analytics.js";
import { clearMemoryPanelCache } from "../pages/memory/memory-panel-cache.js";
import { formatAgentSourceScanRequestError, formatScanCompletedError } from "../pages/agent-source-scan-error.js";
import type { useTranslation } from "../i18n/use-translation.js";
import type { AgentSourcesState } from "../state/app-reducer.js";
import { appActions, AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS, type AppAction } from "../state/app-actions.js";

/** Side effects are driven only by completions already accepted by the reducer. */
export function useScanCompletions(client: Pick<AgentSourceClient, "listSources"> | null, state: AgentSourcesState,
  dispatch: (action: AppAction) => void, translate: ReturnType<typeof useTranslation>["t"]) {
  const latest = useRef({ state, translate }); latest.current = { state, translate };
  const handled = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear(); };
  }, []);
  useEffect(() => {
    if (!client) return;
    for (const completion of state.recentScanCompletions) {
      const key = agentSourceScanExecutionKey(completion);
      // Re-arm expiry after an effect replay without repeating completion effects.
      if (!timers.current.has(key)) timers.current.set(key, setTimeout(() => {
        timers.current.delete(key);
        dispatch(appActions.agentSourceScanCompletionExpired(completion.jobId, completion.attemptId));
        if (handled.current.size > 100) handled.current.delete(handled.current.values().next().value!);
      }, AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS));
      if (handled.current.has(key)) continue;
      handled.current.add(key);
      trackAgentSourceScanOutcome({ ...completion, succeeded: completion.succeeded ?? true });
      clearMemoryPanelCache();
      const stillCurrent = () => {
        const stamp = latest.current.state.scanStamp;
        return mounted.current && (!stamp?.jobId || agentSourceScanExecutionKey({ ...stamp, jobId: stamp.jobId }) === key);
      };
      if (completion.succeeded === false) dispatch(appActions.agentSourcesFailed(latest.current.translate("memory.scanFailed")));
      void client.listSources().then((sources) => {
        if (!stillCurrent()) return;
        dispatch(appActions.agentSourcesRefreshed(sources));
        if (completion.succeeded === false && stillCurrent()) {
          const error = completion.results ? formatScanCompletedError(completion.results, sources, latest.current.translate) : null;
          dispatch(appActions.agentSourcesFailed(error ?? latest.current.translate("memory.scanFailed")));
        }
      }).catch((error) => {
        if (stillCurrent()) dispatch(appActions.agentSourcesFailed(formatAgentSourceScanRequestError(error, undefined, latest.current.translate)));
      });
    }
  }, [client, state.recentScanCompletions, dispatch]);
}
