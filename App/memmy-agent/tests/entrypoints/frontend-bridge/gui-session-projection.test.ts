import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session/manager.js";
import {
  fromGuiChatId,
  GuiSessionProjection,
  GuiSessionProjectionError,
  isExternalGuiChatId,
  toGuiChatId,
} from "../../../src/entrypoints/frontend-bridge/gui-session-projection.js";

const roots: string[] = [];

function createSessions(): { root: string; sessions: SessionManager } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-gui-projection-"));
  roots.push(root);
  return { root, sessions: new SessionManager(path.join(root, "sessions")) };
}

function createVisibleSession(
  sessions: SessionManager,
  root: string,
  key: string,
  projectId: string | null = null,
) {
  const session = sessions.getOrCreate(key);
  session.metadata.webui = true;
  session.metadata.webuiProjectId = projectId;
  session.metadata.webuiWorkspaceCwd = fs.realpathSync(root);
  session.addMessage("user", "修复支付回调");
  sessions.save(session);
  return session;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("GuiSessionProjection", () => {
  it("round-trips canonical external keys without creating an alias Session", () => {
    const { root, sessions } = createSessions();
    const canonicalKey = "telegram:123456";
    createVisibleSession(sessions, root, canonicalKey);

    const guiChatId = toGuiChatId(canonicalKey);
    expect(isExternalGuiChatId(guiChatId)).toBe(true);
    expect(fromGuiChatId(guiChatId)).toBe(canonicalKey);

    const projection = new GuiSessionProjection(sessions);
    const resolved = projection.resolve(guiChatId);
    expect(resolved).toMatchObject({
      canonicalSessionKey: canonicalKey,
      guiChatId,
      guiSessionKey: `websocket:${guiChatId}`,
      source: { kind: "im", channel: "telegram", displayName: "Telegram" },
    });
    expect(sessions.has(`websocket:${guiChatId}`)).toBe(false);
  });

  it("projects IM as standalone and terminal Sessions using their binding", () => {
    const { root, sessions } = createSessions();
    createVisibleSession(sessions, root, "telegram:chat");
    createVisibleSession(sessions, root, "cli:direct", "project-a");

    const rows = new GuiSessionProjection(sessions).snapshot();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: `websocket:${toGuiChatId("telegram:chat")}`,
        projectId: null,
        title: "修复支付回调 · Telegram",
      }),
      expect.objectContaining({
        key: `websocket:${toGuiChatId("cli:direct")}`,
        projectId: "project-a",
        title: "修复支付回调",
      }),
    ]));
  });

  it("rejects unsupported, overlong, malformed, missing, and incomplete projections", () => {
    expect(() => toGuiChatId("email:inbox")).toThrowError(
      expect.objectContaining({ code: "session_source_invalid" }),
    );
    expect(() => toGuiChatId(`telegram:${"x".repeat(200)}`)).toThrowError(
      expect.objectContaining({ code: "session_source_invalid" }),
    );
    expect(() => fromGuiChatId("ext_***")).toThrowError(
      expect.objectContaining({ code: "chat_id_invalid" }),
    );

    const { root, sessions } = createSessions();
    const projection = new GuiSessionProjection(sessions);
    const missingChatId = toGuiChatId("telegram:missing");
    expect(() => projection.resolve(missingChatId)).toThrowError(
      expect.objectContaining({ code: "session_not_found" }),
    );

    const incomplete = sessions.getOrCreate("telegram:incomplete");
    incomplete.metadata.webui = true;
    incomplete.metadata.webuiProjectId = null;
    sessions.save(incomplete);
    expect(() => projection.resolve(toGuiChatId(incomplete.key))).toThrowError(
      expect.objectContaining({ code: "session_binding_invalid" }),
    );

    const hidden = sessions.getOrCreate("telegram:hidden");
    hidden.metadata.webuiProjectId = null;
    hidden.metadata.webuiWorkspaceCwd = fs.realpathSync(root);
    sessions.save(hidden);
    expect(() => projection.resolve(toGuiChatId(hidden.key))).toThrowError(
      expect.objectContaining({ code: "session_not_found" }),
    );
  });

  it("keeps a long IM source suffix visible within the frontend title limit", () => {
    const { root, sessions } = createSessions();
    const session = createVisibleSession(sessions, root, "msteams:chat");
    session.metadata.title = "这是一个非常长的标题".repeat(10);
    sessions.save(session);

    const summary = new GuiSessionProjection(sessions).projectSession(session);
    expect(summary?.title).toHaveLength(52);
    expect(summary?.title).toMatch(/ · Microsoft Teams$/);
  });

  it("keeps native GUI keys unchanged", () => {
    const { root, sessions } = createSessions();
    createVisibleSession(sessions, root, "websocket:native-chat");
    const projection = new GuiSessionProjection(sessions);

    expect(projection.resolve("native-chat")).toMatchObject({
      canonicalSessionKey: "websocket:native-chat",
      guiChatId: "native-chat",
      guiSessionKey: "websocket:native-chat",
    });
  });

  it("uses typed errors for invalid GUI inputs", () => {
    const { sessions } = createSessions();
    const projection = new GuiSessionProjection(sessions);
    expect(() => projection.resolve("../escape")).toThrow(GuiSessionProjectionError);
  });
});
