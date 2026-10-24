import { useEffect, useRef } from "react";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import { isComputerHistorySupported } from "./computer-history-platform.js";

/** Refresh the saved Memory summary assignment after account/config changes. */
export function useComputerHistoryModelSync(input: {
  client: Pick<MemmyAgentClient, "refreshComputerHistoryModel"> | null;
  enabled: boolean;
  revision: string;
}): void {
  // Serialize configuration refreshes and skip superseded revisions.
  const queue = useRef(Promise.resolve());
  const { client, revision } = input;
  const enabled = input.enabled && isComputerHistorySupported();
  useEffect(() => {
    if (!client || !enabled) return;
    let disposed = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      if (disposed || queued) return;
      // Full and pet windows coexist. Avoid duplicate foreground refreshes;
      // the gateway also refreshes this global assignment in the background.
      if (!document.hasFocus()) {
        clearTimeout(timer);
        timer = setTimeout(sync, 30_000);
        return;
      }
      queued = true;
      clearTimeout(timer);
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (disposed) return;
        let delay = 30_000;
        try {
          await client.refreshComputerHistoryModel();
        } catch {
          // Retry without changing the saved summary assignment.
          delay = 5_000;
        } finally {
          queued = false;
          if (!disposed) timer = setTimeout(sync, delay);
        }
      });
    };
    sync();
    window.addEventListener("focus", sync);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", sync);
    };
  }, [client, enabled, revision]);
}
