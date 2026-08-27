import fs from "node:fs";
import path from "node:path";
import { BaseChannel } from "./base.js";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { validateUrlTarget } from "../../security/network.js";
import { splitMessage } from "../../utils/helpers.js";

export const TELEGRAM_MAX_MESSAGE_LEN = 4000;
export const TELEGRAM_HTML_MAX_LEN = 4096;
export const TELEGRAM_REPLY_CONTEXT_MAX_LEN = TELEGRAM_MAX_MESSAGE_LEN;
const SEND_MAX_RETRIES = 3;
const SEND_RETRY_BASE_DELAY_MS = 500;
const STREAM_EDIT_INTERVAL_DEFAULT = 0.6;
const MEDIA_GROUP_FLUSH_DELAY_MS = 600;

export function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function toolHintToTelegramBlockquote(text: string): string {
  return text ? `<blockquote expandable>${escapeTelegramHtml(text)}</blockquote>` : "";
}

export function stripMd(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function stripMdBlock(text: string): string {
  return text
    .replace(/```[\w]*\n?([\s\S]*?)```/g, "$1")
    .replace(/^#{1,6}\s+(.+)$/gm, "$1")
    .replace(/^>\s*(.*)$/gm, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/^(\d+)\.\s+/gm, "$1. ");
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text)
    width += /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(char)
      ? 2
      : 1;
  return width;
}

export function renderTableBox(tableLines: string[]): string {
  const rows: string[][] = [];
  let hasSep = false;
  for (const line of tableLines) {
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => stripMd(c.trim()));
    if (cells.every((c) => !c || /^:?-+:?$/.test(c))) {
      hasSep = true;
      continue;
    }
    rows.push(cells);
  }
  if (!rows.length || !hasSep) return tableLines.join("\n");
  const cols = Math.max(...rows.map((r) => r.length));
  for (const row of rows) while (row.length < cols) row.push("");
  const widths = [...Array(cols).keys()].map((i) =>
    Math.max(...rows.map((r) => displayWidth(r[i]))),
  );
  const draw = (row: string[]) =>
    row.map((c, i) => c + " ".repeat(widths[i] - displayWidth(c))).join("  ");
  return [
    draw(rows[0]),
    widths.map((w) => "─".repeat(w)).join("  "),
    ...rows.slice(1).map(draw),
  ].join("\n");
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return "";
  const codeBlocks: string[] = [];
  let text = markdown.replace(/```[\w]*\n?([\s\S]*?)```/g, (fullMatch, code) => {
    void fullMatch;
    codeBlocks.push(code);
    return `\0CB${codeBlocks.length - 1}\0`;
  });

  const lines = text.split("\n");
  const rebuilt: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (/^\s*\|.+\|/.test(lines[i])) {
      const table: string[] = [];
      while (i < lines.length && /^\s*\|.+\|/.test(lines[i])) table.push(lines[i++]);
      const box = renderTableBox(table);
      if (box !== table.join("\n")) {
        codeBlocks.push(box);
        rebuilt.push(`\0CB${codeBlocks.length - 1}\0`);
      } else {
        rebuilt.push(...table);
      }
    } else {
      rebuilt.push(lines[i++]);
    }
  }
  text = rebuilt.join("\n");

  const inline: string[] = [];
  text = text.replace(/`([^`]+)`/g, (fullMatch, code) => {
    void fullMatch;
    inline.push(code);
    return `\0IC${inline.length - 1}\0`;
  });
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "⟪B⟫$1⟪/B⟫").replace(/^>\s*(.*)$/gm, "$1");
  text = escapeTelegramHtml(text)
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/^(\d+)\.\s+/gm, "$1. ");
  inline.forEach((code, i) => {
    text = text.replace(`\0IC${i}\0`, `<code>${escapeTelegramHtml(code)}</code>`);
  });
  codeBlocks.forEach((code, i) => {
    text = text.replace(`\0CB${i}\0`, `<pre><code>${escapeTelegramHtml(code)}</code></pre>`);
  });
  return text.replaceAll("⟪B⟫", "<b>").replaceAll("⟪/B⟫", "</b>");
}

export class TelegramConfig {
  enabled = false;
  token = "";
  mode: "polling" | "webhook" = "polling";
  allowFrom: string[] = [];
  proxy: string | null = null;
  replyToMessage = false;
  reactEmoji = "👀";
  groupPolicy: "open" | "mention" = "mention";
  connectionPoolSize = 32;
  poolTimeout = 5;
  streaming = true;
  inlineKeyboards = false;
  streamEditInterval = STREAM_EDIT_INTERVAL_DEFAULT;
  webhookUrl = "";
  webhookListenHost = "127.0.0.1";
  webhookListenPort = 8081;
  webhookPath = "/telegram";
  webhookSecretToken = "";
  webhookMaxConnections = 4;
  app?: any;
  appFactory?: ((config: TelegramConfig) => Promise<any> | any) | null;

  constructor(init: Partial<TelegramConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.token = init.token ?? this.token;
    this.mode = init.mode ?? this.mode;
    this.proxy = init.proxy ?? this.proxy;
    this.streaming = init.streaming ?? this.streaming;
    this.app = init.app ?? this.app;
    this.allowFrom = Array.isArray(init.allowFrom) ? init.allowFrom.map(String) : this.allowFrom;
    this.replyToMessage = init.replyToMessage ?? this.replyToMessage;
    this.reactEmoji = init.reactEmoji ?? this.reactEmoji;
    this.groupPolicy = init.groupPolicy ?? this.groupPolicy;
    this.connectionPoolSize = Number(init.connectionPoolSize ?? this.connectionPoolSize);
    this.poolTimeout = Number(init.poolTimeout ?? this.poolTimeout);
    this.inlineKeyboards = init.inlineKeyboards ?? this.inlineKeyboards;
    this.streamEditInterval = Number(init.streamEditInterval ?? this.streamEditInterval);
    this.webhookUrl = init.webhookUrl ?? this.webhookUrl;
    this.webhookListenHost = init.webhookListenHost ?? this.webhookListenHost;
    this.webhookListenPort = Number(init.webhookListenPort ?? this.webhookListenPort);
    this.webhookPath = normalizeWebhookPath(init.webhookPath ?? this.webhookPath);
    this.webhookSecretToken = init.webhookSecretToken ?? this.webhookSecretToken;
    this.webhookMaxConnections = Number(init.webhookMaxConnections ?? this.webhookMaxConnections);
    this.appFactory = init.appFactory ?? null;
    if (this.mode === "webhook") validateWebhookConfig(this);
  }

  toObject(): Record<string, any> {
    return {
      enabled: this.enabled,
      token: this.token,
      mode: this.mode,
      allowFrom: this.allowFrom,
      proxy: this.proxy,
      replyToMessage: this.replyToMessage,
      reactEmoji: this.reactEmoji,
      groupPolicy: this.groupPolicy,
      connectionPoolSize: this.connectionPoolSize,
      poolTimeout: this.poolTimeout,
      streaming: this.streaming,
      inlineKeyboards: this.inlineKeyboards,
      streamEditInterval: this.streamEditInterval,
      webhookUrl: this.webhookUrl,
      webhookListenHost: this.webhookListenHost,
      webhookListenPort: this.webhookListenPort,
      webhookPath: this.webhookPath,
      webhookSecretToken: this.webhookSecretToken,
      webhookMaxConnections: this.webhookMaxConnections,
    };
  }
}

class StreamBuf {
  text = "";
  messageId: number | null = null;
  lastEdit = 0;
  streamId: string | null = null;
  constructor(init: Partial<StreamBuf> = {}) {
    Object.assign(this, init);
    this.messageId = init.messageId ?? this.messageId;
    this.lastEdit = init.lastEdit ?? this.lastEdit;
    this.streamId = init.streamId ?? this.streamId;
  }
}

export class TelegramChannel extends BaseChannel {
  static BOT_COMMANDS = [
    ["start", "Start the bot"],
    ["new", "Start a new conversation"],
    ["stop", "Stop the current task"],
    ["restart", "Restart the bot"],
    ["status", "Show bot status"],
    ["history", "Show recent conversation messages"],
    ["goal", "Start a sustained objective (long-running task)"],
    ["pairing", "Manage DM pairing"],
    ["model", "Switch runtime model preset"],
    ["dream", "Run Dream memory consolidation now"],
    ["dream_log", "Show the latest Dream memory change"],
    ["dream_restore", "Restore Dream memory to an earlier version"],
    ["help", "Show available commands"],
  ];
  static TELEGRAM_BUS_SLASH_COMMAND_RE =
    /^\/(?:new|stop|restart|status|dream|history|goal|pairing|model)(?:@\w+)?(?:\s+.*)?$/;
  private static readonly DREAM_COMMANDS = new Set([
    "dream",
    "dream_log",
    "dream_restore",
  ]);
  override config: TelegramConfig;
  displayName = "Telegram";
  readonly fileMemoryEnabled: boolean;
  app: any = null;
  chatIds: Record<string, number> = {};
  typingTasks = new Map<string, any>();
  mediaGroupBuffers = new Map<string, any>();
  mediaGroupTimers = new Map<string, NodeJS.Timeout>();
  messageThreads = new Map<string, number>();
  botUserId: number | null = null;
  botUsername: string | null = null;
  streamBuffers: Record<string, StreamBuf> = {};

  constructor(
    config: any = {},
    bus?: any,
    options: { fileMemoryEnabled?: boolean } = {},
  ) {
    const normalized = config instanceof TelegramConfig ? config : new TelegramConfig(config);
    super("telegram", normalized, bus);
    this.config = normalized;
    this.fileMemoryEnabled = options.fileMemoryEnabled === true;
    this.app = normalized.app ?? null;
  }

  static override defaultConfig(): Record<string, any> {
    return new TelegramConfig().toObject();
  }

  override get supportsStreaming(): boolean {
    return Boolean(this.config.streaming);
  }

  override isAllowed(senderId: string): boolean {
    if (super.isAllowed(senderId)) return true;
    const allow = this.config.allowFrom ?? [];
    if (!allow.length || allow.includes("*")) return false;
    const [id, username, extra] = String(senderId).split("|");
    if (extra !== undefined || !id || !username || !/^\d+$/.test(id)) return false;
    return allow.includes(id) || allow.includes(username);
  }

  static normalizeTelegramCommand(content: string): string {
    if (!content.startsWith("/")) return content;
    if (content === "/dream_log" || content.startsWith("/dream_log "))
      return content.replace("/dream_log", "/dream-log");
    if (content === "/dream_restore" || content.startsWith("/dream_restore "))
      return content.replace("/dream_restore", "/dream-restore");
    return content;
  }

  override async start(): Promise<void> {
    if (!this.config.token && !this.app && !this.config.appFactory) return;
    this.running = true;
    const factory = this.config.appFactory;
    if (!this.app && factory) this.app = await factory(this.config);
    if (!this.app && this.config.token) this.app = await this.createGrammyApp();
    if (typeof this.app?.initialize === "function") await this.app.initialize();
    if (typeof this.app?.start === "function") await this.app.start();
    const botInfo =
      typeof this.app?.bot?.get_me === "function" ? await this.app.bot.get_me() : null;
    this.botUserId = botInfo?.id ?? null;
    this.botUsername = botInfo?.username ?? null;
    if (typeof this.app?.bot?.set_my_commands === "function") {
      await this.app.bot
        .set_my_commands(
          TelegramChannel.BOT_COMMANDS
            .filter(
              ([command]) =>
                this.fileMemoryEnabled ||
                !TelegramChannel.DREAM_COMMANDS.has(command),
            )
            .map(([command, description]) => ({ command, description })),
        )
        .catch(() => undefined);
    }
  }

  async createGrammyApp(): Promise<any> {
    const { Bot, InputFile } = await import("grammy");
    const bot = new Bot(this.config.token);
    bot.on("message", async (ctx: any) => {
      await this.processMessageUpdate(normalizeInboundTelegramUpdate(ctx.update), ctx);
    });
    bot.on("callback_query:data", async (ctx: any) => {
      await this.onCallbackQuery(normalizeInboundTelegramUpdate(ctx.update), ctx);
    });
    const apiBot = {
      get_me: () => bot.api.getMe(),
      set_my_commands: (commands: any[]) => bot.api.setMyCommands(commands),
      send_message: ({
        chat_id,
        text,
        parse_mode,
        reply_markup,
        reply_parameters,
        message_thread_id,
      }: any) =>
        bot.api.sendMessage(chat_id, text, {
          parse_mode,
          reply_markup,
          reply_parameters,
          message_thread_id,
        }),
      edit_message_text: ({ chat_id, message_id, text, parse_mode, reply_markup }: any) =>
        bot.api.editMessageText(chat_id, message_id, text, { parse_mode, reply_markup }),
      send_photo: ({
        chat_id,
        photo,
        caption,
        parse_mode,
        reply_parameters,
        message_thread_id,
      }: any) =>
        bot.api.sendPhoto(
          chat_id,
          TelegramChannel.isRemoteMediaUrl(photo) ? photo : new InputFile(photo),
          { caption, parse_mode, reply_parameters, message_thread_id },
        ),
      send_video: ({
        chat_id,
        video,
        caption,
        parse_mode,
        reply_parameters,
        message_thread_id,
      }: any) =>
        bot.api.sendVideo(
          chat_id,
          TelegramChannel.isRemoteMediaUrl(video) ? video : new InputFile(video),
          { caption, parse_mode, reply_parameters, message_thread_id },
        ),
      send_voice: ({
        chat_id,
        voice,
        caption,
        parse_mode,
        reply_parameters,
        message_thread_id,
      }: any) =>
        bot.api.sendVoice(
          chat_id,
          TelegramChannel.isRemoteMediaUrl(voice) ? voice : new InputFile(voice),
          { caption, parse_mode, reply_parameters, message_thread_id },
        ),
      send_audio: ({
        chat_id,
        audio,
        caption,
        parse_mode,
        reply_parameters,
        message_thread_id,
      }: any) =>
        bot.api.sendAudio(
          chat_id,
          TelegramChannel.isRemoteMediaUrl(audio) ? audio : new InputFile(audio),
          { caption, parse_mode, reply_parameters, message_thread_id },
        ),
      send_document: ({
        chat_id,
        document,
        caption,
        parse_mode,
        reply_parameters,
        message_thread_id,
      }: any) =>
        bot.api.sendDocument(
          chat_id,
          TelegramChannel.isRemoteMediaUrl(document) ? document : new InputFile(document),
          { caption, parse_mode, reply_parameters, message_thread_id },
        ),
      set_message_reaction: ({ chat_id, message_id, reaction }: any) =>
        bot.api.setMessageReaction(chat_id, message_id, reaction ? [reaction] : []),
      send_chat_action: ({ chat_id, action }: any) => bot.api.sendChatAction(chat_id, action),
    };
    return {
      bot: apiBot,
      start: async () => {
        void bot.start();
      },
      stop: async () => bot.stop(),
      shutdown: async () => undefined,
      raw: bot,
    };
  }

  override async stop(): Promise<void> {
    this.running = false;
    for (const chatId of [...this.typingTasks.keys()]) this.stopTyping(chatId);
    for (const timer of this.mediaGroupTimers.values()) clearTimeout(timer);
    this.mediaGroupTimers.clear();
    if (typeof this.app?.updater?.stop === "function") await this.app.updater.stop();
    if (typeof this.app?.stop === "function") await this.app.stop();
    if (typeof this.app?.shutdown === "function") await this.app.shutdown();
    this.mediaGroupBuffers.clear();
    this.messageThreads.clear();
  }

  static getMediaType(filePath: string): string {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "photo";
    if (["mp4", "mov", "avi", "mkv", "webm", "3gp"].includes(ext)) return "video";
    if (ext === "ogg") return "voice";
    if (["mp3", "m4a", "wav", "aac"].includes(ext)) return "audio";
    return "document";
  }

  static isRemoteMediaUrl(filePath: string): boolean {
    return /^https?:\/\//i.test(filePath);
  }

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this.app?.bot) return;
    if (!msg.metadata?.agentProgress) {
      this.stopTyping(msg.chatId);
      const replyMessageId = msg.metadata?.message_id;
      if (replyMessageId != null) await this.removeReaction(msg.chatId, Number(replyMessageId));
    }
    const chatId = Number(msg.chatId);
    if (!Number.isFinite(chatId)) return;
    const replyToMessageId = msg.metadata?.message_id;
    const messageThreadId =
      msg.metadata?.message_thread_id ??
      (replyToMessageId != null
        ? this.messageThreads.get(`${msg.chatId}:${replyToMessageId}`)
        : null);
    const threadKwargs = messageThreadId != null ? { message_thread_id: messageThreadId } : {};
    const replyParameters =
      this.config.replyToMessage && replyToMessageId
        ? { message_id: replyToMessageId, allow_sending_without_reply: true }
        : undefined;

    for (const mediaPath of msg.media ?? []) {
      await this.sendMedia(chatId, mediaPath, replyParameters, threadKwargs);
    }

    if (msg.content && msg.content !== "[empty message]") {
      let text = msg.content;
      const buttons = msg.buttons ?? [];
      const replyMarkup = this.buildKeyboard(buttons);
      if (buttons.length && !replyMarkup)
        text = `${text}\n\n${TelegramChannel.buttonsAsText(buttons)}`;
      const chunks = splitMessage(text, TELEGRAM_MAX_MESSAGE_LEN);
      for (let i = 0; i < chunks.length; i += 1) {
        await this.sendText(chatId, chunks[i], replyParameters, threadKwargs, {
          renderAsBlockquote: Boolean(msg.metadata?.toolHint),
          replyMarkup: i === chunks.length - 1 ? replyMarkup : undefined,
        });
      }
    }
  }

  private async sendMedia(
    chatId: number,
    mediaPath: string,
    replyParameters: any,
    threadKwargs: Record<string, any>,
  ): Promise<void> {
    const mediaType = TelegramChannel.getMediaType(mediaPath);
    const bot = this.app.bot;
    const sender =
      {
        photo: bot.send_photo,
        video: bot.send_video,
        voice: bot.send_voice,
        audio: bot.send_audio,
        document: bot.send_document,
      }[mediaType] ?? bot.send_document;
    const param =
      (
        {
          photo: "photo",
          video: "video",
          voice: "voice",
          audio: "audio",
          document: "document",
        } as Record<string, string>
      )[mediaType] ?? "document";
    const extra = mediaType === "video" ? { supports_streaming: true } : {};
    try {
      if (TelegramChannel.isRemoteMediaUrl(mediaPath)) {
        const [ok, error] = await validateUrlTarget(mediaPath);
        if (!ok) throw new Error(`unsafe media URL: ${error}`);
        await this.callWithRetry(sender.bind(bot), {
          chat_id: chatId,
          [param]: mediaPath,
          reply_parameters: replyParameters,
          ...threadKwargs,
          ...extra,
        });
      } else {
        await this.callWithRetry(sender.bind(bot), {
          chat_id: chatId,
          [param]: fs.readFileSync(mediaPath),
          filename: path.basename(mediaPath),
          reply_parameters: replyParameters,
          ...threadKwargs,
          ...extra,
        });
      }
    } catch {
      await bot.send_message({
        chat_id: chatId,
        text: `[Failed to send: ${path.basename(mediaPath)}]`,
        reply_parameters: replyParameters,
        ...threadKwargs,
      });
    }
  }

  async callWithRetry<T>(fn: (args: any) => Promise<T> | T, args: any): Promise<T> {
    let last: any;
    for (let attempt = 1; attempt <= SEND_MAX_RETRIES; attempt += 1) {
      try {
        return await fn(args);
      } catch (error: any) {
        last = error;
        const retryAfter = Number(error?.retry_after ?? error?.retryAfter ?? 0);
        const retryable =
          retryAfter > 0 ||
          /timeout|network|pool/i.test(String(error?.message ?? error?.name ?? ""));
        if (!retryable || attempt === SEND_MAX_RETRIES) throw error;
        await sleep(
          retryAfter > 0 ? retryAfter * 1000 : SEND_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        );
      }
    }
    throw last;
  }

  async sendText(
    chatId: number,
    text: string,
    replyParameters: any = undefined,
    threadKwargs: Record<string, any> = {},
    opts: { renderAsBlockquote?: boolean; replyMarkup?: any } = {},
  ): Promise<void> {
    const html = opts.renderAsBlockquote
      ? toolHintToTelegramBlockquote(text)
      : markdownToTelegramHtml(text);
    try {
      await this.callWithRetry(this.app.bot.send_message.bind(this.app.bot), {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        reply_parameters: replyParameters,
        reply_markup: opts.replyMarkup,
        ...threadKwargs,
      });
    } catch {
      await this.callWithRetry(this.app.bot.send_message.bind(this.app.bot), {
        chat_id: chatId,
        text,
        reply_parameters: replyParameters,
        reply_markup: opts.replyMarkup,
        ...threadKwargs,
      });
    }
  }

  static isNotModifiedError(error: any): boolean {
    return /message is not modified/i.test(String(error?.message ?? error));
  }

  override async sendDelta(
    chatId: string,
    delta: string,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    if (!this.app?.bot) return;
    const intChatId = Number(chatId);
    if (!Number.isFinite(intChatId)) return;
    const streamId = metadata.streamId == null ? null : String(metadata.streamId);
    if (metadata.streamEnd) {
      const buf = this.streamBuffers[chatId];
      if (!buf?.messageId || !buf.text) return;
      if (streamId !== null && buf.streamId !== null && buf.streamId !== streamId) return;
      if (delta) buf.text += delta;
      this.stopTyping(chatId);
      const html = markdownToTelegramHtml(buf.text);
      const chunks = splitMessage(html, TELEGRAM_HTML_MAX_LEN);
      await this.callWithRetry(this.app.bot.edit_message_text.bind(this.app.bot), {
        chat_id: intChatId,
        message_id: buf.messageId,
        text: chunks[0],
        parse_mode: "HTML",
      }).catch(async (error) => {
        if (!TelegramChannel.isNotModifiedError(error)) {
          await this.app.bot.edit_message_text({
            chat_id: intChatId,
            message_id: buf.messageId,
            text: splitMessage(buf.text, TELEGRAM_MAX_MESSAGE_LEN)[0],
          });
        }
      });
      for (const chunk of chunks.slice(1)) await this.sendText(intChatId, chunk);
      delete this.streamBuffers[chatId];
      return;
    }

    let buf = this.streamBuffers[chatId];
    if (!buf || (streamId !== null && buf.streamId !== null && buf.streamId !== streamId)) {
      buf = this.streamBuffers[chatId] = new StreamBuf({ streamId });
    } else if (buf.streamId === null) {
      buf.streamId = streamId;
    }
    buf.text += delta;
    if (!buf.text.trim()) return;
    const now = Date.now() / 1000;
    const threadKwargs =
      metadata.message_thread_id != null ? { message_thread_id: metadata.message_thread_id } : {};
    if (buf.messageId == null) {
      const sent = await this.callWithRetry(this.app.bot.send_message.bind(this.app.bot), {
        chat_id: intChatId,
        text: stripMdBlock(buf.text),
        ...threadKwargs,
      });
      buf.messageId = Number((sent as any)?.message_id ?? (sent as any)?.messageId ?? 0);
      buf.lastEdit = now;
    } else if (now - buf.lastEdit >= this.config.streamEditInterval) {
      await this.callWithRetry(this.app.bot.edit_message_text.bind(this.app.bot), {
        chat_id: intChatId,
        message_id: buf.messageId,
        text: stripMdBlock(buf.text),
      }).catch((error) => {
        if (!TelegramChannel.isNotModifiedError(error)) throw error;
      });
      buf.lastEdit = now;
    }
  }

  async flushStreamOverflow(
    chatId: number,
    buf: StreamBuf,
    threadKwargs: Record<string, any>,
  ): Promise<void> {
    const chunks = splitMessage(buf.text, TELEGRAM_MAX_MESSAGE_LEN);
    if (chunks.length <= 1) return;
    await this.app.bot
      .edit_message_text({ chat_id: chatId, message_id: buf.messageId, text: chunks[0] })
      .catch((error: any) => {
        if (!TelegramChannel.isNotModifiedError(error)) throw error;
      });
    for (const chunk of chunks.slice(1, -1))
      await this.app.bot.send_message({ chat_id: chatId, text: chunk, ...threadKwargs });
    const sent = await this.app.bot.send_message({
      chat_id: chatId,
      text: chunks.at(-1),
      ...threadKwargs,
    });
    buf.messageId = Number(sent?.message_id ?? sent?.messageId ?? 0);
    buf.text = chunks.at(-1) ?? "";
  }

  static senderId(user: any): string {
    return user?.username ? `${user.id}|${user.username}` : String(user?.id ?? "");
  }

  static deriveTopicSessionKey(message: any): string | null {
    const threadId = message?.message_thread_id ?? message?.messageThreadId;
    return threadId == null
      ? null
      : `telegram:${message.chat_id ?? message.chatId}:topic:${threadId}`;
  }

  static buildMessageMetadata(message: any, user: any): Record<string, any> {
    const reply = message?.reply_to_message ?? message?.replyToMessage;
    return {
      message_id: message?.message_id ?? message?.messageId,
      user_id: user?.id,
      username: user?.username ?? null,
      first_name: user?.first_name ?? user?.firstName ?? null,
      is_group: (message?.chat?.type ?? "private") !== "private",
      message_thread_id: message?.message_thread_id ?? message?.messageThreadId ?? null,
      is_forum: Boolean(message?.chat?.is_forum ?? message?.chat?.isForum),
      reply_to_message_id: reply ? (reply.message_id ?? reply.messageId ?? null) : null,
    };
  }

  async extractReplyContext(message: any): Promise<string | null> {
    const reply = message?.reply_to_message ?? message?.replyToMessage;
    if (!reply) return null;
    let text = reply.text ?? reply.caption ?? "";
    if (text.length > TELEGRAM_REPLY_CONTEXT_MAX_LEN)
      text = `${text.slice(0, TELEGRAM_REPLY_CONTEXT_MAX_LEN)}...`;
    if (!text) return null;
    const [botId] = await this.ensureBotIdentity();
    const replyUser = reply.from_user ?? reply.fromUser;
    if (botId && replyUser?.id === botId) return `[Reply to bot: ${text}]`;
    if (replyUser?.username) return `[Reply to @${replyUser.username}: ${text}]`;
    if (replyUser?.first_name ?? replyUser?.firstName)
      return `[Reply to ${replyUser.first_name ?? replyUser.firstName}: ${text}]`;
    return `[Reply to: ${text}]`;
  }

  async downloadMessageMedia(
    message: any,
    { addFailureContent = false }: { addFailureContent?: boolean } = {},
  ): Promise<[string[], string[]]> {
    const fail = addFailureContent;
    const [mediaFile, mediaType] = pickMessageMedia(message);
    if (!mediaFile || !this.app?.bot) return [[], []];
    try {
      const file = await this.app.bot.get_file(mediaFile.file_id ?? mediaFile.fileId);
      const ext = this.getExtension(
        mediaType,
        mediaFile.mime_type ?? mediaFile.mimeType,
        mediaFile.file_name ?? mediaFile.fileName,
      );
      const mediaDir = getMediaDir("telegram");
      fs.mkdirSync(mediaDir, { recursive: true });
      const unique =
        mediaFile.file_unique_id ?? mediaFile.fileUniqueId ?? mediaFile.file_id ?? mediaFile.fileId;
      const target = path.join(mediaDir, `${safeFilename(String(unique))}${ext}`);
      if (typeof file.download_to_drive === "function") await file.download_to_drive(target);
      else if (typeof file.downloadToDrive === "function") await file.downloadToDrive(target);
      else if (file.bytes) fs.writeFileSync(target, file.bytes);
      const content =
        mediaType === "voice" || mediaType === "audio"
          ? await this.transcribeAudio(target).then((text) =>
              text ? `[transcription: ${text}]` : `[${mediaType}: ${target}]`,
            )
          : `[${mediaType}: ${target}]`;
      return [[target], [content]];
    } catch {
      return [[], fail ? [`[${mediaType}: download failed]`] : []];
    }
  }

  async ensureBotIdentity(): Promise<[number | null, string | null]> {
    if (this.botUserId !== null || this.botUsername !== null)
      return [this.botUserId, this.botUsername];
    if (!this.app?.bot?.get_me) return [null, null];
    const botInfo = await this.app.bot.get_me();
    this.botUserId = botInfo?.id ?? null;
    this.botUsername = botInfo?.username ?? null;
    return [this.botUserId, this.botUsername];
  }

  static hasMentionEntity(
    text: string,
    entities: any[] | null | undefined,
    botUsername: string,
    botId: number | null,
  ): boolean {
    const handle = `@${botUsername}`.toLowerCase();
    for (const entity of entities ?? []) {
      if (entity.type === "text_mention") {
        if (botId != null && entity.user?.id === botId) return true;
        continue;
      }
      if (entity.type !== "mention") continue;
      const offset = Number(entity.offset);
      const length = Number(entity.length);
      if (text.slice(offset, offset + length).toLowerCase() === handle) return true;
    }
    return text.toLowerCase().includes(handle);
  }

  async isGroupMessageForBot(message: any): Promise<boolean> {
    if ((message?.chat?.type ?? "private") === "private" || this.config.groupPolicy === "open")
      return true;
    const [botId, botUsername] = await this.ensureBotIdentity();
    if (botUsername) {
      if (
        TelegramChannel.hasMentionEntity(message.text ?? "", message.entities, botUsername, botId)
      )
        return true;
      if (
        TelegramChannel.hasMentionEntity(
          message.caption ?? "",
          message.caption_entities,
          botUsername,
          botId,
        )
      )
        return true;
    }
    const replyUser = message?.reply_to_message?.from_user ?? message?.replyToMessage?.fromUser;
    return Boolean(botId && replyUser?.id === botId);
  }

  rememberThreadContext(message: any): void {
    const threadId = message?.message_thread_id ?? message?.messageThreadId;
    if (threadId == null) return;
    const key = `${message.chat_id ?? message.chatId}:${message.message_id ?? message.messageId}`;
    this.messageThreads.set(key, threadId);
    if (this.messageThreads.size > 1000) {
      const first = this.messageThreads.keys().next().value;
      if (first !== undefined) this.messageThreads.delete(first);
    }
  }

  async forwardCommand(update: any, context: any): Promise<void> {
    return this.processForwardCommand(update, context);
  }

  async processForwardCommand(update: any, context: any): Promise<void> {
    const message = update.message;
    const user = update.effective_user ?? update.effectiveUser;
    if (!message || !user) return;
    const senderId = TelegramChannel.senderId(user);
    if (!this.isAllowed(senderId)) return;
    this.rememberThreadContext(message);
    let content = message.text ?? "";
    if (content.startsWith("/") && content.includes("@")) {
      const [command, ...rest] = content.split(" ");
      content = `${command.split("@")[0]}${rest.length ? ` ${rest.join(" ")}` : ""}`;
    }
    content = TelegramChannel.normalizeTelegramCommand(content);
    await this.handleMessage({
      senderId,
      chatId: String(message.chat_id ?? message.chatId),
      content,
      metadata: TelegramChannel.buildMessageMetadata(message, user),
      sessionKey: TelegramChannel.deriveTopicSessionKey(message),
      isDm: (message.chat?.type ?? "private") === "private",
    });
  }

  async onMessage(update: any, context: any): Promise<void> {
    return this.processMessageUpdate(update, context);
  }

  async processMessageUpdate(update: any, context: any): Promise<void> {
    const message = update.message;
    const user = update.effective_user ?? update.effectiveUser;
    if (!message || !user) return;
    const chatId = message.chat_id ?? message.chatId;
    const strChatId = String(chatId);
    const senderId = TelegramChannel.senderId(user);
    if (!this.isAllowed(senderId)) return;
    this.rememberThreadContext(message);
    this.chatIds[senderId] = Number(chatId);
    if (!(await this.isGroupMessageForBot(message))) return;

    const contentParts: string[] = [];
    const mediaPaths: string[] = [];
    if (message.text) contentParts.push(message.text);
    if (message.caption) contentParts.push(message.caption);
    if (message.location)
      contentParts.push(`[location: ${message.location.latitude}, ${message.location.longitude}]`);
    const [currentMedia, currentMediaParts] = await this.downloadMessageMedia(message, {
      addFailureContent: true,
    });
    mediaPaths.push(...currentMedia);
    contentParts.push(...currentMediaParts);
    const reply = message.reply_to_message ?? message.replyToMessage;
    if (reply) {
      const replyContext = await this.extractReplyContext(message);
      const [replyMedia, replyMediaParts] = await this.downloadMessageMedia(reply);
      mediaPaths.unshift(...replyMedia);
      const tag =
        replyContext || (replyMediaParts.length ? `[Reply to: ${replyMediaParts[0]}]` : null);
      if (tag) contentParts.unshift(tag);
    }
    const content = contentParts.length ? contentParts.join("\n") : "[empty message]";
    const metadata = TelegramChannel.buildMessageMetadata(message, user);
    const sessionKey = TelegramChannel.deriveTopicSessionKey(message);
    if (message.media_group_id) {
      const key = `${strChatId}:${message.media_group_id}`;
      let buf = this.mediaGroupBuffers.get(key);
      if (!buf) {
        buf = { senderId, chatId: strChatId, contents: [], media: [], metadata, sessionKey };
        this.mediaGroupBuffers.set(key, buf);
        this.startTyping(strChatId);
        await this.addReaction(strChatId, metadata.message_id, this.config.reactEmoji);
      }
      if (content !== "[empty message]") buf.contents.push(content);
      buf.media.push(...mediaPaths);
      if (!this.mediaGroupTimers.has(key)) {
        const timer = setTimeout(() => {
          this.mediaGroupTimers.delete(key);
          void this.flushMediaGroup(key);
        }, MEDIA_GROUP_FLUSH_DELAY_MS);
        timer.unref?.();
        this.mediaGroupTimers.set(key, timer);
      }
      return;
    }
    this.startTyping(strChatId);
    await this.addReaction(strChatId, metadata.message_id, this.config.reactEmoji);
    await this.handleMessage({
      senderId,
      chatId: strChatId,
      content,
      media: mediaPaths,
      metadata,
      sessionKey,
    });
  }

  async flushMediaGroup(key: string): Promise<void> {
    const timer = this.mediaGroupTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.mediaGroupTimers.delete(key);
    }
    const buf = this.mediaGroupBuffers.get(key);
    if (!buf) return;
    this.mediaGroupBuffers.delete(key);
    await this.handleMessage({
      senderId: buf.senderId,
      chatId: buf.chatId,
      content: buf.contents.join("\n") || "[empty message]",
      media: [...new Set<string>(buf.media)],
      metadata: buf.metadata,
      sessionKey: buf.sessionKey,
    });
  }

  startTyping(chatId: string): void {
    this.stopTyping(chatId);
    if (!this.app?.bot?.send_chat_action) return;
    const send = () =>
      this.app.bot
        .send_chat_action({ chat_id: Number(chatId), action: "typing" })
        .catch(() => undefined);
    send();
    this.typingTasks.set(chatId, setInterval(send, 4000));
  }

  stopTyping(chatId: string): void {
    const timer = this.typingTasks.get(chatId);
    if (timer) clearInterval(timer);
    this.typingTasks.delete(chatId);
  }

  async addReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    if (!this.app?.bot?.set_message_reaction || !emoji || messageId == null) return;
    await this.app.bot
      .set_message_reaction({
        chat_id: Number(chatId),
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      })
      .catch(() => undefined);
  }

  async removeReaction(chatId: string, messageId: number): Promise<void> {
    if (!this.app?.bot?.set_message_reaction || messageId == null) return;
    await this.app.bot
      .set_message_reaction({ chat_id: Number(chatId), message_id: messageId, reaction: [] })
      .catch(() => undefined);
  }

  static formatTelegramError(error: any): string {
    const text = String(error?.message ?? error ?? "").trim();
    if (text) return text;
    if (error?.cause) return `${error.constructor?.name ?? "Error"} (${String(error.cause)})`;
    return error?.constructor?.name ?? "Error";
  }

  getExtension(mediaType: string, mimeType?: string | null, filename?: string | null): string {
    const extMap: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "audio/ogg": ".ogg",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/webm": ".webm",
      "video/x-matroska": ".mkv",
      "video/3gpp": ".3gp",
    };
    if (mimeType && extMap[mimeType]) return extMap[mimeType];
    const typeMap: Record<string, string> = {
      image: ".jpg",
      voice: ".ogg",
      audio: ".mp3",
      video: ".mp4",
      file: "",
    };
    if (typeMap[mediaType]) return typeMap[mediaType];
    if (!filename) return "";
    const basename = path.basename(filename);
    const firstDot = basename.indexOf(".");
    return firstDot >= 0 ? basename.slice(firstDot) : "";
  }

  buildKeyboard(buttons: string[][]): any {
    if (!buttons.length || !this.config.inlineKeyboards) return null;
    return {
      inline_keyboard: buttons.map((row) =>
        row.map((label) => ({
          text: label,
          callback_data: TelegramChannel.safeCallbackData(label),
        })),
      ),
    };
  }

  static safeCallbackData(label: string): string {
    const encoded = Buffer.from(label);
    return encoded.length <= 64
      ? label
      : encoded
          .subarray(0, 64)
          .toString("utf8")
          .replace(/\uFFFD+$/g, "");
  }

  static buttonsAsText(buttons: string[][]): string {
    return buttons
      .filter((row) => row.length)
      .map((row) => row.map((label) => `[${label}]`).join(" "))
      .join("\n");
  }

  async onCallbackQuery(update: any, context: any): Promise<void> {
    const query = update.callback_query ?? update.callbackQuery;
    const user = update.effective_user ?? update.effectiveUser;
    const chatId = query?.message?.chat_id ?? query?.message?.chatId;
    if (!query || !user || chatId == null) return;
    const senderId = TelegramChannel.senderId(user);
    if (!this.isAllowed(senderId)) return;
    if (typeof query.answer === "function") await query.answer();
    if (typeof query.message?.edit_reply_markup === "function")
      await query.message.edit_reply_markup({ reply_markup: null }).catch(() => undefined);
    this.startTyping(String(chatId));
    await this.handleMessage({
      senderId,
      chatId: String(chatId),
      content: query.data ?? "",
      metadata: {
        callback_query_id: query.id,
        button_label: query.data ?? "",
        user_id: user.id,
        username: user.username ?? null,
        first_name: user.first_name ?? user.firstName ?? null,
        is_callback: true,
      },
    });
  }
}

function normalizeWebhookPath(value: string): string {
  const trimmed = value.trim() || "/telegram";
  if (!trimmed.startsWith("/")) throw new Error('webhookPath must start with "/"');
  return trimmed;
}

function validateWebhookConfig(config: TelegramConfig): void {
  let url: URL;
  try {
    url = new URL(config.webhookUrl.trim());
  } catch {
    throw new Error("webhookUrl must be a public HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.host)
    throw new Error("webhookUrl must be a public HTTPS URL");
  const secret = config.webhookSecretToken.trim();
  if (!secret) throw new Error("webhookSecretToken is required when Telegram mode is webhook");
  if (secret.length > 256 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error(
      "webhookSecretToken must be 1-256 characters using only A-Z, a-z, 0-9, _ and -",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFilename(name: string): string {
  return (
    path
      .basename(name || "telegram")
      .replace(/[^\w.-]/g, "_")
      .replace(/^[._-]+/, "") || "telegram"
  );
}

function normalizeInboundTelegramMessage(message: any): any {
  if (!message || typeof message !== "object") return message;
  const out: any = { ...message };
  if (out.chat?.id != null && out.chat_id == null) out.chat_id = out.chat.id;
  if (out.from && !out.from_user) out.from_user = out.from;
  if (out.reply_to_message)
    out.reply_to_message = normalizeInboundTelegramMessage(out.reply_to_message);
  return out;
}

/**
 * Normalizes a grammy/native Telegram update into the PTB shape this channel's logic expects.
 *
 * The ctx.update that grammy passes in only has native fields (message.from, message.chat.id), not PTB's
 * effective_user / message.chat_id / reply.from_user. Without these, the first line of processMessageUpdate,
 * `if (!message || !user) return`, silently drops every inbound message. This function fills in those alias fields.
 */
function normalizeInboundTelegramUpdate(update: any): any {
  if (!update || typeof update !== "object") return update;
  const message = normalizeInboundTelegramMessage(update.message ?? update.edited_message);
  const callbackQuery = update.callback_query ?? update.callbackQuery;
  const normalizedCallback = callbackQuery
    ? { ...callbackQuery, message: normalizeInboundTelegramMessage(callbackQuery.message) }
    : callbackQuery;
  const effectiveUser =
    update.effective_user ?? update.effectiveUser ?? message?.from ?? callbackQuery?.from ?? null;
  const out: any = { ...update, effective_user: effectiveUser };
  if (message) out.message = message;
  if (normalizedCallback) out.callback_query = normalizedCallback;
  return out;
}

function pickMessageMedia(message: any): [any, string] {
  if (message?.photo?.length) return [message.photo.at(-1), "image"];
  if (message?.voice) return [message.voice, "voice"];
  if (message?.audio) return [message.audio, "audio"];
  if (message?.document) return [message.document, "file"];
  if (message?.video) return [message.video, "video"];
  if (message?.video_note ?? message?.videoNote)
    return [message.video_note ?? message.videoNote, "video"];
  if (message?.animation) return [message.animation, "animation"];
  return [null, ""];
}
