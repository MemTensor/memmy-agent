import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../../src/core/agent-runtime/loop.js";
import { MessageTool } from "../../../../src/core/agent-runtime/tools/message.js";
import { RequestContext } from "../../../../src/core/agent-runtime/tools/context.js";
import { InboundMessage } from "../../../../src/core/runtime-messages/events.js";
import { AsyncQueue, MessageBus } from "../../../../src/core/runtime-messages/queue.js";
import { Config } from "../../../../src/config/schema.js";
import { LLMResponse, ToolCallRequest } from "../../../../src/providers/base.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-message-suppress-"));
  roots.push(root);
  return root;
}

function makeLoop(root = tmpRoot()): AgentLoop {
  const provider = {
    generation: { maxTokens: 4096 },
    getDefaultModel: () => "test-model",
    chatWithRetry: vi.fn(),
  };
  return new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
    provider,
    workspace: root,
    model: "test-model",
  });
}

async function nextDeliveredMessage(loop: AgentLoop): Promise<Awaited<ReturnType<MessageBus["consumeOutbound"]>>> {
  for (let index = 0; index < 10; index += 1) {
    const message = await loop.bus.consumeOutbound();
    if (!message.metadata?.agentProgress) return message;
  }
  throw new Error("No delivered message found");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("message tool final reply suppression", () => {
  it("suppresses the final reply when message sends to the same target", async () => {
    const loop = makeLoop();
    const calls = [
      new LLMResponse({
        content: "",
        toolCalls: [
          new ToolCallRequest({
            id: "call1",
            name: "message",
            arguments: { content: "Hello", channel: "feishu", chat_id: "chat123" },
          }),
        ],
      }),
      new LLMResponse({ content: "Done" }),
    ];
    loop.provider.chatWithRetry = vi.fn(async () => calls.shift()!);

    const result = await loop.processMessage(
      new InboundMessage({ channel: "feishu", senderId: "user1", chatId: "chat123", content: "Send" }),
    );
    const sent = [await nextDeliveredMessage(loop)];

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("Hello");
    expect(result).toBeNull();
  });

  it("does not suppress when message sends to a different target", async () => {
    const loop = makeLoop();
    const calls = [
      new LLMResponse({
        content: "",
        toolCalls: [
          new ToolCallRequest({
            id: "call1",
            name: "message",
            arguments: { content: "Email content", channel: "email", chat_id: "user@example.com" },
          }),
        ],
      }),
      new LLMResponse({ content: "I've sent the email." }),
    ];
    loop.provider.chatWithRetry = vi.fn(async () => calls.shift()!);

    const result = await loop.processMessage(
      new InboundMessage({ channel: "feishu", senderId: "user1", chatId: "chat123", content: "Send email" }),
    );
    const sent = [await nextDeliveredMessage(loop)];

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("email");
    expect(result).not.toBeNull();
    expect(result!.channel).toBe("feishu");
    expect(result!.content).toBe("I've sent the email.");
  });

  it("does not suppress when no message tool is used", async () => {
    const loop = makeLoop();
    loop.provider.chatWithRetry = vi.fn(async () => new LLMResponse({ content: "Hello!" }));

    const result = await loop.processMessage(
      new InboundMessage({ channel: "feishu", senderId: "user1", chatId: "chat123", content: "Hi" }),
    );

    expect(result).not.toBeNull();
    expect(result!.content).toContain("Hello");
  });

  it("does not emit an empty fallback when an injected follow-up uses message", async () => {
    const loop = makeLoop();
    const calls = [
      new LLMResponse({ content: "First answer" }),
      new LLMResponse({
        content: "",
        toolCalls: [
          new ToolCallRequest({
            id: "call1",
            name: "message",
            arguments: { content: "Tool reply", channel: "feishu", chat_id: "chat123" },
          }),
        ],
      }),
      new LLMResponse({ content: "" }),
      new LLMResponse({ content: "" }),
      new LLMResponse({ content: "" }),
    ];
    loop.provider.chatWithRetry = vi.fn(async () => calls.shift()!);
    const pendingQueue = new AsyncQueue<InboundMessage>();
    pendingQueue.put(new InboundMessage({ channel: "feishu", senderId: "user1", chatId: "chat123", content: "follow-up" }));

    const result = await loop.processMessage(
      new InboundMessage({ channel: "feishu", senderId: "user1", chatId: "chat123", content: "Start" }),
      undefined,
      { pendingQueue },
    );
    const sent = [await nextDeliveredMessage(loop)];

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("Tool reply");
    expect(result).toBeNull();
  });

  it("hides internal reasoning from progress updates", async () => {
    const loop = makeLoop();
    const calls = [
      new LLMResponse({
        content: "Visible<think>hidden</think>",
        toolCalls: [new ToolCallRequest({ id: "call1", name: "read_file", arguments: { path: "foo.txt" } })],
        reasoningContent: "secret reasoning",
        thinkingBlocks: [{ signature: "sig", thought: "secret thought" }],
      }),
      new LLMResponse({ content: "Done" }),
    ];
    loop.provider.chatWithRetry = vi.fn(async () => calls.shift()!);
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.tools.execute = vi.fn(async () => "ok");
    const progress: Array<[string, boolean]> = [];

    const [finalContent] = await loop.runAgentLoop([], {
      onProgress: async (content: string, opts: { toolHint?: boolean } = {}) => {
        progress.push([content, Boolean(opts.toolHint)]);
      },
    });

    expect(finalContent).toBe("Done");
    expect(progress).toEqual([
      ["Visible", false],
      ["read foo.txt", true],
    ]);
  });
});

describe("MessageTool turn tracking", () => {
  it("tracks same-target sends in a turn", () => {
    const tool = new MessageTool();
    tool.setContext(new RequestContext({ channel: "feishu", chatId: "chat1" }));

    expect(tool.sentInTurn).toBe(false);
    tool.sentInTurn = true;
    expect(tool.sentInTurn).toBe(true);
  });

  it("startTurn resets the flag", () => {
    const tool = new MessageTool();
    tool.sentInTurn = true;

    tool.startTurn();

    expect(tool.sentInTurn).toBe(false);
  });

  it("schema discourages current-chat replies", () => {
    const tool = new MessageTool();

    expect(tool.description).toContain("Do not use this for the normal reply in the current chat");
    expect(tool.description).toContain("generate_image creates images in the current chat");
    expect(tool.parameters.properties.content.description).toContain("Do not use this for a normal reply in the current chat");
  });
});
