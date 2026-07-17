/** Pet agent bridge module. */
import type { MemmyAgentClient, MemmyAgentWebSocketConnection, MemmyAgentWsEvent, MemmyAgentUnsubscribe } from "../api/memmy-agent-client.js";
import { formatMessage, zhCNMessages } from "../i18n/messages.js";
import type { Task, TaskBusValue } from "../lib/task-bus.js";

const DEFAULT_NEW_CHAT_TIMEOUT_MS = 8_000;
const DEFAULT_UNAVAILABLE_MESSAGE = formatMessage(zhCNMessages["pet.agentUnavailable"]);
const DEFAULT_EMPTY_RESPONSE_MESSAGE = formatMessage(zhCNMessages["pet.agentEmptyResponse"]);

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
  client: Pick<MemmyAgentClient, "connectWebSocket">;
  /** Bus. */
  bus: Pick<TaskBusValue, "appendChunk" | "completeTask" | "errorTask" | "cancelTask">;
  /** Unavailable message. */
  unavailableMessage?: string;
  /** Empty response message. */
  emptyResponseMessage?: string;
  /** New chat timeout ms. */
  newChatTimeoutMs?: number;
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
      const chatId = await resolveChatId(nextConnection, input.task.sessionId);
      subscribeTaskRun(nextConnection, chatId, input.task.id);
      nextConnection.sendMessage({ chatId, content });
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
        return nextConnection;
      })
      .finally(() => {
        connectionPromise = null;
      });
    return connectionPromise;
  }

  /** Handles resolve chat id. */
  async function resolveChatId(nextConnection: MemmyAgentWebSocketConnection, sessionId: string): Promise<string> {
    const existing = sessionChatIds.get(sessionId);
    if (existing) {
      return existing;
    }

    const chatId = await requestNewChat(nextConnection);
    sessionChatIds.set(sessionId, chatId);
    return chatId;
  }

  /** Handles request new chat. */
  function requestNewChat(nextConnection: MemmyAgentWebSocketConnection): Promise<string> {
    const pending = newChatQueue.then(() => {
      if (closed) {
        throw new Error(unavailableMessage);
      }
      return nextConnection.newChat(newChatTimeoutMs);
    });
    newChatQueue = pending.catch(() => undefined);
    return pending.catch((error: unknown) => {
      throw toError(error, unavailableMessage);
    });
  }

  /** Handles handle global event. */
  function handleGlobalEvent(event: MemmyAgentWsEvent): void {
    if (event.event === "connection_closed") {
      failActiveRuns(unavailableMessage);
      return;
    }

    if (event.event === "error" && !event.chat_id) {
      failActiveRuns(event.detail ?? unavailableMessage);
    }
  }

  /** Handles subscribe task run. */
  function subscribeTaskRun(nextConnection: MemmyAgentWebSocketConnection, chatId: string, taskId: string): void {
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

  /** Handles fail active runs. */
  function failActiveRuns(message: string): void {
    for (const chatId of [...activeRuns.keys()]) {
      failTaskRun(chatId, message);
    }
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
