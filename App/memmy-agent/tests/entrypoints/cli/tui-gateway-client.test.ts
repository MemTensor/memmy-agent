import { describe, expect, it, vi } from "vitest";
import {
  TuiGatewayClient,
  type TuiWebSocket,
} from "../../../src/entrypoints/cli/tui-gateway-client.js";

type Listener = (...args: any[]) => void;

class FakeSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(event: Record<string, any>): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit("close");
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const bootstrapSelection = {
  preset_id: "base",
  provider: "openai",
  endpoint_id: "chat",
  protocol: "openai-chat-completions",
  model: "gpt-base",
  source: "byok",
  owner_account_id: null,
  capabilities: ["agent"],
};

const sessionSelection = {
  ...bootstrapSelection,
  preset_id: "fast",
  model: "gpt-fast",
};

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}

async function connectClient({
  historyMessages = [],
}: {
  historyMessages?: Record<string, any>[];
} = {}) {
  const sockets: FakeSocket[] = [];
  let bootstrapCount = 0;
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/webui/bootstrap")) {
      bootstrapCount += 1;
      return response({
        token: `token-${bootstrapCount}`,
        ws_path: "/gateway",
        expires_in: 300,
        model_name: "openai/gpt-test",
        model_selection: bootstrapSelection,
        tool_names: ["exec", "read_file"],
      });
    }
    if (url.includes("/webui-thread?surface=tui")) {
      return response({ schemaVersion: 3, sessionKey: "websocket:ext_Y2xpOnRlc3Q", messages: historyMessages });
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  const client = new TuiGatewayClient({
    baseUrl: "http://127.0.0.1:18980",
    sessionKey: "cli:test",
    fetchImpl,
    webSocketFactory: (url) => {
      expect(url).toContain("client_surface=tui");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as TuiWebSocket;
    },
    reconnectDelayMs: 1,
    requestTimeoutMs: 500,
  });
  const starting = client.start();
  await waitUntil(() => sockets.length === 1);
  const socket = sockets[0]!;
  socket.open();
  socket.message({ event: "ready", chat_id: "unused" });
  expect(socket.sent).toContainEqual({ type: "attach", chat_id: "ext_Y2xpOnRlc3Q" });
  socket.message({
    event: "attached",
    chat_id: "ext_Y2xpOnRlc3Q",
    model_selection: sessionSelection,
  });
  socket.message({
    event: "message_queue_snapshot",
    chat_id: "ext_Y2xpOnRlc3Q",
    revision: 0,
    items: [],
    started_items: [],
  });
  await starting;
  return { client, fetchImpl, sockets };
}

describe("TuiGatewayClient", () => {
  it("bootstraps, declares the TUI surface, attaches one Session, and hydrates TUI history", async () => {
    const { client, fetchImpl, sockets } = await connectClient({
      historyMessages: [
        { id: "user-1", role: "user", content: "from TUI" },
        { id: "assistant-1", role: "assistant", content: "answer" },
      ],
    });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:18980/webui/bootstrap",
      expect.stringContaining("/webui-thread?surface=tui"),
    ]);
    expect(client.snapshot()).toMatchObject({
      connection: "connected",
      attached: true,
      queueRevision: 0,
      modelName: "openai/gpt-test",
      modelSelection: {
        presetId: "fast",
        provider: "openai",
        endpointId: "chat",
        model: "gpt-fast",
      },
      toolNames: ["exec", "read_file"],
    });
    expect(client.snapshot().messages.map((message) => message.text)).toEqual(["from TUI", "answer"]);
    expect(sockets).toHaveLength(1);
    client.close();
  });

  it("buffers current-generation live events during history and hides non-TUI transcript events", async () => {
    let resolveHistory!: (value: Response) => void;
    const history = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    const sockets: FakeSocket[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("/webui/bootstrap")) {
        return response({ token: "token", ws_path: "/", expires_in: 300, model_name: null });
      }
      return history;
    });
    const client = new TuiGatewayClient({
      baseUrl: "http://127.0.0.1:18980",
      sessionKey: "cli:test",
      fetchImpl,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as TuiWebSocket;
      },
      requestTimeoutMs: 500,
    });
    const starting = client.start();
    await waitUntil(() => sockets.length === 1);
    const socket = sockets[0]!;
    socket.open();
    socket.message({ event: "ready" });
    socket.message({ event: "attached", chat_id: client.chatId });
    socket.message({
      event: "user",
      chat_id: client.chatId,
      text: "live TUI",
      turn_id: "turn-tui",
      client_request_id: "11111111-1111-4111-8111-111111111111",
      source: { kind: "tui", channel: "websocket" },
    });
    socket.message({
      event: "delta",
      chat_id: client.chatId,
      text: "hel",
      stream_id: "stream-tui",
      turn_id: "turn-tui",
      source: { kind: "tui", channel: "websocket" },
    });
    socket.message({
      event: "delta",
      chat_id: client.chatId,
      text: "lo",
      stream_id: "stream-tui",
      turn_id: "turn-tui",
      source: { kind: "tui", channel: "websocket" },
    });
    socket.message({
      event: "message",
      chat_id: client.chatId,
      text: "must stay hidden",
      turn_id: "turn-gui",
      source: { kind: "gui", channel: "websocket" },
    });
    socket.message({
      event: "user",
      chat_id: client.chatId,
      text: "external user must stay hidden",
      turn_id: "turn-gui",
      source: { kind: "gui", channel: "websocket" },
    });
    resolveHistory(response({
      schemaVersion: 3,
      sessionKey: `websocket:${client.chatId}`,
      messages: [{
        id: "persisted-user",
        role: "user",
        content: "live TUI",
        client_request_id: "11111111-1111-4111-8111-111111111111",
        turnId: "turn-tui",
      }, {
        id: "persisted-assistant",
        role: "assistant",
        content: "hello",
        turnId: "turn-tui",
      }],
    }));
    await starting;

    expect(client.snapshot().messages).toHaveLength(2);
    expect(client.snapshot().messages[0]).toMatchObject({ text: "live TUI", turnId: "turn-tui" });
    expect(client.snapshot().messages[1]).toMatchObject({ role: "assistant", text: "hello" });
    expect(client.snapshot().messages.some((message) => message.text.includes("hidden"))).toBe(false);
    client.close();
  });

  it("applies only consecutive queue revisions and requests one snapshot for a gap", async () => {
    const { client, sockets } = await connectClient();
    const socket = sockets[0]!;
    const first = {
      client_request_id: "11111111-1111-4111-8111-111111111111",
      text: "first",
      queued_at: "2026-08-09T12:00:00.000Z",
      source: { kind: "gui", channel: "websocket" },
    };
    socket.message({
      event: "message_queued",
      chat_id: client.chatId,
      client_request_id: first.client_request_id,
      revision: 1,
      item: first,
    });
    expect(client.snapshot().queueItems.map((item) => item.text)).toEqual(["first"]);

    socket.message({
      event: "message_queued",
      chat_id: client.chatId,
      client_request_id: "33333333-3333-4333-8333-333333333333",
      revision: 3,
      item: { ...first, client_request_id: "33333333-3333-4333-8333-333333333333", text: "gap" },
    });
    socket.message({
      event: "message_dequeued",
      chat_id: client.chatId,
      client_request_id: first.client_request_id,
      revision: 4,
      item: first,
    });
    expect(client.snapshot()).toMatchObject({ queueLoading: true, queueRevision: 1, queueItems: [] });
    expect(socket.sent.filter((frame) => frame.type === "queue_snapshot_request")).toHaveLength(1);

    socket.message({
      event: "message_queue_snapshot",
      chat_id: client.chatId,
      revision: 2,
      items: [first],
      started_items: [],
    });
    expect(client.snapshot()).toMatchObject({ queueLoading: true, queueRevision: 1, queueItems: [] });

    socket.message({
      event: "message_queue_snapshot",
      chat_id: client.chatId,
      revision: 4,
      items: [{ ...first, client_request_id: "44444444-4444-4444-8444-444444444444", text: "authoritative" }],
      started_items: [],
    });
    expect(client.snapshot()).toMatchObject({ queueLoading: false, queueRevision: 4 });
    expect(client.snapshot().queueItems.map((item) => item.text)).toEqual(["authoritative"]);
    client.close();
  });

  it("waits for Queue and Steer acknowledgements, promotes only TUI dequeues, and targets Stop", async () => {
    const { client, sockets } = await connectClient();
    const socket = sockets[0]!;
    const queueId = "11111111-1111-4111-8111-111111111111";
    const queueResult = client.submit("queued TUI question", "queue", queueId);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "message",
      client_request_id: queueId,
      turn_admission: "queue",
    });
    const queuedItem = {
      client_request_id: queueId,
      text: "queued TUI question",
      queued_at: "2026-08-09T12:00:00.000Z",
      source: { kind: "tui", channel: "websocket" },
    };
    socket.message({
      event: "message_queued",
      chat_id: client.chatId,
      client_request_id: queueId,
      revision: 1,
      item: queuedItem,
    });
    await expect(queueResult).resolves.toMatchObject({ status: "queued" });
    expect(client.snapshot().messages).toHaveLength(0);
    socket.message({
      event: "message_dequeued",
      chat_id: client.chatId,
      client_request_id: queueId,
      revision: 2,
      item: queuedItem,
    });
    expect(client.snapshot().messages).toEqual([
      expect.objectContaining({ role: "user", text: "queued TUI question" }),
    ]);

    const guiQueueId = "33333333-3333-4333-8333-333333333333";
    const guiQueuedItem = {
      client_request_id: guiQueueId,
      text: "GUI-only adjustment",
      queued_at: "2026-08-09T12:00:01.000Z",
      source: { kind: "gui", channel: "websocket" },
      queue_surface: "chat_composer",
    };
    socket.message({
      event: "message_queued",
      chat_id: client.chatId,
      client_request_id: guiQueueId,
      revision: 3,
      item: guiQueuedItem,
    });
    expect(client.snapshot().queueItems.map((item) => item.text)).toEqual(["GUI-only adjustment"]);
    socket.message({
      event: "message_dequeued",
      chat_id: client.chatId,
      client_request_id: guiQueueId,
      revision: 4,
      item: { ...guiQueuedItem, turn_admission: "steer", turn_id: "turn-gui" },
      turn_admission: "steer",
      turn_id: "turn-gui",
    });
    expect(client.snapshot().queueItems).toEqual([]);
    expect(client.snapshot().messages).toEqual([
      expect.objectContaining({ role: "user", text: "queued TUI question" }),
    ]);

    socket.message({
      event: "run_status",
      chat_id: client.chatId,
      status: "running",
      started_at: 1_786_262_400,
      turn_id: "turn-owned",
      owned_by_tui: true,
      source: { kind: "tui", channel: "websocket" },
    });
    const steerId = "22222222-2222-4222-8222-222222222222";
    const steerResult = client.submit("steer this Turn", "steer", steerId);
    expect(socket.sent.at(-1)).toMatchObject({
      turn_admission: "steer",
      expected_turn_id: "turn-owned",
    });
    socket.message({
      event: "message_steered",
      chat_id: client.chatId,
      client_request_id: steerId,
      turn_id: "turn-owned",
    });
    await expect(steerResult).resolves.toMatchObject({ status: "steered" });
    expect(client.snapshot().messages.filter((message) => message.role === "user")).toHaveLength(2);

    const stopping = client.stopOwnedTurn();
    expect(socket.sent.at(-1)).toEqual({
      type: "stop",
      chat_id: client.chatId,
      expected_turn_id: "turn-owned",
    });
    socket.message({
      event: "stop_result",
      chat_id: client.chatId,
      turn_id: "turn-owned",
      outcome: "stopped",
    });
    await expect(stopping).resolves.toBe("stopped");
    client.close();
  });

  it("re-bootstraps after a disconnect and never reuses the one-time token", async () => {
    const { client, fetchImpl, sockets } = await connectClient();
    sockets[0]!.message({
      event: "run_status",
      chat_id: client.chatId,
      status: "running",
      started_at: 1_786_262_400,
      turn_id: "turn-owned",
      owned_by_tui: true,
      source: { kind: "tui", channel: "websocket" },
    });
    sockets[0]!.message({
      event: "goal_state",
      chat_id: client.chatId,
      goal_state: { goal_id: "goal-before-reconnect", status: "active" },
    });
    sockets[0]!.disconnect();
    expect(client.snapshot()).toMatchObject({
      busy: false,
      ownedByTui: false,
      activeTurnId: null,
      startedAt: null,
      goalState: null,
    });
    await waitUntil(() => sockets.length === 2);
    const second = sockets[1]!;
    second.open();
    second.message({ event: "ready" });
    second.message({ event: "attached", chat_id: client.chatId });
    second.message({
      event: "message_queue_snapshot",
      chat_id: client.chatId,
      revision: 0,
      items: [],
      started_items: [],
    });
    await waitUntil(() => client.snapshot().connection === "connected");
    const bootstrapCalls = fetchImpl.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.endsWith("/webui/bootstrap"));
    expect(bootstrapCalls).toHaveLength(2);
    client.close();
  });

  it("resends an unacknowledged submission with the same id after reconnect", async () => {
    const { client, sockets } = await connectClient();
    const clientRequestId = "55555555-5555-4555-8555-555555555555";
    const submission = client.submit("survive reconnect", "queue", clientRequestId);
    expect(sockets[0]!.sent.at(-1)).toMatchObject({
      type: "message",
      client_request_id: clientRequestId,
      content: "survive reconnect",
    });

    sockets[0]!.disconnect();
    await waitUntil(() => sockets.length === 2);
    const second = sockets[1]!;
    second.open();
    second.message({ event: "ready" });
    second.message({ event: "attached", chat_id: client.chatId });
    second.message({
      event: "message_queue_snapshot",
      chat_id: client.chatId,
      revision: 0,
      items: [],
      started_items: [],
    });
    await waitUntil(() => client.snapshot().connection === "connected");
    expect(second.sent.filter((frame) => frame.type === "message")).toEqual([
      expect.objectContaining({
        client_request_id: clientRequestId,
        content: "survive reconnect",
      }),
    ]);
    second.message({
      event: "message_queued",
      chat_id: client.chatId,
      client_request_id: clientRequestId,
      revision: 1,
      item: {
        client_request_id: clientRequestId,
        text: "survive reconnect",
        queued_at: "2026-08-09T12:00:00.000Z",
        source: { kind: "tui", channel: "websocket" },
      },
    });
    await expect(submission).resolves.toEqual({ clientRequestId, status: "queued" });
    client.close();
  });

  it("stores the Goal state delivered by the attach snapshot sequence", async () => {
    const { client, sockets } = await connectClient();
    sockets[0]!.message({
      event: "goal_state",
      chat_id: client.chatId,
      goal_state: {
        goal_id: "goal-1",
        status: "active",
        objective: "finish the work",
      },
    });
    expect(client.snapshot().goalState).toEqual({
      goal_id: "goal-1",
      status: "active",
      objective: "finish the work",
    });
    client.close();
  });

  it("updates committed selection only after a matching /model acknowledgement", async () => {
    const { client, sockets } = await connectClient();
    const socket = sockets[0]!;
    const requestId = "77777777-7777-4777-8777-777777777777";
    const switched = {
      ...sessionSelection,
      preset_id: "power",
      provider: "anthropic",
      endpoint_id: "messages",
      protocol: "anthropic-messages",
      model: "claude-sonnet-4-5",
    };
    const submission = client.submit("/model power", "queue", requestId);

    socket.message({
      event: "runtime_model_updated",
      chat_id: client.chatId,
      client_request_id: requestId,
      model_selection: switched,
    });
    expect(client.snapshot().modelSelection?.presetId).toBe("fast");

    socket.message({
      event: "message_accepted",
      chat_id: client.chatId,
      client_request_id: requestId,
      turn_id: "turn-model",
      model_selection: sessionSelection,
    });
    await expect(submission).resolves.toMatchObject({ status: "accepted" });

    socket.message({
      event: "runtime_model_updated",
      chat_id: "another-chat",
      client_request_id: requestId,
      model_selection: switched,
    });
    socket.message({
      event: "runtime_model_updated",
      chat_id: client.chatId,
      client_request_id: "88888888-8888-4888-8888-888888888888",
      model_selection: switched,
    });
    expect(client.snapshot().modelSelection?.presetId).toBe("fast");

    socket.message({
      event: "runtime_model_updated",
      chat_id: client.chatId,
      client_request_id: requestId,
      model_selection: switched,
    });
    expect(client.snapshot().modelSelection).toMatchObject({
      presetId: "power",
      provider: "anthropic",
      endpointId: "messages",
      protocol: "anthropic-messages",
      model: "claude-sonnet-4-5",
      source: "byok",
      ownerAccountId: null,
    });
    client.close();
  });
});
