/** Pet agent bridge module. */
import type {
  MemmyAgentClient,
  MemmyAgentUnsubscribe,
  MemmyAgentWebSocketConnection,
  MemmyAgentWsEvent
} from "../api/memmy-agent-client.js";
import { formatMessage, zhCNMessages } from "../i18n/messages.js";
import type { Task, TaskBusValue } from "../lib/task-bus.js";

const DEFAULT_NEW_CHAT_TIMEOUT_MS = 8_000;
const DEFAULT_UNAVAILABLE_MESSAGE = formatMessage(zhCNMessages["pet.agentUnavailable"]);
const DEFAULT_EMPTY_RESPONSE_MESSAGE = formatMessage(zhCNMessages["pet.agentEmptyResponse"]);
const PET_RECOVERY_WINDOW_MS = 30_000;
const PET_RECOVERY_RETRY_DELAYS_MS = [250, 1_000, 2_000, 5_000] as const;

export interface PetAgentBridge {
  /** Handles send task. */
  sendTask(input: PetAgentSendInput): Promise<void>;
  /** Stops the active run for a task when it is still streaming. */
  stopTask(taskId: string): boolean;
  /** Closes close. */
  close(): void;
}

/** Contract for pet agent send input. */
export interface PetAgentSendInput {
  task: Task;
  content: string;
}

export interface CreatePetAgentBridgeOptions {
  /** Client. */
  client: Pick<MemmyAgentClient, "connectWebSocket" | "readWebuiThread" | "chatIdToSessionKey">;
  /** Bus. */
  bus: Pick<TaskBusValue, "appendChunk" | "completeTask" | "errorTask" | "cancelTask">;
  /** Unavailable message. */
  unavailableMessage?: string;
  /** Empty response message. */
  emptyResponseMessage?: string;
  /** New chat timeout ms. */
  newChatTimeoutMs?: number;
  recoveryWindowMs?: number;
}

interface ActiveTaskRun {
  taskId: string;
  accumulatedText: string;
  unsubscribe: MemmyAgentUnsubscribe;
}

interface ActiveTaskRunEntry {
  chatId: string;
  run: ActiveTaskRun;
}

interface PetRecoveryEntry {
  taskId: string;
  chatId: string;
  submittedContent: string;
  deadline: number;
  disconnectedGeneration: number;
  retryAttempt: number;
  reconcileToken: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export interface PetReconnectRecoveryTrackerOptions {
  client: Pick<MemmyAgentClient, "readWebuiThread" | "chatIdToSessionKey">;
  getConnection: () => MemmyAgentWebSocketConnection | null;
  completeTask: (taskId: string, text: string) => void;
  errorTask: (taskId: string, message: string) => void;
  emptyResponseMessage: string;
  recoveryTimeoutMessage: string;
  interruptedMessage: string;
  recoveryWindowMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class PetReconnectRecoveryTracker {
  private readonly entries = new Map<string, PetRecoveryEntry>();
  private readonly recoveryWindowMs: number;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly options: PetReconnectRecoveryTrackerOptions) {
    this.recoveryWindowMs = options.recoveryWindowMs ?? PET_RECOVERY_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  register(input: { taskId: string; chatId: string; submittedContent: string }): void {
    this.remove(input.taskId);
    this.entries.set(input.taskId, {
      ...input,
      deadline: 0,
      disconnectedGeneration: 0,
      retryAttempt: 0,
      reconcileToken: 0,
      deadlineTimer: null,
      retryTimer: null
    });
  }

  connectionClosed(generation: number): void {
    for (const entry of this.entries.values()) {
      entry.disconnectedGeneration = generation;
      entry.reconcileToken += 1;
      this.clearRetryTimer(entry);
      if (entry.deadline > 0) {
        continue;
      }
      entry.deadline = this.now() + this.recoveryWindowMs;
      entry.deadlineTimer = this.setTimer(() => this.timeout(entry.taskId), this.recoveryWindowMs);
    }
  }

  ready(generation: number): void {
    for (const entry of this.entries.values()) {
      if (entry.deadline > 0 && generation > entry.disconnectedGeneration) {
        entry.retryAttempt = 0;
        this.clearRetryTimer(entry);
        this.reconcile(entry.taskId, generation);
      }
    }
  }

  remove(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) {
      return;
    }
    entry.reconcileToken += 1;
    this.clearEntryTimers(entry);
    this.entries.delete(taskId);
  }

  prune(activeTaskIds: Iterable<string>): void {
    const active = new Set(activeTaskIds);
    for (const taskId of this.entries.keys()) {
      if (!active.has(taskId)) {
        this.remove(taskId);
      }
    }
  }

  close(): void {
    for (const taskId of [...this.entries.keys()]) {
      this.remove(taskId);
    }
  }

  private reconcile(taskId: string, generation: number): void {
    const entry = this.entries.get(taskId);
    const connection = this.options.getConnection();
    if (!entry || !connection || entry.deadline <= 0 || this.now() >= entry.deadline) {
      return;
    }
    const token = entry.reconcileToken + 1;
    entry.reconcileToken = token;
    void Promise.all([
      this.options.client.readWebuiThread(this.options.client.chatIdToSessionKey(entry.chatId)),
      connection.requestRunStatusSnapshot(entry.chatId, generation)
    ]).then(([thread, snapshot]) => {
      const current = this.entries.get(taskId);
      if (!current
        || current.reconcileToken !== token
        || current.deadline <= 0
        || connection.getReadyGeneration() !== generation) {
        return;
      }
      const userIndex = findLastUserMessageIndex(thread.messages);
      const userText = userIndex >= 0 ? readCanonicalMessageText(thread.messages[userIndex]) : "";
      if (userText.trim() !== current.submittedContent.trim()) {
        this.scheduleRetry(current, generation);
        return;
      }
      if (snapshot.status === "running") {
        current.deadline = 0;
        this.clearEntryTimers(current);
        return;
      }
      if (thread.last_turn_closed === true) {
        const answer = findLastAssistantText(thread.messages, userIndex) || this.options.emptyResponseMessage;
        this.options.completeTask(taskId, answer);
      } else {
        this.options.errorTask(taskId, this.options.interruptedMessage);
      }
      this.remove(taskId);
    }).catch(() => {
      const current = this.entries.get(taskId);
      if (current && current.reconcileToken === token) {
        this.scheduleRetry(current, generation);
      }
    });
  }

  private scheduleRetry(entry: PetRecoveryEntry, generation: number): void {
    if (this.now() >= entry.deadline) {
      this.timeout(entry.taskId);
      return;
    }
    this.clearRetryTimer(entry);
    const delay = PET_RECOVERY_RETRY_DELAYS_MS[entry.retryAttempt]
      ?? PET_RECOVERY_RETRY_DELAYS_MS[PET_RECOVERY_RETRY_DELAYS_MS.length - 1]
      ?? 5_000;
    entry.retryAttempt += 1;
    const remaining = Math.max(0, entry.deadline - this.now());
    entry.retryTimer = this.setTimer(() => {
      entry.retryTimer = null;
      this.reconcile(entry.taskId, generation);
    }, Math.min(delay, remaining));
  }

  private timeout(taskId: string): void {
    if (!this.entries.has(taskId)) {
      return;
    }
    this.options.errorTask(taskId, this.options.recoveryTimeoutMessage);
    this.remove(taskId);
  }

  private clearRetryTimer(entry: PetRecoveryEntry): void {
    if (entry.retryTimer) {
      this.clearTimer(entry.retryTimer);
      entry.retryTimer = null;
    }
  }

  private clearEntryTimers(entry: PetRecoveryEntry): void {
    this.clearRetryTimer(entry);
    if (entry.deadlineTimer) {
      this.clearTimer(entry.deadlineTimer);
      entry.deadlineTimer = null;
    }
  }
}

/** Creates create pet agent bridge. */
export function createPetAgentBridge(options: CreatePetAgentBridgeOptions): PetAgentBridge {
  const unavailableMessage = options.unavailableMessage ?? DEFAULT_UNAVAILABLE_MESSAGE;
  const emptyResponseMessage = options.emptyResponseMessage ?? DEFAULT_EMPTY_RESPONSE_MESSAGE;
  const newChatTimeoutMs = options.newChatTimeoutMs ?? DEFAULT_NEW_CHAT_TIMEOUT_MS;
  const sessionChatIds = new Map<string, string>();
  const activeRuns = new Map<string, ActiveTaskRun>();
  let connection: MemmyAgentWebSocketConnection | null = null;
  let connectionPromise: Promise<MemmyAgentWebSocketConnection> | null = null;
  let newChatQueue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const recoveryTracker = new PetReconnectRecoveryTracker({
    client: options.client,
    getConnection: () => connection,
    completeTask: (taskId, text) => {
      const entry = findActiveTaskRunByTaskId(taskId);
      if (entry) {
        completeTaskRun(entry.chatId, text);
      }
    },
    errorTask: (taskId, message) => {
      const entry = findActiveTaskRunByTaskId(taskId);
      if (entry) {
        failTaskRun(entry.chatId, message);
      }
    },
    emptyResponseMessage,
    recoveryTimeoutMessage: formatMessage(zhCNMessages["home.agent.recoveryTimeout"]),
    interruptedMessage: formatMessage(zhCNMessages["home.agent.executionInterrupted"]),
    recoveryWindowMs: options.recoveryWindowMs
  });

  const bridge: PetAgentBridge = {
    async sendTask(input) {
      const content = input.content.trim();
      if (!content) {
        return;
      }
      if (closed) {
        throw new Error(unavailableMessage);
      }

      const nextConnection = await ensureConnection();
      const expectedGeneration = nextConnection.getReadyGeneration();
      if (expectedGeneration === null) {
        throw new Error(unavailableMessage);
      }
      const chatId = await resolveChatId(nextConnection, input.task.sessionId, expectedGeneration);
      subscribeTaskRun(nextConnection, chatId, input.task.id);
      recoveryTracker.register({ taskId: input.task.id, chatId, submittedContent: content });
      try {
        nextConnection.sendMessage({ chatId, content }, expectedGeneration);
      } catch (error) {
        const run = activeRuns.get(chatId);
        if (run) {
          cleanupRun(chatId, run);
        }
        throw error;
      }
    },
    stopTask(taskId) {
      const entry = findActiveTaskRunByTaskId(taskId);
      if (!entry) {
        return false;
      }

      try {
        connection?.stop(entry.chatId);
      } catch (error) {
        console.warn("pet agent stop failed", error);
      }
      options.bus.cancelTask(entry.run.taskId);
      cleanupRun(entry.chatId, entry.run);
      return true;
    },
    close() {
      closed = true;
      for (const run of activeRuns.values()) {
        run.unsubscribe();
      }
      activeRuns.clear();
      recoveryTracker.close();
      connection?.close();
      connection = null;
    }
  };

  return bridge;

  /** Validates ensure connection. */
  async function ensureConnection(): Promise<MemmyAgentWebSocketConnection> {
    if (connection) {
      return connection;
    }
    if (connectionPromise) {
      return connectionPromise;
    }

    connectionPromise = options.client
      .connectWebSocket(handleGlobalEvent)
      .then((nextConnection) => {
        connection = nextConnection;
        const generation = nextConnection.getReadyGeneration();
        if (generation !== null) {
          recoveryTracker.ready(generation);
        }
        return nextConnection;
      })
      .finally(() => {
        connectionPromise = null;
      });
    return connectionPromise;
  }

  /** Handles resolve chat id. */
  async function resolveChatId(
    nextConnection: MemmyAgentWebSocketConnection,
    sessionId: string,
    expectedGeneration: number
  ): Promise<string> {
    const existing = sessionChatIds.get(sessionId);
    if (existing) {
      return existing;
    }

    const chatId = await requestNewChat(nextConnection, expectedGeneration);
    sessionChatIds.set(sessionId, chatId);
    return chatId;
  }

  /** Handles request new chat. */
  function requestNewChat(nextConnection: MemmyAgentWebSocketConnection, expectedGeneration: number): Promise<string> {
    const pending = newChatQueue.then(() => {
      if (closed) {
        throw new Error(unavailableMessage);
      }
      return nextConnection.newChat(expectedGeneration, newChatTimeoutMs);
    });
    newChatQueue = pending.catch(() => undefined);
    return pending.catch((error: unknown) => {
      throw toError(error, unavailableMessage);
    });
  }

  /** Handles handle global event. */
  function handleGlobalEvent(event: MemmyAgentWsEvent): void {
    if (event.event === "connection_closed") {
      recoveryTracker.connectionClosed(event.connection_generation ?? 0);
      return;
    }

    if (event.event === "ready" && typeof event.connection_generation === "number") {
      recoveryTracker.ready(event.connection_generation);
    }
  }

  /** Handles subscribe task run. */
  function subscribeTaskRun(
    nextConnection: MemmyAgentWebSocketConnection,
    chatId: string,
    taskId: string
  ): void {
    activeRuns.get(chatId)?.unsubscribe();
    const run: ActiveTaskRun = {
      taskId,
      accumulatedText: "",
      unsubscribe: nextConnection.onChat(chatId, (event) => handleTaskEvent(chatId, event))
    };
    activeRuns.set(chatId, run);
  }

  /** Handles handle task event. */
  function handleTaskEvent(chatId: string, event: MemmyAgentWsEvent): void {
    const run = activeRuns.get(chatId);
    if (!run) {
      return;
    }

    if (event.event === "delta") {
      appendTaskText(run, readEventText(event));
      return;
    }

    if (event.event === "stream_end") {
      completeTaskRun(chatId, readEventText(event) || run.accumulatedText || emptyResponseMessage);
      return;
    }

    if (event.event === "message") {
      if (event.kind === "progress" || event.kind === "tool_hint" || event.kind === "reasoning") {
        return;
      }
      completeTaskRun(chatId, readEventText(event) || run.accumulatedText || emptyResponseMessage);
      return;
    }

    if (event.event === "turn_end") {
      completeTaskRun(chatId, run.accumulatedText || emptyResponseMessage);
      return;
    }

    if (event.event === "goal_status" && event.status !== "running") {
      completeTaskRun(chatId, run.accumulatedText || emptyResponseMessage);
      return;
    }

    if (event.event === "error") {
      failTaskRun(chatId, event.detail ?? event.reason ?? unavailableMessage);
    }
  }

  /** Appends append task text. */
  function appendTaskText(run: ActiveTaskRun, text: string): void {
    if (!text) {
      return;
    }

    run.accumulatedText += text;
    options.bus.appendChunk(run.taskId, text);
  }

  /** Handles complete task run. */
  function completeTaskRun(chatId: string, finalText: string): void {
    const run = activeRuns.get(chatId);
    if (!run) {
      return;
    }

    options.bus.completeTask(run.taskId, finalText);
    cleanupRun(chatId, run);
  }

  /** Handles fail task run. */
  function failTaskRun(chatId: string, message: string): void {
    const run = activeRuns.get(chatId);
    if (!run) {
      return;
    }

    options.bus.errorTask(run.taskId, message);
    cleanupRun(chatId, run);
  }

  /** Finds active task run by task id. */
  function findActiveTaskRunByTaskId(taskId: string): ActiveTaskRunEntry | null {
    for (const [chatId, run] of activeRuns.entries()) {
      if (run.taskId === taskId) {
        return { chatId, run };
      }
    }

    return null;
  }

  /** Handles cleanup run. */
  function cleanupRun(chatId: string, run: ActiveTaskRun): void {
    run.unsubscribe();
    activeRuns.delete(chatId);
    recoveryTracker.remove(run.taskId);
  }

}

/** Reads read event text. */
function readEventText(event: MemmyAgentWsEvent): string {
  return typeof event.text === "string" ? event.text : typeof event.content === "string" ? event.content : "";
}

/** Handles to error. */
function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(String(error || fallbackMessage));
}

function findLastUserMessageIndex(messages: Record<string, unknown>[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function findLastAssistantText(messages: Record<string, unknown>[], afterIndex: number): string {
  for (let index = messages.length - 1; index > afterIndex; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return readCanonicalMessageText(messages[index]);
    }
  }
  return "";
}

function readCanonicalMessageText(message: Record<string, unknown> | undefined): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}
