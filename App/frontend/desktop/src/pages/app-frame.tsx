import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  productTourIncludesLogs,
  productTourStartMemorySubPage,
  productTourStartRoute
} from "../app/product-tour.js";
import { PRODUCT_TOUR_CHAT_CONTENT_ANCHOR, PRODUCT_TOUR_MEMORY_NAV_ANCHOR, PRODUCT_TOUR_TOOLS_NAV_ANCHOR } from "../app/product-tour-layout.js";
import type { AppRoutePath } from "../app/routes.js";
import { clearFocusedAgentTarget, clearProductTourStep, readDeferredGuidanceStep, readGuidanceCompleted, routeTable, writeDeferredGuidanceStep } from "../app/routes.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { buildOnboardingStepCompletedEvent } from "../analytics/onboarding-analytics.js";
import {
  useOptionalAgentRuntimeBridge,
  type AgentTaskStateCoordinator,
  type SidebarIntent
} from "../app/agent-runtime-bridge.js";
import { useOptionalApiClients } from "../app/providers.js";
import { MemmyAgentRequestError } from "../api/memmy-agent-client.js";
import { communityLinks } from "../community/community-links.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Tooltip } from "../components/tooltip.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { useOptionalUpdateCoordinator, type UpdateCoordinatorValue } from "../app/update-coordinator.js";
import type { MemmyAgentProject, WebuiSessionTarget } from "../api/memmy-agent-client.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { useTaskBus } from "../lib/task-bus.js";
import { agentActions, appActions, createAgentOperationError } from "../state/app-actions.js";
import type { AppState } from "../state/app-reducer.js";
import { useAppState } from "../state/app-state.js";
import { agentChatScopeKey } from "../state/agent-composer-state.js";
import type { AgentTaskView } from "../state/agent-chat-slice.js";
import { decideTaskDoneNotification } from "../state/task-done-notification.js";
import { maskAccountIdentifier } from "../utils/mask-account-identifier.js";
import { openExternalUrl } from "../utils/open-url.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import { ImChannelTitleIcon, imChannelTitleDisplay } from "../integrations/integration-meta.js";
import { ImprovementProgramModal } from "./improvement-program-modal.js";
import { writeMemorySubPage } from "./memory-page.js";
import { SearchPalette } from "../components/search-palette.js";
import { SidebarResizeHandle, useCodexResizableSidebar } from "./sidebar-resize.js";
import {
  Archive,
  ArrowLeft,
  BarChart3,
  BrainCircuit,
  Info,
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
  User,
  Wand2
} from "./memory/memory-prototype-icons.js";
import { SETTINGS_NAV_ITEMS, type SettingsTabId } from "./settings-nav.js";
import { Check, CheckCheck, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download, Folder, FolderOpen, FolderPlus, ListFilter, MoreHorizontal, Plus, RotateCcw } from "lucide-react";

export interface SettingsSidebarNav {
  activeTab: SettingsTabId;
  onSelectTab: (tab: SettingsTabId) => void;
}

export interface AppFrameProps {
  title: string;
  reserveTopBar?: boolean;
  topBar?: ReactNode;
  topBarBorder?: boolean;
  /** When set, replaces the main app sidebar with settings section navigation. */
  settingsNav?: SettingsSidebarNav;
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

export interface ProjectSidebarNode {
  project: MemmyAgentProject;
  tasks: AgentTaskView[];
}

export interface ProjectSidebarTree {
  pinnedTasks: AgentTaskView[];
  pinnedProjects: ProjectSidebarNode[];
  projects: ProjectSidebarNode[];
  standaloneTasks: AgentTaskView[];
  archivedProjects: ProjectSidebarNode[];
  archivedStandaloneTasks: AgentTaskView[];
}

type SidebarContextMenuPlacementSource =
  | { kind: "anchor"; anchor: SidebarMenuAnchor }
  | { kind: "point"; x: number; y: number };

interface ProjectContextMenuState {
  projectId: string;
  placement: SidebarContextMenuPlacementSource;
}

interface TaskContextMenuState {
  task: AgentTaskView;
  x: number;
  y: number;
}

type SidebarInlineRename = { sessionKey: string; original: string };

type SidebarTaskPatch = Extract<SidebarIntent, { kind: "task-patch" }>["patch"];

interface SidebarMenuAnchor {
  left: number;
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

interface SidebarContextMenuPlacement {
  left: number;
  top: number;
}

type AgentTaskSort = AppState["agent"]["sidebarState"]["view"]["sort"];
type NewAgentDraftState = Pick<AppState["agent"], "blankDraftActive" | "newChatRequestId" | "composerDraftsByScope" | "composerPendingAttachmentsByScope">;

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

type AppFrameTranslate = (key: MessageKey, values?: MessageValues) => string;

interface SidebarUpdateActionView {
  kind: "available" | "downloading" | "installing" | "prepared";
  label: string;
  ariaLabel: string;
  title: string;
  disabled: boolean;
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

const taskListActionsMenuSize: SidebarMenuSize = {
  width: 140,
  height: 252,
  margin: 8,
  gap: 4
};
const taskContextMenuSize: SidebarMenuSize = {
  width: 144,
  height: 112,
  margin: 8,
  gap: 0
};
const projectContextMenuSize: SidebarMenuSize = {
  width: 240,
  height: 196,
  margin: 8,
  gap: 4
};
const projectCreateMenuSize: SidebarMenuSize = {
  width: 260,
  height: 280,
  margin: 8,
  gap: 2
};
const sidebarMenuOverlayZIndex = 9999;
const SIDEBAR_PROFILE_NAME_MAX_VISUAL_WIDTH = 10;
const SIDEBAR_PROFILE_META_MAX_VISUAL_WIDTH = 12;
const ACCOUNT_DISPLAY_ELLIPSIS = "…";
const standaloneRenderTaskStateCoordinator: AgentTaskStateCoordinator = {
  refreshTaskState: () => undefined,
  focusTask: () => undefined,
  mutateProject: async () => ({ status: "rejected", code: "agent_gateway_unavailable" }),
  enqueueSidebarIntent: async () => undefined,
  runWithSidebarSettled: async (operation) => operation(),
  retrySidebarIntents: () => undefined,
  dispose: () => undefined
};

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
    && !(agent.composerPendingAttachmentsByScope[draftScopeKey]?.length);
}

/** Sidebar workspace highlight: only when a blank new-task draft targets a project. */
export function resolveSelectedSidebarProjectId(
  agent: Pick<AppState["agent"], "currentSessionKey" | "newChatRequestId" | "draftTargetsByScope">,
  currentPath: string
): string | null {
  if (currentPath !== "/main") return null;
  // Existing chats must not light up their workspace — only new-task project picks do.
  if (agent.currentSessionKey) return null;
  const draft = agent.draftTargetsByScope[agentChatScopeKey(null, agent.newChatRequestId)];
  return draft?.kind === "project" ? draft.projectId : null;
}

export function AppFrame(props: AppFrameProps) {
  const { state, dispatch } = useAppState();
  const { clients } = useOptionalApiClients();
  const { t, language } = useTranslation();
  const update = useOptionalUpdateCoordinator();
  const { track } = useAnalytics();
  const taskStateCoordinator = useOptionalAgentRuntimeBridge()?.taskStateCoordinator
    ?? standaloneRenderTaskStateCoordinator;
  const taskBus = useTaskBus();
  const { syncAgentTaskStatuses } = taskBus;
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [showCommunity, setShowCommunity] = useState(false);
  const [taskListMenuAnchor, setTaskListMenuAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [taskContextMenu, setTaskContextMenu] = useState<TaskContextMenuState | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [projectCreateMenuAnchor, setProjectCreateMenuAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [inlineRename, setInlineRename] = useState<SidebarInlineRename | null>(null);
  const [inlineRenameDraft, setInlineRenameDraft] = useState("");
  const [removeProjectId, setRemoveProjectId] = useState<string | null>(null);
  const [archiveProjectId, setArchiveProjectId] = useState<string | null>(null);
  const [projectMutationId, setProjectMutationId] = useState<string | null>(null);
  const [archiveConfirmSessionKey, setArchiveConfirmSessionKey] = useState<string | null>(null);
  const [deleteConfirmTask, setDeleteConfirmTask] = useState<AgentTaskView | null>(null);
  const [deferredGuidanceStep, setDeferredGuidanceStep] = useState(() =>
    readDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage)
  );
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const communityMenuRef = useRef<HTMLDivElement | null>(null);
  const taskScrollRef = useRef<HTMLDivElement | null>(null);
  const [taskScrollFade, setTaskScrollFade] = useState(false);
  const sidebarResize = useCodexResizableSidebar("memmy.appFrame.sidebarWidth.codex.v2");
  const hasRequestedAgentData = useRef(false);
  const lastNotifiedCompletionAt = useRef<number | null>(null);
  const previousCanonicalSessionKeysRef = useRef<Set<string> | null>(null);
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
  const sidebarUpdateAction = resolveSidebarUpdateAction(update, t);
  const visibleTasks = state.agent.tasks;
  const projectTree = useMemo(
    () => deriveSidebarPlacement(visibleTasks, state.agent.projects),
    [state.agent.projects, visibleTasks]
  );
  const showingStandaloneArchived = state.agent.sidebarState.view.show_archived;
  const showingProjectArchived = state.agent.sidebarState.view.show_project_archived;
  const showingArchived = showingProjectArchived || showingStandaloneArchived;
  const visibleProjectTree = useMemo(
    () => deriveVisibleSidebarPlacement(projectTree, {
      projectTasks: showingArchived,
      standaloneTasks: showingArchived
    }),
    [projectTree, showingArchived]
  );
  const highlightedSessionKey = state.navigation.currentPath === "/main" ? state.agent.currentSessionKey : null;
  const selectedSidebarProjectId = resolveSelectedSidebarProjectId(state.agent, state.navigation.currentPath);

  const removeProject = state.agent.projects.find((project) => project.id === removeProjectId) ?? null;
  const archiveProject = state.agent.projects.find((project) => project.id === archiveProjectId) ?? null;
  const removeProjectTaskCount = removeProject
    ? state.agent.sessions.filter((session) => session.projectId === removeProject.id).length
    : 0;
  const archiveProjectTaskCount = archiveProject
    ? countProjectTasksToArchive(state.agent.tasks, archiveProject.id)
    : 0;

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
          || state.agent.goalStatesByChatId[task.chatId]?.status === "active"
      }))
    });
  }, [state.agent.goalStatesByChatId, state.agent.tasks, syncAgentTaskStatuses]);

  useEffect(() => {
    const current = new Set(state.agent.sessions.map((session) => session.key));
    const previous = previousCanonicalSessionKeysRef.current;
    if (previous) {
      const removed = [...previous].filter((sessionKey) => !current.has(sessionKey));
      if (removed.length && clients?.memmyAgent) {
        taskBus.removeTasksBySessionIds(removed.flatMap((sessionKey) => [
          sessionKey,
          clients.memmyAgent!.sessionKeyToChatId(sessionKey)
        ]));
      }
    }
    previousCanonicalSessionKeysRef.current = current;
  }, [clients?.memmyAgent, state.agent.sessions, taskBus]);

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
    if (
      typeof document === "undefined"
      || (!taskListMenuAnchor && !taskContextMenu && !projectContextMenu && !projectCreateMenuAnchor && !archiveConfirmSessionKey)
    ) {
      return;
    }

    const closeMenus = () => {
      setTaskListMenuAnchor(null);
      setSortMenuOpen(false);
      setTaskContextMenu(null);
      setProjectContextMenu(null);
      setProjectCreateMenuAnchor(null);
      setArchiveConfirmSessionKey(null);
    };
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        closeMenus();
        return;
      }
      // Portal menus live under document.body; ignore presses inside them so item
      // onClick can run (a blanket document click would unmount first).
      // Inline archive confirm lives in the task row (not a portal); pointerdown
      // must not clear archiveConfirmSessionKey before its click handler runs.
      if (
        target.closest(".app-frame-sidebar-menu")
        || target.closest(".app-frame-workspace-picker-menu")
        || target.closest(".app-frame-task-row--confirming")
      ) {
        return;
      }
      closeMenus();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenus();
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [archiveConfirmSessionKey, projectContextMenu, projectCreateMenuAnchor, taskContextMenu, taskListMenuAnchor]);

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

  function refreshAgentTasks(): void {
    taskStateCoordinator.refreshTaskState({ reason: "manual" });
  }

  function openNewAgent(target?: WebuiSessionTarget) {
    const nextDraftRequestId = shouldCreateNewAgentDraft(state.agent)
      ? state.agent.newChatRequestId + 1
      : state.agent.newChatRequestId;
    const draftScopeKey = agentChatScopeKey(null, nextDraftRequestId);
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
    if (target || !(draftScopeKey in state.agent.draftTargetsByScope)) {
      dispatch(agentActions.draftTargetUpdated(draftScopeKey, target ?? { kind: "standalone" }));
    }
    dispatch(appActions.navigate("/main"));
  }

  function openSidebarRoute(path: AppRoutePath) {
    if (path === "/main") {
      openNewAgent({ kind: "standalone" });
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
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const firstStep = state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset" ? "improvement" : "product_tour";
    if (firstStep === "product_tour") {
      const includeLogs = productTourIncludesLogs(state.bootstrap?.onboarding.scanPermission);
      clearProductTourStep(storage);
      writeMemorySubPage(storage, productTourStartMemorySubPage(includeLogs));
      dispatch(appActions.navigate(productTourStartRoute(includeLogs)));
    }
    writeDeferredGuidanceStep(storage, firstStep);
    setDeferredGuidanceStep(firstStep);
  }

  function chooseDeferredImprovementProgram(accepted: boolean) {
    const onboardingPatch = { improvementProgram: accepted ? "accepted" : "declined" } as const;
    const privacyPatch = { allowMemoryImprovementUpload: accepted };
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const includeLogs = productTourIncludesLogs(state.bootstrap?.onboarding.scanPermission);

    clearProductTourStep(storage);
    writeMemorySubPage(storage, productTourStartMemorySubPage(includeLogs));
    writeDeferredGuidanceStep(storage, "product_tour");
    setDeferredGuidanceStep("product_tour");
    dispatch(appActions.navigate(productTourStartRoute(includeLogs)));
    dispatch(appActions.onboardingUpdated(onboardingPatch));
    dispatch(appActions.privacyUpdated(privacyPatch));
    track(buildOnboardingStepCompletedEvent({
      step: "improvement_program",
      choice: accepted ? "accepted" : "declined",
      scanPermission: state.bootstrap?.onboarding.scanPermission
    }));

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
      dispatch(agentActions.historyOpenFailed(chatId, requestId, createAgentOperationError({
        source: "history",
        message: error instanceof Error ? error.message : String(error),
        chatId
      })));
    }
  }

  async function saveSidebarStateForTask(task: AgentTaskView, patch: SidebarTaskPatch) {
    await enqueueSidebarIntent({
      id: nextAgentSidebarMutationId(),
      kind: "task-patch",
      sessionKey: task.sessionKey,
      patch: {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        ...(patch.archived === undefined ? {} : { archived: patch.archived }),
        ...(patch.tags === undefined ? {} : { tags: patch.tags })
      }
    });
  }

  async function saveSidebarView(patch: {
    sort?: typeof state.agent.sidebarState.view.sort;
    showArchived?: boolean;
    showProjectArchived?: boolean;
    showPreviews?: boolean;
  }) {
    await enqueueSidebarIntent({
      id: nextAgentSidebarMutationId(),
      kind: "view-patch",
      patch: {
        ...(patch.sort ? { sort: patch.sort } : {}),
        ...(patch.showArchived == null ? {} : { show_archived: patch.showArchived }),
        ...(patch.showProjectArchived == null ? {} : { show_project_archived: patch.showProjectArchived }),
        ...(patch.showPreviews == null ? {} : { show_previews: patch.showPreviews })
      }
    });
  }

  async function enqueueSidebarIntent(intent: SidebarIntent): Promise<void> {
    try {
      await taskStateCoordinator.enqueueSidebarIntent(intent);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!(error instanceof Error) || error.message !== "sidebar_sync_pending") return;
      dispatch(agentActions.operationFailed("sidebar", createAgentOperationError({
        source: "sidebar",
        message: "sidebar_sync_pending"
      })));
    }
  }

  function toggleSidebarGroup(key: string) {
    void enqueueSidebarIntent({
      id: nextAgentSidebarMutationId(),
      kind: "set-collapsed",
      groupKey: key,
      collapsed: !state.agent.sidebarState.collapsed_groups[key]
    });
  }

  function expandTaskAncestors(task: AgentTaskView) {
    for (const key of resolveTaskAncestorGroupKeys(task, state.agent.projects, showingArchived)) {
      if (!state.agent.sidebarState.collapsed_groups[key]) continue;
      void enqueueSidebarIntent({
        id: nextAgentSidebarMutationId(),
        kind: "set-collapsed",
        groupKey: key,
        collapsed: false
      });
    }
  }

  function selectSidebarWorkspace(projectId: string) {
    setProjectCreateMenuAnchor(null);
    openNewAgent({ kind: "project", projectId });
  }

  async function registerProject(mode: "blank" | "existing") {
    setProjectCreateMenuAnchor(null);
    if (!clients?.memmyAgent || !window.memmy || projectMutationId) return;
    const operationId = `project-create-${crypto.randomUUID()}`;
    setProjectMutationId(operationId);
    try {
      const selected = mode === "blank"
        ? await window.memmy.selectEmptyProjectDirectory()
        : await window.memmy.selectProjectDirectory();
      if (selected.canceled) return;
      const result = await taskStateCoordinator.mutateProject({
        kind: "create",
        input: { mode, path: selected.path }
      });
      if (result.status !== "committed") {
        showProjectOperationError(result.status === "rejected" ? result.code : "network_unavailable");
        return;
      }
      if (result.project) {
        openNewAgent({ kind: "project", projectId: result.project.id });
      } else {
        openNewAgent({ kind: "standalone" });
      }
    } catch (error) {
      showProjectOperationError(error);
      void refreshAgentTasks();
    } finally {
      setProjectMutationId((current) => current === operationId ? null : current);
    }
  }

  async function updateProject(
    projectId: string,
    update: { name: string } | { pinned: boolean }
  ): Promise<boolean> {
    if (!clients?.memmyAgent || projectMutationId) return false;
    const operationId = `project-update-${crypto.randomUUID()}`;
    setProjectMutationId(operationId);
    try {
      const result = await taskStateCoordinator.mutateProject({
        kind: "update",
        projectId,
        update
      });
      if (result.status !== "committed") {
        showProjectOperationError(result.status === "rejected" ? result.code : "network_unavailable");
        return false;
      }
      return true;
    } catch (error) {
      showProjectOperationError(error);
      void refreshAgentTasks();
      return false;
    } finally {
      setProjectMutationId((current) => current === operationId ? null : current);
    }
  }

  async function revealProject(projectId: string) {
    if (!clients?.memmyAgent || projectMutationId) return;
    const operationId = `project-reveal-${crypto.randomUUID()}`;
    setProjectMutationId(operationId);
    try {
      await clients.memmyAgent.revealProject(projectId, { timeoutMs: 15_000 });
    } catch (error) {
      showProjectOperationError(error);
    } finally {
      setProjectMutationId((current) => current === operationId ? null : current);
    }
  }

  async function archiveProjectTasks(projectId: string) {
    const keys = state.agent.tasks
      .filter((task) => task.projectId === projectId && !task.archived)
      .map((task) => task.sessionKey);
    if (!keys.length) return;
    await enqueueSidebarIntent({
      id: nextAgentSidebarMutationId(),
      kind: "batch-archive",
      sessionKeys: keys
    });
    setArchiveProjectId(null);
  }

  function markProjectTasksRead(projectId: string) {
    const keys = state.agent.tasks
      .filter((task) => task.projectId === projectId)
      .map((task) => task.chatId);
    dispatch(agentActions.tasksMarkedRead(keys));
  }

  function workspaceProjectIds(): string[] {
    return Array.from(new Set([
      ...visibleProjectTree.projects.map((node) => node.project.id),
      ...visibleProjectTree.pinnedProjects.map((node) => node.project.id)
    ]));
  }

  function setAllWorkspaceProjectsCollapsed(collapsed: boolean) {
    for (const projectId of workspaceProjectIds()) {
      const groupKey = `project:${projectId}`;
      if (Boolean(state.agent.sidebarState.collapsed_groups[groupKey]) === collapsed) {
        continue;
      }
      void enqueueSidebarIntent({
        id: nextAgentSidebarMutationId(),
        kind: "set-collapsed",
        groupKey,
        collapsed
      });
    }
  }

  function markAllTasksRead() {
    const keys = state.agent.tasks.map((task) => task.chatId);
    if (!keys.length) {
      return;
    }
    dispatch(agentActions.tasksMarkedRead(keys));
  }

  async function confirmRemoveProject() {
    const projectId = removeProjectId;
    if (!projectId || !clients?.memmyAgent || projectMutationId) return;
    const operationId = `project-delete-${crypto.randomUUID()}`;
    setProjectMutationId(operationId);
    try {
      const result = await taskStateCoordinator.mutateProject({
        kind: "delete",
        projectId
      });
      if (result.status !== "committed") {
        showProjectOperationError(result.status === "rejected" ? result.code : "network_unavailable");
        return;
      }
      taskBus.removeTasksBySessionIds(result.deletedSessionKeys.flatMap((key) => [
        key,
        clients.memmyAgent.sessionKeyToChatId(key)
      ]));
      setRemoveProjectId(null);
    } catch (error) {
      showProjectOperationError(error);
      void refreshAgentTasks();
    } finally {
      setProjectMutationId((current) => current === operationId ? null : current);
    }
  }

  function showProjectOperationError(error: unknown) {
    const code = typeof error === "string"
      ? error
      : error instanceof MemmyAgentRequestError
        ? error.code
        : null;
    dispatch(agentActions.operationFailed("sidebar", createAgentOperationError({
      source: "sidebar",
      message: code ?? "project_operation_failed"
    })));
  }

  function openProjectMenu(event: MouseEvent, projectId: string) {
    event.preventDefault();
    event.stopPropagation();
    setTaskListMenuAnchor(null);
    setSortMenuOpen(false);
    setProjectCreateMenuAnchor(null);
    setTaskContextMenu(null);
    cancelInlineRename();
    const target = event.currentTarget;
    const fromActionButton = event.type === "click"
      && target instanceof HTMLElement
      && target.classList.contains("task-icon-button");
    if (fromActionButton) {
      const buttonRect = target.getBoundingClientRect();
      setProjectContextMenu({
        projectId,
        placement: {
          kind: "anchor",
          // Left edge lines up with the … button.
          anchor: {
            left: buttonRect.left,
            right: buttonRect.right,
            bottom: buttonRect.bottom
          }
        }
      });
      return;
    }
    setProjectContextMenu({
      projectId,
      placement: { kind: "point", x: event.clientX, y: event.clientY }
    });
  }

  function beginTaskRename(task: AgentTaskView) {
    if (task.archived) {
      return;
    }
    setTaskListMenuAnchor(null);
    setTaskContextMenu(null);
    setProjectContextMenu(null);
    setArchiveConfirmSessionKey(null);
    setInlineRename({ sessionKey: task.sessionKey, original: task.title });
    setInlineRenameDraft(task.title);
  }

  function cancelInlineRename() {
    setInlineRename(null);
    setInlineRenameDraft("");
  }

  function commitInlineRename() {
    const target = inlineRename;
    const nextValue = inlineRenameDraft.trim();
    if (!target) {
      return;
    }
    if (!nextValue || nextValue === target.original) {
      cancelInlineRename();
      return;
    }
    cancelInlineRename();
    const task = state.agent.tasks.find((item) => item.sessionKey === target.sessionKey);
    if (task) {
      void renameTask(task, nextValue);
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
      dispatch(agentActions.operationFailed("sidebar", createAgentOperationError({
        source: "sidebar",
        message: error instanceof Error ? error.message : String(error)
      })));
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

  function cancelArchiveConfirm() {
    setArchiveConfirmSessionKey(null);
  }

  function archiveTask(task: AgentTaskView) {
    setArchiveConfirmSessionKey(null);
    track({ name: "task_archived", params: { page_path: state.navigation.currentPath }, consentTier: "basic" });
    void saveSidebarStateForTask(task, { archived: true });
  }

  function unarchiveTask(task: AgentTaskView) {
    setArchiveConfirmSessionKey(null);
    void saveSidebarStateForTask(task, { archived: false });
  }

  function toggleTaskListMenu(anchor: SidebarMenuAnchor) {
    setProjectCreateMenuAnchor(null);
    setTaskContextMenu(null);
    setProjectContextMenu(null);
    setArchiveConfirmSessionKey(null);
    setTaskListMenuAnchor((value) => (value ? null : anchor));
    setSortMenuOpen(false);
  }

  function openTaskContextMenu(event: MouseEvent, task: AgentTaskView) {
    event.preventDefault();
    setTaskListMenuAnchor(null);
    setSortMenuOpen(false);
    setArchiveConfirmSessionKey(null);
    cancelInlineRename();
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
      dispatch(agentActions.operationFailed("sidebar", createAgentOperationError({
        source: "sidebar",
        message: error instanceof Error ? error.message : String(error)
      })));
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

        {props.settingsNav ? (
          <>
            <div className="memory-page-return-row">
              <button
                type="button"
                aria-label={t("settings.leave")}
                title={t("settings.leave")}
                onClick={openSettingsFromSidebar}
                className="memory-page-back-button"
              >
                <ArrowLeft size={16} />
                <span>{t("settings.leave")}</span>
              </button>
            </div>
            <div className="app-frame-settings-nav flex-1 min-h-0 pb-4 overflow-y-auto" aria-label={t("settings.title")}>
              <nav className="space-y-1" aria-label={t("settings.title")}>
                {SETTINGS_NAV_ITEMS.map((item) => {
                  const active = props.settingsNav?.activeTab === item.id;
                  const icon = item.id === "account"
                    ? <User size={16} />
                    : item.id === "model"
                      ? <BrainCircuit size={16} />
                      : item.id === "tokens"
                        ? <BarChart3 size={16} />
                        : item.id === "preferences"
                          ? <Wand2 size={16} />
                          : <Info size={16} />;
                  return (
                    <div key={item.id}>
                      <button
                        type="button"
                        id={`settings-tab-${item.id}`}
                        aria-current={active ? "page" : undefined}
                        className={`app-frame-nav-button relative flex items-center gap-2.5 px-3 py-2 transition-all cursor-pointer ${
                          active
                            ? "app-frame-nav-button--active"
                            : "text-text-ink/75 hover:bg-canvas-oat/60 hover:text-text-ink/85"
                        }`}
                        onClick={() => props.settingsNav?.onSelectTab(item.id)}
                      >
                        <span className="shrink-0">{icon}</span>
                        <span className="flex-1 text-left">{t(item.labelKey)}</span>
                      </button>
                    </div>
                  );
                })}
              </nav>
            </div>
          </>
        ) : (
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
                className={`app-frame-nav-button relative flex items-center gap-2 transition-all cursor-pointer ${
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
        )}

        {props.settingsNav ? null : (
        <div ref={taskScrollRef} className={`app-frame-task-scroll flex-1 overflow-y-auto${taskScrollFade ? " app-frame-task-scroll--faded" : ""}`}>
          <div className="app-frame-task-list">
            <div className="app-frame-task-list-header">
              <span className="app-frame-task-list-header__title">{t("appFrame.taskList.title")}</span>
              <div className="app-frame-task-list-header__actions">
                <button
                  type="button"
                  aria-label={t("appFrame.taskList.actions")}
                  title={t("appFrame.taskList.actions")}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleTaskListMenu(sidebarMenuAnchorFromRect(event.currentTarget.getBoundingClientRect()));
                  }}
                  className={`app-frame-task-section-action${showingArchived ? " is-active" : ""}`}
                >
                  <ListFilter size={14} />
                </button>
                {taskListMenuAnchor ? (
                  <TaskListActionsMenu
                    anchor={taskListMenuAnchor}
                    showPreviews={state.agent.sidebarState.view.show_previews}
                    showArchived={showingArchived}
                    sort={state.agent.sidebarState.view.sort}
                    sortMenuOpen={sortMenuOpen}
                    onTogglePreviews={() => {
                      setTaskListMenuAnchor(null);
                      void saveSidebarView({ showPreviews: !state.agent.sidebarState.view.show_previews });
                    }}
                    onToggleSortMenu={() => setSortMenuOpen((value) => !value)}
                    onSelectSort={(sort) => {
                      setTaskListMenuAnchor(null);
                      setSortMenuOpen(false);
                      void saveSidebarView({ sort });
                    }}
                    onMarkAllRead={() => {
                      setTaskListMenuAnchor(null);
                      markAllTasksRead();
                    }}
                    onRefresh={() => {
                      setTaskListMenuAnchor(null);
                      void refreshAgentTasks();
                    }}
                    onToggleArchived={() => {
                      setTaskListMenuAnchor(null);
                      void saveSidebarView({ showProjectArchived: !showingArchived, showArchived: !showingArchived });
                    }}
                    onCollapseAll={() => {
                      setTaskListMenuAnchor(null);
                      setAllWorkspaceProjectsCollapsed(true);
                    }}
                    onExpandAll={() => {
                      setTaskListMenuAnchor(null);
                      setAllWorkspaceProjectsCollapsed(false);
                    }}
                  />
                ) : null}
              </div>
            </div>
            <div className="app-frame-task-list__body space-y-3">
            {visibleProjectTree.pinnedTasks.length > 0 || visibleProjectTree.pinnedProjects.length > 0 ? (
              <ProjectTreeSection
                title={t("common.pin")}
                groupKey="pinned"
                collapsedGroups={state.agent.sidebarState.collapsed_groups}
                projects={visibleProjectTree.pinnedProjects}
                tasks={visibleProjectTree.pinnedTasks}
                currentSessionKey={highlightedSessionKey}
                selectedProjectId={selectedSidebarProjectId}
                showPreviews={state.agent.sidebarState.view.show_previews}
                projectRegistryState={state.agent.projectRegistryState}
                onToggleGroup={toggleSidebarGroup}
                onToggleProject={toggleSidebarGroup}
                onOpenTask={openAgentTask}
                onRenameTask={beginTaskRename}
                renamingSessionKey={inlineRename?.sessionKey ?? null}
                renameDraft={inlineRenameDraft}
                onRenameDraftChange={setInlineRenameDraft}
                onCommitRename={commitInlineRename}
                onCancelRename={cancelInlineRename}
                onTaskContextMenu={openTaskContextMenu}
                onPinTask={pinTask}
                archiveConfirmSessionKey={archiveConfirmSessionKey}
                onRequestArchiveTask={requestArchiveTask}
                onConfirmArchiveTask={archiveTask}
                onCancelArchiveConfirm={cancelArchiveConfirm}
                onUnarchiveTask={unarchiveTask}
                onDeleteArchivedTask={requestDeleteArchivedTask}
                onProjectContextMenu={openProjectMenu}
                onNewProjectTask={(projectId) => openNewAgent({ kind: "project", projectId })}
              />
            ) : null}

            <ProjectTreeSection
              title={t("appFrame.projects")}
              showingArchived={showingArchived}
              groupKey="projects"
              collapsedGroups={state.agent.sidebarState.collapsed_groups}
              projects={visibleProjectTree.projects}
              tasks={[]}
              currentSessionKey={highlightedSessionKey}
              selectedProjectId={selectedSidebarProjectId}
              showPreviews={state.agent.sidebarState.view.show_previews}
              projectRegistryState={state.agent.projectRegistryState}
              emptyText={state.agent.projectRegistryState === "corrupt"
                ? t("appFrame.project.registryUnavailable")
                : t("appFrame.project.empty")}
              onToggleGroup={toggleSidebarGroup}
              onToggleProject={toggleSidebarGroup}
              onOpenTask={openAgentTask}
              onRenameTask={beginTaskRename}
              renamingSessionKey={inlineRename?.sessionKey ?? null}
              renameDraft={inlineRenameDraft}
              onRenameDraftChange={setInlineRenameDraft}
              onCommitRename={commitInlineRename}
              onCancelRename={cancelInlineRename}
              onTaskContextMenu={openTaskContextMenu}
              onPinTask={pinTask}
              archiveConfirmSessionKey={archiveConfirmSessionKey}
              onRequestArchiveTask={requestArchiveTask}
              onConfirmArchiveTask={archiveTask}
              onCancelArchiveConfirm={cancelArchiveConfirm}
              onUnarchiveTask={unarchiveTask}
              onDeleteArchivedTask={requestDeleteArchivedTask}
              onProjectContextMenu={openProjectMenu}
              onNewProjectTask={(projectId) => openNewAgent({ kind: "project", projectId })}
              headerLeadingAction={(
                <div className="relative flex items-center">
                  <button
                    type="button"
                    className={`app-frame-workspace-add${projectCreateMenuAnchor ? " is-open" : ""}`}
                    aria-label={t("appFrame.project.add")}
                    title={t("appFrame.project.add")}
                    disabled={state.agent.projectRegistryState === "corrupt" || projectMutationId != null}
                    onClick={(event) => {
                      event.stopPropagation();
                      setTaskListMenuAnchor(null);
                      setSortMenuOpen(false);
                      const anchor = sidebarMenuAnchorFromRect(event.currentTarget.getBoundingClientRect());
                      setProjectCreateMenuAnchor((current) => (current ? null : anchor));
                    }}
                  >
                    <FolderPlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  {projectCreateMenuAnchor ? (
                    <SidebarWorkspacePickerMenu
                      anchor={projectCreateMenuAnchor}
                      projects={state.agent.projects}
                      registryState={state.agent.projectRegistryState}
                      onSelectProject={selectSidebarWorkspace}
                      onOpenLocalFolder={() => void registerProject("existing")}
                    />
                  ) : null}
                </div>
              )}
            />

            <ProjectTreeSection
              title={t("appFrame.tasks")}
              showingArchived={showingArchived}
              groupKey="standalone"
              collapsedGroups={state.agent.sidebarState.collapsed_groups}
              projects={[]}
              tasks={visibleProjectTree.standaloneTasks}
              currentSessionKey={highlightedSessionKey}
              selectedProjectId={selectedSidebarProjectId}
              showPreviews={state.agent.sidebarState.view.show_previews}
              projectRegistryState={state.agent.projectRegistryState}
              emptyText={state.agent.isLoadingSessions
                ? t("appFrame.taskList.loading")
                : t(showingArchived ? "appFrame.taskList.emptyArchived" as MessageKey : "appFrame.taskList.empty")}
              onToggleGroup={toggleSidebarGroup}
              onToggleProject={toggleSidebarGroup}
              onOpenTask={openAgentTask}
              onRenameTask={beginTaskRename}
              renamingSessionKey={inlineRename?.sessionKey ?? null}
              renameDraft={inlineRenameDraft}
              onRenameDraftChange={setInlineRenameDraft}
              onCommitRename={commitInlineRename}
              onCancelRename={cancelInlineRename}
              onTaskContextMenu={openTaskContextMenu}
              onPinTask={pinTask}
              archiveConfirmSessionKey={archiveConfirmSessionKey}
              onRequestArchiveTask={requestArchiveTask}
              onConfirmArchiveTask={archiveTask}
              onCancelArchiveConfirm={cancelArchiveConfirm}
              onUnarchiveTask={unarchiveTask}
              onDeleteArchivedTask={requestDeleteArchivedTask}
              onProjectContextMenu={openProjectMenu}
              onNewProjectTask={(projectId) => openNewAgent({ kind: "project", projectId })}
              headerAction={(
                <div className="app-frame-task-section-header__actions-inner">
                  <button
                    type="button"
                    className="app-frame-task-section-action"
                    aria-label={t("appFrame.task.newStandalone")}
                    title={t("appFrame.task.newStandalone")}
                    onClick={(event) => {
                      event.stopPropagation();
                      openNewAgent({ kind: "standalone" });
                    }}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              )}
            />
            </div>
          </div>
          {taskContextMenu && (
            <TaskContextMenu
              menu={taskContextMenu}
              onRename={beginTaskRename}
              onPinTask={pinTask}
              onArchiveTask={requestArchiveTask}
              onUnarchiveTask={unarchiveTask}
              onDeleteArchivedTask={requestDeleteArchivedTask}
              onClose={() => setTaskContextMenu(null)}
            />
          )}
          {projectContextMenu ? (
            <ProjectContextMenu
              menu={projectContextMenu}
              project={state.agent.projects.find((project) => project.id === projectContextMenu.projectId) ?? null}
              archiveTaskCount={countProjectTasksToArchive(state.agent.tasks, projectContextMenu.projectId)}
              onClose={() => setProjectContextMenu(null)}
              onPin={(project) => {
                setProjectContextMenu(null);
                void updateProject(project.id, { pinned: !project.pinned });
              }}
              onReveal={(project) => {
                setProjectContextMenu(null);
                void revealProject(project.id);
              }}
              onMarkRead={(project) => {
                setProjectContextMenu(null);
                markProjectTasksRead(project.id);
              }}
              onArchive={(project) => {
                setProjectContextMenu(null);
                setArchiveProjectId(project.id);
              }}
              onRemove={(project) => {
                setProjectContextMenu(null);
                setRemoveProjectId(project.id);
              }}
            />
          ) : null}
        </div>
        )}

        {props.settingsNav ? null : sidebarUpdateAction ? (
          <div className="app-frame-sidebar-footer app-frame-sidebar-footer--compound">
            <button
              type="button"
              onClick={openSettingsFromSidebar}
              title={t("settings.title")}
              aria-label={t("settings.title")}
              className="app-frame-sidebar-footer--button app-frame-sidebar-footer-account"
            >
              <span className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5">
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
              </span>
            </button>
            <button
              type="button"
              className={`app-frame-sidebar-update-button app-frame-sidebar-update-button--${sidebarUpdateAction.kind}`}
              aria-label={sidebarUpdateAction.ariaLabel}
              title={sidebarUpdateAction.title}
              disabled={sidebarUpdateAction.disabled}
              aria-live="polite"
              onClick={(event) => {
                event.stopPropagation();
                void update?.requestInlineAction();
              }}
            >
              {renderSidebarUpdateActionIcon(sidebarUpdateAction.kind)}
              <span className="app-frame-sidebar-update-button__label">{sidebarUpdateAction.label}</span>
            </button>
            <button
              type="button"
              onClick={openSettingsFromSidebar}
              title={t("settings.title")}
              aria-label={t("settings.title")}
              className={`app-frame-profile-settings app-frame-profile-settings-button shrink-0 inline-flex items-center justify-center transition-colors ${
                state.navigation.currentPath === "/settings"
                  ? "app-frame-profile-settings--active text-action-sky"
                  : "text-text-ink/45"
              }`}
            >
              <Settings2 size={14} />
            </button>
          </div>
        ) : (
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
        )}
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
          data-tour-anchor={PRODUCT_TOUR_CHAT_CONTENT_ANCHOR}
          className={`min-h-0 h-full flex-1 overflow-hidden${
            sidebarHidden && !props.topBarBorder ? " app-frame-content-body--sidebar-hidden" : ""
          }`}
          style={props.topBarBorder ? { paddingTop: "var(--codex-toolbar-height)" } : undefined}
        >
          {props.children}
        </div>
      </main>
      <ConfirmDialog
        open={removeProject != null}
        title={t("appFrame.project.remove")}
        message={removeProject ? t("appFrame.project.removeConfirm", {
          name: removeProject.name,
          count: removeProjectTaskCount
        }) : ""}
        cancelLabel={t("dialog.cancel")}
        closeLabel={t("common.close")}
        confirmLabel={t("common.remove")}
        confirmDisabled={projectMutationId != null}
        confirmVariant="danger"
        onCancel={() => {
          if (projectMutationId == null) {
            setRemoveProjectId(null);
          }
        }}
        onConfirm={() => void confirmRemoveProject()}
      />
      <ConfirmDialog
        open={archiveProject != null}
        title={t("appFrame.project.archiveTasks")}
        message={archiveProject ? t("appFrame.project.archiveConfirm", {
          name: archiveProject.name,
          count: archiveProjectTaskCount
        }) : ""}
        cancelLabel={t("dialog.cancel")}
        closeLabel={t("common.close")}
        confirmLabel={t("common.confirm")}
        onCancel={() => setArchiveProjectId(null)}
        onConfirm={() => {
          if (archiveProject) void archiveProjectTasks(archiveProject.id);
        }}
      />
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
      {deferredGuidanceStep === "improvement" && state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset" && (
        <ImprovementProgramModal
          onChoice={chooseDeferredImprovementProgram}
          onLearnMore={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}
          showGift={
            state.bootstrap?.promotions?.improvementGift === true
            && (state.bootstrap?.promotions?.improvementGiftRewardTokens ?? 0) > 0
          }
          giftTokens={state.bootstrap?.promotions?.improvementGiftRewardTokens ?? 0}
        />
      )}
      <SearchPalette
        open={searchPaletteOpen}
        tasks={state.agent.tasks}
        projects={state.agent.projects}
        projectRegistryState={state.agent.projectRegistryState}
        standaloneLabel={t("appFrame.tasks")}
        missingProjectLabel={t("appFrame.project.recordUnavailable")}
        registryUnavailableLabel={t("appFrame.project.taskRegistryUnavailable")}
        placeholder={t("appFrame.search")}
        emptyLabel={t("appFrame.search.empty")}
        untitledLabel={t("appFrame.search.untitled")}
        ariaLabel={t("appFrame.search")}
        onClose={() => setSearchPaletteOpen(false)}
        onSelectTask={(task) => {
          setSearchPaletteOpen(false);
          expandTaskAncestors(task);
          void openAgentTask(task);
        }}
      />
    </div>
  );
}

let agentHistoryRequestCounter = 0;
let agentSidebarMutationCounter = 0;

function nextAgentHistoryRequestId(chatId: string): string {
  agentHistoryRequestCounter += 1;
  return `${chatId}-${agentHistoryRequestCounter}`;
}

function nextAgentSidebarMutationId(): string {
  agentSidebarMutationCounter += 1;
  return `sidebar-${Date.now()}-${agentSidebarMutationCounter}`;
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
    left: rect.left,
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
 * Left-aligns a menu to a sidebar icon/rail anchor so it stays over the sidebar.
 *
 * @param anchor The icon/button anchor (`left` is the alignment edge).
 * @param viewport The current viewport size.
 * @param size The menu size and margin configuration.
 * @returns The menu's fixed left/top coordinates.
 */
export function resolveSidebarMenuPlacementStart(
  anchor: SidebarMenuAnchor,
  viewport: SidebarMenuViewport,
  size: SidebarMenuSize
): SidebarContextMenuPlacement {
  const maxLeft = Math.max(size.margin, viewport.width - size.width - size.margin);
  const maxTop = Math.max(size.margin, viewport.height - size.height - size.margin);

  return {
    left: clamp(anchor.left, size.margin, maxLeft),
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
 * Keeps a pointer-anchored context menu entirely inside the viewport.
 *
 * @param point The pointer position that opened the menu.
 * @param viewport The current viewport size.
 * @param size The menu size and margin configuration.
 * @returns The menu's fixed left/top coordinates.
 */
export function resolveSidebarContextMenuPlacement(
  point: { x: number; y: number },
  viewport: SidebarMenuViewport,
  size: SidebarMenuSize
): SidebarContextMenuPlacement {
  const maxLeft = Math.max(size.margin, viewport.width - size.width - size.margin);
  const maxTop = Math.max(size.margin, viewport.height - size.height - size.margin);

  return {
    left: clamp(point.x, size.margin, maxLeft),
    top: clamp(point.y + size.gap, size.margin, maxTop)
  };
}

/**
 * Resolves portal styles for a sidebar context menu opened from a button or pointer.
 *
 * @param source Button-anchored or pointer-anchored placement source.
 * @param viewport The current viewport size.
 * @param size The menu size and margin configuration.
 * @returns Fixed positioning styles for the menu portal.
 */
export function resolveSidebarContextMenuOverlayStyle(
  source: SidebarContextMenuPlacementSource,
  viewport: SidebarMenuViewport,
  size: SidebarMenuSize
): CSSProperties {
  if (source.kind === "anchor") {
    return {
      ...resolveSidebarMenuPlacementStart(source.anchor, viewport, size),
      zIndex: sidebarMenuOverlayZIndex
    };
  }

  return {
    ...resolveSidebarContextMenuPlacement(source, viewport, size),
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

export function deriveSidebarPlacement(
  tasks: AgentTaskView[],
  projects: MemmyAgentProject[]
): ProjectSidebarTree {
  const activeTasks = tasks.filter((task) => !task.archived);
  const archivedTasks = tasks.filter((task) => task.archived);
  const unpinnedActiveTasks = activeTasks.filter((task) => !task.pinned);
  const buildNodes = (
    source: AgentTaskView[],
    projectFilter: (project: MemmyAgentProject) => boolean
  ): ProjectSidebarNode[] => projects
    .filter(projectFilter)
    .map((project) => ({
      project,
      tasks: source.filter((task) => task.groupProjectId === project.id)
    }));

  return {
    pinnedTasks: activeTasks.filter((task) => task.pinned),
    pinnedProjects: buildNodes(unpinnedActiveTasks, (project) => project.pinned),
    projects: buildNodes(unpinnedActiveTasks, (project) => !project.pinned),
    standaloneTasks: unpinnedActiveTasks.filter((task) => task.groupProjectId === null),
    archivedProjects: buildNodes(archivedTasks, () => true),
    archivedStandaloneTasks: archivedTasks.filter((task) => task.groupProjectId === null)
  };
}

export const buildProjectSidebarTree = deriveSidebarPlacement;

export function deriveVisibleSidebarPlacement(
  tree: ProjectSidebarTree,
  showingArchived: { projectTasks: boolean; standaloneTasks: boolean }
) {
  return {
    pinnedTasks: tree.pinnedTasks.filter((task) => (
      task.groupProjectId
        ? !showingArchived.projectTasks
        : !showingArchived.standaloneTasks
    )),
    pinnedProjects: showingArchived.projectTasks ? [] : tree.pinnedProjects,
    projects: showingArchived.projectTasks ? tree.archivedProjects : tree.projects,
    standaloneTasks: showingArchived.standaloneTasks
      ? tree.archivedStandaloneTasks
      : tree.standaloneTasks
  };
}

export function countProjectTasksToArchive(
  tasks: AgentTaskView[],
  projectId: string
): number {
  return tasks.filter((task) => task.projectId === projectId && !task.archived).length;
}

export function resolveTaskAncestorGroupKeys(
  task: AgentTaskView,
  projects: MemmyAgentProject[],
  showingArchived: boolean
): string[] {
  if (!showingArchived && task.pinned) {
    return ["pinned"];
  }
  if (task.groupProjectId) {
    const projectKey = `project:${task.groupProjectId}`;
    if (showingArchived) {
      return ["projects", projectKey];
    }
    const project = projects.find((candidate) => candidate.id === task.groupProjectId);
    return [project?.pinned ? "pinned" : "projects", projectKey];
  }
  return ["standalone"];
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

const PROJECT_SIDEBAR_TASK_PREVIEW_LIMIT = 5;

function ProjectTreeSection(props: {
  title: string;
  titleBadge?: string;
  showingArchived?: boolean;
  groupKey: string;
  collapsedGroups: Record<string, boolean>;
  projects: ProjectSidebarNode[];
  tasks: AgentTaskView[];
  currentSessionKey: string | null;
  selectedProjectId: string | null;
  showPreviews: boolean;
  projectRegistryState: "ready" | "corrupt";
  /** Always-visible trailing control (e.g. add workspace), outside the fade group. */
  headerLeadingAction?: ReactNode;
  headerAction?: ReactNode;
  emptyText?: string;
  renamingSessionKey: string | null;
  renameDraft: string;
  onToggleGroup: (key: string) => void;
  onToggleProject: (key: string) => void;
  onOpenTask: (task: AgentTaskView) => Promise<void>;
  onRenameTask: (task: AgentTaskView) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onTaskContextMenu: (event: MouseEvent, task: AgentTaskView) => void;
  onPinTask: (task: AgentTaskView, pinned: boolean) => void;
  archiveConfirmSessionKey: string | null;
  onRequestArchiveTask: (task: AgentTaskView) => void;
  onConfirmArchiveTask: (task: AgentTaskView) => void;
  onCancelArchiveConfirm: () => void;
  onUnarchiveTask: (task: AgentTaskView) => void;
  onDeleteArchivedTask: (task: AgentTaskView) => void;
  onProjectContextMenu: (event: MouseEvent, projectId: string) => void;
  onNewProjectTask: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const [expandedProjectTaskIds, setExpandedProjectTaskIds] = useState<Record<string, boolean>>({});
  const collapsed = Boolean(props.collapsedGroups[props.groupKey]);
  const renderTask = (task: AgentTaskView, nested = false) => (
    <TaskRow
      key={task.sessionKey}
      task={task}
      depth={nested ? 1 : 0}
      isCurrent={props.currentSessionKey === task.sessionKey}
      showPreview={props.showPreviews}
      projectRegistryState={props.projectRegistryState}
      renaming={props.renamingSessionKey === task.sessionKey}
      renameDraft={props.renameDraft}
      onRenameDraftChange={props.onRenameDraftChange}
      onCommitRename={props.onCommitRename}
      onCancelRename={props.onCancelRename}
      onOpen={() => void props.onOpenTask(task)}
      onRename={() => props.onRenameTask(task)}
      onContextMenu={(event) => props.onTaskContextMenu(event, task)}
      onPin={() => props.onPinTask(task, !task.pinned)}
      archiveConfirming={props.archiveConfirmSessionKey === task.sessionKey}
      onRequestArchive={() => props.onRequestArchiveTask(task)}
      onConfirmArchive={() => props.onConfirmArchiveTask(task)}
      onCancelArchive={props.onCancelArchiveConfirm}
      onUnarchive={() => props.onUnarchiveTask(task)}
      onDeleteArchived={() => props.onDeleteArchivedTask(task)}
    />
  );

  return (
    <section className="app-frame-task-section">
      <div
        className="app-frame-task-section-header app-frame-task-section-header--toggle"
        onClick={() => props.onToggleGroup(props.groupKey)}
      >
        <button
          type="button"
          className="app-frame-task-section-header__trigger"
          aria-expanded={!collapsed}
        >
          <span className="app-frame-task-section-header__title min-w-0">
            <span className="truncate">{props.title}</span>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={`app-frame-task-section-header__toggle-icon shrink-0${collapsed ? " is-collapsed" : ""}`}
            />
            {props.titleBadge ? (
              <span className="app-frame-task-section-header__badge">{props.titleBadge}</span>
            ) : null}
          </span>
        </button>
        {props.headerLeadingAction || props.headerAction ? (
          <div
            className="app-frame-task-section-header__trailing"
            onClick={(event) => event.stopPropagation()}
          >
            {props.headerLeadingAction}
            {props.headerAction ? (
              <div className="app-frame-task-section-header__actions">
                {props.headerAction}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={`app-frame-collapsible${collapsed ? " is-collapsed" : ""}`}>
        <div className="app-frame-collapsible__inner">
          <div className="app-frame-task-section-body">
            {props.tasks.map((task) => renderTask(task))}
            {props.projects.map((node) => {
              const projectKey = `project:${node.project.id}`;
              const projectCollapsed = Boolean(props.collapsedGroups[projectKey]);
              const showAllTasks = Boolean(expandedProjectTaskIds[node.project.id]);
              const visibleTasks = node.tasks.length > PROJECT_SIDEBAR_TASK_PREVIEW_LIMIT && !showAllTasks
                ? node.tasks.slice(0, PROJECT_SIDEBAR_TASK_PREVIEW_LIMIT)
                : node.tasks;
              const hiddenTaskCount = node.tasks.length - visibleTasks.length;
              return (
                <div key={node.project.id} className="app-frame-project-node">
                  <ProjectRow
                    project={node.project}
                    collapsed={projectCollapsed}
                    selected={props.selectedProjectId === node.project.id}
                    onToggle={() => props.onToggleProject(projectKey)}
                    onContextMenu={(event) => props.onProjectContextMenu(event, node.project.id)}
                    onNewTask={() => props.onNewProjectTask(node.project.id)}
                  />
                  <div
                    className={`app-frame-collapsible${projectCollapsed ? " is-collapsed" : ""}`}
                    aria-hidden={projectCollapsed || undefined}
                  >
                    <div className="app-frame-collapsible__inner">
                      <div className="app-frame-project-children">
                        {node.tasks.length === 0 ? (
                          <div className="app-frame-task-empty app-frame-task-empty--nested">
                            {props.showingArchived
                              ? t("appFrame.taskList.emptyArchived")
                              : t("appFrame.taskList.empty")}
                          </div>
                        ) : (
                          <>
                            {visibleTasks.map((task) => renderTask(task, true))}
                            {node.tasks.length > PROJECT_SIDEBAR_TASK_PREVIEW_LIMIT ? (
                              <button
                                type="button"
                                className="app-frame-project-show-more"
                                tabIndex={projectCollapsed ? -1 : undefined}
                                onClick={() => setExpandedProjectTaskIds((current) => ({
                                  ...current,
                                  [node.project.id]: !showAllTasks
                                }))}
                              >
                                {showAllTasks
                                  ? t("appFrame.project.showFewerTasks")
                                  : t("appFrame.project.showMoreTasks")}
                                {!showAllTasks && hiddenTaskCount > 0 ? ` · ${hiddenTaskCount}` : ""}
                              </button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {!props.tasks.length && !props.projects.length && props.emptyText ? (
              <div className="app-frame-task-empty">{props.emptyText}</div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function SidebarMarqueeText(props: {
  text: string;
  className?: string;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const label = textRef.current;
    if (!viewport || !label) {
      return;
    }

    const update = () => {
      setDistance(Math.max(0, label.scrollWidth - viewport.clientWidth));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [props.text]);

  const marqueeStyle = {
    "--marquee-distance": `${distance}px`,
    "--marquee-duration": `${Math.min(8, Math.max(2.2, distance / 28))}s`
  } as CSSProperties;

  return (
    <span ref={viewportRef} className={`app-frame-sidebar-marquee${props.className ? ` ${props.className}` : ""}`}>
      <span
        ref={textRef}
        className="app-frame-sidebar-marquee__text"
        style={marqueeStyle}
        data-overflow={distance > 1 ? "true" : undefined}
      >
        {props.text}
      </span>
    </span>
  );
}

function SidebarInlineRenameInput(props: {
  value: string;
  maxLength: number;
  ariaLabel: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelOnBlurRef = useRef(false);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      className="app-frame-sidebar-rename-input"
      value={props.value}
      maxLength={props.maxLength}
      aria-label={props.ariaLabel}
      onChange={(event) => props.onChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          if (isComposingKeyboardEvent(event)) {
            return;
          }
          event.preventDefault();
          cancelOnBlurRef.current = true;
          props.onCommit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelOnBlurRef.current = true;
          props.onCancel();
        }
      }}
      onBlur={() => {
        if (cancelOnBlurRef.current) {
          cancelOnBlurRef.current = false;
          return;
        }
        props.onCommit();
      }}
    />
  );
}

function ProjectRow(props: {
  project: MemmyAgentProject;
  collapsed: boolean;
  selected: boolean;
  onToggle: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onNewTask: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`app-frame-project-row${props.selected ? " app-frame-project-row--selected" : ""}`}
      title={props.project.rootPath}
    >
      <button
        type="button"
        className="app-frame-project-row__main"
        aria-expanded={!props.collapsed}
        aria-label={props.collapsed ? t("appFrame.project.expand") : t("appFrame.project.collapse")}
        onClick={(event) => {
          props.onToggle();
          // Avoid sticky :focus-within fill after mouse expand/collapse.
          event.currentTarget.blur();
        }}
        onContextMenu={props.onContextMenu}
      >
        <span className="app-frame-project-row__folder-stack" aria-hidden="true">
          <Folder
            size={16}
            className={`app-frame-project-row__folder${props.collapsed ? " is-active" : ""}`}
          />
          <FolderOpen
            size={16}
            className={`app-frame-project-row__folder app-frame-project-row__folder--open${!props.collapsed ? " is-active" : ""}`}
          />
          <ChevronRight
            size={16}
            className={`app-frame-project-row__chevron${props.collapsed ? " is-active" : ""}`}
          />
          <ChevronDown
            size={16}
            className={`app-frame-project-row__chevron${!props.collapsed ? " is-active" : ""}`}
          />
        </span>
        <SidebarMarqueeText text={props.project.name} className="app-frame-project-title" />
      </button>
      <div className="app-frame-project-row__actions">
        <TaskIconButton label={t("appFrame.project.newTask")} tooltip={false} onClick={props.onNewTask}>
          <MessageSquarePlus size={14} />
        </TaskIconButton>
        <TaskIconButton
          label={t("appFrame.project.actions")}
          tooltip={false}
          onClick={(event) => props.onContextMenu(event)}
        >
          <MoreHorizontal size={14} />
        </TaskIconButton>
      </div>
    </div>
  );
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
  renamingSessionKey?: string | null;
  renameDraft?: string;
  onRenameDraftChange?: (value: string) => void;
  onCommitRename?: () => void;
  onCancelRename?: () => void;
  onOpenTask: (task: AgentTaskView) => Promise<void>;
  onRenameTask: (task: AgentTaskView) => void;
  onContextMenu: (event: MouseEvent, task: AgentTaskView) => void;
  onPinTask: (task: AgentTaskView, pinned: boolean) => void;
  archiveConfirmSessionKey: string | null;
  onRequestArchiveTask: (task: AgentTaskView) => void;
  onConfirmArchiveTask: (task: AgentTaskView) => void;
  onCancelArchiveConfirm?: () => void;
  onUnarchiveTask: (task: AgentTaskView) => void;
  onDeleteArchivedTask: (task: AgentTaskView) => void;
}) {
  if (!props.tasks.length && !props.emptyText && props.hideWhenEmpty && !props.alwaysShowHeader) {
    return null;
  }

  return (
    <section className="app-frame-task-section">
      <div className="app-frame-task-section-header">
        <div className="app-frame-task-section-header__title">{props.title}</div>
        {props.headerAction ? (
          <div className="app-frame-task-section-header__actions">
            {props.headerAction}
          </div>
        ) : null}
      </div>
      <div className="app-frame-task-section-body">
        {props.tasks.map((task) => (
          <TaskRow
            key={task.sessionKey}
            task={task}
            isCurrent={props.currentSessionKey === task.sessionKey}
            showPreview={props.showPreviews}
            renaming={props.renamingSessionKey === task.sessionKey}
            renameDraft={props.renameDraft ?? ""}
            onRenameDraftChange={props.onRenameDraftChange}
            onCommitRename={props.onCommitRename}
            onCancelRename={props.onCancelRename}
            onOpen={() => void props.onOpenTask(task)}
            onRename={() => props.onRenameTask(task)}
            onContextMenu={(event) => props.onContextMenu(event, task)}
            onPin={() => props.onPinTask(task, !task.pinned)}
            archiveConfirming={props.archiveConfirmSessionKey === task.sessionKey}
            onRequestArchive={() => props.onRequestArchiveTask(task)}
            onConfirmArchive={() => props.onConfirmArchiveTask(task)}
            onCancelArchive={props.onCancelArchiveConfirm}
            onUnarchive={() => props.onUnarchiveTask(task)}
            onDeleteArchived={() => void props.onDeleteArchivedTask(task)}
          />
        ))}
        {!props.tasks.length && props.emptyText ? (
          <div className="app-frame-task-empty">{props.emptyText}</div>
        ) : null}
      </div>
    </section>
  );
}

export function TaskRow(props: {
  task: AgentTaskView;
  isCurrent: boolean;
  showPreview: boolean;
  depth?: 0 | 1;
  projectRegistryState?: "ready" | "corrupt";
  renaming?: boolean;
  renameDraft?: string;
  onRenameDraftChange?: (value: string) => void;
  onCommitRename?: () => void;
  onCancelRename?: () => void;
  onOpen: () => void;
  onRename?: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onPin: () => void;
  archiveConfirming: boolean;
  onRequestArchive: () => void;
  onConfirmArchive: () => void;
  onCancelArchive?: () => void;
  onUnarchive: () => void;
  onDeleteArchived: () => void;
}) {
  const { t } = useTranslation();
  const [isTaskRowHovered, setIsTaskRowHovered] = useState(false);
  const archived = props.task.archived;
  const renaming = Boolean(props.renaming);
  const depth = props.depth ?? 0;
  const hasTaskStatus = props.task.runStartedAt != null || props.task.completedUnseen;
  const imTitleDisplay = imChannelTitleDisplay(props.task.title);
  const projectIssueLabel = props.task.projectId == null || props.task.groupProjectId != null
    ? null
    : props.projectRegistryState === "corrupt"
      ? t("appFrame.project.taskRegistryUnavailable")
      : t("appFrame.project.recordUnavailable");
  const projectIssueTitle = projectIssueLabel ? `${projectIssueLabel} · ${props.task.cwd}` : undefined;
  const showHoverActions = !renaming && (isTaskRowHovered || props.archiveConfirming);
  const showStatusSlot = !showHoverActions && !archived && !renaming && hasTaskStatus;
  const rowClassName = [
    "app-frame-task-row",
    depth === 1 ? "app-frame-task-row--depth-1" : "",
    props.isCurrent ? "app-frame-task-row--current" : "",
    props.archiveConfirming ? "app-frame-task-row--confirming" : "",
    renaming ? "app-frame-task-row--renaming" : "",
    showHoverActions ? "app-frame-task-row--actions-visible" : "",
    showStatusSlot ? "app-frame-task-row--status-visible" : ""
  ].filter(Boolean).join(" ");

  return (
    <div
      className={rowClassName}
      data-current-session={props.isCurrent ? "true" : undefined}
      onContextMenu={renaming ? undefined : props.onContextMenu}
      onMouseEnter={() => setIsTaskRowHovered(true)}
      onMouseLeave={() => setIsTaskRowHovered(false)}
    >
      {renaming ? (
        <div className="app-frame-task-row__main">
          <SidebarInlineRenameInput
            value={props.renameDraft ?? props.task.title}
            maxLength={60}
            ariaLabel={t("appFrame.renameTaskPrompt")}
            onChange={props.onRenameDraftChange ?? (() => undefined)}
            onCommit={props.onCommitRename ?? (() => undefined)}
            onCancel={props.onCancelRename ?? (() => undefined)}
          />
        </div>
      ) : (
        <button
          type="button"
          aria-current={props.isCurrent ? "page" : undefined}
          title={projectIssueTitle}
          onClick={props.onOpen}
          onDoubleClick={(event) => {
            if (archived || !props.onRename) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            props.onRename();
          }}
          className="app-frame-task-row__main"
        >
          {archived ? (
            <span className="app-frame-task-row__title-row">
              <Archive size={14} className="app-frame-task-row__archive-icon" aria-hidden="true" />
              {imTitleDisplay ? <ImChannelTitleIcon slug={imTitleDisplay.slug} name={imTitleDisplay.channelName} /> : null}
              <SidebarMarqueeText text={imTitleDisplay?.title ?? props.task.title} className="app-frame-task-title" />
            </span>
          ) : imTitleDisplay ? (
            <span className="app-frame-task-row__title-row">
              <ImChannelTitleIcon slug={imTitleDisplay.slug} name={imTitleDisplay.channelName} />
              <SidebarMarqueeText text={imTitleDisplay.title} className="app-frame-task-title" />
            </span>
          ) : (
            <SidebarMarqueeText text={props.task.title} className="app-frame-task-title" />
          )}
          {props.showPreview && props.task.preview ? (
            <span className="app-frame-task-preview truncate">{props.task.preview}</span>
          ) : null}
          {projectIssueLabel ? (
            <span className="app-frame-task-preview app-frame-task-preview--error truncate">
              {projectIssueLabel}
            </span>
          ) : null}
        </button>
      )}
      <div className="app-frame-task-row__trail">
        {renaming ? null : archived ? (
          showHoverActions ? (
            <>
              <TaskIconButton label={t("appFrame.task.unarchive")} active onClick={props.onUnarchive}>
                <RotateCcw size={14} />
              </TaskIconButton>
              <TaskIconButton label={t("appFrame.task.deleteArchived")} danger onClick={props.onDeleteArchived}>
                <Trash2 size={14} />
              </TaskIconButton>
            </>
          ) : null
        ) : props.archiveConfirming ? (
          <TaskArchiveInlineAction
            task={props.task}
            confirming={props.archiveConfirming}
            onPin={props.onPin}
            onRequestArchive={props.onRequestArchive}
            onConfirmArchive={props.onConfirmArchive}
            onCancelArchive={props.onCancelArchive ?? (() => undefined)}
          />
        ) : showHoverActions ? (
          <>
            <TaskIconButton label={props.task.pinned ? t("appFrame.task.unpin") : t("appFrame.task.pin")} active={props.task.pinned} onClick={props.onPin}>
              <Pin size={14} />
            </TaskIconButton>
            <TaskIconButton label={t("appFrame.task.archive")} onClick={props.onRequestArchive}>
              <Archive size={14} />
            </TaskIconButton>
          </>
        ) : showStatusSlot ? (
          <TaskStatusIndicator task={props.task} />
        ) : null}
      </div>
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
  onCancelArchive: () => void;
}) {
  const { t } = useTranslation();

  if (props.confirming) {
    return (
      <InlineConfirmButton
        ariaLabel={t("appFrame.task.confirmArchive")}
        label={t("common.confirm")}
        onClick={props.onConfirmArchive}
      />
    );
  }

  return (
    <>
      <TaskIconButton label={props.task.pinned ? t("appFrame.task.unpin") : t("appFrame.task.pin")} active={props.task.pinned} onClick={props.onPin}>
        <Pin size={14} />
      </TaskIconButton>
      <TaskIconButton label={t("appFrame.task.archive")} onClick={props.onRequestArchive}>
        <Archive size={14} />
      </TaskIconButton>
    </>
  );
}

function TaskIconButton(props: {
  label: string;
  active?: boolean;
  danger?: boolean;
  /** Floating tooltip; keep false for self-evident icons revealed on row hover. */
  tooltip?: boolean;
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const colorClass = props.danger
    ? "text-text-ink/40 hover:text-status-error"
    : props.active
      ? "text-action-sky hover:text-action-sky-hover"
      : "text-text-ink/40 hover:text-text-ink/70";

  const button = (
    <button
      type="button"
      aria-label={props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick(event);
      }}
      className={`task-icon-button w-6 h-6 inline-flex items-center justify-center rounded-input text-center leading-none hover:bg-background-paper/80 transition-colors cursor-pointer ${colorClass}`}
    >
      {props.children}
    </button>
  );

  if (props.tooltip === false) {
    return button;
  }

  return <Tooltip content={props.label}>{button}</Tooltip>;
}

function InlineConfirmButton(props: {
  ariaLabel: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className="app-frame-task-confirm"
    >
      {props.label}
    </button>
  );
}

function formatSidebarWorkspacePath(rootPath: string): string {
  return rootPath
    .replace(/\\/g, "/")
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
}

function formatSidebarCompactWorkspacePath(rootPath: string, maxWidth = 28): string {
  const displayPath = formatSidebarWorkspacePath(rootPath).replace(/\/+$/, "");
  if (displayPath.length <= maxWidth) return displayPath;
  const folder = displayPath.split("/").filter(Boolean).pop() ?? displayPath;
  const prefix = displayPath.slice(0, Math.max(4, maxWidth - folder.length - 4));
  return `${prefix}.../${folder}`;
}

function filterSidebarWorkspaceProjects(projects: MemmyAgentProject[], query: string): MemmyAgentProject[] {
  const normalized = query.trim().toLocaleLowerCase();
  const sorted = [...projects].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  );
  if (!normalized) return sorted;
  return sorted.filter((project) => {
    const displayPath = formatSidebarWorkspacePath(project.rootPath).toLocaleLowerCase();
    return project.name.toLocaleLowerCase().includes(normalized)
      || project.rootPath.toLocaleLowerCase().includes(normalized)
      || displayPath.includes(normalized);
  });
}

function SidebarWorkspacePickerMenu(props: {
  anchor: SidebarMenuAnchor;
  projects: MemmyAgentProject[];
  registryState: "ready" | "corrupt";
  onSelectProject: (projectId: string) => void;
  onOpenLocalFolder: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const visibleProjects = props.registryState === "ready"
    ? filterSidebarWorkspaceProjects(props.projects, query)
    : [];

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }

  const overlayStyle = resolveSidebarContextMenuOverlayStyle(
    { kind: "anchor", anchor: props.anchor },
    { width: window.innerWidth, height: window.innerHeight },
    projectCreateMenuSize
  );
  const menu = (
    <div
      className="home-project-picker__menu app-frame-workspace-picker-menu"
      style={overlayStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <label className="home-project-picker__search">
        <input
          ref={searchInputRef}
          value={query}
          placeholder={t("home.project.search")}
          aria-label={t("home.project.search")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        />
      </label>
      <div className="home-project-picker__list" role="listbox">
        <div className="home-project-picker__projects" role="presentation">
          {props.registryState === "corrupt" ? (
            <p className="home-project-picker__empty">{t("home.project.registryUnavailable")}</p>
          ) : visibleProjects.length === 0 ? (
            <p className="home-project-picker__empty" role="status">{t("home.project.empty")}</p>
          ) : visibleProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="option"
              aria-selected="false"
              className="home-project-picker__option"
              title={formatSidebarWorkspacePath(project.rootPath)}
              onClick={() => props.onSelectProject(project.id)}
            >
              <Folder size={13} className="shrink-0" aria-hidden="true" />
              <span className="home-project-picker__path truncate">
                {formatSidebarCompactWorkspacePath(project.rootPath)}
              </span>
            </button>
          ))}
        </div>
        {props.registryState === "ready" ? (
          <>
            <div className="home-project-picker__divider" role="separator" />
            <div className="home-project-picker__actions" role="presentation">
              <button
                type="button"
                role="option"
                aria-selected="false"
                className="home-project-picker__option home-project-picker__option--action"
                onClick={props.onOpenLocalFolder}
              >
                <Plus size={13} strokeWidth={1.75} className="shrink-0 home-project-picker__action-icon" aria-hidden="true" />
                <span>{t("home.project.new")}</span>
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}

function TaskListActionsMenu(props: {
  anchor: SidebarMenuAnchor;
  showPreviews: boolean;
  showArchived: boolean;
  sort: AgentTaskSort;
  sortMenuOpen: boolean;
  onTogglePreviews: () => void;
  onToggleSortMenu: () => void;
  onSelectSort: (sort: AgentTaskSort) => void;
  onMarkAllRead: () => void;
  onRefresh: () => void;
  onToggleArchived: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  const { t } = useTranslation();

  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }

  const overlayStyle = resolveSidebarContextMenuOverlayStyle(
    { kind: "anchor", anchor: props.anchor },
    { width: window.innerWidth, height: window.innerHeight },
    taskListActionsMenuSize
  );
  const menu = (
    <div
      className="app-frame-sidebar-menu app-frame-sidebar-menu--task-list"
      style={overlayStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <MenuButton
        icon={props.showArchived ? <Check size={13} /> : <Archive size={13} />}
        label={t("appFrame.project.showArchived")}
        active={props.showArchived}
        onClick={props.onToggleArchived}
      />
      <MenuButton
        icon={<ListChecks size={13} />}
        label={props.showPreviews ? t("appFrame.task.hidePreview") : t("appFrame.task.preview")}
        onClick={props.onTogglePreviews}
      />
      <div className="relative">
        <MenuButton icon={<LayoutList size={13} />} label={t("appFrame.task.sort")} onClick={props.onToggleSortMenu} />
        {props.sortMenuOpen && (
          <div className="app-frame-sidebar-menu app-frame-sidebar-menu--nested app-frame-sidebar-menu--sm">
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
      <div className="app-frame-sidebar-menu__divider" role="separator" />
      <MenuButton
        icon={<CheckCheck size={13} />}
        label={t("appFrame.project.markAllRead")}
        onClick={props.onMarkAllRead}
      />
      <MenuButton
        icon={<RefreshCw size={13} />}
        label={t("appFrame.task.refresh")}
        onClick={props.onRefresh}
      />
      <div className="app-frame-sidebar-menu__divider" role="separator" />
      <MenuButton
        icon={<ChevronsDownUp size={13} />}
        label={t("appFrame.project.collapseAll")}
        onClick={props.onCollapseAll}
      />
      <MenuButton
        icon={<ChevronsUpDown size={13} />}
        label={t("appFrame.project.expandAll")}
        onClick={props.onExpandAll}
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
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  const overlayStyle = resolveSidebarContextMenuOverlayStyle(
    { kind: "point", x: props.menu.x, y: props.menu.y },
    { width: window.innerWidth, height: window.innerHeight },
    taskContextMenuSize
  );
  const menu = (
    <div
      className="app-frame-sidebar-menu app-frame-sidebar-menu--md"
      style={overlayStyle}
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
  return createPortal(menu, document.body);
}

function ProjectContextMenu(props: {
  menu: ProjectContextMenuState;
  project: MemmyAgentProject | null;
  archiveTaskCount: number;
  onPin: (project: MemmyAgentProject) => void;
  onReveal: (project: MemmyAgentProject) => void;
  onMarkRead: (project: MemmyAgentProject) => void;
  onArchive: (project: MemmyAgentProject) => void;
  onRemove: (project: MemmyAgentProject) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const project = props.project;
  if (!project) return null;
  const run = (action: () => void) => {
    action();
    props.onClose();
  };
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  const overlayStyle = resolveSidebarContextMenuOverlayStyle(
    props.menu.placement,
    { width: window.innerWidth, height: window.innerHeight },
    projectContextMenuSize
  );
  const menu = (
    <div
      className="app-frame-sidebar-menu app-frame-sidebar-menu--project"
      style={overlayStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <MenuButton
        icon={<Pin size={13} />}
        label={project.pinned ? t("appFrame.project.unpin") : t("appFrame.project.pin")}
        onClick={() => run(() => props.onPin(project))}
      />
      <MenuButton
        icon={<Folder size={13} />}
        label={t("appFrame.project.reveal")}
        onClick={() => run(() => props.onReveal(project))}
      />
      <MenuButton
        icon={<CheckCheck size={13} />}
        label={t("appFrame.project.markRead")}
        onClick={() => run(() => props.onMarkRead(project))}
      />
      <MenuButton
        icon={<Archive size={13} />}
        label={t("appFrame.project.archiveTasks")}
        disabled={props.archiveTaskCount === 0}
        onClick={() => run(() => props.onArchive(project))}
      />
      <MenuButton
        icon={<Trash2 size={13} />}
        label={t("appFrame.project.remove")}
        danger
        onClick={() => run(() => props.onRemove(project))}
      />
    </div>
  );
  return createPortal(menu, document.body);
}

function MenuButton(props: {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneClass = props.disabled
    ? "app-frame-sidebar-menu__item--disabled"
    : props.danger
      ? "app-frame-sidebar-menu__item--danger"
      : props.active
        ? "app-frame-sidebar-menu__item--active"
        : "";
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`app-frame-sidebar-menu__item ${toneClass}`.trim()}
    >
      {props.icon ? <span className="app-frame-sidebar-menu__item-icon">{props.icon}</span> : null}
      <span className="app-frame-sidebar-menu__item-label">{props.label}</span>
    </button>
  );
}

export function resolveSidebarUpdateAction(
  update: UpdateCoordinatorValue | null,
  t: AppFrameTranslate
): SidebarUpdateActionView | null {
  if (!update) {
    return null;
  }

  if (update.phase === "available") {
    return {
      kind: "available",
      label: t("appFrame.update.available"),
      ariaLabel: t("appFrame.update.availableAria"),
      title: t("appFrame.update.availableAria"),
      disabled: false
    };
  }

  if (update.phase === "downloading") {
    const percent = normalizeUpdateDownloadPercent(update.downloadProgress?.percent);
    return {
      kind: "downloading",
      label: percent === null ? t("appFrame.update.downloading") : t("appFrame.update.progress", { percent }),
      ariaLabel: percent === null ? t("appFrame.update.downloadingAria") : t("appFrame.update.progressAria", { percent }),
      title: percent === null ? t("appFrame.update.downloadingAria") : t("appFrame.update.progressAria", { percent }),
      disabled: true
    };
  }

  if (update.phase === "installing") {
    return {
      kind: "installing",
      label: t("appFrame.update.installing"),
      ariaLabel: t("appFrame.update.installingAria"),
      title: t("appFrame.update.installingAria"),
      disabled: true
    };
  }

  if (update.phase === "prepared") {
    return {
      kind: "prepared",
      label: t("appFrame.update.restart"),
      ariaLabel: t("appFrame.update.restartAria"),
      title: t("appFrame.update.restartAria"),
      disabled: false
    };
  }

  return null;
}

function normalizeUpdateDownloadPercent(percent: number | null | undefined): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function renderSidebarUpdateActionIcon(kind: SidebarUpdateActionView["kind"]): ReactNode {
  if (kind === "available") {
    return <Download size={14} strokeWidth={2.2} aria-hidden="true" />;
  }
  if (kind === "prepared") {
    return <RefreshCw size={13} strokeWidth={2.1} aria-hidden="true" />;
  }
  return null;
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
