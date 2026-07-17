import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import {
  finishWebuiTurn,
  publishWebuiThreadSessionUpdated,
  publishTurnRunStatus,
  shouldPublishWebuiThreadSessionUpdated,
  shouldPublishWebuiRunStatus,
  websocketTurnWallStartedAt,
  websocketTurnWallStartTimes,
} from "../../../src/core/session/webui-turns.js";

const roots: string[] = [];

function inbound(channel: string, chatId: string, metadata: Record<string, any> = {}): InboundMessage {
  return new InboundMessage({ channel, senderId: "u", chatId, content: "hi", metadata });
}

beforeEach(() => {
  websocketTurnWallStartTimes.clear();
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sessionRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-webui-turn-helper-"));
  roots.push(root);
  return root;
}

describe("webui turn helpers", () => {
  it("records wall-clock timing when websocket status becomes running", async () => {
    const bus = new MessageBus();
    const msg = inbound("websocket", "chat-a");

    await publishTurnRunStatus(bus, msg, "running");

    expect(websocketTurnWallStartTimes.has("chat-a")).toBe(true);
    const startedAt = websocketTurnWallStartedAt("chat-a");
    expect(typeof startedAt).toBe("number");
    const outbound = await bus.nextOutbound();
    expect(outbound.chatId).toBe("chat-a");
    expect(outbound.metadata.startedAt).toBe(startedAt);
  });

  it("clears wall-clock timing when websocket status becomes idle", async () => {
    const bus = new MessageBus();
    const msg = inbound("websocket", "chat-b");

    await publishTurnRunStatus(bus, msg, "running");
    expect(websocketTurnWallStartedAt("chat-b")).not.toBeNull();
    await bus.nextOutbound();

    await publishTurnRunStatus(bus, msg, "idle");

    expect(websocketTurnWallStartedAt("chat-b")).toBeNull();
  });

  it("does not mutate the websocket timing registry for non-websocket channels", async () => {
    const bus = new MessageBus();

    await publishTurnRunStatus(bus, inbound("telegram", "1"), "running");

    expect(websocketTurnWallStartTimes.size).toBe(0);
  });

  it("only publishes run status for real WebUI turns", () => {
    expect(shouldPublishWebuiRunStatus(inbound("websocket", "chat-a", { webui: true }))).toBe(true);
    expect(shouldPublishWebuiRunStatus(inbound("websocket", "chat-a", { webui: true, webui_ephemeral_command: "status" }))).toBe(false);
    expect(shouldPublishWebuiRunStatus(inbound("websocket", "chat-a"))).toBe(false);
    expect(shouldPublishWebuiRunStatus(inbound("telegram", "chat-a", { webui: true }))).toBe(false);
  });

  it("publishes thread-scoped session updates only for real WebUI turns", async () => {
    const bus = new MessageBus();
    const msg = inbound("websocket", "chat-a", { webui: true, message_id: "m1" });

    expect(shouldPublishWebuiThreadSessionUpdated(msg)).toBe(true);
    expect(shouldPublishWebuiThreadSessionUpdated(inbound("websocket", "chat-a", { webui: true, webui_ephemeral_command: "status" }))).toBe(false);
    expect(shouldPublishWebuiThreadSessionUpdated(inbound("telegram", "chat-a", { webui: true }))).toBe(false);

    await publishWebuiThreadSessionUpdated(bus, msg);

    const outbound = await bus.nextOutbound();
    expect(outbound.chatId).toBe("chat-a");
    expect(outbound.content).toBe("");
    expect(outbound.metadata).toMatchObject({
      webui: true,
      message_id: "m1",
      sessionUpdated: true,
      sessionUpdateScope: "thread",
    });
  });

  it("finishes a WebUI turn with a turn_end anchor followed by idle cleanup", async () => {
    const bus = new MessageBus();
    const sessions = new SessionManager(sessionRoot());
    const msg = inbound("websocket", "chat-finish", { webui: true });
    websocketTurnWallStartTimes.set("chat-finish", 1780732800);

    await finishWebuiTurn({
      bus,
      msg,
      sessionKey: "websocket:chat-finish",
      sessions,
      latencyMs: 42.9,
    });

    const turnEnd = await bus.nextOutbound();
    const idle = await bus.nextOutbound();
    expect(turnEnd.metadata).toMatchObject({
      webui: true,
      turnEnd: true,
      latencyMs: 42,
      goalState: expect.any(Object),
    });
    expect(idle.metadata).toMatchObject({
      webui: true,
      goalStatusEvent: true,
      goalStatus: "idle",
    });
    expect(websocketTurnWallStartedAt("chat-finish")).toBeNull();
  });
});
