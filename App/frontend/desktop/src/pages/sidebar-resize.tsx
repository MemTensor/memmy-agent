/** Sidebar resize module. */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
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
  resizeDirection?: 1 | -1;
  /**
   * Inline size of the flex row this pane shares with the primary content.
   *
   * When measured, the pane is capped at `availableWidth - reservedPrimaryWidth`
   * so narrowing the window shrinks the pane instead of pushing the conversation
   * out of the row. `null` means "not measured yet" and leaves the pane alone,
   * which is what non-measuring hosts (and jsdom tests) get.
   */
  availableWidth?: number | null;
  /** Space the shared row always keeps for the primary content beside the pane. */
  reservedPrimaryWidth?: number;
}

export interface ResizableSidebarState {
  /** The width the user asked for, stored across sessions. */
  width: number;
  /**
   * The width actually rendered.
   *
   * It differs from {@link ResizableSidebarState.width} only while the shared
   * row is too narrow for the preference. Keeping the two apart is what lets the
   * pane return to the user's chosen width when the window grows again; anything
   * that positions against the pane (the top-bar actions) must use this one.
   */
  appliedWidth: number;
  /** The floor actually rendered, after the shared-row fit. */
  appliedMinWidth: number;
  /** The ceiling actually rendered, after the shared-row fit. */
  appliedMaxWidth: number;
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
    maxWidth,
    resizeDirection = 1,
    availableWidth = null,
    reservedPrimaryWidth
  } = options;
  const [width, setWidth] = useState(() => readStoredSidebarWidth(storageKey, defaultWidth, minWidth, maxWidth));
  const [dragState, setDragState] = useState<SidebarDragState | null>(null);
  const setClampedWidth = useCallback(
    // Only the pane's own bounds go into the preference; the shared row caps
    // the rendered width separately, so a narrow window never rewrites it.
    (nextWidth: number) => setWidth(clampSidebarWidth(nextWidth, minWidth, maxWidth)),
    [maxWidth, minWidth]
  );
  // A pane that shares its row has to yield when that row can no longer afford
  // its floor: otherwise the pane overflows and the conversation beside it
  // disappears behind the row's `overflow: hidden`. Panes without a shared row
  // (the file browser, the app sidebar) keep their own bounds untouched.
  const sharesRow = reservedPrimaryWidth != null && availableWidth != null && Number.isFinite(availableWidth);
  const appliedMaxWidth = fitSidebarMaxWidth(availableWidth, reservedPrimaryWidth, maxWidth);
  const appliedMinWidth = sharesRow
    ? Math.max(SHARED_ROW_MIN_PANE_WIDTH, Math.min(minWidth, appliedMaxWidth))
    : minWidth;
  const appliedWidth = clampSidebarWidth(width, appliedMinWidth, appliedMaxWidth);
  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      // Drag from the width on screen, not the stored preference. When the row
      // is capping the pane the two differ, and starting from the preference
      // would leave the handle dead until the drag travelled past the cap.
      setDragState({ startX: event.clientX, startWidth: appliedWidth });
    },
    [appliedWidth]
  );
  const resizeBy = useCallback(
    (delta: number) => setClampedWidth(appliedWidth + delta * resizeDirection),
    [appliedWidth, resizeDirection, setClampedWidth]
  );
  const sidebarStyle = useMemo<CSSProperties>(
    () => ({
      width: appliedWidth,
      minWidth: appliedMinWidth,
      maxWidth: appliedMaxWidth,
      flexBasis: appliedWidth
    }),
    [appliedMaxWidth, appliedMinWidth, appliedWidth]
  );

  useEffect(() => {
    // Re-clamp only against the pane's own bounds. Folding the row fit in here
    // would persist a narrow window's cap as the user's preference, and the
    // pane would stay shrunken after the window grew back.
    setWidth(clampSidebarWidth(width, minWidth, maxWidth));
  }, [maxWidth, minWidth, width]);

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
      setClampedWidth(dragState.startWidth + (event.clientX - dragState.startX) * resizeDirection);
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
  }, [dragState, resizeDirection, setClampedWidth]);

  return {
    width,
    appliedWidth,
    appliedMinWidth,
    appliedMaxWidth,
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

/**
 * Measures the inline size of the flex row a pane shares with the chat.
 *
 * A pane can only stay out of the conversation's way if it knows how much room
 * the row actually has, and that room changes whenever the window or the app
 * sidebar is resized. `ResizeObserver` reports both without a window listener.
 *
 * @returns The row ref to attach, and its measured width (`null` until measured).
 */
export function useSharedRowWidth<T extends HTMLElement>(): readonly [RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = (value: number) => {
      // A zero-width row means "not laid out yet" (first render, or jsdom), not
      // "no room". Reporting it as a measurement would collapse the pane.
      if (!(value > 0)) return;
      setWidth((current) => (current != null && Math.abs(current - value) < 0.5 ? current : value));
    };
    update(element.clientWidth);

    if (typeof ResizeObserver === "undefined") {
      // jsdom and other non-layout hosts: report once and never re-measure.
      return;
    }

    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
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

/**
 * Caps a pane's ceiling so it shares its row with the primary content.
 *
 * Without the cap a pane whose width no longer fits keeps its size, overflows
 * the flex row, and the row's `overflow: hidden` hides the conversation
 * entirely. Reserving {@link SHARED_ROW_PRIMARY_RESERVE} leaves the conversation
 * visible while the pane shrinks with the window.
 *
 * @param availableWidth Measured inline size of the shared row, if known.
 * @param reservedPrimaryWidth Space kept for the primary content beside the pane.
 * @param maxWidth The pane's own preferred ceiling.
 * @returns The ceiling to clamp against.
 */
export function fitSidebarMaxWidth(
  availableWidth: number | null,
  reservedPrimaryWidth: number | undefined,
  maxWidth: number
): number {
  if (availableWidth == null || !Number.isFinite(availableWidth) || reservedPrimaryWidth == null) {
    return maxWidth;
  }

  return Math.max(SHARED_ROW_MIN_PANE_WIDTH, Math.min(maxWidth, Math.floor(availableWidth - reservedPrimaryWidth)));
}

/**
 * Narrowest a side pane may become while still previewing something.
 *
 * Below this the preview stops being readable, so the shared row stops shrinking
 * the pane and lets the chat give up its share instead. The stylesheet's overlay
 * fallback takes over only under `SHARED_ROW_MIN_CHAT_WIDTH + this`, a row the
 * desktop window's minimum width keeps out of reach.
 */
export const SHARED_ROW_MIN_PANE_WIDTH = 240;

/**
 * Space a shared flex row keeps for the chat before the preview starts to yield.
 *
 * The pane is a preview of something the chat already refers to, so the chat is
 * the surface that must stay usable: at this width the pane stops growing and
 * the two columns keep sharing the row instead of one covering the other. Under
 * {@link SHARED_ROW_MIN_CHAT_WIDTH} the chat would be too narrow to use, which
 * is where the stylesheet's overlay fallback becomes the better of two bad
 * options; see the `agent-workspace` container query in styles.css.
 */
export const SHARED_ROW_PRIMARY_RESERVE = 420;

/**
 * Row width under which the chat is too narrow to keep beside the preview.
 *
 * `SHARED_ROW_MIN_PANE_WIDTH + SHARED_ROW_MIN_CHAT_WIDTH` is the overlay
 * breakpoint in styles.css, and `fullWindowOptions.minWidth` in the desktop
 * shell is sized to keep the app's narrowest row above it.
 */
export const SHARED_ROW_MIN_CHAT_WIDTH = 240;

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
