/** Sidebar resize module. */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { readCodexSidebarLayout } from "../theme/codex-sidebar-layout.js";

interface SidebarDragState {
  startX: number;
  startWidth: number;
}

export interface ResizableSidebarOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

export interface ResizableSidebarState {
  width: number;
  minWidth: number;
  maxWidth: number;
  isResizing: boolean;
  sidebarStyle: CSSProperties;
  beginResize: (event: ReactPointerEvent<HTMLElement>) => void;
  resizeBy: (delta: number) => void;
}

export interface SidebarResizeHandleProps {
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  isResizing: boolean;
  isDisabled?: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeBy: (delta: number) => void;
}

/** Handles use resizable sidebar. */
export function useResizableSidebar(options: ResizableSidebarOptions): ResizableSidebarState {
  const {
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth
  } = options;
  const [width, setWidth] = useState(() => readStoredSidebarWidth(storageKey, defaultWidth, minWidth, maxWidth));
  const [dragState, setDragState] = useState<SidebarDragState | null>(null);
  const setClampedWidth = useCallback(
    (nextWidth: number) => setWidth(clampSidebarWidth(nextWidth, minWidth, maxWidth)),
    [maxWidth, minWidth]
  );
  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      setDragState({ startX: event.clientX, startWidth: width });
    },
    [width]
  );
  const resizeBy = useCallback(
    (delta: number) => setClampedWidth(width + delta),
    [setClampedWidth, width]
  );
  const sidebarStyle = useMemo<CSSProperties>(
    () => ({
      width,
      minWidth,
      maxWidth,
      flexBasis: width
    }),
    [maxWidth, minWidth, width]
  );

  useEffect(() => {
    setClampedWidth(width);
  }, [setClampedWidth, width]);

  useEffect(() => {
    writeStoredSidebarWidth(storageKey, width);
  }, [storageKey, width]);

  useEffect(() => {
    if (!dragState || typeof window === "undefined") {
      return;
    }

    const body = window.document.body;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;

    body.style.cursor = "col-resize";
    body.style.userSelect = "none";

    const handlePointerMove = (event: PointerEvent) => {
      setClampedWidth(dragState.startWidth + event.clientX - dragState.startX);
    };
    const stopResize = () => setDragState(null);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);

    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, [dragState, setClampedWidth]);

  return {
    width,
    minWidth,
    maxWidth,
    isResizing: Boolean(dragState),
    sidebarStyle,
    beginResize,
    resizeBy
  };
}

/** Handles use codex resizable sidebar. */
export function useCodexResizableSidebar(storageKey: string): ResizableSidebarState {
  const layout = useMemo(() => readCodexSidebarLayout(), []);
  return useResizableSidebar({
    storageKey,
    defaultWidth: layout.defaultWidth,
    minWidth: layout.minWidth,
    maxWidth: layout.maxWidth
  });
}

/** Handles sidebar resize handle. */
export function SidebarResizeHandle(props: SidebarResizeHandleProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.isDisabled) {
      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    props.onResizeBy(event.key === "ArrowRight" ? 16 : -16);
  };

  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuemin={props.minWidth}
      aria-valuemax={props.maxWidth}
      aria-valuenow={props.width}
      aria-disabled={props.isDisabled ? true : undefined}
      tabIndex={props.isDisabled ? -1 : 0}
      className={`sidebar-resize-handle${props.isResizing ? " sidebar-resize-handle--active" : ""}${props.isDisabled ? " sidebar-resize-handle--disabled" : ""}`}
      onPointerDown={props.isDisabled ? undefined : props.onResizeStart}
      onKeyDown={handleKeyDown}
    />
  );
}

export function clampSidebarWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

function readStoredSidebarWidth(storageKey: string, defaultWidth: number, minWidth: number, maxWidth: number): number {
  if (typeof window === "undefined") {
    return defaultWidth;
  }

  try {
    const rawValue = window.localStorage.getItem(storageKey);
    const value = rawValue == null ? Number.NaN : Number.parseInt(rawValue, 10);
    return Number.isFinite(value) ? clampSidebarWidth(value, minWidth, maxWidth) : defaultWidth;
  } catch {
    return defaultWidth;
  }
}

function writeStoredSidebarWidth(storageKey: string, width: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // If the user has disabled storage, this drag is unaffected.
  }
}
