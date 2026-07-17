import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OutboundMessage } from "../../../../src/core/runtime-messages/events.js";
import { getWorkspacePath } from "../../../../src/config/paths.js";
import { RequestContext } from "../../../../src/core/agent-runtime/tools/context.js";
import { MessageTool } from "../../../../src/core/agent-runtime/tools/message.js";

const roots: string[] = [];

function workspace(prefix = "msg-workspace-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("MessageTool", () => {
  it("returns an error when no target context is available", async () => {
    const tool = new MessageTool();

    await expect(tool.execute({ content: "test" })).resolves.toBe("Error: No target channel/chat specified");
  });

  it.each([
    "not a list",
    [["ok"], "row-not-a-list"],
    [["ok", 42]],
    [[null]],
  ])("rejects malformed buttons %#", async (bad) => {
    const tool = new MessageTool();

    await expect(
      tool.execute({ content: "hi", channel: "telegram", chat_id: "1", buttons: bad as any }),
    ).resolves.toBe("Error: buttons must be a list of list of strings");
  });

  it("marks channel delivery only when enabled", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });

    await tool.execute({ content: "normal", channel: "telegram", chat_id: "1" });
    const token = tool.setRecordChannelDelivery(true);
    try {
      await tool.execute({ content: "cron", channel: "telegram", chat_id: "1" });
    } finally {
      tool.resetRecordChannelDelivery(token);
    }

    expect(sent[0].metadata).toEqual({});
    expect(sent[1].metadata).toEqual({ recordChannelDelivery: true });
  });

  it("records media deliveries", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });

    await tool.execute({
      content: "image",
      channel: "websocket",
      chat_id: "chat-1",
      media: ["/tmp/generated.png"],
    });

    expect(sent[0].metadata).toEqual({ recordChannelDelivery: true });
  });

  it("inherits metadata for the same target", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    const slackMeta = { slack: { thread_ts: "111.222", channel_type: "channel" } };
    tool.setContext(new RequestContext({ channel: "slack", chatId: "C123", metadata: slackMeta }));

    await tool.execute({ content: "thread reply" });

    expect(sent[0].metadata).toEqual(slackMeta);
  });

  it("clears metadata when the context has none", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    tool.setContext(
      new RequestContext({
        channel: "slack",
        chatId: "C123",
        metadata: { slack: { thread_ts: "111.222", channel_type: "channel" } },
      }),
    );
    tool.setContext(new RequestContext({ channel: "slack", chatId: "C123", metadata: {} }));

    await tool.execute({ content: "plain reply" });

    expect(sent[0].metadata).toEqual({});
  });

  it("does not inherit metadata for a different target", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    tool.setContext(
      new RequestContext({
        channel: "slack",
        chatId: "C123",
        metadata: { slack: { thread_ts: "111.222", channel_type: "channel" } },
      }),
    );

    await tool.execute({ content: "channel reply", channel: "slack", chat_id: "C999" });

    expect(sent[0].metadata).toEqual({});
  });

  it("resolves relative media paths", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });

    await tool.execute({
      content: "see attached",
      channel: "telegram",
      chat_id: "1",
      media: ["output/image.png"],
    });

    expect(sent[0].media).toEqual([path.join(getWorkspacePath(), "output/image.png")]);
  });

  it("resolves relative media paths from the active workspace", async () => {
    const sent: OutboundMessage[] = [];
    const root = workspace();
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); }, workspace: root });

    await tool.execute({
      content: "see attached",
      channel: "telegram",
      chat_id: "1",
      media: ["output/image.png"],
    });

    expect(sent[0].media).toEqual([path.join(root, "output/image.png")]);
  });

  it("rejects outside workspace absolute media when restricted", async () => {
    const sent: OutboundMessage[] = [];
    const root = workspace();
    const outside = path.join(path.dirname(root), `secret-${Date.now()}.txt`);
    fs.writeFileSync(outside, "secret");
    roots.push(outside);
    const tool = new MessageTool({
      sendCallback: async (msg) => { sent.push(msg); },
      workspace: root,
      restrictToWorkspace: true,
    });

    const result = await tool.execute({
      content: "see attached",
      channel: "telegram",
      chat_id: "1",
      media: [outside],
    });

    expect(result).toContain("Error: media path is not allowed:");
    expect(result).toContain("outside allowed directory");
    expect(sent).toEqual([]);
  });

  it("allows workspace absolute media when restricted", async () => {
    const sent: OutboundMessage[] = [];
    const root = workspace();
    const image = path.join(root, "image.png");
    fs.writeFileSync(image, "image");
    const tool = new MessageTool({
      sendCallback: async (msg) => { sent.push(msg); },
      workspace: root,
      restrictToWorkspace: true,
    });

    const result = await tool.execute({
      content: "see attached",
      channel: "telegram",
      chat_id: "1",
      media: [image],
    });

    expect(result).toBe("Message sent to telegram:1 with 1 attachments");
    expect(sent[0].media).toEqual([path.resolve(image)]);
  });

  it("passes through absolute media paths", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    const absPath = path.join(os.tmpdir(), "abs_image.png");

    await tool.execute({
      content: "see attached",
      channel: "telegram",
      chat_id: "1",
      media: [absPath],
    });

    expect(sent[0].media).toEqual([absPath]);
  });

  it("passes through URL media paths", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    const url = "https://example.com/image.png";

    await tool.execute({
      content: "see attached",
      channel: "telegram",
      chat_id: "1",
      media: [url],
    });

    expect(sent[0].media).toEqual([url]);
  });

  it("resolves mixed media paths", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    const absPath = path.join(os.tmpdir(), "absolute.png");

    await tool.execute({
      content: "see attached",
      channel: "telegram",
      chat_id: "1",
      media: ["output/relative.png", absPath, "https://example.com/url.png", "http://example.com/http.png"],
    });

    expect(sent[0].media).toEqual([
      path.join(getWorkspacePath(), "output/relative.png"),
      absPath,
      "https://example.com/url.png",
      "http://example.com/http.png",
    ]);
  });

  it("tracks turn media for the same target", async () => {
    const root = workspace("msg-turn-");
    const file = path.join(root, "doc.md");
    fs.writeFileSync(file, "hello");
    const tool = new MessageTool({ sendCallback: async () => undefined });
    tool.setContext(new RequestContext({ channel: "websocket", chatId: "chat-1", metadata: {} }));
    tool.startTurn();

    await tool.execute({ content: "see file", channel: "websocket", chat_id: "chat-1", media: [file] });

    expect(tool.turnDeliveredMediaPaths()).toEqual([path.resolve(file)]);
  });

  it("clears tracked media at the start of a turn", async () => {
    const root = workspace("msg-turn-");
    const file = path.join(root, "doc.md");
    fs.writeFileSync(file, "hello");
    const tool = new MessageTool({ sendCallback: async () => undefined });
    tool.setContext(new RequestContext({ channel: "websocket", chatId: "chat-1", metadata: {} }));
    tool.startTurn();
    await tool.execute({ content: "see file", media: [file] });

    tool.startTurn();

    expect(tool.turnDeliveredMediaPaths()).toEqual([]);
  });

  it("does not track turn media for a different target", async () => {
    const root = workspace("msg-turn-");
    const file = path.join(root, "doc.md");
    fs.writeFileSync(file, "hello");
    const tool = new MessageTool({ sendCallback: async () => undefined });
    tool.setContext(new RequestContext({ channel: "websocket", chatId: "chat-1", metadata: {} }));

    await tool.execute({ content: "see file", channel: "telegram", chat_id: "tg-other", media: [file] });

    expect(tool.turnDeliveredMediaPaths()).toEqual([]);
  });

  it("rejects a wrong explicit WebSocket chat id", async () => {
    const sent: OutboundMessage[] = [];
    const root = workspace("msg-ws-");
    const file = path.join(root, "doc.md");
    fs.writeFileSync(file, "hello");
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    const conv = "550e8400-e29b-41d4-a716-446655440000";
    tool.setContext(new RequestContext({ channel: "websocket", chatId: conv, metadata: {} }));

    const result = await tool.execute({
      content: "see file",
      channel: "websocket",
      chat_id: "anon-deadbeefcafe",
      media: [file],
    });

    expect(result).toContain("Error: chat_id does not match");
    expect(sent).toEqual([]);
  });

  it("allows an explicit WebSocket chat id when it matches context", async () => {
    const sent: OutboundMessage[] = [];
    const root = workspace("msg-ws-");
    const file = path.join(root, "doc.md");
    fs.writeFileSync(file, "hello");
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    const conv = "550e8400-e29b-41d4-a716-446655440000";
    tool.setContext(new RequestContext({ channel: "websocket", chatId: conv, metadata: {} }));

    const result = await tool.execute({
      content: "see file",
      channel: "websocket",
      chat_id: conv,
      media: [file],
    });

    expect(result).toContain("Message sent");
    expect(sent[0].chatId).toBe(conv);
  });

  it("allows CLI context to target another WebSocket chat", async () => {
    const sent: OutboundMessage[] = [];
    const root = workspace("msg-cli-");
    const file = path.join(root, "doc.md");
    fs.writeFileSync(file, "hello");
    const tool = new MessageTool({ sendCallback: async (msg) => { sent.push(msg); } });
    const target = "550e8400-e29b-41d4-a716-446655440000";
    tool.setContext(new RequestContext({ channel: "cli", chatId: "direct", metadata: {} }));

    const result = await tool.execute({
      content: "ping",
      channel: "websocket",
      chat_id: target,
      media: [file],
    });

    expect(result).toContain("Message sent");
    expect(sent[0].channel).toBe("websocket");
    expect(sent[0].chatId).toBe(target);
  });
});
