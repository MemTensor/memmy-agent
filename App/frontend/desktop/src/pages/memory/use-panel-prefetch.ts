import { useEffect } from "react";
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
    async function next() {
      if (stopped || document.hidden || !remaining.length) return;
      try {
        await client!.prefetchPanel!(remaining.shift()!, controller.signal);
      } catch {
        return;
      } // No prefetch retries or startup request burst.
      if (!stopped) timer = setTimeout(next, 2000);
    }
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden && !stopped) timer = setTimeout(next, 2000);
    };
    timer = setTimeout(next, 2000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client, current]);
}
