import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PRODUCT_TOUR_MEMORY_NAV_ANCHOR, PRODUCT_TOUR_TOOLS_NAV_ANCHOR } from "../app/product-tour-layout.js";
import type { AppRoutePath } from "../app/routes.js";
import { clearDeferredGuidanceStep, clearFocusedAgentTarget, clearProductTourStep, readDeferredGuidanceStep, readGuidanceCompleted, routeTable, writeDeferredGuidanceStep, writeGuidanceCompleted } from "../app/routes.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import {
  useOptionalAgentRuntimeBridge,
  type AgentTaskStateCoordinator,
  type SidebarIntent
} from "../app/agent-runtime-bridge.js";
import { useOptionalApiClients } from "../app/providers.js";
import { MemmyAgentRequestError } from "../api/memmy-agent-client.js";
import { communityLinks } from "../community/community-links.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import { Tooltip } from "../components/tooltip.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
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
import { CheckCheck, ChevronDown, ChevronRight, Folder, FolderPlus, MoreHorizontal, Pencil, Plus } from "lucide-react";

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

interface ProjectContextMenuState {
  projectId: string;
  x: number;
  y: number;
}

interface TaskContextMenuState {
  task: AgentTaskView;
  x: number;
  y: number;
}

type SidebarTaskPatch = Extract<SidebarIntent, { kind: "task-patch" }>["patch"];

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
const projectListMoreMenuSize: SidebarMenuSize = {
  width: 128,
  height: 40,
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
  width: 176,
  height: 200,
  margin: 8,
  gap: 0
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

export function AppFrame(props: AppFrameProps) {
  const { state, dispatch } = useAppState();
  const { clients } = useOptionalApiClients();
  const { t, language } = useTranslation();
  const { track } = useAnalytics();
  const taskStateCoordinator = useOptionalAgentRuntimeBridge()?.taskStateCoordinator
    ?? standaloneRenderTaskStateCoordinator;
  const taskBus = useTaskBus();
  const { syncAgentTaskStatuses } = taskBus;
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [showCommunity, setShowCommunity] = useState(false);
  const [taskListMenuAnchor, setTaskListMenuAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [projectListMenuAnchor, setProjectListMenuAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [taskContextMenu, setTaskContextMenu] = useState<TaskContextMenuState | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [projectCreateMenuOpen, setProjectCreateMenuOpen] = useState(false);
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState("");
  const [removeProjectId, setRemoveProjectId] = useState<string | null>(null);
  const [archiveProjectId, setArchiveProjectId] = useState<string | null>(null);
  const [projectMutationId, setProjectMutationId] = useState<string | null>(null);
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
  const visibleTasks = state.agent.tasks;
  const projectTree = useMemo(
    () => deriveSidebarPlacement(visibleTasks, state.agent.projects),
    [state.agent.projects, visibleTasks]
  );
  const showingStandaloneArchived = state.agent.sidebarState.view.show_archived;
  const showingProjectArchived = state.agent.sidebarState.view.show_project_archived;
  const visibleProjectTree = useMemo(
    () => deriveVisibleSidebarPlacement(projectTree, {
      projectTasks: showingProjectArchived,
      standaloneTasks: showingStandaloneArchived
    }),
    [projectTree, showingProjectArchived, showingStandaloneArchived]
  );
  const highlightedSessionKey = state.navigation.currentPath === "/main" ? state.agent.currentSessionKey : null;
  const renameProject = state.agent.projects.find((project) => project.id === renameProjectId) ?? null;
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
      }))
    });
  }, [state.agent.tasks, syncAgentTaskStatuses]);

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
      || (!taskListMenuAnchor && !projectListMenuAnchor && !taskContextMenu && !projectContextMenu && !projectCreateMenuOpen && !archiveConfirmSessionKey)
    ) {
      return;
    }

    const closeMenus = () => {
      setTaskListMenuAnchor(null);
      setProjectListMenuAnchor(null);
      setSortMenuOpen(false);
      setTaskContextMenu(null);
      setProjectContextMenu(null);
      setProjectCreateMenuOpen(false);
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
  }, [archiveConfirmSessionKey, projectContextMenu, projectCreateMenuOpen, projectListMenuAnchor, taskContextMenu, taskListMenuAnchor]);

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
    const showingTaskArchive = task.groupProjectId
      ? showingProjectArchived
      : showingStandaloneArchived;
    for (const key of resolveTaskAncestorGroupKeys(task, state.agent.projects, showingTaskArchive)) {
      if (!state.agent.sidebarState.collapsed_groups[key]) continue;
      void enqueueSidebarIntent({
        id: nextAgentSidebarMutationId(),
        kind: "set-collapsed",
        groupKey: key,
        collapsed: false
      });
    }
  }

  async function registerProject(mode: "blank" | "existing") {
    setProjectCreateMenuOpen(false);
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
    event.stopPropagation();
    setTaskListMenuAnchor(null);
    setProjectListMenuAnchor(null);
    setSortMenuOpen(false);
    setProjectCreateMenuOpen(false);
    setTaskContextMenu(null);
    setProjectContextMenu({ projectId, x: event.clientX, y: event.clientY });
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
    setProjectListMenuAnchor(null);
    setProjectCreateMenuOpen(false);
    setTaskContextMenu(null);
    setArchiveConfirmSessionKey(null);
    setTaskListMenuAnchor((value) => (value ? null : anchor));
    setSortMenuOpen(false);
  }

  function toggleProjectListMenu(anchor: SidebarMenuAnchor) {
    setTaskListMenuAnchor(null);
    setSortMenuOpen(false);
    setProjectCreateMenuOpen(false);
    setTaskContextMenu(null);
    setProjectContextMenu(null);
    setArchiveConfirmSessionKey(null);
    setProjectListMenuAnchor((value) => (value ? null : anchor));
  }

  function openTaskContextMenu(event: MouseEvent, task: AgentTaskView) {
    event.preventDefault();
    setTaskListMenuAnchor(null);
    setProjectListMenuAnchor(null);
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
            {visibleProjectTree.pinnedTasks.length > 0 || visibleProjectTree.pinnedProjects.length > 0 ? (
              <ProjectTreeSection
                title={t("common.pin")}
                groupKey="pinned"
                collapsedGroups={state.agent.sidebarState.collapsed_groups}
                projects={visibleProjectTree.pinnedProjects}
                tasks={visibleProjectTree.pinnedTasks}
                currentSessionKey={highlightedSessionKey}
                showPreviews={state.agent.sidebarState.view.show_previews}
                projectRegistryState={state.agent.projectRegistryState}
                onToggleGroup={toggleSidebarGroup}
                onToggleProject={toggleSidebarGroup}
                onOpenTask={openAgentTask}
                onRenameTask={openRenameDialog}
                onTaskContextMenu={openTaskContextMenu}
                onPinTask={pinTask}
                archiveConfirmSessionKey={archiveConfirmSessionKey}
                onRequestArchiveTask={requestArchiveTask}
                onConfirmArchiveTask={archiveTask}
                onUnarchiveTask={unarchiveTask}
                onDeleteArchivedTask={requestDeleteArchivedTask}
                onProjectContextMenu={openProjectMenu}
                onNewProjectTask={(projectId) => openNewAgent({ kind: "project", projectId })}
              />
            ) : null}

            <ProjectTreeSection
              title={t("appFrame.projects")}
              groupKey="projects"
              collapsedGroups={state.agent.sidebarState.collapsed_groups}
              projects={visibleProjectTree.projects}
              tasks={[]}
              currentSessionKey={highlightedSessionKey}
              showPreviews={state.agent.sidebarState.view.show_previews}
              projectRegistryState={state.agent.projectRegistryState}
              emptyText={state.agent.projectRegistryState === "corrupt"
                ? t("appFrame.project.registryUnavailable")
                : t("appFrame.project.empty")}
              onToggleGroup={toggleSidebarGroup}
              onToggleProject={toggleSidebarGroup}
              onOpenTask={openAgentTask}
              onRenameTask={openRenameDialog}
              onTaskContextMenu={openTaskContextMenu}
              onPinTask={pinTask}
              archiveConfirmSessionKey={archiveConfirmSessionKey}
              onRequestArchiveTask={requestArchiveTask}
              onConfirmArchiveTask={archiveTask}
              onUnarchiveTask={unarchiveTask}
              onDeleteArchivedTask={requestDeleteArchivedTask}
              onProjectContextMenu={openProjectMenu}
              onNewProjectTask={(projectId) => openNewAgent({ kind: "project", projectId })}
              headerAction={(
                <div className="flex items-center gap-0.5">
                  <div className="relative">
                    <button
                      type="button"
                      className="app-frame-task-section-action"
                      aria-label={t("appFrame.project.add")}
                      title={t("appFrame.project.add")}
                      disabled={state.agent.projectRegistryState === "corrupt" || projectMutationId != null}
                      onClick={(event) => {
                        event.stopPropagation();
                        setTaskListMenuAnchor(null);
                        setProjectListMenuAnchor(null);
                        setSortMenuOpen(false);
                        setProjectCreateMenuOpen((open) => !open);
                      }}
                    >
                      <Plus size={14} />
                    </button>
                    {projectCreateMenuOpen ? (
                      <div className="app-frame-project-create-menu">
                        <MenuButton label={t("appFrame.project.createBlank")} onClick={() => void registerProject("blank")} />
                        <MenuButton label={t("appFrame.project.useExisting")} onClick={() => void registerProject("existing")} />
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={t("appFrame.project.listActions")}
                    title={t("appFrame.project.listActions")}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleProjectListMenu(sidebarMenuAnchorFromRect(event.currentTarget.getBoundingClientRect()));
                    }}
                    className="app-frame-task-section-action"
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {projectListMenuAnchor ? (
                    <ProjectListMoreMenu
                      anchor={projectListMenuAnchor}
                      showArchived={showingProjectArchived}
                      onToggleArchived={() => {
                        setProjectListMenuAnchor(null);
                        void saveSidebarView({ showProjectArchived: !showingProjectArchived });
                      }}
                    />
                  ) : null}
                </div>
              )}
            />

            <ProjectTreeSection
              title={t("appFrame.tasks")}
              groupKey="standalone"
              collapsedGroups={state.agent.sidebarState.collapsed_groups}
              projects={[]}
              tasks={visibleProjectTree.standaloneTasks}
              currentSessionKey={highlightedSessionKey}
              showPreviews={state.agent.sidebarState.view.show_previews}
              projectRegistryState={state.agent.projectRegistryState}
              emptyText={state.agent.isLoadingSessions
                ? t("appFrame.taskList.loading")
                : t(showingStandaloneArchived ? "appFrame.taskList.emptyArchived" as MessageKey : "appFrame.taskList.empty")}
              onToggleGroup={toggleSidebarGroup}
              onToggleProject={toggleSidebarGroup}
              onOpenTask={openAgentTask}
              onRenameTask={openRenameDialog}
              onTaskContextMenu={openTaskContextMenu}
              onPinTask={pinTask}
              archiveConfirmSessionKey={archiveConfirmSessionKey}
              onRequestArchiveTask={requestArchiveTask}
              onConfirmArchiveTask={archiveTask}
              onUnarchiveTask={unarchiveTask}
              onDeleteArchivedTask={requestDeleteArchivedTask}
              onProjectContextMenu={openProjectMenu}
              onNewProjectTask={(projectId) => openNewAgent({ kind: "project", projectId })}
              headerAction={(
                <div className="flex items-center gap-0.5">
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
                    <MoreHorizontal size={14} />
                  </button>
                  {taskListMenuAnchor ? (
                    <SidebarMoreMenu
                      anchor={taskListMenuAnchor}
                      showPreviews={state.agent.sidebarState.view.show_previews}
                      showArchived={showingStandaloneArchived}
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
                        void saveSidebarView({ showArchived: !showingStandaloneArchived });
                      }}
                      onToggleSortMenu={() => setSortMenuOpen((value) => !value)}
                      onSelectSort={(sort) => {
                        setTaskListMenuAnchor(null);
                        setSortMenuOpen(false);
                        void saveSidebarView({ sort });
                      }}
                    />
                  ) : null}
                </div>
              )}
            />
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
              onRename={(project) => {
                setProjectContextMenu(null);
                setRenameProjectId(project.id);
                setRenameProjectValue(project.name);
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
      <Modal
        open={renameProject != null}
        title={t("appFrame.project.rename")}
        showCloseButton={false}
        className="rename-dialog"
        backdropClassName="rename-dialog-backdrop"
        style={{ width: 360, maxWidth: "calc(100vw - 32px)" }}
        onClose={() => setRenameProjectId(null)}
        footer={(
          <>
            <Button type="button" variant="soft" size="sm" onClick={() => setRenameProjectId(null)}>
              {t("dialog.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!renameProjectValue.trim() || projectMutationId != null}
              onClick={() => {
                if (!renameProject) return;
                const value = renameProjectValue.trim();
                void updateProject(renameProject.id, { name: value }).then((committed) => {
                  if (committed) {
                    setRenameProjectId(null);
                  }
                });
              }}
            >
              {t("dialog.ok")}
            </Button>
          </>
        )}
      >
        <input
          type="text"
          maxLength={160}
          value={renameProjectValue}
          onChange={(event) => setRenameProjectValue(event.target.value)}
          className="rename-dialog-input"
        />
        {renameProject ? <div className="app-frame-project-path">{renameProject.rootPath}</div> : null}
      </Modal>
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

function ProjectTreeSection(props: {
  title: string;
  groupKey: string;
  collapsedGroups: Record<string, boolean>;
  projects: ProjectSidebarNode[];
  tasks: AgentTaskView[];
  currentSessionKey: string | null;
  showPreviews: boolean;
  projectRegistryState: "ready" | "corrupt";
  headerAction?: ReactNode;
  emptyText?: string;
  onToggleGroup: (key: string) => void;
  onToggleProject: (key: string) => void;
  onOpenTask: (task: AgentTaskView) => Promise<void>;
  onRenameTask: (task: AgentTaskView) => void;
  onTaskContextMenu: (event: MouseEvent, task: AgentTaskView) => void;
  onPinTask: (task: AgentTaskView, pinned: boolean) => void;
  archiveConfirmSessionKey: string | null;
  onRequestArchiveTask: (task: AgentTaskView) => void;
  onConfirmArchiveTask: (task: AgentTaskView) => void;
  onUnarchiveTask: (task: AgentTaskView) => void;
  onDeleteArchivedTask: (task: AgentTaskView) => void;
  onProjectContextMenu: (event: MouseEvent, projectId: string) => void;
  onNewProjectTask: (projectId: string) => void;
}) {
  const collapsed = Boolean(props.collapsedGroups[props.groupKey]);
  const renderTask = (task: AgentTaskView, nested = false) => (
    <div key={task.sessionKey} className={nested ? "app-frame-project-task" : undefined}>
      <TaskRow
        task={task}
        isCurrent={props.currentSessionKey === task.sessionKey}
        showPreview={props.showPreviews}
        projectRegistryState={props.projectRegistryState}
        onOpen={() => void props.onOpenTask(task)}
        onRename={() => props.onRenameTask(task)}
        onContextMenu={(event) => props.onTaskContextMenu(event, task)}
        onPin={() => props.onPinTask(task, !task.pinned)}
        archiveConfirming={props.archiveConfirmSessionKey === task.sessionKey}
        onRequestArchive={() => props.onRequestArchiveTask(task)}
        onConfirmArchive={() => props.onConfirmArchiveTask(task)}
        onUnarchive={() => props.onUnarchiveTask(task)}
        onDeleteArchived={() => props.onDeleteArchivedTask(task)}
      />
    </div>
  );

  return (
    <section className="space-y-1">
      <div
        className="app-frame-task-section-header flex cursor-pointer items-center justify-between py-1.5 pl-1 pr-0"
        onClick={() => props.onToggleGroup(props.groupKey)}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-text-ink/50"
          aria-expanded={!collapsed}
        >
          <span className="app-frame-task-section-header__title min-w-0 truncate">{props.title}</span>
          {collapsed
            ? <ChevronRight size={13} aria-hidden="true" className="app-frame-task-section-header__toggle-icon shrink-0" />
            : <ChevronDown size={13} aria-hidden="true" className="app-frame-task-section-header__toggle-icon shrink-0" />}
        </button>
        <div
          className="app-frame-task-section-header__actions"
          onClick={(event) => event.stopPropagation()}
        >
          {props.headerAction}
        </div>
      </div>
      {!collapsed ? (
        <>
          {props.tasks.map((task) => renderTask(task))}
          {props.projects.map((node) => {
            const projectKey = `project:${node.project.id}`;
            const projectCollapsed = Boolean(props.collapsedGroups[projectKey]);
            return (
              <div key={node.project.id} className="app-frame-project-node">
                <ProjectRow
                  project={node.project}
                  collapsed={projectCollapsed}
                  onToggle={() => props.onToggleProject(projectKey)}
                  onContextMenu={(event) => props.onProjectContextMenu(event, node.project.id)}
                  onNewTask={() => props.onNewProjectTask(node.project.id)}
                />
                {!projectCollapsed ? node.tasks.map((task) => renderTask(task, true)) : null}
              </div>
            );
          })}
          {!props.tasks.length && !props.projects.length && props.emptyText ? (
            <div className="app-frame-task-empty pl-5 py-2 text-text-ink/40">{props.emptyText}</div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ProjectRow(props: {
  project: MemmyAgentProject;
  collapsed: boolean;
  onToggle: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onNewTask: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="app-frame-project-row flex items-center gap-1 rounded-input hover:bg-canvas-oat/55"
      title={props.project.rootPath}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1 text-left"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
      >
        <Folder size={14} className="shrink-0 text-action-sky/70" />
        <span className="app-frame-project-title min-w-0 flex-1 truncate text-text-ink/75">{props.project.name}</span>
      </button>
      <div className="app-frame-project-row__actions flex shrink-0 items-center pr-1">
        <TaskIconButton label={t("appFrame.project.newTask")} onClick={props.onNewTask}>
          <MessageSquarePlus size={12} />
        </TaskIconButton>
        <TaskIconButton
          label={t("appFrame.project.actions")}
          onClick={(event) => props.onContextMenu(event)}
        >
          <MoreHorizontal size={12} />
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
  projectRegistryState?: "ready" | "corrupt";
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
  const projectIssueLabel = props.task.projectId == null || props.task.groupProjectId != null
    ? null
    : props.projectRegistryState === "corrupt"
      ? t("appFrame.project.taskRegistryUnavailable")
      : t("appFrame.project.recordUnavailable");
  const projectIssueTitle = projectIssueLabel ? `${projectIssueLabel} · ${props.task.cwd}` : undefined;
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
        className="min-w-0 flex-1 text-left pl-1 py-2 cursor-pointer"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`app-frame-task-title min-w-0 flex-1 truncate ${titleClass}`}>{props.task.title}</span>
        </span>
        {props.showPreview && props.task.preview && (
          <span className={`app-frame-task-preview mt-1 block truncate ${previewClass}`}>{props.task.preview}</span>
        )}
        {projectIssueLabel ? (
          <span className="app-frame-task-preview mt-1 block truncate text-status-error/70">
            {projectIssueLabel}
          </span>
        ) : null}
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

function TaskIconButton(props: {
  label: string;
  active?: boolean;
  danger?: boolean;
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
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
          props.onClick(event);
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

function ProjectListMoreMenu(props: {
  anchor: SidebarMenuAnchor;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  const { t } = useTranslation();

  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }

  const overlayStyle = resolveSidebarMenuOverlayStyle(
    props.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    projectListMoreMenuSize
  );
  const menu = (
    <div
      className="fixed w-32 rounded-menu border border-border-stone/40 bg-background-paper shadow-lg p-1"
      style={overlayStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <MenuButton
        icon={<Archive size={12} />}
        label={props.showArchived
          ? t("appFrame.project.showAll")
          : t("appFrame.project.showArchived")}
        active={props.showArchived}
        onClick={props.onToggleArchived}
      />
    </div>
  );

  return createPortal(menu, document.body);
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
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  const placement = resolveSidebarContextMenuPlacement(
    props.menu,
    { width: window.innerWidth, height: window.innerHeight },
    taskContextMenuSize
  );
  const menu = (
    <div
      className="fixed z-50 w-36 rounded-menu border border-border-stone/40 bg-background-paper shadow-lg p-1"
      style={placement}
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
  onRename: (project: MemmyAgentProject) => void;
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
  const placement = resolveSidebarContextMenuPlacement(
    props.menu,
    { width: window.innerWidth, height: window.innerHeight },
    projectContextMenuSize
  );
  const menu = (
    <div
      className="fixed z-50 w-44 rounded-menu border border-border-stone/40 bg-background-paper shadow-lg p-1"
      style={placement}
      onClick={(event) => event.stopPropagation()}
    >
      <MenuButton
        icon={<Pin size={12} />}
        label={project.pinned ? t("appFrame.project.unpin") : t("appFrame.project.pin")}
        onClick={() => run(() => props.onPin(project))}
      />
      <MenuButton
        icon={<Folder size={12} />}
        label={t("appFrame.project.reveal")}
        onClick={() => run(() => props.onReveal(project))}
      />
      <MenuButton
        icon={<Pencil size={12} />}
        label={t("appFrame.project.rename")}
        onClick={() => run(() => props.onRename(project))}
      />
      <MenuButton
        icon={<CheckCheck size={12} />}
        label={t("appFrame.project.markRead")}
        onClick={() => run(() => props.onMarkRead(project))}
      />
      <MenuButton
        icon={<Archive size={12} />}
        label={t("appFrame.project.archiveTasks")}
        disabled={props.archiveTaskCount === 0}
        onClick={() => run(() => props.onArchive(project))}
      />
      <MenuButton
        icon={<Trash2 size={12} />}
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
  const colorClass = props.disabled
    ? "cursor-not-allowed text-text-ink/30"
    : props.danger
      ? "cursor-pointer text-status-error hover:bg-status-error/10"
      : props.active
        ? "cursor-pointer text-action-sky bg-action-sky/10"
        : "cursor-pointer text-text-ink/65 hover:bg-canvas-oat/60";
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-input text-left text-xs ${colorClass}`}
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
