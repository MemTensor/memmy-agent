import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { usePanelPoll } from "./use-panel-poll.js";
import { ApiRequestError } from "../../api/http.js";
import { usePanelVisible } from "./panel-visibility.js";
export function usePanelViewStatus(
  client: MemoryRuntimeClient | null,
  section: string,
  invalidate: () => void,
  reload?: () => Promise<unknown>
) {
  const [expired, setExpired] = useState(false);
  const visible = usePanelVisible();
  const scope = useMemo(() => ({}), [client, section, visible]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const latest = useRef({ invalidate, reload });
  latest.current = { invalidate, reload };
  const generation = useRef(0);
  async function check() {
    const id = generation.current;
    const checkingScope = scope;
    try {
      await client!.checkPanelView!(section);
      if (id === generation.current && checkingScope === currentScope.current) {
        setExpired(false);
        if (expired) void latest.current.reload?.().catch(() => undefined);
      }
    } catch (error) {
      if (id !== generation.current || checkingScope !== currentScope.current) throw error;
      if (id === generation.current && error instanceof ApiRequestError && [401, 403, 404, 409].includes(error.status)) {
        setExpired(true);
        latest.current.invalidate();
        if (error.status === 409) {
          client?.resetPanelView?.(section);
          void latest.current.reload?.().catch(() => undefined);
        }
      }
      throw error;
    }
  }
  usePanelPoll(Boolean(client?.checkPanelView), check, 60_000, true);
  // A new service must never reveal details retained from the previous client.
  useLayoutEffect(() => {
    generation.current++;
    latest.current.invalidate();
  }, [client, section]);
  useEffect(() => {
    generation.current++;
    const handler = () => {
      generation.current++;
      setExpired(true);
      latest.current.invalidate();
      if (visible && !document.hidden) void latest.current.reload?.().catch(() => undefined);
    };
    window.addEventListener("memmy-panel-invalidated", handler);
    return () => {
      generation.current++;
      window.removeEventListener("memmy-panel-invalidated", handler);
    };
  }, [client, visible]);
  return {
    reloadCurrent: () => visible && !document.hidden && scope === currentScope.current
      ? latest.current.reload?.() ?? Promise.resolve()
      : Promise.resolve(),
    clear: () => {
      setExpired(false);
    }
  };
}
export function canPreservePanelResult(error: unknown): boolean {
  return !(error instanceof ApiRequestError && [401, 403, 404, 409].includes(error.status));
}
