import { RecordingEntryPage, type RecordingEntrySession } from "./recording-entry.js";
import { InterviewRecordingPanel, type RecordingPanelSession } from "./interview-recording-panel.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AudioLines, LockKeyhole, Copy, Globe2, Maximize2, Minimize2, PanelRight, Pin, PinOff, Plus, X } from "lucide-react";
import type { AgentChatMessage } from "../state/agent-chat-slice.js";
import { useTranslation } from "../i18n/use-translation.js";
import { ThreadFileIcon } from "./agent-thread-file-icon.js";
import {
  clampThreadListWidth,
  clampThreadPanelWidth,
  closeThreadTab,
  collectThreadArtifacts,
  collectThreadFileChanges,
  normalizeThreadPath,
  openThreadTab,
  threadPanelContentWidth,
  threadPanelOffset,
  threadPanelUsesOverlay,
  threadTabForArtifact,
  threadTabForChange,
  threadTabForPath,
  THREAD_LIST_DEFAULT_WIDTH,
  THREAD_PANEL_MIN_WIDTH,
  THREAD_PANEL_NARROW_WIDTH,
  type ThreadPanelTab,
  type ThreadPanelView,
  type ThreadTabState,
} from "./agent-thread-panel-model.js";
import { ThreadTabPreview, type ThreadPreviewContext } from "./agent-thread-panel-preview.js";
import { BrowserPanel, isBlankBrowserUrl, MEMMY_BROWSER_NEW_TAB_EVENT,
  MEMMY_BROWSER_OPEN_EVENT, takePendingBrowserNewTab } from "./browser-panel.js";
import {
  ThreadChangesView,
  ThreadFilesView,
  ThreadOverviewView,
  ThreadViewSelector,
  type ThreadViewVariant,
} from "./agent-thread-panel-views.js";

export const THREAD_PANEL_WIDTH_STORAGE_KEY = "memmy.threadPanel.width.v1";
export const THREAD_PANEL_CLOSE_MS = 150;
export const THREAD_PANEL_FULLSCREEN_BODY_CLASS = "memmy-thread-panel-fullscreen";
export const PLUGIN_RECORDING_TAB_ID = "recording:plugin";
const POPOVER_CLOSE_DELAY_MS = 160;
const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 560;
const POPOVER_VIEWPORT_PADDING = 12;
const KEYBOARD_RESIZE_STEP = 16;
const EMPTY_TABS: ThreadTabState = { tabs: [], activeId: null };

export type ThreadPanelPhase = "closed" | "open" | "closing";
export type ThreadPanelMotion = "open" | "closing" | "resizing";

type StoredWidths = { sidebar: number; content: number | null };

function readStoredWidths(): StoredWidths {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY) ?? "null") as Partial<StoredWidths> | null;
    return {
      sidebar: typeof parsed?.sidebar === "number" && Number.isFinite(parsed.sidebar) ? parsed.sidebar : THREAD_PANEL_MIN_WIDTH,
      content: typeof parsed?.content === "number" && Number.isFinite(parsed.content) ? parsed.content : null,
    };
  } catch {
    return { sidebar: THREAD_PANEL_MIN_WIDTH, content: null };
  }
}

function writeStoredWidths(widths: StoredWidths) {
  try {
    window.localStorage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Width memory is a convenience; private or full storage must not break the panel.
  }
}

export type AgentThreadPanelController = ReturnType<typeof useAgentThreadPanel>;

type PanelSession = {
  phase: ThreadPanelPhase; fullscreen: boolean; view: ThreadPanelView; tabState: ThreadTabState;
  pinned: boolean; artifactsCollapsed: boolean; listWidth: number; resizing: boolean;
  closingWidth: number | null; clearTabsOnClose: boolean;
};
const EMPTY_PANEL_SESSION: PanelSession = {
  phase: 'closed', fullscreen: false, view: 'overview', tabState: EMPTY_TABS, pinned: false,
  artifactsCollapsed: false, listWidth: THREAD_LIST_DEFAULT_WIDTH, resizing: false,
  closingWidth: null, clearTabsOnClose: false,
};
function finishPanelClose(state: PanelSession): PanelSession {
  return { ...state, phase: 'closed', closingWidth: null, resizing: false,
    ...(state.clearTabsOnClose ? { tabState: EMPTY_TABS, pinned: false } : {}), clearTabsOnClose: false };
}

export function useAgentThreadPanel(options: { scopeKey: string; containerRef: RefObject<HTMLElement | null>; enabled: boolean }) {
  const [aliases, setAliases] = useState(() => new Map<string, string>());
  const aliasesRef = useRef(aliases);
  aliasesRef.current = aliases;
  const resolveScopeOwner = useCallback((scopeKey: string) => aliasesRef.current.get(scopeKey) ?? scopeKey, []);
  const ownerKey = aliases.get(options.scopeKey) ?? options.scopeKey;
  const [sessions, setSessions] = useState(() => new Map<string, PanelSession>());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const session = sessions.get(ownerKey) ?? EMPTY_PANEL_SESSION;
  const { phase, fullscreen, view, tabState, pinned, artifactsCollapsed, listWidth, resizing } = session;
  const updateSession = useCallback((owner: string, update: (previous: PanelSession) => PanelSession) => {
    setSessions(current => {
      const previous = current.get(owner) ?? EMPTY_PANEL_SESSION;
      const next = update(previous);
      if (next === previous) return current;
      return new Map(current).set(owner, next);
    });
  }, []);
  const promoteScope = useCallback((from: string, to: string): void => {
    if (!from || !to || from === to) return;
    const owner = resolveScopeOwner(from);
    const next = new Map(aliasesRef.current).set(to, owner);
    aliasesRef.current = next;
    setAliases(next);
  }, [resolveScopeOwner]);
  const [widths, setWidths] = useState<StoredWidths>(readStoredWidths);
  const [containerWidth, setContainerWidth] = useState(0);
  const closeTimerRef = useRef<{ id: number; owner: string } | null>(null);
  const widthsDirtyRef = useRef(false);
  const previousOwnerRef = useRef(ownerKey);
  useLayoutEffect(() => {
    const previous = previousOwnerRef.current;
    if (previous === ownerKey) return;
    previousOwnerRef.current = ownerKey;
    if (closeTimerRef.current?.owner === previous) {
      window.clearTimeout(closeTimerRef.current.id);
      closeTimerRef.current = null;
    }
    updateSession(previous, state => state.phase === 'closing' ? finishPanelClose(state)
      : state.resizing ? { ...state, resizing: false } : state);
  }, [ownerKey, updateSession]);

  const containerRef = options.containerRef;
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setContainerWidth(element.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef, options.enabled]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current.id);
  }, []);

  useEffect(() => {
    if (resizing || !widthsDirtyRef.current) return;
    widthsDirtyRef.current = false;
    writeStoredWidths(widths);
  }, [resizing, widths]);

  const hasContent = tabState.tabs.length > 0;
  const overlay = threadPanelUsesOverlay(containerWidth);
  const liveWidth = overlay ? containerWidth : hasContent
    ? clampThreadPanelWidth(widths.content ?? threadPanelContentWidth(containerWidth), containerWidth)
    : clampThreadPanelWidth(widths.sidebar, containerWidth);
  const width = phase === "closing" && session.closingWidth != null ? session.closingWidth : liveWidth;
  const visible = options.enabled && phase !== "closed";
  const offset = options.enabled && phase === "open" && !overlay ? threadPanelOffset(width, containerWidth) : 0;
  const motion: ThreadPanelMotion = resizing ? "resizing" : phase === "closing" ? "closing" : "open";
  const liveWidthRef = useRef(liveWidth);
  liveWidthRef.current = liveWidth;
  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;
  const cancelCloseTimer = useCallback(() => {
    if (closeTimerRef.current?.owner === ownerKey) {
      window.clearTimeout(closeTimerRef.current.id);
      closeTimerRef.current = null;
    }
  }, [ownerKey]);
  const open = useCallback(() => {
    cancelCloseTimer();
    updateSession(ownerKey, state => ({ ...state, phase: 'open', closingWidth: null, clearTabsOnClose: false,
      ...(state.clearTabsOnClose ? { tabState: EMPTY_TABS, pinned: false } : {}) }));
  }, [ownerKey, updateSession, cancelCloseTimer]);

  const close = useCallback(() => {
    cancelCloseTimer();
    updateSession(ownerKey, state => ({ ...state, fullscreen: false, closingWidth: liveWidthRef.current,
      phase: state.phase === 'closed' ? 'closed' : 'closing' }));
    const id = window.setTimeout(() => {
      if (closeTimerRef.current?.id === id) closeTimerRef.current = null;
      updateSession(ownerKey, finishPanelClose);
    }, THREAD_PANEL_CLOSE_MS);
    closeTimerRef.current = { id, owner: ownerKey };
  }, [ownerKey, updateSession, cancelCloseTimer]);

  const ensureContentWidth = useCallback(() => {
    const minimum = threadPanelContentWidth(containerWidthRef.current);
    setWidths((current) => {
      const content = Math.max(current.content ?? 0, minimum);
      return content === current.content ? current : { ...current, content };
    });
  }, []);

  const openTab = useCallback((tab: ThreadPanelTab) => {
    cancelCloseTimer();
    updateSession(ownerKey, state => ({ ...state, phase: 'open', closingWidth: null, clearTabsOnClose: false,
      tabState: openThreadTab(state.clearTabsOnClose ? EMPTY_TABS : state.tabState, tab),
      pinned: liveWidthRef.current < THREAD_PANEL_NARROW_WIDTH ? false : state.pinned }));
    ensureContentWidth();
  }, [ownerKey, updateSession, cancelCloseTimer, ensureContentWidth]);

  const activateTab = useCallback((id: string) => {
    updateSession(ownerKey, state => state.tabState.tabs.some(tab => tab.id === id)
      ? { ...state, tabState: { ...state.tabState, activeId: id } } : state);
  }, [ownerKey, updateSession]);

  const closeTab = useCallback((id: string) => {
    const next = closeThreadTab((sessionsRef.current.get(ownerKey) ?? EMPTY_PANEL_SESSION).tabState, id);
    if (next.tabs.length) {
      updateSession(ownerKey, state => ({ ...state, tabState: next }));
      return;
    }
    updateSession(ownerKey, state => ({ ...state, clearTabsOnClose: true }));
    close();
  }, [ownerKey, updateSession, close]);

  const resize = useCallback((nextWidth: number) => {
    const clamped = clampThreadPanelWidth(nextWidth, containerWidthRef.current);
    widthsDirtyRef.current = true;
    setWidths((current) => ((sessionsRef.current.get(ownerKey) ?? EMPTY_PANEL_SESSION).tabState.tabs.length
      ? { ...current, content: clamped }
      : { ...current, sidebar: clamped }));
  }, [ownerKey]);

  const finishResize = useCallback(() => updateSession(ownerKey, state => ({ ...state, resizing: false })), [ownerKey, updateSession]);

  const togglePinned = useCallback(() => {
    if (!(sessionsRef.current.get(ownerKey) ?? EMPTY_PANEL_SESSION).pinned) ensureContentWidth();
    updateSession(ownerKey, state => ({ ...state, pinned: !state.pinned }));
  }, [ownerKey, updateSession, ensureContentWidth]);
  const setView = useCallback((next: ThreadPanelView) => updateSession(ownerKey, state => ({ ...state, view: next })), [ownerKey, updateSession]);
  const setFullscreen = useCallback((next: boolean) => updateSession(ownerKey, state => ({ ...state, fullscreen: next })), [ownerKey, updateSession]);

  return {
    scopeKey: options.scopeKey,
    ownerKey,
    resolveScopeOwner,
    promoteScope,
    phase,
    visible,
    motion,
    width,
    offset,
    overlay,
    fullscreen,
    view,
    tabState,
    hasContent,
    pinned,
    listWidth: clampThreadListWidth(listWidth, width),
    artifactsCollapsed,
    resizing,
    open,
    close,
    toggle: phase === "open" ? close : open,
    setView,
    setFullscreen,
    openTab,
    activateTab,
    closeTab,
    togglePinned,
    setListWidth: (next: number) => updateSession(ownerKey, state => ({ ...state, listWidth: clampThreadListWidth(next, width) })),
    toggleArtifactsCollapsed: () => updateSession(ownerKey, state => ({ ...state, artifactsCollapsed: !state.artifactsCollapsed })),
    beginResize: () => updateSession(ownerKey, state => ({ ...state, resizing: true })),
    resize,
    finishResize,
  };
}

type BrowserTab = { id: number; guestId?: number; url?: string; title?: string };
type BrowserSession = { open: boolean; mounted: boolean; tabs: BrowserTab[]; activeId: number; copiedId: number | null };
type BrowserTabRequest = { url: string; scopeKey?: string; sourceGuestId?: number };

/** Memmy's unused new tab is about:blank, the same role as Chrome's new-tab page. */
function isUnusedNewTab(tab: BrowserTab): boolean {
  return !tab.url || isBlankBrowserUrl(tab.url);
}
const EMPTY_BROWSER_SESSION: BrowserSession = {
  open: false, mounted: false, tabs: [{ id: 1, url: '' }], activeId: 1, copiedId: null,
};

export function AgentThreadPanel(props: {
  controller: AgentThreadPanelController;
  messages: AgentChatMessage[];
  workspaceRoot: string | null;
  previewContext: ThreadPreviewContext;
  recordingSession?: RecordingEntrySession;
  pluginRecordingSession?: RecordingPanelSession | null;
  recordingAuthenticated?: boolean;
  onRecordingSignIn?: () => void;
  onOpenRecording?: () => void;
  onCloseRecording?: () => void;
  onClosePluginRecording?: () => void;
  recordingRevealRequestId?: number;
  onRecordingVisibleChange?: (visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const panel = props.controller;
  const artifacts = useMemo(() => collectThreadArtifacts(props.messages), [props.messages]);
  const changes = useMemo(() => collectThreadFileChanges(props.messages), [props.messages]);
  const filesRefreshToken = useMemo(
    () => changes.map((change) => `${change.key}:${change.added}:${change.deleted}`).join("|") + `#${artifacts.length}`,
    [artifacts.length, changes],
  );
  const activeTab = panel.tabState.tabs.find((tab) => tab.id === panel.tabState.activeId) ?? null;
  const activeFileKey = activeTab?.type === "file" ? normalizeThreadPath(activeTab.path ?? activeTab.url ?? "") : null;
  const activeChangeKey = activeTab?.type === "change" ? activeTab.id.slice("change:".length) : null;
  const listVisible = !panel.hasContent || panel.pinned;
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverTimerRef = useRef<number | null>(null);
  const popoverHoveredRef = useRef(false);
  const popoverMenuOpenRef = useRef(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [listResizing, setListResizing] = useState(false);
  const ownerKey = panel.ownerKey;
  const [browserSessions, setBrowserSessions] = useState(() => new Map<string, BrowserSession>([
    [ownerKey, EMPTY_BROWSER_SESSION],
  ]));
  const browserSessionsRef = useRef(browserSessions);
  browserSessionsRef.current = browserSessions;
  const browserSession = browserSessions.get(ownerKey) ?? EMPTY_BROWSER_SESSION;
  const { open: browserOpen, mounted: browserMounted, tabs: browserTabs,
    activeId: activeBrowserTabId, copiedId: copiedBrowserTabId } = browserSession;
  const recordingVisible = panel.visible && panel.phase === "open" && !browserOpen && activeTab?.id === "recording:main";
  useEffect(() => props.onRecordingVisibleChange?.(recordingVisible), [props.onRecordingVisibleChange, recordingVisible]);
  // The overview list is hidden behind either a file preview or a browser tab.
  // A pinned list is also hidden while the browser surface is selected.
  const pinnedListVisible = panel.pinned && panel.hasContent && !browserOpen;
  const popoverAllowed = panel.visible && panel.phase === 'open'
    && (panel.hasContent || browserOpen) && !pinnedListVisible;
  const anyBrowserMounted = [...browserSessions.values()].some(session => session.mounted);
  const nextBrowserTabId = useRef(2);
  const backgroundBrowserOwners = useRef(new Set<string>());
  const updateBrowser = useCallback((owner: string, update: (previous: BrowserSession) => BrowserSession) => {
    setBrowserSessions(current => {
      const previous = current.get(owner) ?? EMPTY_BROWSER_SESSION;
      const next = update(previous);
      return next === previous ? current : new Map(current).set(owner, next);
    });
  }, []);
  const setBrowserOpen = (open: boolean) => updateBrowser(ownerKey, state => ({ ...state, open }));
  const lastRecordingRevealRequest = useRef(0);
  useEffect(() => {
    const requestId = props.recordingRevealRequestId ?? 0;
    if (!requestId || requestId <= lastRecordingRevealRequest.current) return;
    lastRecordingRevealRequest.current = requestId;
    updateBrowser(ownerKey, state => state.open ? { ...state, open: false } : state);
  }, [props.recordingRevealRequestId, ownerKey, updateBrowser]);
  const setActiveBrowserTabId = (activeId: number) => updateBrowser(ownerKey, state => ({ ...state, activeId }));
  const addBrowserTab = useCallback((url?: string, owner = ownerKey, fromPagePopup = false) => {
    const id = nextBrowserTabId.current++;
    updateBrowser(owner, state => {
      // Chrome on macOS opens the URL as its own tab, then closes the new-tab
      // page only when that page was the window's only tab. A page-initiated
      // popup never consumes it, and any other new tab stays where it is.
      const dropLoneNewTab = Boolean(url) && !fromPagePopup && state.tabs.length === 1
        && state.tabs[0] !== undefined && isUnusedNewTab(state.tabs[0]);
      return { ...state, tabs: dropLoneNewTab ? [{ id, url }] : [...state.tabs, { id, url: url ?? '' }],
        activeId: id, mounted: true, open: true };
    });
    if (owner === ownerKey) panel.open();
    else backgroundBrowserOwners.current.add(owner);
  }, [ownerKey, updateBrowser, panel.open]);
  useEffect(() => {
    if (!backgroundBrowserOwners.current.delete(ownerKey)) return;
    const session = browserSessionsRef.current.get(ownerKey);
    if (session?.mounted && session.open) panel.open();
  }, [ownerKey, panel.open]);
  const ensureBrowserOpen = useCallback(() => {
    const id = nextBrowserTabId.current++;
    updateBrowser(ownerKey, state => ({ ...state, mounted: true, open: true,
      ...(state.tabs.length ? {} : { tabs: [{ id, url: '' }], activeId: id }) }));
    panel.open();
  }, [ownerKey, updateBrowser, panel.open]);
  const closeBrowserTab = useCallback((id: number, owner = ownerKey) => {
    updateBrowser(owner, state => {
      const tabs = state.tabs.filter(tab => tab.id !== id);
      return { ...state, tabs, mounted: tabs.length > 0, open: tabs.length > 0 && state.open,
        activeId: state.activeId === id ? tabs.at(-1)?.id ?? 1 : state.activeId };
    });
  }, [ownerKey, updateBrowser]);
  useEffect(() => window.memmy?.onEmbeddedBrowserClose?.((guestId) => {
    for (const [owner, session] of browserSessionsRef.current) {
      const tab = session.tabs.find(item => item.guestId === guestId);
      if (tab) { closeBrowserTab(tab.id, owner); break; }
    }
  }), [closeBrowserTab]);
  const copyBrowserTabMention = useCallback(async (guestId: number, id: number) => {
    try {
      if (!window.memmy?.copyEmbeddedBrowserTabMention) return;
      await window.memmy.copyEmbeddedBrowserTabMention(guestId);
      updateBrowser(ownerKey, state => ({ ...state, copiedId: id }));
    } catch { updateBrowser(ownerKey, state => ({ ...state, copiedId: null })); }
  }, [ownerKey, updateBrowser]);
  const requestOwner = useCallback((request?: { scopeKey?: string; sourceGuestId?: number }): string | null => {
    const explicit = request?.scopeKey ? panel.resolveScopeOwner(request.scopeKey) : null;
    if (request?.sourceGuestId !== undefined) {
      const match = [...browserSessionsRef.current].find(([, state]) =>
        state.tabs.some(tab => tab.guestId === request.sourceGuestId));
      if (!match || (explicit && explicit !== match[0])) return null;
      return match[0];
    }
    return explicit ?? ownerKey;
  }, [ownerKey, panel.resolveScopeOwner]);
  const openRequestedTab = useCallback((request: BrowserTabRequest) => {
    const owner = requestOwner(request);
    if (owner && /^https?:\/\//.test(request.url)) {
      addBrowserTab(request.url, owner, request.sourceGuestId !== undefined);
    }
  }, [requestOwner, addBrowserTab]);
  const consumePendingTabs = useCallback((fallback?: BrowserTabRequest) => {
    let consumed = false;
    for (let pending = takePendingBrowserNewTab(); pending; pending = takePendingBrowserNewTab()) {
      consumed = true;
      openRequestedTab(pending);
    }
    if (!consumed && fallback) openRequestedTab(fallback);
  }, [openRequestedTab]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ scopeKey?: string; sourceGuestId?: number; newTab?: boolean }>).detail;
      if (detail?.newTab) return;
      const owner = requestOwner(detail);
      if (owner === ownerKey) ensureBrowserOpen();
    };
    const newTab = (event: Event) => {
      const request = (event as CustomEvent<BrowserTabRequest>).detail;
      consumePendingTabs(request);
    };
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, open);
    window.addEventListener(MEMMY_BROWSER_NEW_TAB_EVENT, newTab);
    return () => {
      window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, open);
      window.removeEventListener(MEMMY_BROWSER_NEW_TAB_EVENT, newTab);
    };
  }, [ownerKey, requestOwner, consumePendingTabs, ensureBrowserOpen]);
  useEffect(() => consumePendingTabs(), [consumePendingTabs]);
  const activeGuestId = browserTabs.find(tab => tab.id === activeBrowserTabId)?.guestId;
  useEffect(() => {
    const selected = panel.visible && browserOpen ? activeGuestId ?? null : null;
    const result = window.memmy?.selectEmbeddedBrowserTab?.(selected);
    void Promise.resolve(result).catch(() => undefined);
  }, [ownerKey, panel.visible, browserOpen, activeGuestId]);
  const { fullscreen, setFullscreen } = panel;

  const cancelPopoverClose = useCallback(() => {
    if (popoverTimerRef.current != null) {
      window.clearTimeout(popoverTimerRef.current);
      popoverTimerRef.current = null;
    }
  }, []);
  const schedulePopoverClose = useCallback(() => {
    cancelPopoverClose();
    if (popoverMenuOpenRef.current) return;
    popoverTimerRef.current = window.setTimeout(() => {
      popoverTimerRef.current = null;
      setPopoverOpen(false);
    }, POPOVER_CLOSE_DELAY_MS);
  }, [cancelPopoverClose]);

  useEffect(() => {
    if (!popoverAllowed) setPopoverOpen(false);
  }, [popoverAllowed]);

  useEffect(() => {
    cancelPopoverClose();
    popoverHoveredRef.current = false;
    popoverMenuOpenRef.current = false;
    setPopoverOpen(false);
    setListResizing(false);
  }, [ownerKey, cancelPopoverClose]);

  useEffect(() => () => cancelPopoverClose(), [cancelPopoverClose]);

  useEffect(() => {
    if (!popoverOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      if (target.closest("[data-thread-popover-layer]")) return;
      setPopoverOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [popoverOpen]);

  useEffect(() => {
    if (!fullscreen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setFullscreen(false);
    }
    document.body.classList.add(THREAD_PANEL_FULLSCREEN_BODY_CLASS);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.classList.remove(THREAD_PANEL_FULLSCREEN_BODY_CLASS);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fullscreen, setFullscreen]);

  function handleTriggerEnter() {
    if (!popoverAllowed) return;
    popoverHoveredRef.current = true;
    cancelPopoverClose();
    setPopoverOpen(true);
  }

  function handleTriggerLeave() {
    popoverHoveredRef.current = false;
    schedulePopoverClose();
  }

  function handlePopoverMenuOpenChange(open: boolean) {
    popoverMenuOpenRef.current = open;
    if (open) {
      cancelPopoverClose();
    } else if (!popoverHoveredRef.current) {
      schedulePopoverClose();
    }
  }

  function startPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || fullscreen) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.width;
    panel.beginResize();
    trackPointer(
      (moveEvent) => panel.resize(startWidth + (startX - moveEvent.clientX)),
      panel.finishResize,
    );
  }

  function handlePanelSashKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    panel.resize(panel.width + (event.key === "ArrowLeft" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP));
    panel.finishResize();
  }

  function startListResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.listWidth;
    setListResizing(true);
    trackPointer(
      (moveEvent) => panel.setListWidth(startWidth + (moveEvent.clientX - startX)),
      () => setListResizing(false),
    );
  }

  function renderView(variant: ThreadViewVariant) {
    if (panel.view === "files") {
      return (
        <ThreadFilesView
          rootPath={props.workspaceRoot}
          activeKey={activeFileKey}
          refreshToken={filesRefreshToken}
          variant={variant}
          onOpenFile={(entry) => panel.openTab(threadTabForPath(entry.path, entry.name))}
        />
      );
    }
    if (panel.view === "changes") {
      return (
        <ThreadChangesView
          changes={changes}
          activeKey={activeChangeKey}
          variant={variant}
          onSelect={(change) => panel.openTab(threadTabForChange(change))}
        />
      );
    }
    return (
      <ThreadOverviewView
        artifacts={artifacts}
        activeKey={activeFileKey}
        collapsed={panel.artifactsCollapsed}
        variant={variant}
        onToggleCollapsed={panel.toggleArtifactsCollapsed}
        onSelect={(artifact) => panel.openTab(threadTabForArtifact(artifact))}
      />
    );
  }

  const className = [
    "thread-panel",
    `thread-panel--${panel.phase}`,
    panel.hasContent ? "thread-panel--content" : "thread-panel--sidebar",
    listVisible ? "thread-panel--list-visible" : "",
    fullscreen ? "thread-panel--fullscreen" : "",
    panel.overlay ? "thread-panel--overlay" : "",
  ].filter(Boolean).join(" ");

  return (
    <aside className={className} aria-hidden={!panel.visible}
      style={!panel.visible ? (anyBrowserMounted ? {
        position: 'fixed', left: -10_000, top: 0, width: Math.max(panel.width, 800),
        height: 600, opacity: 0, pointerEvents: 'none',
      } : { display: 'none' }) : fullscreen ? undefined : { width: panel.width }}
      aria-label={t("home.threadPanel.label")}>
      {fullscreen || panel.overlay ? null : (
        <div
          className={`thread-panel__sash${panel.resizing ? " thread-panel__sash--active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("home.threadPanel.resize")}
          aria-valuenow={panel.width}
          tabIndex={0}
          onPointerDown={startPanelResize}
          onKeyDown={handlePanelSashKeyDown}
        />
      )}
      <header className="thread-panel__header" data-window-drag-exclusion="thread-panel-header">
        <div className="thread-panel__header-main">
          <div
            ref={triggerRef}
            className="thread-panel__overview-trigger"
            onPointerEnter={handleTriggerEnter}
            onPointerLeave={handleTriggerLeave}
          >
            <button
              type="button"
              className={`thread-panel__icon-button thread-panel__overview-button${pinnedListVisible ? " thread-panel__overview-button--inactive" : ""}${popoverOpen ? " thread-panel__icon-button--active" : ""}`}
              aria-label={t(pinnedListVisible ? "home.threadPanel.alreadyPinned" : "home.threadPanel.overview")}
              title={t(pinnedListVisible ? "home.threadPanel.alreadyPinned" : "home.threadPanel.overview")}
              aria-haspopup={popoverAllowed ? "dialog" : undefined}
              aria-expanded={popoverAllowed ? popoverOpen : undefined}
              onClick={() => {
                if (!popoverAllowed) return;
                cancelPopoverClose();
                // Pointer-enter may already have opened the hover list before
                // this click arrives; clicking must not immediately close it.
                setPopoverOpen(true);
              }}
            >
              <ThreadListIcon />
            </button>
          </div>
          {(panel.hasContent || browserMounted) ? (
            <ThreadTabs
              tabs={panel.hasContent ? panel.tabState.tabs : []}
              activeId={panel.tabState.activeId}
              browserSurfaceActive={browserOpen}
              onActivate={(id) => {
                setBrowserOpen(false);
                panel.activateTab(id);
              }}
              onClose={(id) => {
                if (id === PLUGIN_RECORDING_TAB_ID) props.onClosePluginRecording?.();
                else if (panel.tabState.tabs.find((tab) => tab.id === id)?.type === "recording") props.onCloseRecording?.();
                panel.closeTab(id);
              }}
              browserTabs={browserMounted ? browserTabs : []}
              activeBrowserTabId={activeBrowserTabId}
              onActivateBrowser={(id) => {
                setBrowserOpen(true);
                setActiveBrowserTabId(id);
              }}
              onCloseBrowser={closeBrowserTab}
              onCopyBrowser={(guestId, id) => { void copyBrowserTabMention(guestId, id); }}
              copiedBrowserTabId={copiedBrowserTabId}
            />
          ) : null}
        </div>
        <div className="thread-panel__header-actions">
          {props.onOpenRecording && !panel.tabState.tabs.some((tab) => tab.type === "recording") ? (
            <button type="button" className="thread-panel__icon-button" aria-label={t("recording.page.title")}
              title={t("recording.page.title")} onClick={() => { setBrowserOpen(false); props.onOpenRecording?.(); }}>
              <AudioLines size={16} aria-hidden="true" />
            </button>
          ) : null}
          {(panel.hasContent || browserMounted) ? (
            <button
              type="button"
              className="thread-panel__icon-button"
              aria-label={t("browser.newTab")}
              title={t("browser.newTab")}
              onClick={() => addBrowserTab()}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className={`thread-panel__icon-button${browserOpen ? " thread-panel__icon-button--active" : ""}`}
            aria-label={t("browser.title")}
            title={t("browser.title")}
            aria-pressed={browserOpen}
            onClick={ensureBrowserOpen}
          >
            <Globe2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="thread-panel__icon-button"
            aria-label={t(fullscreen ? "home.threadPanel.exitFullscreen" : "home.threadPanel.fullscreen")}
            title={t(fullscreen ? "home.threadPanel.exitFullscreen" : "home.threadPanel.fullscreen")}
            onClick={() => setFullscreen(!fullscreen)}
          >
            {fullscreen ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
          </button>
          {fullscreen ? null : (
            <button
              type="button"
              className="thread-panel__icon-button"
              aria-label={t("home.threadPanel.collapse")}
              title={t("home.threadPanel.collapse")}
              onClick={panel.close}
            >
              <PanelRight size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      <div className="thread-panel__body">
        {anyBrowserMounted ? <div className="memmy-browser-stack" style={!browserOpen ? {
          position: 'fixed', left: -10_000, top: 0, width: 800, height: 600,
          opacity: 0, pointerEvents: 'none',
        } : undefined}>
          {[...browserSessions].filter(([, state]) => state.mounted).flatMap(([tabOwner, state]) =>
            state.tabs.map(tab => <BrowserPanel key={`${tabOwner}:${tab.id}`}
              initialAddress={tab.url ?? ''}
              active={tabOwner === ownerKey && panel.visible && browserOpen && tab.id === state.activeId}
              hidden={tabOwner !== ownerKey || !panel.visible || !browserOpen || tab.id !== state.activeId}
              onTabReady={(guestId) => updateBrowser(tabOwner, current => ({ ...current,
                tabs: current.tabs.map(item => item.id === tab.id && item.guestId !== guestId
                  ? { ...item, guestId } : item) }))}
              onNavigation={(url, title) => updateBrowser(tabOwner, current => ({ ...current,
                tabs: current.tabs.map(item => item.id === tab.id && (item.url !== url || item.title !== title)
                  ? { ...item, url, title } : item) }))} />))}
        </div> : null}
        {!browserOpen && listVisible ? (
          <div className="thread-panel__list" style={panel.hasContent ? { width: panel.listWidth } : undefined}>
            <div className="thread-panel__list-header">
              <ThreadViewSelector variant="panel" value={panel.view} onChange={panel.setView} />
              {panel.hasContent ? (
                <button
                  type="button"
                  className="thread-panel__icon-button thread-panel__pin"
                  aria-label={t("home.threadPanel.unpin")}
                  title={t("home.threadPanel.unpin")}
                  onClick={panel.togglePinned}
                >
                  <PinOff size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="thread-panel__list-body">{renderView("panel")}</div>
          </div>
        ) : null}
        {!browserOpen && listVisible && panel.hasContent ? (
          <div
            className={`thread-panel__list-sash${listResizing ? " thread-panel__list-sash--active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("home.threadPanel.resizeList")}
            onPointerDown={startListResize}
          />
        ) : null}
        {!browserOpen && activeTab ? (
          <div className="thread-panel__main">
            {activeTab.type === "recording"
              ? activeTab.id === PLUGIN_RECORDING_TAB_ID
                ? props.pluginRecordingSession
                  ? <InterviewRecordingPanel embedded session={props.pluginRecordingSession} onClose={props.onClosePluginRecording} /> : null
                : props.recordingAuthenticated || (props.recordingSession && props.recordingSession.status !== "idle")
                  ? props.recordingSession ? <RecordingEntryPage session={props.recordingSession} /> : null
                  : <div className="recording-sign-in"><LockKeyhole size={24} /><p>{t("recording.page.signInTitle")}</p>
                    <button type="button" onClick={props.onRecordingSignIn}>{t("recording.page.signIn")}</button></div>
              : <ThreadTabPreview key={activeTab.id} tab={activeTab} context={props.previewContext} />}
          </div>
        ) : null}
      </div>
      {popoverOpen && popoverAllowed ? (
        <ThreadOverviewPopover
          ref={popoverRef}
          anchor={triggerRef.current}
          onPointerEnter={() => {
            popoverHoveredRef.current = true;
            cancelPopoverClose();
          }}
          onPointerLeave={() => {
            popoverHoveredRef.current = false;
            schedulePopoverClose();
          }}
        >
          <div className="thread-popover__header">
            <ThreadViewSelector
              variant="popover"
              value={panel.view}
              onChange={panel.setView}
              onOpenChange={handlePopoverMenuOpenChange}
            />
            <button
              type="button"
              className="thread-panel__icon-button thread-panel__pin"
              aria-label={t("home.threadPanel.pin")}
              title={t("home.threadPanel.pin")}
              onClick={() => {
                setPopoverOpen(false);
                panel.togglePinned();
              }}
            >
              <Pin size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="thread-popover__body">{renderView("popover")}</div>
        </ThreadOverviewPopover>
      ) : null}
      {panel.resizing || listResizing ? <div className="thread-panel__drag-overlay" aria-hidden="true" /> : null}
    </aside>
  );
}

function ThreadOverviewPopover(props: {
  ref: RefObject<HTMLDivElement | null>;
  anchor: HTMLElement | null;
  children: ReactNode;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { t } = useTranslation();
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const { anchor } = props;

  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(POPOVER_VIEWPORT_PADDING, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - POPOVER_VIEWPORT_PADDING));
      const maxHeight = Math.max(0, Math.min(POPOVER_HEIGHT, window.innerHeight - rect.bottom - POPOVER_VIEWPORT_PADDING));
      setPosition({ top: rect.bottom, left, maxHeight });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchor]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={props.ref}
      className="thread-popover"
      role="dialog"
      aria-label={t("home.threadPanel.overview")}
      style={position ? { top: position.top, left: position.left, maxHeight: position.maxHeight } : { visibility: "hidden" }}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
    >
      {props.children}
    </div>,
    document.body,
  );
}

type BrowserStripTab = { id: number; guestId?: number; url?: string; title?: string };

function browserTabLabel(tab: BrowserStripTab, fallback: string): string {
  const title = tab.title?.trim() ?? "";
  if (title && !isBlankBrowserUrl(title)) return title;
  if (tab.url && !isBlankBrowserUrl(tab.url) && tab.url.startsWith("http")) {
    try { return new URL(tab.url).host; } catch { /* keep the fallback label */ }
  }
  return fallback;
}

function ThreadTabs(props: {
  tabs: ThreadPanelTab[];
  activeId: string | null;
  browserSurfaceActive: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  browserTabs: BrowserStripTab[];
  activeBrowserTabId: number;
  onActivateBrowser: (id: number) => void;
  onCloseBrowser: (id: number) => void;
  onCopyBrowser: (guestId: number, id: number) => void;
  copiedBrowserTabId: number | null;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const items = [
    ...props.tabs.map((tab) => ({ kind: "file" as const, key: tab.id, tab })),
    ...props.browserTabs.map((tab) => ({ kind: "browser" as const, key: `browser:${tab.id}`, tab })),
  ];
  const activeKey = props.browserSurfaceActive ? `browser:${props.activeBrowserTabId}` : props.activeId;

  useEffect(() => {
    const active = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-thread-tab-id]") ?? [])]
      .find((element) => element.dataset.threadTabId === activeKey);
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  function activateAt(index: number) {
    const item = items[index];
    if (!item) return;
    if (item.kind === "file") props.onActivate(item.tab.id);
    else props.onActivateBrowser(item.tab.id);
  }

  function closeAt(index: number) {
    const item = items[index];
    if (!item) return;
    if (item.kind === "file") props.onClose(item.tab.id);
    else props.onCloseBrowser(item.tab.id);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, index: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateAt(index);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      closeAt(index);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = index + (event.key === "ArrowLeft" ? -1 : 1);
      if (!items[next]) return;
      activateAt(next);
      listRef.current?.querySelector<HTMLElement>(`[data-thread-tab-index="${next}"]`)?.focus();
    }
  }

  return (
    <div ref={listRef} className="thread-tabs" role="tablist">
      {items.map((item, index) => {
        if (item.kind === "file") {
          const tab = item.tab;
          const active = !props.browserSurfaceActive && tab.id === props.activeId;
          return (
            <div
              key={item.key}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-thread-tab-id={tab.id}
              data-thread-tab-index={index}
              className={`thread-tab${active ? " thread-tab--active" : ""}`}
              title={tab.type === "change" ? tab.absolutePath ?? tab.path : tab.type === "file" ? tab.path ?? tab.name : tab.name}
              onClick={() => props.onActivate(tab.id)}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                props.onClose(tab.id);
              }}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span className="thread-tab__icon">
                {tab.type === "recording" ? <AudioLines size={16} /> : <ThreadFileIcon name={tab.name} />}
              </span>
              <span className="thread-tab__title">{tab.name}</span>
              <button
                type="button"
                className="thread-tab__close"
                aria-label={t("home.threadPanel.closeTab", { name: tab.name })}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClose(tab.id);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        }
        const tab = item.tab;
        const label = browserTabLabel(tab, t("browser.blankTab"));
        const active = props.browserSurfaceActive && tab.id === props.activeBrowserTabId;
        return (
          <div
            key={item.key}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-browser-tab=""
            data-thread-tab-id={item.key}
            data-thread-tab-index={index}
            className={`thread-tab${active ? " thread-tab--active" : ""}`}
            title={tab.url && !isBlankBrowserUrl(tab.url) ? tab.url : label}
            onClick={() => props.onActivateBrowser(tab.id)}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              props.onCloseBrowser(tab.id);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span className="thread-tab__icon">
              <Globe2 size={16} aria-hidden="true" />
            </span>
            <span className="thread-tab__title">{label}</span>
            {tab.guestId ? (
              <button
                type="button"
                className="thread-tab__close"
                aria-label={t("browser.copyTabMention")}
                title={t(props.copiedBrowserTabId === tab.id ? "browser.copiedTabMention" : "browser.copyTabMention")}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCopyBrowser(tab.guestId!, tab.id);
                }}
              >
                <Copy size={12} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="thread-tab__close"
              aria-label={t("browser.closeTab", { name: label })}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                props.onCloseBrowser(tab.id);
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ThreadListIcon() {
  return (
    <svg className="thread-list-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function trackPointer(onMove: (event: PointerEvent) => void, onEnd: () => void) {
  const previousCursor = document.body.style.cursor;
  const previousSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  let frame = 0;
  let latest: PointerEvent | null = null;
  const move = (event: PointerEvent) => {
    latest = event;
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (latest) onMove(latest);
    });
  };
  const end = () => {
    if (frame) window.cancelAnimationFrame(frame);
    if (latest) onMove(latest);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousSelect;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    onEnd();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}
