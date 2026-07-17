import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session/manager.js";

const roots: string[] = [];

function sessionManager(): SessionManager {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-heartbeat-context-"));
  roots.push(root);
  return new SessionManager(path.join(root, "sessions"));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("heartbeat context bridge", () => {
  it("injects delivered heartbeat messages into the channel session", () => {
    const manager = sessionManager();
    const session = manager.getOrCreate("telegram:12345");
    session.addMessage("user", "hello earlier");
    manager.save(session);

    const target = manager.getOrCreate("telegram:12345");
    target.addMessage("assistant", "3 new emails — invoice, meeting, proposal.", { channelDelivery: true });
    manager.save(target);

    const history = manager.getOrCreate("telegram:12345").getHistory({ maxMessages: 0 });
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history.at(-1)?.content).toContain("3 new emails");
  });

  it("keeps delivered heartbeat messages when the user replies", () => {
    const manager = sessionManager();
    const session = manager.getOrCreate("telegram:12345");
    session.addMessage("user", "Hey");
    session.addMessage("assistant", "Hi there!");
    manager.save(session);

    const injected = manager.getOrCreate("telegram:12345");
    injected.addMessage("assistant", "If you want, I can mark that email as read.", { channelDelivery: true });
    manager.save(injected);

    const replied = manager.getOrCreate("telegram:12345");
    replied.addMessage("user", "Sure");
    manager.save(replied);

    const history = manager.getOrCreate("telegram:12345").getHistory({ maxMessages: 0 });
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "user"]);
    expect(history[2].content).toContain("mark that email");
    expect(history[3].content).toBe("Sure");
  });

  it("appends cleanly without duplicating existing history", () => {
    const manager = sessionManager();
    const session = manager.getOrCreate("telegram:12345");
    session.addMessage("user", "What time is it?");
    session.addMessage("assistant", "It's 2pm.");
    session.addMessage("user", "Thanks");
    manager.save(session);

    const injected = manager.getOrCreate("telegram:12345");
    injected.addMessage("assistant", "You have a meeting in 30 minutes.", { channelDelivery: true });
    manager.save(injected);

    const history = manager.getOrCreate("telegram:12345").getHistory({ maxMessages: 0 });
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history.at(-1)?.content).toContain("meeting in 30 minutes");
  });

  it("keeps context when replying to the first delivered message", () => {
    const manager = sessionManager();
    const session = manager.getOrCreate("telegram:99999");
    session.addMessage("assistant", "Weather alert: sandstorm expected at 4pm.", { channelDelivery: true });
    session.addMessage("user", "Sure");
    manager.save(session);

    const history = manager.getOrCreate("telegram:99999").getHistory({ maxMessages: 0 });
    expect(history).toEqual([
      { role: "assistant", content: "Weather alert: sandstorm expected at 4pm." },
      { role: "user", content: "Sure" },
    ]);
  });
});
