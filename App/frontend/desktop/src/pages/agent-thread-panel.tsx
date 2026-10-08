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
import { Copy, Globe2, Maximize2, Minimize2, PanelRight, Pin, PinOff, Plus, X } from "lucide-react";
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
import { BrowserPanel, hasPendingBrowserOpen, MEMMY_BROWSER_NEW_TAB_EVENT,
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

export function useAgentThreadPanel(options: { scopeKey: string; containerRef: RefObject<HTMLElement | null>; enabled: boolean }) {
  const [phase, setPhase] = useState<ThreadPanelPhase>("closed");
  const [fullscreen, setFullscreen] = useState(false);
  const [view, setView] = useState<ThreadPanelView>("overview");
  const [tabState, setTabState] = useState<ThreadTabState>(EMPTY_TABS);
  const [pinned, setPinned] = useState(false);
  const [artifactsCollapsed, setArtifactsCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(THREAD_LIST_DEFAULT_WIDTH);
  const [widths, setWidths] = useState<StoredWidths>(readStoredWidths);
  const [containerWidth, setContainerWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const [scopeKey, setScopeKey] = useState(options.scopeKey);
  const closeTimerRef = useRef<number | null>(null);
  const clearTabsOnCloseRef = useRef(false);
  const closingWidthRef = useRef<number | null>(null);
  const widthsDirtyRef = useRef(false);

  if (scopeKey !== options.scopeKey) {
    setScopeKey(options.scopeKey);
    setTabState(EMPTY_TABS);
    setPinned(false);
    setFullscreen(false);
  }

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
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (resizing || !widthsDirtyRef.current) return;
    widthsDirtyRef.current = false;
    writeStoredWidths(widths);
  }, [resizing, widths]);

  const hasContent = tabState.tabs.length > 0;
  const liveWidth = hasContent
    ? clampThreadPanelWidth(widths.content ?? threadPanelContentWidth(containerWidth), containerWidth)
    : clampThreadPanelWidth(widths.sidebar, containerWidth);
  const width = phase === "closing" && closingWidthRef.current != null ? closingWidthRef.current : liveWidth;
  const visible = options.enabled && phase !== "closed";
  const offset = options.enabled && phase === "open" ? threadPanelOffset(width, containerWidth) : 0;
  const motion: ThreadPanelMotion = resizing ? "resizing" : phase === "closing" ? "closing" : "open";
  const liveWidthRef = useRef(liveWidth);
  liveWidthRef.current = liveWidth;
  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const open = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (clearTabsOnCloseRef.current) {
      clearTabsOnCloseRef.current = false;
      setTabState(EMPTY_TABS);
      setPinned(false);
    }
    closingWidthRef.current = null;
    setPhase("open");
  }, []);

  const close = useCallback(() => {
    setFullscreen(false);
    closingWidthRef.current = liveWidthRef.current;
    setPhase((current) => (current === "closed" ? current : "closing"));
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      closingWidthRef.current = null;
      if (clearTabsOnCloseRef.current) {
        clearTabsOnCloseRef.current = false;
        setTabState(EMPTY_TABS);
        setPinned(false);
      }
      setPhase("closed");
    }, THREAD_PANEL_CLOSE_MS);
  }, []);

  const ensureContentWidth = useCallback(() => {
    const minimum = threadPanelContentWidth(containerWidthRef.current);
    setWidths((current) => {
      const content = Math.max(current.content ?? 0, minimum);
      return content === current.content ? current : { ...current, content };
    });
  }, []);

  const openTab = useCallback((tab: ThreadPanelTab) => {
    if (liveWidthRef.current < THREAD_PANEL_NARROW_WIDTH) setPinned(false);
    setTabState((current) => openThreadTab(current, tab));
    ensureContentWidth();
    open();
  }, [ensureContentWidth, open]);

  const activateTab = useCallback((id: string) => {
    setTabState((current) => (current.tabs.some((tab) => tab.id === id) ? { ...current, activeId: id } : current));
  }, []);

  const closeTab = useCallback((id: string) => {
    const next = closeThreadTab(tabStateRef.current, id);
    if (next.tabs.length) {
      setTabState(next);
      return;
    }
    clearTabsOnCloseRef.current = true;
    close();
  }, [close]);

  const resize = useCallback((nextWidth: number) => {
    const clamped = clampThreadPanelWidth(nextWidth, containerWidthRef.current);
    widthsDirtyRef.current = true;
    setWidths((current) => (tabStateRef.current.tabs.length
      ? { ...current, content: clamped }
      : { ...current, sidebar: clamped }));
  }, []);

  const finishResize = useCallback(() => setResizing(false), []);

  const togglePinned = useCallback(() => {
    if (!pinnedRef.current) ensureContentWidth();
    setPinned(!pinnedRef.current);
  }, [ensureContentWidth]);

  return {
    phase,
    visible,
    motion,
    width,
    offset,
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
    setListWidth: (next: number) => setListWidth(clampThreadListWidth(next, width)),
    toggleArtifactsCollapsed: () => setArtifactsCollapsed((current) => !current),
    beginResize: () => setResizing(true),
    resize,
    finishResize,
  };
}

export function AgentThreadPanel(props: {
  controller: AgentThreadPanelController;
  messages: AgentChatMessage[];
  workspaceRoot: string | null;
  previewContext: ThreadPreviewContext;
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
  const popoverAllowed = panel.hasContent && !panel.pinned;
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverTimerRef = useRef<number | null>(null);
  const popoverHoveredRef = useRef(false);
  const popoverMenuOpenRef = useRef(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [listResizing, setListResizing] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(hasPendingBrowserOpen);
  const [browserMounted, setBrowserMounted] = useState(hasPendingBrowserOpen);
  const nextBrowserTabId = useRef(2);
  const [browserTabs, setBrowserTabs] = useState<Array<{ id: number; guestId?: number; url?: string; title?: string }>>([{ id: 1 }]);
  const [activeBrowserTabId, setActiveBrowserTabId] = useState(1);
  const [copiedBrowserTabId, setCopiedBrowserTabId] = useState<number | null>(null);
  const addBrowserTab = useCallback((url?: string) => {
    const id = nextBrowserTabId.current++;
    setBrowserTabs(current => [...current, { id, url }]);
    setActiveBrowserTabId(id);
    setBrowserMounted(true);
    setBrowserOpen(true);
  }, []);
  const ensureBrowserOpen = useCallback(() => {
    setBrowserMounted(true);
    setBrowserOpen(true);
    setBrowserTabs(current => {
      if (current.length) return current;
      const id = nextBrowserTabId.current++;
      setActiveBrowserTabId(id);
      return [{ id }];
    });
  }, []);
  const closeBrowserTab = useCallback((id: number) => {
    setBrowserTabs(current => {
      const remaining = current.filter(tab => tab.id !== id);
      if (remaining.length) {
        setActiveBrowserTabId(selected => selected === id ? remaining.at(-1)!.id : selected);
        return remaining;
      }
      setBrowserOpen(false);
      setBrowserMounted(false);
      return [];
    });
  }, []);
  useEffect(() => window.memmy?.onEmbeddedBrowserClose?.((guestId) => {
    const tab = browserTabs.find(item => item.guestId === guestId);
    if (tab) closeBrowserTab(tab.id);
  }), [browserTabs, closeBrowserTab]);
  const copyBrowserTabMention = useCallback(async (guestId: number, id: number) => {
    try {
      if (!window.memmy?.copyEmbeddedBrowserTabMention) return;
      await window.memmy.copyEmbeddedBrowserTabMention(guestId);
      setCopiedBrowserTabId(id);
    } catch { setCopiedBrowserTabId(null); }
  }, []);
  useEffect(() => {
    const open = () => ensureBrowserOpen();
    const newTab = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        takePendingBrowserNewTab();
        addBrowserTab(url);
      }
    };
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, open);
    window.addEventListener(MEMMY_BROWSER_NEW_TAB_EVENT, newTab);
    return () => {
      window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, open);
      window.removeEventListener(MEMMY_BROWSER_NEW_TAB_EVENT, newTab);
    };
  }, [addBrowserTab, ensureBrowserOpen]);
  useEffect(() => {
    const pending = takePendingBrowserNewTab();
    if (pending) addBrowserTab(pending);
  }, [addBrowserTab]);
  useEffect(() => {
    if (browserOpen) setBrowserMounted(true);
  }, [browserOpen]);
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
  ].filter(Boolean).join(" ");

  return (
    <aside className={className} aria-hidden={!panel.visible}
      style={!panel.visible ? (browserMounted ? {
        position: 'fixed', left: -10_000, top: 0, width: Math.max(panel.width, 800),
        height: 600, opacity: 0, pointerEvents: 'none',
      } : { display: 'none' }) : fullscreen ? undefined : { width: panel.width }}
      aria-label={t("home.threadPanel.label")}>
      {fullscreen ? null : (
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
              className={`thread-panel__icon-button thread-panel__overview-button${panel.pinned && panel.hasContent ? " thread-panel__overview-button--inactive" : ""}${popoverOpen ? " thread-panel__icon-button--active" : ""}`}
              aria-label={t(panel.pinned && panel.hasContent ? "home.threadPanel.alreadyPinned" : "home.threadPanel.overview")}
              title={t(panel.pinned && panel.hasContent ? "home.threadPanel.alreadyPinned" : "home.threadPanel.overview")}
              aria-haspopup={popoverAllowed ? "dialog" : undefined}
              aria-expanded={popoverAllowed ? popoverOpen : undefined}
              onClick={() => {
                if (!popoverAllowed) return;
                cancelPopoverClose();
                setPopoverOpen((current) => !current);
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
              onClose={panel.closeTab}
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
        {browserMounted ? <div className="memmy-browser-stack" style={!browserOpen ? {
          position: 'fixed', left: -10_000, top: 0, width: 800, height: 600,
          opacity: 0, pointerEvents: 'none',
        } : undefined}>
          {browserTabs.map(tab => <BrowserPanel key={tab.id}
            initialAddress={tab.id === 1 ? tab.url : tab.url ?? ''}
            active={tab.id === activeBrowserTabId}
            hidden={!browserOpen || tab.id !== activeBrowserTabId}
            onTabReady={(guestId) => setBrowserTabs(current => current.map(item =>
              item.id === tab.id && item.guestId !== guestId ? { ...item, guestId } : item))}
            onNavigation={(url, title) => setBrowserTabs(current => current.map(item =>
              item.id === tab.id && (item.url !== url || item.title !== title)
                ? { ...item, url, title } : item))} />)}
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
            <ThreadTabPreview key={activeTab.id} tab={activeTab} context={props.previewContext} />
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
  const [position, setPosition] = useState<{ top: number; left: number; height: number } | null>(null);
  const { anchor } = props;

  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(POPOVER_VIEWPORT_PADDING, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - POPOVER_VIEWPORT_PADDING));
      const height = Math.max(160, Math.min(POPOVER_HEIGHT, window.innerHeight - rect.bottom - POPOVER_VIEWPORT_PADDING));
      setPosition({ top: rect.bottom, left, height });
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
      style={position ? { top: position.top, left: position.left, height: position.height } : { visibility: "hidden" }}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
    >
      {props.children}
    </div>,
    document.body,
  );
}

type BrowserStripTab = { id: number; guestId?: number; url?: string; title?: string };

function browserTabLabel(tab: BrowserStripTab, index: number, fallback: string): string {
  if (tab.title?.trim()) return tab.title;
  if (tab.url?.startsWith("http")) {
    try { return new URL(tab.url).host; } catch { /* keep the fallback label */ }
  }
  return `${fallback} ${index + 1}`;
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
    ...props.browserTabs.map((tab, index) => ({ kind: "browser" as const, key: `browser:${tab.id}`, tab, index })),
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
              title={tab.type === "change" ? tab.absolutePath ?? tab.path : tab.path ?? tab.name}
              onClick={() => props.onActivate(tab.id)}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                props.onClose(tab.id);
              }}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span className="thread-tab__icon">
                <ThreadFileIcon name={tab.name} />
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
        const label = browserTabLabel(tab, item.index, t("browser.title"));
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
            title={tab.url || label}
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
