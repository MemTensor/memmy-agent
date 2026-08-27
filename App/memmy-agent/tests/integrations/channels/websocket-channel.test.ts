import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { GoalRuntime } from "../../../src/core/agent-runtime/goal-runtime.js";
import { getMediaDir } from "../../../src/config/paths.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import {
  WebSocketChannel,
  WebSocketConfig,
  issueRouteSecretMatches,
  isValidChatId,
  normalizeConfigPath,
  normalizeHttpPath,
  parseEnvelope,
  parseInboundPayload,
  parseQuery,
  parseRequestPath,
  stripTrailingSlash,
} from "../../../src/integrations/channels/websocket.js";
import { webuiTranscriptPath } from "../../../src/entrypoints/frontend-bridge/transcript.js";
import { toGuiChatId } from "../../../src/entrypoints/frontend-bridge/gui-session-projection.js";
import { websocketTurnWallStartTimes } from "../../../src/core/session/webui-turns.js";

const WINDOWS_COMMAND_ERROR = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。";

function connection(): { send: ReturnType<typeof vi.fn>; remoteAddress: string[] } {
  return { send: vi.fn(async () => undefined), remoteAddress: ["127.0.0.1"] };
}

function sent(ws: { send: ReturnType<typeof vi.fn> }, index = 0): any {
  return JSON.parse(ws.send.mock.calls[index][0]);
}

function modelSelection(preset: string, provider: string, model: string): any {
  const endpointId = provider === "anthropic" ? "messages" : "chat";
  const protocol = provider === "anthropic" ? "anthropic-messages" : "openai-chat-completions";
  return {
    preset,
    presetId: preset,
    provider,
    endpointId,
    protocol,
    model,
    source: "byok",
    ownerAccountId: null,
    capability: "agent",
    capabilities: ["agent"],
    snapshot: {
      provider: null,
      model,
      contextWindowTokens: 200_000,
      signature: [provider, model],
    },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

function tinyPngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

function writeWebuiImage(name = "screen.png"): string {
  const dir = path.join(getMediaDir("websocket"), "webui");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, tinyPngBytes());
  return fs.realpathSync(filePath);
}

function writeWebuiText(name = "report.txt"): string {
  const dir = path.join(getMediaDir("websocket"), "webui");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "Quarterly revenue is $5M", "utf8");
  return fs.realpathSync(filePath);
}

function tempDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-websocket-test-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

function webuiChannel(bus: MessageBus, root = tempDataDir()): WebSocketChannel {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return new WebSocketChannel({}, bus, {
    sessionManager: new SessionManager(path.join(root, "sessions")),
    workspacePath: workspace,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  websocketTurnWallStartTimes.clear();
  if (oldDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WebSocket channel", () => {
  it("parses inbound payloads and validates chat ids", () => {
    expect(parseInboundPayload(JSON.stringify({ text: "hello" }))).toBe("hello");
    expect(parseInboundPayload("raw text")).toBe("raw text");
    expect(isValidChatId("chat-1")).toBe(true);
    expect(isValidChatId("")).toBe(false);
  });

  it("rejects an invalid transcript surface before reading a Session", () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    channel.apiTokens.set("api-token", Number.POSITIVE_INFINITY);

    const response = channel.handleWebuiThreadGet({
      path: "/api/sessions/websocket%3Achat/webui-thread?surface=other",
      headers: { authorization: "Bearer api-token" },
    }, "websocket%3Achat");

    expect(response.status).toBe(400);
    expect(String(response.body)).toContain("surface_invalid");
  });

  it("returns the complete confirmed model selection for a new chat's first message", async () => {
    const root = tempDataDir();
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const bus = new MessageBus();
    const resolver = vi.fn(() => modelSelection("current-default", "openai", "gpt-5"));
    const channel = new WebSocketChannel({}, bus, {
      sessionManager: new SessionManager(path.join(root, "sessions")),
      workspacePath: workspace,
      modelSelectionResolver: resolver,
    });
    const ws = connection();
    const requestId = "11111111-1111-4111-8111-111111111111";

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "new_chat",
      client_request_id: requestId,
      model_preset: "current-default",
    });

    const attached = sent(ws);
    expect(attached).toMatchObject({
      event: "attached",
      client_request_id: requestId,
      model_preset: "current-default",
      model_provider: "openai",
      model: "gpt-5",
      model_selection: {
        preset_id: "current-default",
        provider: "openai",
        endpoint_id: "chat",
        protocol: "openai-chat-completions",
        model: "gpt-5",
        source: "byok",
        owner_account_id: null,
        capabilities: ["agent"],
      },
    });

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "message",
      chat_id: attached.chat_id,
      content: "hello",
      webui: true,
      client_request_id: requestId,
      model_preset: attached.model_preset,
      target: { kind: "standalone" },
    });

    const inbound = await bus.nextInbound();
    expect(inbound.chatId).toBe(attached.chat_id);
    expect(inbound.metadata).toMatchObject({
      client_request_id: requestId,
      model_preset: "current-default",
      model_provider: "openai",
      model: "gpt-5",
    });
    expect(resolver).toHaveBeenNthCalledWith(1, {
      requestedPreset: "current-default",
    });
    expect(resolver).toHaveBeenNthCalledWith(2, {
      requestedPreset: "current-default",
    });
  });

  it("returns an existing Session's committed model selection on attach", async () => {
    const root = tempDataDir();
    const sessions = new SessionManager(path.join(root, "sessions"));
    const session = sessions.getOrCreate("websocket:chat-existing");
    session.metadata.modelPreset = "fast";
    session.metadata.modelSelection = {
      presetId: "fast",
      provider: "anthropic",
      endpointId: "messages",
      protocol: "anthropic-messages",
      model: "claude-sonnet-4-5",
      source: "byok",
      ownerAccountId: null,
      capabilities: ["agent"],
    };
    sessions.save(session);
    const channel = new WebSocketChannel({}, new MessageBus(), { sessionManager: sessions });
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-existing" });

    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      event: "attached",
      chat_id: "chat-existing",
      model_preset: "fast",
      model_provider: "anthropic",
      model: "claude-sonnet-4-5",
      model_selection: {
        preset_id: "fast",
        provider: "anthropic",
        endpoint_id: "messages",
        protocol: "anthropic-messages",
        model: "claude-sonnet-4-5",
        source: "byok",
        owner_account_id: null,
        capabilities: ["agent"],
      },
    });
  });

  it("rejects an explicitly unavailable new-chat selection without falling back", async () => {
    const resolver = vi.fn((input: any) => input.requestedPreset === "deleted-model"
      ? null
      : modelSelection("current-default", "openai", "gpt-5"));
    const channel = new WebSocketChannel({}, new MessageBus(), {
      modelSelectionResolver: resolver,
    });
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "new_chat",
      client_request_id: "12121212-1212-4212-8212-121212121212",
      model_preset: "deleted-model",
    });

    expect(sent(ws)).toEqual({
      event: "error",
      client_request_id: "12121212-1212-4212-8212-121212121212",
      detail: "new_chat_rejected",
      reason: "model_selection_unavailable",
    });
    expect(channel.subscriptions.size).toBe(0);
  });

  it("acknowledges queued WebUI requests without accepting or duplicating them", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const first = connection();
    const duplicate = connection();
    const chatId = "chat-queued";
    const clientRequestId = "11111111-1111-4111-8111-111111111111";
    const request = {
      type: "message",
      chat_id: chatId,
      content: "queued work",
      webui: true,
      client_request_id: clientRequestId,
      target: { kind: "standalone" },
    };

    await channel.dispatchEnvelope(first, "client-1", request);
    expect(bus.inboundSize).toBe(1);
    expect(channel.inflightWebuiMessageRequests.size).toBe(1);

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: {
        webuiMessageQueued: true,
        webuiRequestSessionKey: `websocket:${chatId}`,
        clientRequestId,
      },
    }));
    const firstQueued = first.send.mock.calls
      .map(([payload]) => JSON.parse(payload))
      .find((event) => event.event === "message_queued");
    expect(firstQueued).toEqual({
      event: "message_queued",
      chat_id: chatId,
      client_request_id: clientRequestId,
      revision: 0,
    });

    await channel.dispatchEnvelope(duplicate, "client-2", request);
    expect(bus.inboundSize).toBe(1);
    const duplicateQueued = duplicate.send.mock.calls
      .map(([payload]) => JSON.parse(payload))
      .find((event) => event.event === "message_queued");
    expect(duplicateQueued).toEqual({
      event: "message_queued",
      chat_id: chatId,
      client_request_id: clientRequestId,
      revision: 0,
    });

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: {
        webuiMessageAccepted: true,
        webuiRequestSessionKey: `websocket:${chatId}`,
        clientRequestId,
      },
    }));
    expect(channel.inflightWebuiMessageRequests.size).toBe(0);
    expect(first.send.mock.calls.map(([payload]) => JSON.parse(payload).event)).toContain("message_accepted");
    expect(duplicate.send.mock.calls.map(([payload]) => JSON.parse(payload).event)).toContain("message_accepted");
  });

  it("broadcasts visible composer queue items while leaving unmarked requests transport-only", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const first = connection();
    const second = connection();
    const duplicate = connection();
    const chatId = "chat-visible-queue";
    const sessionKey = `websocket:${chatId}`;
    const clientRequestId = "66666666-6666-4666-8666-666666666666";
    channel.connectionSurface.set(first, "gui");
    channel.connectionSurface.set(second, "tui");
    channel.attachConnection(first, chatId);
    channel.attachConnection(second, chatId);
    const request = {
      type: "message",
      chat_id: chatId,
      content: "visible queued work",
      webui: true,
      queue_surface: "chat_composer",
      client_request_id: clientRequestId,
      target: { kind: "standalone" },
    };

    await channel.dispatchEnvelope(first, "client-1", request);
    const inbound = await bus.nextInbound();
    expect(inbound.metadata).toMatchObject({
      client_request_id: clientRequestId,
      webui_queue_surface: "chat_composer",
    });
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: {
        webuiMessageQueued: true,
        webuiRequestSessionKey: sessionKey,
        clientRequestId,
        webuiQueueItem: {
          clientRequestId,
          content: "visible queued work",
          media: [],
          queuedAt: "2026-08-09T12:00:00.000Z",
          sessionKey,
          source: { kind: "gui", channel: "websocket" },
        },
        queueRevision: 1,
      },
    }));

    const expectedItem = {
      client_request_id: clientRequestId,
      text: "visible queued work",
      media_urls: [],
      queued_at: "2026-08-09T12:00:00.000Z",
      source: { kind: "gui", channel: "websocket" },
    };
    for (const ws of [first, second]) {
      expect(ws.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual({
        event: "message_queued",
        chat_id: chatId,
        client_request_id: clientRequestId,
        item: expectedItem,
        revision: 1,
      });
    }

    await channel.dispatchEnvelope(duplicate, "client-3", request);
    expect(duplicate.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual({
      event: "message_queued",
      chat_id: chatId,
      client_request_id: clientRequestId,
      item: expectedItem,
      revision: 1,
    });

    const invalid = connection();
    await channel.dispatchEnvelope(invalid, "client-invalid", { ...request, queue_surface: "pet" });
    expect(invalid.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual(expect.objectContaining({
      event: "error",
      reason: "queue_surface_invalid",
    }));
  });

  it("derives the immutable Turn source from the connection surface", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const tui = connection();
    channel.connectionSurface.set(tui, "tui");
    const chatId = "chat-tui-source";

    await channel.dispatchEnvelope(tui, "tui-client", {
      type: "message",
      chat_id: chatId,
      content: "from the terminal",
      webui: true,
      queue_surface: "chat_composer",
      client_request_id: "12121212-1212-4212-8212-121212121212",
      target: { kind: "standalone" },
      turn_source: { kind: "gui", channel: "spoofed" },
    });

    const inbound = await bus.nextInbound();
    expect(inbound.turnSource).toEqual({ kind: "tui", channel: "websocket" });
    expect(inbound.metadata.turn_source).toBeUndefined();
  });

  it("replays an idempotent Steer acknowledgement without submitting a second Turn", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const tui = connection();
    const gui = connection();
    const duplicate = connection();
    const chatId = "chat-steer-idempotent";
    const sessionKey = `websocket:${chatId}`;
    const clientRequestId = "13131313-1313-4313-8313-131313131313";
    const turnId = "turn-tui-owned";
    const request = {
      type: "message",
      chat_id: chatId,
      content: "add this to the current Turn",
      webui: true,
      queue_surface: "chat_composer",
      client_request_id: clientRequestId,
      target: { kind: "standalone" },
      turn_admission: "steer",
      expected_turn_id: turnId,
    };
    channel.connectionSurface.set(tui, "tui");
    channel.connectionSurface.set(gui, "gui");
    channel.connectionSurface.set(duplicate, "tui");
    channel.attachConnection(tui, chatId);
    channel.attachConnection(gui, chatId);
    channel.activeTurnIdByChatId.set(chatId, turnId);
    channel.activeTurnSourceByChatId.set(chatId, { kind: "tui", channel: "websocket" });

    await channel.dispatchEnvelope(tui, "tui-client", request);
    expect(bus.inboundSize).toBe(1);
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: {
        webuiMessageSteered: true,
        webuiRequestSessionKey: sessionKey,
        clientRequestId,
        turnId,
        steeredContent: request.content,
        steeredMedia: [],
        turnSource: { kind: "tui", channel: "websocket" },
      },
    }));

    for (const ws of [tui, gui]) {
      expect(ws.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual(expect.objectContaining({
        event: "user",
        chat_id: chatId,
        text: request.content,
        client_request_id: clientRequestId,
        turn_id: turnId,
        source: { kind: "tui", channel: "websocket" },
      }));
    }
    expect(tui.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual({
      event: "message_steered",
      chat_id: chatId,
      client_request_id: clientRequestId,
      turn_id: turnId,
    });

    await channel.dispatchEnvelope(duplicate, "tui-client-2", request);
    expect(bus.inboundSize).toBe(1);
    expect(duplicate.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual({
      event: "message_steered",
      chat_id: chatId,
      client_request_id: clientRequestId,
      turn_id: turnId,
    });
  });

  it("projects all Turn content to GUI and only TUI-owned Turn content to TUI", async () => {
    const channel = webuiChannel(new MessageBus());
    const gui = connection();
    const tui = connection();
    const chatId = "chat-surface-projection";
    channel.connectionSurface.set(gui, "gui");
    channel.connectionSurface.set(tui, "tui");
    channel.attachConnection(gui, chatId);
    channel.attachConnection(tui, chatId);

    await channel.sendRunStatus(chatId, "running", {
      startedAt: 10,
      turnId: "turn-gui",
      source: { kind: "gui", channel: "websocket" },
    });
    await channel.sendTurnPayload(chatId, {
      event: "user",
      chat_id: chatId,
      text: "private GUI question",
      turn_id: "turn-gui",
      source: { kind: "gui", channel: "websocket" },
    });
    await channel.sendTurnPayload(chatId, {
      event: "message",
      chat_id: chatId,
      text: "private GUI answer",
      turn_id: "turn-gui",
      source: { kind: "gui", channel: "websocket" },
    });

    expect(gui.send.mock.calls.map(([payload]) => JSON.parse(payload))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "user", text: "private GUI question", turn_id: "turn-gui" }),
      expect.objectContaining({ event: "message", text: "private GUI answer", turn_id: "turn-gui" }),
    ]));
    expect(tui.send.mock.calls.map(([payload]) => JSON.parse(payload))).toEqual([
      {
        event: "run_status",
        chat_id: chatId,
        status: "running",
        busy: true,
        owned_by_tui: false,
      },
    ]);

    gui.send.mockClear();
    tui.send.mockClear();
    await channel.sendRunStatus(chatId, "running", {
      startedAt: 20,
      turnId: "turn-tui",
      source: { kind: "tui", channel: "websocket" },
    });
    await channel.sendTurnPayload(chatId, {
      event: "user",
      chat_id: chatId,
      text: "shared TUI question",
      turn_id: "turn-tui",
      source: { kind: "tui", channel: "websocket" },
    });

    expect(tui.send.mock.calls.map(([payload]) => JSON.parse(payload))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "run_status",
        turn_id: "turn-tui",
        owned_by_tui: true,
      }),
      expect.objectContaining({
        event: "user",
        text: "shared TUI question",
        turn_id: "turn-tui",
      }),
    ]));
  });

  it("keeps a TUI connection attached to one Session and targets Stop only there", async () => {
    const stopExpectedTurn = vi.fn(async () => "stopped" as const);
    const channel = new WebSocketChannel({}, new MessageBus(), { stopExpectedTurn });
    const tui = connection();
    channel.connectionSurface.set(tui, "tui");
    channel.attachConnection(tui, "chat-old");
    channel.attachConnection(tui, "chat-current");
    expect(channel.connectionChats.get(tui)).toEqual(new Set(["chat-current"]));
    expect(channel.subscriptions.get("chat-old")).toBeUndefined();

    await channel.dispatchEnvelope(tui, "tui-client", {
      type: "stop",
      chat_id: "chat-other",
      expected_turn_id: "turn-other",
    });
    expect(stopExpectedTurn).not.toHaveBeenCalled();
    expect(sent(tui)).toMatchObject({
      event: "error",
      detail: "stop_failed",
      reason: "session_not_attached",
    });

    tui.send.mockClear();
    await channel.dispatchEnvelope(tui, "tui-client", {
      type: "stop",
      chat_id: "chat-current",
      expected_turn_id: "turn-current",
    });
    expect(stopExpectedTurn).toHaveBeenCalledWith("websocket:chat-current", "turn-current");
    expect(sent(tui)).toEqual({
      event: "stop_result",
      chat_id: "chat-current",
      turn_id: "turn-current",
      stopped: 1,
      outcome: "stopped",
    });
  });

  it("serializes attach snapshots before a concurrent dequeue event", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const ws = connection();
    const chatId = "chat-queue-snapshot";
    const sessionKey = `websocket:${chatId}`;
    const clientRequestId = "77777777-7777-4777-8777-777777777777";
    const startedRequestId = "99999999-9999-4999-8999-999999999999";
    const entered = deferred<void>();
    const release = deferred<void>();
    const descriptor = {
      clientRequestId,
      content: "snapshot item",
      media: [],
      queuedAt: "2026-08-09T12:00:00.000Z",
      sessionKey,
      source: { kind: "gui" as const, channel: "websocket" },
      queueSurface: null,
    };
    const startedDescriptor = {
      ...descriptor,
      clientRequestId: startedRequestId,
      content: "already started",
      queuedAt: "2026-08-09T12:00:01.000Z",
    };
    channel.getWebuiQueueSnapshot = vi.fn(async () => {
      entered.resolve(undefined);
      await release.promise;
      return { revision: 1, items: [descriptor], startedItems: [startedDescriptor] };
    });

    const attaching = channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: chatId });
    await entered.promise;
    const dequeuing = channel.send(new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: {
        webuiMessageDequeued: true,
        webuiRequestSessionKey: sessionKey,
        clientRequestId,
        webuiQueueItem: descriptor,
        queueRevision: 2,
      },
    }));
    await Promise.resolve();
    expect(ws.send.mock.calls.map(([payload]) => JSON.parse(payload).event)).not.toContain("message_dequeued");

    release.resolve(undefined);
    await Promise.all([attaching, dequeuing]);
    const events = ws.send.mock.calls.map(([payload]) => JSON.parse(payload));
    const snapshotIndex = events.findIndex((event) => event.event === "message_queue_snapshot");
    const dequeuedIndex = events.findIndex((event) => event.event === "message_dequeued");
    expect(snapshotIndex).toBeGreaterThan(events.findIndex((event) => event.event === "run_status_snapshot"));
    expect(dequeuedIndex).toBeGreaterThan(snapshotIndex);
    expect(events[snapshotIndex]).toMatchObject({
      chat_id: chatId,
      items: [expect.objectContaining({ client_request_id: clientRequestId })],
      started_items: [expect.objectContaining({ client_request_id: startedRequestId })],
    });
    expect(events[dequeuedIndex]).toMatchObject({
      chat_id: chatId,
      client_request_id: clientRequestId,
      item: expect.objectContaining({ client_request_id: clientRequestId }),
    });

    const repeated = connection();
    await channel.dispatchEnvelope(repeated, "client-2", { type: "attach", chat_id: chatId });
    expect(repeated.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual(expect.objectContaining({
      event: "message_queue_snapshot",
      items: [expect.objectContaining({ client_request_id: clientRequestId })],
      started_items: [expect.objectContaining({ client_request_id: startedRequestId })],
    }));
    expect(channel.getWebuiQueueSnapshot).toHaveBeenCalledTimes(2);
  });

  it("serves an attached queue snapshot request and rejects another Session", async () => {
    const channel = webuiChannel(new MessageBus());
    const ws = connection();
    const chatId = "chat-explicit-snapshot";
    channel.attachConnection(ws, chatId);
    channel.getWebuiQueueSnapshot = vi.fn(async () => ({
      revision: 7,
      items: [],
      startedItems: [],
    }));

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "queue_snapshot_request",
      chat_id: chatId,
    });
    expect(sent(ws)).toEqual({
      event: "message_queue_snapshot",
      chat_id: chatId,
      revision: 7,
      items: [],
      started_items: [],
    });

    ws.send.mockClear();
    await channel.dispatchEnvelope(ws, "client-1", {
      type: "queue_snapshot_request",
      chat_id: "chat-not-attached",
    });
    expect(sent(ws)).toMatchObject({
      event: "error",
      chat_id: "chat-not-attached",
      detail: "queue_snapshot_request_invalid",
    });
    expect(channel.getWebuiQueueSnapshot).toHaveBeenCalledTimes(1);
  });

  it("projects an IM queue event only to the matching canonical Session subscribers", async () => {
    const channel = webuiChannel(new MessageBus());
    const matching = connection();
    const other = connection();
    const sessionKey = "slack:room-42";
    const chatId = toGuiChatId(sessionKey);
    const clientRequestId = "14141414-1414-4414-8414-141414141414";
    channel.attachConnection(matching, chatId);
    channel.attachConnection(other, "chat-other-session");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "room-42",
      content: "",
      metadata: {
        webuiMessageQueued: true,
        webuiRequestSessionKey: sessionKey,
        clientRequestId,
        queueRevision: 1,
        webuiQueueItem: {
          clientRequestId,
          content: "from Slack",
          media: [],
          queuedAt: "2026-08-09T12:00:00.000Z",
          sessionKey,
          source: { kind: "im", channel: "slack" },
        },
      },
    }));

    expect(sent(matching)).toMatchObject({
      event: "message_queued",
      chat_id: chatId,
      revision: 1,
      item: {
        text: "from Slack",
        source: { kind: "im", channel: "slack" },
      },
    });
    expect(other.send).not.toHaveBeenCalled();

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "room-42",
      content: "",
      metadata: {
        webuiMessageQueueRemoved: true,
        webuiRequestSessionKey: sessionKey,
        clientRequestId,
        queueRevision: 2,
      },
    }));
    expect(sent(matching, 1)).toEqual({
      event: "message_queue_removed",
      chat_id: chatId,
      client_request_id: clientRequestId,
      revision: 2,
    });
    expect(other.send).not.toHaveBeenCalled();
  });

  it("removes one queued idempotent request, broadcasts it, and preserves started Turns", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const first = connection();
    const second = connection();
    const chatId = "chat-queue-remove";
    const clientRequestId = "88888888-8888-4888-8888-888888888888";
    const missingRequestId = "99999999-9999-4999-8999-999999999999";
    const startedRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    channel.attachConnection(first, chatId);
    channel.attachConnection(second, chatId);
    const removeQueuedWebuiMessage = vi.fn()
      .mockResolvedValueOnce({ outcome: "removed", revision: 3 })
      .mockResolvedValueOnce({ outcome: "missing", revision: 3 })
      .mockResolvedValueOnce({ outcome: "already_dequeued", revision: 4 });
    channel.removeQueuedWebuiMessage = removeQueuedWebuiMessage;
    await channel.dispatchEnvelope(first, "client-message", {
      type: "message",
      chat_id: chatId,
      content: "remove me",
      webui: true,
      queue_surface: "chat_composer",
      client_request_id: clientRequestId,
      target: { kind: "standalone" },
    });
    await bus.nextInbound();

    const remove = async (ws: ReturnType<typeof connection>, requestId: string, targetId: string) => {
      await channel.dispatchEnvelope(ws, "client-remove", {
        type: "queue_remove",
        chat_id: chatId,
        request_id: requestId,
        client_request_id: targetId,
      });
    };
    await remove(first, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", clientRequestId);
    expect(channel.inflightWebuiMessageRequests.size).toBe(0);
    for (const ws of [first, second]) {
      expect(ws.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual({
        event: "message_queue_removed",
        chat_id: chatId,
        client_request_id: clientRequestId,
        revision: 3,
      });
    }
    expect(first.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual(expect.objectContaining({
      event: "queue_remove_result",
      client_request_id: clientRequestId,
      ok: true,
      outcome: "removed",
    }));

    await remove(second, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", missingRequestId);
    expect(first.send.mock.calls.map(([payload]) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({
        event: "message_queue_removed",
        client_request_id: missingRequestId,
      }),
    );
    await remove(first, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", startedRequestId);
    expect(first.send.mock.calls.map(([payload]) => JSON.parse(payload))).toContainEqual(expect.objectContaining({
      event: "queue_remove_result",
      client_request_id: startedRequestId,
      ok: true,
      outcome: "already_dequeued",
    }));
    expect(second.send.mock.calls.map(([payload]) => JSON.parse(payload))).not.toContainEqual(expect.objectContaining({
      event: "message_queue_removed",
      client_request_id: startedRequestId,
    }));

    const callsBeforeInvalid = removeQueuedWebuiMessage.mock.calls.length;
    await channel.dispatchEnvelope(first, "client-invalid", {
      type: "queue_remove",
      chat_id: chatId,
      request_id: "not-a-uuid",
      client_request_id: clientRequestId,
    });
    expect(removeQueuedWebuiMessage).toHaveBeenCalledTimes(callsBeforeInvalid);
    expect(first.send.mock.calls.map(([payload]) => JSON.parse(payload)).at(-1)).toMatchObject({
      event: "queue_remove_result",
      ok: false,
      error: "invalid_request",
    });

    const unattached = connection();
    await remove(unattached, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", clientRequestId);
    expect(removeQueuedWebuiMessage).toHaveBeenCalledTimes(callsBeforeInvalid);
    expect(sent(unattached)).toMatchObject({
      event: "queue_remove_result",
      ok: false,
      error: "invalid_request",
    });
  });

  it("steers one GUI composer queue item with ordered idempotent broadcasts", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const requester = connection();
    const observer = connection();
    const tui = connection();
    const chatId = "chat-queue-steer";
    const sessionKey = `websocket:${chatId}`;
    const clientRequestId = "12121212-1212-4212-8212-121212121212";
    const requestId = "34343434-3434-4434-8434-343434343434";
    const turnId = "mec5x2l7-k3p9w8qd";
    channel.connectionSurface.set(requester, "gui");
    channel.connectionSurface.set(observer, "gui");
    channel.connectionSurface.set(tui, "tui");
    channel.attachConnection(requester, chatId);
    channel.attachConnection(observer, chatId);
    channel.attachConnection(tui, chatId);
    await channel.dispatchEnvelope(requester, "client-message", {
      type: "message",
      chat_id: chatId,
      content: "adjust the active turn",
      webui: true,
      queue_surface: "chat_composer",
      client_request_id: clientRequestId,
      target: { kind: "standalone" },
    });
    await bus.nextInbound();
    requester.send.mockClear();
    observer.send.mockClear();
    tui.send.mockClear();
    const descriptor = {
      clientRequestId,
      content: "adjust the active turn",
      media: [],
      queuedAt: "2026-08-10T12:00:00.000Z",
      sessionKey,
      source: { kind: "gui" as const, channel: "websocket" },
      queueSurface: "chat_composer" as const,
      turnAdmission: "steer" as const,
      turnId,
    };
    channel.steerQueuedWebuiMessage = vi.fn(async () => ({
      outcome: "steered" as const,
      revision: 2,
      turnId,
      descriptor,
    }));

    await channel.dispatchEnvelope(requester, "client-control", {
      type: "queue_steer",
      chat_id: chatId,
      request_id: requestId,
      client_request_id: clientRequestId,
      expected_turn_id: turnId,
    });

    const requesterEvents = requester.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(requesterEvents.map((event) => event.event)).toEqual([
      "message_dequeued",
      "message_steered",
      "queue_steer_result",
    ]);
    expect(requesterEvents[0]).toMatchObject({
      client_request_id: clientRequestId,
      revision: 2,
      turn_admission: "steer",
      turn_id: turnId,
      item: {
        queue_surface: "chat_composer",
        turn_admission: "steer",
        turn_id: turnId,
      },
    });
    expect(requesterEvents[2]).toMatchObject({
      ok: true,
      outcome: "steered",
      turn_id: turnId,
    });
    expect(observer.send.mock.calls.map(([payload]) => JSON.parse(payload))).toEqual([
      expect.objectContaining({ event: "message_dequeued", client_request_id: clientRequestId }),
    ]);
    expect(tui.send.mock.calls.map(([payload]) => JSON.parse(payload))).toEqual([
      expect.objectContaining({ event: "message_dequeued", client_request_id: clientRequestId }),
    ]);
    expect(channel.inflightWebuiMessageRequests.get(`${sessionKey}\0${clientRequestId}`))
      .toMatchObject({ queued: false, steeredTurnId: turnId });

    await channel.dispatchEnvelope(tui, "tui-control", {
      type: "queue_steer",
      chat_id: chatId,
      request_id: "78787878-7878-4878-8878-787878787878",
      client_request_id: clientRequestId,
      expected_turn_id: turnId,
    });
    expect(channel.steerQueuedWebuiMessage).toHaveBeenCalledTimes(1);
    expect(tui.send.mock.calls.map(([payload]) => JSON.parse(payload)).at(-1)).toMatchObject({
      event: "queue_steer_result",
      ok: false,
      error: "invalid_request",
    });
  });

  it("rejects new chat creation when no usable default model exists", async () => {
    const channel = new WebSocketChannel({}, new MessageBus(), {
      modelSelectionResolver: () => null,
    });
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "new_chat",
      client_request_id: "22222222-2222-4222-8222-222222222222",
    });

    expect(sent(ws)).toEqual({
      event: "error",
      client_request_id: "22222222-2222-4222-8222-222222222222",
      detail: "new_chat_rejected",
      reason: "model_selection_unavailable",
    });
    expect(channel.subscriptions.size).toBe(0);
  });

  it("sends messages to attached chat connections", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = { send: vi.fn<(payload: string) => Promise<void>>(async () => undefined) };
    channel.attachConnection(ws, "chat-1");

    await channel.send(new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "hello", metadata: { x: 1 }, media: ["a.png"] }));

    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      event: "message",
      chat_id: "chat-1",
      text: "hello",
      content: "hello",
      metadata: { x: 1 },
      media: ["a.png"],
    });
  });

  it("consumes a successful WebUI Goal creation acknowledgement", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-goal");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-goal",
      content: "Goal created.\n## Goal\n{ ... }",
      metadata: { webuiGoalCreateAck: true, webui: true },
    }));

    expect(ws.send).not.toHaveBeenCalled();
    expect(fs.existsSync(webuiTranscriptPath("websocket:chat-goal"))).toBe(false);
  });

  it("sends and persists structured model errors without leaking internal metadata", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-quota");

    await channel.send(
      new OutboundMessage({
        channel: "websocket",
        chatId: "chat-quota",
        content: "当前模型额度已用完",
        metadata: {
          x: 1,
          modelErrorCategory: "quota_exhausted",
          modelErrorDetail: "Error: raw provider detail 40309",
          modelErrorContext: {
            category: "quota_exhausted",
            presetId: "byok-agent",
            source: "byok",
            provider: "openai",
            model: "gpt-4o",
            capability: "agent",
            apiKey: "must-not-leak",
            extraHeaders: { Authorization: "must-not-leak" }
          }
        },
      }),
    );

    expect(sent(ws)).toMatchObject({
      event: "message",
      content: "当前模型额度已用完",
      metadata: { x: 1 },
      model_error: {
        category: "quota_exhausted",
        detail: "Error: raw provider detail 40309",
        presetId: "byok-agent",
        source: "byok",
        provider: "openai",
        model: "gpt-4o",
        capability: "agent"
      },
    });
    expect(sent(ws).metadata).not.toHaveProperty("modelErrorCategory");
    expect(sent(ws).metadata).not.toHaveProperty("modelErrorDetail");
    expect(sent(ws).metadata).not.toHaveProperty("modelErrorContext");
    expect(JSON.stringify(sent(ws))).not.toContain("must-not-leak");
    const transcript = fs
      .readFileSync(webuiTranscriptPath("websocket:chat-quota"), "utf8")
      .trim()
      .split(/\n/u)
      .map((line) => JSON.parse(line));
    expect(transcript).toHaveLength(1);
    expect(transcript[0].model_error).toEqual({
      category: "quota_exhausted",
      detail: "Error: raw provider detail 40309",
      presetId: "byok-agent",
      source: "byok",
      provider: "openai",
      model: "gpt-4o",
      capability: "agent"
    });
    expect(transcript[0].metadata).toEqual({ x: 1 });

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-quota",
      content: "平台服务响应异常，请稍后重试。",
      metadata: {
        modelErrorCategory: "model_failed",
        modelErrorDetail: "Error: raw provider failure"
      }
    }));
    expect(sent(ws, 1).model_error).toEqual({
      category: "model_failed",
      detail: "Error: raw provider failure"
    });

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-quota",
      content: "图片解析失败，请稍后重试",
      metadata: {
        modelErrorCategory: "image_analysis_failed",
        modelErrorDetail: "Error: internal vision failure",
        modelErrorContext: {
          category: "image_analysis_failed",
          presetId: "account-agent",
          source: "account",
          provider: "memmy_account",
          model: "agent_chat",
          capability: "agent",
          failedProvider: "memmy_account",
          failedModel: "image2text",
          apiKey: "must-not-leak"
        }
      }
    }));
    expect(sent(ws, 2).model_error).toEqual({
      category: "image_analysis_failed",
      detail: "Error: internal vision failure",
      presetId: "account-agent",
      source: "account",
      provider: "memmy_account",
      model: "agent_chat",
      capability: "agent",
      failedProvider: "memmy_account",
      failedModel: "image2text"
    });
    expect(JSON.stringify(sent(ws, 2))).not.toContain("must-not-leak");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-quota",
      content: "当前模型不支持图片输入，请切换到支持多模态能力的模型后重试",
      metadata: { modelErrorCategory: "image_input_unsupported" }
    }));
    expect(sent(ws, 3).model_error).toEqual({ category: "image_input_unsupported" });
  });

  it("sends context compaction status as a dedicated WebUI event and transcript row", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = { send: vi.fn(async () => undefined) };
    channel.attachConnection(ws, "chat-1");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "压缩已完成",
      metadata: {
        agentProgress: true,
        contextCompaction: true,
        compactionId: "context-compaction:turn-1",
        compactionStatus: "done",
      },
    }));

    expect(sent(ws)).toEqual({
      event: "context_compaction",
      chat_id: "chat-1",
      compaction_id: "context-compaction:turn-1",
      status: "done",
      text: "压缩已完成",
      content: "压缩已完成",
    });
    const transcript = fs.readFileSync(webuiTranscriptPath("websocket:chat-1"), "utf8")
      .trim()
      .split(/\n/u)
      .map((line) => JSON.parse(line));
    expect(transcript).toEqual([sent(ws)]);
  });

  it("sends retry wait as a live-only event without transcript content", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendRunStatus("chat-1", "running", { startedAt: 123, turnId: "turn-1" });
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "Model request failed, retrying attempt 2 in 2s...",
      metadata: { retryWait: true, turn_id: "turn-1" },
    }));

    expect(sent(ws, 1)).toEqual({
      event: "retry_wait",
      chat_id: "chat-1",
      text: "Model request failed, retrying attempt 2 in 2s...",
      turn_id: "turn-1",
    });
    expect(sent(ws, 1)).not.toHaveProperty("content");
    expect(fs.existsSync(webuiTranscriptPath("websocket:chat-1"))).toBe(false);
  });

  it("drops retry wait events for inactive turn ids", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendRunStatus("chat-1", "running", { startedAt: 123, turnId: "turn-active" });
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "Model request failed, retrying attempt 1 in 1s...",
      metadata: { retryWait: true, turn_id: "turn-stopped" },
    }));

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(sent(ws)).toMatchObject({ event: "run_status", turn_id: "turn-active" });
    expect(fs.existsSync(webuiTranscriptPath("websocket:chat-1"))).toBe(false);
  });

  it("classifies outbound structured media attachments for WebUI rendering", async () => {
    const root = tempDataDir();
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const deck = path.join(workspace, "deck.pptx");
    const image = path.join(workspace, "image.png");
    const video = path.join(workspace, "clip.mp4");
    fs.writeFileSync(deck, "pptx", "utf8");
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(video, "mp4", "utf8");
    const channel = new WebSocketChannel({}, new MessageBus(), { workspacePath: workspace });
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "attachments ready",
      media: [deck, image, video],
    }));

    expect(sent(ws).media_urls).toEqual([
      expect.objectContaining({ kind: "file", name: "deck.pptx", path: fs.realpathSync(deck), url: expect.stringMatching(/^\/api\/media\//) }),
      expect.objectContaining({ kind: "image", name: "image.png", path: fs.realpathSync(image), url: expect.stringMatching(/^\/api\/media\//) }),
      expect.objectContaining({ kind: "video", name: "clip.mp4", path: fs.realpathSync(video), url: expect.stringMatching(/^\/api\/media\//) }),
    ]);
  });

  it("dispatches typed envelopes with media into inbound bus messages", async () => {
    const root = tempDataDir();
    const bus = new MessageBus();
    const channel = webuiChannel(bus, root);
    const titleService = {
      trackUserMessage: vi.fn(),
      onUserMessagePersisted: vi.fn(),
    };
    channel.setWebuiTitleService(titleService as any);
    const ws = { send: vi.fn(async () => undefined), remoteAddress: ["127.0.0.1"] };
    const imagePath = writeWebuiImage();
    const textPath = writeWebuiText();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "message",
      chat_id: "chat-1",
      content: "see this",
      webui: true,
      client_request_id: "11111111-1111-4111-8111-111111111111",
      target: { kind: "standalone" },
      language: "zh-CN",
      media_paths: [imagePath, textPath],
      mcp_presets: ["local"],
      image_generation: { enabled: true, aspect_ratio: "16:9" },
    });

    const inbound = await bus.nextInbound();
    expect(inbound.chatId).toBe("chat-1");
    expect(inbound.senderId).toBe("client-1");
    expect(inbound.media).toEqual([imagePath, textPath]);
    expect(inbound.metadata.webui).toBe(true);
    expect(inbound.metadata.webui_language).toBe("zh-CN");
    expect(inbound.metadata.mcp_presets).toEqual(["local"]);
    expect(inbound.metadata.image_generation).toEqual({ enabled: true, aspect_ratio: "16:9" });
    expect(titleService.trackUserMessage).toHaveBeenCalledWith({
      chatId: "chat-1",
      sessionKey: "websocket:chat-1",
      content: "see this",
      metadata: expect.objectContaining({
        webui: true,
        webui_language: "zh-CN",
        mcp_presets: ["local"],
      }),
      mediaPaths: [imagePath, textPath],
    });
    expect(titleService.onUserMessagePersisted).not.toHaveBeenCalled();
  });

  it("acknowledges the first WebUI message after binding its workspace", async () => {
    const root = tempDataDir();
    const workspace = path.join(root, "workspace");
    const sessions = new SessionManager(path.join(root, "sessions"));
    fs.mkdirSync(workspace, { recursive: true });
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus, { sessionManager: sessions, workspacePath: workspace });
    const loop = new AgentLoop({
      workspace,
      sessionManager: sessions,
      bus,
      provider: {
        generation: { maxTokens: 256 },
        getDefaultModel: () => "test-model",
      },
    });
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "message",
      chat_id: "chat-1",
      content: "/help",
      webui: true,
      client_request_id: "11111111-1111-4111-8111-111111111111",
      target: { kind: "standalone" },
    });
    await loop.dispatchMessage(await bus.nextInbound());
    while (bus.outboundSize) {
      await channel.send(await bus.nextOutbound());
    }

    const payloads = ws.send.mock.calls.map(([payload]) => JSON.parse(payload));
    const events = payloads.map((payload) => payload.event);
    expect(events).toContain("message_accepted");
    expect(events).toContain("session_updated");
    expect(payloads.find((payload) => payload.event === "message_accepted")).toMatchObject({
      chat_id: "chat-1",
      client_request_id: "11111111-1111-4111-8111-111111111111",
      model_selection: {
        preset_id: "default",
        endpoint_id: "default",
        model: "anthropic/claude-opus-4-5",
        source: "byok",
        owner_account_id: null,
        capabilities: ["agent"],
      },
    });
  });

  it("writes only a Goal objective into the accepted WebUI transcript", async () => {
    const root = tempDataDir();
    const sessions = new SessionManager(path.join(root, "sessions"));
    const channel = new WebSocketChannel({}, new MessageBus(), {
      sessionManager: sessions,
      workspacePath: root,
    });
    const session = sessions.getOrCreate("websocket:chat-goal");
    session.addMessage("user", "/goal 编写亚洲流行文化网页", {
      commandMessage: true,
      client_request_id: "11111111-1111-4111-8111-111111111111",
    });
    sessions.save(session);
    const ws = connection();
    channel.attachConnection(ws, "chat-goal");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-goal",
      content: "",
      metadata: {
        webuiMessageAccepted: true,
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      },
    }));

    const lines = fs.readFileSync(webuiTranscriptPath("websocket:chat-goal"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toContainEqual(expect.objectContaining({
      event: "user",
      text: "编写亚洲流行文化网页",
    }));
  });

  it("repairs a persisted queue-steer user transcript idempotently on thread GET", () => {
    const root = tempDataDir();
    const sessions = new SessionManager(path.join(root, "sessions"));
    const channel = new WebSocketChannel({}, new MessageBus(), {
      sessionManager: sessions,
      workspacePath: root,
    });
    const chatId = "chat-steer-repair";
    const clientRequestId = "90909090-9090-4090-8090-909090909090";
    const turnId = "mec5x2l7-k3p9w8qd";
    const session = sessions.getOrCreate(`websocket:${chatId}`);
    session.metadata.webui = true;
    session.metadata.webuiProjectId = null;
    session.metadata.webuiWorkspaceCwd = root;
    session.messages.push({
      role: "user",
      content: "initial request",
      client_request_id: "78787878-7878-4878-8878-787878787878",
      turn_id: turnId,
      turn_source: { kind: "gui", channel: "websocket" },
    });
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: "provider-visible content" }],
      client_request_id: clientRequestId,
      turn_id: turnId,
      turn_source: { kind: "gui", channel: "websocket" },
      webui_queue_steer_recovery: {
        client_request_id: clientRequestId,
        content: "original queued adjustment",
        media: [],
        source: { kind: "gui", channel: "websocket" },
        queue_surface: "chat_composer",
        turn_id: turnId,
      },
    });
    session.messages.push({ role: "assistant", content: "final answer" });
    sessions.save(session, { fsync: true });
    const transcript = webuiTranscriptPath(`websocket:${chatId}`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      {
        event: "user",
        chat_id: chatId,
        text: "initial request",
        client_request_id: "78787878-7878-4878-8878-787878787878",
        turn_id: turnId,
        source: { kind: "gui", channel: "websocket" },
      },
      { event: "delta", chat_id: chatId, text: "final answer", turn_id: turnId },
      { event: "stream_end", chat_id: chatId, turn_id: turnId },
      { event: "turn_end", chat_id: chatId, turn_id: turnId },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    channel.apiTokens.set("api-token", Number.POSITIVE_INFINITY);
    const request = {
      path: `/api/sessions/websocket%3A${chatId}/webui-thread`,
      headers: { authorization: "Bearer api-token" },
    };

    const response = channel.handleWebuiThreadGet(request, `websocket%3A${chatId}`);
    expect(response.status).toBe(200);
    expect(JSON.parse(String(response.body)).messages.map((message: Record<string, any>) => (
      message.role === "user" ? message.client_request_id : message.role
    ))).toEqual([
      "78787878-7878-4878-8878-787878787878",
      clientRequestId,
      "assistant",
    ]);
    expect(channel.handleWebuiThreadGet(request, `websocket%3A${chatId}`).status).toBe(200);
    const lines = fs.readFileSync(webuiTranscriptPath(`websocket:${chatId}`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.filter((line) => (
      line.event === "user" && line.client_request_id === clientRequestId
    ))).toEqual([
      expect.objectContaining({
        text: "original queued adjustment",
        client_request_id: clientRequestId,
        turn_id: turnId,
        source: { kind: "gui", channel: "websocket" },
      }),
    ]);
  });

  it("notifies the WebUI title service only after thread-scoped session updates are sent", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const titleService = {
      trackUserMessage: vi.fn(),
      onUserMessagePersisted: vi.fn(),
    };
    channel.setWebuiTitleService(titleService as any);
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "",
      metadata: { sessionUpdated: true, sessionUpdateScope: "thread" },
    }));
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "",
      metadata: { sessionUpdated: true, sessionUpdateScope: "metadata" },
    }));

    expect(sent(ws, 0)).toEqual({ event: "session_updated", chat_id: "chat-1", scope: "thread" });
    expect(sent(ws, 1)).toEqual({ event: "session_updated", chat_id: "chat-1", scope: "metadata" });
    expect(titleService.onUserMessagePersisted).toHaveBeenCalledTimes(1);
    expect(titleService.onUserMessagePersisted).toHaveBeenCalledWith("chat-1");
  });

  it("rejects deprecated media data URL envelopes with chat-scoped errors", async () => {
    tempDataDir();
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus);
    const ws = connection();
    const png = `data:image/png;base64,${tinyPngBytes().toString("base64")}`;

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "message",
      chat_id: "chat-1",
      content: "see this",
      webui: true,
      media: [{ data_url: png, name: "screen.png" }],
    });

    expect(sent(ws)).toMatchObject({
      event: "error",
      chat_id: "chat-1",
      detail: "attachment_rejected",
      reason: "deprecated_payload",
    });
    expect(bus.inbound.getNowait()).toBeUndefined();
  });

  it("rejects malformed media envelopes with chat-scoped errors", async () => {
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "message",
      chat_id: "chat-1",
      content: "see this",
      webui: true,
      media_paths: { path: "/tmp/screen.png" },
    });

    expect(sent(ws)).toMatchObject({
      event: "error",
      chat_id: "chat-1",
      detail: "attachment_rejected",
      reason: "malformed",
    });
    expect(bus.inbound.getNowait()).toBeUndefined();
  });

  it("routes stop as a control envelope and persists only the stop_result terminal row", async () => {
    tempDataDir();
    const bus = new MessageBus();
    const cancelActiveTasks = vi.fn(async () => 1);
    const channel = new WebSocketChannel({}, bus, { cancelActiveTasks });
    const ws = { send: vi.fn(async () => undefined), remoteAddress: ["127.0.0.1"] };

    await channel.dispatchEnvelope(ws, "client-1", { type: "stop", chat_id: "chat-1" });
    expect(cancelActiveTasks).toHaveBeenCalledWith("websocket:chat-1");
    expect(sent(ws)).toEqual({
      event: "stop_result",
      chat_id: "chat-1",
      stopped: 1,
    });
    expect(bus.inbound.getNowait()).toBeUndefined();
    const lines = fs.readFileSync(webuiTranscriptPath("websocket:chat-1"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([{ event: "stop_result", chat_id: "chat-1", stopped: 1 }]);
  });

  it("emits stream and goal control events to subscribers", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = { send: vi.fn<(payload: string) => Promise<void>>(async () => undefined) };
    channel.attachConnection(ws, "chat-1");

    await channel.sendDelta("chat-1", "hel", { streamId: "s1" });
    await channel.sendDelta("chat-1", "lo", { streamId: "s1", streamEnd: true });
    await channel.sendRunStatus("chat-1", "running", { startedAt: 123 });

    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ event: "delta", text: "hel", stream_id: "s1" });
    expect(JSON.parse(ws.send.mock.calls[1][0])).toMatchObject({ event: "stream_end", text: "hello", stream_id: "s1" });
    expect(JSON.parse(ws.send.mock.calls[2][0])).toMatchObject({ event: "run_status", status: "running", started_at: 123 });
  });

  it("strips trailing HTTP slashes except for root", () => {
    expect(stripTrailingSlash("/ws/")).toBe("/ws");
    expect(stripTrailingSlash("/")).toBe("/");
    expect(stripTrailingSlash("")).toBe("/");
  });

  it("parses request paths and query strings", () => {
    const [path, query] = parseRequestPath("/ws/?token=abc&client_id=browser&client_id=second");

    expect(path).toBe("/ws");
    expect(query.token).toEqual(["abc"]);
    expect(query.client_id).toEqual(["browser", "second"]);
  });

  it("normalizes configured websocket paths like request paths", () => {
    expect(normalizeConfigPath("/ws/")).toBe(normalizeHttpPath("/ws/?token=abc"));
  });

  it("extracts token and client id query values", () => {
    const query = parseQuery("/ws?token=abc&client_id=browser");

    expect(query.token).toEqual(["abc"]);
    expect(query.client_id).toEqual(["browser"]);
  });

  it("parses inbound content, text, and message JSON fields", () => {
    expect(parseInboundPayload(JSON.stringify({ content: "from content" }))).toBe("from content");
    expect(parseInboundPayload(JSON.stringify({ text: "from text" }))).toBe("from text");
    expect(parseInboundPayload(JSON.stringify({ message: "from message" }))).toBe("from message");
  });

  it("returns null for inbound payload edge cases", () => {
    expect(parseInboundPayload("")).toBeNull();
    expect(parseInboundPayload('["hello"]')).toBe('["hello"]');
    expect(parseInboundPayload(JSON.stringify({ text: "" }))).toBeNull();
    expect(parseInboundPayload(JSON.stringify({ other: "x" }))).toBeNull();
  });

  it("requires websocket config paths to start with slash", () => {
    expect(() => new WebSocketConfig({ path: "ws" })).toThrow(/path must start/);
  });

  it("requires SSL cert and key files together", () => {
    const channel = new WebSocketChannel({ sslCertfile: "/tmp/cert.pem" });

    expect(() => channel.buildSslContext()).toThrow(/sslCertfile/);
  });

  it("starts the built-in server with HTTPS when SSL files are configured", async () => {
    const fakeServer: any = {
      on: vi.fn(() => fakeServer),
      listen: vi.fn((port: number, host: string, callback: () => void) => {
        callback();
        return fakeServer;
      }),
      close: vi.fn((callback: () => void) => {
        callback();
        return fakeServer;
      }),
    };
    const createServer = vi.spyOn(https, "createServer").mockReturnValue(fakeServer);
    const tls = { cert: Buffer.from("cert"), key: Buffer.from("key") };
    const channel = new WebSocketChannel({ sslCertfile: "/tmp/cert.pem", sslKeyfile: "/tmp/key.pem" }, new MessageBus());
    vi.spyOn(channel, "buildSslContext").mockReturnValue(tls);

    try {
      await channel.start();

      expect(createServer).toHaveBeenCalledWith(tls, expect.any(Function));
      expect(fakeServer.listen).toHaveBeenCalledWith(channel.config.port, channel.config.host, expect.any(Function));
    } finally {
      await channel.stop();
      createServer.mockRestore();
    }
  });

  it("default config includes safe bind and streaming", () => {
    const config = WebSocketChannel.defaultConfig();

    expect(config.enabled).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.streaming).toBe(true);
    expect(config.websocketRequiresToken).toBe(true);
  });

  it("requires token issue path to differ from websocket path", () => {
    expect(() => new WebSocketConfig({ path: "/ws", tokenIssuePath: "/ws" })).toThrow(/tokenIssuePath/);
  });

  it("matches token issue route secrets from bearer auth", () => {
    expect(issueRouteSecretMatches({ authorization: "Bearer secret" }, "secret")).toBe(true);
    expect(issueRouteSecretMatches({ authorization: "Bearer wrong" }, "secret")).toBe(false);
  });

  it("matches token issue route secrets from legacy headers", () => {
    expect(issueRouteSecretMatches({ "x-memmy-agent-auth": "secret" }, "secret")).toBe(true);
  });

  it("allows token issue routes when no secret is configured", () => {
    expect(issueRouteSecretMatches({}, "")).toBe(true);
  });

  it("marks webui inbound metadata only for webui envelopes", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "message",
      chat_id: "chat-1",
      content: "hello",
      webui: true,
      client_request_id: "22222222-2222-4222-8222-222222222222",
      target: { kind: "standalone" },
    });

    const inbound = await bus.nextInbound();
    expect(inbound.metadata.webui).toBe(true);
  });

  it("does not mark plain websocket messages as webui", async () => {
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "message", chat_id: "chat-1", content: "hello" });

    const inbound = await bus.nextInbound();
    expect(inbound.metadata.webui).toBeUndefined();
  });

  it("ignores unsupported webui language metadata", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "message",
      chat_id: "chat-1",
      content: "hello",
      webui: true,
      client_request_id: "33333333-3333-4333-8333-333333333333",
      target: { kind: "standalone" },
      language: "fr-FR",
    });

    const inbound = await bus.nextInbound();
    expect(inbound.metadata.webui).toBe(true);
    expect(inbound.metadata.webui_language).toBeUndefined();
  });

  it("dispatches status envelopes as ephemeral status commands without webui transcript metadata", async () => {
    tempDataDir();
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "status", chat_id: "chat-1" });

    const inbound = await bus.nextInbound();
    expect(inbound.chatId).toBe("chat-1");
    expect(inbound.senderId).toBe("client-1");
    expect(inbound.content).toBe("/status");
    expect(inbound.metadata.webui).toBeUndefined();
    expect(inbound.metadata.webui_ephemeral_command).toBe("status");
    expect(fs.existsSync(webuiTranscriptPath("chat-1"))).toBe(false);
  });

  it("broadcasts ephemeral status results without appending webui transcript output", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "Runtime: ok",
      metadata: { webui_ephemeral_command: "status" },
    }));

    expect(sent(ws)).toEqual({
      event: "status_result",
      chat_id: "chat-1",
      text: "Runtime: ok",
      content: "Runtime: ok",
      metadata: { webui_ephemeral_command: "status" },
    });
    expect(fs.existsSync(webuiTranscriptPath("chat-1"))).toBe(false);
  });

  it("dispatches history DAG envelopes as ephemeral commands without webui transcript metadata", async () => {
    tempDataDir();
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "history_dag", chat_id: "chat-1" });

    const inbound = await bus.nextInbound();
    expect(inbound.chatId).toBe("chat-1");
    expect(inbound.senderId).toBe("client-1");
    expect(inbound.content).toBe("/history-dag");
    expect(inbound.metadata.webui).toBeUndefined();
    expect(inbound.metadata.webui_ephemeral_command).toBe("historyDag");
    expect(fs.existsSync(webuiTranscriptPath("chat-1"))).toBe(false);
  });

  it("broadcasts ephemeral history DAG results without appending webui transcript output", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    const historyDagPayload = {
      version: 1,
      sessionKey: "websocket:chat-1",
      nodes: [],
      edges: [],
      activePathNodeIds: [],
      snapshotText: "",
    };

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "当前 DAG",
      metadata: {
        webui_ephemeral_command: "historyDag",
        agentUi: { historyDag: historyDagPayload },
      },
    }));

    expect(sent(ws)).toEqual({
      event: "history_dag_result",
      chat_id: "chat-1",
      text: "当前 DAG",
      content: "当前 DAG",
      metadata: {
        webui_ephemeral_command: "historyDag",
        agentUi: { historyDag: historyDagPayload },
      },
      agent_ui: { historyDag: historyDagPayload },
    });
    expect(fs.existsSync(webuiTranscriptPath("chat-1"))).toBe(false);
  });

  it("sends reply metadata in outbound websocket frames", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    const msg = new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "hello", replyTo: "user-1" });

    await channel.send(msg);

    expect(sent(ws).reply_to).toBe("user-1");
  });

  it("ignores legacy unscoped runtime model updates", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(
      new OutboundMessage({
        channel: "websocket",
        chatId: "*",
        metadata: { runtimeModelUpdated: true, model: "openai/gpt-4.1", model_preset: "fast" },
      }),
    );

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("scopes complete runtime model updates to the matching chat and request", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const matching = connection();
    const other = connection();
    channel.attachConnection(matching, "chat-1");
    channel.attachConnection(other, "chat-2");

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      metadata: {
        runtimeModelUpdated: true,
        clientRequestId: "77777777-7777-4777-8777-777777777777",
        modelSelection: {
          preset_id: "fast",
          provider: "openai",
          endpoint_id: "chat",
          protocol: "openai-chat-completions",
          model: "gpt-4.1",
          source: "byok",
          owner_account_id: null,
          capabilities: ["agent"],
        },
      },
    }));

    expect(sent(matching)).toEqual({
      event: "runtime_model_updated",
      chat_id: "chat-1",
      client_request_id: "77777777-7777-4777-8777-777777777777",
      model_name: "gpt-4.1",
      model_preset: "fast",
      model_selection: {
        preset_id: "fast",
        provider: "openai",
        endpoint_id: "chat",
        protocol: "openai-chat-completions",
        model: "gpt-4.1",
        source: "byok",
        owner_account_id: null,
        capabilities: ["agent"],
      },
    });
    expect(other.send).not.toHaveBeenCalled();
  });

  it("sending to a missing connection is a no-op", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());

    await expect(channel.send(new OutboundMessage({ channel: "websocket", chatId: "missing", content: "hello" }))).resolves.toBeUndefined();
  });

  it("sends progress tool events as structured fields", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(
      new OutboundMessage({
        channel: "websocket",
        chatId: "chat-1",
        content: "working",
        metadata: { agentProgress: true, toolEvents: [{ name: "read", status: "ok" }] },
      }),
    );

    expect(sent(ws)).toMatchObject({ kind: "progress", tool_events: [{ name: "read", status: "ok" }] });
  });

  it("preserves decoded Windows errors in WebSocket payloads and transcripts", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-windows-error");
    const toolEvent = {
      version: 1,
      phase: "error",
      call_id: "call-windows",
      name: "exec",
      error: WINDOWS_COMMAND_ERROR,
    };

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-windows-error",
      content: WINDOWS_COMMAND_ERROR,
      metadata: { agentProgress: true, toolEvents: [toolEvent] },
    }));

    const payload = sent(ws);
    expect(payload.tool_events[0].error).toBe(WINDOWS_COMMAND_ERROR);
    const transcript = fs.readFileSync(webuiTranscriptPath("websocket:chat-windows-error"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    expect(transcript).toHaveLength(1);
    expect(transcript[0].tool_events[0].error).toBe(WINDOWS_COMMAND_ERROR);
  });

  it("sends file edit progress as file_edit events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(
      new OutboundMessage({
        channel: "websocket",
        chatId: "chat-1",
        metadata: { fileEditEvents: [{ path: "a.ts", action: "write" }] },
      }),
    );

    expect(sent(ws)).toEqual({ event: "file_edit", chat_id: "chat-1", edits: [{ path: "a.ts", action: "write" }] });
  });

  it("drops live payloads for inactive turn ids but keeps cancellation terminal file edits", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendRunStatus("chat-1", "running", { startedAt: 123, turnId: "turn-active" });
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "late progress",
      metadata: { agentProgress: true, turn_id: "turn-stopped" },
    }));
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      metadata: {
        turn_id: "turn-stopped",
        fileEditEvents: [{ call_id: "call-write", tool: "write_file", path: "late.txt", phase: "start", status: "editing" }],
      },
    }));
    await channel.sendDelta("chat-1", "late answer", { turn_id: "turn-stopped" });

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(sent(ws)).toMatchObject({ event: "run_status", status: "running", turn_id: "turn-active" });

    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      metadata: {
        turn_id: "turn-stopped",
        fileEditEvents: [{
          call_id: "call-write",
          tool: "write_file",
          path: "late.txt",
          phase: "error",
          status: "error",
          cancellation_terminal: true,
        }],
      },
    }));

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(sent(ws, 1)).toMatchObject({
      event: "file_edit",
      chat_id: "chat-1",
      turn_id: "turn-stopped",
      cancellation_terminal: true,
      edits: [{
        call_id: "call-write",
        path: "late.txt",
        phase: "error",
        status: "error",
        cancellation_terminal: true,
      }],
    });

    const lines = fs.readFileSync(webuiTranscriptPath("websocket:chat-1"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([sent(ws, 1)]);
  });

  it("sends agent UI blobs on progress messages", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(
      new OutboundMessage({
        channel: "websocket",
        chatId: "chat-1",
        content: "working",
        metadata: { agentUi: { kind: "card" } },
      }),
    );

    expect(sent(ws).agent_ui).toEqual({ kind: "card" });
  });

  it("drops websocket delta sends when the subscriber has disconnected", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = { send: vi.fn(async () => { throw new Error("closed"); }), remoteAddress: ["127.0.0.1"] };
    channel.attachConnection(ws, "chat-1");

    await expect(channel.sendDelta("chat-1", "hello")).resolves.toBeUndefined();

    expect(channel.subscriptions.has("chat-1")).toBe(false);
  });

  it("emits delta and stream_end frames", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendDelta("chat-1", "hel", { streamId: "s1" });
    await channel.sendDelta("chat-1", "lo", { streamId: "s1", streamEnd: true });

    expect(sent(ws, 0)).toMatchObject({ event: "delta", text: "hel", stream_id: "s1" });
    expect(sent(ws, 1)).toMatchObject({ event: "stream_end", text: "hello", stream_id: "s1" });
    expect(sent(ws, 1)).not.toHaveProperty("resuming");
  });

  it("emits resuming stream_end frames only when requested", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendDelta("chat-1", "tool preface", { streamId: "s1" });
    await channel.sendDelta("chat-1", "", { streamId: "s1", streamEnd: true, resuming: true });
    await channel.sendDelta("chat-1", "final", { streamId: "s2" });
    await channel.sendDelta("chat-1", "", { streamId: "s2", streamEnd: true, resuming: false });

    expect(sent(ws, 1)).toMatchObject({ event: "stream_end", text: "tool preface", stream_id: "s1", resuming: true });
    expect(sent(ws, 3)).toMatchObject({ event: "stream_end", text: "final", stream_id: "s2" });
    expect(sent(ws, 3)).not.toHaveProperty("resuming");
  });

  it("emits reasoning delta frames", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendReasoningDelta("chat-1", "thinking", { streamId: "r1" });

    expect(sent(ws)).toMatchObject({ event: "reasoning_delta", text: "thinking", stream_id: "r1" });
  });

  it("persists reasoning and turn_end frames into WebUI transcripts", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendReasoningDelta("chat-1", "thinking", { streamId: "r1" });
    await channel.sendReasoningEnd("chat-1", { streamId: "r1" });
    await channel.sendTurnEnd("chat-1", {
      latencyMs: 42,
      goalId: "goal-1",
      goalOutcome: "active",
    });

    const lines = fs.readFileSync(webuiTranscriptPath("websocket:chat-1"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { event: "reasoning_delta", chat_id: "chat-1", text: "thinking", stream_id: "r1" },
      { event: "reasoning_end", chat_id: "chat-1", stream_id: "r1" },
      {
        event: "turn_end",
        chat_id: "chat-1",
        latency_ms: 42,
        goal_id: "goal-1",
        goal_outcome: "active",
      },
    ]);
  });

  it("emits reasoning end frames", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendReasoningEnd("chat-1", { streamId: "r1" });

    expect(sent(ws)).toMatchObject({ event: "reasoning_end", stream_id: "r1" });
  });

  it("expands one-shot reasoning sends to delta plus end", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendReasoning(new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "thought" }));

    expect(sent(ws, 0)).toMatchObject({ event: "reasoning_delta", text: "thought" });
    expect(sent(ws, 1)).toMatchObject({ event: "reasoning_end" });
  });

  it("drops empty reasoning delta chunks", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendReasoningDelta("chat-1", "");

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("reasoning without subscribers is a no-op", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());

    await expect(channel.sendReasoningDelta("chat-1", "thought")).resolves.toBeUndefined();
  });

  it("emits turn_end events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendTurnEnd("chat-1");

    expect(sent(ws)).toMatchObject({ event: "turn_end", chat_id: "chat-1" });
  });

  it("includes latency in turn_end events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendTurnEnd("chat-1", { latencyMs: 42 });

    expect(sent(ws).latency_ms).toBe(42);
  });

  it("includes paired Goal identity and outcome in turn_end events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendTurnEnd("chat-1", {
      goalId: "goal-1",
      goalOutcome: "active",
    });

    expect(sent(ws)).toMatchObject({ goal_id: "goal-1", goal_outcome: "active" });
    expect(sent(ws)).not.toHaveProperty("goal_state");
  });

  it("emits running goal status with started_at", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendRunStatus("chat-1", "running", { startedAt: 123 });

    expect(sent(ws)).toMatchObject({ event: "run_status", status: "running", started_at: 123 });
  });

  it("omits started_at for idle goal status", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendRunStatus("chat-1", "idle", { startedAt: 123 });

    expect(sent(ws)).toMatchObject({ event: "run_status", status: "idle" });
    expect(sent(ws).started_at).toBeUndefined();
  });

  it("sends an idle run snapshot immediately after an explicit attach", async () => {
    const channel = new WebSocketChannel({}, new MessageBus(), {
      modelSelectionResolver: () => null,
    });
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1", model_preset: null, model_provider: null, model: null, model_selection: null },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "idle" },
    ]);
  });

  it("sends one authoritative running snapshot after attach", async () => {
    const channel = new WebSocketChannel({}, new MessageBus(), {
      modelSelectionResolver: () => null,
    });
    const ws = connection();
    websocketTurnWallStartTimes.set("chat-1", 1780732800);
    channel.activeTurnIdByChatId.set("chat-1", "turn-1");

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1", model_preset: null, model_provider: null, model: null, model_selection: null },
      {
        event: "run_status_snapshot",
        chat_id: "chat-1",
        status: "running",
        started_at: 1780732800,
        turn_id: "turn-1",
      },
    ]);
  });

  it("correlates an idle snapshot with a still-known active turn", async () => {
    const channel = new WebSocketChannel({}, new MessageBus(), {
      modelSelectionResolver: () => null,
    });
    const ws = connection();
    channel.activeTurnIdByChatId.set("chat-1", "turn-finishing");

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1", model_preset: null, model_provider: null, model: null, model_selection: null },
      {
        event: "run_status_snapshot",
        chat_id: "chat-1",
        status: "idle",
        turn_id: "turn-finishing",
      },
    ]);
  });

  it("keeps run snapshots live-only, single-connection, and read-only", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());
    const attaching = connection();
    const existing = connection();
    channel.attachConnection(existing, "chat-1");
    websocketTurnWallStartTimes.set("chat-1", 1780732800);
    channel.activeTurnIdByChatId.set("chat-1", "turn-1");

    await channel.sendRunStatusSnapshot(attaching, "chat-1");

    expect(sent(attaching)).toEqual({
      event: "run_status_snapshot",
      chat_id: "chat-1",
      status: "running",
      started_at: 1780732800,
      turn_id: "turn-1",
    });
    expect(existing.send).not.toHaveBeenCalled();
    expect(websocketTurnWallStartTimes.get("chat-1")).toBe(1780732800);
    expect(channel.activeTurnIdByChatId.get("chat-1")).toBe("turn-1");
    expect(fs.existsSync(webuiTranscriptPath("websocket:chat-1"))).toBe(false);
  });

  it("keeps run snapshots scoped to explicit attach envelopes", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    const snapshot = vi.spyOn(channel, "sendRunStatusSnapshot");

    await channel.dispatchEnvelope(ws, "client-1", { type: "new_chat" });
    await channel.dispatchEnvelope(ws, "client-1", { type: "message", chat_id: "chat-1", content: "hello" });
    await channel.dispatchEnvelope(ws, "client-1", { type: "status", chat_id: "chat-1" });
    await channel.dispatchEnvelope(ws, "client-1", { type: "history_dag", chat_id: "chat-1" });

    expect(snapshot).not.toHaveBeenCalled();
  });

  it("sends the run snapshot before active goal hydration", async () => {
    const channel = new WebSocketChannel({}, new MessageBus(), {
      modelSelectionResolver: () => null,
    });
    const ws = connection();
    const goalState = {
      goalId: "8f59f58a-7295-4c34-8e03-55e7035a5a8d",
      status: "active",
      objective: "Ship the fix",
      tokenBudget: 12_000,
      tokensUsed: 500,
      timeUsedSeconds: 30,
      createdAt: "2026-08-04T08:00:00.000Z",
      updatedAt: "2026-08-04T08:00:30.000Z",
    };
    channel.sessionManager = {
      readSessionFile: vi.fn(() => ({
        metadata: { goalState },
      })),
    };

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1", model_preset: null, model_provider: null, model: null, model_selection: null },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "idle" },
      {
        event: "goal_state",
        chat_id: "chat-1",
        goal_state: {
          goal_id: goalState.goalId,
          status: goalState.status,
          objective: goalState.objective,
          token_budget: goalState.tokenBudget,
          tokens_used: goalState.tokensUsed,
          time_used_seconds: goalState.timeUsedSeconds,
          created_at: goalState.createdAt,
          updated_at: goalState.updatedAt,
        },
      },
    ]);
  });

  it("continues subscription hydration when an earlier subscriber has disconnected", async () => {
    const channel = new WebSocketChannel({}, new MessageBus(), {
      modelSelectionResolver: () => null,
    });
    const stale = { send: vi.fn(async () => { throw new Error("closed"); }) };
    const attaching = connection();
    const goalState = {
      goalId: "8f59f58a-7295-4c34-8e03-55e7035a5a8d",
      status: "active",
      objective: "Ship the fix",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2026-08-04T08:00:00.000Z",
      updatedAt: "2026-08-04T08:00:00.000Z",
    };
    channel.attachConnection(stale, "chat-1");
    channel.sessionManager = {
      readSessionFile: vi.fn(() => ({
        metadata: { goalState },
      })),
    };

    await expect(channel.dispatchEnvelope(attaching, "client-1", {
      type: "attach",
      chat_id: "chat-1",
    })).resolves.toBeUndefined();

    expect(attaching.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1", model_preset: null, model_provider: null, model: null, model_selection: null },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "idle" },
      {
        event: "goal_state",
        chat_id: "chat-1",
        goal_state: {
          goal_id: goalState.goalId,
          status: goalState.status,
          objective: goalState.objective,
          token_budget: goalState.tokenBudget,
          tokens_used: goalState.tokensUsed,
          time_used_seconds: goalState.timeUsedSeconds,
          created_at: goalState.createdAt,
          updated_at: goalState.updatedAt,
        },
      },
    ]);
    expect(channel.subscriptions.get("chat-1")?.has(stale)).toBe(false);
  });

  it("emits goal state blobs per chat", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendGoalState("chat-1", { active: true, objective: "ship" });

    expect(sent(ws)).toMatchObject({ event: "goal_state", goal_state: { active: true, objective: "ship" } });
  });

  it("publishes committed Goal state before the matching control result", async () => {
    const root = tempDataDir();
    const bus = new MessageBus();
    const sessions = new SessionManager(path.join(root, "sessions"));
    sessions.getOrCreate("websocket:chat-1");
    const runtime = new GoalRuntime({ sessions, bus });
    const channel = new WebSocketChannel({}, bus, {
      sessionManager: sessions,
      goalControlHandler: (request) => runtime.control(request),
    });
    const ws = connection();
    const goal = await runtime.create({
      sessionKey: "websocket:chat-1",
      objective: "Ship Goal mode",
      tokenBudget: null,
      route: { channel: "websocket", chatId: "chat-1" },
      turnId: "turn-create",
    });
    await runtime.flushEffects("websocket:chat-1");
    await bus.nextOutbound();
    channel.attachConnection(ws, "chat-1");

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "goal_control",
      chat_id: "chat-1",
      request_id: "11111111-1111-4111-8111-111111111111",
      goal_id: goal.goalId,
      action: "pause",
    });
    await channel.send(await bus.nextOutbound());
    await channel.send(await bus.nextOutbound());

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      expect.objectContaining({
        event: "goal_state",
        chat_id: "chat-1",
        goal_state: expect.objectContaining({ goal_id: goal.goalId, status: "paused" }),
      }),
      {
        event: "goal_control_result",
        chat_id: "chat-1",
        request_id: "11111111-1111-4111-8111-111111111111",
        ok: true,
      },
    ]);
    expect(sent(ws, 1)).not.toHaveProperty("goal_state");
  });

  it("coalesces equal in-flight Goal controls and rejects a conflicting request summary", async () => {
    const gate = deferred<void>();
    const bus = new MessageBus();
    const handler = vi.fn(async () => {
      await gate.promise;
      return { ok: true };
    });
    const channel = new WebSocketChannel({}, bus, { goalControlHandler: handler });
    const first = connection();
    const duplicate = connection();
    const conflicting = connection();
    const request = {
      type: "goal_control",
      chat_id: "chat-1",
      request_id: "22222222-2222-4222-8222-222222222222",
      goal_id: "8f59f58a-7295-4c34-8e03-55e7035a5a8d",
      action: "pause",
    };

    const firstDispatch = channel.dispatchEnvelope(first, "client-1", request);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await channel.dispatchEnvelope(duplicate, "client-2", request);
    await channel.dispatchEnvelope(conflicting, "client-3", { ...request, action: "resume" });

    expect(sent(conflicting)).toEqual({
      event: "goal_control_result",
      chat_id: "chat-1",
      request_id: request.request_id,
      ok: false,
      error: "request_id_conflict",
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(first.send).not.toHaveBeenCalled();
    expect(duplicate.send).not.toHaveBeenCalled();

    gate.resolve();
    await firstDispatch;
    await channel.send(await bus.nextOutbound());

    expect(sent(first)).toMatchObject({ event: "goal_control_result", ok: true });
    expect(sent(duplicate)).toMatchObject({ event: "goal_control_result", ok: true });
  });

  it.each([
    [{ action: "edit", objective: "" }, "invalid_objective"],
    [{ action: "set_budget", token_budget: 0 }, "invalid_token_budget"],
    [{ action: "pause", goal_id: "not-a-uuid" }, "invalid_transition"]
  ] as const)("rejects invalid Goal control fields with %s", async (overrides, expectedError) => {
    const handler = vi.fn(async () => ({ ok: true }));
    const channel = new WebSocketChannel({}, new MessageBus(), { goalControlHandler: handler });
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "goal_control",
      chat_id: "chat-1",
      request_id: "33333333-3333-4333-8333-333333333333",
      goal_id: "8f59f58a-7295-4c34-8e03-55e7035a5a8d",
      ...overrides,
    });

    expect(sent(ws)).toMatchObject({
      event: "goal_control_result",
      ok: false,
      error: expectedError,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("active goal push is a no-op without a session manager", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());

    await expect(channel.maybePushActiveGoalState("chat-1")).resolves.toBeUndefined();
  });

  it("emits session_updated events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendSessionUpdated("chat-1");

    expect(sent(ws)).toMatchObject({ event: "session_updated", chat_id: "chat-1" });
  });

  it("includes scope in session_updated events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendSessionUpdated("chat-1", "messages");

    expect(sent(ws)).toMatchObject({ event: "session_updated", scope: "messages" });
  });

  it("missing websocket delta connections are a no-op", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());

    await expect(channel.sendDelta("missing", "hello")).resolves.toBeUndefined();
  });

  it("persists stream deltas into WebUI transcript without subscribers", async () => {
    tempDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());

    await channel.sendDelta("chat-1", "hel", { streamId: "s1" });
    await channel.sendDelta("chat-1", "lo", { streamId: "s1", streamEnd: true, resuming: true });

    const lines = fs.readFileSync(webuiTranscriptPath("websocket:chat-1"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { event: "delta", chat_id: "chat-1", text: "hel", stream_id: "s1" },
      { event: "stream_end", chat_id: "chat-1", resuming: true, text: "hello", stream_id: "s1" },
    ]);
  });

  it("stop is idempotent", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());

    await channel.stop();
    await channel.stop();

    expect(channel.running).toBe(false);
  });

  it("parses typed websocket envelopes", () => {
    expect(parseEnvelope(JSON.stringify({ type: "message", chat_id: "chat-1" }))).toEqual({
      type: "message",
      chat_id: "chat-1",
    });
  });

  it("rejects legacy and garbage websocket envelopes", () => {
    expect(parseEnvelope("hello")).toBeNull();
    expect(parseEnvelope("{bad")).toBeNull();
    expect(parseEnvelope(JSON.stringify({ chat_id: "chat-1" }))).toBeNull();
  });

  it("validates websocket chat ids", () => {
    expect(isValidChatId("chat_1:thread-2")).toBe(true);
    expect(isValidChatId("bad space")).toBe(false);
    expect(isValidChatId("x".repeat(65))).toBe(false);
  });
});

describe("WebSocketChannel memmy parity cases", () => {
  it("normalizes HTTP paths by stripping trailing slashes except root", () => {
    expect(normalizeHttpPath("/chat/")).toBe("/chat");
    expect(normalizeHttpPath("/chat?x=1")).toBe("/chat");
    expect(normalizeHttpPath("/")).toBe("/");
  });

  it("parses request paths consistently with normalized path and query helpers", () => {
    const [path, query] = parseRequestPath("/ws/?token=secret&client_id=u1");
    expect(path).toBe(normalizeHttpPath("/ws/?token=secret&client_id=u1"));
    expect(query).toEqual(parseQuery("/ws/?token=secret&client_id=u1"));
  });

  it("falls back to raw string payloads for invalid inbound JSON", () => {
    expect(parseInboundPayload("{not json")).toBe("{not json");
  });

  it("handles inbound payload edge cases", () => {
    expect(parseInboundPayload(JSON.stringify({ content: "" }))).toBeNull();
    expect(parseInboundPayload(JSON.stringify({ content: 123 }))).toBeNull();
    expect(parseInboundPayload(JSON.stringify({ content: "  " }))).toBeNull();
    expect(parseInboundPayload('["hello"]')).toBe('["hello"]');
    expect(parseInboundPayload(JSON.stringify({ unknown_key: "val" }))).toBeNull();
    expect(parseInboundPayload(JSON.stringify({ content: null }))).toBeNull();
  });

  it("requires WebSocket config paths to start with slash", () => {
    expect(() => new WebSocketConfig({ path: "bad" })).toThrow(/path must start with "\/"/);
  });

  it("requires both SSL cert and key files", () => {
    const channel = new WebSocketChannel({ sslCertfile: "/tmp/c.pem", sslKeyfile: "" }, new MessageBus());
    expect(() => channel.buildSslContext()).toThrow(/sslCertfile and sslKeyfile/);
  });

  it("requires token issue path to differ from the WebSocket path", () => {
    expect(() => new WebSocketConfig({ path: "/ws", tokenIssuePath: "/ws" })).toThrow(/tokenIssuePath must differ/);
  });

  it("matches token issue route secrets when no secret is configured", () => {
    expect(issueRouteSecretMatches({}, "")).toBe(true);
    expect(issueRouteSecretMatches({ authorization: "Bearer anything" }, "")).toBe(true);
  });

  it("marks inbound metadata for WebUI message envelopes", async () => {
    const bus = new MessageBus();
    const channel = webuiChannel(bus);
    await channel.dispatchEnvelope(connection(), "webui-client", {
      type: "message",
      chat_id: "chat-1",
      content: "hello",
      webui: true,
      client_request_id: "44444444-4444-4444-8444-444444444444",
      target: { kind: "standalone" },
    });
    const msg = await bus.nextInbound();
    expect(msg.channel).toBe("websocket");
    expect(msg.chatId).toBe("chat-1");
    expect(msg.metadata.webui).toBe(true);
    expect(msg.metadata.wantsStream).toBe(true);
  });

  it("does not mark plain WebSocket messages as WebUI", async () => {
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus);
    await channel.dispatchEnvelope(connection(), "custom-client", { type: "message", chat_id: "chat-1", content: "hello" });
    const msg = await bus.nextInbound();
    expect(msg.metadata.webui).toBeUndefined();
  });

  it("sends JSON messages with media and reply metadata", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    const msg = new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "hello", media: ["/tmp/a.png"], replyTo: "m1" });

    await channel.send(msg);

    expect(sent(ws)).toMatchObject({
      event: "message",
      chat_id: "chat-1",
      text: "hello",
      reply_to: "m1",
      media: ["/tmp/a.png"],
    });
  });

  it("ignores duplicate legacy unscoped runtime model updates", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(new OutboundMessage({ channel: "websocket", chatId: "*", metadata: { runtimeModelUpdated: true, model: "openai/gpt-4.1", model_preset: "fast" } }));

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("ignores sends without matching connections", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    await expect(channel.send(new OutboundMessage({ channel: "websocket", chatId: "missing", content: "hello" }))).resolves.toBeUndefined();
  });

  it("drops outbound messages when send detects a closed socket", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = { send: vi.fn(async () => { throw new Error("closed"); }), remoteAddress: ["127.0.0.1"] };
    channel.attachConnection(ws, "chat-1");

    await expect(channel.send(new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "hello" }))).resolves.toBeUndefined();
    expect(channel.subscriptions.has("chat-1")).toBe(false);
  });

  it("includes structured tool events in progress messages", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.send(new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "working", metadata: { agentProgress: true, toolEvents: [{ name: "read", status: "ok" }] } }));
    expect(sent(ws)).toMatchObject({ kind: "progress", tool_events: [{ name: "read", status: "ok" }] });
  });

  it("uses file edit events for file edit progress", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.send(new OutboundMessage({ channel: "websocket", chatId: "chat-1", metadata: { fileEditEvents: [{ path: "a.ts", action: "write" }] } }));
    expect(sent(ws)).toEqual({ event: "file_edit", chat_id: "chat-1", edits: [{ path: "a.ts", action: "write" }] });
  });

  it("includes agent UI payloads in progress messages", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.send(new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "working", metadata: { agentUi: { kind: "card" } } }));
    expect(sent(ws).agent_ui).toEqual({ kind: "card" });
  });

  it("sendDelta ignores a connection that closed during delivery", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = { send: vi.fn(async () => { throw new Error("closed"); }), remoteAddress: ["127.0.0.1"] };
    channel.attachConnection(ws, "chat-1");

    await expect(channel.sendDelta("chat-1", "hello")).resolves.toBeUndefined();
    expect(channel.subscriptions.has("chat-1")).toBe(false);
  });

  it("isolates serialization and send failures to the affected connection", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const broken = {
      send: vi.fn(async () => undefined),
      close: vi.fn(),
      remoteAddress: ["127.0.0.2"]
    };
    const healthy = {
      send: vi.fn(async () => undefined),
      close: vi.fn(),
      remoteAddress: ["127.0.0.3"]
    };
    channel.attachConnection(broken, "chat-1");
    channel.attachConnection(healthy, "chat-1");
    const cyclic: Record<string, unknown> = { event: "message" };
    cyclic.self = cyclic;

    await expect(channel.safeSendTo(broken, cyclic)).resolves.toBeUndefined();

    expect(broken.close).toHaveBeenCalledWith(1011, "connection send failed");
    expect(channel.subscriptions.get("chat-1")).toEqual(new Set([healthy]));

    await channel.send(new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "still alive" }));
    expect(healthy.send).toHaveBeenCalledTimes(1);
    expect(sent(healthy)).toMatchObject({ event: "message", content: "still alive" });
  });

  it("closes only the failed connection when a connection loop rejects", () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const failed = {
      send: vi.fn(async () => undefined),
      close: vi.fn(),
      remoteAddress: ["127.0.0.4"]
    };
    const healthy = connection();
    channel.attachConnection(failed, "chat-1");
    channel.attachConnection(healthy, "chat-1");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    channel.handleConnectionLoopFailure(failed, new TypeError("dispatch failed"));

    expect(failed.close).toHaveBeenCalledWith(1011, "connection loop failed");
    expect(channel.subscriptions.get("chat-1")).toEqual(new Set([healthy]));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("TypeError"));
    expect(warning.mock.calls[0]?.[0]).not.toContain("dispatch failed");
  });

  it("sendDelta emits delta and stream end", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendDelta("chat-1", "hel", { streamId: "s1" });
    await channel.sendDelta("chat-1", "lo", { streamId: "s1", streamEnd: true });
    expect(sent(ws, 0)).toMatchObject({ event: "delta", text: "hel", stream_id: "s1" });
    expect(sent(ws, 1)).toMatchObject({ event: "stream_end", text: "hello", stream_id: "s1" });
  });

  it("sendReasoningDelta emits streaming frame", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendReasoningDelta("chat-1", "thinking", { streamId: "r1" });
    expect(sent(ws)).toMatchObject({ event: "reasoning_delta", text: "thinking", stream_id: "r1" });
  });

  it("sendReasoningEnd emits close frame", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendReasoningEnd("chat-1", { streamId: "r1" });
    expect(sent(ws)).toMatchObject({ event: "reasoning_end", stream_id: "r1" });
  });

  it("expands one-shot reasoning into delta and end events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendReasoning(new OutboundMessage({ channel: "websocket", chatId: "chat-1", content: "thought" }));
    expect(sent(ws, 0)).toMatchObject({ event: "reasoning_delta", text: "thought" });
    expect(sent(ws, 1)).toMatchObject({ event: "reasoning_end" });
  });

  it("sendReasoningDelta drops empty chunks", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendReasoningDelta("chat-1", "");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("ignores reasoning sends without subscribers", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    await expect(channel.sendReasoningDelta("chat-1", "thought")).resolves.toBeUndefined();
  });

  it("emits turn end events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendTurnEnd("chat-1");
    expect(sent(ws)).toMatchObject({ event: "turn_end", chat_id: "chat-1" });
  });

  it("emits running goal status with startedAt", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendRunStatus("chat-1", "running", { startedAt: 123 });
    expect(sent(ws)).toMatchObject({ event: "run_status", status: "running", started_at: 123 });
  });

  it("omits startedAt for idle goal status", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendRunStatus("chat-1", "idle", { startedAt: 123 });
    expect(sent(ws)).toMatchObject({ event: "run_status", status: "idle" });
    expect(sent(ws).started_at).toBeUndefined();
  });

  it("emits goal state blobs per chat", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendGoalState("chat-1", { active: true, objective: "ship" });
    expect(sent(ws)).toMatchObject({ event: "goal_state", goal_state: { active: true, objective: "ship" } });
  });

  it("detects typed frames when parsing envelopes", () => {
    expect(parseEnvelope(JSON.stringify({ type: "message", chat_id: "chat-1" }))).toEqual({ type: "message", chat_id: "chat-1" });
  });
});
