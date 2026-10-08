import { useEffect, useRef, useState, type MouseEvent, type WheelEvent, type KeyboardEvent } from 'react';
import type { ComputerUseSurfaceAction, ComputerUseSurfaceMessage } from '@memmy/local-api-contracts';
import { useTranslation } from '../i18n/use-translation.js';

type SurfaceAction = Pick<ComputerUseSurfaceAction, 'action' | 'x' | 'y' | 'deltaY' | 'key'>;

function imageCoordinates(event: MouseEvent<HTMLImageElement>): { x: number; y: number } | null {
  const image = event.currentTarget;
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (event.clientX - bounds.left - (bounds.width - width) / 2) / width;
  const y = (event.clientY - bounds.top - (bounds.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

function playwrightKey(event: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.key === ' ' ? 'Space' : event.key);
  return parts.join('+');
}

export function AgentBrowserSurface({ sessionKey }: { sessionKey: string | null }) {
  const { t } = useTranslation();
  const [surface, setSurface] = useState<ComputerUseSurfaceMessage | null>(null);
  const [error, setError] = useState('');
  const scopeRef = useRef(sessionKey);
  scopeRef.current = sessionKey;
  useEffect(() => {
    setSurface(null);
    if (!sessionKey) return;
    let active = true;
    const onMessage = (message: ComputerUseSurfaceMessage) => {
      if (!active || message.surface !== 'browser' || message.sessionKey !== scopeRef.current) return;
      setSurface(message.type.endsWith(':close') ? null : message);
    };
    const unsubscribe = window.memmy?.onBrowserSidebarSurface?.(onMessage);
    void window.memmy?.getBrowserSidebarSurface?.(sessionKey).then(message => {
      if (active && message && message.sessionKey === scopeRef.current) setSurface(message);
    }).catch(() => undefined);
    return () => { active = false; unsubscribe?.(); };
  }, [sessionKey]);

  async function send(action: SurfaceAction) {
    if (!sessionKey || !surface || !window.memmy?.sendBrowserSidebarAction) return;
    try {
      if (!await window.memmy.sendBrowserSidebarAction(sessionKey, action)) {
        setError(t("browser.surface.sessionEnded"));
      } else {
        setError('');
      }
    } catch { setError(t("browser.surface.operationFailed")); }
  }

  function handleWheel(event: WheelEvent<HTMLImageElement>) {
    event.preventDefault();
    void send({ action: 'scroll', deltaY: Math.max(-1000, Math.min(1000, event.deltaY)) });
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const key = playwrightKey(event);
    if (!key) return;
    event.preventDefault();
    void send({ action: 'key', key });
  }

  if (!sessionKey) return <p className="memmy-browser-empty">{t("browser.surface.taskRequired")}</p>;
  if (!window.memmy?.onBrowserSidebarSurface) return <p className="memmy-browser-empty">{t("browser.surface.desktopRequired")}</p>;
  return (
    <div className="memmy-agent-browser-surface" tabIndex={0} onKeyDown={handleKey} aria-label={t("browser.surface.label")}>
      {surface?.imageDataUrl ? (
        <>
          <div className="memmy-agent-browser-surface__header">
            <span title={surface.title}>{surface.title}</span>
            <button type="button" onClick={() => void send({ action: 'open' })}>{t("browser.surface.openTab")}</button>
          </div>
          <img src={surface.imageDataUrl} alt={t("browser.surface.currentPage")} draggable={false}
            onClick={event => {
              const point = imageCoordinates(event);
              if (point) void send({ action: 'click', ...point });
              event.currentTarget.parentElement?.focus();
            }} onWheel={handleWheel} />
        </>
      ) : <p className="memmy-browser-empty">{t("browser.surface.empty")}</p>}
      {error ? <p className="memmy-browser-error" role="alert">{error}</p> : null}
    </div>
  );
}
