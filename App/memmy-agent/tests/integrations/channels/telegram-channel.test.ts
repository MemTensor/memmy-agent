import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { markdownToTelegramHtml, stripMdBlock, TelegramChannel, TelegramConfig } from "../../../src/integrations/channels/telegram.js";

const grammyMock = vi.hoisted(() => {
  const api: any = { instances: [] as any[] };
  function Bot(this: any, token: string) {
    this.token = token;
    this.handlers = new Map<string, any>();
    this.on = vi.fn((event: string, handler: any) => {
      this.handlers.set(event, handler);
      return this;
    });
    this.start = vi.fn(async () => undefined);
    this.stop = vi.fn(async () => undefined);
    this.api = {
      getMe: vi.fn(async () => ({ id: 999, username: "memmy_bot" })),
      setMyCommands: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      editMessageText: vi.fn(async () => undefined),
      sendPhoto: vi.fn(async () => undefined),
      sendVideo: vi.fn(async () => undefined),
      sendVoice: vi.fn(async () => undefined),
      sendAudio: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
      setMessageReaction: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    };
    api.instances.push(this);
  }
  function InputFile(this: any, filePath: string) {
    this.filePath = filePath;
  }
  api.Bot = vi.fn(Bot);
  api.InputFile = vi.fn(InputFile);
  api.reset = () => {
    api.instances = [];
    api.Bot.mockClear();
    api.Bot.mockImplementation(Bot);
    api.InputFile.mockClear();
    api.InputFile.mockImplementation(InputFile);
  };
  return api;
});

vi.mock("grammy", () => ({ Bot: grammyMock.Bot, InputFile: grammyMock.InputFile }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  grammyMock.reset();
});

function makeBot(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    send_message: vi.fn(async () => ({ message_id: 1 })),
    edit_message_text: vi.fn(async () => undefined),
    send_photo: vi.fn(async () => undefined),
    send_video: vi.fn(async () => undefined),
    send_voice: vi.fn(async () => undefined),
    send_audio: vi.fn(async () => undefined),
    send_document: vi.fn(async () => undefined),
    set_message_reaction: vi.fn(async () => undefined),
    get_me: vi.fn(async () => ({ id: 999, username: "memmy_bot" })),
    ...overrides,
  };
}

function channelWithBot(config: Record<string, any> = {}, botOverrides: Record<string, any> = {}): [TelegramChannel, Record<string, any>] {
  const bot = makeBot(botOverrides);
  const channel = new TelegramChannel({ allowFrom: ["*"], app: { bot }, ...config }, new MessageBus());
  return [channel, bot];
}

describe("Telegram channel", () => {
  it("creates a grammY Bot when only a token is configured", async () => {
    const channel = new TelegramChannel({ token: "telegram-token", allowFrom: ["*"] }, new MessageBus());

    await channel.start();

    expect(grammyMock.Bot).toHaveBeenCalledWith("telegram-token");
    expect(grammyMock.instances[0].on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(grammyMock.instances[0].on).toHaveBeenCalledWith("callback_query:data", expect.any(Function));
    expect(grammyMock.instances[0].start).toHaveBeenCalled();
    expect(channel.botUserId).toBe(999);
    expect(channel.botUsername).toBe("memmy_bot");
    await channel.stop();
    expect(grammyMock.instances[0].stop).toHaveBeenCalled();
  });

  it("renders markdown for Telegram HTML output", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("# A < B & C > D")).toBe("<b>A &lt; B &amp; C &gt; D</b>");
    const result = markdownToTelegramHtml("# Overview\n\n- bullet one\n\n1.   step one\n\n**bold text**");
    expect(result).toContain("<b>Overview</b>");
    expect(result).toContain("• bullet one");
    expect(result).toContain("1. step one");
    expect(result).toContain("<b>bold text</b>");
  });

  it("strips markdown blocks for streaming previews", () => {
    expect(stripMdBlock("**bold** and _italic_ and ~~struck~~")).toBe("bold and italic and struck");
    expect(stripMdBlock("## Title\nBody")).toBe("Title\nBody");
    expect(stripMdBlock("[click here](https://example.com)")).toBe("click here");
  });

  it("exposes default config and channel identity", () => {
    expect(new TelegramConfig().streaming).toBe(true);
    expect(new TelegramChannel().name).toBe("telegram");
  });

  it("hides Dream bot commands unless file memory is enabled", async () => {
    const disabledCommands = vi.fn(async (_commands: any[]) => undefined);
    const disabledBot = makeBot({ set_my_commands: disabledCommands });
    const disabled = new TelegramChannel(
      { app: { bot: disabledBot } },
      new MessageBus(),
    );
    await disabled.start();

    const enabledCommands = vi.fn(async (_commands: any[]) => undefined);
    const enabledBot = makeBot({ set_my_commands: enabledCommands });
    const enabled = new TelegramChannel(
      { app: { bot: enabledBot } },
      new MessageBus(),
      { fileMemoryEnabled: true },
    );
    await enabled.start();

    const disabledNames = disabledCommands.mock.calls[0][0].map(
      (entry: any) => entry.command,
    );
    const enabledNames = enabledCommands.mock.calls[0][0].map(
      (entry: any) => entry.command,
    );
    expect(disabledNames).not.toContain("dream");
    expect(disabledNames).not.toContain("dream_log");
    expect(disabledNames).not.toContain("dream_restore");
    expect(enabledNames).toEqual(
      expect.arrayContaining(["dream", "dream_log", "dream_restore"]),
    );
  });

  it("sends text with HTML rendering and button fallback", async () => {
    const bot = { send_message: vi.fn(async (args: any) => ({ message_id: 1 })) };
    const channel = new TelegramChannel({ app: { bot } });

    await channel.send(new OutboundMessage({
      channel: "telegram",
      chatId: "123",
      content: "**Choose**",
      buttons: [["A", "B"]],
    }));

    expect(bot.send_message).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      parse_mode: "HTML",
      text: expect.stringContaining("<b>Choose</b>"),
    }));
    expect(bot.send_message.mock.calls[0][0].text).toContain("[A] [B]");
  });

  it("streams by sending a preview then final HTML edit", async () => {
    const bot = {
      send_message: vi.fn(async (args: any) => ({ message_id: 10 })),
      edit_message_text: vi.fn(async (args: any) => undefined),
    };
    const channel = new TelegramChannel({ app: { bot }, streamEditInterval: 999 });

    await channel.sendDelta("123", "**Hel", { streamId: "s1" });
    await channel.sendDelta("123", "lo**", { streamId: "s1", streamEnd: true });

    expect(bot.send_message).toHaveBeenCalledWith(expect.objectContaining({ text: "**Hel" }));
    expect(bot.edit_message_text).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      message_id: 10,
      text: "<b>Hello</b>",
      parse_mode: "HTML",
    }));
  });

  it("normalizes and forwards inbound Telegram messages", async () => {
    const bus = new MessageBus();
    const channel = new TelegramChannel({ allowFrom: ["42"] }, bus);

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice", first_name: "Alice" },
      message: {
        message_id: 7,
        chat_id: 123,
        chat: { type: "private" },
        text: "hello",
      },
    }, {});

    const inbound = await bus.nextInbound();
    expect(inbound.senderId).toBe("42|alice");
    expect(inbound.chatId).toBe("123");
    expect(inbound.content).toBe("hello");
    expect(inbound.metadata.message_id).toBe(7);

    expect(TelegramChannel.normalizeTelegramCommand("/dream_log latest")).toBe("/dream-log latest");
  });

  it("renders single markdown headers as bold HTML", () => {
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
    expect(markdownToTelegramHtml("### Deep")).toBe("<b>Deep</b>");
  });

  it("preserves numbered markdown lists", () => {
    const result = markdownToTelegramHtml("1. First\n2. Second\n3. Third");

    expect(result).toContain("1. First");
    expect(result).toContain("2. Second");
    expect(result).toContain("3. Third");
  });

  it("normalizes numbered list whitespace", () => {
    const result = markdownToTelegramHtml("1.   Lots of space\n2.  Two spaces");

    expect(result).toContain("1. Lots of space");
    expect(result).toContain("2. Two spaces");
  });

  it("renders mixed Telegram markdown features together", () => {
    const result = markdownToTelegramHtml("# Overview\n\n- bullet one\n- bullet two\n\n1. step one\n\n**bold text**");

    expect(result).toContain("<b>Overview</b>");
    expect(result).toContain("• bullet one");
    expect(result).toContain("1. step one");
    expect(result).toContain("<b>bold text</b>");
  });

  it("strips bullets and numbers for streaming markdown previews", () => {
    const result = stripMdBlock("- item a\n1. item b\n2. item c");

    expect(result).toContain("• item a");
    expect(result).toContain("1. item b");
    expect(result).toContain("2. item c");
  });

  it("derives topic session keys from thread ids", () => {
    expect(TelegramChannel.deriveTopicSessionKey({ chat_id: -100123, message_thread_id: 42 })).toBe(
      "telegram:-100123:topic:42",
    );
  });

  it("derives private DM topic session keys", () => {
    expect(TelegramChannel.deriveTopicSessionKey({ chat_id: 999, message_thread_id: 7 })).toBe(
      "telegram:999:topic:7",
    );
  });

  it("returns no topic session key without a thread id", () => {
    for (const type of ["private", "supergroup", "group"]) {
      expect(TelegramChannel.deriveTopicSessionKey({ chat: { type }, chat_id: 123, message_thread_id: null })).toBeNull();
    }
  });

  it("falls back to original filename extensions for documents", () => {
    const channel = new TelegramChannel(new TelegramConfig(), new MessageBus());

    expect(channel.getExtension("file", null, "report.pdf")).toBe(".pdf");
    expect(channel.getExtension("file", null, "archive.tar.gz")).toBe(".tar.gz");
  });

  it("defaults Telegram group policy to mention", () => {
    expect(new TelegramConfig().groupPolicy).toBe("mention");
  });

  it("accepts legacy Telegram id and username allowlist formats", () => {
    const channel = new TelegramChannel(new TelegramConfig({ allowFrom: ["12345", "alice", "67890|bob"] }), new MessageBus());

    expect(channel.isAllowed("12345|carol")).toBe(true);
    expect(channel.isAllowed("99999|alice")).toBe(true);
    expect(channel.isAllowed("67890|bob")).toBe(true);
  });

  it("rejects invalid legacy Telegram sender shapes", () => {
    const channel = new TelegramChannel(new TelegramConfig({ allowFrom: ["alice"] }), new MessageBus());

    expect(channel.isAllowed("attacker|alice|extra")).toBe(false);
    expect(channel.isAllowed("not-a-number|alice")).toBe(false);
  });

  it("keeps progress messages in the source topic", async () => {
    const [channel, bot] = channelWithBot();

    await channel.send(
      new OutboundMessage({
        channel: "telegram",
        chatId: "123",
        content: "hello",
        metadata: { agentProgress: true, message_thread_id: 42 },
      }),
    );

    expect(bot.send_message.mock.calls[0][0].message_thread_id).toBe(42);
  });

  it("infers reply topic from the message id cache", async () => {
    const [channel, bot] = channelWithBot({ replyToMessage: true });
    channel.messageThreads.set("123:10", 42);

    await channel.send(
      new OutboundMessage({
        channel: "telegram",
        chatId: "123",
        content: "hello",
        metadata: { message_id: 10 },
      }),
    );

    expect(bot.send_message.mock.calls[0][0].message_thread_id).toBe(42);
    expect(bot.send_message.mock.calls[0][0].reply_parameters.message_id).toBe(10);
  });

  it("extracts no reply context when there is no reply", async () => {
    const [channel] = channelWithBot();

    expect(await channel.extractReplyContext({ reply_to_message: null })).toBeNull();
  });

  it("extracts reply context from reply text", async () => {
    const [channel] = channelWithBot();

    expect(
      await channel.extractReplyContext({
        reply_to_message: { text: "Hello world", caption: null, from_user: { id: 2, username: "testuser", first_name: "Test" } },
      }),
    ).toBe("[Reply to @testuser: Hello world]");
  });

  it("extracts reply context from captions", async () => {
    const [channel] = channelWithBot();

    expect(
      await channel.extractReplyContext({
        reply_to_message: { text: null, caption: "Photo caption", from_user: { id: 2, username: null, first_name: "Test" } },
      }),
    ).toBe("[Reply to Test: Photo caption]");
  });

  it("truncates long reply context", async () => {
    const [channel] = channelWithBot();
    const result = await channel.extractReplyContext({
      reply_to_message: { text: "x".repeat(4200), caption: null, from_user: { id: 2 } },
    });

    expect(result).toMatch(/^\[Reply to: x+/);
    expect(result?.endsWith("...]")).toBe(true);
  });

  it("returns no reply context when reply has no text or caption", async () => {
    const [channel] = channelWithBot();

    expect(await channel.extractReplyContext({ reply_to_message: { text: null, caption: null } })).toBeNull();
  });

  it("includes reply context in incoming message content", async () => {
    const [channel] = channelWithBot({ groupPolicy: "open" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.addReaction = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice", first_name: "Alice" },
      message: {
        message_id: 8,
        chat_id: 123,
        chat: { type: "private" },
        text: "translate this",
        reply_to_message: { message_id: 2, text: "Hello", from_user: { id: 1 } },
      },
    }, {});

    expect(handled).toHaveLength(1);
    expect(handled[0].content).toContain("[Reply to: Hello]");
    expect(handled[0].content).toContain("translate this");
  });

  it("ignores unmentioned group messages when group policy requires mentions", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 9, chat_id: -100, chat: { type: "group" }, text: "hello everyone" },
    }, {});

    expect(handled).toEqual([]);
  });

  it("accepts text mentions in groups and caches bot identity", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.addReaction = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: {
        message_id: 10,
        chat_id: -100,
        chat: { type: "group" },
        text: "hey @memmy_bot",
        entities: [{ type: "mention", offset: 4, length: 10 }],
      },
    }, {});

    expect(handled).toHaveLength(1);
    expect(channel.botUsername).toBe("memmy_bot");
  });

  it("accepts caption mentions in groups", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.addReaction = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: {
        message_id: 11,
        chat_id: -100,
        chat: { type: "group" },
        caption: "see @memmy_bot",
        caption_entities: [{ type: "mention", offset: 4, length: 10 }],
      },
    }, {});

    expect(handled).toHaveLength(1);
  });

  it("accepts replies to the bot in groups", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.addReaction = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: {
        message_id: 12,
        chat_id: -100,
        chat: { type: "group" },
        text: "answer",
        reply_to_message: { text: "bot said", from_user: { id: 999 } },
      },
    }, {});

    expect(handled).toHaveLength(1);
  });

  it("accepts plain group messages when group policy is open", async () => {
    const [channel] = channelWithBot({ groupPolicy: "open" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.addReaction = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 13, chat_id: -100, chat: { type: "group" }, text: "plain group" },
    }, {});

    expect(handled).toHaveLength(1);
  });

  it("forwards Telegram location content", async () => {
    const [channel] = channelWithBot();
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.addReaction = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: {
        message_id: 14,
        chat_id: 123,
        chat: { type: "private" },
        location: { latitude: 31.2, longitude: 121.5 },
      },
    }, {});

    expect(handled[0].content).toContain("[location: 31.2, 121.5]");
  });

  it("automatically flushes buffered media group messages", async () => {
    vi.useFakeTimers();
    try {
      const [channel] = channelWithBot();
      const handled: any[] = [];
      channel.startTyping = vi.fn();
      channel.addReaction = vi.fn(async () => undefined);
      channel.handleMessage = async (kwargs: any) => {
        handled.push(kwargs);
      };

      await channel.processMessageUpdate({
        effective_user: { id: 42, username: "alice" },
        message: {
          message_id: 21,
          chat_id: 123,
          chat: { type: "private" },
          media_group_id: "album-1",
          caption: "first",
        },
      }, {});
      await channel.processMessageUpdate({
        effective_user: { id: 42, username: "alice" },
        message: {
          message_id: 22,
          chat_id: 123,
          chat: { type: "private" },
          media_group_id: "album-1",
          caption: "second",
        },
      }, {});

      expect(handled).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(601);

      expect(handled).toHaveLength(1);
      expect(handled[0].content).toBe("first\nsecond");
      expect(handled[0].chatId).toBe("123");
      expect(handled[0].metadata.message_id).toBe(21);
    } finally {
      vi.useRealTimers();
    }
  });

  it("combines Telegram location content with text", async () => {
    const [channel] = channelWithBot();
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.addReaction = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: {
        message_id: 15,
        chat_id: 123,
        chat: { type: "private" },
        text: "meet here",
        location: { latitude: 31.2, longitude: 121.5 },
      },
    }, {});

    expect(handled[0].content).toContain("meet here");
    expect(handled[0].content).toContain("[location: 31.2, 121.5]");
  });

  it("strips bot suffixes and normalizes dream aliases in forwarded commands", async () => {
    const [channel] = channelWithBot({ allowFrom: ["42"] });
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processForwardCommand({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 16, chat_id: 123, chat: { type: "private" }, text: "/dream_log@memmy_bot latest" },
    }, {});

    expect(handled[0].content).toBe("/dream-log latest");
  });

  it("does not inject reply context into forwarded commands", async () => {
    const [channel] = channelWithBot({ allowFrom: ["42"] });
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.processForwardCommand({
      effective_user: { id: 42, username: "alice" },
      message: {
        message_id: 17,
        chat_id: 123,
        chat: { type: "private" },
        text: "/status",
        reply_to_message: { text: "prior" },
      },
    }, {});

    expect(handled[0].content).toBe("/status");
  });

  it("matches Telegram-safe bus slash commands", () => {
    expect(TelegramChannel.TELEGRAM_BUS_SLASH_COMMAND_RE.test("/dream@memmy_bot now")).toBe(true);
    expect(TelegramChannel.TELEGRAM_BUS_SLASH_COMMAND_RE.test("/dream_log latest")).toBe(false);
  });

  it("builds no keyboard when inline keyboard support is disabled", () => {
    const channel = new TelegramChannel(new TelegramConfig({ inlineKeyboards: false }), new MessageBus());

    expect(channel.buildKeyboard([["A", "B"]])).toBeNull();
  });

  it("builds native inline keyboards when enabled", () => {
    const channel = new TelegramChannel(new TelegramConfig({ inlineKeyboards: true }), new MessageBus());

    expect(channel.buildKeyboard([["Yes", "No"], ["Cancel"]])).toEqual({
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "Yes" },
          { text: "No", callback_data: "No" },
        ],
        [{ text: "Cancel", callback_data: "Cancel" }],
      ],
    });
  });

  it("truncates callback data at the UTF-8 boundary", () => {
    const longAscii = "a".repeat(100);
    const asciiOut = TelegramChannel.safeCallbackData(longAscii);
    const longCjk = "同意并继续下一步，我已阅读并同意了服务条款以及隐私政策";
    const cjkOut = TelegramChannel.safeCallbackData(longCjk);

    expect(Buffer.from(asciiOut).length).toBeLessThanOrEqual(64);
    expect(longAscii.startsWith(asciiOut)).toBe(true);
    expect(Buffer.from(cjkOut).length).toBeLessThanOrEqual(64);
    expect(longCjk.startsWith(cjkOut)).toBe(true);
  });

  it("formats button rows as fallback text", () => {
    expect(TelegramChannel.buttonsAsText([["Yes", "No"], ["Cancel"]])).toBe("[Yes] [No]\n[Cancel]");
    expect(TelegramChannel.buttonsAsText([[], ["A"]])).toBe("[A]");
  });

  it("falls back buttons to inline text when native keyboards are disabled", async () => {
    const [channel, bot] = channelWithBot({ inlineKeyboards: false });

    await channel.send(
      new OutboundMessage({
        channel: "telegram",
        chatId: "123",
        content: "Choose",
        buttons: [["Yes", "No"], ["Cancel"]],
      }),
    );

    expect(bot.send_message.mock.calls[0][0].text).toContain("[Yes] [No]\n[Cancel]");
    expect(bot.send_message.mock.calls[0][0].reply_markup).toBeNull();
  });

  it("uses native keyboards when inline keyboard support is enabled", async () => {
    const [channel, bot] = channelWithBot({ inlineKeyboards: true });

    await channel.send(
      new OutboundMessage({
        channel: "telegram",
        chatId: "123",
        content: "Choose",
        buttons: [["Yes"]],
      }),
    );

    expect(bot.send_message.mock.calls[0][0].text).not.toContain("[Yes]");
    expect(bot.send_message.mock.calls[0][0].reply_markup).toEqual({
      inline_keyboard: [[{ text: "Yes", callback_data: "Yes" }]],
    });
  });

  it("ignores unauthorized callback queries before side effects", async () => {
    const [channel] = channelWithBot({ allowFrom: ["42"] });
    const handled: any[] = [];
    const query = {
      id: "cb1",
      data: "Yes",
      answer: vi.fn(async () => undefined),
      message: { chat_id: 123, edit_reply_markup: vi.fn(async () => undefined) },
    };
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onCallbackQuery({ effective_user: { id: 7, username: "mallory" }, callback_query: query }, {});

    expect(query.answer).not.toHaveBeenCalled();
    expect(query.message.edit_reply_markup).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
  });

  it("forwards authorized callback query data", async () => {
    const [channel] = channelWithBot({ allowFrom: ["42"] });
    const handled: any[] = [];
    const query = {
      id: "cb1",
      data: "Yes",
      answer: vi.fn(async () => undefined),
      message: { chat_id: 123, edit_reply_markup: vi.fn(async () => undefined) },
    };
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onCallbackQuery({ effective_user: { id: 42, username: "alice", first_name: "Alice" }, callback_query: query }, {});

    expect(query.answer).toHaveBeenCalled();
    expect(query.message.edit_reply_markup).toHaveBeenCalled();
    expect(handled[0].content).toBe("Yes");
    expect(handled[0].metadata.is_callback).toBe(true);
  });
});

describe("Telegram channel parity with memmy Telegram channel", () => {
  it("webhook config requires https url and secret", () => {
    expect(
      () => new TelegramConfig({ enabled: true, token: "123:abc", mode: "webhook", webhookUrl: "http://example.com/telegram", webhookSecretToken: "secret" }),
    ).toThrow(/public HTTPS URL/);
    expect(
      () => new TelegramConfig({ enabled: true, token: "123:abc", mode: "webhook", webhookUrl: "https://example.com/telegram" }),
    ).toThrow(/webhookSecretToken/);
  });

  it("derive topic session key uses thread id", () => {
    expect(TelegramChannel.deriveTopicSessionKey({ chat_id: -100123, message_thread_id: 42 })).toBe("telegram:-100123:topic:42");
  });

  it("derive topic session key private dm thread", () => {
    expect(TelegramChannel.deriveTopicSessionKey({ chat_id: 123, message_thread_id: 7 })).toBe("telegram:123:topic:7");
  });

  it("derive topic session key none without thread", () => {
    expect(TelegramChannel.deriveTopicSessionKey({ chat_id: 123 })).toBeNull();
  });

  it("get extension falls back to original filename", () => {
    const channel = new TelegramChannel(new TelegramConfig(), new MessageBus());
    expect(channel.getExtension("file", null, "report.pdf")).toBe(".pdf");
    expect(channel.getExtension("file", null, "archive.tar.gz")).toBe(".tar.gz");
  });

  it("telegram group policy defaults to mention", () => {
    expect(new TelegramConfig().groupPolicy).toBe("mention");
  });

  it("is allowed accepts legacy telegram id username formats", () => {
    const channel = new TelegramChannel(new TelegramConfig({ allowFrom: ["12345", "alice", "67890|bob"] }), new MessageBus());
    expect(channel.isAllowed("12345|carol")).toBe(true);
    expect(channel.isAllowed("99999|alice")).toBe(true);
    expect(channel.isAllowed("67890|bob")).toBe(true);
  });

  it("is allowed rejects invalid legacy telegram sender shapes", () => {
    const channel = new TelegramChannel(new TelegramConfig({ allowFrom: ["alice"] }), new MessageBus());
    expect(channel.isAllowed("attacker|alice|extra")).toBe(false);
    expect(channel.isAllowed("not-a-number|alice")).toBe(false);
  });

  it("send progress keeps message in topic", async () => {
    const [channel, bot] = channelWithBot();
    await channel.send(new OutboundMessage({ channel: "telegram", chatId: "123", content: "hello", metadata: { agentProgress: true, message_thread_id: 42 } }));
    expect(bot.send_message.mock.calls[0][0].message_thread_id).toBe(42);
  });

  it("send reply infers topic from message id cache", async () => {
    const [channel, bot] = channelWithBot({ replyToMessage: true });
    channel.messageThreads.set("123:10", 42);
    await channel.send(new OutboundMessage({ channel: "telegram", chatId: "123", content: "hello", metadata: { message_id: 10 } }));
    expect(bot.send_message.mock.calls[0][0].message_thread_id).toBe(42);
    expect(bot.send_message.mock.calls[0][0].reply_parameters.message_id).toBe(10);
  });

  it("group policy mention ignores unmentioned group message", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({ effective_user: { id: 42, username: "alice" }, message: { message_id: 9, chat_id: -100, chat: { type: "group" }, text: "hello everyone" } }, {});
    expect(handled).toEqual([]);
  });

  it("group policy mention accepts text mention and caches bot identity", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 10, chat_id: -100, chat: { type: "group" }, text: "hey @memmy_bot", entities: [{ type: "mention", offset: 4, length: 10 }] },
    }, {});
    expect(handled).toHaveLength(1);
    expect(channel.botUsername).toBe("memmy_bot");
  });

  it("group policy mention accepts caption mention", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 11, chat_id: -100, chat: { type: "group" }, caption: "see @memmy_bot", caption_entities: [{ type: "mention", offset: 4, length: 10 }] },
    }, {});
    expect(handled).toHaveLength(1);
  });

  it("group policy mention accepts reply to bot", async () => {
    const [channel] = channelWithBot({ groupPolicy: "mention" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 12, chat_id: -100, chat: { type: "group" }, text: "answer", reply_to_message: { text: "bot said", from_user: { id: 999 } } },
    }, {});
    expect(handled).toHaveLength(1);
  });

  it("group policy open accepts plain group message", async () => {
    const [channel] = channelWithBot({ groupPolicy: "open" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({ effective_user: { id: 42, username: "alice" }, message: { message_id: 13, chat_id: -100, chat: { type: "group" }, text: "plain group" } }, {});
    expect(handled).toHaveLength(1);
  });

  it("extract reply context no reply", async () => {
    const [channel] = channelWithBot();
    expect(await channel.extractReplyContext({ reply_to_message: null })).toBeNull();
  });

  it("extract reply context with text", async () => {
    const [channel] = channelWithBot();
    expect(await channel.extractReplyContext({ reply_to_message: { text: "Hello world", from_user: { id: 2, username: "testuser", first_name: "Test" } } })).toBe("[Reply to @testuser: Hello world]");
  });

  it("extract reply context with caption only", async () => {
    const [channel] = channelWithBot();
    expect(await channel.extractReplyContext({ reply_to_message: { caption: "Photo caption", from_user: { id: 2, first_name: "Test" } } })).toBe("[Reply to Test: Photo caption]");
  });

  it("extract reply context truncation", async () => {
    const [channel] = channelWithBot();
    const result = await channel.extractReplyContext({ reply_to_message: { text: "x".repeat(4200), from_user: { id: 2 } } });
    expect(result).toMatch(/^\[Reply to: x+/);
    expect(result?.endsWith("...]")).toBe(true);
  });

  it("extract reply context no text returns none", async () => {
    const [channel] = channelWithBot();
    expect(await channel.extractReplyContext({ reply_to_message: { text: null, caption: null } })).toBeNull();
  });

  it("on message includes reply context", async () => {
    const [channel] = channelWithBot({ groupPolicy: "open" });
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 8, chat_id: 123, chat: { type: "private" }, text: "translate this", reply_to_message: { message_id: 2, text: "Hello", from_user: { id: 1 } } },
    }, {});
    expect(handled[0].content).toContain("[Reply to: Hello]");
    expect(handled[0].content).toContain("translate this");
  });

  it("forward command does not inject reply context", async () => {
    const [channel] = channelWithBot({ allowFrom: ["42"] });
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processForwardCommand({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 17, chat_id: 123, chat: { type: "private" }, text: "/status", reply_to_message: { text: "prior" } },
    }, {});
    expect(handled[0].content).toBe("/status");
  });

  it("forward command preserves dream log args and strips bot suffix", async () => {
    const [channel] = channelWithBot({ allowFrom: ["42"] });
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processForwardCommand({
      effective_user: { id: 42, username: "alice" },
      message: { message_id: 16, chat_id: 123, chat: { type: "private" }, text: "/dream_log@memmy_bot latest" },
    }, {});
    expect(handled[0].content).toBe("/dream-log latest");
  });

  it("normalizes Telegram-safe dream command aliases", () => {
    expect(TelegramChannel.normalizeTelegramCommand("/dream_log latest")).toBe("/dream-log latest");
    expect(TelegramChannel.normalizeTelegramCommand("/dream_restore 3")).toBe("/dream-restore 3");
  });

  it("matches Telegram bus slash commands", () => {
    expect(TelegramChannel.TELEGRAM_BUS_SLASH_COMMAND_RE.test("/dream@memmy_bot now")).toBe(true);
    expect(TelegramChannel.TELEGRAM_BUS_SLASH_COMMAND_RE.test("/dream_log latest")).toBe(false);
  });

  it("on message location content", async () => {
    const [channel] = channelWithBot();
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({ effective_user: { id: 42, username: "alice" }, message: { message_id: 14, chat_id: 123, chat: { type: "private" }, location: { latitude: 31.2, longitude: 121.5 } } }, {});
    expect(handled[0].content).toContain("[location: 31.2, 121.5]");
  });

  it("on message location with text", async () => {
    const [channel] = channelWithBot();
    const handled: any[] = [];
    channel.startTyping = vi.fn();
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    await channel.processMessageUpdate({ effective_user: { id: 42, username: "alice" }, message: { message_id: 15, chat_id: 123, chat: { type: "private" }, text: "meet here", location: { latitude: 31.2, longitude: 121.5 } } }, {});
    expect(handled[0].content).toContain("meet here");
    expect(handled[0].content).toContain("[location: 31.2, 121.5]");
  });

  it("renders headers as bold HTML", () => {
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
  });

  it("preserves numbered lists in HTML", () => {
    const result = markdownToTelegramHtml("1. First\n2. Second");
    expect(result).toContain("1. First");
    expect(result).toContain("2. Second");
  });

  it("normalizes numbered list whitespace in HTML", () => {
    expect(markdownToTelegramHtml("1.   Lots of space")).toContain("1. Lots of space");
  });

  it("keeps escaped characters in header HTML", () => {
    expect(markdownToTelegramHtml("# A < B & C > D")).toBe("<b>A &lt; B &amp; C &gt; D</b>");
  });

  it("renders mixed markdown formatting", () => {
    const result = markdownToTelegramHtml("# Overview\n\n- bullet\n\n1. step\n\n**bold**");
    expect(result).toContain("<b>Overview</b>");
    expect(result).toContain("• bullet");
    expect(result).toContain("1. step");
    expect(result).toContain("<b>bold</b>");
  });

  it("strips inline formatting from markdown blocks", () => {
    expect(stripMdBlock("**bold** and _italic_ and ~~struck~~")).toBe("bold and italic and struck");
  });

  it("strips headers from markdown blocks", () => {
    expect(stripMdBlock("## Title\nBody")).toBe("Title\nBody");
  });

  it("converts bullets and numbers in markdown blocks", () => {
    const result = stripMdBlock("- item a\n1. item b\n2. item c");
    expect(result).toContain("• item a");
    expect(result).toContain("1. item b");
    expect(result).toContain("2. item c");
  });

  it("strips links from markdown blocks", () => {
    expect(stripMdBlock("[click here](https://example.com)")).toBe("click here");
  });
});
