/** Pet agent bridge tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentGoalState,
  AgentGoalStatus,
  MemmyAgentUnsubscribe,
  MemmyAgentWebSocketConnection,
  MemmyAgentWsEvent
} from "../../api/memmy-agent-client.js";
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
    expect(socket.connection.sendMessage).toHaveBeenCalledWith({
      chatId: "chat-1",
      content: "总结一下 MemOS",
      clientRequestId: expect.any(String),
      target: { kind: "standalone" }
    }, 1);
    expect(socket.connection.steerQueuedMessage).not.toHaveBeenCalled();

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

  it("Goal 中间 Turn 保持任务，只有 completed 才完成", async () => {
    const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    const socket = createFakeSocket();
    const bus = createBridgeBus();
    const bridge = createPetAgentBridge({ client: createFakeClient(socket.connection), bus });

    await bridge.sendTask({ task: createTask(), content: "完成目标" });
    socket.emit({ event: "run_status", status: "running" });
    socket.emit({ event: "delta", text: "阶段一" });
    socket.emit({ event: "turn_end", goal_id: goalId, goal_outcome: "active" });

    expect(bus.bindTaskGoal).toHaveBeenCalledWith("task-1", goalId);
    expect(bus.completeTask).not.toHaveBeenCalled();
    expect(bus.cancelTask).not.toHaveBeenCalled();
    expect(bus.errorTask).not.toHaveBeenCalled();

    socket.emit({ event: "run_status", status: "running" });
    socket.emit({ event: "delta", text: "，阶段二" });
    socket.emit({ event: "turn_end", goal_id: goalId, goal_outcome: "completed" });

    expect(bus.completeTask).toHaveBeenCalledWith("task-1", "阶段一，阶段二");
  });

  it.each([
    ["paused", "cancel"],
    ["blocked", "error"],
    ["usage_limited", "error"],
    ["budget_limited", "error"]
  ] as const)("Goal %s 进入对应桌宠终态", async (status, expected) => {
    const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    const socket = createFakeSocket();
    const bus = createBridgeBus();
    const bridge = createPetAgentBridge({ client: createFakeClient(socket.connection), bus });

    await bridge.sendTask({ task: createTask({ goalId }), content: "完成目标" });
    socket.emit({ event: "turn_end", goal_id: goalId, goal_outcome: status });

    if (expected === "cancel") {
      expect(bus.cancelTask).toHaveBeenCalledWith("task-1");
      expect(bus.errorTask).not.toHaveBeenCalled();
    } else {
      expect(bus.errorTask).toHaveBeenCalledWith("task-1", expect.any(String));
      expect(bus.cancelTask).not.toHaveBeenCalled();
    }
    expect(bus.completeTask).not.toHaveBeenCalled();
  });

  it("Turn 间 Clear 取消旧任务，后续新 Goal 不能接管它", async () => {
    const oldGoalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    const newGoalId = "1d7e1916-5871-4d57-a477-e3b2f443fa31";
    const socket = createFakeSocket();
    const bus = createBridgeBus();
    const bridge = createPetAgentBridge({ client: createFakeClient(socket.connection), bus });

    await bridge.sendTask({ task: createTask({ goalId: oldGoalId }), content: "完成旧目标" });
    socket.emit({ event: "turn_end", goal_id: oldGoalId, goal_outcome: "active" });
    socket.emit({ event: "goal_state", goal_state: goalState(null, null) });
    socket.emit({ event: "goal_state", goal_state: goalState(newGoalId, "active") });
    socket.emit({ event: "turn_end", goal_id: newGoalId, goal_outcome: "completed" });

    expect(bus.cancelTask).toHaveBeenCalledTimes(1);
    expect(bus.cancelTask).toHaveBeenCalledWith("task-1");
    expect(bus.completeTask).not.toHaveBeenCalled();
    expect(bus.bindTaskGoal).not.toHaveBeenCalled();
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

  it("两个 Goal Turn 之间重连时按持久身份保持 active 任务", async () => {
    vi.useFakeTimers();
    const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    const harness = createRecoveryHarness({
      thread: {
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        last_turn_closed: true,
        last_turn_goal_id: goalId,
        last_turn_goal_outcome: "active",
        messages: [
          { role: "user", content: "问题" },
          { role: "assistant", content: "阶段一" },
          { role: "user", content: "内部续跑", internal_context: "goal_continuation" },
          { role: "assistant", content: "阶段二" }
        ]
      },
      snapshot: { status: "idle", startedAt: null, turnId: null, connectionGeneration: 2 },
      goalState: goalState(goalId, "active")
    });
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题", goalId });

    harness.tracker.connectionClosed(1);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.completeTask).not.toHaveBeenCalled();
    expect(harness.cancelTask).not.toHaveBeenCalled();
    expect(harness.errorTask).not.toHaveBeenCalled();
  });

  it("恢复时 Goal 身份未知会持续重试而不会按普通 Turn 完成", async () => {
    vi.useFakeTimers();
    const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    const harness = createRecoveryHarness({
      thread: {
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        last_turn_closed: true,
        messages: [
          { role: "user", content: "问题" },
          { role: "assistant", content: "阶段结果" }
        ]
      }
    });
    harness.tracker.register({ taskId: "task-1", chatId: "chat-1", submittedContent: "问题", goalId });

    harness.tracker.connectionClosed(1);
    harness.tracker.ready(2);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.completeTask).not.toHaveBeenCalled();
    expect(harness.errorTask).toHaveBeenCalledWith("task-1", "恢复超时");
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

function createBridgeBus(): Pick<
  TaskBusValue,
  "appendChunk" | "completeTask" | "errorTask" | "cancelTask" | "bindTaskGoal"
> {
  return {
    appendChunk: vi.fn(),
    completeTask: vi.fn(),
    errorTask: vi.fn(),
    cancelTask: vi.fn(),
    bindTaskGoal: vi.fn()
  };
}

function createFakeSocket(): { connection: MemmyAgentWebSocketConnection; unsubscribe: ReturnType<typeof vi.fn>; emit: (event: MemmyAgentWsEvent) => void } {
  let chatHandler: ((event: MemmyAgentWsEvent) => void) | null = null;
  const unsubscribe = vi.fn<MemmyAgentUnsubscribe>();
  const connection: MemmyAgentWebSocketConnection = {
    getReadyGeneration: vi.fn(() => 1),
    newChat: vi.fn(async () => ({ chatId: "chat-1", modelPreset: "desktop-openai-gpt-5" })),
    attach: vi.fn(),
    sendMessage: vi.fn(),
    submitMessage: vi.fn(),
    removeQueuedMessage: vi.fn(),
    steerQueuedMessage: vi.fn(),
    requestQueueSnapshot: vi.fn(),
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
      source: null,
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
    last_turn_goal_id?: string;
    last_turn_goal_outcome?: AgentGoalStatus;
    messages: Record<string, unknown>[];
  };
  snapshot?: {
    status: "running" | "idle";
    startedAt: number | null;
    turnId: string | null;
    source: { kind: "gui" | "tui" | "im"; channel: string } | null;
    connectionGeneration: number;
  };
  goalState?: AgentGoalState | null;
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
  vi.mocked(connection.getGoalState).mockReturnValue(overrides.goalState ?? undefined);
  const completeTask = vi.fn();
  const errorTask = vi.fn();
  const cancelTask = vi.fn();
  const bindTaskGoal = vi.fn();
  const tracker = new PetReconnectRecoveryTracker({
    client: {
      readWebuiThread,
      chatIdToSessionKey: (chatId) => `websocket:${chatId}`
    },
    getConnection: () => connection,
    completeTask,
    errorTask,
    cancelTask,
    bindTaskGoal,
    emptyResponseMessage: "空回答",
    recoveryTimeoutMessage: "恢复超时",
    interruptedMessage: "执行中断"
  });
  return { tracker, readWebuiThread, completeTask, errorTask, cancelTask, bindTaskGoal };
}

function goalState(goalId: string | null, status: AgentGoalStatus | null): AgentGoalState {
  return {
    goal_id: goalId,
    status,
    objective: goalId ? "完成目标" : "",
    token_budget: null,
    tokens_used: 0,
    time_used_seconds: 0,
    created_at: goalId ? "2026-08-04T00:00:00.000Z" : null,
    updated_at: goalId ? "2026-08-04T00:00:00.000Z" : null
  };
}
