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
