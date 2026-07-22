/** Pet agent bridge tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentUnsubscribe, MemmyAgentWebSocketConnection, MemmyAgentWsEvent } from "../../api/memmy-agent-client.js";
import type { Task, TaskBusValue } from "../../lib/task-bus.js";
import { createPetAgentBridge, PetReconnectRecoveryTracker } from "../pet-agent-bridge.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPetAgentBridge", () => {
  it("停止当前桌宠任务时发送 Agent stop 并本地取消任务", async () => {
    const socket = createFakeSocket();
    const bus = createBridgeBus();
    const bridge = createPetAgentBridge({
      client: createFakeClient(socket.connection),
      bus
    });

    await bridge.sendTask({ task: createTask(), content: "总结一下 MemOS" });
    expect(socket.connection.sendMessage).toHaveBeenCalledWith({ chatId: "chat-1", content: "总结一下 MemOS" }, 1);

    expect(bridge.stopTask("task-1")).toBe(true);

    expect(socket.connection.stop).toHaveBeenCalledWith("chat-1");
    expect(bus.cancelTask).toHaveBeenCalledWith("task-1");
    expect(socket.unsubscribe).toHaveBeenCalledTimes(1);

    socket.emit({ event: "delta", text: "late chunk" });
    socket.emit({ event: "turn_end" });
    expect(bus.appendChunk).not.toHaveBeenCalled();
    expect(bus.completeTask).not.toHaveBeenCalled();
    expect(bus.errorTask).not.toHaveBeenCalled();
  });

  it("没有活跃任务时不会发送 stop", async () => {
    const socket = createFakeSocket();
    const bus = createBridgeBus();
    const bridge = createPetAgentBridge({
      client: createFakeClient(socket.connection),
      bus
    });

    expect(bridge.stopTask("missing-task")).toBe(false);
    expect(socket.connection.stop).not.toHaveBeenCalled();
    expect(bus.cancelTask).not.toHaveBeenCalled();
  });

  it("运行态快照不会被桌宠当成回答、完成或错误", async () => {
    const socket = createFakeSocket();
    const bus = createBridgeBus();
    const bridge = createPetAgentBridge({
      client: createFakeClient(socket.connection),
      bus
    });

    await bridge.sendTask({ task: createTask(), content: "总结一下 MemOS" });
    socket.emit({
      event: "run_status_snapshot",
      chat_id: "chat-1",
      status: "running",
      started_at: 1780732800
    });
    socket.emit({ event: "run_status_snapshot", chat_id: "chat-1", status: "idle" });

    expect(bus.appendChunk).not.toHaveBeenCalled();
    expect(bus.completeTask).not.toHaveBeenCalled();
    expect(bus.errorTask).not.toHaveBeenCalled();
  });
});

describe("PetReconnectRecoveryTracker", () => {
  it("keeps the first fixed deadline when repeated closes occur", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createRecoveryHarness();
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题" });

    harness.tracker.connectionClosed(1);
    await vi.advanceTimersByTimeAsync(20_000);
    harness.tracker.connectionClosed(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.errorTask).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.errorTask).toHaveBeenCalledTimes(1);
    expect(harness.errorTask).toHaveBeenCalledWith("task-1", "恢复超时");
  });

  it("completes from closed canonical history after the new generation is ready", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness({
      thread: {
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        last_turn_closed: true,
        messages: [
          { role: "user", content: "问题" },
          { role: "assistant", content: "canonical answer" }
        ]
      },
      snapshot: { status: "idle", startedAt: null, turnId: null, connectionGeneration: 2 }
    });
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题" });

    harness.tracker.connectionClosed(1);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.completeTask).toHaveBeenCalledWith("task-1", "canonical answer");
    expect(harness.errorTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.completeTask).toHaveBeenCalledTimes(1);
  });

  it("marks an open idle canonical turn as interrupted instead of retrying it", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness({
      thread: {
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        last_turn_closed: false,
        messages: [{ role: "user", content: "问题" }]
      },
      snapshot: { status: "idle", startedAt: null, turnId: null, connectionGeneration: 2 }
    });
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题" });

    harness.tracker.connectionClosed(1);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.errorTask).toHaveBeenCalledWith("task-1", "执行中断");
    expect(harness.completeTask).not.toHaveBeenCalled();
  });

  it("clears the recovery deadline for a running snapshot and allows a later close to open a new window", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness({
      thread: {
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        last_turn_closed: false,
        messages: [{ role: "user", content: "问题" }]
      },
      snapshot: { status: "running", startedAt: 1_000, turnId: "turn-1", connectionGeneration: 2 }
    });
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题" });

    harness.tracker.connectionClosed(1);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.errorTask).not.toHaveBeenCalled();

    harness.tracker.connectionClosed(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.errorTask).toHaveBeenCalledWith("task-1", "恢复超时");
  });

  it("retries failed reconciliation within the deadline and times out exactly once", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness();
    harness.readWebuiThread.mockRejectedValue(new Error("gateway unavailable"));
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题" });

    harness.tracker.connectionClosed(1);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.readWebuiThread.mock.calls.length).toBeGreaterThan(1);
    expect(harness.errorTask).toHaveBeenCalledTimes(1);
    expect(harness.errorTask).toHaveBeenCalledWith("task-1", "恢复超时");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.errorTask).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending retry when another ready event starts a newer reconciliation", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness();
    harness.readWebuiThread
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementation(() => new Promise<never>(() => undefined));
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题" });

    harness.tracker.connectionClosed(1);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(0);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.readWebuiThread).toHaveBeenCalledTimes(2);
  });

  it("prunes tasks completed by another reconciler so their timeout cannot overwrite completion", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness();
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题一" });
    harness.tracker.register({ taskId: "task-2", chatId: "chat-2", submittedContent: "问题二" });
    harness.tracker.connectionClosed(1);

    harness.tracker.prune(["task-2"]);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.errorTask).toHaveBeenCalledTimes(1);
    expect(harness.errorTask).toHaveBeenCalledWith("task-2", "恢复超时");
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    sessionId: "session-1",
    title: "总结一下 MemOS",
    status: "processing",
    startedAt: 1_000,
    updatedAt: 1_000,
    lastUserMessage: "总结一下 MemOS",
    streamingChunks: [],
    source: "pet",
    ...overrides
  };
}

function createBridgeBus(): Pick<TaskBusValue, "appendChunk" | "completeTask" | "errorTask" | "cancelTask"> {
  return {
    appendChunk: vi.fn(),
    completeTask: vi.fn(),
    errorTask: vi.fn(),
    cancelTask: vi.fn()
  };
}

function createFakeSocket(): { connection: MemmyAgentWebSocketConnection; unsubscribe: ReturnType<typeof vi.fn>; emit: (event: MemmyAgentWsEvent) => void } {
  let chatHandler: ((event: MemmyAgentWsEvent) => void) | null = null;
  const unsubscribe = vi.fn<MemmyAgentUnsubscribe>();
  const connection: MemmyAgentWebSocketConnection = {
    getReadyGeneration: vi.fn(() => 1),
    newChat: vi.fn(async () => "chat-1"),
    attach: vi.fn(),
    sendMessage: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    status: vi.fn(),
    historyDag: vi.fn(),
    onChat: vi.fn((_chatId: string, handler: (event: MemmyAgentWsEvent) => void) => {
      chatHandler = handler;
      return unsubscribe;
    }),
    onStatusResult: vi.fn(() => vi.fn()),
    onHistoryDagResult: vi.fn(() => vi.fn()),
    onSessionUpdate: vi.fn(() => vi.fn()),
    onRuntimeModelUpdate: vi.fn(() => vi.fn()),
    onRunStatus: vi.fn(() => vi.fn()),
    onRunLifecycle: vi.fn(() => vi.fn()),
    requestRunStatusSnapshot: vi.fn(async () => ({
      status: "idle" as const,
      startedAt: null,
      turnId: null,
      connectionGeneration: 1
    })),
    getRunStartedAt: vi.fn(() => null),
    getGoalState: vi.fn(() => null),
    close: vi.fn()
  };

  return {
    connection,
    unsubscribe,
    emit(event) {
      chatHandler?.(event);
    }
  };
}

function createFakeClient(connection: MemmyAgentWebSocketConnection) {
  return {
    connectWebSocket: vi.fn(async () => connection),
    chatIdToSessionKey: vi.fn((chatId: string) => `websocket:${chatId}`),
    readWebuiThread: vi.fn(async (sessionKey: string) => ({
      schemaVersion: 1,
      sessionKey,
      last_turn_closed: true,
      messages: []
    }))
  };
}

function createRecoveryHarness(overrides: {
  thread?: {
    schemaVersion: number;
    sessionKey: string;
    last_turn_closed?: boolean;
    messages: Record<string, unknown>[];
  };
  snapshot?: {
    status: "running" | "idle";
    startedAt: number | null;
    turnId: string | null;
    connectionGeneration: number;
  };
} = {}) {
  const thread = overrides.thread ?? {
    schemaVersion: 1,
    sessionKey: "websocket:chat-1",
    last_turn_closed: false,
    messages: []
  };
  const snapshot = overrides.snapshot ?? {
    status: "idle" as const,
    startedAt: null,
    turnId: null,
    connectionGeneration: 2
  };
  const readWebuiThread = vi.fn(async () => thread);
  const connection = createFakeSocket().connection;
  vi.mocked(connection.getReadyGeneration).mockReturnValue(2);
  vi.mocked(connection.requestRunStatusSnapshot).mockResolvedValue(snapshot);
  const completeTask = vi.fn();
  const errorTask = vi.fn();
  const tracker = new PetReconnectRecoveryTracker({
    client: {
      readWebuiThread,
      chatIdToSessionKey: (chatId) => `websocket:${chatId}`
    },
    getConnection: () => connection,
    completeTask,
    errorTask,
    emptyResponseMessage: "空回答",
    recoveryTimeoutMessage: "恢复超时",
    interruptedMessage: "执行中断"
  });
  return { tracker, readWebuiThread, completeTask, errorTask };
}
