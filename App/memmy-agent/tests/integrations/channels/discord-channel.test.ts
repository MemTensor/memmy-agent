import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  DiscordBotClient,
  DiscordChannel,
  DiscordConfig,
  MAX_MESSAGE_LEN,
} from "../../../src/integrations/channels/discord.js";

const discordSdkMock = vi.hoisted(() => {
  const api: any = { instances: [] as any[] };
  function Client(this: any, opts: any) {
    this.opts = opts;
    this.user = { id: "bot-user" };
    this.handlers = new Map<string, any>();
    this.channels = { cache: new Map(), fetch: vi.fn(async () => null) };
    this.on = vi.fn((event: string, handler: any) => {
      this.handlers.set(event, handler);
      return this;
    });
    this.login = vi.fn(async () => undefined);
    this.destroy = vi.fn(async () => undefined);
    this.isReady = vi.fn(() => true);
    api.instances.push(this);
  }
  api.Client = vi.fn(Client);
  api.reset = () => {
    api.instances = [];
    api.Client.mockClear();
    api.Client.mockImplementation(Client);
  };
  return api;
});

vi.mock("discord.js", () => ({ Client: discordSdkMock.Client }));

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-discord-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  discordSdkMock.reset();
  process.env.MEMMY_CONFIG = oldConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeSentMessage {
  content: string;
  edits: any[] = [];
  constructor(content: string) {
    this.content = content;
  }
  async edit(kwargs: any): Promise<void> {
    this.edits.push(kwargs);
    if (kwargs.content != null) this.content = kwargs.content;
  }
}

class FakeChannel {
  id: number;
  parentId: number | null;
  sentPayloads: any[] = [];
  sentMessages: FakeSentMessage[] = [];
  constructor(id = 123, parentId: number | null = null) {
    this.id = id;
    this.parentId = parentId;
  }
  async send(kwargs: any): Promise<FakeSentMessage> {
    this.sentPayloads.push(kwargs);
    const msg = new FakeSentMessage(kwargs.content ?? "");
    this.sentMessages.push(msg);
    return msg;
  }
  getPartialMessage(messageId: number): any {
    return { id: messageId };
  }
}

function makeMessage(opts: any = {}): any {
  return {
    author: { id: opts.authorId ?? 123, bot: opts.authorBot ?? false },
    channel: new FakeChannel(opts.channelId ?? 456, opts.parentChannelId ?? null),
    content: opts.content ?? "hello",
    guild: opts.guildId != null ? { id: opts.guildId } : null,
    mentions: opts.mentions ?? [],
    rawMentions: opts.rawMentions ?? [],
    attachments: opts.attachments ?? [],
    reference:
      opts.replyTo != null
        ? { message_id: opts.replyTo, resolved: { author: { id: opts.replyAuthorId } } }
        : null,
    id: opts.messageId ?? 789,
  };
}

class FakeAttachment {
  id: number;
  filename: string;
  size: number;
  fail: boolean;
  constructor(id: number, filename: string, { size = 1, fail = false } = {}) {
    this.id = id;
    this.filename = filename;
    this.size = size;
    this.fail = fail;
  }
  async save(dest: string): Promise<void> {
    if (this.fail) throw new Error("save failed");
    fs.writeFileSync(dest, "attachment", "utf8");
  }
}

describe("DiscordChannel", () => {
  it("creates a discord.js client when a token is configured", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, token: "discord-token", allowFrom: ["*"], intents: 123 }),
      new MessageBus(),
    );

    await channel.start();

    expect(discordSdkMock.Client).toHaveBeenCalledWith({ intents: 123 });
    expect(discordSdkMock.instances[0].login).toHaveBeenCalledWith("discord-token");
    expect(channel.botUserId).toBe("bot-user");
    expect(channel.isRunning).toBe(true);
    await channel.stop();
    expect(discordSdkMock.instances[0].destroy).toHaveBeenCalled();
  });

  it("starts and stops safely without a token or with a partial client", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    await channel.start();
    expect(channel.isRunning).toBe(false);
    expect(channel.client).toBeNull();

    const client = new DiscordBotClient(channel);
    channel.client = client;
    channel.running = true;
    await channel.stop();
    expect(channel.isRunning).toBe(false);
    expect(client.closed).toBe(true);
    expect(channel.client).toBeNull();
  });

  it("sends through cached, fetched, and known thread channels", async () => {
    const owner = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const client = new DiscordBotClient(owner);
    const cached = new FakeChannel(123);
    client.channels[123] = cached;

    await client.sendOutbound(
      new OutboundMessage({
        channel: "discord",
        chatId: "123",
        content: "hello",
        metadata: { reply_to: "456" },
      }),
    );
    expect(cached.sentPayloads[0]).toMatchObject({ content: "hello", mention_author: false });
    expect(cached.sentPayloads[0].reference).toEqual({ id: 456 });

    const fetched = new FakeChannel(234);
    client.fetchChannel = vi.fn(async () => fetched);
    await client.sendOutbound(
      new OutboundMessage({ channel: "discord", chatId: "234", content: "fetched" }),
    );
    expect(fetched.sentPayloads).toEqual([{ content: "fetched" }]);

    const thread = new FakeChannel(777, 456);
    owner.knownChannels["777"] = thread;
    client.getChannel = () => null;
    client.fetchChannel = vi.fn(async () => {
      throw new Error("not found");
    });
    await client.sendOutbound(
      new OutboundMessage({ channel: "discord", chatId: "777", content: "thread" }),
    );
    expect(thread.sentPayloads).toEqual([{ content: "thread" }]);
  });

  it("builds chunks for oversized replies", () => {
    const chunks = DiscordBotClient.buildChunks(
      "a".repeat(MAX_MESSAGE_LEN - 10) + "b".repeat(50),
      [],
      false,
    );
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= MAX_MESSAGE_LEN)).toBe(true);
  });

  it("filters self messages, mention-only guild messages, and allow-channel threads", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({
        enabled: true,
        allowFrom: ["*"],
        allowChannels: ["456"],
        groupPolicy: "mention",
      }),
      new MessageBus(),
    );
    channel.botUserId = "999";
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(makeMessage({ authorId: 999, authorBot: true }));
    expect(handled).toEqual([]);

    await channel.onMessage(makeMessage({ guildId: 1, content: "hello everyone" }));
    expect(handled).toEqual([]);

    await channel.onMessage(
      makeMessage({
        guildId: 1,
        content: "<@999> hello",
        mentions: [{ id: 999 }],
        channelId: 777,
        parentChannelId: 456,
        replyTo: 321,
      }),
    );
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ chatId: "777", sessionKey: "discord:456:thread:777" });
    expect(handled[0].metadata).toMatchObject({
      reply_to: "321",
      contextChatId: "456",
      thread_id: "777",
    });
  });

  it("downloads attachments and marks failures", async () => {
    const root = tmpRoot();
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(
      makeMessage({ content: "see file", attachments: [new FakeAttachment(12, "photo.png")] }),
    );
    expect(handled[0].media[0]).toBe(path.join(root, "media", "discord", "12_photo.png"));
    expect(fs.existsSync(handled[0].media[0])).toBe(true);
    expect(handled[0].content).toContain("[attachment: photo.png]");

    handled.length = 0;
    await channel.onMessage(
      makeMessage({
        content: "",
        attachments: [new FakeAttachment(13, "bad.png", { fail: true })],
      }),
    );
    expect(handled[0].media).toEqual([]);
    expect(handled[0].content).toBe("[attachment: bad.png - download failed]");
  });

  it("preserves getter-based channel/guild through normalizeMessage (real discord.js message shape)", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const client = new DiscordBotClient(channel);
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    // A real discord.js Message's channel/guild are prototype getters, not own properties;
    // a {...message} spread drops them, making onMessage crash reading channel.id and taking down the whole gateway.
    const realChannel = new FakeChannel(456, null);
    const proto = {
      get channel() {
        return realChannel;
      },
      get guild() {
        return null;
      },
    };
    const message: any = Object.create(proto);
    message.author = { id: 123, bot: false };
    message.content = "hi";
    message.mentions = [];
    message.rawMentions = [];
    message.attachments = [];
    message.reference = null;
    message.id = 789;

    const normalized = client.normalizeMessage(message);
    expect(normalized.channel).toBe(realChannel);

    await channel.onMessage(normalized);
    expect(handled).toHaveLength(1);
    expect(handled[0].chatId).toBe("456");
  });

  it("streams deltas by editing one Discord message and splits oversized final output", async () => {
    const owner = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const client = new DiscordBotClient(owner);
    const target = new FakeChannel(123);
    client.channels[123] = target;
    owner.client = client;
    owner.running = true;

    await owner.sendDelta("123", "hel", { streamDelta: true, streamId: "s1" });
    await owner.sendDelta("123", "lo", { streamDelta: true, streamId: "s1" });
    await owner.sendDelta("123", "", { streamEnd: true, streamId: "s1" });
    expect(target.sentPayloads[0]).toEqual({ content: "hel" });
    expect(target.sentMessages[0].edits).toEqual([{ content: "hello" }, { content: "hello" }]);
    expect(owner.streamBuffers).toEqual({});
  });

  it("advertises streaming support from config", () => {
    expect(new DiscordChannel(new DiscordConfig({ streaming: true })).supportsStreaming).toBe(true);
    expect(new DiscordChannel(new DiscordConfig({ streaming: false })).supportsStreaming).toBe(
      false,
    );
  });
});

describe("DiscordChannel parity cases", () => {
  it("accepts allowFrom config", () => {
    expect(new DiscordConfig({ allowFrom: ["123"] }).allowFrom).toEqual(["123"]);
  });

  it("accepts allowChannels config", () => {
    expect(new DiscordConfig({ allowChannels: ["456"] }).allowChannels).toEqual(["456"]);
  });

  it("accepts groupPolicy config", () => {
    expect(new DiscordConfig({ groupPolicy: "open" }).groupPolicy).toBe("open");
  });

  it("accepts reaction and working emoji fields", () => {
    const config = new DiscordConfig({
      readReceiptEmoji: "EYES",
      workingEmoji: "TOOLS",
      workingEmojiDelay: 1.5,
    });

    expect(config.readReceiptEmoji).toBe("EYES");
    expect(config.workingEmoji).toBe("TOOLS");
    expect(config.workingEmojiDelay).toBe(1.5);
  });

  it("accepts proxy configuration fields", () => {
    const config = new DiscordConfig({
      proxy: "http://127.0.0.1:7890",
      proxyUsername: "u",
      proxyPassword: "p",
    });

    expect(config.proxy).toBe("http://127.0.0.1:7890");
    expect(config.proxyUsername).toBe("u");
    expect(config.proxyPassword).toBe("p");
  });

  it("can disable streaming support", () => {
    expect(new DiscordChannel(new DiscordConfig({ streaming: false })).supportsStreaming).toBe(
      false,
    );
  });

  it("allows every channel when allowChannels is empty", () => {
    const channel = new DiscordChannel(new DiscordConfig({ allowChannels: [] }));

    expect(channel.isChannelAllowed(new FakeChannel(123))).toBe(true);
  });

  it("allows channels explicitly listed in allowChannels", () => {
    const channel = new DiscordChannel(new DiscordConfig({ allowChannels: ["123"] }));

    expect(channel.isChannelAllowed(new FakeChannel(123))).toBe(true);
  });

  it("allows threads whose parent is listed in allowChannels", () => {
    const channel = new DiscordChannel(new DiscordConfig({ allowChannels: ["456"] }));

    expect(channel.isChannelAllowed(new FakeChannel(777, 456))).toBe(true);
  });

  it("extracts parent ids from parentId", () => {
    const channel = new DiscordChannel();

    expect(channel.channelParentKey(new FakeChannel(777, 456))).toBe("456");
  });

  it("extracts parent ids from parent objects", () => {
    const channel = new DiscordChannel();

    expect(channel.channelParentKey({ id: 777, parent: { id: 456 } })).toBe("456");
  });

  it("remembers channels by string id", () => {
    const channel = new DiscordChannel();
    const discordChannel = new FakeChannel(123);

    channel.rememberChannel(discordChannel);

    expect(channel.knownChannels["123"]).toBe(discordChannel);
  });

  it("forgets remembered channels", () => {
    const channel = new DiscordChannel();
    const discordChannel = new FakeChannel(123);
    channel.rememberChannel(discordChannel);

    channel.forgetChannel(discordChannel);

    expect(channel.knownChannels["123"]).toBeUndefined();
  });

  it("detects bot mentions from mention objects", () => {
    const channel = new DiscordChannel();
    channel.botUserId = "999";

    expect(channel.isBotMentioned(makeMessage({ mentions: [{ id: 999 }] }))).toBe(true);
  });

  it("detects bot mentions from raw mention ids", () => {
    const channel = new DiscordChannel();
    channel.botUserId = "999";

    expect(channel.isBotMentioned(makeMessage({ rawMentions: [999] }))).toBe(true);
  });

  it("detects bot mentions from inline mention text", () => {
    const channel = new DiscordChannel();
    channel.botUserId = "999";

    expect(channel.isBotMentioned(makeMessage({ content: "<@999> hello" }))).toBe(true);
  });

  it("does not report mentions before bot identity is known", () => {
    expect(new DiscordChannel().isBotMentioned(makeMessage({ content: "<@999> hello" }))).toBe(
      false,
    );
  });

  it("marks oversized attachments instead of saving them", async () => {
    tmpRoot();
    const channel = new DiscordChannel();

    const [media, markers] = await channel.saveAttachments([
      new FakeAttachment(1, "huge.bin", { size: 21 * 1024 * 1024 }),
    ]);

    expect(media).toEqual([]);
    expect(markers).toEqual(["[attachment: huge.bin - too large]"]);
  });

  it("saves attachment content into the Discord media directory", async () => {
    const root = tmpRoot();
    const channel = new DiscordChannel();

    const [media, markers] = await channel.saveAttachments([
      { id: 2, filename: "note.txt", size: 4, content: "demo" },
    ]);

    expect(media).toEqual([path.join(root, "media", "discord", "2_note.txt")]);
    expect(fs.readFileSync(media[0], "utf8")).toBe("demo");
    expect(markers).toEqual(["[attachment: note.txt]"]);
  });

  it("sanitizes downloaded attachment filenames", async () => {
    const root = tmpRoot();
    const channel = new DiscordChannel();

    const [media] = await channel.saveAttachments([
      { id: 3, filename: "../../bad name.txt", size: 4, content: "demo" },
    ]);

    expect(media[0]).toBe(path.join(root, "media", "discord", "3_bad_name.txt"));
  });

  it("returns empty media and markers for no attachments", async () => {
    await expect(new DiscordChannel().saveAttachments([])).resolves.toEqual([[], []]);
  });

  it("forwards allowlisted direct messages with metadata", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["123"] }),
      new MessageBus(),
    );
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(makeMessage({ authorId: 123, channelId: 456, messageId: 789 }));

    expect(handled[0]).toMatchObject({ chatId: "456", senderId: "123" });
    expect(handled[0].metadata).toEqual({ message_id: "789", guild_id: null, reply_to: null });
  });

  it("drops messages from users outside allowFrom", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["999"] }),
      new MessageBus(),
    );
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(makeMessage({ authorId: 123 }));

    expect(handled).toEqual([]);
  });

  it("drops messages from channels outside allowChannels", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"], allowChannels: ["999"] }),
      new MessageBus(),
    );
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(makeMessage({ channelId: 456 }));

    expect(handled).toEqual([]);
  });

  it("uses parent channel scoped session keys for threads", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({
        enabled: true,
        allowFrom: ["*"],
        allowChannels: ["456"],
        groupPolicy: "open",
      }),
      new MessageBus(),
    );
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(makeMessage({ guildId: 1, channelId: 777, parentChannelId: 456 }));

    expect(handled[0].sessionKey).toBe("discord:456:thread:777");
    expect(handled[0].metadata).toMatchObject({ contextChatId: "456", thread_id: "777" });
  });

  it("removes bot mention text from forwarded guild content", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"], groupPolicy: "mention" }),
      new MessageBus(),
    );
    channel.botUserId = "999";
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(
      makeMessage({ guildId: 1, content: "<@999> hello", mentions: [{ id: 999 }] }),
    );

    expect(handled[0].content).toBe("hello");
  });

  it("accepts guild replies to the bot even without a mention", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"], groupPolicy: "mention" }),
      new MessageBus(),
    );
    channel.botUserId = "999";
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(
      makeMessage({ guildId: 1, content: "follow up", replyTo: 111, replyAuthorId: 999 }),
    );

    expect(handled).toHaveLength(1);
    expect(handled[0].metadata.reply_to).toBe("111");
  });

  it("accepts messages from other bots", async () => {
    const channel = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    channel.botUserId = "999";
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.onMessage(makeMessage({ authorId: 123, authorBot: true }));

    expect(handled[0].senderId).toBe("123");
  });

  it("adds media markers when building chunks with media", () => {
    expect(DiscordBotClient.buildChunks("hello", ["/tmp/a.png"], true).join("\n")).toContain(
      "[attachment: a.png]",
    );
  });

  it("omits media markers when requested", () => {
    expect(DiscordBotClient.buildChunks("hello", ["/tmp/a.png"], false)).toEqual(["hello"]);
  });

  it("uses reply references only on the first outbound chunk", async () => {
    const owner = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const client = new DiscordBotClient(owner);
    const target = new FakeChannel(123);
    client.channels[123] = target;

    await client.sendOutbound(
      new OutboundMessage({
        channel: "discord",
        chatId: "123",
        content: "a".repeat(MAX_MESSAGE_LEN + 10),
        metadata: { reply_to: "55" },
      }),
    );

    expect(target.sentPayloads).toHaveLength(2);
    expect(target.sentPayloads[0].reference).toEqual({ id: 55 });
    expect(target.sentPayloads[1].reference).toBeUndefined();
  });

  it("sends outbound media after text chunks", async () => {
    const owner = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const client = new DiscordBotClient(owner);
    const target = new FakeChannel(123);
    client.channels[123] = target;

    await client.sendOutbound(
      new OutboundMessage({
        channel: "discord",
        chatId: "123",
        content: "hello",
        media: ["/tmp/demo.txt"],
      }),
    );

    expect(target.sentPayloads[0]).toEqual({ content: "hello" });
    expect(target.sentPayloads[1].file.filename).toBe("demo.txt");
  });

  it("skips outbound sends when fetch returns no channel", async () => {
    const owner = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const client = new DiscordBotClient(owner);
    client.fetchChannel = vi.fn(async () => null);

    await client.sendOutbound(
      new OutboundMessage({ channel: "discord", chatId: "123", content: "hello" }),
    );

    expect(client.fetchChannel).toHaveBeenCalledWith(123);
  });

  it("skips outbound sends when fetching the channel raises", async () => {
    const owner = new DiscordChannel(
      new DiscordConfig({ enabled: true, allowFrom: ["*"] }),
      new MessageBus(),
    );
    const client = new DiscordBotClient(owner);
    client.fetchChannel = vi.fn(async () => {
      throw new Error("not found");
    });

    await expect(
      client.sendOutbound(
        new OutboundMessage({ channel: "discord", chatId: "123", content: "hello" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("safely ignores send when no Discord client is attached", async () => {
    await expect(
      new DiscordChannel().send(
        new OutboundMessage({ channel: "discord", chatId: "123", content: "hello" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("safely ignores send when the Discord client is closed", async () => {
    const channel = new DiscordChannel();
    const client = new DiscordBotClient(channel);
    client.closed = true;
    channel.client = client;

    await expect(
      channel.send(new OutboundMessage({ channel: "discord", chatId: "123", content: "hello" })),
    ).resolves.toBeUndefined();
  });

  it("safely ignores send when the Discord client is not ready", async () => {
    const channel = new DiscordChannel();
    const client = new DiscordBotClient(channel);
    client.ready = false;
    channel.client = client;

    await expect(
      channel.send(new OutboundMessage({ channel: "discord", chatId: "123", content: "hello" })),
    ).resolves.toBeUndefined();
  });

  it("safely ignores streaming deltas without a client", async () => {
    await expect(
      new DiscordChannel().sendDelta("123", "hello", { streamId: "s1" }),
    ).resolves.toBeUndefined();
  });

  it("safely ignores streaming deltas when the channel cannot be resolved", async () => {
    const channel = new DiscordChannel();
    channel.client = new DiscordBotClient(channel);

    await channel.sendDelta("123", "hello", { streamId: "s1" });

    expect(channel.streamBuffers).toEqual({});
  });

  it("keeps independent streaming buffers per stream id", async () => {
    const channel = new DiscordChannel();
    const client = new DiscordBotClient(channel);
    const target = new FakeChannel(123);
    client.channels[123] = target;
    channel.client = client;

    await channel.sendDelta("123", "one", { streamId: "s1" });
    await channel.sendDelta("123", "two", { streamId: "s2" });

    expect(Object.keys(channel.streamBuffers).sort()).toEqual(["123:s1", "123:s2"]);
    expect(target.sentPayloads).toEqual([{ content: "one" }, { content: "two" }]);
  });
});
