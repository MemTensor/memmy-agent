/** Pet agent bridge tests. */
import { describe, expect, it, vi } from "vitest";
import type { MemmyAgentUnsubscribe, MemmyAgentWebSocketConnection, MemmyAgentWsEvent } from "../../api/memmy-agent-client.js";
import type { Task, TaskBusValue } from "../../lib/task-bus.js";
import { createPetAgentBridge } from "../pet-agent-bridge.js";

describe("createPetAgentBridge", () => {
  it("停止当前桌宠任务时发送 Agent stop 并本地取消任务", async () => {
    const socket = createFakeSocket();
    const bus = createBridgeBus();
    const bridge = createPetAgentBridge({
      client: {
        connectWebSocket: vi.fn(async () => socket.connection)
      },
      bus
    });

    await bridge.sendTask({ task: createTask(), content: "总结一下 MemOS" });
    expect(socket.connection.sendMessage).toHaveBeenCalledWith({ chatId: "chat-1", content: "总结一下 MemOS" });

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
      client: {
        connectWebSocket: vi.fn(async () => socket.connection)
      },
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
      client: {
        connectWebSocket: vi.fn(async () => socket.connection)
      },
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
