import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { AgentDefaults } from "../../../src/config/schema.js";
import { Session } from "../../../src/core/session/manager.js";

const DEFAULT_MAX_MESSAGES = 120;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-max-messages-"));
  roots.push(root);
  return root;
}

function makeLoop(maxMessages = DEFAULT_MAX_MESSAGES): AgentLoop {
  const provider = { getDefaultModel: () => "test-model", generation: { maxTokens: 4096 } };
  return new AgentLoop({
    bus: new MessageBus(),
    provider: provider as any,
    workspace: tmpRoot(),
    model: "test-model",
    maxMessages,
  });
}

function populatedSession(n: number): Session {
  const session = new Session({ key: "test:populated" });
  for (let i = 0; i < n; i += 1) {
    session.addMessage("user", `msg-${i}`);
    session.addMessage("assistant", `reply-${i}`);
  }
  return session;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop maxMessages configuration", () => {
  it("uses the builtin maxMessages limit by default", () => {
    const loop = makeLoop();

    expect(loop.maxMessages).toBe(DEFAULT_MAX_MESSAGES);
  });

  it("stores positive maxMessages values", () => {
    const loop = makeLoop(25);

    expect(loop.maxMessages).toBe(25);
  });

  it("normalizes zero maxMessages to the builtin limit", () => {
    const loop = makeLoop(0);

    expect(loop.maxMessages).toBe(DEFAULT_MAX_MESSAGES);
  });

  it("normalizes negative maxMessages to the builtin limit", () => {
    const loop = makeLoop(-5);

    expect(loop.maxMessages).toBe(DEFAULT_MAX_MESSAGES);
  });

  it("session history uses the builtin limit by default", () => {
    const session = populatedSession(80);
    const history = session.getHistory();

    expect(history.length).toBeLessThanOrEqual(DEFAULT_MAX_MESSAGES);
  });

  it("session history respects explicit maxMessages", () => {
    const session = populatedSession(40);
    const history = session.getHistory(20);

    expect(history.length).toBeLessThanOrEqual(20);
  });

  it("sliced session history starts at a user turn", () => {
    const session = populatedSession(30);
    const history = session.getHistory(25);

    expect(history[0].role).toBe("user");
  });

  it("session history treats zero maxMessages as the builtin limit", () => {
    const session = populatedSession(80);
    const history = session.getHistory(0);

    expect(history.length).toBeLessThanOrEqual(DEFAULT_MAX_MESSAGES);
  });

  it("small sessions are unaffected by larger maxMessages", () => {
    const session = populatedSession(5);
    const history = session.getHistory(25);

    expect(history).toHaveLength(10);
  });

  it("processMessage passes configured maxMessages to history replay", async () => {
    const loop = makeLoop(25);
    loop.consolidator.maybeConsolidateByTokens = vi.fn(async () => undefined) as any;
    loop.runner.run = vi.fn(async (spec: any) => ({
      finalContent: "ok",
      content: "ok",
      messages: [...spec.messages, { role: "assistant", content: "ok" }],
      toolCalls: [],
      usage: {},
      stopReason: "completed",
    })) as any;
    const session = loop.sessions.getOrCreate("cli:test");
    const historySpy = vi.spyOn(session, "getHistory");

    const result = await loop.processMessage(new InboundMessage({ channel: "cli", senderId: "user", chatId: "test", content: "hello" }));

    expect(result).not.toBeNull();
    expect(historySpy).toHaveBeenCalledOnce();
    expect(historySpy.mock.calls[0][0]).toMatchObject({ maxMessages: 25 });
  });

  it("processMessage passes the builtin limit when configured maxMessages is zero", async () => {
    const loop = makeLoop(0);
    loop.consolidator.maybeConsolidateByTokens = vi.fn(async () => undefined) as any;
    loop.runner.run = vi.fn(async (spec: any) => ({
      finalContent: "ok",
      content: "ok",
      messages: [...spec.messages, { role: "assistant", content: "ok" }],
      toolCalls: [],
      usage: {},
      stopReason: "completed",
    })) as any;
    const session = loop.sessions.getOrCreate("cli:test");
    const historySpy = vi.spyOn(session, "getHistory");

    const result = await loop.processMessage(new InboundMessage({ channel: "cli", senderId: "user", chatId: "test", content: "hello" }));

    expect(result).not.toBeNull();
    expect(historySpy.mock.calls[0][0]).toMatchObject({ maxMessages: DEFAULT_MAX_MESSAGES });
  });

  it("schema default uses the builtin maxMessages limit", () => {
    const defaults = new AgentDefaults();

    expect(defaults.maxMessages).toBe(DEFAULT_MAX_MESSAGES);
  });

  it("schema accepts zero as the builtin-limit sentinel", () => {
    const defaults = new AgentDefaults({ maxMessages: 0 });

    expect(defaults.maxMessages).toBe(0);
  });

  it("schema accepts positive maxMessages values", () => {
    const defaults = new AgentDefaults({ maxMessages: 25 });

    expect(defaults.maxMessages).toBe(25);
  });

  it("schema rejects negative maxMessages values", () => {
    expect(() => new AgentDefaults({ maxMessages: -1 })).toThrow();
  });
});
