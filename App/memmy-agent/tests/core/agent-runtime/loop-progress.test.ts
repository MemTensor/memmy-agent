import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { AgentProgressHook } from "../../../src/core/agent-runtime/progress-hook.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { buildToolEventFinishPayloads, buildToolEventStartPayload, invokeFileEditProgress, onProgressAcceptsFileEditEvents, withProgressCapabilities } from "../../../src/utils/progress-events.js";
import { formatToolHints } from "../../../src/utils/tool-hints.js";

const WINDOWS_COMMAND_ERROR = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-progress-"));
  roots.push(root);
  return root;
}

function makeLoop(root = tempRoot()): AgentLoop {
  const provider = {
    generation: { maxTokens: 100 },
    getDefaultModel: () => "test-model",
  };
  return new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
    provider,
    workspace: root,
    model: "test-model",
    sessionDir: path.join(root, "sessions"),
    maxIterations: 5,
  });
}

async function drain(bus: MessageBus): Promise<any[]> {
  const messages: any[] = [];
  while (bus.outboundSize > 0) messages.push(await bus.consumeOutbound());
  return messages;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("progress events and tool hints", () => {
  it("formats concise tool hints and collapses adjacent duplicates", () => {
    const hint = formatToolHints(
      [
        { name: "read_file", arguments: { path: "/Users/example/project/src/very/long/file.ts" } },
        { name: "read_file", arguments: { path: "/Users/example/project/src/very/long/file.ts" } },
        { name: "grep", arguments: { pattern: "needle" } },
        {
          name: "exec",
          arguments: { command: "node /Users/example/project/scripts/build.js --flag" },
        },
      ],
      32,
    );
    expect(hint).toContain("read");
    expect(hint).toContain("× 2");
    expect(hint).toContain('grep "needle"');
    expect(hint).toContain("$ node");
  });

  it("builds start and finish payloads including errors and artifacts", () => {
    const call = { id: "call-1", name: "write_file", arguments: { path: "a.txt" } };
    expect(buildToolEventStartPayload(call)).toMatchObject({
      version: 1,
      phase: "start",
      call_id: "call-1",
      name: "write_file",
      result: null,
    });

    const finish = buildToolEventFinishPayloads(
      new AgentHookContext({
        toolCalls: [call, { id: "call-2", name: "exec", arguments: {} }],
        toolResults: [{ files: ["a.txt"], embeds: ["preview"] }, "Error: failed"],
        toolEvents: [{ status: "ok" }, { status: "error", detail: "failed" }],
      }),
    );
    expect(finish[0]).toMatchObject({ phase: "end", files: ["a.txt"], embeds: ["preview"] });
    expect(finish[1]).toMatchObject({ phase: "error", error: "Error: failed" });
  });

  it("preserves decoded Windows errors in error tool events", () => {
    const [finish] = buildToolEventFinishPayloads(
      new AgentHookContext({
        toolCalls: [{ id: "call-windows", name: "exec", arguments: { command: "node" } }],
        toolResults: [WINDOWS_COMMAND_ERROR],
        toolEvents: [{ status: "error", detail: WINDOWS_COMMAND_ERROR }],
      }),
    );

    expect(finish).toMatchObject({ phase: "error", call_id: "call-windows", name: "exec" });
    expect(finish.error).toBe(WINDOWS_COMMAND_ERROR);
  });

  it("invokes file edit progress only when structured options are accepted", async () => {
    const calls: any[] = [];
    await invokeFileEditProgress(
      withProgressCapabilities(
        async (content, opts) => {
          calls.push([content, opts]);
        },
        { fileEditEvents: true },
      ),
      [{ path: "a.txt", status: "ok" }],
    );
    expect(calls[0][1].fileEditEvents).toEqual([{ path: "a.txt", status: "ok" }]);
  });
});

describe("AgentProgressHook", () => {
  it("emits start/end tool events, refreshes tool context, and strips final thinking", async () => {
    const progress: any[] = [];
    const setToolContext = vi.fn();
    const hook = new AgentProgressHook(
      withProgressCapabilities(
        async (content, opts) => {
          progress.push([content, opts]);
        },
        { toolEvents: true, reasoning: true },
      ),
      null,
      null,
      {
        channel: "websocket",
        chatId: "chat-1",
        messageId: "m1",
        sessionKey: "websocket:chat-1",
        setToolContext,
      },
    );
    const call = { id: "c1", name: "read_file", arguments: { path: "src/index.ts" } };
    await hook.beforeExecuteTools(new AgentHookContext({ toolCalls: [call] }));
    expect(progress.at(-1)[0]).toContain("read");
    expect(progress.at(-1)[1].toolEvents[0]).toMatchObject({ phase: "start", name: "read_file" });
    expect(setToolContext).toHaveBeenCalledWith("websocket", "chat-1", "m1", {}, "websocket:chat-1");

    await hook.afterIteration(
      new AgentHookContext({
        toolCalls: [call],
        toolResults: ["ok"],
        toolEvents: [{ name: "read_file", status: "ok", detail: "ok" }],
      }),
    );
    expect(progress.at(-1)[1].toolEvents[0]).toMatchObject({ phase: "end", result: "ok" });
    expect(hook.finalizeContent(new AgentHookContext(), "<think>hidden</think>Visible")).toBe("Visible");
  });

  it("streams only non-thinking incremental text and closes reasoning segments", async () => {
    const deltas: string[] = [];
    const progress: any[] = [];
    const hook = new AgentProgressHook(
      withProgressCapabilities(
        async (content, opts) => {
          progress.push([content, opts]);
        },
        { reasoning: true },
      ),
      async (delta) => {
        deltas.push(delta);
      },
    );
    await hook.emitReasoning("thinking");
    await hook.onStream(new AgentHookContext(), "<think>hidden</think>Hello");
    await hook.onStreamEnd(new AgentHookContext(), { resuming: false });
    expect(deltas).toEqual(["Hello"]);
    expect(progress.some(([, opts]) => opts?.reasoningEnd)).toBe(true);
  });
});

describe("AgentLoop progress integration", () => {
  it("emits start and finish tool events through runAgentLoop", async () => {
    const loop = makeLoop();
    const toolCall = new ToolCallRequest({
      id: "call1",
      name: "custom_tool",
      arguments: { path: "foo.txt" },
    });
    const responses = [new LLMResponse({ content: "Visible", toolCalls: [toolCall] }), new LLMResponse({ content: "Done", toolCalls: [] })];
    (loop.provider as any).chatWithRetry = vi.fn(async () => responses.shift());
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.tools.prepareCall = vi.fn(() => [null, { path: "foo.txt" }, null] as any);
    loop.tools.execute = vi.fn(async () => "ok");

    const progress: any[] = [];
    const [finalContent] = await loop.runAgentLoop([], {
      onProgress: withProgressCapabilities(
        async (content: string, opts?: Record<string, any>) => {
          progress.push([content, opts]);
        },
        { toolEvents: true },
      ),
    });

    expect(finalContent).toBe("Done");
    expect(progress[0]).toEqual(["Visible", undefined]);
    expect(progress[1][0]).toBe('custom_tool("foo.txt")');
    expect(progress[1][1].toolEvents[0]).toMatchObject({
      version: 1,
      phase: "start",
      call_id: "call1",
      name: "custom_tool",
      arguments: { path: "foo.txt" },
      result: null,
    });
    expect(progress.at(-1)[1].toolEvents[0]).toMatchObject({
      phase: "end",
      call_id: "call1",
      result: "ok",
    });
  });

  it("emits file edit progress around write_file execution", async () => {
    const root = tempRoot();
    const loop = makeLoop(root);
    const target = path.join(root, "foo.txt");
    fs.writeFileSync(target, "old\n", "utf8");
    const toolCall = new ToolCallRequest({
      id: "call-write",
      name: "write_file",
      arguments: { path: "foo.txt", content: "new\nextra\n" },
    });
    const responses = [new LLMResponse({ content: "", toolCalls: [toolCall] }), new LLMResponse({ content: "Done", toolCalls: [] })];
    (loop.provider as any).chatWithRetry = vi.fn(async () => responses.shift());
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.tools.prepareCall = vi.fn(() => [null, { path: "foo.txt", content: "new\nextra\n" }, null] as any);
    loop.tools.execute = vi.fn(async (name: string, params: any) => {
      fs.writeFileSync(target, params.content, "utf8");
      return "ok";
    });
    const fileEvents: any[] = [];

    const [finalContent] = await loop.runAgentLoop([], {
      onProgress: withProgressCapabilities(
        async (content: string, opts?: Record<string, any>) => {
          if (opts?.fileEditEvents) fileEvents.push(...opts.fileEditEvents);
        },
        { fileEditEvents: true },
      ),
    });

    expect(finalContent).toBe("Done");
    expect(fileEvents.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(fileEvents[0]).toMatchObject({
      version: 1,
      call_id: "call-write",
      tool: "write_file",
      path: "foo.txt",
      absolute_path: path.resolve(target),
      phase: "start",
      added: 2,
      deleted: 1,
      approximate: true,
      status: "editing",
    });
    expect(fileEvents[1]).toMatchObject({
      phase: "end",
      status: "done",
      added: 2,
      deleted: 1,
      approximate: false,
    });
  });

  it("skips file edit snapshots when progress cannot carry file edit events", async () => {
    const root = tempRoot();
    const loop = makeLoop(root);
    const target = path.join(root, "foo.txt");
    fs.writeFileSync(target, "old\n", "utf8");
    const toolCall = new ToolCallRequest({
      id: "call-write",
      name: "write_file",
      arguments: { path: "foo.txt", content: "new\n" },
    });
    const responses = [new LLMResponse({ content: "", toolCalls: [toolCall] }), new LLMResponse({ content: "Done", toolCalls: [] })];
    (loop.provider as any).chatWithRetry = vi.fn(async () => responses.shift());
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.tools.prepareCall = vi.fn(() => [null, { path: "foo.txt", content: "new\n" }, null] as any);
    loop.tools.execute = vi.fn(async (name: string, params: any) => {
      fs.writeFileSync(target, params.content, "utf8");
      return "ok";
    });
    const progress: string[] = [];

    await loop.runAgentLoop([], {
      onProgress: async (content: string) => {
        progress.push(content);
      },
    });

    expect(fs.readFileSync(target, "utf8")).toBe("new\n");
    expect(progress).not.toContain("");
  });

  it("does not emit file edit progress for exec tool calls", async () => {
    const loop = makeLoop();
    const toolCall = new ToolCallRequest({
      id: "call-exec",
      name: "exec",
      arguments: { command: "printf hi > foo.txt" },
    });
    const responses = [new LLMResponse({ content: "", toolCalls: [toolCall] }), new LLMResponse({ content: "Done", toolCalls: [] })];
    (loop.provider as any).chatWithRetry = vi.fn(async () => responses.shift());
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.tools.prepareCall = vi.fn(() => [null, { command: "printf hi > foo.txt" }, null] as any);
    loop.tools.execute = vi.fn(async () => "ok");
    const fileEvents: any[] = [];

    await loop.runAgentLoop([], {
      onProgress: withProgressCapabilities(
        async (content: string, opts?: Record<string, any>) => {
          if (opts?.fileEditEvents) fileEvents.push(...opts.fileEditEvents);
        },
        { fileEditEvents: true },
      ),
    });

    expect(fileEvents).toEqual([]);
  });

  it("forwards tool events to bus outbound metadata", async () => {
    const bus = new MessageBus();
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "file.txt"), "fixture\n");
    const loop = makeLoop(root);
    loop.bus = bus;
    const toolCall = new ToolCallRequest({ id: "tc1", name: "exec", arguments: { command: "ls file.txt" } });
    const responses = [new LLMResponse({ content: "", toolCalls: [toolCall] }), new LLMResponse({ content: "Done", toolCalls: [] })];
    (loop.provider as any).chatWithRetry = vi.fn(async () => responses.shift());

    await loop.dispatchMessage(
      new InboundMessage({
        channel: "telegram",
        senderId: "u1",
        chatId: "chat1",
        content: "run ls",
      }),
    );

    const outbound = await drain(bus);
    const toolEventMessages = outbound.filter((message) => message.metadata?.toolEvents);
    expect(toolEventMessages.length).toBeGreaterThanOrEqual(2);
    expect(toolEventMessages[0].metadata.toolEvents[0]).toMatchObject({
      phase: "start",
      name: "exec",
      call_id: "tc1",
      result: null,
    });
    expect(toolEventMessages.at(-1).metadata.toolEvents[0]).toMatchObject({
      phase: "end",
    });
    expect(toolEventMessages.at(-1).metadata.toolEvents[0].result).toContain("file.txt");
  });

  it("forwards file edit bus metadata for websocket progress only", async () => {
    const bus = new MessageBus();
    const loop = makeLoop();
    loop.bus = bus;
    const editEvents = [
      {
        call_id: "call-write",
        tool: "write_file",
        path: "foo.txt",
        phase: "start",
        added: 1,
        deleted: 0,
        approximate: true,
        status: "editing",
      },
    ];

    const websocketProgress = await loop.buildBusProgressCallback(
      new InboundMessage({
        channel: "websocket",
        senderId: "u1",
        chatId: "chat1",
        content: "edit",
      }),
    );
    expect(onProgressAcceptsFileEditEvents(websocketProgress)).toBe(true);
    await websocketProgress("", { fileEditEvents: editEvents });
    expect((await bus.consumeOutbound()).metadata.fileEditEvents).toEqual(editEvents);

    const telegramProgress = await loop.buildBusProgressCallback(
      new InboundMessage({
        channel: "telegram",
        senderId: "u1",
        chatId: "chat2",
        content: "edit",
      }),
    );
    expect(onProgressAcceptsFileEditEvents(telegramProgress)).toBe(false);
    await invokeFileEditProgress(telegramProgress, editEvents);
    expect(bus.outboundSize).toBe(0);
  });

  it("does not publish codex progress deltas to non-streaming channels", async () => {
    const bus = new MessageBus();
    const loop = makeLoop();
    loop.bus = bus;
    (loop.provider as any).supportsProgressDeltas = true;
    (loop.provider as any).chatStreamWithRetry = vi.fn();
    (loop.provider as any).chatWithRetry = vi.fn(async () => new LLMResponse({ content: "Hello", toolCalls: [] }));
    loop.tools.getDefinitions = vi.fn(() => []);

    await loop.dispatchMessage(
      new InboundMessage({
        channel: "whatsapp",
        senderId: "u1",
        chatId: "chat1",
        content: "say hello",
      }),
    );

    const outbound = await drain(bus);
    expect(outbound.map((message) => message.content)).toEqual(["Hello"]);
    expect(outbound.some((message) => message.metadata?.agentProgress)).toBe(false);
    expect(outbound.some((message) => message.metadata?.streamed)).toBe(false);
    expect((loop.provider as any).chatStreamWithRetry).not.toHaveBeenCalled();
  });

  it("streams provider deltas to websocket channels and marks final response", async () => {
    const bus = new MessageBus();
    const loop = makeLoop();
    loop.bus = bus;
    (loop.provider as any).supportsProgressDeltas = true;
    (loop.provider as any).chatWithRetry = vi.fn();
    (loop.provider as any).chatStreamWithRetry = vi.fn(async (args: any) => {
      await args.onContentDelta("Hel");
      await args.onContentDelta("lo");
      return new LLMResponse({ content: "Hello", toolCalls: [] });
    });
    loop.tools.getDefinitions = vi.fn(() => []);

    await loop.dispatchMessage(
      new InboundMessage({
        channel: "websocket",
        senderId: "u1",
        chatId: "chat1",
        content: "say hello",
        metadata: { webui: true, wantsStream: true },
      }),
    );

    const outbound = await drain(bus);
    expect(outbound.filter((message) => message.metadata?.streamDelta).map((message) => message.content)).toEqual(["Hel", "lo"]);
    expect(outbound.some((message) => message.metadata?.streamEnd)).toBe(true);
    expect(outbound.find((message) => message.content === "Hello")?.metadata.streamed).toBe(true);
    expect(outbound.some((message) => message.metadata?.turnEnd)).toBe(true);
    expect(outbound.some((message) => message.metadata?.goalStatusEvent && message.metadata.goalStatus === "idle")).toBe(true);
    expect((loop.provider as any).chatWithRetry).not.toHaveBeenCalled();
  });

  it("does not mark non-streamed empty-response recovery as already streamed", async () => {
    const bus = new MessageBus();
    const loop = makeLoop();
    loop.bus = bus;
    (loop.provider as any).chatStreamWithRetry = vi.fn(async () => new LLMResponse({ content: "", toolCalls: [] }));
    (loop.provider as any).chatWithRetry = vi.fn(async () => new LLMResponse({ content: "Recovered final answer", toolCalls: [] }));
    loop.tools.getDefinitions = vi.fn(() => []);

    await loop.dispatchMessage(
      new InboundMessage({
        channel: "websocket",
        senderId: "u1",
        chatId: "chat1",
        content: "say hello",
        metadata: { webui: true, wantsStream: true },
      }),
    );

    const outbound = await drain(bus);
    expect((loop.provider as any).chatStreamWithRetry).toHaveBeenCalledTimes(2);
    expect((loop.provider as any).chatWithRetry).toHaveBeenCalledTimes(1);
    const recovered = outbound.find((message) => message.content === "Recovered final answer");
    expect(recovered).toBeTruthy();
    expect(recovered?.metadata.streamed).not.toBe(true);
    expect(outbound.some((message) => message.metadata?.streamEnd)).toBe(true);
    expect(outbound.some((message) => message.metadata?.turnEnd)).toBe(true);
  });

  it("does not repeat streamed content before tool execution", async () => {
    const loop = makeLoop();
    (loop.provider as any).supportsProgressDeltas = true;
    const toolCall = new ToolCallRequest({
      id: "call1",
      name: "custom_tool",
      arguments: { path: "foo.txt" },
    });
    const responses = [new LLMResponse({ content: "I will inspect it.", toolCalls: [toolCall] }), new LLMResponse({ content: "Done", toolCalls: [] })];
    (loop.provider as any).chatWithRetry = vi.fn();
    (loop.provider as any).chatStreamWithRetry = vi.fn(async (args: any) => {
      const response = responses.shift()!;
      if (response.toolCalls.length) {
        await args.onContentDelta("I will");
        await args.onContentDelta(" inspect it.");
      }
      return response;
    });
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.tools.prepareCall = vi.fn(() => [null, { path: "foo.txt" }, null] as any);
    loop.tools.execute = vi.fn(async () => "ok");
    const streamed: string[] = [];
    const progress: any[] = [];

    const [finalContent] = await loop.runAgentLoop([], {
      onStream: async (delta: string) => streamed.push(delta),
      onProgress: withProgressCapabilities(
        async (content: string, opts?: Record<string, any>) => {
          progress.push([content, opts]);
        },
        { toolEvents: true },
      ),
    });

    expect(finalContent).toBe("Done");
    expect(streamed).toEqual(["I will", " inspect it."]);
    expect(progress.some(([content]) => content === "I will inspect it.")).toBe(false);
    expect(progress[0][0]).toBe('custom_tool("foo.txt")');
  });

  it("publishes a final turn-end marker after websocket dispatch", async () => {
    const bus = new MessageBus();
    const loop = makeLoop();
    loop.bus = bus;
    (loop.provider as any).chatWithRetry = vi.fn(async () => new LLMResponse({ content: "Done", toolCalls: [] }));
    loop.tools.getDefinitions = vi.fn(() => []);

    await loop.dispatchMessage(
      new InboundMessage({
        channel: "websocket",
        senderId: "u1",
        chatId: "chat1",
        content: "say hello",
        metadata: { webui: true },
      }),
    );

    const outbound = await drain(bus);
    const doneIndex = outbound.findIndex((message) => message.content === "Done");
    const turnEndIndex = outbound.findIndex((message) => message.metadata?.turnEnd);
    const idleIndex = outbound.findIndex((message) => message.metadata?.goalStatusEvent && message.metadata.goalStatus === "idle");
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(turnEndIndex).toBeGreaterThan(doneIndex);
    expect(idleIndex).toBeGreaterThan(turnEndIndex);
    expect(outbound[turnEndIndex]).toMatchObject({ content: "", chatId: "chat1" });
  });
});
