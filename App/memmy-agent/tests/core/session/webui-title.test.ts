import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import { WebuiTitleService } from "../../../src/core/session/webui-title.js";
import { WEBUI_TITLE_METADATA_KEY, WEBUI_TITLE_USER_EDITED_METADATA_KEY } from "../../../src/core/session/webui-turns.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sessionRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-webui-title-"));
  roots.push(root);
  return root;
}

function createSession(sessions: SessionManager, chatId = "chat-1", content = "请帮我整理这个长问题的需求范围"): string {
  const sessionKey = `websocket:${chatId}`;
  const session = sessions.getOrCreate(sessionKey);
  session.metadata.webui = true;
  session.addMessage("user", content);
  sessions.save(session);
  return sessionKey;
}

function createService({
  sessions,
  provider = titleProvider("需求范围整理"),
  recorder = { recordAgentChatUsage: vi.fn(async () => true) },
}: {
  sessions: SessionManager;
  provider?: any;
  recorder?: any;
}): { bus: MessageBus; service: WebuiTitleService; scheduled: Promise<any>[]; provider: any; recorder: any } {
  const bus = new MessageBus();
  const scheduled: Promise<any>[] = [];
  const service = new WebuiTitleService({
    bus,
    sessions,
    llmRuntime: () => ({ provider, model: "openai/gpt-4.1-mini" } as any),
    scheduleBackground: (promise) => scheduled.push(promise),
    tokenUsageRecorder: recorder,
  });
  return { bus, service, scheduled, provider, recorder };
}

function titleProvider(title: string, usage: Record<string, unknown> = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }): any {
  return {
    spec: { name: "openai" },
    getDefaultModel: () => "openai/gpt-4.1-mini",
    chatWithRetry: vi.fn(async () => ({ content: title, usage })),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WebuiTitleService", () => {
  it("only records pending title context before the user message is persisted", () => {
    const sessions = new SessionManager(sessionRoot());
    const provider = titleProvider("不会立即调用");
    const { service, scheduled } = createService({ sessions, provider });

    service.trackUserMessage({
      chatId: "chat-1",
      content: "总结一下 React 状态管理方案",
      metadata: { webui: true },
    });

    expect(provider.chatWithRetry).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });

  it("generates metadata title after thread session update using only the first user message", async () => {
    const sessions = new SessionManager(sessionRoot());
    createSession(sessions, "chat-1", "请帮我拆解 UI 53 的标题生成改造");
    const session = sessions.getOrCreate("websocket:chat-1");
    session.addMessage("assistant", "这里是长回答，不应该进入标题提示词");
    sessions.save(session);
    const provider = titleProvider("UI 标题生成改造");
    const { bus, service, scheduled, recorder } = createService({ sessions, provider });

    service.trackUserMessage({ chatId: "chat-1", content: "请帮我拆解 UI 53 的标题生成改造", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-1");
    await scheduled[0];

    const saved = sessions.loadSession("websocket:chat-1");
    expect(saved?.metadata[WEBUI_TITLE_METADATA_KEY]).toBe("UI 标题生成改造");
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    const request = provider.chatWithRetry.mock.calls[0]?.[0];
    expect(request.messages[1].content).toContain("请帮我拆解 UI 53 的标题生成改造");
    expect(request.messages[1].content).not.toContain("这里是长回答");
    expect(recorder.recordAgentChatUsage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "chat-1",
      sessionKey: "websocket:chat-1",
      operation: "session_title",
      provider: "openai",
      modelId: "openai/gpt-4.1-mini",
    }));
    const outbound = await bus.nextOutbound();
    expect(outbound.metadata).toMatchObject({
      webui: true,
      sessionUpdated: true,
      sessionUpdateScope: "metadata",
    });
  });

  it("does not create a missing session or generate titles for non-WebUI sessions", async () => {
    const sessions = new SessionManager(sessionRoot());
    const provider = titleProvider("不应该生成");
    const { service, scheduled } = createService({ sessions, provider });

    service.trackUserMessage({ chatId: "missing", content: "hello", metadata: { webui: true } });
    service.onUserMessagePersisted("missing");
    await scheduled[0];

    expect(sessions.loadSession("websocket:missing")).toBeNull();
    expect(provider.chatWithRetry).not.toHaveBeenCalled();

    const session = sessions.getOrCreate("websocket:chat-2");
    session.addMessage("user", "普通 websocket 消息");
    sessions.save(session);
    service.trackUserMessage({ chatId: "chat-2", content: "普通 websocket 消息", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-2");
    await scheduled[1];

    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("skips command-only messages and sessions that already have user-owned titles", async () => {
    const sessions = new SessionManager(sessionRoot());
    createSession(sessions, "chat-command", "/status");
    const provider = titleProvider("不应该生成");
    const { service, scheduled } = createService({ sessions, provider });

    service.trackUserMessage({ chatId: "chat-command", content: "/status", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-command");
    expect(scheduled).toHaveLength(0);

    createSession(sessions, "chat-title", "帮我总结标题");
    const titled = sessions.getOrCreate("websocket:chat-title");
    titled.metadata[WEBUI_TITLE_METADATA_KEY] = "用户手动标题";
    titled.metadata[WEBUI_TITLE_USER_EDITED_METADATA_KEY] = true;
    sessions.save(titled);

    service.trackUserMessage({ chatId: "chat-title", content: "帮我总结标题", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-title");
    await scheduled[0];

    expect(provider.chatWithRetry).not.toHaveBeenCalled();
    expect(sessions.loadSession("websocket:chat-title")?.metadata[WEBUI_TITLE_METADATA_KEY]).toBe("用户手动标题");
  });

  it("does not treat later user messages as a historical title generation trigger", async () => {
    const sessions = new SessionManager(sessionRoot());
    createSession(sessions, "chat-later", "第一条消息没有生成标题");
    const session = sessions.getOrCreate("websocket:chat-later");
    session.addMessage("assistant", "第一轮回答");
    session.addMessage("user", "第二条消息");
    sessions.save(session);
    const provider = titleProvider("不应该生成");
    const { service, scheduled } = createService({ sessions, provider });

    service.trackUserMessage({ chatId: "chat-later", content: "第二条消息", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-later");
    await scheduled[0];

    expect(provider.chatWithRetry).not.toHaveBeenCalled();
    expect(sessions.loadSession("websocket:chat-later")?.metadata[WEBUI_TITLE_METADATA_KEY]).toBeUndefined();
  });

  it("does not overwrite a manual rename that happens while the model request is in flight", async () => {
    const sessions = new SessionManager(sessionRoot());
    createSession(sessions, "chat-race", "帮我起标题");
    const titleResponse = deferred<any>();
    const provider = {
      spec: { name: "openai" },
      getDefaultModel: () => "openai/gpt-4.1-mini",
      chatWithRetry: vi.fn(() => titleResponse.promise),
    };
    const { bus, service, scheduled } = createService({ sessions, provider });

    service.trackUserMessage({ chatId: "chat-race", content: "帮我起标题", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-race");
    sessions.renameSession("websocket:chat-race", "我的手动标题");
    titleResponse.resolve({ content: "模型标题", usage: { prompt_tokens: 1 } });
    await scheduled[0];

    expect(sessions.loadSession("websocket:chat-race")?.metadata[WEBUI_TITLE_METADATA_KEY]).toBe("我的手动标题");
    expect(bus.outbound.getNowait()).toBeUndefined();
  });

  it("prevents duplicate model calls while a title request for the same session is in flight", async () => {
    const sessions = new SessionManager(sessionRoot());
    createSession(sessions, "chat-flight", "帮我起标题");
    const titleResponse = deferred<any>();
    const provider = {
      spec: { name: "openai" },
      getDefaultModel: () => "openai/gpt-4.1-mini",
      chatWithRetry: vi.fn(() => titleResponse.promise),
    };
    const { service, scheduled } = createService({ sessions, provider });

    service.trackUserMessage({ chatId: "chat-flight", content: "帮我起标题", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-flight");
    service.trackUserMessage({ chatId: "chat-flight", content: "第二条消息", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-flight");

    expect(scheduled).toHaveLength(1);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    titleResponse.resolve({ content: "标题", usage: { prompt_tokens: 1 } });
    await scheduled[0];
  });

  it("records returned usage even when the generated title is rejected", async () => {
    const sessions = new SessionManager(sessionRoot());
    createSession(sessions, "chat-error", "帮我起标题");
    const provider = titleProvider("Error: quota", { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    const { bus, service, scheduled, recorder } = createService({ sessions, provider });

    service.trackUserMessage({ chatId: "chat-error", content: "帮我起标题", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-error");
    await scheduled[0];

    expect(recorder.recordAgentChatUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      operation: "session_title",
    }));
    expect(sessions.loadSession("websocket:chat-error")?.metadata[WEBUI_TITLE_METADATA_KEY]).toBeUndefined();
    expect(bus.outbound.getNowait()).toBeUndefined();
  });

  it("keeps title write and metadata update working when token usage recording fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessions = new SessionManager(sessionRoot());
    createSession(sessions, "chat-recorder", "帮我起标题");
    const recorder = { recordAgentChatUsage: vi.fn(async () => {
      throw new Error("usage backend down");
    }) };
    const { bus, service, scheduled } = createService({ sessions, recorder });

    service.trackUserMessage({ chatId: "chat-recorder", content: "帮我起标题", metadata: { webui: true } });
    service.onUserMessagePersisted("chat-recorder");
    await scheduled[0];
    await Promise.resolve();

    expect(sessions.loadSession("websocket:chat-recorder")?.metadata[WEBUI_TITLE_METADATA_KEY]).toBe("需求范围整理");
    expect((await bus.nextOutbound()).metadata.sessionUpdateScope).toBe("metadata");
    expect(consoleSpy).toHaveBeenCalled();
  });
});
