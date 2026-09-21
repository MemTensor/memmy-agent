import { useEffect, useRef } from "react";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import { isComputerHistorySupported } from "./computer-history-platform.js";

/** Keep background summaries on the selected task model, even outside History. */
export function useComputerHistoryModelSync(input: {
  client: Pick<MemmyAgentClient, "setComputerHistoryModel"> | null;
  enabled: boolean;
  preset: string | null;
  revision: string;
}): void {
  // Serialize across selection changes so a slower old request cannot become
  // the final selection. Intermediate selections that never started are skipped.
  const queue = useRef(Promise.resolve());
  const { client, preset, revision } = input;
  const enabled = input.enabled && isComputerHistorySupported();
  useEffect(() => {
    if (!client || !enabled) return;
    let disposed = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      if (disposed || queued) return;
      // Full and pet windows can coexist. Only the focused window owns the
      // current selection; an inactive window must not restore its stale model.
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
          await client.setComputerHistoryModel(preset);
        } catch {
          // Reconnect/retry without changing the user's chat selection.
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
  }, [client, enabled, preset, revision]);
}
