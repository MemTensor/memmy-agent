import { describe, expect, it, vi } from "vitest";
import { FeishuChannel, FeishuConfig } from "../../../src/integrations/channels/feishu.js";
import { OutboundMessage } from "../../../src/core/runtime-messages/events.js";

function makeChannel(): FeishuChannel {
  const channel = new FeishuChannel(new FeishuConfig({
    appId: "test-app-id",
    appSecret: "test-app-secret",
    toolHintPrefix: "\u{1F527}",
  }));
  (channel as any).client = {};
  return channel;
}

function toolHintCard(send: any): any {
  const [, , msgType, content] = send.mock.calls[0];
  expect(msgType).toBe("interactive");
  return JSON.parse(content);
}

async function sendToolHint(content: string): Promise<any> {
  const channel = makeChannel();
  const send = vi.spyOn(channel as any, "sendMessageSync").mockReturnValue("msg-1");
  await channel.send(new OutboundMessage({
    channel: "feishu",
    chatId: "oc_123456",
    content,
    metadata: { toolHint: true },
  }));
  return { send, card: send.mock.calls.length ? toolHintCard(send) : null };
}

describe("Feishu tool hint code block", () => {
  it("keeps tool hint prefix configurable and serializes markdown post content", () => {
    const config = new FeishuConfig({ toolHintPrefix: "TOOL" });
    const post = JSON.parse(FeishuChannel.markdownToPost("TOOL read_file\n`src/main.ts`"));

    expect(config.toolHintPrefix).toBe("TOOL");
    expect(post.post.zh_cn.content.flat()[0].text).toContain("TOOL read_file");
    expect(JSON.stringify(post)).toContain("src/main.ts");
  });

  it("sends tool hints as interactive cards with the configured prefix", async () => {
    const { send, card } = await sendToolHint('web_search("test query")');

    expect(send).toHaveBeenCalledOnce();
    expect(card.config.wide_screen_mode).toBe(true);
    expect(card.elements[0].content).toContain("\u{1F527}");
    expect(card.elements[0].content).toContain("web_search");
  });

  it("does not send empty tool hints", async () => {
    const { send } = await sendToolHint("   ");

    expect(send).not.toHaveBeenCalled();
  });

  it("sends messages without tool hint metadata as normal text", async () => {
    const channel = makeChannel();
    const send = vi.spyOn(channel as any, "sendMessageSync").mockReturnValue("msg-1");

    await channel.send(new OutboundMessage({
      channel: "feishu",
      chatId: "oc_123456",
      content: "Hello, world!",
      metadata: {},
    }));

    const [, , msgType, content] = send.mock.calls[0];
    expect(msgType).toBe("text");
    expect(JSON.parse(String(content))).toEqual({ text: "Hello, world!" });
  });

  it("keeps multiple old-format tool calls in one card", async () => {
    const { card } = await sendToolHint('web_search("query"), read_file("/path/to/file")');
    const markdown = card.elements[0].content;

    expect(markdown).toContain("web_search");
    expect(markdown).toContain("read_file");
    expect(markdown).toContain("\u{1F527}");
  });

  it("formats new concise tool hints", async () => {
    const { card } = await sendToolHint('read src/main.ts, grep "TODO"');
    const markdown = card.elements[0].content;

    expect(markdown).toContain("read src/main.ts");
    expect(markdown).toContain('grep "TODO"');
  });

  it("does not split commas inside quoted concise arguments", async () => {
    const { card } = await sendToolHint('grep "hello, world", $ echo test');
    const markdown = card.elements[0].content;

    expect(markdown).toContain('grep "hello, world"');
    expect(markdown).toContain("$ echo test");
  });

  it("keeps folded tool counts visible", async () => {
    const { card } = await sendToolHint('read path \u00D7 3, grep "pattern"');
    const markdown = card.elements[0].content;

    expect(markdown).toContain("\u00D7 3");
    expect(markdown).toContain('grep "pattern"');
  });

  it("formats MCP-style tool hints", async () => {
    const { card } = await sendToolHint('4_5v::analyze_image("photo.jpg")');

    expect(card.elements[0].content).toContain("4_5v::analyze_image");
  });

  it("keeps commas inside old-format tool arguments", async () => {
    const { card } = await sendToolHint('web_search("foo, bar"), read_file("/path/to/file")');
    const markdown = card.elements[0].content;

    expect(markdown).toContain('web_search("foo, bar")');
    expect(markdown).toContain('read_file("/path/to/file")');
  });
});
