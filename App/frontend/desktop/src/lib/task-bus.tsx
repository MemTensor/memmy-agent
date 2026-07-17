import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

export const TASK_BUS_STORAGE_KEY = "memmy.taskBus";

export type TaskStatus = "processing" | "answering" | "done" | "error" | "cancelled";

export type TaskSource = "pet" | "main";

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  status: TaskStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastUserMessage: string;
  lastAgentMessage?: string;
  streamingChunks?: string[];
  source: TaskSource;
  dismissed?: boolean;
  readAt?: number;
}

export interface TaskBusSnapshot {
  tasks: Task[];
  focusedTaskId: string | null;
  pendingNewSession: boolean;
}

export interface CreateTaskInput {
  input: string;
  source: TaskSource;
  sessionId?: string;
}

export interface TaskBusAgentMessage {
  role: string;
  content: string;
  createdAt?: number;
  isStreaming?: boolean;
}

export interface SyncAgentConversationInput {
  sessionIds: string[];
  messages: TaskBusAgentMessage[];
  isRunning: boolean;
  preserveFocus?: boolean;
  now?: number;
  makeId?: () => string;
}

export interface TaskBusAgentTaskStatus {
  sessionIds: string[];
  isRunning: boolean;
}

export interface SyncAgentTaskStatusesInput {
  tasks: TaskBusAgentTaskStatus[];
  now?: number;
}

export interface TaskBusValue {
  tasks: Task[];
  focusedTaskId: string | null;
  focusedTask: Task | null;
  runningTasks: Task[];
  lastFinishedTask: Task | null;
  pendingNewSession: boolean;
  createTask: (args: CreateTaskInput) => Task;
  appendChunk: (taskId: string, chunk: string) => void;
  completeTask: (taskId: string, finalText: string) => void;
  errorTask: (taskId: string, message: string) => void;
  cancelTask: (taskId: string) => void;
  focusTask: (taskId: string | null) => void;
  startNewSession: () => void;
  dismissTask: (taskId: string) => void;
  markTaskRead: (taskId: string) => void;
  removeTasksBySessionIds: (sessionIds: string[]) => void;
  syncAgentConversation: (input: SyncAgentConversationInput) => void;
  syncAgentTaskStatuses: (input: SyncAgentTaskStatusesInput) => void;
}

export function createEmptyTaskBusSnapshot(): TaskBusSnapshot {
  return { tasks: [], focusedTaskId: null, pendingNewSession: false };
}

export function createTaskRecord(args: CreateTaskInput, deps: { now?: number; makeId?: () => string } = {}): Task {
  const now = deps.now ?? Date.now();
  const makeTaskId = deps.makeId ?? makeId;
  const id = makeTaskId();
  const sessionId = args.sessionId ?? makeTaskId();

  return {
    id,
    sessionId,
    title: summarizeTitle(args.input),
    status: "processing",
    startedAt: now,
    updatedAt: now,
    lastUserMessage: args.input,
    streamingChunks: [],
    source: args.source
  };
}

export function addTaskToSnapshot(snapshot: TaskBusSnapshot, task: Task): TaskBusSnapshot {
  return {
    tasks: [task, ...snapshot.tasks],
    focusedTaskId: task.id,
    pendingNewSession: false
  };
}

export function appendChunkToSnapshot(snapshot: TaskBusSnapshot, taskId: string, chunk: string, now = Date.now()): TaskBusSnapshot {
  return {
    ...snapshot,
    focusedTaskId: snapshot.focusedTaskId ?? (snapshot.pendingNewSession ? null : taskId),
    tasks: snapshot.tasks.map((task) =>
      task.id === taskId
        ? appendTaskAnswerChunk(task, chunk, now)
        : task
    )
  };
}

export function completeTaskInSnapshot(snapshot: TaskBusSnapshot, taskId: string, finalText: string, now = Date.now()): TaskBusSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: "done",
            lastAgentMessage: finalText,
            finishedAt: now,
            updatedAt: now,
            streamingChunks: [finalText],
            readAt: undefined
          }
        : task
    )
  };
}

export function errorTaskInSnapshot(snapshot: TaskBusSnapshot, taskId: string, message: string, now = Date.now()): TaskBusSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: "error",
            lastAgentMessage: message,
            finishedAt: now,
            updatedAt: now,
            readAt: undefined
          }
        : task
    )
  };
}

export function cancelTaskInSnapshot(snapshot: TaskBusSnapshot, taskId: string, now = Date.now()): TaskBusSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: "cancelled",
            finishedAt: now,
            updatedAt: now
          }
        : task
    )
  };
}

export function focusTaskInSnapshot(snapshot: TaskBusSnapshot, taskId: string | null): TaskBusSnapshot {
  if (!taskId) {
    return { ...snapshot, focusedTaskId: null };
  }

  return {
    ...snapshot,
    focusedTaskId: taskId,
    pendingNewSession: false,
    tasks: snapshot.tasks.map((task) => (task.id === taskId ? { ...task, dismissed: false } : task))
  };
}

export function startNewSessionInSnapshot(snapshot: TaskBusSnapshot): TaskBusSnapshot {
  return { ...snapshot, focusedTaskId: null, pendingNewSession: true };
}

export function dismissTaskInSnapshot(snapshot: TaskBusSnapshot, taskId: string, now = Date.now()): TaskBusSnapshot {
  return {
    ...snapshot,
    focusedTaskId: snapshot.focusedTaskId === taskId ? null : snapshot.focusedTaskId,
    tasks: snapshot.tasks.map((task) => (task.id === taskId ? markTaskDismissed(task, now) : task))
  };
}

export function markTaskReadInSnapshot(snapshot: TaskBusSnapshot, taskId: string, now = Date.now()): TaskBusSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map((task) => (task.id === taskId && isTaskTerminalStatus(task.status) ? { ...task, readAt: now } : task))
  };
}

export function removeTasksBySessionIdsInSnapshot(snapshot: TaskBusSnapshot, sessionIds: string[]): TaskBusSnapshot {
  const targetSessionIds = expandSessionIds(sessionIds);
  if (targetSessionIds.size === 0) {
    return snapshot;
  }

  const removedTaskIds = new Set(snapshot.tasks.filter((task) => targetSessionIds.has(task.sessionId)).map((task) => task.id));
  if (removedTaskIds.size === 0) {
    return snapshot;
  }

  const removedFocusedTask = !!snapshot.focusedTaskId && removedTaskIds.has(snapshot.focusedTaskId);
  return {
    ...snapshot,
    tasks: snapshot.tasks.filter((task) => !removedTaskIds.has(task.id)),
    focusedTaskId: removedFocusedTask ? null : snapshot.focusedTaskId,
    pendingNewSession: removedFocusedTask ? false : snapshot.pendingNewSession
  };
}

export function syncAgentConversationToSnapshot(snapshot: TaskBusSnapshot, input: SyncAgentConversationInput): TaskBusSnapshot {
  const targetSessionIds = expandSessionIds(input.sessionIds);
  if (targetSessionIds.size === 0 || input.messages.length === 0) {
    return snapshot;
  }

  const now = input.now ?? Date.now();
  const sessionId = resolvePrimarySessionId(input.sessionIds);
  const latestTurn = sessionId ? findLatestUserTurn(input.messages) : null;
  let changed = false;
  let latestSyncedTaskId: string | null = null;
  let tasks = snapshot.tasks.map((task) => {
    if (!targetSessionIds.has(task.sessionId) || !isTaskInFlightStatus(task.status)) {
      return task;
    }

    const answer = findAssistantAnswerForTask(input.messages, task);
    if (!answer?.text.trim()) {
      return task;
    }

    const status: TaskStatus = input.isRunning ? "answering" : "done";
    const nextTask = applyTaskAnswerSnapshot(task, answer.text, status, now);
    changed = changed || nextTask !== task;
    return nextTask;
  });

  if (sessionId && latestTurn) {
    const status: TaskStatus = input.isRunning
      ? latestTurn.answer?.text.trim()
        ? "answering"
        : "processing"
      : "done";
    const latestTask = createTaskFromAgentTurn({
      sessionId,
      userText: latestTurn.userText,
      answerText: latestTurn.answer?.text ?? "",
      status,
      now,
      userCreatedAt: latestTurn.userCreatedAt,
      makeId: input.makeId
    });
    const existingIndex = findTaskIndexForAgentTurn(tasks, targetSessionIds, latestTurn.userText, latestTurn.userCreatedAt);
    if (existingIndex >= 0) {
      const currentTask = tasks[existingIndex]!;
      const nextTask = mergeAgentTurnIntoTask(currentTask, latestTask);
      latestSyncedTaskId = nextTask.id;
      if (nextTask !== currentTask) {
        tasks = tasks.map((task, index) => (index === existingIndex ? nextTask : task));
        changed = true;
      }
    } else {
      tasks = [latestTask, ...tasks];
      latestSyncedTaskId = latestTask.id;
      changed = true;
    }
  }

  const focusedTaskId = input.preserveFocus ? snapshot.focusedTaskId : latestSyncedTaskId ?? snapshot.focusedTaskId;
  return changed || focusedTaskId !== snapshot.focusedTaskId ? { ...snapshot, tasks, focusedTaskId } : snapshot;
}

export function syncAgentTaskStatusesToSnapshot(snapshot: TaskBusSnapshot, input: SyncAgentTaskStatusesInput): TaskBusSnapshot {
  const statusBySessionId = createAgentTaskStatusMap(input.tasks);
  if (statusBySessionId.size === 0 || snapshot.tasks.length === 0) {
    return snapshot;
  }

  const now = input.now ?? Date.now();
  const runningRepresentativeTaskIds = findRunningRepresentativeTaskIds(snapshot.tasks, statusBySessionId);
  let changed = false;
  const tasks = snapshot.tasks.map((task) => {
    const isRunning = statusBySessionId.get(task.sessionId);
    if (isRunning == null) {
      return task;
    }

    if (isRunning) {
      if (!runningRepresentativeTaskIds.has(task.id)) {
        return task;
      }

      const nextTask = markTaskRunningFromAgentStatus(task, now);
      changed = changed || nextTask !== task;
      return nextTask;
    }

    const nextTask = finishTaskFromAgentStatus(task, now);
    changed = changed || nextTask !== task;
    return nextTask;
  });

  return changed ? { ...snapshot, tasks } : snapshot;
}

export function loadTaskBusSnapshot(storage: Storage | undefined): TaskBusSnapshot {
  const raw = storage?.getItem(TASK_BUS_STORAGE_KEY);
  if (!raw) {
    return createEmptyTaskBusSnapshot();
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSnapshotLike(parsed)) {
      return createEmptyTaskBusSnapshot();
    }

    const tasks = parsed.tasks.filter(isTaskLike).map((task) => ({
      ...task,
      streamingChunks: undefined
    }));
    const parsedFocusedTaskId = typeof parsed.focusedTaskId === "string" ? parsed.focusedTaskId : null;
    const focusedTaskId = parsedFocusedTaskId && tasks.some((task) => task.id === parsedFocusedTaskId) ? parsedFocusedTaskId : null;

    return {
      tasks,
      focusedTaskId,
      pendingNewSession: parsed.pendingNewSession
    };
  } catch {
    return createEmptyTaskBusSnapshot();
  }
}

export function saveTaskBusSnapshot(storage: Storage | undefined, snapshot: TaskBusSnapshot): void {
  if (!storage) {
    return;
  }

  const serialized = serializeTaskBusSnapshot(snapshot);
  if (storage.getItem(TASK_BUS_STORAGE_KEY) === serialized) {
    return;
  }

  storage.setItem(TASK_BUS_STORAGE_KEY, serialized);
}

const TaskBusContext = createContext<TaskBusValue | null>(null);

export function TaskBusProvider({ children }: PropsWithChildren) {
  const [snapshot, setSnapshot] = useState(() => loadTaskBusSnapshot(getLocalStorage()));

  useEffect(() => {
    saveTaskBusSnapshot(getLocalStorage(), snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== TASK_BUS_STORAGE_KEY) {
        return;
      }

      setSnapshot((current) => {
        const next = loadTaskBusSnapshot(getLocalStorage());
        return serializeTaskBusSnapshot(current) === serializeTaskBusSnapshot(next) ? current : mergePersistedTaskBusSnapshot(current, next);
      });
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const createTask = useCallback<TaskBusValue["createTask"]>((args) => {
    const task = createTaskRecord(args);
    setSnapshot((current) => addTaskToSnapshot(current, task));
    return task;
  }, []);

  const appendChunk = useCallback<TaskBusValue["appendChunk"]>((taskId, chunk) => {
    setSnapshot((current) => appendChunkToSnapshot(current, taskId, chunk));
  }, []);

  const completeTask = useCallback<TaskBusValue["completeTask"]>((taskId, finalText) => {
    setSnapshot((current) => completeTaskInSnapshot(current, taskId, finalText));
  }, []);

  const errorTask = useCallback<TaskBusValue["errorTask"]>((taskId, message) => {
    setSnapshot((current) => errorTaskInSnapshot(current, taskId, message));
  }, []);

  const cancelTask = useCallback<TaskBusValue["cancelTask"]>((taskId) => {
    setSnapshot((current) => cancelTaskInSnapshot(current, taskId));
  }, []);

  const focusTask = useCallback<TaskBusValue["focusTask"]>((taskId) => {
    setSnapshot((current) => focusTaskInSnapshot(current, taskId));
  }, []);

  const startNewSession = useCallback<TaskBusValue["startNewSession"]>(() => {
    setSnapshot(startNewSessionInSnapshot);
  }, []);

  const dismissTask = useCallback<TaskBusValue["dismissTask"]>((taskId) => {
    setSnapshot((current) => dismissTaskInSnapshot(current, taskId));
  }, []);

  const markTaskRead = useCallback<TaskBusValue["markTaskRead"]>((taskId) => {
    setSnapshot((current) => markTaskReadInSnapshot(current, taskId));
  }, []);

  const removeTasksBySessionIds = useCallback<TaskBusValue["removeTasksBySessionIds"]>((sessionIds) => {
    const storage = getLocalStorage();
    if (storage?.getItem(TASK_BUS_STORAGE_KEY) != null) {
      const nextSnapshot = removeTasksBySessionIdsInSnapshot(loadTaskBusSnapshot(storage), sessionIds);
      saveTaskBusSnapshot(storage, nextSnapshot);
      setSnapshot((current) => mergePersistedTaskBusSnapshot(current, nextSnapshot));
      return;
    }

    setSnapshot((current) => removeTasksBySessionIdsInSnapshot(current, sessionIds));
  }, []);

  const syncAgentConversation = useCallback<TaskBusValue["syncAgentConversation"]>((input) => {
    setSnapshot((current) => syncAgentConversationToSnapshot(current, input));
  }, []);

  const syncAgentTaskStatuses = useCallback<TaskBusValue["syncAgentTaskStatuses"]>((input) => {
    setSnapshot((current) => syncAgentTaskStatusesToSnapshot(current, input));
  }, []);

  const focusedTask = useMemo(
    () => snapshot.tasks.find((task) => task.id === snapshot.focusedTaskId) ?? null,
    [snapshot.focusedTaskId, snapshot.tasks]
  );

  const runningTasks = useMemo(
    () => [...snapshot.tasks.filter((task) => isTaskInFlightStatus(task.status))].sort((a, b) => b.updatedAt - a.updatedAt),
    [snapshot.tasks]
  );

  const lastFinishedTask = useMemo(
    () =>
      snapshot.tasks
        .filter((task) => task.status === "done" || task.status === "error")
        .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))[0] ?? null,
    [snapshot.tasks]
  );

  const value = useMemo<TaskBusValue>(
    () => ({
      tasks: snapshot.tasks,
      focusedTaskId: snapshot.focusedTaskId,
      focusedTask,
      runningTasks,
      lastFinishedTask,
      pendingNewSession: snapshot.pendingNewSession,
      createTask,
      appendChunk,
      completeTask,
      errorTask,
      cancelTask,
      focusTask,
      startNewSession,
      dismissTask,
      markTaskRead,
      removeTasksBySessionIds,
      syncAgentConversation,
      syncAgentTaskStatuses
    }),
    [
      appendChunk,
      cancelTask,
      completeTask,
      createTask,
      dismissTask,
      errorTask,
      focusTask,
      focusedTask,
      lastFinishedTask,
      markTaskRead,
      removeTasksBySessionIds,
      runningTasks,
      snapshot.focusedTaskId,
      snapshot.pendingNewSession,
      snapshot.tasks,
      startNewSession,
      syncAgentConversation,
      syncAgentTaskStatuses
    ]
  );

  return <TaskBusContext.Provider value={value}>{children}</TaskBusContext.Provider>;
}

export function useTaskBus(): TaskBusValue {
  const value = useContext(TaskBusContext);
  if (!value) {
    throw new Error("useTaskBus must be used within TaskBusProvider");
  }
  return value;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Builds a summary title for a task.
 *
 * @param input The user input.
 * @returns A title of at most 30 characters.
 */
function summarizeTitle(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  return trimmed.length <= 30 ? trimmed : `${trimmed.slice(0, 28)}…`;
}

/**
 * Appends one chunk of assistant text to a task and advances a running task to "answering".
 */
function appendTaskAnswerChunk(task: Task, chunk: string, now: number): Task {
  if (!isTaskInFlightStatus(task.status)) {
    return task;
  }

  const streamingChunks = [...(task.streamingChunks ?? []), chunk];
  const text = streamingChunks.join("");
  return applyTaskAnswerSnapshot(task, text, "answering", now, streamingChunks);
}

/**
 * Applies answer text taken from an agent message snapshot.
 */
function applyTaskAnswerSnapshot(task: Task, text: string, status: TaskStatus, now: number, streamingChunks: string[] = [text]): Task {
  const taskWithoutFinishedAt = { ...task };
  delete taskWithoutFinishedAt.finishedAt;
  delete taskWithoutFinishedAt.readAt;
  const nextTask: Task = status === "done"
    ? {
        ...task,
        status,
        lastAgentMessage: text,
        updatedAt: now,
        streamingChunks,
        finishedAt: task.finishedAt ?? now,
        readAt: undefined
      }
    : {
        ...taskWithoutFinishedAt,
        status,
        lastAgentMessage: text,
        updatedAt: now,
        streamingChunks
      };

  if (
    task.status === nextTask.status &&
    task.lastAgentMessage === nextTask.lastAgentMessage &&
    task.finishedAt === nextTask.finishedAt &&
    task.updatedAt === nextTask.updatedAt &&
    (task.streamingChunks ?? []).join("") === streamingChunks.join("")
  ) {
    return task;
  }

  return nextTask;
}

/**
 * Advances a pet task to the running state based on the full-mode task list.
 */
function markTaskRunningFromAgentStatus(task: Task, now: number): Task {
  if (task.status === "processing" || task.status === "answering" || task.status === "cancelled" || task.status === "error") {
    return task;
  }

  const taskWithoutFinishedAt = { ...task };
  delete taskWithoutFinishedAt.finishedAt;
  delete taskWithoutFinishedAt.readAt;
  return {
    ...taskWithoutFinishedAt,
    status: "processing",
    updatedAt: now,
    dismissed: false
  };
}

/**
 * Settles a running pet task into the done state based on the full-mode task list.
 */
function finishTaskFromAgentStatus(task: Task, now: number): Task {
  if (!isTaskInFlightStatus(task.status)) {
    return task;
  }

  const text = task.lastAgentMessage ?? task.streamingChunks?.join("") ?? "";
  return {
    ...task,
    status: "done",
    ...(text ? { lastAgentMessage: text, streamingChunks: [text] } : {}),
    updatedAt: now,
    finishedAt: task.finishedAt ?? now,
    readAt: undefined
  };
}

/**
 * Picks the primary session id used by TaskBus records from the session ids synced by full mode.
 */
function resolvePrimarySessionId(sessionIds: string[]): string | null {
  for (const sessionId of sessionIds) {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      continue;
    }
    return trimmed.startsWith("websocket:") ? trimmed.slice("websocket:".length) : trimmed;
  }
  return null;
}

/**
 * Finds the latest user turn in the current full-mode session along with its matching answer.
 */
function findLatestUserTurn(messages: TaskBusAgentMessage[]): { userText: string; userCreatedAt?: number; answer: { text: string; isStreaming: boolean } | null } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || !message.content.trim()) {
      continue;
    }

    return {
      userText: message.content,
      ...(typeof message.createdAt === "number" ? { userCreatedAt: message.createdAt } : {}),
      answer: findAssistantAnswerAfterUserIndex(messages, index)
    };
  }
  return null;
}

/**
 * Creates a TaskBus task representing the latest full-mode turn.
 */
function createTaskFromAgentTurn(input: {
  sessionId: string;
  userText: string;
  answerText: string;
  status: TaskStatus;
  now: number;
  userCreatedAt?: number;
  makeId?: () => string;
}): Task {
  const startedAt = input.userCreatedAt ?? input.now;
  const task = createTaskRecord(
    { input: input.userText, source: "main", sessionId: input.sessionId },
    { now: startedAt, makeId: input.makeId }
  );
  if (input.status === "processing" || !input.answerText.trim()) {
    return {
      ...task,
      status: input.status,
      updatedAt: input.now
    };
  }

  return applyTaskAnswerSnapshot(task, input.answerText, input.status, input.now);
}

/**
 * Finds an existing TaskBus task with the same session and same user input.
 */
function findTaskIndexForAgentTurn(tasks: Task[], targetSessionIds: Set<string>, userText: string, userCreatedAt?: number): number {
  const normalizedUserText = normalizeMessageText(userText);
  let mainFallbackIndex = -1;
  let fallbackIndex = -1;
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    if (!targetSessionIds.has(task.sessionId) || normalizeMessageText(task.lastUserMessage) !== normalizedUserText) {
      continue;
    }
    if (task.source === "main") {
      if (typeof userCreatedAt === "number" && task.startedAt === userCreatedAt) {
        return index;
      }
      if (typeof userCreatedAt !== "number" && mainFallbackIndex < 0) {
        mainFallbackIndex = index;
      }
      continue;
    }
    if (typeof userCreatedAt === "number" && Math.abs(task.startedAt - userCreatedAt) > 60_000) {
      continue;
    }
    if (fallbackIndex < 0) {
      fallbackIndex = index;
    }
  }
  return mainFallbackIndex >= 0 ? mainFallbackIndex : fallbackIndex;
}

/**
 * Finds the latest assistant text after the task's corresponding user message.
 */
function findAssistantAnswerForTask(messages: TaskBusAgentMessage[], task: Task): { text: string; isStreaming: boolean } | null {
  const userText = normalizeMessageText(task.lastUserMessage);
  let userIndex = -1;
  let fallbackIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || normalizeMessageText(message.content) !== userText) {
      continue;
    }
    if (typeof message.createdAt === "number" && message.createdAt === task.startedAt) {
      userIndex = index;
      break;
    }
    if (task.source !== "main" && typeof message.createdAt === "number" && Math.abs(message.createdAt - task.startedAt) <= 60_000) {
      userIndex = index;
      break;
    }
    if (fallbackIndex < 0) {
      fallbackIndex = index;
    }
  }

  if (userIndex < 0 && task.source !== "main") {
    userIndex = fallbackIndex;
  }

  if (userIndex < 0) {
    return null;
  }

  return findAssistantAnswerAfterUserIndex(messages, userIndex);
}

/**
 * Finds the latest assistant text after the given user message and before the next user message.
 */
function findAssistantAnswerAfterUserIndex(messages: TaskBusAgentMessage[], userIndex: number): { text: string; isStreaming: boolean } | null {
  let answer: { text: string; isStreaming: boolean } | null = null;
  for (const message of messages.slice(userIndex + 1)) {
    if (message.role === "user") {
      break;
    }
    if (message.role !== "assistant" || !message.content.trim()) {
      continue;
    }
    answer = { text: message.content, isStreaming: message.isStreaming === true };
  }

  return answer;
}

/**
 * Normalizes text so the same round of user input can be matched.
 */
function normalizeMessageText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Merges the latest full-mode turn back into an existing TaskBus task.
 */
function mergeAgentTurnIntoTask(currentTask: Task, agentTask: Task): Task {
  const nextTask: Task = {
    ...currentTask,
    title: agentTask.title,
    status: agentTask.status,
    startedAt: Math.min(currentTask.startedAt, agentTask.startedAt),
    updatedAt: Math.max(currentTask.updatedAt, agentTask.updatedAt),
    lastUserMessage: agentTask.lastUserMessage,
    source: currentTask.source === "pet" ? currentTask.source : agentTask.source,
    dismissed: false,
    ...(agentTask.lastAgentMessage == null ? {} : { lastAgentMessage: agentTask.lastAgentMessage }),
    ...(agentTask.streamingChunks == null ? {} : { streamingChunks: agentTask.streamingChunks }),
    ...(agentTask.finishedAt == null ? {} : { finishedAt: agentTask.finishedAt })
  };
  if (agentTask.finishedAt == null) {
    delete nextTask.finishedAt;
  }

  if (
    currentTask.title === nextTask.title &&
    currentTask.status === nextTask.status &&
    currentTask.startedAt === nextTask.startedAt &&
    currentTask.updatedAt === nextTask.updatedAt &&
    currentTask.lastUserMessage === nextTask.lastUserMessage &&
    currentTask.lastAgentMessage === nextTask.lastAgentMessage &&
    currentTask.finishedAt === nextTask.finishedAt &&
    currentTask.dismissed === nextTask.dismissed &&
    currentTask.readAt === nextTask.readAt &&
    (currentTask.streamingChunks ?? []).join("") === (nextTask.streamingChunks ?? []).join("")
  ) {
    return currentTask;
  }

  return nextTask;
}

/**
 * Determines whether a task is still within the agent run pipeline.
 */
function isTaskInFlightStatus(status: TaskStatus): boolean {
  return status === "processing" || status === "answering";
}

function isTaskTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "error";
}

function markTaskDismissed(task: Task, now: number): Task {
  return isTaskTerminalStatus(task.status) ? { ...task, dismissed: true, readAt: task.readAt ?? now } : { ...task, dismissed: true };
}

/**
 * Serializes a persistable snapshot, filtering out runtime streaming chunks.
 *
 * @param snapshot The current snapshot.
 * @returns The localStorage string.
 */
function serializeTaskBusSnapshot(snapshot: TaskBusSnapshot): string {
  const persisted: TaskBusSnapshot = {
    ...snapshot,
    tasks: snapshot.tasks.map(({ streamingChunks: _streamingChunks, ...task }) => task)
  };
  return JSON.stringify(persisted);
}

/**
 * Merges a persisted snapshot, preserving the runtime streamingChunks of tasks that still exist in the current window.
 *
 * @param current The current in-memory snapshot.
 * @param persisted The persisted snapshot.
 * @returns The merged in-memory snapshot.
 */
function mergePersistedTaskBusSnapshot(current: TaskBusSnapshot, persisted: TaskBusSnapshot): TaskBusSnapshot {
  const currentTasks = new Map(current.tasks.map((task) => [task.id, task]));
  return {
    ...persisted,
    tasks: persisted.tasks.map((task) => ({
      ...task,
      streamingChunks: currentTasks.get(task.id)?.streamingChunks
    }))
  };
}

/**
 * Expands session ids to be compatible with both the full-mode sessionKey and the pet chatId.
 *
 * @param sessionIds The raw list of session ids.
 * @returns A set that can be matched against Task.sessionId.
 */
function expandSessionIds(sessionIds: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const value of sessionIds) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    expanded.add(trimmed);
    if (trimmed.startsWith("websocket:")) {
      expanded.add(trimmed.slice("websocket:".length));
    } else {
      expanded.add(`websocket:${trimmed}`);
    }
  }

  return expanded;
}

/**
 * Builds a map of full-mode session running states, compatible with the websocket: prefix.
 */
function createAgentTaskStatusMap(tasks: TaskBusAgentTaskStatus[]): Map<string, boolean> {
  const statusBySessionId = new Map<string, boolean>();
  for (const task of tasks) {
    for (const sessionId of expandSessionIds(task.sessionIds)) {
      statusBySessionId.set(sessionId, task.isRunning);
    }
  }
  return statusBySessionId;
}

/**
 * Finds the representative pet task for each running session, so that older queries in the same session don't all flip to the running state together.
 */
function findRunningRepresentativeTaskIds(tasks: Task[], statusBySessionId: Map<string, boolean>): Set<string> {
  const representativeBySessionId = new Map<string, Task>();
  for (const task of tasks) {
    if (task.status === "cancelled" || task.status === "error" || statusBySessionId.get(task.sessionId) !== true) {
      continue;
    }

    const sessionId = canonicalTaskSessionId(task.sessionId);
    const current = representativeBySessionId.get(sessionId);
    if (!current || taskActivityAt(task) > taskActivityAt(current)) {
      representativeBySessionId.set(sessionId, task);
    }
  }
  return new Set([...representativeBySessionId.values()].map((task) => task.id));
}

/**
 * Normalizes a TaskBus session id so that chatId and websocket:chatId are treated as the same session.
 */
function canonicalTaskSessionId(sessionId: string): string {
  return sessionId.startsWith("websocket:") ? sessionId.slice("websocket:".length) : sessionId;
}

/**
 * Computes a task's activity time, used to pick the session's representative task.
 */
function taskActivityAt(task: Task): number {
  return Math.max(task.startedAt, task.updatedAt, task.finishedAt ?? 0);
}

/**
 * Reads the browser localStorage.
 *
 * @returns An available Storage, or undefined.
 */
function getLocalStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/**
 * Determines whether a value looks like a TaskBusSnapshot.
 *
 * @param value The value to validate.
 * @returns Whether it can be parsed as a snapshot.
 */
function isSnapshotLike(value: unknown): value is { tasks: unknown[]; focusedTaskId: unknown; pendingNewSession: boolean } {
  return typeof value === "object" && value !== null && Array.isArray((value as { tasks?: unknown }).tasks) && typeof (value as { pendingNewSession?: unknown }).pendingNewSession === "boolean";
}

/**
 * Determines whether a value looks like a Task.
 *
 * @param value The value to validate.
 * @returns Whether it can be parsed as a task.
 */
function isTaskLike(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const task = value as Partial<Task>;
  return (
    typeof task.id === "string" &&
    typeof task.sessionId === "string" &&
    typeof task.title === "string" &&
    isTaskStatus(task.status) &&
    typeof task.startedAt === "number" &&
    typeof task.updatedAt === "number" &&
    typeof task.lastUserMessage === "string" &&
    isTaskSource(task.source)
  );
}

/**
 * Determines whether a task status is valid.
 *
 * @param value The value to validate.
 * @returns Whether it is a TaskStatus.
 */
function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "processing" || value === "answering" || value === "done" || value === "error" || value === "cancelled";
}

/**
 * Determines whether a task source is valid.
 *
 * @param value The value to validate.
 * @returns Whether it is a TaskSource.
 */
function isTaskSource(value: unknown): value is TaskSource {
  return value === "pet" || value === "main";
}
