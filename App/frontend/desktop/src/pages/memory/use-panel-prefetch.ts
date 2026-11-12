import { usePanelVisible } from "./panel-visibility.js";
import { useEffect } from "react";
import { isUnsupportedPanelRoute } from "../../api/memory-runtime-client.js";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";

/** Warm one lightweight first page at a time, only after visible work is idle. */
export function usePanelPrefetch(client: MemoryRuntimeClient | null, current: string) {
  const visible = usePanelVisible();
  useEffect(() => {
    if (!client?.prefetchPanel || !visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const sections = ["L1", "tasks", "L2", "L3", "Skill", "UserMemory"];
    const mapped: Record<string, string> = {
      memories: "L1",
      tasks: "tasks",
      policies: "L2",
      "world-model": "L3",
      skills: "Skill",
      "user-memories": "UserMemory"
    };
    const remaining = sections.filter((section) => section !== mapped[current]);
    const stats = (current === "analytics" ? ["analysis", "overview"] : ["overview", "analysis"])
      .filter(kind => kind === "overview" ? Boolean(client.getPanelOverviewStats) : Boolean(client.getPanelStats));
    const previewInterval = client.getPanelOverviewStats ? 250 : 2000;
    async function next() {
      if (stopped || document.hidden) return;
      while (stats.length) {
        try {
          const snapshot = stats[0] === "analysis"
            ? await client!.getPanelStats!(controller.signal)
            : await client!.getPanelOverviewStats!(controller.signal);
          if (stopped || document.hidden) return;
          if (snapshot.status === "preparing") {
            timer = setTimeout(next, 500);
            return;
          }
        } catch (error) {
          if (!isUnsupportedPanelRoute(error)) return;
        }
        if (stopped || document.hidden) return;
        stats.shift();
      }
      if (!remaining.length) return;
      try {
        const warmed = await client!.prefetchPanel!(remaining[0]!, controller.signal);
        if (warmed !== false) remaining.shift();
      } catch {
        return;
      } // No prefetch retries or startup request burst.
      if (!stopped && !document.hidden) timer = setTimeout(next, previewInterval);
    }
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden && !stopped) timer = setTimeout(next, stats.length ? 250 : previewInterval);
    };
    timer = setTimeout(next, stats.length ? 250 : previewInterval);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client, current, visible]);
}
