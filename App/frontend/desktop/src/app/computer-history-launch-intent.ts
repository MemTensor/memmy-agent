/** One-shot handoff from the release announcement to History's existing switch. */
const STORAGE_KEY = "memmy.computerHistory.launchEnable.v1";
const REQUEST_EVENT = "memmy:computer-history-launch-enable";
const MAX_AGE_MS = 60_000;

export function requestComputerHistoryLaunchEnable(storage: Storage | undefined, now = Date.now()): void {
  storage?.setItem(STORAGE_KEY, String(now));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REQUEST_EVENT));
}

/** Consumes at most one fresh request; stale navigation cannot open a later session's dialog. */
export function consumeComputerHistoryLaunchEnable(storage: Storage | undefined, now = Date.now()): boolean {
  const raw = storage?.getItem(STORAGE_KEY);
  storage?.removeItem(STORAGE_KEY);
  if (!raw) return false;
  const at = Number(raw);
  return Number.isFinite(at) && at <= now && now - at <= MAX_AGE_MS;
}

export function hasComputerHistoryLaunchEnable(storage: Storage | undefined, now = Date.now()): boolean {
  const at = Number(storage?.getItem(STORAGE_KEY));
  return Number.isFinite(at) && at > 0 && at <= now && now - at <= MAX_AGE_MS;
}

export function onComputerHistoryLaunchEnable(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(REQUEST_EVENT, listener);
  return () => window.removeEventListener(REQUEST_EVENT, listener);
}
