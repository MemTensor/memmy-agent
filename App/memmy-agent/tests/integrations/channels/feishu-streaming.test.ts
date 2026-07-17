import { describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { FeishuChannel, FeishuConfig, FeishuStreamBuffer } from "../../../src/integrations/channels/feishu.js";

function currentSeconds(): number {
  return Date.now() / 1000;
}

function response(success = true, data: Record<string, any> = {}): any {
  return {
    success: vi.fn(() => success),
    data,
    code: success ? 0 : 99999,
    msg: success ? "ok" : "error",
    get_log_id: vi.fn(() => "log1"),
  };
}

function createCardResponse(cardId = "card_stream_001"): any {
  return response(true, { card_id: cardId });
}

function sendResponse(messageId = "om_stream_001"): any {
  return response(true, { message_id: messageId });
}

function mockClient(): any {
  const cardElement = {
    content: vi.fn(() => response(true)),
  };
  return {
    cardkit: {
      v1: {
        card: {
          create: vi.fn(() => createCardResponse()),
          settings: vi.fn(() => response(true)),
        },
        cardElement,
        card_element: cardElement,
      },
    },
    im: {
      v1: {
        message: {
          create: vi.fn(() => sendResponse()),
          reply: vi.fn(() => response(true)),
        },
      },
    },
  };
}

function makeChannel(streaming = true, replyToMessage = false): FeishuChannel {
  const channel = new FeishuChannel(
    new FeishuConfig({
      enabled: true,
      appId: "cli_test",
      appSecret: "secret",
      allowFrom: ["*"],
      streaming,
      replyToMessage,
    }),
    new MessageBus(),
  );
  channel.client = mockClient();
  channel.loop = null;
  return channel;
}

function streamBuf(init: Partial<FeishuStreamBuffer>): FeishuStreamBuffer {
  return new FeishuStreamBuffer(init);
}

describe("Feishu Streaming Config", () => {
  it("streaming default true", () => {
    expect(new FeishuConfig().streaming).toBe(true);
  });

  it("supports streaming when enabled", () => {
    expect(makeChannel(true).supportsStreaming).toBe(true);
  });

  it("supports streaming disabled", () => {
    expect(makeChannel(false).supportsStreaming).toBe(false);
  });
});

describe("Create Streaming Card", () => {
  it("returns card id on success", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.create.mockReturnValue(createCardResponse("card_123"));
    channel.client.im.v1.message.create.mockReturnValue(sendResponse());

    const result = channel.createStreamingCardSync("chat_id", "oc_chat1");

    expect(result).toBe("card_123");
    expect(channel.client.cardkit.v1.card.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
  });

  it("returns none on failure", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.create.mockReturnValue(response(false));
    expect(channel.createStreamingCardSync("chat_id", "oc_chat1")).toBeNull();
  });

  it("returns none on exception", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.create.mockImplementation(() => {
      throw new Error("network");
    });
    expect(channel.createStreamingCardSync("chat_id", "oc_chat1")).toBeNull();
  });

  it("returns none when card send fails", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.create.mockReturnValue(createCardResponse("card_123"));
    channel.client.im.v1.message.create.mockReturnValue(response(false));
    expect(channel.createStreamingCardSync("chat_id", "oc_chat1")).toBeNull();
  });
});

describe("Close Streaming Mode", () => {
  it("returns true on success", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.settings.mockReturnValue(response(true));
    expect(channel.closeStreamingModeSync("card_1", 10)).toBe(true);
  });

  it("returns false on failure", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.settings.mockReturnValue(response(false));
    expect(channel.closeStreamingModeSync("card_1", 10)).toBe(false);
  });

  it("returns false on exception", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.settings.mockImplementation(() => {
      throw new Error("err");
    });
    expect(channel.closeStreamingModeSync("card_1", 10)).toBe(false);
  });
});

describe("Stream Update Text", () => {
  it("returns true on success", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card_element.content.mockReturnValue(response(true));
    expect(channel.streamUpdateTextSync("card_1", "hello", 1)).toBe(true);
  });

  it("returns false on failure", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card_element.content.mockReturnValue(response(false));
    expect(channel.streamUpdateTextSync("card_1", "hello", 1)).toBe(false);
  });

  it("returns false on exception", () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card_element.content.mockImplementation(() => {
      throw new Error("err");
    });
    expect(channel.streamUpdateTextSync("card_1", "hello", 1)).toBe(false);
  });
});

describe("Send Delta", () => {
  it("first delta creates card and sends", async () => {
    const channel = makeChannel();
    channel.client.cardkit.v1.card.create.mockReturnValue(createCardResponse("card_new"));
    channel.client.im.v1.message.create.mockReturnValue(sendResponse("om_new"));

    await channel.sendDelta("oc_chat1", "Hello ");

    expect(channel.streamBuffers.oc_chat1.text).toBe("Hello ");
    expect(channel.streamBuffers.oc_chat1.cardId).toBe("card_new");
    expect(channel.streamBuffers.oc_chat1.sequence).toBe(1);
    expect(channel.client.cardkit.v1.card.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(channel.client.cardkit.v1.card_element.content).toHaveBeenCalledOnce();
  });

  it("group delta uses create when reply disabled", async () => {
    const channel = makeChannel(true, false);
    await channel.sendDelta("oc_chat1", "Hello ", {
      message_id: "om_001",
      chat_type: "group",
    });

    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.reply).not.toHaveBeenCalled();
  });

  it("group delta keeps existing topic when reply disabled", async () => {
    const channel = makeChannel(true, false);
    await channel.sendDelta("oc_chat1", "Hello ", {
      message_id: "om_001",
      chat_type: "group",
      thread_id: "ot_001",
    });

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).not.toBe(true);
  });

  it("group delta replies in thread when reply enabled", async () => {
    const channel = makeChannel(true, true);
    await channel.sendDelta("oc_chat1", "Hello ", {
      message_id: "om_001",
      chat_type: "group",
    });

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).toBe(true);
  });

  it("second delta within interval skips update", async () => {
    const channel = makeChannel();
    const buf = streamBuf({ text: "Hello ", cardId: "card_1", sequence: 1, lastEdit: currentSeconds() });
    channel.streamBuffers.oc_chat1 = buf;

    await channel.sendDelta("oc_chat1", "world");

    expect(buf.text).toBe("Hello world");
    expect(channel.client.cardkit.v1.card_element.content).not.toHaveBeenCalled();
  });

  it("delta after interval updates text", async () => {
    const channel = makeChannel();
    const buf = streamBuf({ text: "Hello ", cardId: "card_1", sequence: 1, lastEdit: currentSeconds() - 1 });
    channel.streamBuffers.oc_chat1 = buf;

    await channel.sendDelta("oc_chat1", "world");

    expect(buf.text).toBe("Hello world");
    expect(buf.sequence).toBe(2);
    expect(channel.client.cardkit.v1.card_element.content).toHaveBeenCalledOnce();
  });

  it("stream end sends final update", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({ text: "Final content", cardId: "card_1", sequence: 3 });

    await channel.sendDelta("oc_chat1", "", { streamEnd: true });

    expect(channel.streamBuffers.oc_chat1).toBeUndefined();
    expect(channel.client.cardkit.v1.card_element.content).toHaveBeenCalledOnce();
    expect(channel.client.cardkit.v1.card.settings).toHaveBeenCalledOnce();
    const settingsCall = channel.client.cardkit.v1.card.settings.mock.calls[0][0];
    expect(settingsCall.data.sequence).toBe(5);
  });

  it("stream end fallback when no card id", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({ text: "Fallback content", cardId: null, sequence: 0 });

    await channel.sendDelta("oc_chat1", "", { streamEnd: true });

    expect(channel.streamBuffers.oc_chat1).toBeUndefined();
    expect(channel.client.cardkit.v1.card_element.content).not.toHaveBeenCalled();
    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
  });

  it("stream end fallback group uses create when reply disabled", async () => {
    const channel = makeChannel(true, false);
    channel.streamBuffers.om_001 = streamBuf({ text: "Fallback content", cardId: null });

    await channel.sendDelta("oc_chat1", "", {
      streamEnd: true,
      message_id: "om_001",
      chat_type: "group",
    });

    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.reply).not.toHaveBeenCalled();
  });

  it("stream end fallback keeps existing topic when reply disabled", async () => {
    const channel = makeChannel(true, false);
    channel.streamBuffers.om_001 = streamBuf({ text: "Fallback content", cardId: null });

    await channel.sendDelta("oc_chat1", "", {
      streamEnd: true,
      message_id: "om_001",
      chat_type: "group",
      thread_id: "ot_001",
    });

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).not.toBe(true);
  });

  it("stream end fallback group replies when reply enabled", async () => {
    const channel = makeChannel(true, true);
    channel.streamBuffers.om_001 = streamBuf({ text: "Fallback content", cardId: null });

    await channel.sendDelta("oc_chat1", "", {
      streamEnd: true,
      message_id: "om_001",
      chat_type: "group",
    });

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).toBe(true);
  });

  it("stream end fallback when final update fails", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({ text: "Lost content", cardId: "card_1", sequence: 3 });
    channel.client.cardkit.v1.card_element.content.mockReturnValue(response(false));

    await channel.sendDelta("oc_chat1", "", { streamEnd: true });

    expect(channel.streamBuffers.oc_chat1).toBeUndefined();
    expect(channel.client.cardkit.v1.card.settings).not.toHaveBeenCalled();
    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
  });

  it("stream end without buf is noop", async () => {
    const channel = makeChannel();
    await channel.sendDelta("oc_chat1", "", { streamEnd: true });
    expect(channel.client.cardkit.v1.card_element.content).not.toHaveBeenCalled();
  });

  it("empty delta skips send", async () => {
    const channel = makeChannel();
    await channel.sendDelta("oc_chat1", "   ");

    expect(channel.streamBuffers.oc_chat1).toBeDefined();
    expect(channel.client.cardkit.v1.card.create).not.toHaveBeenCalled();
  });

  it("no client returns early", async () => {
    const channel = makeChannel();
    channel.client = null;
    await channel.sendDelta("oc_chat1", "text");
    expect(channel.streamBuffers.oc_chat1).toBeUndefined();
  });

  it("sequence increments correctly", async () => {
    const channel = makeChannel();
    const buf = streamBuf({ text: "a", cardId: "card_1", sequence: 5, lastEdit: currentSeconds() - 1 });
    channel.streamBuffers.oc_chat1 = buf;

    await channel.sendDelta("oc_chat1", "b");
    expect(buf.sequence).toBe(6);

    buf.lastEdit = buf.lastEdit = currentSeconds() - 1;
    await channel.sendDelta("oc_chat1", "c");
    expect(buf.sequence).toBe(7);
  });
});

describe("Tool Hint Inline Streaming", () => {
  it("tool hint inlined when stream active", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({ text: "Partial answer", cardId: "card_1", sequence: 2 });

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_chat1",
        content: 'web_fetch("https://example.com")',
        metadata: { toolHint: true },
      }),
    );

    const buf = channel.streamBuffers.oc_chat1;
    expect(buf.text).toContain('🔧 web_fetch("https://example.com")');
    expect(buf.sequence).toBe(3);
    expect(channel.client.cardkit.v1.card_element.content).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
  });

  it("tool hint preserved on next delta", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({
      text: 'Partial answer\n\n🔧 web_fetch("url")\n\n',
      cardId: "card_1",
      sequence: 3,
    });

    await channel.sendDelta("oc_chat1", " continued");

    const buf = channel.streamBuffers.oc_chat1;
    expect(buf.text).toContain("Partial answer");
    expect(buf.text).toContain("🔧 web_fetch");
    expect(buf.text.endsWith(" continued")).toBe(true);
  });

  it("tool hint fallback when no stream", async () => {
    const channel = makeChannel();

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_chat1",
        content: 'read_file("path")',
        metadata: { toolHint: true },
      }),
    );

    expect(channel.streamBuffers.oc_chat1).toBeUndefined();
    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
  });

  it("tool hint group uses create when reply disabled", async () => {
    const channel = makeChannel(true, false);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_chat1",
        content: 'read_file("path")',
        metadata: { toolHint: true, message_id: "om_001", chat_type: "group" },
      }),
    );

    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.reply).not.toHaveBeenCalled();
  });

  it("tool hint keeps existing topic when reply disabled", async () => {
    const channel = makeChannel(true, false);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_chat1",
        content: 'read_file("path")',
        metadata: {
          toolHint: true,
          message_id: "om_001",
          chat_type: "group",
          thread_id: "ot_001",
        },
      }),
    );

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).not.toBe(true);
  });

  it("tool hint group replies when reply enabled", async () => {
    const channel = makeChannel(true, true);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_chat1",
        content: 'read_file("path")',
        metadata: { toolHint: true, message_id: "om_001", chat_type: "group" },
      }),
    );

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).toBe(true);
  });

  it("consecutive tool hints append", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({ text: "Partial answer", cardId: "card_1", sequence: 2 });

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_chat1",
        content: "$ cd /project",
        metadata: { toolHint: true },
      }),
    );
    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_chat1",
        content: "$ git status",
        metadata: { toolHint: true },
      }),
    );

    const buf = channel.streamBuffers.oc_chat1;
    expect(buf.text).toContain("$ cd /project");
    expect(buf.text).toContain("$ git status");
    expect(buf.text.startsWith("Partial answer")).toBe(true);
    expect(buf.text).toContain("🔧 $ cd /project");
    expect(buf.text).toContain("🔧 $ git status");
  });

  it("tool hint preserved on final stream end", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({
      text: 'Final content\n\n🔧 web_fetch("url")\n\n',
      cardId: "card_1",
      sequence: 3,
    });

    await channel.sendDelta("oc_chat1", "", { streamEnd: true });

    expect(channel.streamBuffers.oc_chat1).toBeUndefined();
    const updateCall = channel.client.cardkit.v1.card_element.content.mock.calls[0][0];
    expect(updateCall.data.content).toContain("🔧");
  });

  it("empty tool hint is noop", async () => {
    const channel = makeChannel();
    channel.streamBuffers.oc_chat1 = streamBuf({ text: "Partial answer", cardId: "card_1", sequence: 2 });

    for (const content of ["", "   ", "\t\n"]) {
      await channel.send(
        new OutboundMessage({
          channel: "feishu",
          chatId: "oc_chat1",
          content,
          metadata: { toolHint: true },
        }),
      );
    }

    expect(channel.streamBuffers.oc_chat1.text).toBe("Partial answer");
    expect(channel.streamBuffers.oc_chat1.sequence).toBe(2);
    expect(channel.client.cardkit.v1.card_element.content).not.toHaveBeenCalled();
  });
});

describe("Send Message Returns Id", () => {
  it("returns message id on success", () => {
    const channel = makeChannel();
    channel.client.im.v1.message.create.mockReturnValue(sendResponse("om_abc"));
    expect(channel.sendMessageSync("chat_id", "oc_chat1", "text", '{"text":"hi"}')).toBe("om_abc");
  });

  it("returns none on failure", () => {
    const channel = makeChannel();
    channel.client.im.v1.message.create.mockReturnValue(response(false));
    expect(channel.sendMessageSync("chat_id", "oc_chat1", "text", '{"text":"hi"}')).toBeNull();
  });
});
