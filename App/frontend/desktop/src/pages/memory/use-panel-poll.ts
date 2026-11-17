import { usePanelVisible } from "./panel-visibility.js";
import { useEffect, useRef } from "react";

/** Wait after completion, back off on failure and pause while the window is hidden. */
export function usePanelPoll(enabled: boolean, load: () => Promise<unknown>, interval = 60_000, immediate = false): void {
  const visible = usePanelVisible();
  enabled = enabled && visible;
  const latest = useRef(load);
  const wasHidden = useRef(false);
  latest.current = load;
  useEffect(() => {
    const resumed = visible && wasHidden.current;
    wasHidden.current = !visible;
    if (!enabled) return;
    let stopped = false;
    let active = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(run, delay);
    };
    const run = async () => {
      if (stopped || active || document.hidden) return;
      active = true;
      try {
        await latest.current();
        failures = 0;
      } catch {
        failures = Math.min(failures + 1, 4);
      } finally {
        active = false;
        schedule(interval * 2 ** failures);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden && !active) schedule(0);
    };
    document.addEventListener("visibilitychange", visibility);
    schedule(immediate || resumed ? 0 : interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, interval, immediate, visible]);
}
