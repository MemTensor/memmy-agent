import { useEffect } from "react";
import { isUnsupportedPanelRoute } from "../../api/memory-runtime-client.js";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";

/** Warm one lightweight first page at a time, only after visible work is idle. */
export function usePanelPrefetch(client: MemoryRuntimeClient | null, current: string) {
  useEffect(() => {
    if (!client?.prefetchPanel) return;
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
    let warmOverviewStats = Boolean(client.getPanelOverviewStats);
    let warmAnalysis = Boolean(client.getPanelStats);
    const previewInterval = client.getPanelOverviewStats ? 250 : 2000;
    async function next() {
      if (stopped || document.hidden) return;
      if (warmOverviewStats && client!.getPanelOverviewStats) {
        try {
          const snapshot = current === "analysis" && client!.getPanelStats
            ? await client!.getPanelStats()
            : await client!.getPanelOverviewStats();
          if (stopped) return;
          if (snapshot.status === "preparing") {
            timer = setTimeout(next, 2000);
            return;
          }
        } catch (error) {
          if (!isUnsupportedPanelRoute(error)) return;
        }
        warmOverviewStats = false;
      }
      if (!remaining.length) {
        if (warmAnalysis) {
          warmAnalysis = false;
          try { await client!.getPanelStats!(); } catch { /* Best effort warmup. */ }
        }
        return;
      }
      try {
        const warmed = await client!.prefetchPanel!(remaining[0]!, controller.signal);
        if (warmed !== false) remaining.shift();
      } catch {
        return;
      } // No prefetch retries or startup request burst.
      if (!stopped) timer = setTimeout(next, previewInterval);
    }
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden && !stopped) timer = setTimeout(next, warmOverviewStats ? 250 : 2000);
    };
    timer = setTimeout(next, warmOverviewStats ? 250 : 2000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client, current]);
}
