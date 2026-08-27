import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWebuiSessionBinding,
  SessionManager,
} from "../../../src/core/session/manager.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-webui-binding-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("WebUI Session binding", () => {
  it("uses first-writer-wins reservation semantics", () => {
    const root = tempRoot();
    const other = tempRoot();
    const sessions = new SessionManager(path.join(root, "sessions"));
    const sessionKey = "websocket:chat";
    const binding = { projectId: null, cwd: fs.realpathSync(root) };

    expect(sessions.reserveWebuiSessionBinding(sessionKey, binding)).toEqual(binding);
    expect(sessions.reserveWebuiSessionBinding(sessionKey, binding)).toEqual(binding);
    expect(() => sessions.reserveWebuiSessionBinding(sessionKey, {
      projectId: null,
      cwd: fs.realpathSync(other),
    })).toThrowError(expect.objectContaining({ code: "workspace_conflict" }));
    expect(sessions.consumeWebuiSessionBindingReservation(sessionKey)).toEqual(binding);
    expect(sessions.peekWebuiSessionBindingReservation(sessionKey)).toBeNull();
  });

  it("persists the binding in the existing Session metadata instead of a second store", () => {
    const root = tempRoot();
    const sessionsRoot = path.join(root, "sessions");
    const sessions = new SessionManager(sessionsRoot);
    const session = sessions.getOrCreate("websocket:chat");
    session.metadata.webui = true;
    session.metadata.webuiProjectId = "project-id";
    session.metadata.webuiWorkspaceCwd = fs.realpathSync(root);
    sessions.save(session);

    const reloaded = new SessionManager(sessionsRoot).get("websocket:chat");

    expect(readWebuiSessionBinding(reloaded)).toEqual({
      projectId: "project-id",
      cwd: fs.realpathSync(root),
    });
  });

  it("normalizes a legacy WebUI Session only when both binding fields are absent", () => {
    const root = tempRoot();
    const workspace = fs.realpathSync(root);
    const sessionsRoot = path.join(workspace, "sessions");
    const sessions = new SessionManager(sessionsRoot, {
      legacyWebuiWorkspaceCwd: workspace,
    });
    const legacy = sessions.getOrCreate("websocket:legacy");
    legacy.metadata.webui = true;
    sessions.save(legacy);
    sessions.invalidate(legacy.key);

    const reloaded = sessions.get(legacy.key);

    expect(readWebuiSessionBinding(reloaded)).toEqual({
      projectId: null,
      cwd: workspace,
    });

    const partial = sessions.getOrCreate("websocket:partial");
    partial.metadata.webui = true;
    partial.metadata.webuiProjectId = null;
    sessions.save(partial);
    sessions.invalidate(partial.key);

    expect(() => readWebuiSessionBinding(sessions.get(partial.key))).toThrowError(
      expect.objectContaining({ code: "workspace_missing" }),
    );
  });

  it("does not normalize a non-WebSocket Session marked as WebUI", () => {
    const root = tempRoot();
    const workspace = fs.realpathSync(root);
    const sessions = new SessionManager(path.join(workspace, "sessions"), {
      legacyWebuiWorkspaceCwd: workspace,
    });
    const session = sessions.getOrCreate("telegram:mislabelled");
    session.metadata.webui = true;
    sessions.save(session);
    sessions.invalidate(session.key);

    expect(() => readWebuiSessionBinding(sessions.get(session.key))).toThrowError(
      expect.objectContaining({ code: "workspace_missing" }),
    );
  });

  it("prevents late saves from recreating a permanently deleted Session", async () => {
    const root = tempRoot();
    const sessions = new SessionManager(path.join(root, "sessions"));
    const session = sessions.getOrCreate("websocket:chat");
    session.addMessage("user", "hello");
    sessions.save(session);
    const filePath = sessions.pathFor(session.key);

    expect(sessions.hardDeleteSession(session.key)).toBe(true);
    sessions.save(session);
    await sessions.saveAsync(session);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(sessions.get(session.key)).toBeNull();
    expect(() => sessions.getOrCreate(session.key)).toThrowError(
      expect.objectContaining({ code: "session_deleted" }),
    );
  });
});
