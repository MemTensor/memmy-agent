import { useEffect, useRef, useState } from "react";
import type { PanelTaskItem } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { formatMessage, type MessageKey, type MessageValues, type ResolvedLanguage, zhCNMessages } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { ChevronRight, ListChecks, Search, X } from "./memory-prototype-icons.js";
import { MemoryDrawerDeleteAction } from "./memory-delete-action.js";
import { MemoryMarkdown } from "./memory-markdown.js";
import {
  clearMemoryPanelCache,
  memoryPanelCacheKey,
  readMemoryPanelCacheFirst,
  writeMemoryPanelCaches
} from "./memory-panel-cache.js";
import { type MemoryPageInfo, MemoryPagination, normalizePage } from "./memory-pagination.js";
import { MemoryRefreshButton } from "./memory-refresh-button.js";
import { MemoryStateBox } from "./memory-state-box.js";
import { type RemoteData, toErrorMessage } from "./remote-state.js";

export interface TasksSubPageProps {
  client: MemoryRuntimeClient | null;
}

export interface MemoryTasksOutput extends MemoryPageInfo {
  tasks: MemoryTask[];
}

export interface MemoryTask {
  id: string;
  memoryIds: string[];
  title: string;
  summary: string;
  source: string;
  status: TaskStatus;
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  turnCount?: number;
  memoryCount: number;
  toolCallCount: number;
  rTask?: number;
  skillStatus?: TaskSkillStatus;
  skillReason?: string;
  statusReason?: string;
  chat: TaskChatMessage[];
}

type TaskStatus = "active" | "completed" | "skipped" | "failed" | string;

type TaskSkillStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "generating"
  | "generated"
  | "upgraded"
  | "not_generated"
  | "skipped"
  | string;

interface TaskChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "thinking";
  text?: string;
  createdAt?: string;
  tool?: TaskToolCall;
}

interface TaskTurn {
  id?: string;
  turnId?: string;
  createdAt?: string;
  userText?: string;
  assistantText?: string;
  reasoningSummary?: string;
  toolCalls: TaskToolCall[];
}

interface TaskToolCall {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  success?: boolean;
  startedAt?: string | number;
  endedAt?: string | number;
  thinkingBefore?: string;
  assistantTextBefore?: string;
}

type TaskEpisode = PanelTaskItem["episode"];

type TasksState = RemoteData<MemoryTasksOutput>;
type Translate = (key: MessageKey, values?: MessageValues) => string;
const defaultTranslate: Translate = (key, values) => formatMessage(zhCNMessages[key], values);
const TASKS_CACHE_SECTION = "tasks";
const TASKS_REFRESH_INTERVAL_MS = 5_000;

export async function loadTasksData(client: MemoryRuntimeClient, query = "", page = 1, t: Translate = defaultTranslate): Promise<MemoryTasksOutput> {
  const list = await client.listPanelTasks({ q: query.trim() || undefined, page: normalizePage(page) });

  return {
    tasks: list.tasks.map((task) => taskFromPanelItem(task, t)),
    page: list.page,
    pageSize: list.pageSize,
    total: list.total,
    totalPages: list.totalPages,
    hasNext: list.hasNext,
    hasPrev: list.hasPrev
  };
}

function tasksCacheKeys(query: string, page: number, language: ResolvedLanguage = "zh-CN"): string[] {
  return [
    memoryPanelCacheKey(TASKS_CACHE_SECTION, language, query.trim(), normalizePage(page))
  ];
}

export function TasksSubPage(props: TasksSubPageProps) {
  const { t, language } = useTranslation();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<TasksState>({ status: "loading" });
  const [selectedTask, setSelectedTask] = useState<MemoryTask | null>(null);
  const requestIdRef = useRef(0);

  function refresh(nextPage = page, options: { useCache?: boolean } = {}): Promise<void> {
    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }

    const normalizedPage = normalizePage(nextPage);
    const requestId = ++requestIdRef.current;
    const cacheKeys = tasksCacheKeys(query, normalizedPage, language);
    const cached = (options.useCache ?? true) ? readMemoryPanelCacheFirst<MemoryTasksOutput>(cacheKeys) : null;
    if (cached) {
      setState({ status: "ready", data: cached });
    } else {
      setState((current) => current.status === "ready" ? current : { status: "loading" });
    }

    return loadTasksData(props.client, query, normalizedPage, t)
      .then((data) => {
        writeMemoryPanelCaches(cacheKeys, data);
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState({ status: "ready", data });
        if (data.page !== normalizedPage) {
          setPage(data.page);
        }
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState({ status: "error", message: toErrorMessage(error) });
        throw error;
      });
  }

  function changeQuery(value: string) {
    setQuery(value);
    setSelectedTask(null);
    setPage(1);
  }

  function runSearch() {
    setSelectedTask(null);
    setPage(1);
    void refresh(1).catch(() => undefined);
  }

  function changePage(nextPage: number) {
    const normalizedPage = normalizePage(nextPage);
    if (normalizedPage === page) {
      return;
    }

    setSelectedTask(null);
    setPage(normalizedPage);
  }

  async function deleteTask(task: MemoryTask) {
    if (!props.client) {
      throw new Error(t("memory.clientNotReady"));
    }

    await props.client.deletePanelTask(task.id);
    clearMemoryPanelCache();
    setSelectedTask(null);
    void refresh(page, { useCache: false }).catch(() => undefined);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh().catch(() => undefined), 180);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, query, page, t, language]);

  useEffect(() => {
    if (!props.client) {
      return undefined;
    }
    const interval = window.setInterval(() => void refresh(page, { useCache: false }).catch(() => undefined), TASKS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, query, page, t, language]);

  return (
    <TasksSubPageView
      state={state}
      query={query}
      selectedTask={selectedTask}
      onQueryChange={changeQuery}
      onSearch={runSearch}
      onPageChange={changePage}
      onRefresh={() => refresh(page, { useCache: false })}
      onOpenTask={setSelectedTask}
      onDeleteTask={deleteTask}
      onCloseTask={() => setSelectedTask(null)}
    />
  );
}

export interface TasksSubPageViewProps {
  state: TasksState;
  query: string;
  selectedTask?: MemoryTask | null;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void | Promise<void>;
  onOpenTask: (task: MemoryTask) => void;
  onDeleteTask: (task: MemoryTask) => Promise<void>;
  onCloseTask: () => void;
}

export function TasksSubPageView(props: TasksSubPageViewProps) {
  const { t } = useTranslation();

  return (
    <section className="memory-panel">
      <div className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h3 className="memory-panel__title">
            <ListChecks size={18} className="text-text-ink/60" />
            {t("memory.tasks.title")}
          </h3>
          <p className="memory-panel__subtitle">{t("memory.tasks.subtitle")}</p>
        </div>
        <MemoryRefreshButton onClick={props.onRefresh} />
      </div>
      <div className="memory-toolbar">
        <label className="memory-search">
          <Search size={15} className="memory-search__icon" />
          <input
            type="search"
            value={props.query}
            placeholder={t("memory.tasks.searchPlaceholder")}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                props.onSearch();
              }
            }}
            className="memory-search__input"
          />
        </label>
      </div>

      {props.state.status === "loading" && <MemoryStateBox message={t("memory.tasks.loading")} />}
      {props.state.status === "error" && <MemoryStateBox message={props.state.message} tone="error" />}
      {props.state.status === "ready" && props.state.data.tasks.length === 0 && <MemoryStateBox message={t("memory.tasks.empty")} />}
      {props.state.status === "ready" && props.state.data.tasks.length > 0 && (
        <div className="memory-list">
          {props.state.data.tasks.map((task) => {
            const skillLabel = task.skillStatus ? skillStatusLabel(task.skillStatus, t) : "";
            return (
              <article
                key={task.id}
                role="button"
                tabIndex={0}
                onClick={() => props.onOpenTask(task)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onOpenTask(task);
                  }
                }}
                className={`memory-card${props.selectedTask?.id === task.id ? " memory-card--selected" : ""}`}
              >
                <div className="memory-card__body">
                  <div className="memory-card__title">{task.title}</div>
                  <div className="memory-card__summary">{task.summary}</div>
                  <div className="memory-card__meta">
                    <span className={`memory-pill memory-pill--task-${taskStatusTone(task.status)}`}>{taskStatusLabel(task.status, t)}</span>
                    {skillLabel && <span className={`memory-pill memory-pill--skill-${skillStatusTone(task.skillStatus)}`}>{skillLabel}</span>}
                    <span>{`${t("memory.tasks.startedAt")}: ${formatDateTime(task.startedAt)}`}</span>
                    {task.endedAt && <span>{`${t("memory.tasks.endedAt")}: ${formatDateTime(task.endedAt)}`}</span>}
                    {task.turnCount !== undefined && <span>{t("memory.tasks.turnCount", { count: task.turnCount })}</span>}
                    {task.toolCallCount > 0 && <span>{t("memory.tasks.toolCount", { count: task.toolCallCount })}</span>}
                    {task.rTask !== undefined && <span>{`${t("memory.tasks.rTask")} ${formatDecimal(task.rTask, 2)}`}</span>}
                  </div>
                </div>
                <div className="memory-card__tail">
                  <ChevronRight size={16} />
                </div>
              </article>
            );
          })}
        </div>
      )}
      {props.state.status === "ready" && <MemoryPagination data={props.state.data} onPageChange={props.onPageChange} />}

      {props.selectedTask && <TaskDetailDrawer task={props.selectedTask} onClose={props.onCloseTask} onDelete={props.onDeleteTask} />}
    </section>
  );
}

function TaskDetailDrawer(props: { task: MemoryTask; onClose: () => void; onDelete: (task: MemoryTask) => Promise<void> }) {
  const { t } = useTranslation();
  const task = props.task;
  const skillLabel = task.skillStatus ? skillStatusLabel(task.skillStatus, t) : t("memory.tasks.skill.queued");
  const reason = firstOptionalString(task.statusReason, task.skillReason);

  return (
    <div className="memory-drawer-backdrop" onClick={props.onClose}>
      <button type="button" className="memory-drawer-backdrop__close" tabIndex={-1} aria-hidden="true" onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }} />
      <aside className="memory-drawer" role="dialog" aria-modal="true" aria-labelledby="memory-task-title" onClick={(e) => e.stopPropagation()}>
        <header className="memory-drawer__header">
          <div>
            <div className="memory-drawer__identity">
              <span className="memory-drawer__eyebrow">{task.id}</span>
            </div>
            <h4 id="memory-task-title" className="memory-drawer__title">{task.title}</h4>
          </div>
          <button type="button" onClick={props.onClose} className="memory-drawer__close" aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>
        <div className="memory-drawer__body">
          <section className="memory-detail-card memory-detail-card--meta">
            <h5 className="memory-detail-card__label">{t("memory.memories.traceMeta")}</h5>
            <div className="memory-detail-metrics">
              <MemoryMetric label={t("memory.tasks.status")} value={taskStatusLabel(task.status, t)} />
              <MemoryMetric label={t("memory.tasks.startedAt")} value={formatDateTime(task.startedAt)} />
              <MemoryMetric label={t("memory.tasks.endedAt")} value={task.endedAt ? formatDateTime(task.endedAt) : "-"} />
              <MemoryMetric label={t("memory.tasks.rTask")} value={formatDecimal(task.rTask, 2)} />
              <MemoryMetric label={t("memory.tasks.skillStatus")} value={skillLabel} />
            </div>
            {reason && (
              <div className="memory-task-status-reason">
                <span>{t("memory.tasks.reason")}</span>
                {reason}
              </div>
            )}
          </section>

          <section className="memory-detail-card">
            <h5 className="memory-detail-card__label">{t("memory.tasks.conversation")}</h5>
            {task.chat.length > 0 ? (
              <TaskChatLog messages={task.chat} />
            ) : (
              <MemoryStateBox message={t("memory.tasks.noConversation")} />
            )}
          </section>
        </div>
        <MemoryDrawerDeleteAction onDelete={() => props.onDelete(task)} />
      </aside>
    </div>
  );
}

function TaskChatLog(props: { messages: TaskChatMessage[] }) {
  return (
    <div className="memory-task-chat">
      {props.messages.map((message) => (
        <TaskChatBubble key={message.id} message={message} />
      ))}
    </div>
  );
}

function TaskChatBubble(props: { message: TaskChatMessage }) {
  const { t } = useTranslation();
  const message = props.message;
  const toolDuration = message.role === "tool" && message.tool
    ? formatToolDuration(message.tool.startedAt, message.tool.endedAt)
    : "";
  const roleLabel = message.role === "user"
    ? t("memory.tasks.chat.role.user")
    : message.role === "assistant"
      ? t("memory.tasks.chat.role.assistant")
      : message.role === "thinking"
        ? t("memory.tasks.chat.role.thinking")
        : `${t("memory.tasks.chat.role.tool")} · ${message.tool?.name ?? "tool"}`;

  return (
    <div className={`memory-chat-item memory-chat-item--${message.role}`}>
      <div className="memory-chat-avatar" aria-hidden="true">{chatAvatar(message.role)}</div>
      <div className="memory-chat-content">
        <div className="memory-chat-meta">
          <span className="memory-chat-role">{roleLabel}</span>
          {message.createdAt && <span className="memory-chat-time">{formatTime(message.createdAt)}</span>}
          {message.role === "tool" && message.tool?.success === false && <span className="memory-chat-status memory-chat-status--error">{t("memory.tasks.toolFailed")}</span>}
          {message.role === "tool" && message.tool?.success !== false && <span className="memory-chat-status">{t("memory.tasks.toolOk")}</span>}
          {toolDuration && <span className="memory-chat-duration">{toolDuration}</span>}
        </div>
        <div className="memory-chat-bubble">
          {message.role === "tool" && message.tool ? (
            <TaskToolBubble tool={message.tool} />
          ) : (
            <MemoryMarkdown text={message.text ?? ""} />
          )}
        </div>
      </div>
    </div>
  );
}

function TaskToolBubble(props: { tool: TaskToolCall }) {
  const { t } = useTranslation();
  const input = props.tool.input === undefined ? "" : formatPayload(props.tool.input);
  const output = props.tool.output === undefined ? "" : formatPayload(props.tool.output);
  const error = props.tool.error ?? "";

  return (
    <div className="memory-chat-tool">
      {input && <TaskToolPayload label={t("memory.tasks.toolInput")} value={input} />}
      {output && <TaskToolPayload label={t("memory.tasks.toolOutput")} value={output} />}
      {error && <TaskToolPayload label={t("memory.tasks.toolError")} value={error} open />}
      {!input && !output && !error && <div className="memory-chat-tool__empty">{t("memory.tasks.toolEmpty")}</div>}
    </div>
  );
}

function TaskToolPayload(props: { label: string; value: string; open?: boolean }) {
  return (
    <details className="memory-tool-section" open={props.open}>
      <summary>{props.label}</summary>
      <pre className="memory-tool-pre">{clipPayload(props.value)}</pre>
    </details>
  );
}

function MemoryMetric(props: { label: string; value: string }) {
  return (
    <div className="memory-detail-metric">
      <div className="memory-detail-metric__label">{props.label}</div>
      <div className="memory-detail-metric__value">{props.value}</div>
    </div>
  );
}

function taskFromPanelItem(item: PanelTaskItem, t: Translate): MemoryTask {
  const episode = item.episode;
  const turns: TaskTurn[] = item.turns.map((turn) => ({
    id: turn.rawTurnId,
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    userText: turn.userText,
    assistantText: turn.assistantText,
    reasoningSummary: turn.reasoningSummary,
    toolCalls: arrayValue(turn.toolCalls).map(readToolCall).filter((call): call is TaskToolCall => Boolean(call))
  }));
  const chat = turns.flatMap((turn, index) => messagesForTurn(turn, index));
  const status = deriveTaskStatus(episode, chat);
  const startedAt = firstString(episode.startedAt, turns[0]?.createdAt, item.updatedAt);
  const title = truncate(firstString(episode.title, episode.summary, firstChatText(chat, "user"), episode.id), 100);
  const summary = truncate(firstString(episode.summary, firstChatText(chat, "assistant"), title), 180);

  return {
    id: item.id,
    memoryIds: item.memoryIds,
    title,
    summary,
    source: episode.sessionId,
    status,
    startedAt,
    endedAt: episode.endedAt,
    updatedAt: item.updatedAt,
    turnCount: episode.turnCount ?? uniqueChatUserTurns(chat),
    memoryCount: item.memoryIds.length,
    toolCallCount: chat.filter((message) => message.role === "tool").length,
    rTask: episode.rTask,
    skillStatus: deriveTaskSkillStatus(episode),
    skillReason: firstOptionalString(episode.skillReason, episode.pipelineError),
    statusReason: taskStatusReason(episode, status, t),
    chat
  };
}

function messagesForTurn(turn: TaskTurn, index: number): TaskChatMessage[] {
  const key = firstString(turn.id, turn.turnId, turn.createdAt, String(index));
  const messages: TaskChatMessage[] = [];

  if (turn.userText) {
    messages.push({
      id: `${key}:user`,
      role: "user",
      text: turn.userText,
      createdAt: turn.createdAt
    });
  }

  const hasToolThinking = turn.toolCalls.some((tool) => Boolean(tool.thinkingBefore?.trim()));
  let remainingThinking = normalizeTurnThinking(turn.reasoningSummary ?? "");
  if (!hasToolThinking && remainingThinking) {
    messages.push({
      id: `${key}:thinking`,
      role: "thinking",
      text: remainingThinking,
      createdAt: turn.createdAt
    });
    remainingThinking = "";
  }

  let lastThinkingBefore = "";
  let lastAssistantBefore = "";
  for (const [toolIndex, tool] of turn.toolCalls.entries()) {
    const thinkingBefore = normalizeTurnThinking(tool.thinkingBefore ?? "");
    if (thinkingBefore && thinkingBefore !== lastThinkingBefore) {
      messages.push({
        id: `${key}:thinking:tool:${tool.id ?? toolIndex}`,
        role: "thinking",
        text: thinkingBefore,
        createdAt: normalizeToolTime(tool.startedAt) ?? turn.createdAt
      });
      remainingThinking = removeFirstTurnThinking(remainingThinking, thinkingBefore);
      lastThinkingBefore = thinkingBefore;
    } else if (!thinkingBefore) {
      lastThinkingBefore = "";
    }

    const assistantBefore = tool.assistantTextBefore?.trim() ?? "";
    if (assistantBefore && assistantBefore !== lastAssistantBefore) {
      messages.push({
        id: `${key}:assistant:tool:${tool.id ?? toolIndex}`,
        role: "assistant",
        text: assistantBefore,
        createdAt: normalizeToolTime(tool.startedAt) ?? turn.createdAt
      });
      lastAssistantBefore = assistantBefore;
    } else if (!assistantBefore) {
      lastAssistantBefore = "";
    }

    messages.push({
      id: `${key}:tool:${tool.id ?? tool.name}:${toolIndex}`,
      role: "tool",
      createdAt: normalizeToolTime(tool.startedAt) ?? turn.createdAt,
      tool
    });
  }

  remainingThinking = normalizeTurnThinking(remainingThinking);
  if (remainingThinking) {
    messages.push({
      id: `${key}:thinking:remaining`,
      role: "thinking",
      text: remainingThinking,
      createdAt: turn.createdAt
    });
  }

  if (turn.assistantText) {
    messages.push({
      id: `${key}:assistant`,
      role: "assistant",
      text: turn.assistantText,
      createdAt: turn.createdAt
    });
  }

  return messages;
}

function readToolCall(value: unknown): TaskToolCall | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: stringValue(value.id),
    name: stringValue(value.name) || "tool",
    input: value.input,
    output: value.output,
    error: stringValue(value.error),
    success: typeof value.success === "boolean" ? value.success : undefined,
    startedAt: timeValue(value.startedAt),
    endedAt: timeValue(value.endedAt),
    thinkingBefore: firstOptionalString(stringValue(value.thinkingBefore), stringValue(value.thinking_before)),
    assistantTextBefore: firstOptionalString(stringValue(value.assistantTextBefore), stringValue(value.assistant_text_before))
  };
}

function firstChatText(chat: TaskChatMessage[], role: TaskChatMessage["role"]): string | undefined {
  return chat.find((message) => message.role === role && message.text?.trim())?.text;
}

function normalizeToolTime(value: string | number | undefined): string | undefined {
  if (typeof value === "number") {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  return value;
}

function normalizeTurnThinking(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function removeFirstTurnThinking(source: string, segment: string): string {
  const normalizedSource = normalizeTurnThinking(source);
  const normalizedSegment = normalizeTurnThinking(segment);
  if (!normalizedSource || !normalizedSegment) return normalizedSource;
  const index = normalizedSource.indexOf(normalizedSegment);
  if (index < 0) return normalizedSource;
  return normalizeTurnThinking([
    normalizedSource.slice(0, index),
    normalizedSource.slice(index + normalizedSegment.length)
  ].filter(Boolean).join("\n\n"));
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function formatDecimal(value: number | undefined, digits = 3): string {
  if (value === undefined) {
    return "-";
  }

  const factor = 10 ** digits;
  return (Math.round((value + Number.EPSILON) * factor) / factor).toFixed(digits);
}

function formatToolDuration(startedAt: string | number | undefined, endedAt: string | number | undefined): string {
  const start = timeToMillis(startedAt);
  const end = timeToMillis(endedAt);

  if (start === undefined || end === undefined || end < start) {
    return "";
  }

  return `${Math.round(end - start)} ms`;
}

function timeToMillis(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function taskStatusLabel(status: TaskStatus, t: Translate): string {
  const keyByStatus: Record<string, MessageKey> = {
    active: "memory.tasks.status.active",
    completed: "memory.tasks.status.completed",
    skipped: "memory.tasks.status.skipped",
    failed: "memory.tasks.status.failed",
    open: "memory.tasks.status.active",
    processing: "memory.tasks.status.active",
    closed: "memory.tasks.status.completed"
  };

  return t(keyByStatus[status] ?? "memory.tasks.status.unknown");
}

function taskStatusTone(status: TaskStatus): string {
  if (status === "completed" || status === "closed") return "closed";
  if (status === "skipped") return "skipped";
  if (status === "failed") return "failed";
  return "open";
}

function skillStatusLabel(status: TaskSkillStatus, t: Translate): string {
  const keyByStatus: Record<string, MessageKey> = {
    queued: "memory.tasks.skill.queued",
    running: "memory.tasks.skill.running",
    succeeded: "memory.tasks.skill.succeeded",
    skipped: "memory.tasks.skill.skipped",
    failed: "memory.tasks.skill.failed",
    generating: "memory.tasks.skill.running",
    generated: "memory.tasks.skill.succeeded",
    upgraded: "memory.tasks.skill.succeeded",
    not_generated: "memory.tasks.skill.skipped"
  };

  return t(keyByStatus[status] ?? "memory.tasks.skill.queued");
}

function skillStatusTone(status: TaskSkillStatus | undefined): string {
  if (status === "succeeded" || status === "generated" || status === "upgraded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "skipped" || status === "not_generated") return "skipped";
  if (status === "running" || status === "generating") return "running";
  return "queued";
}

function deriveTaskSkillStatus(episode: TaskEpisode | undefined): TaskSkillStatus {
  if (episode?.skillStatus) return episode.skillStatus;
  if ((episode?.skillMemoryIds?.length ?? 0) > 0) return "succeeded";
  return "queued";
}

function chatAvatar(role: TaskChatMessage["role"]): string {
  if (role === "user") return "U";
  if (role === "tool") return "T";
  if (role === "thinking") return "R";
  return "A";
}

function deriveTaskStatus(episode: TaskEpisode | undefined, chat: TaskChatMessage[]): TaskStatus {
  if (!episode || episode.status === "open" || episode.status === "processing") {
    return "active";
  }

  if (episode.rTask !== undefined && episode.rTask <= -0.5) {
    return "failed";
  }

  if (
    episode.rewardSkipped === true ||
    episode.closeReason === "abandoned" ||
    episode.abandonReason ||
    (episode.rTask === undefined && (episode.turnCount ?? uniqueChatUserTurns(chat)) < 2)
  ) {
    return "skipped";
  }

  return "completed";
}

function uniqueChatUserTurns(chat: TaskChatMessage[]): number {
  return chat.filter((message) => message.role === "user").length;
}

function taskStatusReason(episode: TaskEpisode | undefined, status: TaskStatus, t: Translate): string | undefined {
  if (status === "skipped") {
    return (
      localizeKnownSystemReason(firstOptionalString(episode?.abandonReason, episode?.rewardReason), t) ??
      episode?.skillReason ??
      t("memory.tasks.skip.reason.default")
    );
  }

  if (status === "failed") {
    return episode?.rTask !== undefined
      ? t("memory.tasks.fail.reason.withReward", { rTask: formatDecimal(episode.rTask, 2) })
      : t("memory.tasks.fail.reason.default");
  }

  return undefined;
}

function localizeKnownSystemReason(reason: string | undefined, t: Translate): string | undefined {
  if (!reason) {
    return undefined;
  }

  const normalized = reason.trim();
  const lower = normalized.toLowerCase();

  if (lower.includes("too_few") || lower.includes("too few") || lower.includes("turn")) {
    return t("memory.tasks.skip.reason.tooFew");
  }

  if (lower.includes("too_short") || lower.includes("too short") || lower.includes("short content")) {
    return t("memory.tasks.skip.reason.tooShort");
  }

  if (lower.includes("trivial") || lower.includes("greeting")) {
    return t("memory.tasks.skip.reason.trivial");
  }

  if (lower.includes("tool_heavy") || lower.includes("tool-heavy")) {
    return t("memory.tasks.skip.reason.toolHeavy");
  }

  if (lower.includes("no_assistant") || lower.includes("no assistant")) {
    return t("memory.tasks.skip.reason.noAssistant");
  }

  if (lower.includes("abandon") || lower.includes("unclean")) {
    return t("memory.tasks.skip.reason.unclean");
  }

  return /[\u4e00-\u9fff]/.test(normalized) ? normalized : undefined;
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clipPayload(value: string): string {
  return value.length > 5000 ? `${value.slice(0, 5000)}...` : value;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function firstString(...values: Array<string | number | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "number") {
      return String(value);
    }

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "Untitled task";
}

function firstOptionalString(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function firstNonEmpty(values: string[]): string {
  return values.find((value) => value.trim())?.trim() ?? "Untitled task";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function timeValue(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
