import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, UNIFIED_SESSION_KEY } from "../../../src/core/agent-runtime/loop.js";
import { Consolidator, MemoryStore } from "../../../src/core/agent-runtime/memory.js";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { cmdNew, cmdStop, registerBuiltinCommands } from "../../../src/command/builtin.js";
import { CommandContext, CommandRouter } from "../../../src/command/router.js";
import { AgentDefaults, Config } from "../../../src/config/schema.js";
import { saveConfig } from "../../../src/config/loader.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

const roots: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-unified-session-"));
  roots.push(dir);
  return dir;
}

function makeLoop(unifiedSession = false): AgentLoop {
  return new AgentLoop({
    bus: new MessageBus(),
    provider: {
      generation: { maxTokens: 100 },
      getDefaultModel: () => "test-model",
    },
    workspace: workspace(),
    unifiedSession,
  });
}

function makeMessage(channel = "telegram", chatId = "111", sessionKeyOverride: string | null = null): InboundMessage {
  return new InboundMessage({
    channel,
    chatId,
    senderId: "user1",
    content: "hello",
    sessionKeyOverride,
  });
}

function makeConsolidator(session: Session) {
  const store = new MemoryStore(workspace());
  const sessions = {
    getOrCreate: vi.fn(() => session),
    save: vi.fn(),
    invalidate: vi.fn(),
  };
  const provider = {
    generation: { maxTokens: 100 },
    chatWithRetry: vi.fn(async () => ({ content: "summary", finishReason: "stop" })),
  };
  const consolidator = new Consolidator({
    store,
    provider,
    model: "test-model",
    sessions,
    contextWindowTokens: 1000,
    maxCompletionTokens: 100,
    buildMessages: ({ history }: any) => history,
    getToolDefinitions: () => [],
  });
  return { consolidator, sessions };
}

function fakeCancelableTask(done = false) {
  return {
    done: vi.fn(() => done),
    cancel: vi.fn(() => true),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("unified session dispatch", () => {
  it("rewrites session keys to the unified default when enabled", async () => {
    const loop = makeLoop(true);
    const captured: string[] = [];
    loop.processMessageInternal = vi.fn(async (msg) => {
      captured.push(msg.sessionKey);
      return null;
    });

    await loop.dispatchMessage(makeMessage("telegram", "111"));

    expect(captured).toEqual([UNIFIED_SESSION_KEY]);
  });

  it("makes different channels share the same unified key", async () => {
    const loop = makeLoop(true);
    const captured: string[] = [];
    loop.processMessageInternal = vi.fn(async (msg) => {
      captured.push(msg.sessionKey);
      return null;
    });

    await loop.dispatchMessage(makeMessage("telegram", "111"));
    await loop.dispatchMessage(makeMessage("discord", "222"));
    await loop.dispatchMessage(makeMessage("cli", "direct"));

    expect(captured).toEqual([UNIFIED_SESSION_KEY, UNIFIED_SESSION_KEY, UNIFIED_SESSION_KEY]);
  });

  it("preserves original keys when unified sessions are disabled", async () => {
    const loop = makeLoop(false);
    const captured: string[] = [];
    loop.processMessageInternal = vi.fn(async (msg) => {
      captured.push(msg.sessionKey);
      return null;
    });

    await loop.dispatchMessage(makeMessage("telegram", "999"));

    expect(captured).toEqual(["telegram:999"]);
  });

  it("respects an existing session override in unified mode", async () => {
    const loop = makeLoop(true);
    const captured: string[] = [];
    loop.processMessageInternal = vi.fn(async (msg) => {
      captured.push(msg.sessionKey);
      return null;
    });

    await loop.dispatchMessage(makeMessage("telegram", "111", "telegram:thread:42"));

    expect(captured).toEqual(["telegram:thread:42"]);
  });

  it("defaults unified sessions to false on AgentLoop", () => {
    const loop = makeLoop();

    expect(loop.unifiedSession).toBe(false);
  });
});

describe("unified session config", () => {
  it("defaults AgentDefaults.unifiedSession to false", () => {
    expect(new AgentDefaults().unifiedSession).toBe(false);
  });

  it("allows AgentDefaults.unifiedSession to be enabled", () => {
    expect(new AgentDefaults({ unifiedSession: true }).unifiedSession).toBe(true);
  });

  it("serializes unifiedSession as camelCase for JSON", () => {
    const data = new Config().toObject();

    expect(data.agents.defaults).toHaveProperty("unifiedSession", false);
  });

  it("parses unifiedSession from camelCase config", () => {
    const config = Config.fromObject({ agents: { defaults: { unifiedSession: true } } });

    expect(config.agents.defaults.unifiedSession).toBe(true);
  });

  it("writes unifiedSession into onboard-style saved config", () => {
    const configPath = path.join(workspace(), "config.yaml");

    saveConfig(new Config(), configPath);

    const data = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(data.agents.defaults).toHaveProperty("unifiedSession", false);
  });
});

describe("unified session /new command", () => {
  it("does not register /new as a priority command", () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);

    expect(router.isPriority("/new")).toBe(false);
  });

  it("registers /new as an exact command", () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);

    expect(router.exactHandlers.has("/new")).toBe(true);
  });

  it("passes the current dispatch signal when resetting the session", async () => {
    const sessions = new SessionManager(workspace());
    sessions.getOrCreate(UNIFIED_SESSION_KEY);
    const signal = new AbortController().signal;
    const loop = {
      sessions,
      consolidator: { archive: vi.fn(async () => true) },
      cancelActiveTasks: vi.fn(async () => 0),
      scheduleBackground: vi.fn(),
    };
    const msg = new InboundMessage({
      channel: "telegram",
      senderId: "user1",
      chatId: "111",
      content: "/new",
      sessionKeyOverride: UNIFIED_SESSION_KEY,
    });

    await cmdNew(new CommandContext({ msg, session: null, key: UNIFIED_SESSION_KEY, raw: "/new", loop, abortSignal: signal }));

    expect(loop.cancelActiveTasks).toHaveBeenCalledWith(UNIFIED_SESSION_KEY, { excludeSignal: signal });
  });

  it("clears the shared unified session", async () => {
    const sessions = new SessionManager(workspace());
    const shared = sessions.getOrCreate(UNIFIED_SESSION_KEY);
    shared.addMessage("user", "hello from telegram");
    shared.addMessage("assistant", "hi there");
    sessions.save(shared);
    const scheduled: Promise<any>[] = [];
    const loop = {
      sessions,
      consolidator: { archive: vi.fn(async () => true) },
      cancelActiveTasks: vi.fn(async () => 0),
      scheduleBackground: (promise: Promise<any>) => scheduled.push(Promise.resolve(promise)),
    };
    const msg = new InboundMessage({
      channel: "telegram",
      senderId: "user1",
      chatId: "111",
      content: "/new",
      sessionKeyOverride: UNIFIED_SESSION_KEY,
    });

    const result = await cmdNew(new CommandContext({ msg, session: null, key: UNIFIED_SESSION_KEY, raw: "/new", loop }));
    await Promise.all(scheduled);
    sessions.invalidate(UNIFIED_SESSION_KEY);

    expect(result.content).toContain("New session started");
    expect(sessions.getOrCreate(UNIFIED_SESSION_KEY).messages).toEqual([]);
    expect(loop.consolidator.archive).toHaveBeenCalledTimes(1);
  });

  it("does not clear unrelated sessions in unified mode", async () => {
    const sessions = new SessionManager(workspace());
    const other = sessions.getOrCreate("discord:999");
    other.addMessage("user", "discord message");
    sessions.save(other);
    const shared = sessions.getOrCreate(UNIFIED_SESSION_KEY);
    shared.addMessage("user", "shared message");
    sessions.save(shared);
    const scheduled: Promise<any>[] = [];
    const loop = {
      sessions,
      consolidator: { archive: vi.fn(async () => true) },
      cancelActiveTasks: vi.fn(async () => 0),
      scheduleBackground: (promise: Promise<any>) => scheduled.push(Promise.resolve(promise)),
    };
    const msg = new InboundMessage({
      channel: "telegram",
      senderId: "user1",
      chatId: "111",
      content: "/new",
      sessionKeyOverride: UNIFIED_SESSION_KEY,
    });

    await cmdNew(new CommandContext({ msg, session: null, key: UNIFIED_SESSION_KEY, raw: "/new", loop }));
    await Promise.all(scheduled);
    sessions.invalidate(UNIFIED_SESSION_KEY);
    sessions.invalidate("discord:999");

    expect(sessions.getOrCreate(UNIFIED_SESSION_KEY).messages).toEqual([]);
    expect(sessions.getOrCreate("discord:999").messages).toHaveLength(1);
  });
});

describe("unified session consolidation", () => {
  it("skips an empty unified session without archiving", async () => {
    const session = new Session({ key: UNIFIED_SESSION_KEY });
    const { consolidator } = makeConsolidator(session);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("summary");

    await consolidator.maybeConsolidateByTokens(session);

    expect(archive).not.toHaveBeenCalled();
  });

  it("has identical empty-session consolidation behavior for any key", async () => {
    const archiveCalls: Record<string, number> = {};

    for (const key of ["telegram:123", UNIFIED_SESSION_KEY]) {
      const session = new Session({ key });
      const { consolidator } = makeConsolidator(session);
      const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("summary");
      await consolidator.maybeConsolidateByTokens(session);
      archiveCalls[key] = archive.mock.calls.length;
    }

    expect(archiveCalls["telegram:123"]).toBe(0);
    expect(archiveCalls[UNIFIED_SESSION_KEY]).toBe(0);
  });

  it("attempts token-budget consolidation for an over-budget unified key", async () => {
    const session = new Session({ key: UNIFIED_SESSION_KEY });
    session.messages = [{ role: "user", content: "msg" }];
    const { consolidator } = makeConsolidator(session);
    const estimate = vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([950, "test"]);
    const boundary = vi.spyOn(consolidator, "pickConsolidationBoundary").mockReturnValue(null);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("summary");

    await consolidator.maybeConsolidateByTokens(session);

    expect(estimate).toHaveBeenCalledWith(session);
    expect(boundary).toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });
});

describe("unified session /stop command", () => {
  it("stores active tasks under the effective unified key", () => {
    const loop = makeLoop(true);
    const msg = makeMessage("telegram", "123456");
    const task = fakeCancelableTask();
    const effectiveKey = loop.sessionKey(msg);

    loop.activeTasks.set(effectiveKey, [task]);

    expect(effectiveKey).toBe(UNIFIED_SESSION_KEY);
    expect(loop.activeTasks.has(UNIFIED_SESSION_KEY)).toBe(true);
    expect(loop.activeTasks.has("telegram:123456")).toBe(false);
  });

  it("finds and cancels a task in unified mode", async () => {
    const loop = makeLoop(true);
    const task = fakeCancelableTask();
    loop.activeTasks.set(UNIFIED_SESSION_KEY, [task]);
    const msg = new InboundMessage({
      channel: "telegram",
      chatId: "123456",
      senderId: "user1",
      content: "/stop",
      sessionKeyOverride: UNIFIED_SESSION_KEY,
    });

    const result = await cmdStop(new CommandContext({ msg, session: null, key: UNIFIED_SESSION_KEY, raw: "/stop", loop }));

    expect(task.cancel).toHaveBeenCalledTimes(1);
    expect(result.content).toContain("Stopped 1 task");
  });

  it("lets /stop from one channel cancel unified tasks from another channel", async () => {
    const loop = makeLoop(true);
    const task1 = fakeCancelableTask();
    const task2 = fakeCancelableTask();
    loop.activeTasks.set(UNIFIED_SESSION_KEY, [task1, task2]);
    const msg = new InboundMessage({
      channel: "discord",
      chatId: "789012",
      senderId: "user2",
      content: "/stop",
      sessionKeyOverride: UNIFIED_SESSION_KEY,
    });

    const result = await cmdStop(new CommandContext({ msg, session: null, key: UNIFIED_SESSION_KEY, raw: "/stop", loop }));

    expect(task1.cancel).toHaveBeenCalledTimes(1);
    expect(task2.cancel).toHaveBeenCalledTimes(1);
    expect(result.content).toContain("Stopped 2 task");
  });
});
