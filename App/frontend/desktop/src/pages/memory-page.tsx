import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildMemorySubPageViewEvent } from "../analytics/page-view.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { useApiClients } from "../app/providers.js";
import { PRODUCT_TOUR_MEMORY_NAV_ANCHOR } from "../app/product-tour-layout.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { SidebarResizeHandle, useCodexResizableSidebar } from "./sidebar-resize.js";
import { AnalyticsSubPage } from "./memory/analytics-sub-page.js";
import { LogsSubPage } from "./memory/logs-sub-page.js";
import { MemoriesSubPage } from "./memory/memories-sub-page.js";
import { OverviewSubPage } from "./memory/overview-sub-page.js";
import { PoliciesSubPage } from "./memory/policies-sub-page.js";
import { SkillsSubPage } from "./memory/skills-sub-page.js";
import { SourcesSubPage } from "./memory/sources-sub-page.js";
import { TasksSubPage } from "./memory/tasks-sub-page.js";
import { WorldModelSubPage } from "./memory/world-model-sub-page.js";
import {
  ArrowLeft,
  BarChart3,
  BrainCircuit,
  Globe2,
  Layers,
  Link2,
  ListChecks,
  PanelLeft,
  PanelLeftCollapsed,
  ScrollText,
  Sparkles,
  Wand2
} from "./memory/memory-prototype-icons.js";

export type MemorySubPageId =
  | "overview"
  | "memories"
  | "tasks"
  | "policies"
  | "world-model"
  | "skills"
  | "analytics"
  | "logs"
  | "sources";

interface MemoryNavSection {
  titleKey: MessageKey;
  items: MemoryNavItem[];
}

interface MemoryNavItem {
  id: MemorySubPageId;
  labelKey: MessageKey;
  icon: ReactNode;
}

const memoryNavSections: MemoryNavSection[] = [
  {
    titleKey: "memory.nav.work",
    items: [
      { id: "overview", labelKey: "memory.nav.overview", icon: <Layers size={16} /> },
      { id: "memories", labelKey: "memory.nav.memory", icon: <BrainCircuit size={16} /> },
      { id: "tasks", labelKey: "memory.nav.tasks", icon: <ListChecks size={16} /> },
      { id: "policies", labelKey: "memory.nav.policies", icon: <Sparkles size={16} /> },
      { id: "world-model", labelKey: "memory.nav.worldModel", icon: <Globe2 size={16} /> },
      { id: "skills", labelKey: "memory.nav.skills", icon: <Wand2 size={16} /> }
    ]
  },
  {
    titleKey: "memory.nav.insights",
    items: [
      { id: "analytics", labelKey: "memory.nav.analytics", icon: <BarChart3 size={16} /> },
      { id: "logs", labelKey: "memory.nav.logs", icon: <ScrollText size={16} /> }
    ]
  },
  {
    titleKey: "memory.nav.system",
    items: [
      { id: "sources", labelKey: "memory.sourcesNav", icon: <Link2 size={16} /> }
    ]
  }
];
const MEMORY_SUB_PAGE_STORAGE_KEY = "memmy.memorySubPage";

export interface MemoryPageProps {
  initialSubPage?: MemorySubPageId;
}

export function MemoryPage(props: MemoryPageProps) {
  const { clients } = useApiClients();
  const { dispatch } = useAppState();
  const { track, ready: analyticsReady } = useAnalytics();
  const prevSubPageRef = useRef<MemorySubPageId | null>(null);
  const [activePage, setActivePage] = useState<MemorySubPageId>(() => props.initialSubPage ?? readInitialMemorySubPage());
  const client = clients?.memoryRuntime ?? null;

  function handleSubPageChange(page: MemorySubPageId) {
    setActivePage(page);
  }

  useEffect(() => {
    if (!analyticsReady) {
      return;
    }

    const referrerSubPage = prevSubPageRef.current;
    prevSubPageRef.current = activePage;
    if (referrerSubPage === activePage) {
      return;
    }

    track(buildMemorySubPageViewEvent(activePage, referrerSubPage));
  }, [activePage, analyticsReady, track]);

  const childByPage = useMemo<Record<MemorySubPageId, ReactNode>>(
    () => ({
      overview: <OverviewSubPage client={client} />,
      memories: <MemoriesSubPage client={client} onOpenSettings={() => dispatch(appActions.navigate("/settings"))} />,
      tasks: <TasksSubPage client={client} />,
      policies: <PoliciesSubPage client={client} />,
      "world-model": <WorldModelSubPage client={client} />,
      skills: <SkillsSubPage client={client} />,
      analytics: <AnalyticsSubPage client={client} />,
      logs: <LogsSubPage client={client} />,
      sources: <SourcesSubPage />
    }),
    [client, dispatch]
  );

  useEffect(() => {
    if (props.initialSubPage) {
      setActivePage(props.initialSubPage);
    }
  }, [props.initialSubPage]);

  useEffect(() => {
    writeMemorySubPage(typeof window === "undefined" ? undefined : window.sessionStorage, activePage);
  }, [activePage]);

  return (
    <MemoryPageView
      activePage={activePage}
      onActivePageChange={handleSubPageChange}
      onBack={() => dispatch(appActions.navigate("/main"))}
      childByPage={childByPage}
    />
  );
}

function readInitialMemorySubPage(): MemorySubPageId {
  if (typeof window === "undefined") {
    return "overview";
  }

  const page = new URLSearchParams(window.location.search).get("memoryPage");
  return isMemorySubPageId(page) ? page : readMemorySubPage(window.sessionStorage) ?? "overview";
}

function isMemorySubPageId(value: string | null): value is MemorySubPageId {
  return Boolean(value && memoryNavSections.some((section) => section.items.some((item) => item.id === value)));
}

export function readMemorySubPage(storage: Storage | undefined): MemorySubPageId | null {
  const value = storage?.getItem(MEMORY_SUB_PAGE_STORAGE_KEY) ?? null;
  return isMemorySubPageId(value) ? value : null;
}

export function writeMemorySubPage(storage: Storage | undefined, page: MemorySubPageId): void {
  storage?.setItem(MEMORY_SUB_PAGE_STORAGE_KEY, page);
}

export interface MemoryPageViewProps {
  activePage: MemorySubPageId;
  onActivePageChange: (page: MemorySubPageId) => void;
  onBack?: () => void;
  childByPage?: Record<MemorySubPageId, ReactNode>;
}

export function MemoryPageView(props: MemoryPageViewProps) {
  const { t } = useTranslation();
  const childByPage = props.childByPage ?? createPreviewChildByPage(t);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const sidebarResize = useCodexResizableSidebar("memmy.memory.sidebarWidth.codex.v2");

  const sidebarStyle = sidebarHidden
    ? { ...sidebarResize.sidebarStyle, width: 0, minWidth: 0, maxWidth: 0, flexBasis: 0 }
    : sidebarResize.sidebarStyle;

  return (
    <div className={`sidebar-shell flex h-screen bg-canvas-oat/40${sidebarHidden ? " sidebar-shell--hidden" : ""}`}>
      <aside
        aria-hidden={sidebarHidden ? true : undefined}
        inert={sidebarHidden ? true : undefined}
        className="memory-page-sidebar pb-4 overflow-y-auto shrink-0"
        style={sidebarStyle}
        data-tour-anchor={PRODUCT_TOUR_MEMORY_NAV_ANCHOR}
      >
        <div className="sidebar-window-toolbar memory-page-toolbar">
          <button
            type="button"
            className="sidebar-toolbar-button"
            aria-label={t("appFrame.hideSidebar")}
            title={t("appFrame.hideSidebar")}
            onClick={() => setSidebarHidden(true)}
          >
            <PanelLeft size={20} />
          </button>
        </div>
        <div className="memory-page-return-row">
          <button
            type="button"
            aria-label={t("memory.back")}
            title={t("memory.back")}
            onClick={() => props.onBack?.()}
            className="memory-page-back-button"
          >
            <ArrowLeft size={16} />
            <span>{t("memory.back")}</span>
          </button>
        </div>
        {memoryNavSections.map((section) => (
          <div key={section.titleKey} className="mb-4">
            <div className="memory-page-section-header">
              <span className="memory-page-section-label text-text-ink/45">{t(section.titleKey)}</span>
            </div>
            <nav className="space-y-1">
              {section.items.map((item) => {
                const active = props.activePage === item.id;
                return (
                  <div key={item.id}>
                    <button
                      type="button"
                      onClick={() => props.onActivePageChange(item.id)}
                      className={`app-frame-nav-button relative flex items-center gap-2.5 px-3 py-2 transition-all cursor-pointer ${
                        active
                          ? "app-frame-nav-button--active"
                          : "text-text-ink/75 hover:bg-canvas-oat/60 hover:text-text-ink/85"
                      }`}
                    >
                      <span className="shrink-0">{item.icon}</span>
                      <span className="flex-1 text-left">{t(item.labelKey)}</span>
                    </button>
                  </div>
                );
              })}
            </nav>
          </div>
        ))}
      </aside>
      {sidebarHidden && (
        <button
          type="button"
          className="sidebar-restore-button"
          aria-label={t("appFrame.showSidebar")}
          title={t("appFrame.showSidebar")}
          onClick={() => setSidebarHidden(false)}
        >
          <PanelLeftCollapsed size={20} />
        </button>
      )}
      <SidebarResizeHandle
        label={t("memory.resizeSidebar")}
        width={sidebarResize.width}
        minWidth={sidebarResize.minWidth}
        maxWidth={sidebarResize.maxWidth}
        isResizing={sidebarResize.isResizing}
        isDisabled={sidebarHidden}
        onResizeStart={sidebarResize.beginResize}
        onResizeBy={sidebarResize.resizeBy}
      />
      <div
        className={`min-w-0 flex-1 flex flex-col overflow-hidden bg-content-bg${
          sidebarHidden ? " memory-page-main--sidebar-hidden" : ""
        }`}
      >
        <header className="app-frame-content-topbar" />
        <div className="app-frame-page-content min-h-0 flex-1 overflow-y-auto py-6">{childByPage[props.activePage]}</div>
      </div>
    </div>
  );
}

/**
 * Creates lightweight sub-page nodes for tests and documentation previews.
 *
 * @param t The translation function.
 * @returns A map of sub-page preview nodes.
 */
function createPreviewChildByPage(t: (key: MessageKey) => string): Record<MemorySubPageId, ReactNode> {
  return {
    overview: <div>{t("memory.overview.total")}</div>,
    memories: <div>{t("memory.memories.title")}</div>,
    tasks: <div>{t("memory.tasks.title")}</div>,
    policies: <div>{t("memory.policies.title")}</div>,
    "world-model": <div>{t("memory.worldModel.title")}</div>,
    skills: <div>{t("memory.skills.title")}</div>,
    analytics: <div>{t("memory.analytics.title")}</div>,
    logs: <div>{t("memory.logs.title")}</div>,
    sources: <div>{t("memory.sourcesTitle")} {t("memory.scan")}</div>
  };
}
