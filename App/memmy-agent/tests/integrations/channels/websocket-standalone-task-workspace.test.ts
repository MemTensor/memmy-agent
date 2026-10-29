import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

const TASK_FOLDER_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?$/;
const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

afterEach(() => {
  if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function connection(): { send: ReturnType<typeof vi.fn>; remoteAddress: string[] } {
  return { send: vi.fn(async () => undefined), remoteAddress: ["127.0.0.1"] };
}

function setup(taskRoot?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-standalone-task-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const standaloneTaskRoot = taskRoot ?? path.join(root, "Memmy");
  const sessions = new SessionManager(path.join(root, "sessions"));
  const channel = new WebSocketChannel({}, new MessageBus(), {
    sessionManager: sessions,
    workspacePath: workspace,
    standaloneTaskRoot,
  });
  return { root, workspace, standaloneTaskRoot, sessions, channel };
}

function standaloneMessage(chatId: string, clientRequestId: string): Record<string, any> {
  return {
    type: "message",
    chat_id: chatId,
    content: "hello",
    webui: true,
    client_request_id: clientRequestId,
    target: { kind: "standalone" },
  };
}

function bindingRejections(ws: { send: ReturnType<typeof vi.fn> }): any[] {
  return ws.send.mock.calls
    .map(([payload]) => JSON.parse(payload))
    .filter((payload) => payload.detail === "session_binding_rejected");
}

describe("WebSocket standalone task workspaces", () => {
  it("binds each new standalone task to its own folder instead of the profile workspace", async () => {
    const { workspace, standaloneTaskRoot, sessions, channel } = setup();
    const ws = connection();
    channel.attachConnection(ws, "chat-1");
    channel.attachConnection(ws, "chat-2");

    await channel.dispatchEnvelope(ws, "client-1", standaloneMessage("chat-1", "11111111-1111-4111-8111-111111111111"));
    await channel.dispatchEnvelope(ws, "client-1", standaloneMessage("chat-2", "22222222-2222-4222-8222-222222222222"));

    const first = sessions.peekWebuiSessionBindingReservation("websocket:chat-1");
    const second = sessions.peekWebuiSessionBindingReservation("websocket:chat-2");
    expect(bindingRejections(ws)).toEqual([]);
    expect(first?.projectId).toBeNull();
    expect(path.dirname(first!.cwd)).toBe(fs.realpathSync(standaloneTaskRoot));
    expect(path.basename(first!.cwd)).toMatch(TASK_FOLDER_NAME);
    expect(first!.cwd).not.toBe(fs.realpathSync(workspace));
    expect(second!.cwd).not.toBe(first!.cwd);
    expect(path.dirname(second!.cwd)).toBe(fs.realpathSync(standaloneTaskRoot));
  });

  it("reuses the reserved folder when a new task is addressed again before it starts", async () => {
    const { standaloneTaskRoot, sessions, channel } = setup();
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.dispatchEnvelope(ws, "client-1", standaloneMessage("chat-1", "11111111-1111-4111-8111-111111111111"));
    const reserved = sessions.peekWebuiSessionBindingReservation("websocket:chat-1");
    await channel.dispatchEnvelope(ws, "client-1", standaloneMessage("chat-1", "33333333-3333-4333-8333-333333333333"));

    expect(bindingRejections(ws)).toEqual([]);
    expect(sessions.peekWebuiSessionBindingReservation("websocket:chat-1")).toEqual(reserved);
    expect(fs.readdirSync(standaloneTaskRoot)).toEqual([path.basename(reserved!.cwd)]);
  });

  it("falls back to the profile workspace when the task root cannot be created", async () => {
    const blocker = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-task-blocker-"));
    roots.push(blocker);
    const blockedRoot = path.join(blocker, "Memmy");
    fs.writeFileSync(blockedRoot, "not a directory", "utf8");
    const { workspace, sessions, channel } = setup(blockedRoot);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ws = connection();
    channel.attachConnection(ws, "chat-1");

    await channel.dispatchEnvelope(ws, "client-1", standaloneMessage("chat-1", "11111111-1111-4111-8111-111111111111"));

    expect(bindingRejections(ws)).toEqual([]);
    expect(sessions.peekWebuiSessionBindingReservation("websocket:chat-1")).toEqual({
      projectId: null,
      cwd: fs.realpathSync(workspace),
    });
    expect(warn).toHaveBeenCalledWith(
      "[websocket] task workspace unavailable; using the profile workspace",
      expect.objectContaining({ root: blockedRoot }),
    );
  });

  it("gives the seeded first-report chat its own task folder", () => {
    const { standaloneTaskRoot, sessions, channel } = setup();
    (channel as any).apiTokens.set("api-token", Date.now() / 1000 + 60);

    const response = channel.handleWebuiSeedChat({
      path: "/api/webui/seed-chat",
      method: "POST",
      headers: { authorization: "Bearer api-token" },
      body: JSON.stringify({ user_text: "Organize my latest project", assistant_text: "First report body." }),
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(String(response.body));
    const cwd = sessions.get(body.session_key)?.metadata.webuiWorkspaceCwd;
    expect(path.dirname(cwd)).toBe(fs.realpathSync(standaloneTaskRoot));
    expect(path.basename(cwd)).toMatch(TASK_FOLDER_NAME);
  });
});
