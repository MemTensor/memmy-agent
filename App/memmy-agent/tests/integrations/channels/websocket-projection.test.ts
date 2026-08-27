import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";
import {
  toGuiChatId,
} from "../../../src/entrypoints/frontend-bridge/gui-session-projection.js";
import { TerminalRunControl } from "../../../src/core/session/terminal-session-control.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

function projectedSession(
  manager: SessionManager,
  workspace: string,
  key: string,
  title?: string,
): Session {
  const session = new Session({ key });
  session.metadata.webui = true;
  session.metadata.webuiProjectId = null;
  session.metadata.webuiWorkspaceCwd = workspace;
  if (title) session.metadata.title = title;
  manager.save(session, { fsync: true });
  return session;
}

function fixture(): {
  root: string;
  workspace: string;
  manager: SessionManager;
  bus: MessageBus;
  channel: WebSocketChannel;
  sent: Record<string, any>[];
  connection: { remoteAddress: string[]; send: (raw: string) => Promise<void> };
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-ws-projection-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const manager = new SessionManager(path.join(workspace, "sessions"));
  const bus = new MessageBus();
  const channel = new WebSocketChannel(
    { allowFrom: ["*"] },
    bus,
    { sessionManager: manager, workspacePath: workspace },
  );
  (channel as any).apiTokens.set("api-token", Date.now() / 1000 + 60);
  const sent: Record<string, any>[] = [];
  return {
    root,
    workspace: fs.realpathSync(workspace),
    manager,
    bus,
    channel,
    sent,
    connection: {
      remoteAddress: ["127.0.0.1"],
      send: async (raw: string) => {
        sent.push(JSON.parse(raw));
      },
    },
  };
}

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("WebSocket projected sessions", () => {
  it("lists native GUI, allowed IM, and terminal sessions through the standard summary", () => {
    const { manager, workspace, channel } = fixture();
    projectedSession(manager, workspace, "websocket:native", "Native");
    projectedSession(manager, workspace, "telegram:123", "Telegram task");
    projectedSession(manager, workspace, "cli:direct", "Terminal task");
    projectedSession(manager, workspace, "email:hidden", "Hidden");

    const response = channel.handleSessionsList({
      path: "/api/sessions?token=api-token",
      headers: {},
    });
    const body = JSON.parse(String(response.body));
    expect(body.sessions.map((row: any) => row.key).sort()).toEqual([
      "websocket:ext_Y2xpOmRpcmVjdA",
      "websocket:ext_dGVsZWdyYW06MTIz",
      "websocket:native",
    ]);
    expect(body.sessions.find((row: any) => row.key.includes("dGVsZWdyYW0")).title)
      .toBe("Telegram task · Telegram");
    expect(body.sessions.find((row: any) => row.key.includes("Y2xp")).title)
      .toBe("Terminal task");
  });

  it("routes projected message, status, history, and stop to the canonical session", async () => {
    const { manager, workspace, bus, channel, connection, sent } = fixture();
    const canonicalKey = "telegram:123";
    projectedSession(manager, workspace, canonicalKey);
    const chatId = toGuiChatId(canonicalKey);
    const cancel = vi.fn(async () => 1);
    const drain = vi.fn(async () => undefined);
    channel.cancelActiveTasks = cancel;
    channel.setTranscriptMonitor({ drain } as any);

    await channel.dispatchEnvelope(connection, "client", {
      type: "message",
      chat_id: chatId,
      content: "GUI B",
      webui: true,
      client_request_id: "11111111-1111-4111-8111-111111111111",
    });
    const message = await bus.nextInbound();
    expect(message).toMatchObject({
      channel: "websocket",
      chatId,
      sessionKey: canonicalKey,
      content: "GUI B",
    });

    await channel.dispatchEnvelope(connection, "client", {
      type: "status",
      chat_id: chatId,
    });
    expect(await bus.nextInbound()).toMatchObject({
      chatId,
      sessionKey: canonicalKey,
      content: "/status",
    });

    await channel.dispatchEnvelope(connection, "client", {
      type: "history_dag",
      chat_id: chatId,
    });
    expect(await bus.nextInbound()).toMatchObject({
      chatId,
      sessionKey: canonicalKey,
      content: "/history-dag",
    });

    await channel.dispatchEnvelope(connection, "client", {
      type: "stop",
      chat_id: chatId,
    });
    expect(cancel).toHaveBeenCalledWith(canonicalKey);
    expect(drain).toHaveBeenCalledOnce();
    expect(sent.some((event) => event.event === "stop_result" && event.chat_id === chatId))
      .toBe(true);
    expect(manager.has(`websocket:${chatId}`)).toBe(false);
  });

  it("rejects malformed reserved ext_ chat IDs without creating alias Sessions", async () => {
    const { manager, channel, connection, sent } = fixture();
    await channel.dispatchEnvelope(connection, "client", {
      type: "message",
      chat_id: "ext_",
      content: "must not create an alias",
      webui: true,
    });
    expect(sent.at(-1)).toMatchObject({ event: "error", detail: "invalid chat_id" });
    expect(manager.has("websocket:ext_")).toBe(false);
  });

  it("debounces global projected session updates by GUI chat ID", async () => {
    vi.useFakeTimers();
    try {
      const { manager, workspace, channel, connection, sent } = fixture();
      const canonicalKey = "cli:global-update";
      projectedSession(manager, workspace, canonicalKey);
      const chatId = toGuiChatId(canonicalKey);
      channel.attachConnection(connection, "existing-chat");

      await channel.consumeTranscriptRecord({
        event: "session_updated",
        chat_id: chatId,
        scope: "metadata",
      });
      await channel.sendSessionUpdated(chatId, "thread");
      expect(sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toEqual([{
        event: "session_updated",
        chat_id: chatId,
        scope: "thread",
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the canonical binding for live transcript media", async () => {
    const { manager, workspace, channel, connection, sent } = fixture();
    const canonicalKey = "cli:media";
    projectedSession(manager, workspace, canonicalKey);
    const imagePath = path.join(workspace, "diagram.png");
    fs.writeFileSync(imagePath, "image", "utf8");
    const chatId = toGuiChatId(canonicalKey);
    channel.attachConnection(connection, chatId);

    await channel.consumeTranscriptRecord({
      event: "message",
      chat_id: chatId,
      text: "![diagram](diagram.png)",
      content: "![diagram](diagram.png)",
    }, canonicalKey);
    await channel.consumeTranscriptRecord({
      event: "user",
      chat_id: chatId,
      text: "attachment",
      media_paths: [imagePath],
    }, canonicalKey);

    expect(sent[0].text).toMatch(/^!\[diagram\]\(\/api\/media\//);
    expect(sent[0].content).toBe(sent[0].text);
    expect(sent[1].media_urls).toHaveLength(1);
    expect(sent[1].media_urls[0]).toMatchObject({
      name: "diagram.png",
      path: fs.realpathSync(imagePath),
    });
    expect(sent[1].media_urls[0].url).toMatch(/^\/api\/media\//);
  });

  it("restores an independent terminal run in attach snapshots", async () => {
    const { manager, workspace, channel, connection, sent } = fixture();
    const canonicalKey = "cli:running";
    projectedSession(manager, workspace, canonicalKey);
    const runControl = new TerminalRunControl(manager.root);
    const state = await runControl.create(canonicalKey, "turn-running");
    const chatId = toGuiChatId(canonicalKey);

    await channel.dispatchEnvelope(connection, "client", {
      type: "attach",
      chat_id: chatId,
    });

    expect(sent).toContainEqual({
      event: "run_status_snapshot",
      chat_id: chatId,
      status: "running",
      started_at: state.startedAt / 1000,
      turn_id: "turn-running",
    });
    await runControl.remove(canonicalKey, "turn-running");
  });

  it("rejects target creation for an external projection", async () => {
    const { manager, workspace, channel, connection, sent } = fixture();
    const canonicalKey = "slack:C123";
    projectedSession(manager, workspace, canonicalKey);
    await channel.dispatchEnvelope(connection, "client", {
      type: "message",
      chat_id: toGuiChatId(canonicalKey),
      content: "bad target",
      webui: true,
      client_request_id: "11111111-1111-4111-8111-111111111111",
      target: { kind: "standalone" },
    });
    expect(sent.at(-1)).toMatchObject({
      event: "error",
      reason: "session_target_invalid",
    });
  });

  it("reads, renames, and deletes canonical data while returning the GUI key", async () => {
    const { manager, workspace, channel } = fixture();
    const closeBrowserChat = vi.fn(async () => undefined);
    const sessionTurnBarrier = vi.fn(async (
      _sessionKey: string,
      operation: () => Promise<any>,
    ) => operation());
    channel.closeBrowserChat = closeBrowserChat;
    channel.setSessionTurnBarrier(sessionTurnBarrier);
    const canonicalKey = "feishu:room";
    const session = projectedSession(manager, workspace, canonicalKey, "Base");
    session.addMessage("user", "hello");
    manager.save(session);
    const guiKey = `websocket:${toGuiChatId(canonicalKey)}`;
    const encoded = encodeURIComponent(guiKey);
    const request = { path: `/?token=api-token`, headers: {} };

    const messages = channel.handleSessionMessages(request, encoded);
    expect(JSON.parse(String(messages.body))).toMatchObject({
      key: guiKey,
      messages: [{ role: "user", content: "hello" }],
    });

    const renamed = await channel.handleSessionTitleUpdate({
      path: `/?token=api-token`,
      headers: {},
      method: "POST",
      body: JSON.stringify({ title: "Renamed · 飞书" }),
    }, encoded);
    expect(renamed.status).toBe(200);
    expect(manager.get(canonicalKey)?.metadata.title).toBe("Renamed");
    expect(sessionTurnBarrier).toHaveBeenCalledWith(
      canonicalKey,
      expect.any(Function),
    );

    const deleted = await channel.handleSessionDelete(request, encoded);
    expect(JSON.parse(String(deleted.body))).toEqual({ deleted: true, key: guiKey });
    expect(manager.has(canonicalKey)).toBe(false);
    expect(manager.has(guiKey)).toBe(false);
    expect(closeBrowserChat).toHaveBeenCalledWith("projected-session", canonicalKey);
  });
});
