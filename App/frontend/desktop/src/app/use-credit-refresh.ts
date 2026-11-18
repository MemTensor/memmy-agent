import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../api/http.js";

/** One in-flight read per visible view; a changed account/filter invalidates every old response. */
export function useCreditRefresh<T>(load: (signal: AbortSignal) => Promise<T>, enabled: boolean, userId: string | null, version = -1, readVersion?: (data: T) => number) {
  const [snapshot, setSnapshot] = useState<{ load: typeof load; data: T } | null>(null);
  const [failure, setFailure] = useState<{ load: typeof load; auth: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef(() => {});
  const foreground = useRef(true);
  const versionRef = useRef(version);
  versionRef.current = version;
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, pending = false, sequence = 0, eventVersion = -1;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (disposed || !foreground.current || document.visibilityState === "hidden") return;
      if (controller) { pending = true; return; }
      clearTimeout(timer);
      const current = new AbortController(); controller = current;
      const ticket = ++sequence;
      setLoading(true);
      try {
        const data = await load(current.signal);
        if (readVersion && readVersion(data) < Math.max(versionRef.current, eventVersion)) throw new Error("Stale credits version");
        if (!disposed && ticket === sequence) { setSnapshot({ load, data }); setFailure(null); }
      } catch (error) {
        if (!disposed && ticket === sequence && !current.signal.aborted) {
          const auth = error instanceof ApiRequestError && error.status === 401;
          if (auth) setSnapshot(null);
          setFailure({ load, auth });
        }
      } finally {
        current.abort();
        if (!disposed && ticket === sequence) {
          controller = null; setLoading(false);
          if (pending) { pending = false; void run(); }
          else timer = setTimeout(() => void run(), 10000);
        }
      }
    };
    const refresh = () => void run();
    const suspend = () => {
      clearTimeout(timer); sequence++; controller?.abort(); controller = null; pending = false; setLoading(false);
    };
    const visible = () => { if (document.visibilityState === "hidden") suspend(); else refresh(); };
    const focus = () => { foreground.current = true; refresh(); };
    const blur = () => { foreground.current = false; suspend(); };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ accountVersion?: number; userId?: string }>).detail;
      if (detail?.userId && detail.userId !== userId) return;
      if (!Number.isSafeInteger(detail?.accountVersion) || detail!.accountVersion! <= Math.max(versionRef.current, eventVersion)) return;
      eventVersion = detail!.accountVersion!; refresh();
    };
    refreshRef.current = refresh;
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("memmy:credits-refresh", refresh);
    window.addEventListener("credits.changed", changed);
    document.addEventListener("visibilitychange", visible);
    refresh();
    return () => {
      disposed = true; controller?.abort(); clearTimeout(timer); refreshRef.current = () => {};
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("memmy:credits-refresh", refresh);
      window.removeEventListener("credits.changed", changed);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load, enabled, userId, readVersion]);
  return { data: enabled && snapshot?.load === load ? snapshot.data : null,
    error: enabled && failure?.load === load ? (failure.auth ? "auth" : "load") : null, loading, refresh };
}
