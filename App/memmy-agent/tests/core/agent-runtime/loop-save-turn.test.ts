import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { AgentLoop, TurnContext, TurnState } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../../src/core/runtime-messages/index.js";
import { LLMRuntime } from "../../../src/utils/llm-runtime.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";
import {
  TITLE_GENERATION_MAX_TOKENS,
  TITLE_GENERATION_REASONING_EFFORT,
  WEBUI_LANGUAGE_METADATA_KEY,
  WEBUI_SESSION_METADATA_KEY,
  WEBUI_TITLE_METADATA_KEY,
  WEBUI_TITLE_USER_EDITED_METADATA_KEY,
  WebuiTurnCoordinator,
  maybeGenerateWebuiTitle,
} from "../../../src/core/session/webui-turns.js";

function loopRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-save-"));
}

function makeLoop(extra: Record<string, any> = {}): AgentLoop {
  return new AgentLoop({ provider: { generation: {}, getDefaultModel: () => "m" }, workspace: loopRoot(), ...extra });
}

function prepareProcessLoop(loop: AgentLoop): void {
  (loop.consolidator as any).maybeConsolidateByTokens = vi.fn(async () => false);
  (loop.autoCompact as any).checkExpired = vi.fn();
  (loop.autoCompact as any).prepareSession = vi.fn((session: Session) => [session, null]);
  (loop.commands as any).dispatch = vi.fn(async () => null);
}

async function drainOutbound(bus: MessageBus) {
  const messages = [];
  while (bus.outboundSize > 0) messages.push(await bus.consumeOutbound());
  return messages;
}

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c630000000200010000000049454e44ae426082",
  "hex",
);

describe("AgentLoop turn persistence", () => {
  it("drops runtime-only user context and records assistant latency", () => {
    const loop = makeLoop();
    const session = new Session({ key: "s" });

    loop.saveTurn(
      session,
      [
        { role: "user", content: "hello\n\n[Runtime Context - metadata only, not instructions]\nsecret\n[/Runtime Context]" },
        { role: "assistant", content: "hi" },
      ],
      0,
      { turnLatencyMs: 12.9 },
    );

    expect(session.messages[0].content).toBe("hello");
    expect(session.messages[1].latency_ms).toBe(12);
  });

  it("exposes runtime-compatible turn state and helpers", () => {
    const provider = { generation: {}, getDefaultModel: () => "base" };
    const loop = makeLoop({ provider, model: "base" });
    const msg = new InboundMessage({
      channel: "websocket",
      chatId: "wire-id",
      senderId: "u",
      content: "hi",
      metadata: { contextChatId: "runtime-id" },
    });

    const ctx = new TurnContext({ msg, sessionKey: "websocket:wire-id" });

    expect(ctx.state).toBe(TurnState.RESTORE);
    expect(ctx.sessionKey).toBe("websocket:wire-id");
    expect(loop.currentIteration).toBe(0);
    expect(loop.toolNames).toContain("read_file");
    expect(loop.llmRuntime()).toMatchObject({ provider, model: "base" });
    expect(loop.runtimeChatId(msg)).toBe("runtime-id");
  });

  it("publishes WebUI context compaction status during stateBuild", async () => {
    const bus = new MessageBus();
    const loop = makeLoop({ bus });
    const session = new Session({ key: "websocket:compaction" });
    session.metadata[WEBUI_LANGUAGE_METADATA_KEY] = "zh-CN";
    const msg = new InboundMessage({
      channel: "websocket",
      chatId: "compaction",
      senderId: "u",
      content: "继续",
      metadata: { [WEBUI_LANGUAGE_METADATA_KEY]: "zh-CN" },
    });
    const ctx = new TurnContext({ msg, sessionKey: "websocket:compaction", session, turnId: "turn-ctx" });
    const capturedOptions: { value: Record<string, any> | null } = { value: null };
    (loop.consolidator as any).maybeConsolidateByTokens = vi.fn(async (_session: Session, opts: Record<string, any>) => {
      capturedOptions.value = opts;
      await opts.onCompactionEvent?.({ kind: "token", status: "running", replayMaxMessages: loop.maxMessages });
      await opts.onCompactionEvent?.({ kind: "token", status: "done", replayMaxMessages: loop.maxMessages, changed: true });
      return { kind: "token", replayMaxMessages: loop.maxMessages, changed: true, summary: "summary", error: null, started: true };
    });

    await loop.stateBuild(ctx);

    const compactionMessages = (await drainOutbound(bus)).filter((message) => message.metadata?.contextCompaction);
    if (!capturedOptions.value) throw new Error("expected WebUI compaction options to be captured");
    const webuiCompactionOptions = capturedOptions.value;
    expect(webuiCompactionOptions).toMatchObject({ replayMaxMessages: loop.maxMessages, notifyOnLockWait: true });
    expect(webuiCompactionOptions.onCompactionEvent).toEqual(expect.any(Function));
    expect(compactionMessages.map((message) => message.content)).toEqual(["会话压缩中", "压缩已完成"]);
    expect(compactionMessages.map((message) => message.chatId)).toEqual(["compaction", "compaction"]);
    expect(compactionMessages.map((message) => message.metadata.compactionId)).toEqual(["context-compaction:turn-ctx", "context-compaction:turn-ctx"]);
    expect(compactionMessages.map((message) => message.metadata.compactionStatus)).toEqual(["running", "done"]);
  });

  it("does not pass WebUI context compaction callbacks to CLI turns", async () => {
    const bus = new MessageBus();
    const loop = makeLoop({ bus });
    const session = new Session({ key: "cli:compaction" });
    const msg = new InboundMessage({
      channel: "cli",
      chatId: "compaction",
      senderId: "u",
      content: "continue",
    });
    const ctx = new TurnContext({ msg, sessionKey: "cli:compaction", session, turnId: "turn-cli" });
    let capturedOptions: Record<string, any> | null = null;
    (loop.consolidator as any).maybeConsolidateByTokens = vi.fn(async (_session: Session, opts: Record<string, any>) => {
      capturedOptions = opts;
      await opts.onCompactionEvent?.({ kind: "token", status: "running", replayMaxMessages: loop.maxMessages });
      return { kind: "token", replayMaxMessages: loop.maxMessages, changed: true, summary: "summary", error: null, started: true };
    });

    await loop.stateBuild(ctx);

    expect(capturedOptions).toEqual({ replayMaxMessages: loop.maxMessages });
    expect(bus.outboundSize).toBe(0);
  });

  it("keeps post-save background compaction silent", async () => {
    const bus = new MessageBus();
    const loop = makeLoop({ bus });
    const session = new Session({ key: "websocket:post-save-compaction" });
    const msg = new InboundMessage({
      channel: "websocket",
      chatId: "post-save-compaction",
      senderId: "u",
      content: "继续",
    });
    const ctx = new TurnContext({ msg, sessionKey: "websocket:post-save-compaction", session, turnId: "turn-post-save" });
    ctx.finalContent = "完成";
    let capturedOptions: Record<string, any> | null = null;
    (loop.consolidator as any).maybeConsolidateByTokens = vi.fn(async (_session: Session, opts: Record<string, any>) => {
      capturedOptions = opts;
      await opts.onCompactionEvent?.({ kind: "token", status: "running", replayMaxMessages: loop.maxMessages });
      return { kind: "token", replayMaxMessages: loop.maxMessages, changed: false, summary: null, error: null, started: false };
    });

    await loop.stateSave(ctx);

    expect(capturedOptions).toEqual({ replayMaxMessages: loop.maxMessages });
    expect(bus.outboundSize).toBe(0);
  });

  it("tags normal turn file-cap archives with the effective session key", async () => {
    const loop = makeLoop();
    const archived = [{ role: "tool", content: "/media/wonton.png" }];
    const session = new Session({ key: "websocket:file-cap" });
    session.enforceFileCap = vi.fn((onArchive) => onArchive?.(archived));
    const rawArchive = vi.spyOn(loop.context.memory, "rawArchive").mockImplementation(() => {});
    (loop.consolidator as any).maybeConsolidateByTokens = vi.fn(async () => false);
    const msg = new InboundMessage({ channel: "websocket", chatId: "file-cap", senderId: "u", content: "hello" });
    const ctx = new TurnContext({ msg, sessionKey: "websocket:file-cap", session });
    ctx.finalContent = "done";
    ctx.allMessages = [{ role: "assistant", content: "done" }];

    await loop.stateSave(ctx);

    expect(rawArchive).toHaveBeenCalledWith(archived, { sessionKey: "websocket:file-cap" });
  });

  it("tags system turn file-cap archives with the final override key", async () => {
    const loop = makeLoop();
    prepareProcessLoop(loop);
    const sessionKey = "slack:C123:1700.42";
    const session = loop.sessions.getOrCreate(sessionKey);
    const archived = [{ role: "tool", content: "/media/city.png" }];
    session.enforceFileCap = vi.fn((onArchive) => onArchive?.(archived));
    const rawArchive = vi.spyOn(loop.context.memory, "rawArchive").mockImplementation(() => {});
    (loop as any).runAgentLoop = vi.fn(async (initialMessages: Record<string, any>[], opts: Record<string, any>) => {
      expect(opts.sessionKey).toBe(sessionKey);
      return ["done", [], [...initialMessages, { role: "assistant", content: "done" }], "stop", false];
    });
    const msg = new InboundMessage({
      channel: "system",
      chatId: "slack:C123",
      senderId: "scheduler",
      content: "continue",
      sessionKeyOverride: sessionKey,
    });

    await loop.processSystemMessage(msg, sessionKey);

    expect(rawArchive).toHaveBeenCalledWith(archived, { sessionKey });
  });

  it("generates WebUI titles only for marked sessions", async () => {
    const loop = makeLoop({ provider: { generation: {}, getDefaultModel: () => "m", chatWithRetry: vi.fn(async () => ({ content: '"优化 WebUI 侧边栏。"', finish_reason: "stop" })) } });
    const session = loop.sessions.getOrCreate("websocket:title");
    session.metadata[WEBUI_SESSION_METADATA_KEY] = true;
    session.addMessage("user", "帮我优化一下 webui 的 sidebar");
    session.addMessage("assistant", "可以，我会先调整布局。");
    loop.sessions.save(session);

    await expect(maybeGenerateWebuiTitle({ sessions: loop.sessions, sessionKey: "websocket:title", provider: loop.provider, model: loop.model! })).resolves.toBe(true);

    expect(session.metadata[WEBUI_TITLE_METADATA_KEY]).toBe("优化 WebUI 侧边栏");
    expect((loop.provider as any).chatWithRetry).toHaveBeenCalledOnce();
    expect((loop.provider as any).chatWithRetry.mock.calls[0][0].maxTokens).toBe(TITLE_GENERATION_MAX_TOKENS);
    expect((loop.provider as any).chatWithRetry.mock.calls[0][0].reasoningEffort).toBe(TITLE_GENERATION_REASONING_EFFORT);
  });

  it("skips title generation for plain websocket sessions", async () => {
    const provider = { generation: {}, getDefaultModel: () => "m", chatWithRetry: vi.fn(async () => ({ content: "Plain websocket title" })) };
    const sessions = new SessionManager(loopRoot());
    const session = sessions.getOrCreate("websocket:plain");
    session.addMessage("user", "hello from a custom websocket client");
    sessions.save(session);

    await expect(maybeGenerateWebuiTitle({ sessions, sessionKey: "websocket:plain", provider, model: "m" })).resolves.toBe(false);

    expect(session.metadata[WEBUI_TITLE_METADATA_KEY]).toBeUndefined();
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("skips title generation when the WebUI title was edited by the user", async () => {
    const provider = { generation: {}, getDefaultModel: () => "m", chatWithRetry: vi.fn(async () => ({ content: "Edited title" })) };
    const sessions = new SessionManager(loopRoot());
    const session = sessions.getOrCreate("websocket:edited-title");
    session.metadata[WEBUI_SESSION_METADATA_KEY] = true;
    session.metadata[WEBUI_TITLE_USER_EDITED_METADATA_KEY] = true;
    session.addMessage("user", "please summarize this session");
    sessions.save(session);

    await expect(maybeGenerateWebuiTitle({ sessions, sessionKey: "websocket:edited-title", provider, model: "m" })).resolves.toBe(false);

    expect(session.metadata[WEBUI_TITLE_METADATA_KEY]).toBeUndefined();
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("ignores command-only sessions when generating WebUI titles", async () => {
    const provider = { generation: {}, getDefaultModel: () => "m", chatWithRetry: vi.fn(async () => ({ content: "Command title" })) };
    const sessions = new SessionManager(loopRoot());
    const session = sessions.getOrCreate("websocket:command");
    session.metadata[WEBUI_SESSION_METADATA_KEY] = true;
    session.addMessage("user", "/model deep", { commandMessage: true });
    session.addMessage("assistant", "Switched model preset", { commandMessage: true });
    sessions.save(session);

    await expect(maybeGenerateWebuiTitle({ sessions, sessionKey: "websocket:command", provider, model: "m" })).resolves.toBe(false);

    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("uses the captured LLM runtime for deferred WebUI title updates", async () => {
    const bus = new MessageBus();
    const sessions = new SessionManager(loopRoot());
    const scheduled: Promise<any>[] = [];
    const provider = { generation: {}, getDefaultModel: () => "m", chatWithRetry: vi.fn(async () => ({ content: "Captured Runtime" })) };
    const session = sessions.getOrCreate("websocket:captured");
    session.metadata[WEBUI_SESSION_METADATA_KEY] = true;
    session.addMessage("user", "make a title");
    sessions.save(session);
    const coordinator = new WebuiTurnCoordinator({ bus, sessions, scheduleBackground: (promise) => scheduled.push(promise) });
    const msg = new InboundMessage({ channel: "websocket", chatId: "captured", senderId: "u", content: "make a title", metadata: { webui: true } });

    coordinator.captureTitleContext("websocket:captured", msg, new LLMRuntime(provider as any, "turn-model"));
    await coordinator.handleTurnEnd(msg, { sessionKey: "websocket:captured", latencyMs: null });
    await Promise.all(scheduled);

    expect((provider.chatWithRetry as any).mock.calls[0][0].model).toBe("turn-model");
    expect(sessions.getOrCreate("websocket:captured").metadata[WEBUI_TITLE_METADATA_KEY]).toBe("Captured Runtime");
  });

  it("persists user messages early with media and MCP preset attachments", () => {
    const loop = makeLoop();
    const session = new Session({ key: "websocket:abc" });
    const msg = new InboundMessage({
      channel: "websocket",
      chatId: "abc",
      senderId: "u",
      content: "look",
      media: ["/tmp/a.png"],
      metadata: {
        mcp_presets: [{ name: "browserbase", display_name: "Browserbase" }],
      },
    });

    expect(loop.persistUserMessageEarly(msg, session)).toBe(true);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      role: "user",
      content: "look",
      media: ["/tmp/a.png"],
      mcp_presets: [{ name: "browserbase", display_name: "Browserbase" }],
    });
    expect(session.metadata.pendingUserTurn).toBe(true);
  });

  it("restores runtime checkpoints with pending tool-call errors and deduped overlap", () => {
    const loop = makeLoop();
    const session = new Session({ key: "s" });
    session.messages.push({ role: "assistant", content: "thinking", tool_calls: [{ id: "done", function: { name: "read_file" } }] });
    session.metadata.runtimeCheckpoint = {
      assistantMessage: { role: "assistant", content: "thinking", tool_calls: [{ id: "done", function: { name: "read_file" } }] },
      completedToolResults: [{ role: "tool", tool_call_id: "done", name: "read_file", content: "ok" }],
      pendingToolCalls: [{ id: "pending", function: { name: "web_fetch" } }],
    };
    session.metadata.pendingUserTurn = true;

    expect(loop.restoreRuntimeCheckpoint(session)).toBe(true);

    expect(session.messages.map((msg) => msg.role)).toEqual(["assistant", "tool", "tool"]);
    expect(session.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "pending",
      name: "web_fetch",
      content: "Error: Task interrupted before this tool finished.",
    });
    expect(session.metadata.runtimeCheckpoint).toBeUndefined();
    expect(session.metadata.pendingUserTurn).toBeUndefined();
  });

  it("skips multimodal runtime-only user messages", () => {
    const loop = makeLoop();
    const session = new Session({ key: "runtime-only" });
    const runtime = `${ContextBuilder.RUNTIME_CONTEXT_TAG}\nCurrent Time: now (UTC)`;

    loop.saveTurn(session, [{ role: "user", content: [{ type: "text", text: runtime }] }], 0);

    expect(session.messages).toEqual([]);
  });

  it("keeps image placeholders with media paths after runtime stripping", () => {
    const loop = makeLoop();
    const session = new Session({ key: "image-path" });
    const runtime = `${ContextBuilder.RUNTIME_CONTEXT_TAG}\nCurrent Time: now (UTC)`;

    loop.saveTurn(
      session,
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" }, meta: { path: "/media/feishu/photo.jpg" } }, { type: "text", text: runtime }] }],
      0,
    );

    expect(session.messages[0].content).toEqual([{ type: "text", text: "[image: /media/feishu/photo.jpg]" }]);
  });

  it("keeps generic image placeholders when image metadata is absent", () => {
    const loop = makeLoop();
    const session = new Session({ key: "image-no-meta" });

    loop.saveTurn(
      session,
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }, { type: "text", text: ContextBuilder.RUNTIME_CONTEXT_TAG }] }],
      0,
    );

    expect(session.messages[0].content).toEqual([{ type: "text", text: "[image]" }]);
  });

  it("strips runtime context suffixes from string user messages", () => {
    const loop = makeLoop();
    const session = new Session({ key: "suffix-strip" });
    const runtime = `${ContextBuilder.RUNTIME_CONTEXT_TAG}\nCurrent Time: now\n${ContextBuilder.RUNTIME_CONTEXT_END}`;

    loop.saveTurn(session, [{ role: "user", content: `hello world\n\n${runtime}` }], 0);

    expect(session.messages[0].content).toBe("hello world");
  });

  it("skips string user messages containing only runtime context", () => {
    const loop = makeLoop();
    const session = new Session({ key: "suffix-only" });

    loop.saveTurn(session, [{ role: "user", content: `${ContextBuilder.RUNTIME_CONTEXT_TAG}\nCurrent Time: now` }], 0);

    expect(session.messages).toEqual([]);
  });

  it("keeps tool results under the truncation limit unchanged", () => {
    const loop = makeLoop();
    const session = new Session({ key: "tool-result" });
    const content = "x".repeat(12_000);

    loop.saveTurn(session, [{ role: "tool", tool_call_id: "call_1", name: "read_file", content }], 0);

    expect(session.messages[0].content).toBe(content);
  });

  it("applies per-tool result limits when saving and reloading a session", () => {
    const loop = makeLoop({ maxToolResultChars: 16_000 });
    const session = new Session({ key: "tool-result-limits" });
    const execBoundary = "e".repeat(50_000);
    const execOver = "x".repeat(50_001);
    const readBoundary = "r".repeat(128_000);
    const readOver = "y".repeat(128_001);
    const fallbackOver = "f".repeat(16_001);

    loop.saveTurn(
      session,
      [
        { role: "tool", tool_call_id: "exec_boundary", name: "exec", content: execBoundary },
        { role: "tool", tool_call_id: "exec_over", name: "exec", content: execOver },
        { role: "tool", tool_call_id: "read_boundary", name: "read_file", content: readBoundary },
        { role: "tool", tool_call_id: "read_over", name: "read_file", content: readOver },
        { role: "tool", tool_call_id: "fallback_over", name: "list_dir", content: fallbackOver },
        { role: "tool", tool_call_id: "missing_name", content: fallbackOver },
      ],
      0,
    );
    loop.sessions.save(session);
    loop.sessions.invalidate(session.key);
    const reloaded = loop.sessions.getOrCreate(session.key);
    const byCallId = new Map(reloaded.messages.map((message) => [message.tool_call_id, message.content]));

    expect(byCallId.get("exec_boundary")).toBe(execBoundary);
    expect(byCallId.get("exec_over")).toBe(`${execOver.slice(0, 50_000)}\n... (truncated)`);
    expect(byCallId.get("read_boundary")).toBe(readBoundary);
    expect(byCallId.get("read_over")).toBe(`${readOver.slice(0, 128_000)}\n... (truncated)`);
    expect(byCallId.get("fallback_over")).toBe(`${fallbackOver.slice(0, 16_000)}\n... (truncated)`);
    expect(byCallId.get("missing_name")).toBe(`${fallbackOver.slice(0, 16_000)}\n... (truncated)`);
  });

  it("uses the read_file limit for structured text while preserving image placeholders", () => {
    const loop = makeLoop({ maxToolResultChars: 16_000 });
    const session = new Session({ key: "structured-tool-result" });
    const text = "r".repeat(128_001);

    loop.saveTurn(
      session,
      [{
        role: "tool",
        tool_call_id: "read_structured",
        name: "read_file",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" }, meta: { path: "/tmp/image.png" } },
          { type: "text", text },
        ],
      }],
      0,
    );

    expect(session.messages[0].content).toEqual([
      { type: "text", text: "[image: /tmp/image.png]" },
      { type: "text", text: `${text.slice(0, 128_000)}\n... (truncated)` },
    ]);
  });

  it("rehydrates runtime checkpoints with completed and pending tools", () => {
    const loop = makeLoop();
    const session = new Session({
      key: "checkpoint",
      metadata: {
        runtimeCheckpoint: {
          assistantMessage: { role: "assistant", content: "working", tool_calls: [{ id: "done", function: { name: "read_file" } }, { id: "pending", function: { name: "exec" } }] },
          completedToolResults: [{ role: "tool", tool_call_id: "done", name: "read_file", content: "ok" }],
          pendingToolCalls: [{ id: "pending", function: { name: "exec" } }],
        },
      },
    });

    expect(loop.restoreRuntimeCheckpoint(session)).toBe(true);

    expect(session.messages.map((msg) => msg.role)).toEqual(["assistant", "tool", "tool"]);
    expect(session.messages[2].content.toLowerCase()).toContain("interrupted before this tool finished");
  });

  it("dedupes overlapping runtime checkpoint tails", () => {
    const loop = makeLoop();
    const assistant = { role: "assistant", content: "working", tool_calls: [{ id: "done", function: { name: "read_file" } }, { id: "pending", function: { name: "exec" } }] };
    const completed = { role: "tool", tool_call_id: "done", name: "read_file", content: "ok" };
    const session = new Session({
      key: "checkpoint-overlap",
      messages: [assistant, completed],
      metadata: {
        runtimeCheckpoint: {
          assistantMessage: assistant,
          completedToolResults: [completed],
          pendingToolCalls: [{ id: "pending", function: { name: "exec" } }],
        },
      },
    });

    expect(loop.restoreRuntimeCheckpoint(session)).toBe(true);

    expect(session.messages).toHaveLength(3);
    expect(session.messages[2].tool_call_id).toBe("pending");
  });

  it("closes a pending user turn with an assistant interruption message", () => {
    const loop = makeLoop();
    const session = new Session({ key: "s" });
    session.messages.push({ role: "user", content: "hello" });
    session.metadata.pendingUserTurn = true;

    expect(loop.restorePendingUserTurn(session)).toBe(true);

    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Error: Task interrupted before a response was generated.",
    });
    expect(session.metadata.pendingUserTurn).toBeUndefined();
  });

  it("persists user messages before a turn completes", async () => {
    const loop = makeLoop();
    prepareProcessLoop(loop);
    (loop.runner as any).run = vi.fn(async () => { throw new Error("boom"); });

    await expect(loop.processMessage(new InboundMessage({ channel: "feishu", senderId: "u1", chatId: "c1", content: "persist me" }))).rejects.toThrow("boom");

    loop.sessions.invalidate("feishu:c1");
    const persisted = loop.sessions.getOrCreate("feishu:c1");
    expect(persisted.messages.map((msg) => msg.role)).toEqual(["user"]);
    expect(persisted.messages[0].content).toBe("persist me");
    expect(persisted.metadata.pendingUserTurn).toBe(true);
  });

  it("persists media paths on user turns", async () => {
    const root = loopRoot();
    const imgA = path.join(root, "a.png");
    const imgB = path.join(root, "b.png");
    fs.writeFileSync(imgA, PNG_1X1);
    fs.writeFileSync(imgB, PNG_1X1);
    const loop = makeLoop({ workspace: root });
    prepareProcessLoop(loop);
    (loop.runner as any).run = vi.fn(async () => { throw new Error("interrupt"); });

    await expect(loop.processMessage(new InboundMessage({ channel: "websocket", senderId: "u1", chatId: "media", content: "look", media: [imgA, imgB] }))).rejects.toThrow("interrupt");

    loop.sessions.invalidate("websocket:media");
    const persisted = loop.sessions.getOrCreate("websocket:media");
    expect(persisted.messages[0]).toMatchObject({ role: "user", content: "look", media: [imgA, imgB] });
  });

  it("persists media-only user turns", async () => {
    const root = loopRoot();
    const img = path.join(root, "only.png");
    fs.writeFileSync(img, PNG_1X1);
    const loop = makeLoop({ workspace: root });
    prepareProcessLoop(loop);
    (loop.runner as any).run = vi.fn(async () => { throw new Error("boom"); });

    await expect(loop.processMessage(new InboundMessage({ channel: "websocket", senderId: "u1", chatId: "image-only", content: "", media: [img] }))).rejects.toThrow("boom");

    const persisted = loop.sessions.getOrCreate("websocket:image-only");
    expect(persisted.messages[0]).toMatchObject({ role: "user", content: "", media: [img] });
  });

  it("does not duplicate early persisted user messages", async () => {
    const loop = makeLoop();
    prepareProcessLoop(loop);
    (loop.runner as any).run = vi.fn(async () => ({
      finalContent: "done",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }, { role: "assistant", content: "done" }],
      stopReason: "stop",
    }));

    const result = await loop.processMessage(new InboundMessage({ channel: "feishu", senderId: "u1", chatId: "c2", content: "hello" }));

    expect(result?.content).toBe("done");
    expect(loop.sessions.getOrCreate("feishu:c2").messages.map((msg) => ({ role: msg.role, content: msg.content }))).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("uses contextChatId for runtime prompt assembly", async () => {
    const loop = makeLoop();
    prepareProcessLoop(loop);
    (loop.context as any).buildMessages = vi.fn(() => [{ role: "system", content: "system" }, { role: "user", content: "runtime + hello" }]);
    (loop.runner as any).run = vi.fn(async () => ({
      finalContent: "done",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "runtime + hello" }, { role: "assistant", content: "done" }],
      stopReason: "stop",
    }));

    const result = await loop.processMessage(
      new InboundMessage({
        channel: "discord",
        senderId: "u1",
        chatId: "thread-777",
        content: "hello",
        metadata: { contextChatId: "parent-456" },
        sessionKeyOverride: "discord:parent-456:thread:thread-777",
      }),
    );

    expect(result?.chatId).toBe("thread-777");
    expect((loop.context.buildMessages as any).mock.calls[0][0].chatId).toBe("parent-456");
  });

  it("passes effective session key into spawn tool context", () => {
    const loop = makeLoop();
    const spawn = loop.tools.get("spawn") as any;

    loop.setToolContext("discord", "thread-777", null, {}, "discord:parent-456:thread:thread-777");

    expect(spawn.sessionKey).toBe("discord:parent-456:thread:thread-777");
    expect(spawn.originChannel).toBe("discord");
    expect(spawn.originChatId).toBe("thread-777");
  });

  it("closes pending user turns before appending new input", async () => {
    const loop = makeLoop();
    prepareProcessLoop(loop);
    const session = loop.sessions.getOrCreate("feishu:c3");
    session.addMessage("user", "old question");
    session.metadata.pendingUserTurn = true;
    loop.sessions.save(session);
    (loop.runner as any).run = vi.fn(async () => ({
      finalContent: "new answer",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "Error: Task interrupted before a response was generated." },
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ],
      stopReason: "stop",
    }));

    await loop.processMessage(new InboundMessage({ channel: "feishu", senderId: "u1", chatId: "c3", content: "new question" }));

    expect(loop.sessions.getOrCreate("feishu:c3").messages.map((msg) => ({ role: msg.role, content: msg.content }))).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "Error: Task interrupted before a response was generated." },
      { role: "user", content: "new question" },
      { role: "assistant", content: "new answer" },
    ]);
  });

  it("persists standalone subagent followups", () => {
    const loop = makeLoop();
    const session = new Session({ key: "cli:test" });

    expect(loop.persistSubagentFollowup(session, new InboundMessage({ channel: "system", senderId: "subagent", chatId: "cli:test", content: "subagent result", metadata: { subagentTaskId: "sub-1" } }))).toBe(true);

    expect(session.messages[0]).toMatchObject({ role: "assistant", content: "subagent result", injectedEvent: "subagentResult", subagentTaskId: "sub-1" });
  });

  it("dedupes subagent followups by task id", () => {
    const loop = makeLoop();
    const session = new Session({ key: "cli:dedupe" });
    const msg = new InboundMessage({ channel: "system", senderId: "subagent", chatId: "cli:dedupe", content: "subagent result", metadata: { subagentTaskId: "sub-1" } });

    expect(loop.persistSubagentFollowup(session, msg)).toBe(true);
    expect(loop.persistSubagentFollowup(session, msg)).toBe(false);
    expect(session.messages).toHaveLength(1);
  });

  it("skips empty subagent followups", () => {
    const loop = makeLoop();
    const session = new Session({ key: "cli:empty" });

    expect(loop.persistSubagentFollowup(session, new InboundMessage({ channel: "system", senderId: "subagent", chatId: "cli:empty", content: "", metadata: { subagentTaskId: "sub-empty" } }))).toBe(false);
    expect(session.messages).toEqual([]);
  });

  it("persists multiple subagent followups as standalone history", () => {
    const loop = makeLoop();
    const session = new Session({ key: "cli:multi" });

    for (let index = 0; index < 3; index += 1) {
      expect(
        loop.persistSubagentFollowup(
          session,
          new InboundMessage({
            channel: "system",
            senderId: "subagent",
            chatId: "cli:multi",
            content: `subagent result ${index}`,
            metadata: { subagentTaskId: `sub-${index}` },
          }),
        ),
      ).toBe(true);
    }

    expect(session.messages.filter((msg) => msg.injectedEvent === "subagentResult").map((msg) => msg.content)).toEqual([
      "subagent result 0",
      "subagent result 1",
      "subagent result 2",
    ]);
  });

  it("processes system subagent followups before prompt assembly", async () => {
    const loop = makeLoop();
    prepareProcessLoop(loop);
    const session = loop.sessions.getOrCreate("cli:test");
    session.addMessage("user", "question");
    session.addMessage("assistant", "working");
    loop.sessions.save(session);
    let seenMessages: Record<string, any>[] = [];
    (loop as any).runAgentLoop = vi.fn(async (initialMessages: Record<string, any>[], opts: Record<string, any>) => {
      seenMessages = initialMessages;
      expect(opts.channel).toBe("cli");
      expect(opts.chatId).toBe("test");
      expect(opts.sessionKey).toBe("cli:test");
      return ["done", [], [...initialMessages, { role: "assistant", content: "done" }], "stop", false];
    });

    const response = await loop.processMessage(new InboundMessage({
      channel: "system",
      senderId: "subagent",
      chatId: "cli:test",
      content: "subagent result",
      metadata: { subagentTaskId: "sub-1" },
    }));

    expect(response).toMatchObject({ channel: "cli", chatId: "test", content: "done" });
    const nonSystem = seenMessages.filter((message) => message.role !== "system");
    expect(nonSystem[0].content).toContain("question");
    expect(nonSystem[1].content).toContain("working");
    expect(nonSystem[2].content).toContain("subagent result");
    expect(nonSystem[2].content).toContain("Current Time:");

    loop.sessions.invalidate("cli:test");
    expect(loop.sessions.getOrCreate("cli:test").messages.map((message) => ({
      role: message.role,
      content: message.content,
      injectedEvent: message.injectedEvent,
      subagentTaskId: message.subagentTaskId,
    }))).toEqual([
      { role: "user", content: "question", injectedEvent: undefined, subagentTaskId: undefined },
      { role: "assistant", content: "working", injectedEvent: undefined, subagentTaskId: undefined },
      { role: "assistant", content: "subagent result", injectedEvent: "subagentResult", subagentTaskId: "sub-1" },
      { role: "assistant", content: "done", injectedEvent: undefined, subagentTaskId: undefined },
    ]);
  });

  it("routes system subagent followups back to Slack thread metadata", async () => {
    const loop = makeLoop();
    prepareProcessLoop(loop);
    (loop as any).runAgentLoop = vi.fn(async (initialMessages: Record<string, any>[], opts: Record<string, any>) => {
      expect(opts.channel).toBe("slack");
      expect(opts.chatId).toBe("C123");
      expect(opts.sessionKey).toBe("slack:C123:1700.42");
      return ["thread done", [], [...initialMessages, { role: "assistant", content: "thread done" }], "stop", false];
    });

    const response = await loop.processMessage(new InboundMessage({
      channel: "system",
      senderId: "subagent",
      chatId: "slack:C123",
      content: "subagent result",
      sessionKeyOverride: "slack:C123:1700.42",
      metadata: { subagentTaskId: "sub-2", originMessageId: "msg-123" },
    }));

    expect(response).toMatchObject({
      channel: "slack",
      chatId: "C123",
      content: "thread done",
      metadata: {
        slack: { thread_ts: "1700.42" },
        originMessageId: "msg-123",
      },
    });
    expect(loop.sessions.getOrCreate("slack:C123:1700.42").messages.some((message) => message.subagentTaskId === "sub-2")).toBe(true);
  });

  it("skips early persistence when a user turn has no text or media", () => {
    const loop = makeLoop();
    const session = new Session({ key: "empty-turn" });
    const msg = new InboundMessage({ channel: "websocket", senderId: "u", chatId: "empty-turn", content: "", media: [] });

    expect(loop.persistUserMessageEarly(msg, session)).toBe(false);
    expect(session.messages).toEqual([]);
    expect(session.metadata.pendingUserTurn).toBeUndefined();
  });

  it("passes Slack thread session keys and message ids into spawn context", () => {
    const loop = makeLoop();
    const spawn = loop.tools.get("spawn") as any;

    loop.setToolContext("slack", "C123", "msg-123", { slack: { thread_ts: "1700.42", channel_type: "channel" } }, "slack:C123:1700.42");

    expect(spawn.sessionKey).toBe("slack:C123:1700.42");
    expect(spawn.originMessageId).toBe("msg-123");
  });
});
