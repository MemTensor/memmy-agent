import { MemoryStateBox } from "./memory-state-box.js";
import { Button } from "../../components/button.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { usePanelPoll } from "./use-panel-poll.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { ApiRequestError } from "../../api/http.js";
import { usePanelVisible } from "./panel-visibility.js";
export function usePanelViewStatus(
  client: MemoryRuntimeClient | null,
  section: string,
  invalidate: () => void,
  reload?: () => Promise<unknown>
) {
  const [updated, setUpdated] = useState(false);
  const [expired, setExpired] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const visible = usePanelVisible();
  const scope = useMemo(() => ({}), [client, section, visible]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [checkedScope, setCheckedScope] = useState<object>();
  const latest = useRef({ invalidate, reload });
  latest.current = { invalidate, reload };
  const generation = useRef(0);
  async function check() {
    const id = generation.current;
    const checkingScope = scope;
    try {
      const result = await client!.checkPanelView!(section);
      if (id === generation.current && checkingScope === currentScope.current) {
        setUpdated(result.updated);
        setExpired(false);
        setConnectionError(undefined);
        setCheckedScope(checkingScope);
        if (expired) void latest.current.reload?.().catch(() => undefined);
      }
    } catch (error) {
      if (id !== generation.current || checkingScope !== currentScope.current) throw error;
      setConnectionError(error instanceof Error ? error.message : String(error));
      if (id === generation.current && error instanceof ApiRequestError && [401, 403, 404, 409].includes(error.status)) {
        setCheckedScope(undefined);
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
      setCheckedScope(undefined);
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
    updated,
    expired,
    checking: Boolean(client?.checkPanelView) && checkedScope !== scope,
    connectionError,
    reloadCurrent: () => visible && !document.hidden && scope === currentScope.current
      ? latest.current.reload?.() ?? Promise.resolve()
      : Promise.resolve(),
    retry: () => void check().catch(() => undefined),
    clear: () => {
      setUpdated(false);
      setExpired(false);
      setConnectionError(undefined);
      setCheckedScope(currentScope.current);
    }
  };
}
export function PanelViewGate(props: { status: ReturnType<typeof usePanelViewStatus>; children: ReactNode }) {
  const { t } = useTranslation();
  return <>
    {props.status.checking && <div role="status">
      <MemoryStateBox message={props.status.connectionError ?? t("common.loading")} tone={props.status.connectionError ? "error" : undefined} />
      {props.status.connectionError && <Button type="button" size="sm" onClick={props.status.retry}>{t("app.error.retry")}</Button>}
    </div>}
    <div hidden={props.status.checking}>{props.children}</div>
  </>;
}
export function PanelViewNotice(props: { updated: boolean; expired: boolean }) {
  const { t } = useTranslation();
  return props.updated || props.expired ? (
    <p className="memory-panel-update-notice" role="status">
      {t(props.expired ? "memory.panel.expired" : "memory.panel.updated")}
    </p>
  ) : null;
}

export function canPreservePanelResult(error: unknown): boolean {
  return !(error instanceof ApiRequestError && [401, 403, 404, 409].includes(error.status));
}
