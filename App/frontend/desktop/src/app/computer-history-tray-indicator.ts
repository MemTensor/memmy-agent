import { useEffect } from "react";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";

const STORAGE_KEY = "memmy.computerHistory.trayIndicatorEnabled";
const CHANGE_EVENT = "memmy:computer-history-tray-indicator-changed";

export function readComputerHistoryTrayIndicator(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeComputerHistoryTrayIndicator(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // The current session can still update the indicator when storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Keeps the native menu bar indicator current after navigating away from History. */
export function useComputerHistoryTrayIndicator(client: MemmyAgentClient | null): void {
  useEffect(() => {
    if (window.memmy?.platform !== "darwin" || !window.memmy.setComputerHistoryTrayIndicator) return;
    let active = true;
    let inFlight = false;
    const publish = async () => {
      if (!active) return;
      const enabled = readComputerHistoryTrayIndicator();
      if (!enabled || !client) {
        window.memmy?.setComputerHistoryTrayIndicator?.({ enabled, recording: false });
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const status = await client.getComputerHistoryObservationStatus();
        if (active && readComputerHistoryTrayIndicator()) window.memmy?.setComputerHistoryTrayIndicator?.({
          enabled: true,
          recording: status.state === "running",
        });
      } catch {
        // A missing recorder is not a reliable signal that it is still recording.
        if (active) window.memmy?.setComputerHistoryTrayIndicator?.({
          enabled: readComputerHistoryTrayIndicator(), recording: false,
        });
      } finally {
        inFlight = false;
      }
    };
    void publish();
    const timer = window.setInterval(() => void publish(), 10_000);
    window.addEventListener(CHANGE_EVENT, publish);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(CHANGE_EVENT, publish);
      window.memmy?.setComputerHistoryTrayIndicator?.({ enabled: false, recording: false });
    };
  }, [client]);
}
