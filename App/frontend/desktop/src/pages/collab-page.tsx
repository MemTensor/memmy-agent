import { AtSign, BookOpen, ChevronDown, ChevronRight, Cloud, Folder, Layers, Link2, ListChecks, MessageSquarePlus, MoreHorizontal, PanelRight, PanelRightClose, Pencil, Plus, RefreshCw, Search, Settings, Trash2, UserPlus, X } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  createHttpCollabClient,
  type CollabClient,
  type CollabInstructionsHandover,
  type CollabKnowledgeView,
  type CollabLinks,
  type CollabProject,
  type CollabProjectSession,
  type CollabProjectTask,
  type CollabSessionPage,
  type CollabSessionTurn,
  type CollabSyncProgress,
  type CollabSyncResult,
  type LocalAgentSession,
  type LocalSessionGroup
} from "../api/collab-client.js";
import {
  addCollabProject,
  consumeCollabTourRequest,
  consumeTaskPickerRequest,
  dismissCollabNotice,
  getCollabProjectsSnapshot,
  loadCollabProjects,
  markCollabProjectBound,
  removeCollabProject,
  replaceCollabProject,
  requestCreateProject,
  requestTaskPicker,
  requestCollabTour,
  selectCollabProject,
  sharedProjectFor,
  subscribeCollabProjects
} from "../app/collab-projects-store.js";
import type { MemmyAgentProject } from "../api/memmy-agent-client.js";
import { openAgentTaskInChat } from "../app/open-agent-task.js";
import { sessionKeyToChatId } from "../api/memmy-agent-client.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { agentChatScopeKey, shouldCreateNewAgentDraft } from "../state/agent-composer-state.js";
import type { AgentTaskView, ComposerMention } from "../state/agent-chat-slice.js";
import { useOptionalAppState, type AppStateContextValue } from "../state/app-state.js";
import { ApiRequestError } from "../api/http.js";
import { ProjectKnowledgeDialog, ProjectKnowledgeManageDialog } from "./collab-knowledge-dialog.js";
import {
  readProjectInstructions,
  saveProjectInstructions,
  type ProjectInstructions
} from "../api/projects-client.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import { AgentMessageContent, isLikelyExpensiveAgentMarkdown } from "./agent-message-content.js";
import { memberNamesLabel, readableSummary } from "./collab-board-text.js";
import { agentSourceDisplayName, agentSourceLogoUrl } from "./agent-source-logos.js";
import { AppFrame } from "./app-frame.js";
import { memberColor } from "./collab-member-color.js";
import { MEMBER_REQUESTS_POLL_MS, ProjectMembersDialog } from "./collab-members-dialog.js";
import {
  COLLAB_TOUR_ANCHORS,
  COLLAB_TOUR_STEP_KEYS,
  CollabTourOverlay,
  CollabTourTaskList,
  readCollabTourSeen,
  writeCollabTourSeen
} from "./collab-tour.js";
import styles from "./collab-page.module.css";

export { memberColor };

const TOAST_MS = 1_800;
/** The board shows ten sessions at a time, so a long project stays scannable. */
const SESSION_PAGE_SIZE = 10;
/**
 * 阅读面板首屏同步渲染的轮次数；之后的轮次先占位，滚到附近再展开。
 * 与聊天页的即时渲染条数同一考虑：面板高度内的那几轮必须马上有内容。
 */
const READER_IMMEDIATE_TURNS = 4;
/** 展开后续轮次的起始延迟与递增间隔：让它们分给孩子空闲时段，不扰动正在进行的操作。 */
const READER_DEFERRED_REVEAL_START_MS = 120;
const READER_DEFERRED_REVEAL_STEP_MS = 80;
/** 看板顶部的一次性提示停留时长。 */
const BOARD_NOTICE_MS = 6_000;
/**
 * 看板窄于这个宽度时，项目配置不再占一列。
 * 与 collab-page.module.css 里 `@container collab-board (max-width: 859px)` 一致。
 */
const NARROW_BOARD_PX = 860;

/** How often the board refreshes while an association uploads. */
const PROGRESS_POLL_MS = 1_200;
/** 看板开着时的刷新间隔：别的成员关联了会话，不用改筛选也能看到。 */
const BOARD_POLL_MS = 5_000;
const MAX_PROJECT_NAME_CHARS = 20;
const MAX_LOCAL_SESSIONS = 500;
/**
 * 云端每名成员在每个项目内保留的任务数（`CollabLimits.MAX_SESSIONS_PER_MEMBER`），
 * 新建的 Memmy 任务与关联的 Agent 任务共用。超出后按最近交互自动替换。
 */
const SESSIONS_PER_MEMBER_LIMIT = 20;
const EMPTY_LINKS: CollabLinks = { groups: [], sessions: [] };
/** 还没有设定指令时的空值，看板与弹窗共用。 */
const EMPTY_PROJECT_INSTRUCTIONS: ProjectInstructions = {
  text: "",
  origin: null,
  cloudProjectId: null,
  updatedAt: null
};
/** Member filter: anyone, only me, or only the other members. */
type MemberFilter = "all" | "me" | "others";

/** How an agent organizes its sessions, which names the groups in the picker. */
export type GroupingKind = "directory" | "project" | "workspace" | "workbuddy";

export function groupingKind(sourceId: string): GroupingKind {
  if (sourceId === "codex") return "project";
  if (sourceId === "cursor") return "workspace";
  if (sourceId === "workbuddy") return "workbuddy";
  return "directory";
}

/** A group in the picker with the sessions of it that match the search. */
export interface SessionGroupView {
  group: LocalSessionGroup;
  sessions: LocalAgentSession[];
}

/**
 * One agent's sessions in its groups, the most recently active group first, plus those outside every group.
 * A search keeps sessions matching every keyword, and every session of a group whose name matches.
 */
export function groupAgentSessions(sessions: readonly LocalAgentSession[], sourceId: string, query: string): { groups: SessionGroupView[]; ungrouped: LocalAgentSession[] } {
  const keywords = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (value: string) => keywords.every((keyword) => value.toLowerCase().includes(keyword));
  const groups = new Map<string, SessionGroupView>();
  const ungrouped: LocalAgentSession[] = [];
  const ordered = sessions
    .filter((session) => session.sourceId === sourceId)
    .sort((left, right) => Date.parse(right.updatedAt || "0") - Date.parse(left.updatedAt || "0"));
  for (const session of ordered) {
    const hit = matches(`${session.title}\n${session.lastQuestion}`);
    if (!session.group) {
      if (hit) ungrouped.push(session);
      continue;
    }
    if (!hit && !matches(session.group.label)) continue;
    const view = groups.get(session.group.id) ?? { group: session.group, sessions: [] };
    view.sessions.push(session);
    groups.set(session.group.id, view);
  }
  return { groups: [...groups.values()], ungrouped };
}

function findGroupLink(links: CollabLinks, sourceId: string, groupId: string) {
  return links.groups.find((link) => link.sourceId === sourceId && link.groupId === groupId);
}

/** Whether the picker shows a session as checked: covered by its whole group and not excluded, or linked on its own. */
export function isSessionChecked(links: CollabLinks, session: LocalAgentSession): boolean {
  const group = session.group ? findGroupLink(links, session.sourceId, session.group.id) : undefined;
  if (group) return !group.excluded.includes(session.conversationId);
  return links.sessions.some((link) => localSessionKey(link) === localSessionKey(session));
}

/** A linked whole group with exclusions is mixed; independent session selections are mixed too. */
export function groupCheckState(links: CollabLinks, sourceId: string, view: SessionGroupView): "checked" | "mixed" | "unchecked" {
  const group = findGroupLink(links, sourceId, view.group.id);
  if (group) return group.excluded.length ? "mixed" : "checked";
  return view.sessions.some((session) => isSessionChecked(links, session)) ? "mixed" : "unchecked";
}

/** Links the whole group, replacing its single-session links, or unlinks it entirely. */
export function toggleGroupLink(links: CollabLinks, sourceId: string, view: SessionGroupView): CollabLinks {
  const inGroup = new Set(view.sessions.map(localSessionKey));
  const sessions = links.sessions.filter((link) => !inGroup.has(localSessionKey(link)));
  const group = findGroupLink(links, sourceId, view.group.id);
  if (group?.excluded.length) {
    // A mixed checkbox selects the entire group on click, just like a partially selected group of sessions.
    return { groups: links.groups.map((link) => link === group ? { ...link, excluded: [] } : link), sessions };
  }
  if (group) {
    return { groups: links.groups.filter((link) => !(link.sourceId === sourceId && link.groupId === view.group.id)), sessions };
  }
  return { groups: [...links.groups, { sourceId, groupId: view.group.id, excluded: [] }], sessions };
}

/** Inside a linked group a session is excluded or included again; elsewhere it is linked on its own. */
export function toggleSessionLink(links: CollabLinks, session: LocalAgentSession): CollabLinks {
  const group = session.group ? findGroupLink(links, session.sourceId, session.group.id) : undefined;
  if (group) {
    const excluded = group.excluded.includes(session.conversationId)
      ? group.excluded.filter((id) => id !== session.conversationId)
      : [...group.excluded, session.conversationId];
    return { ...links, groups: links.groups.map((link) => (link === group ? { ...group, excluded } : link)) };
  }
  const key = localSessionKey(session);
  const linked = links.sessions.some((link) => localSessionKey(link) === key);
  return {
    ...links,
    sessions: linked
      ? links.sessions.filter((link) => localSessionKey(link) !== key)
      : [...links.sessions, { sourceId: session.sourceId, conversationId: session.conversationId }]
  };
}

function linksEqual(left: CollabLinks, right: CollabLinks): boolean {
  const canonical = (links: CollabLinks) => JSON.stringify({
    groups: links.groups.map(({ sourceId, groupId, excluded }) => [sourceId, groupId, [...excluded].sort()] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    sessions: links.sessions.map(({ sourceId, conversationId }) => [sourceId, conversationId] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  });
  return canonical(left) === canonical(right);
}

export function agentHasLinks(links: CollabLinks, sourceId: string): boolean {
  return links.groups.some((link) => link.sourceId === sourceId) || links.sessions.some((link) => link.sourceId === sourceId);
}

/** Month/day hour:minute, or empty when the time is unknown. */
export function formatSessionTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The buckets the task list splits its rows into, newest first. */
export type TaskDayGroup = "today" | "yesterday" | "week" | "earlier";

const DAY_MS = 86_400_000;

/** Midnight of the day the moment falls on, in this computer's time zone. */
function startOfLocalDay(moment: Date): number {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
}

/** Monday of the week the moment falls in: 本周 starts there, as the list calls it. */
function startOfLocalWeek(moment: Date): number {
  const start = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start.getTime();
}

/** Which day the row belongs to: 今天, 昨天, earlier in this week, or 更早. */
export function taskDayGroup(value: string | null, now: Date = new Date()): TaskDayGroup {
  const time = value ? Date.parse(value) : NaN;
  // A row with no usable time is grouped last rather than at the top, where it would look newest.
  if (!Number.isFinite(time)) return "earlier";
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(new Date(time))) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return time >= startOfLocalWeek(now) ? "week" : "earlier";
}

/** What a row shows on the right of its title: the hour today, the day before yesterday, the date after that. */
export type TaskStamp =
  | { kind: "time"; text: string }
  | { kind: "yesterday" }
  | { kind: "date"; month: number; day: number };

export function taskStamp(value: string | null, now: Date = new Date()): TaskStamp | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const group = taskDayGroup(value, now);
  if (group === "today") {
    const pad = (number: number) => String(number).padStart(2, "0");
    return { kind: "time", text: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
  }
  if (group === "yesterday") return { kind: "yesterday" };
  return { kind: "date", month: date.getMonth() + 1, day: date.getDate() };
}

/** The stamp in the current language: 14:32, 昨天, or 10月26日. */
export function stampLabel(stamp: TaskStamp | null, t: (key: MessageKey, values?: MessageValues) => string): string {
  if (!stamp) return "";
  if (stamp.kind === "time") return stamp.text;
  if (stamp.kind === "yesterday") return t("collab.sessions.stamp.yesterday");
  return t("collab.sessions.stamp.date", { month: stamp.month, day: stamp.day });
}

/** Key that identifies a local session across agents. */
export function localSessionKey(session: { sourceId: string; conversationId: string }): string {
  return `${session.sourceId}\u0000${session.conversationId}`;
}

/** 会话行真正用到的字段：这些一样，屏上就没有变化。 */
function sessionSignature(session: CollabProjectSession): string {
  return [
    session.id,
    session.title,
    session.lastQuestion,
    session.memberName,
    session.mine ? "1" : "0",
    session.source,
    String(session.turnCount),
    session.lastActiveAt ?? "",
    session.link,
    session.shareText
  ].join("\u0000");
}

/**
 * 云端每次返回都是新对象，直接写回会让看板白重画一次。内容一致时返回值告诉调用方「不用写」。
 * 只比较画面上与复制链接真正读到的字段，够用且比整串 JSON 便宜。
 */
function sameSessionPage(current: CollabSessionPage | null, next: CollabSessionPage): boolean {
  if (!current || current.total !== next.total) return false;
  if (current.sessions.length !== next.sessions.length) return false;
  for (let index = 0; index < current.sessions.length; index += 1) {
    const left = current.sessions[index];
    const right = next.sessions[index];
    if (!left || !right || sessionSignature(left) !== sessionSignature(right)) return false;
  }
  return true;
}

/** 上传进度也一样：四个数没变就不必重画进度条。 */
function sameSyncProgress(current: CollabSyncProgress | null, next: CollabSyncProgress | null): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  return current.running === next.running
    && current.total === next.total
    && current.completed === next.completed
    && current.failed === next.failed;
}

/**
 * 已经看过“成员任务可以用 @ 引用”提示的项目。按项目记：同一个人在不同项目里都需要知道这件事，
 * 同一个项目看一次就够。读失败（隐私模式、旧数据）当没看过，宁可多提示一次也不报错。
 */
const CONTEXT_TIP_STORAGE_KEY = "memmy.collab.contextTipSeen";
const CONTEXT_TIP_STORAGE_LIMIT = 100;

function readContextTipSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(CONTEXT_TIP_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeContextTipSeen(seen: string[]): void {
  try {
    window.localStorage.setItem(
      CONTEXT_TIP_STORAGE_KEY,
      JSON.stringify(seen.slice(-CONTEXT_TIP_STORAGE_LIMIT))
    );
  } catch {
    // 存不下就只在本次会话里生效，不影响任务列表。
  }
}

/** 空值常量：wrapper 每次都要读一遍全局状态，不能每次现造空数组把 memo 冲掉。 */
const NO_PROJECTS: MemmyAgentProject[] = [];
const NO_TASKS: AgentTaskView[] = [];

/**
 * The page entry: reads the two lists from app state and hands them to the board.
 * 看板只用到这两份数据。全局状态的其余部分（消息流、连接状态、界面开关）每变一次都会换掉 context 的
 * value，所以真正干活的看板是 memo 的：后台有任务输出时，它不该跟着每个事件重画一遍。
 */
export function CollabPage() {
  // 看板只用到这两份数据。全局状态的其余部分（消息流、连接状态、界面开关）每变一次都会换掉 context 的
  // value，所以真正干活的看板必须是 memo 的：后台有任务输出时，它不该跟着每个事件重画一遍。
  const appState = useOptionalAppState();
  const projects = appState?.state.agent.projects ?? NO_PROJECTS;
  const tasks = appState?.state.agent.tasks ?? NO_TASKS;
  // dispatch 的引用是稳定的，当作 prop 传下去不会把 memo 冲掉。
  const dispatch = appState?.dispatch ?? null;
  // 读最新的 agent 状态靠 ref：把它写进依赖会让回调每次都换新，看板就会跟着后台每条流式输出重画。
  const agentRef = useRef(appState?.state.agent ?? null);
  agentRef.current = appState?.state.agent ?? null;
  /**
   * 继续任务：在同一个项目下开一条新任务，并把被继续的那条任务作为引用带进去。
   * 步骤与侧栏「＋」一致（新建草稿、指定项目目标、切到对话页），只是多带一个引用片；
   * 引用沿用 @ 引用的同一套存储，落地后就是一个可移除的引用，由使用者说明要继续做什么。
   */
  const onContinueTask = useCallback((projectId: string, mention: ComposerMention | null) => {
    const agent = agentRef.current;
    if (!dispatch || !agent) return;
    const createsDraft = shouldCreateNewAgentDraft(agent);
    const nextRequestId = createsDraft ? agent.newChatRequestId + 1 : agent.newChatRequestId;
    const scopeKey = agentChatScopeKey(null, nextRequestId);
    if (createsDraft) {
      dispatch(agentActions.newChatRequested());
    } else if (!agent.blankDraftActive) {
      dispatch(agentActions.blankDraftReopened());
    }
    dispatch(agentActions.draftTargetUpdated(scopeKey, { kind: "project", projectId }));
    if (mention) {
      const existing = agent.composerMentionsByScope[scopeKey] ?? [];
      if (!existing.some((item) => item.id === mention.id)) {
        dispatch(agentActions.composerMentionsUpdated(scopeKey, [...existing, mention]));
      }
    }
    dispatch(appActions.navigate("/main"));
  }, [dispatch]);
  return (
    <CollabBoard
      dispatch={dispatch}
      projects={projects}
      tasks={tasks}
      onContinueTask={onContinueTask}
    />
  );
}

/**
 * The board of one project: its header and the session list. A project is local; when its sharing switch is on,
 * the sessions come from the cloud and the list also carries members and references.
 */
const CollabBoard = memo(function CollabBoard(props: {
  dispatch: AppStateContextValue["dispatch"] | null;
  projects: MemmyAgentProject[];
  tasks: AgentTaskView[];
  /** 在项目下开一条新任务并带上引用；引用为空时就是普通的「在此项目新建任务」。 */
  onContinueTask: (projectId: string, mention: ComposerMention | null) => void;
}) {
  const { dispatch, projects, tasks, onContinueTask } = props;
  const { clients } = useApiClients();
  const { t, language } = useTranslation();
  const collab = useMemo(() => (clients ? createHttpCollabClient(clients.runtimeConfig) : null), [clients]);
  const snapshot = useSyncExternalStore(subscribeCollabProjects, getCollabProjectsSnapshot, getCollabProjectsSnapshot);
  const [page, setPage] = useState<CollabSessionPage | null>(null);
  const [member, setMember] = useState<MemberFilter>("all");
  const [query, setQuery] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [reading, setReading] = useState<{ session: CollabProjectSession; turns: CollabSessionTurn[] } | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  /** Choosing which of the project's own Memmy sessions members may read. */
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 看板右侧的项目配置：指令等项目的配置项在这里查看与编辑，与侧栏无关。 */
  const [configOpen, setConfigOpen] = useState(true);
  /** 用户手动收起或展开后，不再随宽度自动开关。换项目时清掉。 */
  const configTouchedRef = useRef(false);
  const pageRef = useRef<HTMLDivElement>(null);
  /** 看板当前展示的项目指令：本机项目读本机文件，协作项目用云端列表里的内容。 */
  const [instructions, setInstructions] = useState<ProjectInstructions>(EMPTY_PROJECT_INSTRUCTIONS);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  /** 项目关联的知识库：只影响本项目的检索，成员都能关联，解除限本人添加或所有者、管理员。 */
  const [knowledge, setKnowledge] = useState<CollabKnowledgeView | null>(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeManageOpen, setKnowledgeManageOpen] = useState(false);
  /** 「邀请」in the header and「项目成员」in the sidebar menu open the same dialog. */
  const [membersOpen, setMembersOpen] = useState(false);
  /** 待审核的加入申请数：弹窗没开时也轮询，别人提交申请后「邀请」入口上直接出现角标。 */
  const [pendingRequests, setPendingRequests] = useState(0);
  const [deleting, setDeleting] = useState<CollabProjectSession | null>(null);
  /** 多选删除：进入选择模式后勾选本人的任务，一次移除。 */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** 成员首次进入时的单行提示：按项目记录已读，同一个项目只出现一次。 */
  const [contextTipSeen, setContextTipSeen] = useState<string[]>(() => readContextTipSeen());
  /**
   * 首次创建协作项目时的引导（teach mode）。步骤放在看板里，示例任务行与「…」菜单的展开才跟得上高亮；
   * 完成与跳过都记在本机，之后不再自动出现，需要时从项目设置里重看。
   */
  const [tourStep, setTourStep] = useState<number | null>(null);
  const tourActive = tourStep !== null;
  /** Upload progress of a queued association; the list grows while it runs. */
  const [progress, setProgress] = useState<CollabSyncProgress | null>(null);
  /** Bumped when an association is queued, so polling starts without waiting for a filter or page change. */
  const [pollKey, setPollKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** Projects whose tasks were already uploaded for this opening, so filters do not re-upload them. */
  const syncedProjectRef = useRef<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  /**
   * 写回一页列表。轮询、手动刷新、上传后重读都走这里：内容与屏上一样就保留原对象，
   * 让 React 中途退出渲染，也不去动共享 store（否则侧栏会跟着重画）。
   */
  const applyPage = useCallback((next: CollabSessionPage) => {
    setPage((current) => (sameSessionPage(current, next) ? current : next));
    replaceCollabProject(next.project);
  }, []);

  useEffect(() => {
    if (collab) void loadCollabProjects(collab);
  }, [collab]);

  // 一次性提示（如新建时云端不可用）停留几秒后自动消失，不需要用户手动关闭。
  const notice = snapshot.notice;
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => dismissCollabNotice(), BOARD_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The board belongs to a project on this computer. Sharing only adds a cloud record to it.
  const project = projects.find((candidate) => candidate.id === snapshot.selectedId)
    ?? projects[0]
    ?? null;
  useEffect(() => {
    // A reload, or a project opened from a link, has no selection yet: the first project keeps the board usable.
    if (project && snapshot.selectedId !== project.id) selectCollabProject(project.id);
  }, [project, snapshot.selectedId]);
  const shared = sharedProjectFor(snapshot.projects, project?.id);
  const sharedId = shared?.id ?? null;
  const projectId = project?.id ?? null;

  /** 结束引导：完成与跳过都记在本机，之后不再自动出现，需要时从项目设置里重看。 */
  const finishTour = useCallback(() => {
    writeCollabTourSeen();
    setTourStep(null);
  }, []);

  /**
   * 刚创建并开启协作、或在项目设置里刚开启协作的项目走一遍引导。
   * 只在这一个时机请求一次：打开其他协作项目、加入他人的项目都不会弹；本机已经看过则不再出现。
   * 等云端记录读回来再开始：否则「邀请」与「关联任务」两个锚点还没渲染，高亮会落空。
   */
  useEffect(() => {
    if (!projectId || snapshot.tourFor !== projectId || !sharedId) return;
    consumeCollabTourRequest();
    if (tourStep !== null || readCollabTourSeen()) return;
    setTourStep(0);
  }, [projectId, sharedId, snapshot.tourFor, tourStep]);

  // 最后一步点「开始使用」后步骤越界，在这里收尾并把完成记录写下来。
  useEffect(() => {
    if (tourStep !== null && tourStep >= COLLAB_TOUR_STEP_KEYS.length) finishTour();
  }, [tourStep, finishTour]);

  // 宽看板默认展开配置；窄到放不下时先收起。用户点过收起或展开之后，以他的选择为准。
  useLayoutEffect(() => {
    configTouchedRef.current = false;
    const page = pageRef.current;
    if (!page) return;
    const apply = (width: number) => {
      if (width <= 0 || configTouchedRef.current) return;
      const open = width >= NARROW_BOARD_PX;
      setConfigOpen((current) => (current === open ? current : open));
    };
    apply(page.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      apply(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(page);
    return () => observer.disconnect();
  }, [projectId]);

  function chooseConfig(open: boolean) {
    configTouchedRef.current = true;
    setConfigOpen(open);
  }

  // A project that just started sharing asks which of its own sessions go to the cloud.
  useEffect(() => {
    if (!projectId || snapshot.taskPickerFor !== projectId) return;
    consumeTaskPickerRequest();
    setSettingsOpen(false);
    setTaskPickerOpen(true);
  }, [projectId, snapshot.taskPickerFor]);

  /**
   * 项目指令由所有者与管理员维护；仅在本机的项目没有其他成员，本机的人就是所有者。
   * 协作项目的指令以云端为准，注入由协作侧自己的钩子完成，看板只负责展示与保存。
   */
  const canEditInstructions = !shared || shared.role === "owner" || shared.role === "admin";
  const instructionsDirectory = project?.rootPath ?? null;
  const runtimeConfig = clients?.runtimeConfig ?? null;
  /** 云端列表里的指令：协作项目的权威内容。 */
  const sharedInstructions = shared?.instructions ?? "";
  const runtimeBaseUrl = runtimeConfig?.baseUrl ?? null;

  // 协作项目不读本机项目指令：那是另一套按文件夹归属的存储，读它会拿到别人的指令或本机旧镜像。
  // 本机项目照旧读本机文件。依赖都是基本类型，客户端对象每次渲染可能都是新的。
  useEffect(() => {
    if (sharedId) {
      setInstructions({ ...EMPTY_PROJECT_INSTRUCTIONS, text: sharedInstructions, cloudProjectId: sharedId });
      return;
    }
    if (!instructionsDirectory || !runtimeBaseUrl || !runtimeConfig) {
      setInstructions(EMPTY_PROJECT_INSTRUCTIONS);
      return;
    }
    let cancelled = false;
    void readProjectInstructions(runtimeConfig, instructionsDirectory)
      .then((view) => {
        if (!cancelled) setInstructions(view);
      })
      .catch(() => {
        if (!cancelled) setInstructions(EMPTY_PROJECT_INSTRUCTIONS);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runtimeConfig 的身份每渲染都可能变化，改看它的地址
  }, [instructionsDirectory, runtimeBaseUrl, sharedId, sharedInstructions]);

  /**
   * 保存指令：协作项目写云端（权限也在云端判定），后端把内容缓存到协作侧自己的文件；
   * 仅在本机的项目直接写本机文件。保存后对此后开始的任务生效。
   */
  async function saveInstructions(text: string): Promise<void> {
    if (sharedId && collab) {
      const updated = await collab.setInstructions(sharedId, text);
      replaceCollabProject(updated);
      setInstructions({ ...EMPTY_PROJECT_INSTRUCTIONS, text: updated.instructions, cloudProjectId: updated.id });
      return;
    }
    if (!instructionsDirectory) return;
    if (!runtimeConfig?.baseUrl) throw new Error(t("collab.instructions.saveFailed"));
    const saved = await saveProjectInstructions(runtimeConfig, instructionsDirectory, text);
    setInstructions(saved);
  }

  /**
   * 项目配置打开时读一次关联的知识库。云端没实现这组接口（旧版本）时按「没有关联」显示，
   * 不影响指令与看板的其它部分。
   */
  useEffect(() => {
    if (!configOpen || !sharedId || !collab) {
      setKnowledge(null);
      return;
    }
    let cancelled = false;
    void collab.knowledge(sharedId)
      .then((view) => {
        if (!cancelled) setKnowledge(view);
      })
      .catch(() => {
        if (!cancelled) setKnowledge(null);
      });
    return () => {
      cancelled = true;
    };
  }, [configOpen, sharedId, collab]);

  /** 关联一个知识库：加入后本项目全体成员的 Agent 都能检索到它。 */
  async function addKnowledge(baseId: string): Promise<void> {
    if (!sharedId || !collab) return;
    const view = await collab.addKnowledge(sharedId, baseId);
    setKnowledge(view);
  }

  /** 解除关联：权限由云端判定，被拒绝时把原因显示出来。 */
  async function removeKnowledge(baseId: string): Promise<void> {
    if (!sharedId || !collab) return;
    setKnowledge(await collab.removeKnowledge(sharedId, baseId));
  }

  // One request builds every page: the query and the member filter decide what `total` counts.
  useEffect(() => {
    if (!collab || !sharedId) {
      setPage(null);
      return;
    }
    let cancelled = false;
    const first = pageIndex === 0 && !query;
    if (first) setPage(null);
    const load = async () => {
      try {
        // The list is read first: waiting for an upload that may be queued behind other work is what made the
        // board sit on "loading". The upload starts in parallel and the next poll picks up what it adds. It runs
        // once per board opening and only for this project, so a search or a page change never re-uploads.
        if (!syncedProjectRef.current.has(sharedId)) {
          syncedProjectRef.current.add(sharedId);
          void collab.syncSessions({ tasksOnly: true, projectId: sharedId })
            .then(() => refreshAfterUploadRef.current())
            .catch(() => undefined);
        }
        const result = await collab.listSessions(sharedId, {
          ...(query ? { query } : {}),
          ...(member === "all" ? {} : { member }),
          offset: pageIndex * SESSION_PAGE_SIZE,
          limit: SESSION_PAGE_SIZE
        });
        if (cancelled) return;
        applyPage(result);
      } catch (cause) {
        if (!cancelled) showToast(messageOf(cause));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [applyPage, collab, sharedId, query, member, pageIndex, showToast]);

  /**
   * Called once the background upload of this project's own tasks finishes, so a task finished moments ago shows
   * up without the board having waited for it.
   */
  const refreshAfterUploadRef = useRef<() => void>(() => undefined);
  const refreshAfterUpload = useCallback(() => {
    if (!collab || !sharedId) return;
    void collab.listSessions(sharedId, {
      ...(query ? { query } : {}),
      ...(member === "all" ? {} : { member }),
      offset: pageIndex * SESSION_PAGE_SIZE,
      limit: SESSION_PAGE_SIZE
    })
      .then((result) => applyPage(result))
      .catch(() => undefined);
  }, [applyPage, collab, sharedId, query, member, pageIndex]);
  refreshAfterUploadRef.current = refreshAfterUpload;

  /** Re-reads the current page without blanking it, so rows arrive instead of the board flickering. */
  const refreshSessions = useCallback(async (projectId: string) => {
    if (!collab) return;
    try {
      const result = await collab.listSessions(projectId, {
        ...(query ? { query } : {}),
        ...(member === "all" ? {} : { member }),
        offset: pageIndex * SESSION_PAGE_SIZE,
        limit: SESSION_PAGE_SIZE
      });
      applyPage(result);
    } catch {
      // A failed refresh keeps the last page; the next poll retries.
    }
  }, [applyPage, collab, member, pageIndex, query]);

  const refreshBoard = useCallback(async () => {
    if (!sharedId || refreshing) return;
    setRefreshing(true);
    try {
      await refreshSessions(sharedId);
    } finally {
      setRefreshing(false);
    }
  }, [refreshSessions, refreshing, sharedId]);

  // While the board is open, keep the list current. An upload polls quickly; otherwise a slower pass picks up
  // a session another member associated, without waiting for a filter or page change.
  useEffect(() => {
    if (!collab || !sharedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** 上一次看到的「是否在上传」，窗口隐藏时据此决定回到前台后多久再查。 */
    let uploading = false;

    const schedule = (running: boolean) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), running ? PROGRESS_POLL_MS : BOARD_POLL_MS);
    };

    const tick = async () => {
      // 窗口在后台就没人看得到这次结果：不查、不写，等着回来那一下补上。
      if (document.hidden) {
        schedule(uploading);
        return;
      }
      const [next, listing] = await Promise.all([
        collab.getSyncProgress(sharedId).catch(() => null),
        collab.listSessions(sharedId, { ...(member === "all" ? {} : { member }), ...(query ? { query } : {}), offset: pageIndex * SESSION_PAGE_SIZE, limit: SESSION_PAGE_SIZE }).catch(() => null)
      ]);
      if (cancelled) return;
      if (listing) applyPage(listing);
      setProgress((current) => (sameSyncProgress(current, next) ? current : next));
      uploading = Boolean(next?.running);
      schedule(uploading);
    };

    // 切回窗口时立刻补一次：后台跳过的那几拍不会让人先看到旧列表。
    const refreshNow = () => {
      if (cancelled || document.hidden) return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", refreshNow);

    // Opening the board joins an upload that started earlier, and keeps refreshing after it stops.
    void collab.getSyncProgress(sharedId)
      .then((current) => {
        if (cancelled) return;
        uploading = current.running;
        setProgress((previous) => (sameSyncProgress(previous, current) ? previous : current));
        schedule(current.running);
      })
      .catch(() => {
        if (!cancelled) schedule(false);
      });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refreshNow);
      if (timer) clearTimeout(timer);
    };
  }, [applyPage, collab, sharedId, member, query, pageIndex, pollKey]);

  // 换一个项目就从头算角标，不把上个项目的待审核数带到这个项目上。
  useEffect(() => {
    setPendingRequests(0);
  }, [sharedId]);

  /**
   * 弹窗关着时也读一次待审核的申请：别人在本机之外提交申请后，「邀请」入口上直接出现角标，
   * 不用先打开弹窗才知道。弹窗开着时由弹窗自己轮询，这里让位。
   */
  useEffect(() => {
    if (!collab || !sharedId || membersOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (document.hidden) {
        timer = setTimeout(() => void tick(), MEMBER_REQUESTS_POLL_MS);
        return;
      }
      try {
        const view = await collab.listMembers(sharedId);
        if (cancelled) return;
        setPendingRequests(view.canManage ? view.requests.length : 0);
        // 不是所有者或管理员就没有可审核的申请，学到这一点后本窗口不再查。
        if (!view.canManage) return;
      } catch {
        // 云端暂时不可用：下一轮再试，角标保留上一份结果。
      }
      if (!cancelled) timer = setTimeout(() => void tick(), MEMBER_REQUESTS_POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [collab, sharedId, membersOpen]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const sessions = page?.sessions ?? null;
  const filtering = Boolean(query) || member !== "all";

  const total = page?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE));

  // A new query or member filter starts again from the first page.
  useEffect(() => {
    setPageIndex(0);
  }, [query, member, sharedId]);

  // Keep the page in range when a deletion or a filter change leaves it past the end.
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= pageCount) setPageIndex(pageCount - 1);
  }, [pageCount, pageIndex]);

  // Only this project's own tasks: nothing leaves the computer until sharing is on and sessions are chosen.
  const localTasks = useMemo(() => {
    if (!projectId) return [];
    return tasks
      .filter((task) => task.projectId === projectId && !task.archived)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }, [projectId, tasks]);

  async function openSession(session: CollabProjectSession) {
    if (!collab) return;
    setReadingId(session.id);
    try {
      setReading(await collab.readSessionDetail(session.id));
    } catch (cause) {
      showToast(messageOf(cause));
    } finally {
      setReadingId(null);
    }
  }

  /**
   * 点开一条任务。本人在这台电脑上用 Memmy 建的任务直接进会话页——正文就在本机，没必要先给一个只读面板；
   * 别人的任务、以及其他 Agent 的任务仍用只读面板读云端副本。
   */
  function openRow(session: CollabProjectSession) {
    const chatId = session.conversationId;
    const task = chatId
      ? tasks.find((candidate) => candidate.sessionKey && sessionKeyToChatId(candidate.sessionKey) === chatId) ?? null
      : null;
    if (task && dispatch) {
      void openAgentTaskInChat({ memmyAgent: clients?.memmyAgent, dispatch, task });
      return;
    }
    void openSession(session);
  }

  async function copyLink(session: CollabProjectSession) {
    try {
      await navigator.clipboard.writeText(session.shareText);
      showToast(t("collab.session.linkCopied"));
    } catch {
      showToast(t("collab.session.copyFailed"));
    }
  }

  /**
   * 继续一条协作任务：把它的全文作为引用带到项目下的新任务里。
   * 引用文本取不到（网络或权限）时退回任务链接，Agent 仍可凭链接自行读取，不阻断新建。
   */
  async function continueSession(session: CollabProjectSession) {
    // 列表只在有项目时渲染，这里仍取一次 id：闭包里的项目不在这里收窄。
    const localProjectId = project?.id ?? null;
    if (!localProjectId) return;
    let reference = session.shareText;
    try {
      const read = collab ? await collab.readReference(session.shareText || session.link) : null;
      if (read?.text) reference = read.text;
    } catch {
      // 保留链接作为引用，下面的新建照常进行。
    }
    onContinueTask(localProjectId, { id: session.id, title: session.title, reference });
  }

  /** 关掉项目内的一次性提示，并记住这个项目已经看过。 */
  function dismissContextTip(projectId: string) {
    setContextTipSeen((current) => {
      if (current.includes(projectId)) return current;
      const next = [...current, projectId];
      writeContextTipSeen(next);
      return next;
    });
  }

  async function confirmDelete() {
    if (!collab || !sharedId || !deleting) return;
    const session = deleting;
    setDeleting(null);
    try {
      await collab.removeSession(sharedId, session.id);
      showToast(t("collab.session.deleted"));
      await refreshSessions(sharedId);
    } catch (cause) {
      showToast(messageOf(cause));
    }
  }

  /** 选择模式只在本人任务上生效：他人的任务只能看，删除也由云端限定为本人。 */
  function toggleSelected(sessionId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function selectAllMine() {
    const mine = (page?.sessions ?? []).filter((session) => session.mine).map((session) => session.id);
    setSelected((current) => (mine.length > 0 && mine.every((id) => current.has(id)) ? new Set() : new Set(mine)));
  }

  async function deleteSelected() {
    if (!collab || !sharedId || !selected.size) return;
    const ids = [...selected];
    setConfirmBulkDelete(false);
    setBulkDeleting(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await collab.removeSession(sharedId, id);
      } catch {
        failed += 1;
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    setSelecting(false);
    const deleted = ids.length - failed;
    showToast(failed
      ? t("collab.sessions.bulkDeletePartial", { deleted: String(deleted), failed: String(failed) })
      : t("collab.sessions.bulkDeleted", { count: String(deleted) }));
    await refreshSessions(sharedId);
  }

  useEffect(() => {
    // 换页、换筛选或进入/退出选择模式后，旧的勾选不再有效。
    setSelected(new Set());
  }, [pageIndex, member, query, selecting]);

  const memberOptions: { value: MemberFilter; label: string }[] = [
    { value: "all", label: t("collab.filter.all") },
    { value: "me", label: t("collab.filter.you") },
    { value: "others", label: t("collab.filter.others") }
  ];

  // 提示条只在有他人的任务时出现，数字与成员名都取自同一批数据，不加一次请求。
  const otherSessions = (sessions ?? []).filter((session) => !session.mine);
  const otherSessionCount = otherSessions.length;
  const otherMemberNames = otherSessions.map((session) => session.memberName);
  const memberLabel = memberNamesLabel(otherMemberNames, language);
  const showContextTip = project !== null
    && otherSessionCount > 0
    && !contextTipSeen.includes(project.id);

  const selectableSessions = (page?.sessions ?? []).filter((session) => session.mine);
  const allPageSelected = selectableSessions.length > 0 && selectableSessions.every((session) => selected.has(session.id));

  return (
    <AppFrame title={project?.name ?? t("nav.collab")}>
      <div className={styles.page} ref={pageRef}>
        {!project ? (
          snapshot.projects === null ? (
            <p className={styles.loading}>{t("collab.loading")}</p>
          ) : (
            <div className={styles.empty}>
              <b>{t("collab.empty.title")}</b>
              <p>{t("collab.empty.body")}</p>
              <Button variant="primary" size="sm" onClick={() => requestCreateProject()}>{t("home.project.new")}</Button>
            </div>
          )
        ) : (
          <>
            {/* 看板与右侧的项目配置并排：配置属于项目，不随任务列表滚动。 */}
            <div className={styles.scroller}>
              <div className={styles.wrap} data-tour-anchor={COLLAB_TOUR_ANCHORS.board}>
                {notice !== null ? (
                  <div className={styles.cloudNotice} role="alert">
                    <span>{notice}</span>
                  </div>
                ) : null}
                {/* 只有已共享的项目才依赖云端；本地项目不提示云端异常，等开启共享时再报错。 */}
                {shared !== null && snapshot.error !== null ? (
                  <div className={styles.cloudNotice} role="status">
                    <span>{t("collab.cloudUnavailable", { message: snapshot.error })}</span>
                    <Button size="sm" variant="ghost" onClick={() => collab && void loadCollabProjects(collab)}>
                      {t("collab.retry")}
                    </Button>
                  </div>
                ) : null}
                <header className={styles.boardHeader} data-tour-anchor={COLLAB_TOUR_ANCHORS.header}>
                  <span className={styles.boardIcon} aria-hidden="true">
                    {shared ? <Cloud size={22} /> : <Folder size={22} />}
                  </span>
                  <h1 className={styles.boardName}>{project.name}</h1>
                  <span className={styles.boardScope}>
                    {shared
                      ? t("collab.members", { count: String(shared.memberCount) })
                      : t("collab.board.localOnly")}
                  </span>
                  <span className={styles.grow} />
                  {shared ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-tour-anchor={COLLAB_TOUR_ANCHORS.invite}
                      onClick={() => setMembersOpen(true)}
                      // 有待审核的申请时把数量写进无障碍名称，按钮上也带一个角标。
                      aria-label={pendingRequests > 0 ? t("collab.members.pending", { count: String(pendingRequests) }) : undefined}
                      title={pendingRequests > 0 ? t("collab.members.pending", { count: String(pendingRequests) }) : undefined}
                    >
                      <UserPlus size={15} aria-hidden="true" />
                      {t("collab.members.invite")}
                      {pendingRequests > 0 ? (
                        <span className={styles.requestBadge} aria-hidden="true">{pendingRequests}</span>
                      ) : null}
                    </Button>
                  ) : null}
                  {/* 收起与展开不同时出现：展开时入口在面板标题栏，收起后才回到这里，与 WorkBuddy 一致 */}
                  {configOpen ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("collab.config.expand")}
                      title={t("collab.config.expand")}
                      onClick={() => chooseConfig(true)}
                    >
                      <PanelRight size={15} aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("collab.settings.open")}
                    title={t("collab.settings.open")}
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings size={15} aria-hidden="true" />
                  </Button>
                </header>

                {shared ? (
                  <>
                    <div className={styles.toolbar} data-tour-anchor={COLLAB_TOUR_ANCHORS.toolbar}>
                      {/* 按成员筛选：原型里的三段胶囊，比下拉少一次点击 */}
                      <div className={styles.seg} role="group" aria-label={t("collab.filter.label")}>
                        {memberOptions.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={`${styles.segItem} ${option.value === member ? styles.segItemOn : ""}`}
                            aria-pressed={option.value === member}
                            onClick={() => setMember(option.value)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      <span className={styles.grow} />
                      {/* 搜索属于浏览，选择态收起来；已经带着查询时保留，否则列表被筛住却看不到原因 */}
                      {selecting && !query ? null : (
                        <label className={styles.searchBox}>
                          <Search size={14} aria-hidden="true" className={styles.searchIcon} />
                          <input
                            value={searchDraft}
                            placeholder={t("collab.sessions.searchPlaceholder")}
                            aria-label={t("collab.sessions.searchPlaceholder")}
                            onChange={(event) => {
                              const next = event.target.value;
                              setSearchDraft(next);
                              // Clearing shows everything again at once; typing waits for a pause.
                              if (!next.trim()) setQuery("");
                            }}
                            onKeyDown={(event) => {
                              // 回车确认输入法候选词时不要发起搜索，否则搜的是半成品拼音。
                              if (event.key === "Enter" && !isComposingKeyboardEvent(event)) setQuery(searchDraft.trim());
                              if (event.key === "Escape") {
                                setSearchDraft("");
                                setQuery("");
                              }
                            }}
                          />
                          {searchDraft && searchDraft !== query ? (
                            <button type="button" className={styles.searchGo} onClick={() => setQuery(searchDraft.trim())}>
                              {t("collab.sessions.searchGo")}
                            </button>
                          ) : null}
                        </label>
                      )}
                      {selecting ? (
                        /* 选择态只留这一组，整组不换行：否则最后一个「删除」会被挤到下一行单挂 */
                        <span className={styles.selectActions}>
                          <span className={styles.selectCount}>
                            {t("collab.sessions.selectedCount", { count: String(selected.size) })}
                          </span>
                          <Button size="sm" variant="ghost" disabled={!selectableSessions.length || bulkDeleting} onClick={selectAllMine}>
                            {t(allPageSelected ? "collab.sessions.deselectAll" : "collab.sessions.selectAll")}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={bulkDeleting} onClick={() => setSelecting(false)}>
                            {t("collab.cancel")}
                          </Button>
                          {/* 破坏性操作保留警示色，但用文字按钮，不在工具条里压一块红底 */}
                          <Button
                            size="sm"
                            variant="ghost"
                            className={styles.dangerGhost}
                            disabled={!selected.size || bulkDeleting}
                            onClick={() => setConfirmBulkDelete(true)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            {bulkDeleting ? t("collab.sessions.deleting") : t("collab.session.delete")}
                          </Button>
                        </span>
                      ) : (
                        <>
                          {/* 刷新属于浏览列表，选择态用不上，放在常态这一支 */}
                          <Button
                            size="sm"
                            variant="ghost"
                            className={styles.iconAction}
                            aria-label={t("collab.sessions.refresh")}
                            title={t("collab.sessions.refresh")}
                            disabled={refreshing}
                            onClick={() => void refreshBoard()}
                          >
                            <RefreshCw size={14} aria-hidden="true" />
                            <span className={styles.actionLabel}>{t("collab.sessions.refresh")}</span>
                          </Button>
                          {/* 多选只对本人任务生效：没有本人的任务时不显示入口 */}
                          {(sessions ?? []).some((session) => session.mine) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className={styles.iconAction}
                              aria-label={t("collab.sessions.select")}
                              title={t("collab.sessions.select")}
                              onClick={() => setSelecting(true)}
                            >
                              <ListChecks size={14} aria-hidden="true" />
                              <span className={styles.actionLabel}>{t("collab.sessions.select")}</span>
                            </Button>
                          ) : null}
                          <Button size="sm" variant="primary" data-tour-anchor={COLLAB_TOUR_ANCHORS.associate} onClick={() => setPickOpen(true)}>
                            <Link2 size={14} aria-hidden="true" />
                            {t("collab.associate")}
                          </Button>
                        </>
                      )}
                    </div>

                    {/*
                     * 引导期间整页都换成引导自己的示例页：真实任务、同步进度与成员提示都不出现。
                     * 从项目设置里重看时项目里本就有任务，混在一起会分不清哪条是演示、哪条是自己的。
                     */}
                    {tourActive ? <CollabTourTaskList step={tourStep ?? 0} projectName={project.name} /> : null}

                    {!tourActive && progress?.running ? (() => {
                      // 云端每人每项目只留最近 20 个，进度也按这个额度显示，不报会超出上限的条数。
                      const cappedTotal = Math.min(progress.total, SESSIONS_PER_MEMBER_LIMIT);
                      const cappedDone = Math.min(progress.completed, cappedTotal);
                      // 超出额度的那几条还在上传：进度已满，用缓慢呼吸说明后台仍在处理。
                      const pending = progress.total > cappedTotal && progress.completed >= cappedTotal;
                      return (
                        <div className={styles.syncStrip} role="status" aria-live="polite">
                          <span className={styles.syncText}>
                            {t("collab.sync.progress", { completed: String(cappedDone), total: String(cappedTotal) })}
                          </span>
                          <span className={styles.syncBar} aria-hidden="true">
                            <span
                              className={`${styles.syncBarFill} ${pending ? styles.syncBarFillPending : ""}`}
                              style={{ width: `${cappedTotal ? Math.round((cappedDone / cappedTotal) * 100) : 0}%` }}
                            />
                          </span>
                        </div>
                      );
                    })() : null}
                    {!tourActive && showContextTip ? (
                      // 只有项目里确实有他人任务时才出现：空项目里这句话没有对象，提示也就没有意义。
                      <div className={styles.contextTip} role="status">
                        <span className={styles.contextTipIcon} aria-hidden="true"><AtSign size={13} /></span>
                        <span className={styles.contextTipText}>
                          {t(
                            memberLabel ? "collab.contextTip.text" : "collab.contextTip.textAnon",
                            memberLabel
                              ? { who: memberLabel, count: String(otherSessionCount) }
                              : { count: String(otherSessionCount) }
                          )}
                        </span>
                        <button
                          type="button"
                          className={styles.contextTipAction}
                          onClick={() => dismissContextTip(project.id)}
                        >
                          {t("collab.contextTip.dismiss")}
                        </button>
                      </div>
                    ) : null}
                    {sessions === null ? (
                      tourActive ? null : <p className={styles.loading}>{t("collab.loading")}</p>
                    ) : sessions.length === 0 && filtering ? (
                      tourActive ? null : (
                      // 筛选没结果时只说明当前筛选下没有任务：清除入口在筛选控件本身，不必再给一个按钮。
                      <div className={styles.empty}>
                        {query ? (
                          <>
                            <b>{t("collab.sessions.noMatch.title")}</b>
                            <p>{t("collab.sessions.noMatch.body", { query })}</p>
                          </>
                        ) : (
                          <p>{t(member === "me" ? "collab.sessions.noMatch.bodyMe" : "collab.sessions.noMatch.bodyOthers")}</p>
                        )}
                      </div>
                      )
                    ) : sessions.length === 0 ? (
                      // An empty project is the one place to explain the board: what it collects and what a
                      // member can do with it. New projects start here, so it carries the first-run guidance.
                      tourActive ? null : (
                      <section className={styles.guide} aria-label={t("collab.sessions.empty.title")}>
                        <b className={styles.guideTitle}>{t("collab.sessions.empty.title")}</b>
                        <p className={styles.guideLead}>{t("collab.sessions.empty.lead")}</p>
                        <ul className={styles.guideList}>
                          {([
                            { key: "task", icon: <MessageSquarePlus size={15} aria-hidden="true" /> },
                            { key: "associate", icon: <Link2 size={15} aria-hidden="true" /> }
                          ] as const).map((item) => (
                            <li key={item.key} className={styles.guideItem}>
                              <span className={styles.guideIcon} aria-hidden="true">{item.icon}</span>
                              <div className={styles.guideText}>
                                <b>{t(`collab.sessions.empty.${item.key}.title` as MessageKey)}</b>
                                <span>{t(`collab.sessions.empty.${item.key}.body` as MessageKey)}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>
                      )
                    ) : (
                      tourActive ? null : <>
                      <ul className={`${styles.list} ${styles.stream} ${styles.flatStream}`}>
                        {sessions.map((session) => {
                          // Members see this person's nickname in their own Memmy, so the avatar keeps the nickname.
                          const name = session.memberName || (session.mine ? t("collab.session.you") : "");
                          // 旧记录里的摘要可能停在 Agent 的完成通知上，读不出内容就不显示。
                          const summary = readableSummary(session.lastQuestion);
                          // 本人的任务也写昵称：自己看到的与成员看到的一致，只有昵称缺失时才退回「你」。
                          const menuOpen = openMenuId === session.id;
                          return (
                            <li
                              key={session.id}
                              className={`${styles.row} ${selecting ? styles.rowSelecting : styles.rowOpenable} ${menuOpen ? styles.rowMenuOpen : ""} ${selected.has(session.id) ? styles.rowSelected : ""}`}
                              onClick={() => {
                                if (!selecting) {
                                  openRow(session);
                                  return;
                                }
                                // 选择模式下点击整行就是勾选；他人的任务不可选。
                                if (session.mine) toggleSelected(session.id);
                              }}
                            >
                              {selecting && session.mine ? (
                                <input
                                  type="checkbox"
                                  className={styles.rowCheck}
                                  checked={selected.has(session.id)}
                                  aria-label={session.title}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={() => toggleSelected(session.id)}
                                />
                              ) : null}
                              {/* 头像只用成员自身颜色的浅底与字色，接近原型里的淡色头像 */}
                              <span
                                className={`${styles.avatar} ${styles.avatarSoft}`}
                                style={{ "--member": memberColor(name) } as CSSProperties}
                                aria-hidden="true"
                              >
                                {Array.from(name)[0] ?? "?"}
                              </span>
                              <div className={styles.rowText}>
                                <span className={styles.rowTitle}>{session.title}</span>
                                {summary ? <span className={styles.rowSummary}>{summary}</span> : null}
                              </div>
                              <span className={styles.meta}>
                                {[name, stampLabel(taskStamp(session.lastActiveAt), t)].filter(Boolean).join(" · ")}
                              </span>
                              {selecting ? null : (
                              <button
                                type="button"
                                className={styles.moreButton}
                                aria-label={t("collab.session.more")}
                                title={t("collab.session.more")}
                                aria-expanded={menuOpen}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setOpenMenuId(menuOpen ? null : session.id);
                                }}
                              >
                                <MoreHorizontal size={15} aria-hidden="true" />
                              </button>
                              )}
                              {menuOpen ? (
                                <>
                                  {/*
                                   * The row itself opens the session reader. Every click that belongs to the menu has to
                                   * stop here, or copying a link also opens the session behind the toast.
                                   */}
                                  <button
                                    type="button"
                                    className={styles.menuScrim}
                                    aria-label={t("collab.cancel")}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setOpenMenuId(null);
                                    }}
                                  />
                                  <div className={styles.menu} role="menu" onClick={(event) => event.stopPropagation()}>
                                    {/* 任一行都可用，包括他人的只读任务：只读限制作用于正文，不影响在自己这边开新任务 */}
                                    <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setOpenMenuId(null); void continueSession(session); }}>
                                      {t("collab.session.continue")}
                                    </button>
                                    <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setOpenMenuId(null); void copyLink(session); }}>
                                      {t("collab.session.copyLink")}
                                    </button>
                                    {session.mine ? (
                                      <>
                                        <div className={styles.menuSeparator} role="separator" />
                                        <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.menuItemDanger}`} onClick={() => { setOpenMenuId(null); setDeleting(session); }}>
                                          {t("collab.session.delete")}
                                        </button>
                                      </>
                                    ) : null}
                                  </div>
                                </>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                      {total > SESSION_PAGE_SIZE ? (
                        <nav className={styles.pager} aria-label={t("collab.sessions.pager")}>
                          <span className={styles.pagerInfo}>
                            {t("collab.sessions.pageInfo", {
                              page: String(pageIndex + 1),
                              pages: String(pageCount),
                              total: String(total)
                            })}
                          </span>
                          <span className={styles.grow} />
                          <Button size="sm" variant="ghost" disabled={pageIndex === 0} onClick={() => setPageIndex(pageIndex - 1)}>
                            {t("collab.sessions.prevPage")}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={pageIndex >= pageCount - 1} onClick={() => setPageIndex(pageIndex + 1)}>
                            {t("collab.sessions.nextPage")}
                          </Button>
                        </nav>
                      ) : total > 0 ? (
                        <p className={styles.pagerInfo}>{t("collab.sessions.totalOnly", { total: String(total) })}</p>
                      ) : null}
                      </>
                    )}
                  </>
                ) : (
                  <LocalProjectSessions
                    tasks={localTasks}
                    onOpenTask={(task) => {
                      if (!dispatch) return;
                      void openAgentTaskInChat({ memmyAgent: clients?.memmyAgent, dispatch, task });
                    }}
                    // 本机任务没有云端引用可带：新任务就落在同一个项目目录里，正文不搬。
                    onContinueTask={() => onContinueTask(project.id, null)}
                  />
                )}
              </div>
            </div>
            {configOpen ? (
              <ProjectConfigPanel
                instructions={instructions}
                canEdit={canEditInstructions}
                knowledge={shared ? knowledge : null}
                knowledgeAvailable={Boolean(shared)}
                onEdit={() => setInstructionsOpen(true)}
                onAddKnowledge={() => setKnowledgeOpen(true)}
                onManageKnowledge={() => setKnowledgeManageOpen(true)}
                onCollapse={() => chooseConfig(false)}
              />
            ) : null}
            {configOpen ? (
              <button
                type="button"
                className={styles.configScrim}
                aria-label={t("collab.config.collapse")}
                tabIndex={-1}
                onClick={() => chooseConfig(false)}
              />
            ) : null}
          </>
        )}
      </div>

      {/* Overlays mount on the body, like the app's other menus and dialogs, so the sidebar never covers them. */}
      {typeof document === "undefined" ? null : createPortal(<>
      {/*
       * 引导层必须挂在 body 上：看板容器带 `container-type: inline-size`（隐含 contain: layout），
       * 会成为 fixed 后代的包含块，遮罩坐标取的是视口矩形，放在看板里就会错位。
       */}
      {tourActive && project ? (
        <CollabTourOverlay
          step={tourStep ?? 0}
          projectName={project.name}
          onNext={() => setTourStep((step) => (step ?? -1) + 1)}
          onBack={() => setTourStep((step) => Math.max(0, (step ?? 0) - 1))}
          onSkip={finishTour}
        />
      ) : null}
      {project ? (
        <ProjectInstructionsDialog
          open={instructionsOpen}
          instructions={instructions}
          canEdit={canEditInstructions}
          onClose={() => setInstructionsOpen(false)}
          onSave={saveInstructions}
          onSaved={() => showToast(t("collab.instructions.saved"))}
          onFailed={(message) => showToast(message || t("collab.instructions.saveFailed"))}
        />
      ) : null}
      {project ? (
        <ProjectKnowledgeManageDialog
          open={knowledgeManageOpen}
          knowledge={knowledge}
          onClose={() => setKnowledgeManageOpen(false)}
          onAdd={() => { setKnowledgeManageOpen(false); setKnowledgeOpen(true); }}
          onRemove={removeKnowledge}
        />
      ) : null}
      {project ? (
        <ProjectKnowledgeDialog
          open={knowledgeOpen}
          linked={knowledge?.bases ?? []}
          maxBases={knowledge?.maxBases ?? 10}
          config={runtimeConfig}
          onClose={() => { setKnowledgeOpen(false); setKnowledgeManageOpen(true); }}
          onAdd={addKnowledge}
          onAdded={(count) => showToast(t("collab.knowledge.added", { count: String(count) }))}
        />
      ) : null}
      {project ? (
        <ProjectBoardSettingsDialog
          open={settingsOpen}
          project={project}
          shared={shared}
          collab={collab}
          onClose={() => setSettingsOpen(false)}
          onShared={() => {
            // The board re-reads its own list once sharing exists.
            setSettingsOpen(false);
            setPollKey((key) => key + 1);
          }}
          onUnshared={() => {
            setPage(null);
            setSettingsOpen(false);
            showToast(t("collab.settings.unshared"));
          }}
          taskCount={localTasks.length}
          onPickSessions={() => {
            setSettingsOpen(false);
            setTaskPickerOpen(true);
          }}
          onReplayTour={() => {
            // 重看引导先关上设置：引导层的遮罩是整窗的，弹窗盖在上面会遮住目标。
            setSettingsOpen(false);
            setTourStep(0);
          }}
          onNotice={showToast}
          onFailed={showToast}
        />
      ) : null}
      {collab && shared ? (
        <ProjectMembersDialog
          open={membersOpen}
          collab={collab}
          projectId={shared.id}
          onClose={() => setMembersOpen(false)}
          onToast={showToast}
          // The member count in the header and the sidebar follows approvals and removals.
          onProjectChanged={replaceCollabProject}
          // 弹窗关掉后角标沿用弹窗里读到的数，不必再查一次。
          onRequestsChange={setPendingRequests}
        />
      ) : null}
      {collab && shared ? (
        <ProjectTaskPickerDialog
          open={taskPickerOpen}
          collab={collab}
          project={shared}
          onClose={() => setTaskPickerOpen(false)}
          onSaved={(result) => {
            setTaskPickerOpen(false);
            if (result.started) {
              setProgress({ running: true, total: result.started, completed: 0, failed: 0 });
              setPollKey((key) => key + 1);
              showToast(t("collab.tasks.queued", { count: String(result.started) }));
            } else {
              showToast(t("collab.tasks.saved"));
            }
            void refreshSessions(shared.id);
          }}
          onFailed={showToast}
        />
      ) : null}
      {collab && shared ? (
        <AssociateSessionsModal
          open={pickOpen}
          collab={collab}
          project={shared}
          onClose={() => setPickOpen(false)}
          onLinked={(result) => {
            // The selection is already saved; the upload continues in the background and the board shows it.
            setPickOpen(false);
            if (result.started) {
              setProgress({ running: true, total: result.started, completed: 0, failed: 0 });
              setPollKey((key) => key + 1);
              // 超出云端额度时不报真实条数：最终只会保留最近的 20 个，报数量会让人以为都留下了。
              showToast(result.started > SESSIONS_PER_MEMBER_LIMIT
                ? t("collab.pick.queuedCapped", { limit: String(SESSIONS_PER_MEMBER_LIMIT) })
                : t("collab.pick.queued", { count: String(result.started) }));
            } else {
              showToast(t("collab.pick.done"));
            }
            void refreshSessions(shared.id);
          }}
        />
      ) : null}
      <SessionReaderPanel
        session={reading}
        loading={readingId !== null}
        onClose={() => setReading(null)}
        onCopy={(session) => void copyLink(session)}
      />
      <ConfirmDialog
        open={confirmBulkDelete}
        title={t("collab.sessions.bulkDeleteTitle")}
        message={t("collab.sessions.bulkDeleteMessage", { count: String(selected.size) })}
        cancelLabel={t("collab.cancel")}
        confirmLabel={t("collab.session.delete")}
        confirmVariant="danger"
        icon={null}
        onCancel={() => setConfirmBulkDelete(false)}
        onConfirm={() => void deleteSelected()}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t("collab.session.deleteTitle")}
        message={t("collab.session.deleteMessage", { title: deleting?.title ?? "" })}
        cancelLabel={t("collab.cancel")}
        confirmLabel={t("collab.session.delete")}
        confirmVariant="danger"
        icon={null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
      {toast ? <div className={styles.toast} role="status">{toast}</div> : null}
      </>, document.body)}
    </AppFrame>
  );
});

/**
 * The sessions tab of a project that is not shared: this computer's own tasks for it, nothing more. Sharing is
 * turned on in the project settings, so the list stays a list instead of carrying a reminder.
 */
function LocalProjectSessions(props: {
  tasks: AgentTaskView[];
  onOpenTask: (task: AgentTaskView) => void;
  /** 在这个项目下开一条新任务：本机任务没有云端引用，新任务只是落在同一个项目里。 */
  onContinueTask: () => void;
}) {
  const { t } = useTranslation();
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  return (
    <>
      {props.tasks.length === 0 ? (
        <p className={styles.localEmpty}>{t("collab.board.noTasks")}</p>
      ) : (
        // 本机项目没有工具条，列表要自己留出与标题的间距，否则悬停行浮起的外环会贴住项目名。
        <ul className={`${styles.list} ${styles.stream} ${styles.flatStream}`}>
          {props.tasks.map((task) => {
            const menuOpen = openMenuKey === task.sessionKey;
            return (
              <li
                key={task.sessionKey}
                className={`${styles.row} ${styles.rowOpenable} ${menuOpen ? styles.rowMenuOpen : ""}`}
                onClick={() => props.onOpenTask(task)}
              >
                <span className={styles.localIcon} aria-hidden="true"><Folder size={15} /></span>
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>{task.title}</span>
                  {task.preview ? <span className={styles.rowSummary}>{task.preview}</span> : null}
                </div>
                <span className={styles.meta}>{stampLabel(taskStamp(task.updatedAt), t)}</span>
                <button
                  type="button"
                  className={styles.moreButton}
                  aria-label={t("collab.session.more")}
                  title={t("collab.session.more")}
                  aria-expanded={menuOpen}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuKey(menuOpen ? null : task.sessionKey);
                  }}
                >
                  <MoreHorizontal size={15} aria-hidden="true" />
                </button>
                {menuOpen ? (
                  <>
                    <button
                      type="button"
                      className={styles.menuScrim}
                      aria-label={t("collab.cancel")}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuKey(null);
                      }}
                    />
                    <div className={styles.menu} role="menu" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setOpenMenuKey(null);
                          props.onContinueTask();
                        }}
                      >
                        {t("collab.session.continue")}
                      </button>
                    </div>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * Which of the project's own Memmy sessions go to the cloud. A session that already belongs to the project starts
 * checked, so the dialog also works as a way to take one back out.
 */
function ProjectTaskPickerDialog(props: {
  open: boolean;
  collab: CollabClient | null;
  project: CollabProject;
  onClose: () => void;
  onSaved: (result: CollabSyncResult) => void;
  onFailed: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<CollabProjectTask[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { collab, open, project } = props;

  useEffect(() => {
    if (!open || !collab) return;
    let cancelled = false;
    setTasks(null);
    setError(null);
    collab.listProjectTasks(project.id)
      .then((listing) => {
        if (cancelled) return;
        setTasks(listing);
        setSelected(new Set(listing.filter((task) => task.included).map((task) => task.conversationId)));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [collab, open, project.id]);

  const count = tasks?.length ?? 0;
  const allSelected = count > 0 && selected.size === count;

  function toggle(conversationId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }

  async function confirm() {
    if (!collab || busy) return;
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await collab.saveProjectTasks(project.id, [...selected]));
    } catch (cause) {
      setError(messageOf(cause) || t("collab.pick.failed"));
      props.onFailed(messageOf(cause) || t("collab.pick.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.tasks.title")}
      subtitle={t("collab.tasks.subtitle")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.pickModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          <span className={styles.tasksCount}>{t("collab.tasks.selected", { count: String(selected.size) })}</span>
          <span className={styles.footerButtons}>
            <Button variant="ghost" onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button
              variant="primary"
              disabled={busy || tasks === null || count === 0}
              onClick={() => void confirm()}
            >
              {t("collab.tasks.confirm")}
            </Button>
          </span>
        </>
      )}
    >
      {tasks === null ? (
        <p className={styles.loading}>{error ?? t("collab.loading")}</p>
      ) : count === 0 ? (
        <p className={styles.localEmpty}>{t("collab.tasks.empty")}</p>
      ) : (
        // One bordered card holds the select-all row and the sessions, so every box sits on the same left edge.
        <div className={styles.tasksCard}>
          <label className={styles.tasksAll}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(tasks.map((task) => task.conversationId)))}
            />
            <span>{t("collab.tasks.selectAll")}</span>
          </label>
          <ul className={styles.tasksList}>
            {tasks.map((task) => {
              const summary = readableSummary(task.lastQuestion);
              return (
              <li
                key={task.conversationId}
                className={`${styles.row} ${styles.rowOpenable}`}
                onClick={() => toggle(task.conversationId)}
              >
                <input
                  type="checkbox"
                  className={styles.tasksCheck}
                  checked={selected.has(task.conversationId)}
                  onChange={() => toggle(task.conversationId)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={task.title}
                />
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>{task.title}</span>
                  {summary ? <span className={styles.rowSummary}>{summary}</span> : null}
                </div>
                <span className={styles.meta}>{formatSessionTime(task.updatedAt)}</span>
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** 项目指令的上限，与云端和注入侧一致（1 万字，与 WorkBuddy 相同）：全文注入，长度决定每轮的开销。 */
const MAX_INSTRUCTION_CHARS = 10_000;

/**
 * 看板右侧的项目配置。项目里的配置项放在这里查看：先有指令，知识库与技能随后加入；
 * 所有者与管理员可以直接编辑，成员只读。
 */
function ProjectConfigPanel(props: {
  instructions: ProjectInstructions;
  canEdit: boolean;
  /** 关联的知识库；本机项目没有云端配置，为 null。 */
  knowledge: CollabKnowledgeView | null;
  /** 只有协作项目能关联知识库：本机项目没有项目范围可言。 */
  knowledgeAvailable: boolean;
  onEdit: () => void;
  onAddKnowledge: () => void;
  onManageKnowledge: () => void;
  onCollapse: () => void;
}) {
  const { t } = useTranslation();
  const text = props.instructions.text.trim();
  return (
    <aside className={styles.config} aria-label={t("collab.config.title")}>
      <div className={styles.configHead}>
        <b className={styles.configTitle}>{t("collab.config.title")}</b>
        <button
          type="button"
          className={styles.configIcon}
          aria-label={t("collab.config.collapse")}
          title={t("collab.config.collapse")}
          onClick={props.onCollapse}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.configCards}>
        <section className={styles.configCard}>
          <div className={styles.configCardHead}>
            <span className={styles.configCardTitle}>{t("collab.config.instructions")}</span>
            {props.canEdit ? (
              <button
                type="button"
                className={styles.configIcon}
                aria-label={t("collab.config.instructionsEdit")}
                title={t("collab.config.instructionsEdit")}
                onClick={props.onEdit}
              >
                <Pencil size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <button type="button" className={styles.configCardBody} onClick={props.onEdit}>
            {text ? (
              <span className={styles.configText}>{text}</span>
            ) : (
              <span className={styles.configEmpty}>{t("collab.config.instructionsEmpty")}</span>
            )}
          </button>
        </section>
        {props.knowledgeAvailable ? (
          <section className={styles.configCard}>
            <div className={styles.configCardHead}>
              <span className={styles.configCardTitle}>
                {t("collab.config.knowledge")}
                {props.knowledge?.bases.length ? <span className={styles.configKnowledgeCount}>{props.knowledge.bases.length}</span> : null}
              </span>
              {props.knowledge?.bases.length ? (
                <button type="button" className={styles.configKnowledgeAction} onClick={props.onManageKnowledge}>
                  {t("collab.config.knowledgeManage")}
                </button>
              ) : null}
            </div>
            <div className={styles.configCardBody}>
              {props.knowledge?.bases.length ? (
                <>
                  <ul className={styles.configKnowledgeList}>
                    {props.knowledge.bases.slice(0, 3).map((base) => (
                      <li key={base.id} className={styles.configKnowledgeRow}>
                        <BookOpen size={12} aria-hidden="true" />
                        <span className={styles.configKnowledgeName} title={base.name}>{base.name}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <span className={styles.configEmpty}>{t("collab.config.knowledgeEmpty")}</span>
                  <button type="button" className={styles.configKnowledgeMore} onClick={props.onAddKnowledge}>
                    {t("collab.config.knowledgeAdd")}
                  </button>
                </>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * 项目指令的编辑与查看。所有者与管理员保存后对此后开始的任务生效；成员打开时只读。
 */
function ProjectInstructionsDialog(props: {
  open: boolean;
  instructions: ProjectInstructions;
  canEdit: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
  onSaved: () => void;
  onFailed: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(props.instructions.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 打开时总是从当前生效的指令开始改，取消了不留草稿。 */
  useEffect(() => {
    if (!props.open) return;
    setDraft(props.instructions.text);
    setError(null);
  }, [props.open, props.instructions.text]);

  const used = [...draft.trim()].length;
  const tooLong = used > MAX_INSTRUCTION_CHARS;
  const unchanged = draft.trim() === props.instructions.text.trim();
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!props.open || !props.canEdit) return;
    editorRef.current?.focus();
  }, [props.open, props.canEdit]);

  async function save() {
    if (saving || tooLong) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave(draft.trim());
      props.onSaved();
      props.onClose();
    } catch (cause) {
      setError(messageOf(cause) || t("collab.instructions.saveFailed"));
      props.onFailed(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.instructions.title")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.createModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          <span />
          <span className={styles.footerButtons}>
            {props.canEdit ? (
              <>
                <Button onClick={props.onClose}>{t("common.cancel")}</Button>
                <Button variant="primary" disabled={saving || tooLong || unchanged} onClick={() => void save()}>
                  {t("collab.instructions.save")}
                </Button>
              </>
            ) : (
              <Button onClick={props.onClose}>{t("collab.instructions.close")}</Button>
            )}
          </span>
        </>
      )}
    >
      <p className={styles.dialogHint}>
        {props.canEdit ? t("collab.instructions.editHint") : t("collab.instructions.readHint")}
      </p>
      {props.canEdit ? (
        <>
          <textarea
            ref={editorRef}
            className={styles.instructionsInput}
            aria-label={t("collab.instructions.title")}
            value={draft}
            maxLength={MAX_INSTRUCTION_CHARS * 2}
            placeholder={t("collab.instructions.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={styles.instructionsMeta}>
            <span className={tooLong ? styles.instructionsOver : undefined}>
              {t("collab.instructions.counter", { count: String(used), max: String(MAX_INSTRUCTION_CHARS) })}
            </span>
            {error ? <span className={styles.instructionsError} role="alert">{t("collab.instructions.saveFailed")}</span> : null}
          </div>
        </>
      ) : (
        <div className={styles.instructionsReadonly}>
          {props.instructions.text.trim() || t("collab.instructions.empty")}
        </div>
      )}
    </Modal>
  );
}

/**
 * The board's settings: the one switch that decides whether this project's sessions leave the computer, and the
 * entry to choosing which of them members can read.
 */
function ProjectBoardSettingsDialog(props: {
  open: boolean;
  project: MemmyAgentProject;
  shared: CollabProject | null;
  collab: CollabClient | null;
  onClose: () => void;
  onShared: () => void;
  onUnshared: () => void;
  onPickSessions: () => void;
  /** 重新走一遍首次引导：新建协作项目时自动出现一次，之后只在这里重看。 */
  onReplayTour?: () => void;
  /** How many of the project's own sessions could be shared, which decides whether choosing them is worth a dialog. */
  taskCount: number;
  onNotice: (message: string) => void;
  onFailed: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /** Which switch is running, so a slow cloud says what it is doing instead of only greying the box. */
  const [action, setAction] = useState<"sharing" | "stopping" | null>(null);
  /** Asking again before a shared project leaves the cloud, since members lose access. */
  const [confirmStop, setConfirmStop] = useState(false);
  /** How many of the project's own sessions the cloud holds, shown as the sync row's detail. */
  const [taskStats, setTaskStats] = useState<{ synced: number; total: number } | null>(null);
  const { clients } = useApiClients();
  const sharedId = props.shared?.id ?? null;
  const ownedByOther = Boolean(props.shared && props.shared.role !== "owner");

  useEffect(() => {
    if (props.open) setConfirmStop(false);
  }, [props.open, sharedId]);

  // The sync row says what is already there, so opening the settings reads the project's own sessions once.
  useEffect(() => {
    if (!props.open || !sharedId || !props.collab) {
      setTaskStats(null);
      return;
    }
    let cancelled = false;
    props.collab.listProjectTasks(sharedId)
      .then((tasks) => {
        if (cancelled) return;
        setTaskStats({ synced: tasks.filter((task) => task.synced).length, total: tasks.length });
      })
      .catch(() => {
        if (!cancelled) setTaskStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [props.open, sharedId, props.collab]);

  async function startSharing() {
    if (!props.collab || busy) return;
    setBusy(true);
    setAction("sharing");
    try {
      const created = await props.collab.createProject(props.project.name, props.project.rootPath);
      addCollabProject(created.project);
      try {
        await props.collab.bindLocalProject(created.project.id, props.project.id);
        markCollabProjectBound(created.project.id, props.project.id);
      } catch (cause) {
        // Ok either way: the next launch retries the binding, and reads still go through the same folder.
        console.warn(`Project binding failed: ${messageOf(cause)}`);
      }
      props.onShared();
      // 刚开启协作：关掉设置后看板会走一遍首次引导（本机已看过则不再出现）。
      requestCollabTour(props.project.id);
      if (props.taskCount > 0) {
        // The project already has sessions: the person picks which of them members may read.
        requestTaskPicker(props.project.id);
      } else {
        // Nothing to choose yet; new sessions sync from now on.
        props.onNotice(t("collab.settings.sharedNoTasks"));
      }
    } catch (cause) {
      props.onFailed(messageOf(cause) || t("collab.settings.shareFailed"));
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  async function stopSharing() {
    if (!props.collab || !sharedId || busy) return;
    setBusy(true);
    setAction("stopping");
    try {
      let instructions: CollabInstructionsHandover = "none";
      try {
        instructions = (await props.collab.deleteProject(sharedId))?.instructions ?? "none";
      } catch (cause) {
        // Already gone from the cloud: the switch is off either way, so the local record follows.
        if (!(cause instanceof ApiRequestError && cause.status === 404)) throw cause;
      }
      removeCollabProject(sharedId);
      props.onUnshared();
      // 背景与规范留在创建者的本机项目里：以云端为准覆盖本机旧内容。
      if (instructions === "saved") props.onNotice(t("collab.settings.instructionsKept"));
    } catch (cause) {
      props.onFailed(messageOf(cause) || t("collab.settings.unshareFailed"));
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.settings.title")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.createModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          <span />
          <span className={styles.footerButtons}>
            {/* 开关改动即时生效，没有可取消的东西 */}
            <Button onClick={props.onClose}>{t("common.close")}</Button>
          </span>
        </>
      )}
    >
      {/* 行式列表：左侧标题与说明，右侧控件，行间细线；与设置页同一套排布 */}
      <div className={styles.settingsRows}>
        <div className={styles.settingsRow}>
          <div className={styles.settingsRowText}>
            <div className={styles.settingsRowTitle}>{props.project.name}</div>
            <div className={`${styles.settingsRowDesc} ${styles.settingsRowPath}`} title={props.project.rootPath}>
              {props.project.rootPath}
            </div>
          </div>
          <div className={styles.settingsRowControl}>
            <Button
              size="sm"
              disabled={!clients?.memmyAgent}
              onClick={() => void clients?.memmyAgent?.revealProject(props.project.id, { timeoutMs: 15_000 })}
            >
              {t("collab.settings.reveal")}
            </Button>
          </div>
        </div>

        <div className={styles.settingsRow}>
          <div className={styles.settingsRowText}>
            <div className={styles.settingsRowTitle}>{t("collab.create.share")}</div>
            <div className={styles.settingsRowDesc}>
              {ownedByOther
                ? t("collab.settings.memberHint")
                : sharedId ? t("collab.settings.shareOnHint") : t("collab.settings.shareOffHint")}
            </div>
          </div>
          <div className={styles.settingsRowControl}>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(sharedId)}
              aria-label={t("collab.create.share")}
              // Turning sharing off deletes the cloud project, which only its owner may do.
              disabled={busy || ownedByOther || (!sharedId && !props.collab)}
              onClick={() => {
                if (sharedId) setConfirmStop(true);
                else void startSharing();
              }}
              className={`${styles.settingsSwitch}${sharedId ? ` ${styles.settingsSwitchOn}` : ""}`}
            />
          </div>
        </div>

        {sharedId ? (
          <div className={styles.settingsRow}>
            <div className={styles.settingsRowText}>
              <div className={styles.settingsRowTitle}>{t("collab.settings.sessionsRow")}</div>
              <div className={styles.settingsRowDesc}>
                {taskStats === null
                  ? t("collab.settings.sessionsFallback")
                  : taskStats.total === 0
                    ? t("collab.settings.sessionsEmpty")
                    : t("collab.settings.sessionsHint", {
                      synced: String(taskStats.synced),
                      total: String(taskStats.total)
                    })}
              </div>
            </div>
            <div className={styles.settingsRowControl}>
              <Button size="sm" onClick={props.onPickSessions}>{t("collab.settings.pickSessions")}</Button>
            </div>
          </div>
        ) : null}

        {sharedId && props.onReplayTour ? (
          <div className={styles.settingsRow}>
            <div className={styles.settingsRowText}>
              <div className={styles.settingsRowTitle}>{t("collab.settings.tour.title")}</div>
              <div className={styles.settingsRowDesc}>{t("collab.settings.tour.desc")}</div>
            </div>
            <div className={styles.settingsRowControl}>
              <Button size="sm" onClick={props.onReplayTour}>{t("collab.settings.tour.action")}</Button>
            </div>
          </div>
        ) : null}
      </div>
      {action ? (
        <p className={styles.settingsBusy} role="status">
          {action === "sharing" ? t("collab.settings.sharing") : t("collab.settings.stopping")}
        </p>
      ) : null}
      {confirmStop && sharedId ? (
        <section className={styles.stopSharing} role="alertdialog" aria-label={t("collab.settings.stopTitle")}>
          <b>{t("collab.settings.stopTitle")}</b>
          <p>{t("appFrame.project.stopSharingMessage", { name: props.project.name })}</p>
          <div className={styles.footerButtons}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmStop(false)}>
              {t("collab.cancel")}
            </Button>
            {/* 删除云端项目是破坏性操作，和侧栏确认框一致用 danger */}
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void stopSharing()}>
              {t("appFrame.project.stopSharing")}
            </Button>
          </div>
        </section>
      ) : null}
    </Modal>
  );
}

/**
 * A cloud session read as a conversation: the person's question, then the Agent's answer.
 * Tool steps stay in the stored transcript and are not drawn here. Members can read each other's
 * sessions, but only the person who shared one can delete it, which the board's row menu already enforces.
 *
 * It floats on the right of the board rather than opening as a dialog: the list stays visible, so reading
 * someone else's task never loses the place it came from.
 */
function SessionReaderPanel(props: {
  session: { session: CollabProjectSession; turns: CollabSessionTurn[] } | null;
  loading: boolean;
  onClose: () => void;
  onCopy: (session: CollabProjectSession) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const data = props.session;
  const open = data !== null;
  const name = data ? data.session.memberName || (data.session.mine ? t("collab.session.you") : "") : "";
  const agentName = data ? agentSourceDisplayName(data.session.source) || "Agent" : "";
  const agentLogo = data ? agentSourceLogoUrl(data.session.source) : undefined;

  // Esc closes the panel and focus moves into it while it is open, so a reader who never touches the mouse still
  // ends up in the task they just opened.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, props.onClose]);

  if (!data) return null;

  const spoken = (data.turns.flatMap((turn) => {
    const question = visibleQuestion(turn.question);
    const reply = visibleReply(turn.reply);
    return question || reply ? [{ question, reply, startedAt: turn.startedAt }] : [];
  })).map((turn, index) => ({ ...turn, number: index + 1 }));
  // 一个任务只来自一个 Agent：名字与图标只标一次，回复正文保持干净。
  const firstAgent = spoken.findIndex((turn) => turn.reply);
  const moment = stampLabel(taskStamp(data.session.lastActiveAt), t);
  const when = taskDayGroup(data.session.lastActiveAt) === "today"
    ? `${t("collab.sessions.group.today")} ${moment}`
    : moment;

  return createPortal(
    <div className={styles.readerLayer}>
      {/* 不压暗看板：只铺一层几乎看不出的薄雾，点击面板外即关闭 */}
      <button
        type="button"
        className={styles.readerScrim}
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={props.onClose}
      />
      <aside
        ref={panelRef}
        className={styles.readerPanel}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-collab-reader=""
        tabIndex={-1}
      >
        <header className={styles.readerHead}>
          <span
            className={`${styles.avatar} ${styles.avatarSoft} ${styles.readerHeadAvatar}`}
            style={{ "--member": memberColor(name) } as CSSProperties}
            aria-hidden="true"
          >
            {Array.from(name)[0] ?? "?"}
          </span>
          <div className={styles.readerHeadText}>
            <h2 id={titleId} className={styles.readerTitle}>{data.session.title}</h2>
            <div className={styles.readerHeadMeta}>
              <span>{[name, when].filter(Boolean).join(" · ")}</span>
              {data.session.mine ? null : <span className={styles.readerBadge}>{t("collab.reader.readOnly")}</span>}
            </div>
          </div>
          <div className={styles.readerActions}>
            <button
              type="button"
              className={styles.readerAction}
              aria-label={t("collab.session.copyLink")}
              title={t("collab.session.copyLink")}
              onClick={() => props.onCopy(data.session)}
            >
              <Link2 size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.readerAction}
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={props.onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className={styles.readerBody}>
          {data.session.trimmed ? (
            <p className={styles.readerTrimmed}>{t("collab.reader.trimmed")}</p>
          ) : null}
          {spoken.length === 0 ? (
            <p className={styles.loading}>{t("collab.reader.empty")}</p>
          ) : spoken.map((turn, index) => {
            // 打开面板时只有开头几轮真在屏上：其余的先按估算高度占位，滚到附近再由 AgentMessageContent
            // 自己展开。否则一个长任务的全部 Markdown、代码块会在同一次提交里算完，点击要等几百毫秒。
            const defer = index >= READER_IMMEDIATE_TURNS && Boolean(turn.reply) && isLikelyExpensiveAgentMarkdown(turn.reply);
            return (
              <article key={`${turn.startedAt}-${turn.number}`} className={styles.readerTurn}>
                {spoken.length > 1 ? (
                  <span className={styles.readerTurnIndex}>{t("collab.reader.turn", { index: String(turn.number) })}</span>
                ) : null}
                {turn.question ? (
                  <div className={styles.readerUser} data-collab-role="user">
                    <p className={styles.readerUserBubble}>{turn.question}</p>
                  </div>
                ) : null}
                {turn.reply ? (
                  <div className={styles.readerAgent} data-collab-role="agent">
                    {turn.number === spoken[firstAgent]?.number ? (
                      <div className={styles.readerAgentHead}>
                        {agentLogo ? (
                          <img className={styles.readerAgentLogo} src={agentLogo} alt="" />
                        ) : (
                          <span className={styles.readerAgentMark} aria-hidden="true">{Array.from(agentName)[0] ?? "A"}</span>
                        )}
                        <span>{agentName}</span>
                      </div>
                    ) : null}
                    <AgentMessageContent
                      content={turn.reply}
                      readOnlyFileReferences
                      deferRender={defer}
                      deferredRevealDelayMs={defer
                        ? READER_DEFERRED_REVEAL_START_MS + (index - READER_IMMEDIATE_TURNS) * READER_DEFERRED_REVEAL_STEP_MS
                        : 0}
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
        <footer className={styles.readerFoot}>{t("collab.reader.hint")}</footer>
      </aside>
    </div>,
    document.body
  );
}

/**
 * Cursor stores the host envelope in the user bubble. The person typed the `<user_query>` body;
 * a bubble that is only a system notification has nothing to show.
 */
export function visibleQuestion(text: string): string {
  const queries = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/giu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((query) => query.length > 0);
  return withoutCursorTaskFollowup(stripHostEnvelope(queries.length > 0 ? queries.join("\n\n") : text));
}

/** Drops a host envelope that leaked into an answer. The answer itself stays. */
export function visibleReply(text: string): string {
  return stripHostEnvelope(text);
}

function stripHostEnvelope(text: string): string {
  return text
    .replace(/<(timestamp|system_notification|system[_-]reminder|image_files|open_and_recently_viewed_files)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .trim();
}

/** Cursor writes this into `<user_query>` when a background task ends. It is not something the person typed. */
function withoutCursorTaskFollowup(text: string): string {
  return text
    .replace(/briefly inform the user about the task result and perform any follow-up actions \(if needed\)\.\s*if there['’]s no follow-ups needed, don['’]t explicitly say that\.?/giu, "")
    .trim();
}

/** 新建项目: an online project (default) or a local one, per the prototype. */
export function AssociateSessionsModal(props: {
  open: boolean;
  collab: CollabClient;
  project: CollabProject;
  onClose: () => void;
  onLinked: (result: CollabSyncResult) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<LocalAgentSession[] | null>(null);
  const [saved, setSaved] = useState<CollabLinks>(EMPTY_LINKS);
  const [links, setLinks] = useState<CollabLinks>(EMPTY_LINKS);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlinkGroup, setConfirmUnlinkGroup] = useState(false);
  const { collab, open, project } = props;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConfirmUnlinkGroup(false);
    setSessions(null);
    setSaved(EMPTY_LINKS);
    setLinks(EMPTY_LINKS);
    setAgentId(null);
    setQuery("");
    setExpanded(new Set());
    setError(null);
    // The last scan shows at once; when it is older, the newer list replaces it a few seconds later.
    Promise.all([collab.listLocalSessions({ limit: MAX_LOCAL_SESSIONS }), collab.getLinks(project.id)])
      .then(([listing, current]) => {
        if (cancelled) return;
        setSessions(listing.sessions);
        setSaved(current);
        setLinks(current);
        if (!listing.refreshing) return;
        void collab.listLocalSessions({ limit: MAX_LOCAL_SESSIONS, fresh: true })
          .then((fresh) => {
            if (!cancelled) setSessions(fresh.sessions);
          })
          .catch(() => undefined);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [collab, open, project.id]);

  const agents = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of sessions ?? []) if (!seen.has(session.sourceId)) seen.set(session.sourceId, session.agentName);
    return [...seen.entries()].map(([sourceId, name]) => ({ sourceId, name }));
  }, [sessions]);
  /**
   * 列表用的 Agent 比导航栏慢一帧：点一下立刻看到选中态，列表的内容跟着补上。
   * 两者在稳定后始终一致，只是渲染优先级不同。
   */
  const shownAgentId = useDeferredValue(agentId);
  const activeAgent = agents.find((agent) => agent.sourceId === shownAgentId) ?? agents.find((agent) => agentHasLinks(links, agent.sourceId)) ?? agents[0] ?? null;
  const kind = activeAgent ? groupingKind(activeAgent.sourceId) : "directory";
  const view = useMemo(
    () => (activeAgent ? groupAgentSessions(sessions ?? [], activeAgent.sourceId, query) : { groups: [], ungrouped: [] }),
    [activeAgent, query, sessions]
  );
  // 每次渲染都把两份勾选树串成 JSON 再排序很浪费：两者都不变时沿用上一次的结果。
  const changed = useMemo(() => !linksEqual(links, saved), [links, saved]);
  /** 当前勾选会关联的任务数，用于在提交前提示云端只保留最近 20 个。 */
  const selectedCount = useMemo(
    () => (sessions ?? []).filter((session) => isSessionChecked(links, session)).length,
    [sessions, links]
  );

  function toggleExpanded(groupId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function confirm() {
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onLinked(await collab.saveLinks(project.id, links));
    } catch {
      // A multi-task unlink can have succeeded in part; keep the selection so the person can retry.
      setError(t("collab.pick.saveFailedRetry"));
    } finally {
      setBusy(false);
    }
  }

  function requestSave() {
    if (!changed || busy) return;
    // Only removing a previously saved whole group needs confirmation; exclusions of individual sessions do not.
    const removedGroup = saved.groups.some((group) => !findGroupLink(links, group.sourceId, group.groupId));
    if (removedGroup) setConfirmUnlinkGroup(true);
    else void confirm();
  }

  function sessionRow(session: LocalAgentSession, nested: boolean) {
    const checked = isSessionChecked(links, session);
    const excluded = !checked && Boolean(session.group && findGroupLink(links, session.sourceId, session.group.id));
    const summary = readableSummary(session.lastQuestion);
    return (
      <label key={localSessionKey(session)} className={`${styles.pickRow} ${nested ? styles.pickRowNested : ""}`}>
        <input type="checkbox" checked={checked} onChange={() => setLinks((current) => toggleSessionLink(current, session))} />
        <span className={`${styles.pickTitle} ${excluded ? styles.pickTitleExcluded : ""}`} title={summary || session.title}>{session.title}</span>
        <span className={styles.meta}>{excluded ? t("collab.pick.excluded") : formatSessionTime(session.updatedAt)}</span>
      </label>
    );
  }

  /**
   * 列表本体只在数据真的变化时重建。切换 Agent 时导航栏的选中态立刻画出来，
   * 列表的重建留到下一帧（`useDeferredValue`），点击不必等这份渲染完才有反馈。
   */
  const pickerList = useMemo(() => (
        <div className={styles.pickList}>
          {sessions === null && !error ? (
            <p className={styles.loading}>{t("collab.pick.loading")}</p>
          ) : !view.groups.length && !view.ungrouped.length ? (
            <p className={styles.loading}>{t("collab.pick.empty")}</p>
          ) : (
            <>
              {view.groups.length ? <p className={styles.pickSection}>{t(`collab.pick.unit.${kind}` as MessageKey)}</p> : null}
              {view.groups.map((item) => {
                const state = groupCheckState(links, activeAgent!.sourceId, item);
                const isOpen = Boolean(query.trim()) || expanded.has(item.group.id);
                const GroupIcon = kind === "directory" ? Folder : Layers;
                return (
                  <div key={item.group.id} className={styles.groupBlock}>
                    <div className={styles.groupRow}>
                      <input
                        type="checkbox"
                        aria-label={item.group.label}
                        checked={state === "checked"}
                        ref={(element) => {
                          if (element) element.indeterminate = state === "mixed";
                        }}
                        onChange={() => setLinks((current) => {
                          // Search narrows visible rows, not the scope of the whole-group operation.
                          const complete = groupAgentSessions(sessions ?? [], activeAgent!.sourceId, "").groups
                            .find((group) => group.group.id === item.group.id) ?? item;
                          return toggleGroupLink(current, activeAgent!.sourceId, complete);
                        })}
                      />
                      <button type="button" className={styles.groupToggle} aria-expanded={isOpen} title={item.group.path ?? item.group.label} onClick={() => toggleExpanded(item.group.id)}>
                        <span className={styles.groupIcon}><GroupIcon size={15} aria-hidden="true" /></span>
                        <span className={styles.groupText}>
                          <span className={styles.groupName}>{item.group.label}</span>
                          {findGroupLink(links, activeAgent!.sourceId, item.group.id) ? <span className={styles.groupHint}>{t("collab.pick.wholeGroup")}</span> : null}
                        </span>
                        {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                      </button>
                    </div>
                    {isOpen ? item.sessions.map((session) => sessionRow(session, true)) : null}
                  </div>
                );
              })}
              {view.ungrouped.length ? <p className={styles.pickSection}>{t(`collab.pick.ungrouped.${kind}` as MessageKey)}</p> : null}
              {view.ungrouped.map((session) => sessionRow(session, false))}
            </>
          )}
        </div>
  ), [error, sessions, view, kind, activeAgent, links, expanded, query, t]);

  return (
    <>
    <Modal
      open={props.open}
      title={t("collab.pick.title")}
      subtitle={t("collab.pick.subtitle", { project: project.name })}
      onClose={busy || confirmUnlinkGroup ? undefined : props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.pickModal}
      backdropClassName={styles.backdrop}
      footer={(
        <>
          {error ? <span className={styles.error} role="alert">{error}</span> : selectedCount > SESSIONS_PER_MEMBER_LIMIT ? (
            <span className={styles.pickLimit} role="status">
              {t("collab.pick.limitHint", { limit: String(SESSIONS_PER_MEMBER_LIMIT) })}
            </span>
          ) : <span />}
          <span className={styles.footerButtons}>
            <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button variant="primary" disabled={!changed || busy} onClick={requestSave}>
              {busy ? t("collab.pick.saving") : t("collab.pick.save")}
            </Button>
          </span>
        </>
      )}
    >
      <div className={styles.pickBody}>
        <nav className={styles.agentList} aria-label="Agent">
          {agents.map((agent) => {
            const logo = agentSourceLogoUrl(agent.sourceId);
            const active = agent.sourceId === (agentId ?? activeAgent?.sourceId);
            return (
              <button
                key={agent.sourceId}
                type="button"
                aria-pressed={active}
                className={`${styles.agentItem} ${active ? styles.agentItemActive : ""}`}
                onClick={() => {
                  setAgentId(agent.sourceId);
                  setQuery("");
                }}
              >
                <span className={styles.agentLogo}>{logo ? <img src={logo} alt="" /> : null}</span>
                <span className={styles.agentText}>
                  <span className={styles.agentName}>{agentSourceDisplayName(agent.sourceId) || agent.name}</span>
                  <span className={styles.agentHint}>{t(`collab.pick.groupBy.${groupingKind(agent.sourceId)}` as MessageKey)}</span>
                </span>
                {agentHasLinks(links, agent.sourceId) ? <span className={styles.agentDot} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </nav>
        <section className={styles.pickMain}>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              placeholder={activeAgent ? t("collab.pick.searchIn", { agent: agentSourceDisplayName(activeAgent.sourceId) || activeAgent.name }) : t("collab.pick.search")}
              aria-label={t("collab.pick.search")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {pickerList}
        </section>
      </div>
    </Modal>
    <ConfirmDialog
      open={props.open && confirmUnlinkGroup}
      title={t("collab.pick.unlinkGroupTitle")}
      message={t("collab.pick.unlinkGroupMessage")}
      cancelLabel={t("collab.cancel")}
      confirmLabel={t("collab.pick.unlinkGroupConfirm")}
      confirmVariant="danger"
      icon={null}
      onCancel={() => setConfirmUnlinkGroup(false)}
      onConfirm={() => {
        setConfirmUnlinkGroup(false);
        void confirm();
      }}
    />
    </>
  );
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
