import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PRODUCT_TOUR_MEMORY_NAV_ANCHOR, PRODUCT_TOUR_TOOLS_NAV_ANCHOR } from "../app/product-tour-layout.js";
import type { AppRoutePath } from "../app/routes.js";
import { clearDeferredGuidanceStep, clearFocusedAgentTarget, clearProductTourStep, readDeferredGuidanceStep, readGuidanceCompleted, routeTable, writeDeferredGuidanceStep, writeGuidanceCompleted } from "../app/routes.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { useOptionalApiClients } from "../app/providers.js";
import { MemmyAgentRequestError } from "../api/memmy-agent-client.js";
import { communityLinks } from "../community/community-links.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import { Tooltip } from "../components/tooltip.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { useTaskBus } from "../lib/task-bus.js";
import { agentActions, appActions } from "../state/app-actions.js";
import type { AppState } from "../state/app-reducer.js";
import { useAppState } from "../state/app-state.js";
import { agentChatScopeKey } from "../state/agent-composer-state.js";
import { updateSidebarStateForTask, type AgentTaskView } from "../state/agent-chat-slice.js";
import { decideTaskDoneNotification } from "../state/task-done-notification.js";
import { maskAccountIdentifier } from "../utils/mask-account-identifier.js";
import { openExternalUrl } from "../utils/open-url.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import { ImprovementProgramModal } from "./improvement-program-modal.js";
import { NicknameModal } from "../components/nickname-modal.js";
import { randomNickname } from "../lib/nickname.js";
import { ProductTourGuide, productTourTabRoute, type ProductTourTab } from "../app/product-tour.js";
import { persistNickname } from "../app/nickname.js";
import { SearchPalette } from "../components/search-palette.js";
import { SidebarResizeHandle, useCodexResizableSidebar } from "./sidebar-resize.js";
import {
  Archive,
  BrainCircuit,
  LayoutList,
  ListChecks,
  Link2,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftCollapsed,
  Pin,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  User
} from "./memory/memory-prototype-icons.js";

export interface AppFrameProps {
  title: string;
  reserveTopBar?: boolean;
  topBar?: ReactNode;
  topBarBorder?: boolean;
  children: ReactNode;
}

interface NavItem {
  path?: AppRoutePath;
  icon: ReactNode;
  action?: "search" | "community";
  labelKey?: string;
}

interface TaskGroups {
  pinned: AgentTaskView[];
  active: AgentTaskView[];
  archived: AgentTaskView[];
}

interface TaskContextMenuState {
  task: AgentTaskView;
  x: number;
  y: number;
}

interface SidebarMenuAnchor {
  right: number;
  bottom: number;
}

interface SidebarMenuViewport {
  width: number;
  height: number;
}

interface SidebarMenuSize {
  width: number;
  height: number;
  margin: number;
  gap: number;
}

interface SidebarMenuPlacement {
  right: number;
  top: number;
}

interface SidebarMenuOverlayStyle extends SidebarMenuPlacement {
  zIndex: number;
}

type AgentTaskSort = AppState["agent"]["sidebarState"]["view"]["sort"];
type NewAgentDraftState = Pick<AppState["agent"], "blankDraftActive" | "newChatRequestId" | "composerDraftsByScope" | "composerPendingAttachmentsByScope" | "composerMediaErrorByScope">;

export interface SidebarAccountLabels {
  brandName: string;
  byokLabel: string;
  accountFallback: string;
  accountMetaFallback: string;
  unsetName: string;
  unsetMeta: string;
}

export interface SidebarAccountSummary {
  name: string;
  meta: string;
}

export interface AccountDisplayText {
  text: string;
  truncated: boolean;
}

const navItems: NavItem[] = [
  { path: "/main", icon: <MessageSquarePlus size={16} /> },
  { action: "search", icon: <Search size={16} />, labelKey: "appFrame.search" },
  { path: "/tools", icon: <Link2 size={16} /> },
  { path: "/memory", icon: <BrainCircuit size={16} /> },
  { action: "community", icon: <MessageCircle size={16} />, labelKey: "welcome.joinCommunity" }
];

const taskSortOptions = [
  { value: "updated_desc", labelKey: "appFrame.sort.updatedDesc" },
  { value: "title_asc", labelKey: "appFrame.sort.titleAsc" }
] as const;

const sidebarMoreMenuSize: SidebarMenuSize = {
  width: 128,
  height: 128,
  margin: 8,
  gap: 4
};
const sidebarMenuOverlayZIndex = 9999;
const SIDEBAR_PROFILE_NAME_MAX_VISUAL_WIDTH = 10;
const SIDEBAR_PROFILE_META_MAX_VISUAL_WIDTH = 12;
const ACCOUNT_DISPLAY_ELLIPSIS = "…";

function resolveProductTourNavAnchor(path: AppRoutePath): string | undefined {
  if (path === "/memory") return PRODUCT_TOUR_MEMORY_NAV_ANCHOR;
  if (path === "/tools") return PRODUCT_TOUR_TOOLS_NAV_ANCHOR;
  return undefined;
}

export function shouldCreateNewAgentDraft(agent: NewAgentDraftState): boolean {
  if (agent.blankDraftActive) {
    return false;
  }
  const draftScopeKey = agentChatScopeKey(null, agent.newChatRequestId);
  return !agent.composerDraftsByScope[draftScopeKey]
    && !(agent.composerPendingAttachmentsByScope[draftScopeKey]?.length)
    && !agent.composerMediaErrorByScope[draftScopeKey];
}

export function AppFrame(props: AppFrameProps) {
  const { state, dispatch } = useAppState();
  const { clients } = useOptionalApiClients();
  const { t, language } = useTranslation();
  const { track } = useAnalytics();
  const taskBus = useTaskBus();
  const { syncAgentTaskStatuses } = taskBus;
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [showCommunity, setShowCommunity] = useState(false);
  const [taskListMenuAnchor, setTaskListMenuAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [taskContextMenu, setTaskContextMenu] = useState<TaskContextMenuState | null>(null);
  const [archiveConfirmSessionKey, setArchiveConfirmSessionKey] = useState<string | null>(null);
  const [deleteConfirmTask, setDeleteConfirmTask] = useState<AgentTaskView | null>(null);
  const [renameTarget, setRenameTarget] = useState<AgentTaskView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deferredGuidanceStep, setDeferredGuidanceStep] = useState(() =>
    readDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage)
  );
  const [deferredNickname, setDeferredNickname] = useState("");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const communityMenuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const taskScrollRef = useRef<HTMLDivElement | null>(null);
  const [taskScrollFade, setTaskScrollFade] = useState(false);
  const sidebarResize = useCodexResizableSidebar("memmy.appFrame.sidebarWidth.codex.v2");
  const hasRequestedAgentData = useRef(false);
  const lastNotifiedCompletionAt = useRef<number | null>(null);
  const accountSummary = resolveSidebarAccountSummary(state, {
    brandName: t("brand.name"),
    byokLabel: t("welcome.byok.title"),
    accountFallback: t("appFrame.accountFallback"),
    accountMetaFallback: t("appFrame.accountMetaFallback"),
    unsetName: t("appFrame.unsetName"),
    unsetMeta: t("appFrame.unsetMeta")
  });
  const accountNameLine = truncateAccountDisplayText(accountSummary.name, SIDEBAR_PROFILE_NAME_MAX_VISUAL_WIDTH);
  const accountMetaLine = truncateAccountDisplayText(accountSummary.meta, SIDEBAR_PROFILE_META_MAX_VISUAL_WIDTH);
  const visibleTasks = state.agent.tasks;
  const taskGroups = useMemo(() => groupAgentTasks(visibleTasks), [visibleTasks]);
  const showingArchived = state.agent.sidebarState.view.show_archived;
  const timeGroups = useMemo(
    () => groupTasksByTime(showingArchived ? taskGroups.archived : taskGroups.active),
    [showingArchived, taskGroups.active, taskGroups.archived]
  );
  const highlightedSessionKey = state.navigation.currentPath === "/main" ? state.agent.currentSessionKey : null;

  useEffect(() => {
    const el = taskScrollRef.current;
    if (!el) return;
    const check = () => {
      const canScrollMore = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
      setTaskScrollFade(canScrollMore);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      observer.disconnect();
    };
  }, [visibleTasks]);

  useEffect(() => {
    const openSearchPalette = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']")) {
        return;
      }
      event.preventDefault();
      setSearchPaletteOpen(true);
    };

    document.addEventListener("keydown", openSearchPalette);
    return () => document.removeEventListener("keydown", openSearchPalette);
  }, []);

  useEffect(() => {
    syncAgentTaskStatuses({
      tasks: state.agent.tasks.map((task) => ({
        sessionIds: [task.chatId, task.sessionKey],
        isRunning: task.runStartedAt != null
      }))
    });
  }, [state.agent.tasks, syncAgentTaskStatuses]);

  useEffect(() => {
    if (!clients?.memmyAgent || hasRequestedAgentData.current) {
      return;
    }

    hasRequestedAgentData.current = true;
    void refreshAgentTasks();
  }, [clients]);

  useEffect(() => {
    const completion = state.agent.lastTaskCompletion;
    if (!completion || lastNotifiedCompletionAt.current === completion.at) {
      return;
    }
    lastNotifiedCompletionAt.current = completion.at;

    if (typeof window === "undefined" || typeof document === "undefined" || !window.memmy?.notifyTaskDone) {
      return;
    }

    const plan = decideTaskDoneNotification({
      enabled: state.bootstrap?.app?.taskDoneNotificationEnabled ?? true,
      soundEnabled: state.bootstrap?.app?.notificationSoundEnabled ?? true,
      windowFocused: document.hasFocus()
    });
    if (!plan) {
      return;
    }

    const completedTitle = state.agent.tasks.find((task) => task.chatId === completion.chatId)?.title?.trim();
    const body = completedTitle
      ? t("notification.taskDone.bodyNamed", { title: completedTitle })
      : t("notification.taskDone.body");
    void window.memmy.notifyTaskDone({
      title: t("notification.taskDone.title"),
      body,
      silent: plan.silent
    }).catch(() => undefined);
  }, [state.agent.lastTaskCompletion, state.agent.tasks, state.bootstrap, t]);

  useEffect(() => {
    if (typeof document === "undefined" || (!taskListMenuAnchor && !taskContextMenu && !archiveConfirmSessionKey)) {
      return;
    }

    const closeMenus = () => {
      setTaskListMenuAnchor(null);
      setSortMenuOpen(false);
      setTaskContextMenu(null);
      setArchiveConfirmSessionKey(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenus();
      }
    };

    document.addEventListener("click", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [archiveConfirmSessionKey, taskContextMenu, taskListMenuAnchor]);

  useEffect(() => {
    if (!showCommunity || typeof document === "undefined") {
      return;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const menu = communityMenuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }

      setShowCommunity(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowCommunity(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showCommunity]);

  async function refreshAgentTasks() {
    if (!clients?.memmyAgent) {
      return;
    }

    const sessionsRequestId = nextAgentSessionsRequestId("manual");
    dispatch(agentActions.sessionsLoading(sessionsRequestId));
    try {
      const boot = await clients.memmyAgent.bootstrap();
      dispatch(agentActions.bootstrapSucceeded(boot.model_name));
      const [sessions, sidebarState] = await Promise.all([
        clients.memmyAgent.listSessions(),
        clients.memmyAgent.readSidebarState()
      ]);
      dispatch(agentActions.sidebarStateLoaded(sidebarState));
      dispatch(agentActions.sessionsLoaded(sessions, sessionsRequestId));
    } catch (error) {
      dispatch(agentActions.failed(error instanceof Error ? error.message : String(error)));
    }
  }

  function openNewAgent() {
    clearFocusedAgentTarget(
      typeof window === "undefined" ? undefined : window.sessionStorage,
      typeof window === "undefined" ? undefined : window.location,
      typeof window === "undefined" ? undefined : window.history
    );
    if (shouldCreateNewAgentDraft(state.agent)) {
      dispatch(agentActions.newChatRequested());
    } else if (!state.agent.blankDraftActive) {
      dispatch(agentActions.blankDraftReopened());
    }
    dispatch(appActions.navigate("/main"));
  }

  function openSidebarRoute(path: AppRoutePath) {
    if (path === "/main") {
      openNewAgent();
    } else {
      dispatch(appActions.navigate(path));
    }
  }

  function openSettingsFromSidebar() {
    if (state.navigation.currentPath === "/settings") {
      const prev = state.navigation.history.slice().reverse().find((p) => p !== "/settings");
      dispatch(appActions.navigate(prev ?? "/main"));
      return;
    }

    dispatch(appActions.navigate("/settings"));
    handleFirstSidebarInteraction();
  }

  function handleFirstSidebarInteraction() {
    if (readGuidanceCompleted(typeof window === "undefined" ? undefined : window.localStorage)) {
      return;
    }
    if (deferredGuidanceStep !== "armed") {
      return;
    }
    const firstStep = state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset" ? "improvement" : "product_tour";
    if (firstStep === "product_tour") {
      clearProductTourStep(typeof window === "undefined" ? undefined : window.sessionStorage);
    }
    writeDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage, firstStep);
    setDeferredGuidanceStep(firstStep);
  }

  function submitDeferredNickname() {
    void persistNickname({
      rawNickname: deferredNickname,
      language,
      isByok: state.bootstrap?.app.userMode === "byok",
      storage: typeof window === "undefined" ? undefined : window.localStorage,
      current: state.account,
      updateProfile: (nickname) => clients?.account.updateProfile({ nickname }) ?? Promise.resolve(null)
    }).then((update) => dispatch(appActions.accountUpdated(update)));
    track({ name: "onboarding_step_completed", params: { step: "nickname", step_index: 0 }, consentTier: "basic" });
    writeGuidanceCompleted(typeof window === "undefined" ? undefined : window.localStorage);
    clearDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage);
    setDeferredGuidanceStep(null);
  }

  function chooseDeferredImprovementProgram(accepted: boolean) {
    const onboardingPatch = { improvementProgram: accepted ? "accepted" : "declined" } as const;
    const privacyPatch = { allowMemoryImprovementUpload: accepted };

    clearProductTourStep(typeof window === "undefined" ? undefined : window.sessionStorage);
    writeDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage, "product_tour");
    setDeferredGuidanceStep("product_tour");
    dispatch(appActions.onboardingUpdated(onboardingPatch));
    dispatch(appActions.privacyUpdated(privacyPatch));
    track({ name: "onboarding_step_completed", params: { step: "improvement_program", step_index: 2, choice: accepted ? "accepted" : "declined" }, consentTier: "basic" });

    void clients?.config
      .setImprovementProgram(accepted)
      .then((response) => {
        dispatch(appActions.onboardingUpdated(response.onboarding));
        dispatch(appActions.privacyUpdated(response.privacy));
        dispatch(appActions.tokenUsageUpdated(response.tokenUsage));
        if (!accepted) {
          return;
        }

        const { planName, totalTokens, usedTokens, remainingTokens } = response.tokenUsage;
        track({
          name: "token_usage_snapshot",
          params: {
            plan_name: planName,
            total_tokens: totalTokens,
            used_tokens: usedTokens,
            remaining_tokens: remainingTokens,
            usage_pct: totalTokens > 0 ? Math.round((usedTokens / totalTokens) * 100) : 0
          },
          consentTier: "basic"
        });
      })
      .catch((error) => {
        console.warn("set deferred improvement program failed", error);
      });
  }

  async function openAgentTask(task: AgentTaskView) {
    handleFirstSidebarInteraction();
    if (!clients?.memmyAgent) {
      dispatch(appActions.navigate("/main"));
      return;
    }

    const chatId = clients.memmyAgent.sessionKeyToChatId(task.sessionKey);
    const requestId = nextAgentHistoryRequestId(chatId);
    track({ name: "task_opened", params: { page_path: state.navigation.currentPath }, consentTier: "basic" });
    dispatch(agentActions.historyLoading(task.sessionKey, chatId, requestId));
    dispatch(appActions.navigate("/main"));
    try {
      dispatch(agentActions.historyLoaded(await clients.memmyAgent.readWebuiThread(task.sessionKey), requestId));
    } catch (error) {
      if (error instanceof MemmyAgentRequestError && error.status === 404) {
        dispatch(agentActions.historyOpenMissing(task.sessionKey, chatId, requestId));
        return;
      }
      dispatch(agentActions.failed(error instanceof Error ? error.message : String(error)));
    }
  }

  async function saveSidebarStateForTask(task: AgentTaskView, patch: Parameters<typeof updateSidebarStateForTask>[2]) {
    const nextState = updateSidebarStateForTask(state.agent.sidebarState, task.sessionKey, patch);
    await saveSidebarState(nextState);
  }

  async function saveSidebarView(patch: {
    sort?: typeof state.agent.sidebarState.view.sort;
    showArchived?: boolean;
    showPreviews?: boolean;
  }) {
    await saveSidebarState({
      ...state.agent.sidebarState,
      view: {
        ...state.agent.sidebarState.view,
        ...(patch.sort ? { sort: patch.sort } : {}),
        ...(patch.showArchived == null ? {} : { show_archived: patch.showArchived }),
        ...(patch.showPreviews == null ? {} : { show_previews: patch.showPreviews })
      }
    });
  }

  async function saveSidebarState(nextState: typeof state.agent.sidebarState) {
    if (!clients?.memmyAgent) {
      return;
    }

    dispatch(agentActions.sidebarStateSaved(nextState));
    try {
      dispatch(agentActions.sidebarStateSaved(await clients.memmyAgent.writeSidebarState(nextState)));
    } catch (error) {
      dispatch(agentActions.failed(error instanceof Error ? error.message : String(error)));
    }
  }

  function openRenameDialog(task: AgentTaskView) {
    setTaskContextMenu(null);
    setArchiveConfirmSessionKey(null);
    setRenameTarget(task);
    setRenameValue(task.title);
  }

  function closeRenameDialog() {
    setRenameTarget(null);
    setRenameValue("");
  }

  function submitRenameDialog() {
    const task = renameTarget;
    const nextTitle = renameValue;
    closeRenameDialog();
    if (task) {
      void renameTask(task, nextTitle);
    }
  }

  async function renameTask(task: AgentTaskView, nextTitle: string) {
    if (!clients?.memmyAgent) {
      return;
    }
    const trimmedTitle = nextTitle.trim();
    try {
      track({ name: "task_renamed", params: { page_path: state.navigation.currentPath }, consentTier: "basic" });
      await clients.memmyAgent.renameSession(task.sessionKey, trimmedTitle);
      await saveSidebarStateForTask(task, { title: null });
      await refreshAgentTasks();
    } catch (error) {
      dispatch(agentActions.failed(error instanceof Error ? error.message : String(error)));
    }
  }

  function pinTask(task: AgentTaskView, pinned: boolean) {
    setArchiveConfirmSessionKey(null);
    track({ name: "task_pinned", params: { page_path: state.navigation.currentPath, pinned }, consentTier: "basic" });
    void saveSidebarStateForTask(task, { pinned });
  }

  function requestArchiveTask(task: AgentTaskView) {
    setTaskContextMenu(null);
    setArchiveConfirmSessionKey(task.sessionKey);
  }

  function archiveTask(task: AgentTaskView) {
    setArchiveConfirmSessionKey(null);
    track({ name: "task_archived", params: { page_path: state.navigation.currentPath }, consentTier: "basic" });
    void saveSidebarStateForTask(task, { archived: true, pinned: false });
  }

  function unarchiveTask(task: AgentTaskView) {
    setArchiveConfirmSessionKey(null);
    void saveSidebarStateForTask(task, { archived: false });
  }

  function toggleTaskListMenu(anchor: SidebarMenuAnchor) {
    setTaskContextMenu(null);
    setArchiveConfirmSessionKey(null);
    setTaskListMenuAnchor((value) => (value ? null : anchor));
    setSortMenuOpen(false);
  }

  function openTaskContextMenu(event: MouseEvent, task: AgentTaskView) {
    event.preventDefault();
    setTaskListMenuAnchor(null);
    setSortMenuOpen(false);
    setArchiveConfirmSessionKey(null);
    setTaskContextMenu({ task, x: event.clientX, y: event.clientY });
  }

  function requestDeleteArchivedTask(task: AgentTaskView) {
    if (!task.archived || !clients?.memmyAgent) {
      return;
    }

    setTaskContextMenu(null);
    setArchiveConfirmSessionKey(null);
    setDeleteConfirmTask(task);
  }

  async function confirmDeleteArchivedTask() {
    const task = deleteConfirmTask;
    setDeleteConfirmTask(null);
    if (!task?.archived || !clients?.memmyAgent) {
      return;
    }

    const deletingCurrentTask =
      task.sessionKey === state.agent.currentSessionKey
      || task.chatId === state.agent.currentChatId;

    try {
      track({ name: "task_deleted", params: { page_path: state.navigation.currentPath }, consentTier: "basic" });
      await clients.memmyAgent.deleteSession(task.sessionKey);
      taskBus.removeTasksBySessionIds([task.chatId, task.sessionKey]);
      if (deletingCurrentTask) {
        openNewAgent();
      }
      await refreshAgentTasks();
    } catch (error) {
      dispatch(agentActions.failed(error instanceof Error ? error.message : String(error)));
    }
  }

  const sidebarStyle = sidebarHidden
    ? { ...sidebarResize.sidebarStyle, width: 0, minWidth: 0, maxWidth: 0, flexBasis: 0 }
    : sidebarResize.sidebarStyle;

  return (
    <div className={`sidebar-shell flex h-screen bg-canvas-oat${sidebarHidden ? " sidebar-shell--hidden" : ""}`}>
      <aside
        aria-hidden={sidebarHidden ? true : undefined}
        inert={sidebarHidden ? true : undefined}
        className="app-frame-sidebar flex flex-col"
        style={sidebarStyle}
      >
        <div className="sidebar-window-toolbar">
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

        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const key = item.path ?? item.action ?? "unknown";
            const active = item.path
              ? state.navigation.currentPath === item.path && (item.path !== "/main" || !state.agent.currentSessionKey)
              : item.action === "community" && showCommunity;

            const label = item.path
              ? t(routeTable[item.path].navKey as Parameters<typeof t>[0])
              : t(item.labelKey as Parameters<typeof t>[0]);

            function handleClick() {
              handleFirstSidebarInteraction();
              if (item.action === "search") {
                setSearchPaletteOpen(true);
              } else if (item.action === "community") {
                setShowCommunity((v) => !v);
              } else if (item.path) {
                openSidebarRoute(item.path);
              }
            }

            const navButton = (
              <button
                type="button"
                data-tour-anchor={item.path ? resolveProductTourNavAnchor(item.path) : undefined}
                onClick={handleClick}
                className={`app-frame-nav-button relative flex items-center gap-2.5 px-3 py-2 transition-all cursor-pointer ${
                  active
                    ? "app-frame-nav-button--active"
                    : "text-text-ink/75 hover:bg-canvas-oat/60 hover:text-text-ink/85"
                }`}
              >
                <span className="shrink-0">{item.icon}</span>
                <span className="flex-1 text-left">{label}</span>
              </button>
            );

            if (item.action === "community") {
              return (
                <div key={key} ref={communityMenuRef} className="relative">
                  {navButton}
                  {showCommunity && (
                    <div className="community-popover absolute top-full mt-2 bg-background-paper rounded-card-lg border-content-panel p-3 z-50">
                      <div className="community-popover-grid grid gap-2.5">
                        <div className="community-popover-wechat">
                          <div className="community-popover-wechat-title">
                            <span>{t("welcome.wechatGroup")}</span>
                          </div>
                          <img src={communityLinks.wechatGroupUrl} alt={t("welcome.wechatGroup")} className="community-popover-qr rounded bg-white" />
                          <span className="community-popover-wechat-hint">{t("appFrame.scanToJoin")}</span>
                        </div>
                        <div className="community-popover-links">
                          <CommunityLink href={communityLinks.githubUrl} title={t("welcome.github")} detail="MemTensor/memmy-agent" />
                          <CommunityLink href={communityLinks.discordUrl} title={t("welcome.discord")} detail="discord.gg/zfhKKn52wP" />
                          <CommunityLink href={communityLinks.twitterUrl} title={t("welcome.twitter")} detail="@Memmy_ai" />
                          <CommunityLink href={communityLinks.emailUrl} title={t("welcome.email")} detail={communityLinks.email} external={false} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={key}>
                {navButton}
              </div>
            );
          })}
        </nav>

        <div ref={taskScrollRef} className={`app-frame-task-scroll mt-5 mx-4 flex-1 overflow-y-auto${taskScrollFade ? " app-frame-task-scroll--faded" : ""}`}>
          <div className="space-y-3">
            {!showingArchived && (
              <TaskSection
                title={t("common.pin")}
                tasks={taskGroups.pinned}
                currentSessionKey={highlightedSessionKey}
                showPreviews={state.agent.sidebarState.view.show_previews}
                onOpenTask={openAgentTask}
                onRenameTask={openRenameDialog}
                onContextMenu={openTaskContextMenu}
                onPinTask={pinTask}
                archiveConfirmSessionKey={archiveConfirmSessionKey}
                onRequestArchiveTask={requestArchiveTask}
                onConfirmArchiveTask={archiveTask}
                onUnarchiveTask={unarchiveTask}
                onDeleteArchivedTask={requestDeleteArchivedTask}
                hideWhenEmpty
              />
            )}
            {timeGroups.length > 0 ? timeGroups.map((group, index) => (
              <TaskSection
                key={group.labelKey}
                title={t(group.labelKey as Parameters<typeof t>[0])}
                tasks={group.tasks}
                currentSessionKey={highlightedSessionKey}
                showPreviews={state.agent.sidebarState.view.show_previews}
                onOpenTask={openAgentTask}
                onRenameTask={openRenameDialog}
                onContextMenu={openTaskContextMenu}
                onPinTask={pinTask}
                archiveConfirmSessionKey={archiveConfirmSessionKey}
                onRequestArchiveTask={requestArchiveTask}
                onConfirmArchiveTask={archiveTask}
                onUnarchiveTask={unarchiveTask}
                onDeleteArchivedTask={requestDeleteArchivedTask}
                headerAction={index === 0 ? (
                  <div className="relative flex items-center">
                    <button
                      type="button"
                      aria-label={t("appFrame.taskList.actions")}
                      title={t("appFrame.taskList.actions")}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleTaskListMenu(sidebarMenuAnchorFromRect(event.currentTarget.getBoundingClientRect()));
                      }}
                      className="app-frame-task-section-action"
                    >
                      <span className="app-frame-task-section-action__dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                    </button>
                    {taskListMenuAnchor && (
                      <SidebarMoreMenu
                        anchor={taskListMenuAnchor}
                        showPreviews={state.agent.sidebarState.view.show_previews}
                        showArchived={state.agent.sidebarState.view.show_archived}
                        sort={state.agent.sidebarState.view.sort}
                        sortMenuOpen={sortMenuOpen}
                        onRefresh={() => {
                          setTaskListMenuAnchor(null);
                          void refreshAgentTasks();
                        }}
                        onTogglePreviews={() => {
                          setTaskListMenuAnchor(null);
                          void saveSidebarView({ showPreviews: !state.agent.sidebarState.view.show_previews });
                        }}
                        onToggleArchived={() => {
                          setTaskListMenuAnchor(null);
                          void saveSidebarView({ showArchived: !state.agent.sidebarState.view.show_archived });
                        }}
                        onToggleSortMenu={() => setSortMenuOpen((value) => !value)}
                        onSelectSort={(sort) => {
                          setTaskListMenuAnchor(null);
                          setSortMenuOpen(false);
                          void saveSidebarView({ sort });
                        }}
                      />
                    )}
                  </div>
                ) : undefined}
                alwaysShowHeader
              />
            )) : (
              <TaskSection
                title={t("appFrame.timeGroup.today")}
                tasks={[]}
                currentSessionKey={highlightedSessionKey}
                showPreviews={state.agent.sidebarState.view.show_previews}
                emptyText={state.agent.isLoadingSessions ? t("appFrame.taskList.loading") : state.agent.error ?? t(showingArchived ? "appFrame.taskList.emptyArchived" as MessageKey : "appFrame.taskList.empty")}
                onOpenTask={openAgentTask}
                onRenameTask={openRenameDialog}
                onContextMenu={openTaskContextMenu}
                onPinTask={pinTask}
                archiveConfirmSessionKey={archiveConfirmSessionKey}
                onRequestArchiveTask={requestArchiveTask}
                onConfirmArchiveTask={archiveTask}
                onUnarchiveTask={unarchiveTask}
                onDeleteArchivedTask={requestDeleteArchivedTask}
                headerAction={(
                  <div className="relative flex items-center">
                    <button
                      type="button"
                      aria-label={t("appFrame.taskList.actions")}
                      title={t("appFrame.taskList.actions")}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleTaskListMenu(sidebarMenuAnchorFromRect(event.currentTarget.getBoundingClientRect()));
                      }}
                      className="app-frame-task-section-action"
                    >
                      <span className="app-frame-task-section-action__dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                    </button>
                    {taskListMenuAnchor && (
                      <SidebarMoreMenu
                        anchor={taskListMenuAnchor}
                        showPreviews={state.agent.sidebarState.view.show_previews}
                        showArchived={state.agent.sidebarState.view.show_archived}
                        sort={state.agent.sidebarState.view.sort}
                        sortMenuOpen={sortMenuOpen}
                        onRefresh={() => {
                          setTaskListMenuAnchor(null);
                          void refreshAgentTasks();
                        }}
                        onTogglePreviews={() => {
                          setTaskListMenuAnchor(null);
                          void saveSidebarView({ showPreviews: !state.agent.sidebarState.view.show_previews });
                        }}
                        onToggleArchived={() => {
                          setTaskListMenuAnchor(null);
                          void saveSidebarView({ showArchived: !state.agent.sidebarState.view.show_archived });
                        }}
                        onToggleSortMenu={() => setSortMenuOpen((value) => !value)}
                        onSelectSort={(sort) => {
                          setTaskListMenuAnchor(null);
                          setSortMenuOpen(false);
                          void saveSidebarView({ sort });
                        }}
                      />
                    )}
                  </div>
                )}
                alwaysShowHeader
              />
            )}
          </div>
          {taskContextMenu && (
            <TaskContextMenu
              menu={taskContextMenu}
              onRename={openRenameDialog}
              onPinTask={pinTask}
              onArchiveTask={requestArchiveTask}
              onUnarchiveTask={unarchiveTask}
              onDeleteArchivedTask={requestDeleteArchivedTask}
              onClose={() => setTaskContextMenu(null)}
            />
          )}
        </div>

        <button
          type="button"
          onClick={openSettingsFromSidebar}
          title={t("settings.title")}
          aria-label={t("settings.title")}
          className="app-frame-sidebar-footer app-frame-sidebar-footer--button"
        >
          <span className="flex w-full items-center gap-2 px-2 py-1.5">
            <span className="w-6 h-6 rounded-full bg-action-sky/15 flex items-center justify-center shrink-0" aria-hidden="true">
              <User size={13} className="text-action-sky" />
            </span>
            <span className="app-frame-profile-text flex-1 min-w-0">
              <SidebarProfileTextLine
                className="app-frame-profile-name text-text-ink/70 truncate"
                fullText={accountSummary.name}
                line={accountNameLine}
              />
              <SidebarProfileTextLine
                className="app-frame-profile-meta text-text-ink/45 truncate"
                fullText={accountSummary.meta}
                line={accountMetaLine}
              />
            </span>
            <span
              className={`app-frame-profile-settings shrink-0 inline-flex items-center justify-center transition-colors ${
                state.navigation.currentPath === "/settings"
                  ? "app-frame-profile-settings--active text-action-sky"
                  : "text-text-ink/45"
              }`}
              aria-hidden="true"
            >
              <Settings2 size={14} />
            </span>
          </span>
        </button>
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
        label={t("appFrame.resizeSidebar")}
        width={sidebarResize.width}
        minWidth={sidebarResize.minWidth}
        maxWidth={sidebarResize.maxWidth}
        isResizing={sidebarResize.isResizing}
        isDisabled={sidebarHidden || showCommunity}
        onResizeStart={sidebarResize.beginResize}
        onResizeBy={sidebarResize.resizeBy}
      />

      <main className={`relative min-w-0 flex-1 overflow-hidden flex flex-col bg-content-bg${sidebarHidden ? " app-frame-main--sidebar-hidden" : ""}`} aria-label={props.title}>
        {props.reserveTopBar !== false && (
          <header className={`app-frame-content-topbar${props.topBarBorder ? " app-frame-content-topbar--bordered" : ""}`}>
            {props.topBar}
          </header>
        )}
        <div
          className={`min-h-0 h-full flex-1 overflow-hidden${
            sidebarHidden && !props.topBarBorder ? " app-frame-content-body--sidebar-hidden" : ""
          }`}
          style={props.topBarBorder ? { paddingTop: "var(--codex-toolbar-height)" } : undefined}
        >
          {props.children}
        </div>
      </main>
      <ConfirmDialog
        open={deleteConfirmTask != null}
        title={t("appFrame.deleteArchivedTitle")}
        message={deleteConfirmTask ? t("appFrame.deleteArchivedConfirm", { title: deleteConfirmTask.title }) : ""}
        cancelLabel={t("dialog.cancel")}
        closeLabel={t("common.close")}
        confirmLabel={t("dialog.ok")}
        confirmVariant="danger"
        onCancel={() => setDeleteConfirmTask(null)}
        onConfirm={() => void confirmDeleteArchivedTask()}
      />
      <Modal
        open={renameTarget != null}
        title={t("appFrame.renameTaskPrompt")}
        showCloseButton={false}
        className="rename-dialog"
        backdropClassName="rename-dialog-backdrop"
        style={{ width: 360, maxWidth: "calc(100vw - 32px)" }}
        initialFocusRef={renameInputRef}
        onClose={closeRenameDialog}
        footer={(
          <>
            <Button type="button" variant="soft" size="sm" onClick={closeRenameDialog}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={submitRenameDialog}>
              {t("dialog.ok")}
            </Button>
          </>
        )}
      >
        <input
          ref={renameInputRef}
          type="text"
          value={renameValue}
          maxLength={60}
          placeholder={t("appFrame.renameTaskPlaceholder")}
          aria-label={t("appFrame.renameTaskPrompt")}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (isComposingKeyboardEvent(event)) {
                return;
              }
              event.preventDefault();
              submitRenameDialog();
            }
          }}
          className="w-full px-3 py-2 rounded-input border border-border-stone/40 bg-background-paper text-sm text-text-ink/80 placeholder:text-text-ink/40 outline-none focus:outline-none"
        />
      </Modal>
      {deferredGuidanceStep === "improvement" && state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset" && (
        <ImprovementProgramModal
          onChoice={chooseDeferredImprovementProgram}
          onLearnMore={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}
          showGift={state.bootstrap?.promotions?.improvementGift ?? true}
        />
      )}
      {deferredGuidanceStep === "product_tour" && (
        <ProductTourGuide
          onDismiss={() => {
            // Increment 3: after the product tour ends, enter the final DGS step — the nickname modal (set for both account and BYOK).
            // The tour has ended; clear the persisted step index so the next tour doesn't resume from a mid-tour step.
            clearProductTourStep(typeof window === "undefined" ? undefined : window.sessionStorage);
            setDeferredNickname(randomNickname(language));
            writeDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage, "nickname");
            setDeferredGuidanceStep("nickname");
          }}
          onTabChange={(tab: ProductTourTab) => {
            // The memory step maps to /main (stay on the main workspace and highlight the memory entry icon) rather than the standalone /memory page —
            // /memory doesn't host the tour overlay, so navigating there would lose the tour and strand the user on the memory page. See productTourTabRoute for the mapping.
            dispatch(appActions.navigate(productTourTabRoute(tab)));
          }}
        />
      )}
      {deferredGuidanceStep === "nickname" && (
        <NicknameModal
          open
          nickname={deferredNickname}
          onNicknameChange={setDeferredNickname}
          onShuffle={() => setDeferredNickname(randomNickname(language))}
          onSubmit={submitDeferredNickname}
        />
      )}
      <SearchPalette
        open={searchPaletteOpen}
        tasks={state.agent.tasks}
        placeholder={t("appFrame.search")}
        emptyLabel={t("appFrame.search.empty")}
        untitledLabel={t("appFrame.search.untitled")}
        ariaLabel={t("appFrame.search")}
        onClose={() => setSearchPaletteOpen(false)}
        onSelectTask={(task) => {
          setSearchPaletteOpen(false);
          void openAgentTask(task);
        }}
      />
    </div>
  );
}

let agentHistoryRequestCounter = 0;
let agentSessionsRequestCounter = 0;

function nextAgentHistoryRequestId(chatId: string): string {
  agentHistoryRequestCounter += 1;
  return `${chatId}-${agentHistoryRequestCounter}`;
}

function nextAgentSessionsRequestId(reason: "manual"): string {
  agentSessionsRequestCounter += 1;
  return `sessions-${reason}-${Date.now()}-${agentSessionsRequestCounter}`;
}

function CommunityLink(props: { href: string; title: string; detail: string; external?: boolean }) {
  const external = props.external ?? true;
  return (
    <a
      href={props.href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="community-link flex flex-col rounded-lg text-xs text-text-ink/60 transition-colors"
    >
      <span className="community-link-title font-medium text-text-ink/70">{props.title}</span>
      <span className="community-link-detail text-text-ink/45">{props.detail}</span>
    </a>
  );
}

/**
 * Converts a button DOMRect into a sidebar menu anchor.
 *
 * @param rect The trigger button's rectangle relative to the viewport.
 * @returns The sidebar menu anchor.
 */
function sidebarMenuAnchorFromRect(rect: DOMRect): SidebarMenuAnchor {
  return {
    right: rect.right,
    bottom: rect.bottom
  };
}

/**
 * Resolves the fixed positioning coordinates for the sidebar menu.
 *
 * @param anchor The trigger button anchor.
 * @param viewport The current viewport size.
 * @param size The menu size and margin configuration.
 * @returns The menu's fixed coordinates relative to the viewport.
 */
export function resolveSidebarMenuPlacement(
  anchor: SidebarMenuAnchor,
  viewport: SidebarMenuViewport,
  size: SidebarMenuSize
): SidebarMenuPlacement {
  const maxRight = Math.max(size.margin, viewport.width - size.width - size.margin);
  const maxTop = Math.max(size.margin, viewport.height - size.height - size.margin);

  return {
    right: clamp(viewport.width - anchor.right, size.margin, maxRight),
    top: clamp(anchor.bottom + size.gap, size.margin, maxTop)
  };
}

/**
 * Resolves the inline styles used by the sidebar menu's body portal.
 *
 * @param anchor The trigger button anchor.
 * @param viewport The current viewport size.
 * @param size The menu size and margin configuration.
 * @returns The menu's fixed coordinates and overlay z-index.
 */
export function resolveSidebarMenuOverlayStyle(
  anchor: SidebarMenuAnchor,
  viewport: SidebarMenuViewport,
  size: SidebarMenuSize
): SidebarMenuOverlayStyle {
  return {
    ...resolveSidebarMenuPlacement(anchor, viewport, size),
    zIndex: sidebarMenuOverlayZIndex
  };
}

/**
 * Clamps a number to a closed interval.
 *
 * @param value The number to clamp.
 * @param min The minimum value.
 * @param max The maximum value.
 * @returns The clamped number.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function groupAgentTasks(tasks: AgentTaskView[]): TaskGroups {
  return {
    pinned: tasks.filter((task) => task.pinned && !task.archived),
    active: tasks.filter((task) => !task.pinned && !task.archived),
    archived: tasks.filter((task) => task.archived)
  };
}

export interface TimeGroup {
  labelKey: string;
  tasks: AgentTaskView[];
}

export function groupTasksByTime(tasks: AgentTaskView[], now?: Date): TimeGroup[] {
  const ref = now ?? new Date();
  const todayStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;

  const today: AgentTaskView[] = [];
  const yesterday: AgentTaskView[] = [];
  const week: AgentTaskView[] = [];
  const older: AgentTaskView[] = [];

  for (const task of tasks) {
    const ts = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
    if (ts >= todayStart) {
      today.push(task);
    } else if (ts >= yesterdayStart) {
      yesterday.push(task);
    } else if (ts >= weekStart) {
      week.push(task);
    } else {
      older.push(task);
    }
  }

  const groups: TimeGroup[] = [];
  if (today.length) groups.push({ labelKey: "appFrame.timeGroup.today", tasks: today });
  if (yesterday.length) groups.push({ labelKey: "appFrame.timeGroup.yesterday", tasks: yesterday });
  if (week.length) groups.push({ labelKey: "appFrame.timeGroup.last7days", tasks: week });
  if (older.length) groups.push({ labelKey: "appFrame.timeGroup.older", tasks: older });
  return groups;
}

function TaskSection(props: {
  title: string;
  tasks: AgentTaskView[];
  currentSessionKey: string | null;
  showPreviews: boolean;
  headerAction?: ReactNode;
  emptyText?: string;
  alwaysShowHeader?: boolean;
  hideWhenEmpty?: boolean;
  onOpenTask: (task: AgentTaskView) => Promise<void>;
  onRenameTask: (task: AgentTaskView) => void;
  onContextMenu: (event: MouseEvent, task: AgentTaskView) => void;
  onPinTask: (task: AgentTaskView, pinned: boolean) => void;
  archiveConfirmSessionKey: string | null;
  onRequestArchiveTask: (task: AgentTaskView) => void;
  onConfirmArchiveTask: (task: AgentTaskView) => void;
  onUnarchiveTask: (task: AgentTaskView) => void;
  onDeleteArchivedTask: (task: AgentTaskView) => void;
}) {
  if (!props.tasks.length && !props.emptyText && props.hideWhenEmpty && !props.alwaysShowHeader) {
    return null;
  }

  return (
    <section className="space-y-1.5">
      <div className="app-frame-task-section-header flex items-center justify-between py-1.5 pl-3 pr-0">
        <div className="app-frame-task-section-header__title text-text-ink/45">{props.title}</div>
        {props.headerAction}
      </div>
      {props.tasks.map((task) => (
        <TaskRow
          key={task.sessionKey}
          task={task}
          isCurrent={props.currentSessionKey === task.sessionKey}
          showPreview={props.showPreviews}
          onOpen={() => void props.onOpenTask(task)}
          onRename={() => props.onRenameTask(task)}
          onContextMenu={(event) => props.onContextMenu(event, task)}
          onPin={() => props.onPinTask(task, !task.pinned)}
          archiveConfirming={props.archiveConfirmSessionKey === task.sessionKey}
          onRequestArchive={() => props.onRequestArchiveTask(task)}
          onConfirmArchive={() => props.onConfirmArchiveTask(task)}
          onUnarchive={() => props.onUnarchiveTask(task)}
          onDeleteArchived={() => void props.onDeleteArchivedTask(task)}
        />
      ))}
      {!props.tasks.length && props.emptyText && <div className="app-frame-task-empty pl-3 py-2 text-text-ink/40">{props.emptyText}</div>}
    </section>
  );
}

export function TaskRow(props: {
  task: AgentTaskView;
  isCurrent: boolean;
  showPreview: boolean;
  onOpen: () => void;
  onRename?: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onPin: () => void;
  archiveConfirming: boolean;
  onRequestArchive: () => void;
  onConfirmArchive: () => void;
  onUnarchive: () => void;
  onDeleteArchived: () => void;
}) {
  const { t } = useTranslation();
  const [isTaskRowHovered, setIsTaskRowHovered] = useState(false);
  const archived = props.task.archived;
  const rowStateClass = props.archiveConfirming
    ? "bg-status-error/5 ring-1 ring-status-error/15"
    : props.isCurrent
      ? "app-frame-nav-button--active"
      : "hover:bg-canvas-oat/50";
  const titleClass = props.isCurrent ? "text-action-sky-hover" : "text-text-ink/70";
  const previewClass = props.isCurrent ? "text-action-sky-hover/65" : "text-text-ink/45";
  const hasTaskStatus = props.task.runStartedAt != null || props.task.completedUnseen;
  const shouldShowTaskActions = archived ? isTaskRowHovered : props.archiveConfirming || isTaskRowHovered || hasTaskStatus;

  return (
    <div
      className={`app-frame-task-row relative flex items-start gap-1 transition-all text-text-ink/65 ${rowStateClass}`}
      data-current-session={props.isCurrent ? "true" : undefined}
      onContextMenu={props.onContextMenu}
      onMouseEnter={() => setIsTaskRowHovered(true)}
      onMouseLeave={() => setIsTaskRowHovered(false)}
    >
      <button
        type="button"
        aria-current={props.isCurrent ? "page" : undefined}
        onClick={props.onOpen}
        onDoubleClick={(event) => {
          if (archived || !props.onRename) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          props.onRename();
        }}
        className="min-w-0 flex-1 text-left pl-3 py-2 cursor-pointer"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`app-frame-task-title min-w-0 flex-1 truncate ${titleClass}`}>{props.task.title}</span>
        </span>
        {props.showPreview && props.task.preview && (
          <span className={`app-frame-task-preview mt-1 block truncate ${previewClass}`}>{props.task.preview}</span>
        )}
      </button>
      {shouldShowTaskActions && (
        <div className="flex self-center shrink-0 items-center justify-center gap-0.5 pr-1.5">
          {archived ? (
            <>
              <TaskIconButton label={t("appFrame.task.unarchive")} active onClick={props.onUnarchive}>
                <Archive size={12} />
              </TaskIconButton>
              <TaskIconButton label={t("appFrame.task.deleteArchived")} danger onClick={props.onDeleteArchived}>
                <Trash2 size={12} />
              </TaskIconButton>
            </>
          ) : props.archiveConfirming ? (
            <TaskArchiveInlineAction
              task={props.task}
              confirming={props.archiveConfirming}
              onPin={props.onPin}
              onRequestArchive={props.onRequestArchive}
              onConfirmArchive={props.onConfirmArchive}
            />
          ) : isTaskRowHovered ? (
            <>
              <TaskIconButton label={props.task.pinned ? t("appFrame.task.unpin") : t("appFrame.task.pin")} active={props.task.pinned} onClick={props.onPin}>
                <Pin size={12} />
              </TaskIconButton>
              <div className="relative h-6 w-6">
                <div className="absolute inset-0 transition-opacity opacity-100">
                  <TaskIconButton label={t("appFrame.task.archive")} onClick={props.onRequestArchive}>
                    <Archive size={12} />
                  </TaskIconButton>
                </div>
              </div>
            </>
          ) : (
            <div className="relative h-6 w-6">
              <div className="absolute inset-0 flex items-center justify-center transition-opacity opacity-100">
                <TaskStatusIndicator task={props.task} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskStatusIndicator(props: { task: AgentTaskView }) {
  const { t } = useTranslation();
  if (props.task.runStartedAt != null) {
    const label = t("appFrame.task.running");
    return (
      <span className="shrink-0 w-4 h-4 inline-flex items-center justify-center text-action-sky" aria-label={label} title={label}>
        <Loader2 size={12} className="animate-spin" />
      </span>
    );
  }
  if (props.task.completedUnseen) {
    const label = t("appFrame.task.completedUnseen");
    return (
      <span className="shrink-0 w-4 h-4 inline-flex items-center justify-center" aria-label={label} title={label}>
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--color-warning)" }} />
      </span>
    );
  }
  return null;
}

export function TaskArchiveInlineAction(props: {
  task: AgentTaskView;
  confirming: boolean;
  onPin: () => void;
  onRequestArchive: () => void;
  onConfirmArchive: () => void;
}) {
  const { t } = useTranslation();

  if (props.confirming) {
    return <InlineConfirmButton ariaLabel={t("appFrame.task.confirmArchive")} label={t("common.confirm")} onClick={props.onConfirmArchive} />;
  }

  return (
    <>
      <TaskIconButton label={props.task.pinned ? t("appFrame.task.unpin") : t("appFrame.task.pin")} active={props.task.pinned} onClick={props.onPin}>
        <Pin size={12} />
      </TaskIconButton>
      <TaskIconButton label={t("appFrame.task.archive")} onClick={props.onRequestArchive}>
        <Archive size={12} />
      </TaskIconButton>
    </>
  );
}

function TaskIconButton(props: { label: string; active?: boolean; danger?: boolean; children: ReactNode; onClick: () => void }) {
  const colorClass = props.danger
    ? "text-text-ink/40 hover:text-status-error"
    : props.active
      ? "text-action-sky hover:text-action-sky-hover"
      : "text-text-ink/40 hover:text-text-ink/70";

  return (
    <Tooltip content={props.label}>
      <button
        type="button"
        aria-label={props.label}
        onClick={(event) => {
          event.stopPropagation();
          props.onClick();
        }}
        className={`task-icon-button w-6 h-6 inline-flex items-center justify-center rounded-input text-center leading-none hover:bg-background-paper/80 transition-colors cursor-pointer ${colorClass}`}
      >
        {props.children}
      </button>
    </Tooltip>
  );
}

function InlineConfirmButton(props: { ariaLabel: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className="h-6 px-2.5 inline-flex items-center justify-center rounded-input border border-status-error/35 bg-status-error/10 text-center text-[11px] font-bold leading-none text-status-error hover:bg-status-error/15 transition-colors cursor-pointer"
    >
      {props.label}
    </button>
  );
}

function SidebarMoreMenu(props: {
  anchor: SidebarMenuAnchor;
  showPreviews: boolean;
  showArchived: boolean;
  sort: AgentTaskSort;
  sortMenuOpen: boolean;
  onRefresh: () => void;
  onTogglePreviews: () => void;
  onToggleArchived: () => void;
  onToggleSortMenu: () => void;
  onSelectSort: (sort: AgentTaskSort) => void;
}) {
  const { t } = useTranslation();

  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }

  const overlayStyle = resolveSidebarMenuOverlayStyle(
    props.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    sidebarMoreMenuSize
  );
  const menu = (
    <div
      className="fixed w-32 rounded-menu border border-border-stone/40 bg-background-paper shadow-lg p-1"
      style={overlayStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <MenuButton icon={<RefreshCw size={12} />} label={t("appFrame.task.refresh")} onClick={props.onRefresh} />
      <MenuButton icon={<ListChecks size={12} />} label={props.showPreviews ? t("appFrame.task.hidePreview") : t("appFrame.task.preview")} onClick={props.onTogglePreviews} />
      <div className="relative">
        <MenuButton icon={<LayoutList size={12} />} label={t("appFrame.task.sort")} onClick={props.onToggleSortMenu} />
        {props.sortMenuOpen && (
          <div className="absolute left-full top-0 ml-1 w-28 rounded-menu border border-border-stone/40 bg-background-paper shadow-lg p-1">
            {taskSortOptions.map((option) => (
              <MenuButton
                key={option.value}
                label={t(option.labelKey as MessageKey)}
                active={props.sort === option.value}
                onClick={() => props.onSelectSort(option.value)}
              />
            ))}
          </div>
        )}
      </div>
      <MenuButton
        icon={<Archive size={12} />}
        label={props.showArchived ? t("appFrame.task.showAll" as MessageKey) : t("appFrame.task.showArchived" as MessageKey)}
        active={props.showArchived}
        onClick={props.onToggleArchived}
      />
    </div>
  );

  return createPortal(menu, document.body);
}

function TaskContextMenu(props: {
  menu: TaskContextMenuState;
  onRename: (task: AgentTaskView) => void;
  onPinTask: (task: AgentTaskView, pinned: boolean) => void;
  onArchiveTask: (task: AgentTaskView) => void;
  onUnarchiveTask: (task: AgentTaskView) => void;
  onDeleteArchivedTask: (task: AgentTaskView) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const task = props.menu.task;
  const run = (action: () => void) => {
    action();
    props.onClose();
  };
  return (
    <div
      className="fixed z-50 w-36 rounded-menu border border-border-stone/40 bg-background-paper shadow-lg p-1"
      style={{ left: props.menu.x, top: props.menu.y }}
      onClick={(event) => event.stopPropagation()}
    >
      {task.archived ? (
        <>
          <MenuButton label={t("appFrame.task.unarchive")} onClick={() => run(() => props.onUnarchiveTask(task))} />
          <MenuButton label={t("appFrame.task.deleteArchived")} danger onClick={() => run(() => void props.onDeleteArchivedTask(task))} />
        </>
      ) : (
        <>
          <MenuButton label={t("appFrame.task.rename")} onClick={() => run(() => void props.onRename(task))} />
          <MenuButton label={task.pinned ? t("appFrame.task.unpin") : t("appFrame.task.pin")} onClick={() => run(() => props.onPinTask(task, !task.pinned))} />
          <MenuButton label={t("appFrame.task.archive")} onClick={() => run(() => props.onArchiveTask(task))} />
        </>
      )}
    </div>
  );
}

function MenuButton(props: { label: string; icon?: ReactNode; active?: boolean; danger?: boolean; onClick: () => void }) {
  const colorClass = props.danger
    ? "text-status-error hover:bg-status-error/10"
    : props.active
      ? "text-action-sky bg-action-sky/10"
      : "text-text-ink/65 hover:bg-canvas-oat/60";
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-input text-left text-xs cursor-pointer ${colorClass}`}
    >
      {props.icon}
      <span className="truncate">{props.label}</span>
    </button>
  );
}

function SidebarProfileTextLine(props: { className: string; fullText: string; line: AccountDisplayText }) {
  const content = (
    <span
      className={props.className}
      tabIndex={props.line.truncated ? 0 : undefined}
      aria-label={props.line.truncated ? props.fullText : undefined}
    >
      {props.line.text}
    </span>
  );

  return props.line.truncated ? <Tooltip content={props.fullText}>{content}</Tooltip> : content;
}

/**
 * Resolves the sidebar account summary by sign-in mode.
 *
 * @param state The current global state.
 * @param labels The sidebar account copy.
 * @returns The account summary shown in the sidebar.
 */
export function resolveSidebarAccountSummary(state: AppState, labels: SidebarAccountLabels): SidebarAccountSummary {
  const userMode = state.bootstrap?.app.userMode ?? "unset";

  if (userMode === "byok") {
    // The BYOK-set name is persisted in local localStorage and read back into state.account.nickname on startup; show it if present, otherwise fall back to the brand name.
    // meta is fixed to the mode label ("API Key mode").
    return {
      name: state.account.nickname || labels.brandName,
      meta: labels.byokLabel
    };
  }

  if (userMode === "account") {
    const accountIdentifier = state.account.email || state.account.phoneNumber || "";
    const maskedIdentifier = maskAccountIdentifier(accountIdentifier);

    return {
      name: state.account.nickname || maskedIdentifier || labels.accountFallback,
      meta: maskedIdentifier || labels.accountMetaFallback
    };
  }

  return {
    name: labels.unsetName,
    meta: labels.unsetMeta
  };
}

export function truncateAccountDisplayText(text: string, maxVisualWidth: number): AccountDisplayText {
  const normalized = text.trim();
  if (!normalized || maxVisualWidth <= 0) {
    return { text: normalized, truncated: false };
  }

  let visualWidth = 0;
  let output = "";
  for (const char of Array.from(normalized)) {
    const charWidth = sidebarAccountCharWidth(char);
    if (visualWidth + charWidth > maxVisualWidth) {
      return { text: `${output.trimEnd()}${ACCOUNT_DISPLAY_ELLIPSIS}`, truncated: true };
    }
    visualWidth += charWidth;
    output += char;
  }

  return { text: normalized, truncated: false };
}

function sidebarAccountCharWidth(char: string): number {
  if ((char.codePointAt(0) ?? 0) <= 0xff) {
    return 0.5;
  }

  return 1;
}
