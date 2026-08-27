import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";
import {
  GatewayTranscriptMonitor,
  GuiTranscriptMirror,
} from "../../../src/entrypoints/frontend-bridge/gui-transcript-sync.js";
import {
  GuiSessionProjection,
  toGuiChatId,
} from "../../../src/entrypoints/frontend-bridge/gui-session-projection.js";
import {
  appendTranscriptObject,
  readTranscriptLines,
  webuiTranscriptPath,
} from "../../../src/entrypoints/frontend-bridge/transcript.js";

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

function fixture(): {
  root: string;
  workspace: string;
  sessions: SessionManager;
  projection: GuiSessionProjection;
  mirror: GuiTranscriptMirror;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-gui-sync-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const sessions = new SessionManager(path.join(workspace, "sessions"));
  return {
    root,
    workspace,
    sessions,
    projection: new GuiSessionProjection(sessions),
    mirror: new GuiTranscriptMirror(sessions, workspace),
  };
}

function saveProjectedSession(
  sessions: SessionManager,
  workspace: string,
  key: string,
): Session {
  const session = new Session({ key });
  session.metadata.webui = true;
  session.metadata.webuiProjectId = null;
  session.metadata.webuiWorkspaceCwd = workspace;
  sessions.save(session, { fsync: true });
  return session;
}

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GUI transcript synchronization", () => {
  it("establishes an allowed IM standalone binding before mirroring user output", () => {
    const { workspace, sessions, mirror } = fixture();
    const session = new Session({ key: "telegram:123" });
    const message = new InboundMessage({
      channel: "telegram",
      chatId: "123",
      senderId: "user",
      content: "hello",
    });
    const binding = mirror.prepareSession(message, session, session.key);
    const canonicalWorkspace = fs.realpathSync(workspace);
    expect(binding).toEqual({ projectId: null, cwd: canonicalWorkspace });
    expect(sessions.loadSession(session.key)?.metadata).toMatchObject({
      webui: true,
      webuiProjectId: null,
      webuiWorkspaceCwd: canonicalWorkspace,
    });

    const clientRequestId = "11111111-1111-4111-8111-111111111111";
    const turn = mirror.turn(
      session.key,
      "turn-1",
      { kind: "im", channel: "telegram" },
      clientRequestId,
    )!;
    mirror.user(turn, "hello");
    mirror.progress(turn, "", {
      fileEditEvents: [{ path: "src/index.ts", action: "write" }],
    });
    mirror.progress(turn, "task card", {
      agentUi: { task: { title: "Projected task" } },
    });
    mirror.delta(turn, "world", "stream-1");
    mirror.contextCompaction(turn, "Summarizing chat context", "running");
    mirror.retryWait(turn, "Retrying in 1 second");
    mirror.final(turn, "world", 12, { result: { status: "done" } });
    mirror.ended(turn, 12);
    const transcript = readTranscriptLines(`websocket:${toGuiChatId(session.key)}`);
    expect(transcript.map((row) => row.event))
      .toEqual([
        "session_updated",
        "user",
        "file_edit",
        "message",
        "delta",
        "context_compaction",
        "retry_wait",
        "message",
        "turn_end",
        "run_status",
        "session_updated",
      ]);
    expect(transcript[2]).toMatchObject({
      event: "file_edit",
      edits: [{ path: "src/index.ts", action: "write" }],
    });
    expect(transcript[3]).toMatchObject({
      event: "message",
      agent_ui: { task: { title: "Projected task" } },
    });
    expect(transcript[5]).toMatchObject({
      event: "context_compaction",
      status: "running",
    });
    expect(transcript[6]).toMatchObject({
      event: "retry_wait",
      text: "Retrying in 1 second",
    });
    expect(transcript[7]).toMatchObject({
      event: "message",
      agent_ui: { result: { status: "done" } },
    });
    expect(transcript[1]).toMatchObject({
      event: "user",
      client_request_id: clientRequestId,
      source: { kind: "im", channel: "telegram" },
    });
    for (const record of transcript.slice(1, 10)) {
      expect(record.source).toEqual({ kind: "im", channel: "telegram" });
    }
  });

  it("starts existing files at EOF and broadcasts only appended complete records", async () => {
    const { workspace, sessions, projection } = fixture();
    const key = "cli:direct";
    saveProjectedSession(sessions, workspace, key);
    const guiKey = `websocket:${toGuiChatId(key)}`;
    const chatId = toGuiChatId(key);
    appendTranscriptObject(guiKey, { event: "message", chat_id: chatId, text: "old" });
    const records: Record<string, any>[] = [];
    const monitor = new GatewayTranscriptMonitor({
      projection,
      onRecord: (record) => {
        records.push(record);
      },
      onRefresh: () => undefined,
    });
    monitor.start();
    monitor.stop();
    appendTranscriptObject(guiKey, { event: "message", chat_id: chatId, text: "new" });
    await monitor.scan();
    expect(records.map((record) => record.text)).toEqual(["new"]);
  });

  it("mirrors image model errors with the selected and internally failed models separated", () => {
    const { workspace, sessions, mirror } = fixture();
    const session = saveProjectedSession(sessions, workspace, "cli:image-error");
    const turn = mirror.turn(session.key, "turn-image-error", { kind: "tui", channel: "cli" })!;

    mirror.final(turn, "图片解析失败，请稍后重试", 17, null, "image_analysis_failed", {
      category: "image_analysis_failed",
      presetId: "account-agent",
      source: "account",
      provider: "memmy_account",
      model: "agent_chat",
      capability: "agent",
      failedProvider: "memmy_account",
      failedModel: "image2text",
    });

    expect(readTranscriptLines(`websocket:${toGuiChatId(session.key)}`).at(-1)).toMatchObject({
      event: "message",
      model_error: {
        category: "image_analysis_failed",
        model: "agent_chat",
        failedProvider: "memmy_account",
        failedModel: "image2text",
      },
    });
  });

  it("requests a thread refresh after a malformed appended line", async () => {
    const { workspace, sessions, projection } = fixture();
    const key = "slack:room";
    saveProjectedSession(sessions, workspace, key);
    const guiKey = `websocket:${toGuiChatId(key)}`;
    const refreshes: string[] = [];
    const monitor = new GatewayTranscriptMonitor({
      projection,
      onRecord: () => undefined,
      onRefresh: (chatId) => {
        refreshes.push(chatId);
      },
    });
    monitor.start();
    monitor.stop();
    fs.appendFileSync(webuiTranscriptPath(guiKey), "{bad json}\n", "utf8");
    await monitor.scan();
    expect(refreshes).toEqual([toGuiChatId(key)]);
  });

  it("drains records appended while an earlier scan is still running", async () => {
    const { workspace, sessions, projection } = fixture();
    const key = "cli:direct";
    saveProjectedSession(sessions, workspace, key);
    const guiKey = `websocket:${toGuiChatId(key)}`;
    const chatId = toGuiChatId(key);
    appendTranscriptObject(guiKey, { event: "message", chat_id: chatId, text: "old" });
    const records: string[] = [];
    let releaseFirst!: () => void;
    const firstRecordGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstRecordSeen!: () => void;
    const firstRecordStarted = new Promise<void>((resolve) => {
      firstRecordSeen = resolve;
    });
    const monitor = new GatewayTranscriptMonitor({
      projection,
      onRecord: async (record) => {
        records.push(String(record.text));
        if (record.text === "first") {
          firstRecordSeen();
          await firstRecordGate;
        }
      },
      onRefresh: () => undefined,
    });
    monitor.start();
    monitor.stop();
    appendTranscriptObject(guiKey, { event: "message", chat_id: chatId, text: "first" });
    const firstScan = monitor.scan();
    await firstRecordStarted;
    appendTranscriptObject(guiKey, { event: "message", chat_id: chatId, text: "second" });
    const drain = monitor.drain();
    releaseFirst();
    await Promise.all([firstScan, drain]);
    expect(records).toEqual(["first", "second"]);
  });
});
