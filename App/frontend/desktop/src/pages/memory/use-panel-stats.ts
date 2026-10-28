import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelOverviewStatsOutput, PanelStatsOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { isUnsupportedPanelRoute } from "../../api/memory-runtime-client.js";
import { usePanelPoll } from "./use-panel-poll.js";
import { toErrorMessage, type RemoteData } from "./remote-state.js";
import { ApiRequestError } from "../../api/http.js";
import { usePanelVisible } from "./panel-visibility.js";
export function usePanelStats<T>(
  client: MemoryRuntimeClient | null,
  section: "overview" | "analysis",
  legacy: () => Promise<T>
) {
  const [state, setState] = useState<RemoteData<T>>({ status: "loading" });
  const [snapshot, setSnapshot] = useState<PanelStatsOutput | PanelOverviewStatsOutput>();
  const [connectionError, setConnectionError] = useState<string>();
  const generation = useRef(0);
  const oldService = useRef(false);
  const overviewStatsUnsupported = useRef(false);
  const visible = usePanelVisible();
  async function load() {
    const current = generation.current;
    try {
      if (!oldService.current) {
        try {
          let result: PanelStatsOutput | PanelOverviewStatsOutput | undefined;
          let selectedData: unknown;
          if (section === "overview" && client?.getPanelOverviewStats && !overviewStatsUnsupported.current) {
            try {
              result = await client.getPanelOverviewStats();
              selectedData = result.data;
            } catch (error) {
              if (!isUnsupportedPanelRoute(error)) throw error;
              overviewStatsUnsupported.current = true;
            }
          }
          if (!result && client?.getPanelStats) {
            try {
              result = await client.getPanelStats();
              selectedData = result.data?.[section];
            } catch (error) {
              if (!isUnsupportedPanelRoute(error)) throw error;
              oldService.current = true;
            }
          }
          if (result) {
            if (current !== generation.current) return;
            setConnectionError(undefined);
            setSnapshot(result);
            setState(
              selectedData
                ? { status: "ready", data: selectedData as T }
                : result.status === "error"
                  ? { status: "error", message: result.error ?? "Statistics failed" }
                  : { status: "loading" }
            );
            return;
          }
        } catch (error) {
          if (!isUnsupportedPanelRoute(error)) throw error;
        }
      }
      const data = await legacy();
      if (current === generation.current) {
        setConnectionError(undefined);
        setState({ status: "ready", data });
      }
    } catch (error) {
      if (current === generation.current) {
        const message = toErrorMessage(error);
        const unsafe = error instanceof ApiRequestError && [401, 403, 404, 409].includes(error.status);
        setConnectionError(message);
        if (unsafe) setSnapshot(undefined);
        setState((previous) => (!unsafe && previous.status === "ready" ? previous : { status: "error", message }));
      }
      throw error;
    }
  }
  useLayoutEffect(() => {
    generation.current++;
    oldService.current = false;
    overviewStatsUnsupported.current = false;
    setState({ status: "loading" });
    setSnapshot(undefined);
    setConnectionError(undefined);
    if (visible) void load().catch(() => undefined);
    return () => {
      generation.current++;
    };
  }, [client, section, visible]);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      setState({ status: "loading" });
      setSnapshot(undefined);
      if (visible && !document.hidden) void load().catch(() => undefined);
    };
    window.addEventListener("memmy-panel-invalidated", clear);
    return () => window.removeEventListener("memmy-panel-invalidated", clear);
  }, [client, section, visible]);
  const preparingInterval = 100;
  usePanelPoll(Boolean(client), load, snapshot?.status === "preparing" ? preparingInterval : 60_000);
  return { state, snapshot, connectionError };
}
