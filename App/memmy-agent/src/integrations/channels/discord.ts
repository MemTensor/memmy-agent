import fs from "node:fs/promises";
import path from "node:path";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { splitMessage } from "../../utils/helpers.js";
import { BaseChannel } from "./base.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_LEN = 2000;
export const TYPING_INTERVAL_S = 8;

type StreamBuf = { text: string; message: any | null; lastEdit: number; streamId: string | null };

export class DiscordConfig {
  enabled = false;
  token = "";
  allowFrom: string[] = [];
  allowChannels: string[] = [];
  intents = 37377;
  groupPolicy = "mention";
  readReceiptEmoji = "👀";
  workingEmoji = "🔧";
  workingEmojiDelay = 2.0;
  streaming = true;
  proxy: string | null = null;
  proxyUsername: string | null = null;
  proxyPassword: string | null = null;

  constructor(init: Partial<DiscordConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.token = init.token ?? this.token;
    this.allowFrom = init.allowFrom ?? [];
    this.allowChannels = init.allowChannels ?? [];
    this.intents = init.intents ?? this.intents;
    this.groupPolicy = init.groupPolicy ?? this.groupPolicy;
    this.readReceiptEmoji = init.readReceiptEmoji ?? this.readReceiptEmoji;
    this.workingEmoji = init.workingEmoji ?? this.workingEmoji;
    this.workingEmojiDelay = init.workingEmojiDelay ?? this.workingEmojiDelay;
    this.streaming = init.streaming ?? this.streaming;
    this.proxy = init.proxy ?? null;
    this.proxyUsername = init.proxyUsername ?? null;
    this.proxyPassword = init.proxyPassword ?? null;
  }
}

function channelParentKey(channel: any): string | null {
  const parentId = channel?.parent_id ?? channel?.parentId ?? channel?.parent?.id;
  return parentId == null ? null : String(parentId);
}

function channelAllowKeys(channel: any): Set<string> {
  const keys = new Set<string>();
  if (channel?.id != null) keys.add(String(channel.id));
  const parent = channelParentKey(channel);
  if (parent) keys.add(parent);
  return keys;
}

function safeFilename(name: string): string {
  return path.basename(name).replace(/[^\w.\-]+/g, "_") || "attachment.bin";
}

export class DiscordBotClient {
  channel: DiscordChannel;
  channels: Record<number, any> = {};
  sdkClient: any = null;
  closed = false;
  ready = false;
  opts: any;

  constructor(channel: DiscordChannel, opts: any = {}) {
    this.channel = channel;
    this.opts = opts;
  }

  async start(token: string): Promise<void> {
    const { Client } = await import("discord.js");
    this.sdkClient = new Client({ intents: this.opts.intents });
    this.sdkClient.on?.("ready", () => {
      this.ready = true;
      const userId = this.sdkClient?.user?.id;
      if (userId) this.channel.botUserId = String(userId);
    });
    this.sdkClient.on?.("messageCreate", (message: any) => {
      void this.channel.onMessage(this.normalizeMessage(message));
    });
    await this.sdkClient.login(token);
    this.ready = Boolean(this.sdkClient?.isReady?.() ?? true);
    const userId = this.sdkClient?.user?.id;
    if (userId) this.channel.botUserId = String(userId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.sdkClient?.destroy?.();
    this.sdkClient = null;
    this.ready = false;
  }

  isClosed(): boolean {
    return this.closed;
  }

  isReady(): boolean {
    return this.ready;
  }

  getChannel(channelId: number): any {
    return (
      this.channels[channelId] ?? this.sdkClient?.channels?.cache?.get?.(String(channelId)) ?? null
    );
  }

  async fetchChannel(channelId: number): Promise<any> {
    return (await this.sdkClient?.channels?.fetch?.(String(channelId))) ?? null;
  }

  normalizeMessage(message: any): any {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : typeof message.attachments?.values === "function"
        ? [...message.attachments.values()]
        : [];
    const mentions = Array.isArray(message.mentions)
      ? message.mentions
      : typeof message.mentions?.users?.values === "function"
        ? [...message.mentions.users.values()]
        : [];
    // A discord.js Message's channel/guild/author/reference are mostly prototype getters that a {...message} spread drops,
    // which makes onMessage crash reading channel.id. Read them explicitly (triggering the getters) and override, so these fields stay on the normalized object.
    return {
      ...message,
      channel: message.channel,
      guild: message.guild,
      author: message.author,
      reference: message.reference,
      attachments,
      mentions,
    };
  }

  static buildChunks(content: string, media: string[] = [], includeMediaMarkers = true): string[] {
    const suffix =
      includeMediaMarkers && media.length
        ? `\n${media.map((m) => `[attachment: ${path.basename(m)}]`).join("\n")}`
        : "";
    return splitMessage(`${content}${suffix}`, MAX_MESSAGE_LEN);
  }

  async sendOutbound(msg: OutboundMessage): Promise<void> {
    const channelId = Number(msg.chatId);
    let channel = this.channel.knownChannels[msg.chatId] ?? this.getChannel(channelId);
    if (!channel) {
      try {
        channel = await this.fetchChannel(channelId);
      } catch {
        return;
      }
    }
    if (!channel) return;
    this.channel.rememberChannel(channel);
    const chunks = DiscordBotClient.buildChunks(msg.content, [], false);
    for (const [index, chunk] of chunks.entries()) {
      const payload: Record<string, any> = { content: chunk };
      const replyTo = msg.metadata?.reply_to;
      if (index === 0 && replyTo && typeof channel.getPartialMessage === "function") {
        payload.reference = channel.getPartialMessage(Number(replyTo));
        payload.mention_author = false;
      }
      await channel.send(payload);
    }
    for (const mediaPath of msg.media ?? []) {
      await channel.send({ file: { filename: path.basename(mediaPath), path: mediaPath } });
    }
  }
}

export class DiscordChannel extends BaseChannel {
  override name = "discord";
  override displayName = "Discord";
  override config: DiscordConfig;
  client: DiscordBotClient | null = null;
  botUserId: string | null = null;
  knownChannels: Record<string, any> = {};
  typingTasks: Record<string, Promise<void>> = {};
  streamBuffers: Record<string, StreamBuf> = {};

  static override defaultConfig(): Record<string, any> {
    return new DiscordConfig() as any;
  }

  constructor(config: Partial<DiscordConfig> = {}, bus?: any) {
    super("discord", config instanceof DiscordConfig ? config : new DiscordConfig(config), bus);
    this.config = config instanceof DiscordConfig ? config : new DiscordConfig(config);
  }

  override get supportsStreaming(): boolean {
    return Boolean(this.config.streaming);
  }

  async start(): Promise<void> {
    if (!this.config.token) return;
    this.client = new DiscordBotClient(this, { intents: this.config.intents });
    try {
      await this.client.start(this.config.token);
      this.running = true;
    } catch {
      await this.client.close();
      this.client = null;
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.client) await this.client.close();
    this.client = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.client || this.client.isClosed() || !this.client.isReady()) return;
    await this.client.sendOutbound(msg);
  }

  rememberChannel(channel: any): void {
    if (channel?.id != null) this.knownChannels[String(channel.id)] = channel;
  }

  forgetChannel(channel: any): void {
    if (channel?.id != null) delete this.knownChannels[String(channel.id)];
  }

  channelAllowKeys(channel: any): Set<string> {
    return channelAllowKeys(channel);
  }

  channelParentKey(channel: any): string | null {
    return channelParentKey(channel);
  }

  isChannelAllowed(channel: any): boolean {
    if (!this.config.allowChannels.length) return true;
    const keys = channelAllowKeys(channel);
    return this.config.allowChannels.some((allowed) => keys.has(String(allowed)));
  }

  isBotMentioned(message: any): boolean {
    const id = this.botUserId;
    if (!id) return false;
    return (
      (message.mentions ?? []).some((user: any) => String(user.id) === id) ||
      (message.rawMentions ?? []).some((userId: any) => String(userId) === id) ||
      String(message.content ?? "").includes(`<@${id}>`)
    );
  }

  async saveAttachments(attachments: any[]): Promise<[string[], string[]]> {
    const mediaDir = getMediaDir("discord");
    await fs.mkdir(mediaDir, { recursive: true });
    const media: string[] = [];
    const markers: string[] = [];
    for (const attachment of attachments) {
      const filename = safeFilename(attachment.filename ?? "attachment.bin");
      if (Number(attachment.size ?? 0) > MAX_ATTACHMENT_BYTES) {
        markers.push(`[attachment: ${filename} - too large]`);
        continue;
      }
      const dest = path.join(mediaDir, `${attachment.id ?? Date.now()}_${filename}`);
      try {
        if (typeof attachment.save === "function") await attachment.save(dest);
        else if (attachment.content) await fs.writeFile(dest, attachment.content);
        else await fs.writeFile(dest, Buffer.alloc(0));
        media.push(dest);
        markers.push(`[attachment: ${filename}]`);
      } catch {
        markers.push(`[attachment: ${filename} - download failed]`);
      }
    }
    return [media, markers];
  }

  async onMessage(message: any): Promise<void> {
    const authorId = String(message.author?.id ?? "");
    if (authorId && authorId === this.botUserId) return;
    if (!this.isAllowed(authorId)) return;
    const channel = message.channel;
    // Skip when no channel is available: better to drop a single message than let an uncaught exception take down the whole gateway process.
    if (!channel) return;
    this.rememberChannel(channel);
    if (!this.isChannelAllowed(channel)) return;
    const isGuild = message.guild != null;
    const isThread = channelParentKey(channel) != null;
    const isReplyToBot = String(message.reference?.resolved?.author?.id ?? "") === this.botUserId;
    if (
      isGuild &&
      this.config.groupPolicy === "mention" &&
      !this.isBotMentioned(message) &&
      !isThread &&
      !isReplyToBot
    )
      return;

    const [media, markers] = await this.saveAttachments(message.attachments ?? []);
    const content = [
      String(message.content ?? "")
        .replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "")
        .trim(),
      ...markers,
    ]
      .filter(Boolean)
      .join("\n");
    const metadata: Record<string, any> = {
      message_id: String(message.id ?? ""),
      guild_id: message.guild?.id != null ? String(message.guild.id) : null,
      reply_to: message.reference?.message_id != null ? String(message.reference.message_id) : null,
    };
    let sessionKey: string | null = null;
    const parentId = channelParentKey(channel);
    if (parentId) {
      metadata.parent_channel_id = parentId;
      metadata.contextChatId = parentId;
      metadata.thread_id = String(channel.id);
      sessionKey = `discord:${parentId}:thread:${channel.id}`;
    }
    await this.handleMessage({
      senderId: authorId,
      chatId: String(channel.id),
      content,
      media,
      metadata,
      sessionKey,
      isDm: !isGuild,
    });
  }

  async sendDelta(
    chatId: string,
    delta: string,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    if (!this.client) return;
    const streamId = metadata.streamId ?? chatId;
    const key = `${chatId}:${streamId}`;
    const buf = this.streamBuffers[key] ?? { text: "", message: null, lastEdit: 0, streamId };
    buf.text += delta;
    const channel = this.knownChannels[chatId] ?? this.client.getChannel(Number(chatId));
    if (!channel) return;
    if (!buf.message) {
      buf.message = await channel.send({ content: buf.text || " " });
    } else if (!metadata.streamEnd || delta) {
      await buf.message.edit({
        content: DiscordBotClient.buildChunks(buf.text, [], false)[0] || " ",
      });
    }
    if (metadata.streamEnd) {
      const chunks = DiscordBotClient.buildChunks(buf.text, [], false);
      if (chunks.length) await buf.message.edit({ content: chunks[0] });
      for (const chunk of chunks.slice(1)) await channel.send({ content: chunk });
      delete this.streamBuffers[key];
    } else {
      this.streamBuffers[key] = buf;
    }
  }
}
