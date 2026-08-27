import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { buildHelpText, cmdRestart, setRestartCommandRuntimeForTests } from "../../../src/command/builtin.js";
import { CommandContext } from "../../../src/command/router.js";
import { Session } from "../../../src/core/session/manager.js";
import {
  DESKTOP_MANAGED_GATEWAY_ENV,
  RESTART_NOTIFY_CHANNEL_ENV,
  RESTART_NOTIFY_CHAT_ID_ENV,
  RESTART_STARTED_AT_ENV,
} from "../../../src/utils/restart.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-restart-command-"));
}

function provider(): any {
  return {
    getDefaultModel: () => "test-model",
    spec: { name: "openai" },
    generation: { maxTokens: 8192, temperature: 0.1 },
  };
}

function makeLoop(): [AgentLoop, MessageBus] {
  const bus = new MessageBus();
  const loop = new AgentLoop({ bus, provider: provider(), workspace: tempRoot(), model: "test-model" });
  return [loop, bus];
}

function stubStatusEstimate(
  loop: AgentLoop,
  estimate: [number, string] | Error,
): ReturnType<typeof vi.fn> {
  const estimateSessionPromptTokens = vi.fn(() => {
    if (estimate instanceof Error) throw estimate;
    return estimate;
  });
  loop.consolidator.withProviderSnapshot = vi.fn(() => ({
    estimateSessionPromptTokens,
  })) as any;
  return estimateSessionPromptTokens;
}

function stubRestartRuntime(runScheduled = false): {
  callbacks: Array<() => void>;
  scheduler: ReturnType<typeof vi.fn>;
  launcher: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
} {
  const callbacks: Array<() => void> = [];
  const unref = vi.fn();
  const scheduler = vi.fn((callback: () => void, delayMs: number) => {
    callbacks.push(callback);
    if (runScheduled) callback();
    return delayMs;
  });
  const launcher = vi.fn(() => ({ unref }));
  const exit = vi.fn();
  const warn = vi.fn();
  setRestartCommandRuntimeForTests({
    scheduler,
    launcher,
    exit,
    warn,
    execPath: "/usr/bin/node",
    argv: ["/usr/bin/node", "/app/dist/main.js", "agent", "--config", "config.yaml"],
    cwd: "/workspace",
    env: { MEMMY_TEST: "1" },
  });
  return { callbacks, scheduler, launcher, exit, warn, unref };
}

async function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve, reject) => {
      void resolve;
      return setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]);
}

describe("/restart command", () => {
  afterEach(() => {
    vi.useRealTimers();
    setRestartCommandRuntimeForTests(null);
    delete process.env[RESTART_NOTIFY_CHANNEL_ENV];
    delete process.env[RESTART_NOTIFY_CHAT_ID_ENV];
    delete process.env[RESTART_STARTED_AT_ENV];
    delete process.env[DESKTOP_MANAGED_GATEWAY_ENV];
  });

  it("sets restart notification env vars and schedules process restart", async () => {
    delete process.env[RESTART_NOTIFY_CHANNEL_ENV];
    delete process.env[RESTART_NOTIFY_CHAT_ID_ENV];
    delete process.env[RESTART_STARTED_AT_ENV];
    const restart = stubRestartRuntime();
    const msg = new InboundMessage({ channel: "cli", senderId: "user", chatId: "direct", content: "/restart" });
    const ctx = new CommandContext({ msg, session: null, key: msg.sessionKey, raw: "/restart", loop: {} });

    const out = await cmdRestart(ctx);

    expect(out.content).toContain("Restarting");
    expect(process.env[RESTART_NOTIFY_CHANNEL_ENV]).toBe("cli");
    expect(process.env[RESTART_NOTIFY_CHAT_ID_ENV]).toBe("direct");
    expect(process.env[RESTART_STARTED_AT_ENV]).toBeTruthy();
    expect(restart.scheduler).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(restart.callbacks).toHaveLength(1);

    restart.callbacks[0]();

    expect(restart.launcher).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/app/dist/main.js", "agent", "--config", "config.yaml"],
      {
        cwd: "/workspace",
        env: { MEMMY_TEST: "1" },
        stdio: "inherit",
        detached: true,
      },
    );
    expect(restart.unref).toHaveBeenCalledTimes(1);
    expect(restart.exit).toHaveBeenCalledWith(0);
  });

  it("still replies when restart scheduling fails", async () => {
    const warn = vi.fn();
    setRestartCommandRuntimeForTests({
      scheduler: () => {
        throw new Error("scheduler failed");
      },
      warn,
    });
    const msg = new InboundMessage({ channel: "cli", senderId: "user", chatId: "direct", content: "/restart" });
    const ctx = new CommandContext({ msg, session: null, key: msg.sessionKey, raw: "/restart", loop: {} });

    const out = await cmdRestart(ctx);

    expect(out.content).toContain("Restarting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("scheduler failed"));
  });

  it("hands managed Desktop restart ownership to IPC and exits with code 75 only after acknowledgement", async () => {
    const callbacks: Array<() => void> = [];
    const scheduler = vi.fn((callback: () => void, delayMs: number) => {
      callbacks.push(callback);
      return delayMs;
    });
    const exit = vi.fn();
    const sendIpc = vi.fn((message, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    });
    setRestartCommandRuntimeForTests({
      env: { [DESKTOP_MANAGED_GATEWAY_ENV]: "1" },
      scheduler,
      exit,
      sendIpc
    });
    const msg = new InboundMessage({
      channel: "websocket",
      senderId: "user",
      chatId: "chat-1",
      content: "/restart",
      metadata: { webui: true }
    });
    const ctx = new CommandContext({ msg, session: null, key: msg.sessionKey, raw: "/restart", loop: {} });

    const out = await cmdRestart(ctx);

    expect(out.content).toContain("Restarting");
    expect(sendIpc).toHaveBeenCalledWith(expect.objectContaining({
      type: "memmy-agent:restart",
      channel: "websocket",
      chatId: "chat-1",
      metadata: { webui: true }
    }), expect.any(Function));
    expect(scheduler).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(exit).not.toHaveBeenCalled();
    callbacks[0]?.();
    expect(exit).toHaveBeenCalledWith(75);
    expect(process.env[RESTART_NOTIFY_CHANNEL_ENV]).toBeUndefined();
  });

  it("does not exit a managed gateway when Desktop IPC fails or times out", async () => {
    vi.useFakeTimers();
    const scheduler = vi.fn();
    const exit = vi.fn();
    setRestartCommandRuntimeForTests({
      env: { [DESKTOP_MANAGED_GATEWAY_ENV]: "1" },
      scheduler,
      exit,
      sendIpc: vi.fn((_message, callback) => {
        callback(new Error("IPC closed"));
        return false;
      })
    });
    const msg = new InboundMessage({ channel: "websocket", senderId: "user", chatId: "chat-1", content: "/restart" });
    const ctx = new CommandContext({ msg, session: null, key: msg.sessionKey, raw: "/restart", loop: {} });

    await expect(cmdRestart(ctx)).resolves.toMatchObject({ content: expect.stringContaining("Failed to restart") });
    expect(scheduler).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    setRestartCommandRuntimeForTests({
      env: { [DESKTOP_MANAGED_GATEWAY_ENV]: "1" },
      scheduler,
      exit,
      sendIpc: vi.fn(() => true)
    });
    const timedOut = cmdRestart(ctx);
    await vi.advanceTimersByTimeAsync(500);
    await expect(timedOut).resolves.toMatchObject({ content: expect.stringContaining("Failed to restart") });
    expect(scheduler).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("help includes restart and status", () => {
    const help = buildHelpText();

    expect(help).toContain("/restart");
    expect(help).toContain("/status");
  });

  it("handles restart at the run-loop priority layer", async () => {
    const [loop, bus] = makeLoop();
    stubRestartRuntime();
    const dispatch = vi.spyOn(loop as any, "dispatchMessage");
    await bus.publishInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/restart" }));

    const runTask = loop.run();
    const out = await withTimeout(bus.consumeOutbound());
    loop.stop();
    await runTask;

    expect(dispatch).not.toHaveBeenCalled();
    expect(out.content).toContain("Restarting");
  });

  it("handles status at the run-loop priority layer", async () => {
    const [loop, bus] = makeLoop();
    const dispatch = vi.spyOn(loop as any, "dispatchMessage");
    await bus.publishInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/status" }));

    const runTask = loop.run();
    const out = await withTimeout(bus.consumeOutbound());
    loop.stop();
    await runTask;

    expect(dispatch).not.toHaveBeenCalled();
    expect(out.content).toMatch(/memmy|Model/);
  });

  it("run exits when externally stopped while waiting for inbound messages", async () => {
    const [loop] = makeLoop();
    const runTask = loop.run();

    loop.stop();
    await runTask;

    expect((loop as any).running).toBe(false);
  });

  it("status reports the session model, run usage, context, conversation and Agent uptime", async () => {
    const [loop] = makeLoop();
    const session = new Session({ key: "telegram:c1" });
    session.messages = [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }];
    loop.sessions.getOrCreate = vi.fn(() => session) as any;
    loop.startTime = Date.now() / 1000 - 125;
    loop.lastUsageBySession.set("telegram:c1", { prompt_tokens: 0, completion_tokens: 0 });
    stubStatusEstimate(loop, [20_500, "test"]);

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/status" }));

    expect(response?.content).toContain("Model: openai / test-model");
    expect(response?.content).toContain("Last run tokens: 0 in / 0 out");
    expect(response?.content).toContain("Context: ~20k / 200k");
    expect(response?.content).toContain("Conversation: 3 user turns");
    expect(response?.content).toContain("Agent uptime: 2m 5s");
    expect(response?.content).not.toContain("Tasks:");
    expect(response?.metadata).toEqual({ renderAs: "text" });
  });

  it("status counts retained user turns beyond the default history window", async () => {
    const [loop] = makeLoop();
    const session = new Session({ key: "telegram:c1" });
    session.messages = [...Array(131).keys()].map((i) => ({ role: "user", content: `message ${i}` }));
    loop.sessions.getOrCreate = vi.fn(() => session) as any;
    stubStatusEstimate(loop, [1000, "test"]);

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/status" }));

    expect(response?.content).toContain("Conversation: 131 user turns");
  });

  it("status does not query or display dispatch and subagent tasks", async () => {
    const [loop] = makeLoop();
    const session = new Session({ key: "telegram:c1" });
    session.getHistory = vi.fn(() => [{ role: "user" }]) as any;
    loop.sessions.getOrCreate = vi.fn(() => session) as any;
    stubStatusEstimate(loop, [1000, "test"]);
    loop.subagents.getRunningCountBySession = vi.fn(() => 2) as any;
    loop.activeTasks.set("telegram:c1", [{ done: () => false }, { done: () => true }] as any);

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/status" }));

    expect(response?.content).not.toMatch(/Tasks:|Goal:|Queue:|Subagent/i);
    expect(loop.subagents.getRunningCountBySession).not.toHaveBeenCalled();
  });

  it("resets usage counters when the runner omits usage", async () => {
    const [loop] = makeLoop();
    loop.runner.run = vi
      .fn()
      .mockResolvedValueOnce({ finalContent: "first", messages: [], usage: { prompt_tokens: 9, completion_tokens: 4 } })
      .mockResolvedValueOnce({ finalContent: "second", messages: [], usage: {} }) as any;

    await loop.runAgentLoop([], { sessionKey: "telegram:c1" });
    expect(loop.lastUsageBySession.get("telegram:c1")).toMatchObject({ prompt_tokens: 9, completion_tokens: 4 });

    await loop.runAgentLoop([], { sessionKey: "telegram:c1" });
    expect(loop.lastUsageBySession.has("telegram:c1")).toBe(false);
  });

  it("status does not substitute last usage when context estimation fails", async () => {
    const [loop] = makeLoop();
    const session = new Session({ key: "telegram:c1" });
    session.getHistory = vi.fn(() => [{ role: "user" }]) as any;
    loop.sessions.getOrCreate = vi.fn(() => session) as any;
    loop.lastUsageBySession.set("telegram:c1", { prompt_tokens: 1200, completion_tokens: 34 });
    loop.lastUsageBySession.set("telegram:other", { prompt_tokens: 9999, completion_tokens: 888 });
    stubStatusEstimate(loop, new Error("estimate failed"));

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/status" }));

    expect(response?.content).toContain("Last run tokens: 1200 in / 34 out");
    expect(response?.content).not.toContain("9999 in / 888 out");
    expect(response?.content).toContain("Context: error (token estimation failed)");
    expect(response?.content).not.toContain("Context: ~1k");
  });

  it("history shows recent user and assistant messages", async () => {
    const [loop] = makeLoop();
    const session = loop.sessions.getOrCreate("telegram:c1");
    session.messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "tool", content: "tool result" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "I am doing well." },
    ];

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/history" }));

    expect(response?.content).toContain("👤 You: Hello");
    expect(response?.content).toContain("🤖 Bot: Hi there!");
    expect(response?.content).not.toContain("tool result");
    expect(response?.metadata).toEqual({ renderAs: "text" });
  });

  it("history respects the count argument", async () => {
    const [loop] = makeLoop();
    const session = loop.sessions.getOrCreate("telegram:c1");
    session.messages = [...Array(20).keys()].map((i) => ({ role: "user", content: `message ${i}` }));

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/history 3" }));

    expect(response?.content).toContain("Last 3 message(s)");
    expect(response?.content).toContain("message 19");
    expect(response?.content).not.toContain("message 0");
  });

  it("history clamps negative count arguments to one message", async () => {
    const [loop] = makeLoop();
    const session = loop.sessions.getOrCreate("telegram:c1");
    session.messages = [
      { role: "user", content: "older message" },
      { role: "user", content: "newer message" },
    ];

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/history -5" }));

    expect(response?.content).toContain("Last 1 message(s)");
    expect(response?.content).toContain("newer message");
    expect(response?.content).not.toContain("older message");
  });

  it("history clamps count and extracts text blocks", async () => {
    const [loop] = makeLoop();
    const session = loop.sessions.getOrCreate("telegram:c1");
    session.messages = [
      { role: "user", content: [{ type: "text", text: "visible text" }, { type: "image_url", image_url: { url: "data:image/png;base64,..." } }] },
      ...[...Array(60).keys()].map((i) => ({ role: "assistant", content: `reply ${i}` })),
    ];

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/history 999" }));

    expect(response?.content).toContain("Last 50 message(s)");
    expect(response?.content).not.toContain("visible text");
    expect(response?.content).toContain("reply 59");
    expect(response?.content).not.toContain("reply 9");
  });

  it("history uses the default session window before selecting visible messages", async () => {
    const [loop] = makeLoop();
    const session = loop.sessions.getOrCreate("telegram:c1");
    session.messages = [
      ...[...Array(60).keys()].map((i) => ({ role: "user", content: `old visible ${i}` })),
      ...[...Array(130).keys()].map((i) => ({ role: "system", content: `hidden filler ${i}` })),
    ];

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/history 50" }));

    expect(response?.content).toContain("No conversation history yet.");
    expect(response?.content).not.toContain("old visible");
  });

  it("history rejects invalid counts", async () => {
    const [loop] = makeLoop();

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/history nope" }));

    expect(response?.content).toMatch(/^Usage: \/history \[count]/);
  });

  it("history reports empty sessions", async () => {
    const [loop] = makeLoop();

    const response = await loop.processMessage(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "/history" }));

    expect(response?.content).toContain("No conversation history yet.");
  });

  it("processDirect preserves render metadata for direct status commands", async () => {
    const [loop] = makeLoop();

    const response = await loop.processDirect("/status", { sessionKey: "cli:test" });

    expect(response?.metadata).toEqual({ renderAs: "text" });
  });
});
