import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { getMediaDir } from "../../../src/config/paths.js";
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
  publishRuntimeModelUpdate,
  stripTrailingSlash,
} from "../../../src/integrations/channels/websocket.js";
import { webuiTranscriptPath } from "../../../src/entrypoints/frontend-bridge/transcript.js";
import { websocketTurnWallStartTimes } from "../../../src/core/session/webui-turns.js";

const WINDOWS_COMMAND_ERROR = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。";

function connection(): { send: ReturnType<typeof vi.fn>; remoteAddress: string[] } {
  return { send: vi.fn(async () => undefined), remoteAddress: ["127.0.0.1"] };
}

function sent(ws: { send: ReturnType<typeof vi.fn> }, index = 0): any {
  return JSON.parse(ws.send.mock.calls[index][0]);
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

afterEach(() => {
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

    await channel.sendGoalStatus("chat-1", "running", { startedAt: 123, turnId: "turn-1" });
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

    await channel.sendGoalStatus("chat-1", "running", { startedAt: 123, turnId: "turn-active" });
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "Model request failed, retrying attempt 1 in 1s...",
      metadata: { retryWait: true, turn_id: "turn-stopped" },
    }));

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(sent(ws)).toMatchObject({ event: "goal_status", turn_id: "turn-active" });
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
    tempDataDir();
    const bus = new MessageBus();
    const channel = new WebSocketChannel({}, bus);
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
    await channel.sendGoalStatus("chat-1", "running", { startedAt: 123 });

    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ event: "delta", text: "hel", stream_id: "s1" });
    expect(JSON.parse(ws.send.mock.calls[1][0])).toMatchObject({ event: "stream_end", text: "hello", stream_id: "s1" });
    expect(JSON.parse(ws.send.mock.calls[2][0])).toMatchObject({ event: "goal_status", status: "running", started_at: 123 });
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
    const channel = new WebSocketChannel({}, bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "message", chat_id: "chat-1", content: "hello", webui: true });

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
    const channel = new WebSocketChannel({}, bus);
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "message", chat_id: "chat-1", content: "hello", webui: true, language: "fr-FR" });

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

  it("broadcasts runtime model updates", async () => {
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

    expect(sent(ws)).toEqual({ event: "runtime_model_updated", model_name: "openai/gpt-4.1", model_preset: "fast" });
  });

  it("publishes runtime model update messages onto the bus", async () => {
    const bus = new MessageBus();

    publishRuntimeModelUpdate(bus, "openai/gpt-4.1", "fast");

    const outbound = await bus.nextOutbound();
    expect(outbound.channel).toBe("websocket");
    expect(outbound.chatId).toBe("*");
    expect(outbound.metadata).toMatchObject({ runtimeModelUpdated: true, model: "openai/gpt-4.1", model_preset: "fast" });
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

    await channel.sendGoalStatus("chat-1", "running", { startedAt: 123, turnId: "turn-active" });
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
    expect(sent(ws)).toMatchObject({ event: "goal_status", status: "running", turn_id: "turn-active" });

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
    await channel.sendTurnEnd("chat-1", { latencyMs: 42, goalState: { active: true } });

    const lines = fs.readFileSync(webuiTranscriptPath("websocket:chat-1"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { event: "reasoning_delta", chat_id: "chat-1", text: "thinking", stream_id: "r1" },
      { event: "reasoning_end", chat_id: "chat-1", stream_id: "r1" },
      { event: "turn_end", chat_id: "chat-1", latency_ms: 42, goal_state: { active: true } },
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

  it("includes goal state in turn_end events", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendTurnEnd("chat-1", { goalState: { active: true } });

    expect(sent(ws).goal_state).toEqual({ active: true });
  });

  it("emits running goal status with started_at", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendGoalStatus("chat-1", "running", { startedAt: 123 });

    expect(sent(ws)).toMatchObject({ event: "goal_status", status: "running", started_at: 123 });
  });

  it("omits started_at for idle goal status", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.sendGoalStatus("chat-1", "idle", { startedAt: 123 });

    expect(sent(ws)).toMatchObject({ event: "goal_status", status: "idle" });
    expect(sent(ws).started_at).toBeUndefined();
  });

  it("sends an idle run snapshot immediately after an explicit attach", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1" },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "idle" },
    ]);
  });

  it("sends a running snapshot before the legacy running hydrate", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    websocketTurnWallStartTimes.set("chat-1", 1780732800);
    channel.activeTurnIdByChatId.set("chat-1", "turn-1");

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1" },
      {
        event: "run_status_snapshot",
        chat_id: "chat-1",
        status: "running",
        started_at: 1780732800,
        turn_id: "turn-1",
      },
      { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 },
    ]);
  });

  it("correlates an idle snapshot with a still-known active turn", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.activeTurnIdByChatId.set("chat-1", "turn-finishing");

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1" },
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
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.sessionManager = {
      readSessionFile: vi.fn(() => ({
        metadata: { goalState: { status: "active", objective: "Ship the fix" } },
      })),
    };

    await channel.dispatchEnvelope(ws, "client-1", { type: "attach", chat_id: "chat-1" });

    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1" },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "idle" },
      {
        event: "goal_state",
        chat_id: "chat-1",
        goal_state: { active: true, objective: "Ship the fix" },
      },
    ]);
  });

  it("continues subscription hydration when an earlier subscriber has disconnected", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const stale = { send: vi.fn(async () => { throw new Error("closed"); }) };
    const attaching = connection();
    channel.attachConnection(stale, "chat-1");
    channel.sessionManager = {
      readSessionFile: vi.fn(() => ({
        metadata: { goalState: { status: "active", objective: "Ship the fix" } },
      })),
    };

    await expect(channel.dispatchEnvelope(attaching, "client-1", {
      type: "attach",
      chat_id: "chat-1",
    })).resolves.toBeUndefined();

    expect(attaching.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { event: "attached", chat_id: "chat-1" },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "idle" },
      {
        event: "goal_state",
        chat_id: "chat-1",
        goal_state: { active: true, objective: "Ship the fix" },
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
    const channel = new WebSocketChannel({}, bus);
    await channel.dispatchEnvelope(connection(), "webui-client", { type: "message", chat_id: "chat-1", content: "hello", webui: true });
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

  it("broadcasts runtime model updates", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.send(new OutboundMessage({ channel: "websocket", chatId: "*", metadata: { runtimeModelUpdated: true, model: "openai/gpt-4.1", model_preset: "fast" } }));

    expect(sent(ws)).toEqual({ event: "runtime_model_updated", model_name: "openai/gpt-4.1", model_preset: "fast" });
  });

  it("publishes runtime model updates as WebSocket outbound events", async () => {
    const bus = new MessageBus();
    publishRuntimeModelUpdate(bus, "openai/gpt-4.1", "fast");
    const event = await bus.nextOutbound();
    expect(event.channel).toBe("websocket");
    expect(event.chatId).toBe("*");
    expect(event.metadata).toEqual({ runtimeModelUpdated: true, model: "openai/gpt-4.1", model_preset: "fast" });
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
    await channel.sendGoalStatus("chat-1", "running", { startedAt: 123 });
    expect(sent(ws)).toMatchObject({ event: "goal_status", status: "running", started_at: 123 });
  });

  it("omits startedAt for idle goal status", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    await channel.sendGoalStatus("chat-1", "idle", { startedAt: 123 });
    expect(sent(ws)).toMatchObject({ event: "goal_status", status: "idle" });
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
