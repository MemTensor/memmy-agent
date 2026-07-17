import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InboundMessage, OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { isApproved } from "../channel-auth/index.js";
import { splitMessage } from "../../utils/helpers.js";
import { BaseChannel, type ChannelHandleMessageOptions } from "./base.js";

export const TYPING_NOTICE_TIMEOUT_MS = 30_000;

type Run = { text: string; styles: Set<string>; opaque?: boolean };

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function utf16Len(value: string): number {
  return Buffer.from(value, "utf16le").length / 2;
}

function safeFilename(name: string): string {
  return path.basename(name || "attachment").replace(/[^\w.\-]+/g, "_") || "attachment";
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function stripCell(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function displayWidth(value: string): number {
  return [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 0xff ? 2 : 1), 0);
}

function renderTable(lines: string[]): string {
  const rows: string[][] = [];
  let hasSeparator = false;
  for (const line of lines) {
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(stripCell);
    if (cells.every((cell) => !cell || /^:?-+:?$/.test(cell))) {
      hasSeparator = true;
      continue;
    }
    rows.push(cells);
  }
  if (!rows.length || !hasSeparator) return lines.join("\n");
  const cols = Math.max(...rows.map((row) => row.length));
  for (const row of rows) while (row.length < cols) row.push("");
  const widths = [...Array(cols).keys()].map((col) => Math.max(...rows.map((row) => displayWidth(row[col]))));
  const draw = (row: string[]) => row.map((cell, i) => `${cell}${" ".repeat(widths[i] - displayWidth(cell))}`).join("  ");
  return [draw(rows[0]), widths.map((width) => "─".repeat(width)).join("  "), ...rows.slice(1).map(draw)].join("\n");
}

function applyPattern(runs: Run[], pattern: RegExp, makeRun: (match: RegExpExecArray, styles: Set<string>) => Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.opaque) {
      out.push(run);
      continue;
    }
    let pos = 0;
    for (const match of run.text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > pos) out.push({ text: run.text.slice(pos, index), styles: new Set(run.styles) });
      out.push(...makeRun(match as RegExpExecArray, new Set(run.styles)));
      pos = index + match[0].length;
    }
    if (pos < run.text.length) out.push({ text: run.text.slice(pos), styles: new Set(run.styles) });
  }
  return out;
}

export function markdownToSignal(markdown: string): [string, string[]] {
  if (!markdown) return ["", []];
  const protectedBlocks: string[] = [];
  let text = markdown.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (match, code: string) => {
    protectedBlocks.push(code);
    return `\0C${protectedBlocks.length - 1}\0`;
  });

  const lines = text.split("\n");
  const rebuilt: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (/^\s*\|.+\|/.test(lines[i])) {
      const table: string[] = [];
      while (i < lines.length && /^\s*\|.+\|/.test(lines[i])) {
        table.push(lines[i]);
        i += 1;
      }
      protectedBlocks.push(renderTable(table));
      rebuilt.push(`\0C${protectedBlocks.length - 1}\0`);
    } else {
      rebuilt.push(lines[i]);
      i += 1;
    }
  }
  text = rebuilt.join("\n");

  let runs: Run[] = [{ text, styles: new Set() }];
  runs = applyPattern(runs, /\0C(\d+)\0/g, (match, styles) => [{ text: protectedBlocks[Number(match[1])] ?? "", styles: new Set([...styles, "MONOSPACE"]), opaque: true }]);
  runs = applyPattern(runs, /`([^`\n]+)`/g, (match, styles) => [{ text: match[1], styles: new Set([...styles, "MONOSPACE"]), opaque: true }]);
  runs = applyPattern(runs, /^#{1,6}\s+(.+)$/gm, (match, styles) => [{ text: match[1], styles: new Set([...styles, "BOLD"]) }]);
  runs = applyPattern(runs, /^>\s*(.*)$/gm, (match, styles) => [{ text: match[1], styles }]);
  runs = applyPattern(runs, /^[-*]\s+/gm, (match, styles) => [{ text: "• ", styles }]);
  runs = applyPattern(runs, /^(\d+)\.\s+/gm, (match, styles) => [{ text: `${match[1]}. `, styles }]);
  runs = applyPattern(runs, /\[([^\]]+)]\(([^)]+)\)/g, (match, styles) => {
    const textPart = match[1];
    const url = match[2];
    const norm = (value: string) => value.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
    return [{ text: norm(textPart) === norm(url) ? url : `${textPart} (${url})`, styles }];
  });
  runs = applyPattern(runs, /\*\*(.+?)\*\*|__(.+?)__/gs, (match, styles) => [{ text: match[1] ?? match[2], styles: new Set([...styles, "BOLD"]) }]);
  runs = applyPattern(runs, /(?<!\*)\*([^*\n]+)\*(?!\*)|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, (match, styles) => [
    { text: match[1] ?? match[2], styles: new Set([...styles, "ITALIC"]) },
  ]);
  runs = applyPattern(runs, /~~(.+?)~~|(?<![~\w])~([^~\n]+)~(?![~\w])/gs, (match, styles) => [
    { text: match[1] ?? match[2], styles: new Set([...styles, "STRIKETHROUGH"]) },
  ]);

  let plain = "";
  const styles: string[] = [];
  let offset = 0;
  for (const run of runs) {
    if (!run.text) continue;
    plain += run.text;
    const length = utf16Len(run.text);
    for (const style of [...run.styles].sort()) styles.push(`${offset}:${length}:${style}`);
    offset += length;
  }
  return [plain, styles];
}

export function partitionStyles(plainText: string, chunks: string[], textStyles: string[]): string[][] {
  if (!chunks.length) return [];
  if (!textStyles.length) return chunks.map(() => []);
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) while (cursor < plainText.length && /\s/.test(plainText[cursor])) cursor += 1;
    const start = utf16Len(plainText.slice(0, cursor));
    ranges.push([start, start + utf16Len(chunk)]);
    cursor += chunk.length;
  }
  const out = chunks.map(() => [] as string[]);
  for (const entry of textStyles) {
    const [startRaw, lengthRaw, style] = entry.split(":", 3);
    const start = Number(startRaw);
    const end = start + Number(lengthRaw);
    for (const [index, [chunkStart, chunkEnd]] of ranges.entries()) {
      if (end <= chunkStart || start >= chunkEnd) continue;
      const rebasedStart = Math.max(start, chunkStart) - chunkStart;
      const rebasedEnd = Math.min(end, chunkEnd) - chunkStart;
      if (rebasedEnd > rebasedStart) out[index].push(`${rebasedStart}:${rebasedEnd - rebasedStart}:${style}`);
    }
  }
  return out;
}

export class SignalDMConfig {
  enabled = false;
  policy = "allowlist";
  allowFrom: string[] = [];

  constructor(init: Partial<SignalDMConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.policy = init.policy ?? this.policy;
    this.allowFrom = asArray(init.allowFrom ?? this.allowFrom);
  }
}

export class SignalGroupConfig {
  enabled = false;
  policy = "allowlist";
  allowFrom: string[] = [];
  requireMention = true;

  constructor(init: Partial<SignalGroupConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.policy = init.policy ?? this.policy;
    this.allowFrom = asArray(init.allowFrom ?? this.allowFrom);
    this.requireMention = init.requireMention ?? this.requireMention;
  }
}

export class SignalConfig {
  enabled = false;
  phoneNumber = "";
  daemonHost = "localhost";
  daemonPort = 8080;
  groupMessageBufferSize = 20;
  attachmentsDir: string | null = null;
  dm: SignalDMConfig;
  group: SignalGroupConfig;
  allowFrom: string[] = [];

  constructor(init: Partial<SignalConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.phoneNumber = init.phoneNumber ?? this.phoneNumber;
    this.daemonHost = init.daemonHost ?? this.daemonHost;
    this.daemonPort = Number(init.daemonPort ?? this.daemonPort);
    this.groupMessageBufferSize = Number(init.groupMessageBufferSize ?? this.groupMessageBufferSize);
    if (this.groupMessageBufferSize <= 0) throw new Error("groupMessageBufferSize must be > 0");
    this.attachmentsDir = init.attachmentsDir ?? this.attachmentsDir;
    this.dm = init.dm instanceof SignalDMConfig ? init.dm : new SignalDMConfig(init.dm ?? {});
    this.group = init.group instanceof SignalGroupConfig ? init.group : new SignalGroupConfig(init.group ?? {});
    this.allowFrom = unique([...this.dm.allowFrom, ...this.group.allowFrom]);
  }
}

export class SignalChannel extends BaseChannel {
  override name = "signal";
  override displayName = "Signal";
  override config: SignalConfig;
  httpClient: any = null;
  requestId = 0;
  sseTask: Promise<void> | null = null;
  typingTasks: Record<string, boolean> = {};
  typingUuidWarnings = new Set<string>();
  accountIdAliases = new Set<string>();
  groupBuffers: Record<string, Array<Record<string, any>>> = {};
  maxMessageLength = 64_000;
  httpTimeoutSeconds = 60;

  static override defaultConfig(): Record<string, any> {
    return new SignalConfig() as any;
  }

  constructor(config: Partial<SignalConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof SignalConfig ? config : new SignalConfig(config);
    super("signal", normalized, bus);
    this.config = normalized;
    this.rememberAccountIdAlias(this.config.phoneNumber);
  }

  override isAllowed(senderId: string): boolean {
    const allowList = this.config.allowFrom;
    if (allowList.includes("*")) return true;
    if (SignalChannel.senderMatchesAllowlist(senderId, allowList)) return true;
    for (const part of String(senderId).split("|")) {
      for (const variant of SignalChannel.normalizeSignalId(part)) {
        if (isApproved(this.name, variant)) return true;
      }
    }
    return false;
  }

  override async handleMessage(
    senderIdOrOptions: string | ChannelHandleMessageOptions,
    chatId?: string,
    content?: string,
    media?: string[],
    metadata?: Record<string, any>,
    sessionKey?: string | null,
  ): Promise<void> {
    const options =
      typeof senderIdOrOptions === "object"
        ? senderIdOrOptions
        : {
            senderId: senderIdOrOptions,
            chatId,
            content: content ?? "",
            media,
            metadata,
            sessionKey,
          };
    const messageMetadata = this.supportsStreaming ? { ...(options.metadata ?? {}), wantsStream: true } : (options.metadata ?? {});
    await this.bus.publishInbound(
      new InboundMessage({
        channel: this.name,
        senderId: String(options.senderId ?? ""),
        chatId: String(options.chatId ?? ""),
        content: options.content ?? "",
        media: options.media ?? [],
        metadata: messageMetadata,
        sessionKeyOverride: options.sessionKey ?? undefined,
      }),
    );
  }

  override async start(): Promise<void> {
    if (!this.config.phoneNumber) return;
    this.httpClient = this.httpClient ?? createSignalFetchHttpClient(this.config);
    await this.httpClient.get?.("/api/v1/check").catch?.(() => undefined);
    if (!this.sseTask) {
      this.sseTask = this.sseReceiveLoop().catch(() => undefined);
    }
    this.running = true;
  }

  override async stop(): Promise<void> {
    this.running = false;
    const sseTask = this.sseTask as any;
    if (sseTask && typeof sseTask.cancel === "function") {
      sseTask.cancel();
      try {
        await sseTask;
      } catch {
        // Cancellation errors are expected during shutdown.
      }
    }
    this.sseTask = null;
    for (const chatId of Object.keys(this.typingTasks)) await this.stopTyping(chatId);
    await this.httpClient?.aclose?.();
    this.httpClient = null;
  }

  override async send(msg: OutboundMessage): Promise<void> {
    const isProgress = Boolean(msg.metadata?.agentProgress);
    try {
      const [plainText, textStyles] = markdownToSignal(msg.content);
      if (!plainText && !msg.media.length) return;
      const recipientParams = this.recipientParams(msg.chatId);
      const chunks = plainText ? splitMessage(plainText, this.maxMessageLength) : [""];
      const chunkStyles = partitionStyles(plainText, chunks, textStyles);
      for (const [index, chunk] of chunks.entries()) {
        const params: Record<string, any> = { message: chunk, ...recipientParams };
        if (chunkStyles[index]?.length) params.textStyle = chunkStyles[index];
        if (msg.media.length && index === 0) params.attachments = msg.media;
        const response = await this.sendRequest("send", params);
        if (response.error) throw new Error(`signal-cli send failed: ${JSON.stringify(response.error)}`);
      }
    } finally {
      if (!isProgress) await this.stopTyping(msg.chatId, false);
    }
  }

  async sseReceiveLoop(): Promise<void> {
    if (!this.httpClient) throw new Error("HTTP client not initialized for Signal SSE stream");
    const ctx = this.httpClient.stream("GET", "/api/v1/events");
    const response = typeof ctx?.then === "function" ? await ctx : ctx;
    const manager = typeof response?.[Symbol.asyncIterator] === "function" ? null : response;
    const stream = manager && typeof manager.__aenter__ === "function" ? await manager.__aenter__() : response;
    try {
      if (stream.statusCode !== undefined && stream.statusCode !== 200) throw new Error(`SSE connection failed with status ${stream.statusCode}`);
      const eventBuffer: string[] = [];
      for await (const lineRaw of stream.iterLines()) {
        const line = String(lineRaw);
        if (!line || line === ":") {
          if (eventBuffer.length) {
            try {
              await this.handleReceiveNotification(JSON.parse(eventBuffer.join("\n")));
            } catch {
              // Bad SSE frames are skipped; the stream remains live.
            }
            eventBuffer.length = 0;
          }
        } else if (line.startsWith("data:")) {
          eventBuffer.push(line[5] === " " ? line.slice(6) : line.slice(5));
        }
      }
      if (this.running) throw new Error("Signal SSE stream closed by remote endpoint");
    } finally {
      if (manager && typeof manager.__aexit__ === "function") await manager.__aexit__(null, null, null);
    }
  }

  async handleReceiveNotification(params: Record<string, any>): Promise<void> {
    try {
      const envelope = params.envelope ?? {};
      if (!envelope || typeof envelope !== "object") return;
      const senderParts = SignalChannel.collectSenderIdParts(envelope);
      if (!senderParts.length) return;
      const senderNumber = SignalChannel.primarySenderId(senderParts);
      const senderId = senderParts.join("|");
      if (senderParts.some((part) => this.idMatchesAccount(part))) {
        for (const part of senderParts) this.rememberAccountIdAlias(part);
      }
      if (envelope.receiptMessage) return;
      if (envelope.typingMessage) return;
      if (envelope.dataMessage) await this.handleDataMessage(senderId, senderNumber, envelope.dataMessage, envelope.sourceName ?? null);
    } catch {
      // Inbound notification handling is best-effort; malformed daemon events must not kill the channel.
    }
  }

  async handleDataMessage(senderId: string, senderNumber: string, dataMessage: Record<string, any>, senderName: string | null): Promise<void> {
    const messageText = dataMessage.message || "";
    const attachments = Array.isArray(dataMessage.attachments) ? dataMessage.attachments : [];
    const mentions = Array.isArray(dataMessage.mentions) ? dataMessage.mentions : [];
    const timestamp = dataMessage.timestamp;
    if (dataMessage.reaction) return;
    if (!messageText && !attachments.length) return;
    const groupId = SignalChannel.extractGroupId(dataMessage.groupInfo, dataMessage.groupV2);
    const isGroupMessage = dataMessage.groupInfo != null || dataMessage.groupV2 != null;
    const [allowed, chatId] = this.checkInboundPolicy({
      senderId,
      senderNumber,
      groupId,
      isGroupMessage,
      messageText,
      mentions,
      senderName,
      timestamp,
    });
    if (!allowed) {
      if (!isGroupMessage && this.config.dm.enabled) {
        await super.handleMessage({ senderId, chatId, content: "", isDm: true });
      }
      return;
    }
    const [content, media] = this.assembleInboundContent({
      senderName,
      senderNumber,
      messageText,
      attachments,
      mentions,
      isGroupMessage,
      chatId,
    });
    await this.startTyping(chatId);
    try {
      await this.handleMessage({
        senderId,
        chatId,
        content,
        media,
        metadata: {
          timestamp,
          senderName,
          senderNumber,
          isGroup: isGroupMessage,
          groupId,
        },
        isDm: !isGroupMessage,
      });
    } catch (error) {
      await this.stopTyping(chatId);
      throw error;
    }
  }

  checkInboundPolicy({
    senderId,
    senderNumber,
    groupId = null,
    isGroupMessage,
    messageText,
    mentions = [],
    senderName,
    timestamp,
  }: {
    senderId: string;
    senderNumber: string;
    groupId?: string | null;
    isGroupMessage: boolean;
    messageText: string;
    mentions?: any[];
    senderName?: string | null;
    timestamp?: number | null;
  }): [boolean, string] {
    if (isGroupMessage) {
      const chatId = groupId || senderNumber;
      if (!this.config.group.enabled) return [false, chatId];
      if (this.config.group.policy === "allowlist" && !this.config.group.allowFrom.includes(chatId)) return [false, chatId];
      this.addToGroupBuffer(chatId, senderName || senderNumber, senderNumber, messageText, timestamp ?? null);
      const isCommand = messageText.trim().startsWith("/");
      if (!isCommand && !this.shouldRespondInGroup(messageText, mentions)) return [false, chatId];
      return [true, chatId];
    }
    const chatId = senderNumber;
    if (!this.config.dm.enabled) return [false, chatId];
    if (this.config.dm.policy === "allowlist" && !SignalChannel.senderMatchesAllowlist(senderId, this.config.dm.allowFrom)) return [false, chatId];
    return [true, chatId];
  }

  assembleInboundContent({
    senderName,
    senderNumber,
    messageText,
    attachments,
    mentions,
    isGroupMessage,
    chatId,
  }: {
    senderName: string | null;
    senderNumber: string;
    messageText: string;
    attachments: any[];
    mentions: any[];
    isGroupMessage: boolean;
    chatId: string;
  }): [string, string[]] {
    const parts: string[] = [];
    const media: string[] = [];
    if (isGroupMessage) {
      const context = this.getGroupBufferContext(chatId);
      if (context) parts.push(`[Recent group messages for context:]\n${context}\n---`);
      messageText = this.stripBotMention(messageText, mentions);
      if (messageText) parts.push(`[${senderName || senderNumber}]: ${messageText}`);
    } else if (messageText) {
      parts.push(messageText);
    }
    if (attachments.length) {
      const mediaDir = getMediaDir("signal");
      fs.mkdirSync(mediaDir, { recursive: true });
      for (const attachment of attachments) {
        const attachmentId = attachment?.id;
        if (!attachmentId) continue;
        const filename = attachment.filename || `attachment_${attachmentId}`;
        try {
          const source = path.join(this.signalAttachmentsDir(), String(attachmentId));
          if (fs.existsSync(source)) {
            const dest = path.join(mediaDir, `signal_${safeFilename(filename)}`);
            fs.copyFileSync(source, dest);
            media.push(dest);
            const type = String(attachment.contentType || "").split("/", 1)[0];
            const markerType = ["image", "audio", "video"].includes(type) ? type : "file";
            parts.push(`[${markerType}: ${dest}]`);
          } else {
            parts.push(`[attachment: ${filename} - not found]`);
          }
        } catch {
          parts.push(`[attachment: ${filename} - error]`);
        }
      }
    }
    return [parts.join("\n") || "[empty message]", media];
  }

  addToGroupBuffer(groupId: string, senderName: string, senderNumber: string, messageText: string, timestamp: number | null): void {
    const buffer = (this.groupBuffers[groupId] ??= []);
    buffer.push({ senderName, senderNumber, content: messageText, timestamp });
    while (buffer.length > this.config.groupMessageBufferSize) buffer.shift();
  }

  getGroupBufferContext(groupId: string): string {
    const buffer = this.groupBuffers[groupId] ?? [];
    if (buffer.length <= 1) return "";
    return buffer
      .slice(0, -1)
      .map((msg) => `${msg.senderName}: ${String(msg.content).slice(0, 200)}`)
      .join("\n");
  }

  signalAttachmentsDir(): string {
    return this.config.attachmentsDir ? expandHome(this.config.attachmentsDir) : path.join(os.homedir(), ".local/share/signal-cli/attachments");
  }

  static normalizeSignalId(value: string): string[] {
    const raw = String(value || "").trim();
    if (!raw) return [];
    const out = [raw, raw.toLowerCase()];
    if (raw.startsWith("+") && raw.length > 1) out.push(raw.slice(1));
    else if (/^\d+$/.test(raw)) out.push(`+${raw}`);
    return unique(out);
  }

  static senderMatchesAllowlist(senderId: string, allowList: string[]): boolean {
    if (!allowList.length) return false;
    const senderVariants = new Set<string>();
    for (const part of String(senderId).split("|")) for (const variant of this.normalizeSignalId(part)) senderVariants.add(variant);
    const allowVariants = new Set<string>();
    for (const entry of allowList) for (const part of String(entry).split("|")) for (const variant of this.normalizeSignalId(part)) allowVariants.add(variant);
    return [...senderVariants].some((variant) => allowVariants.has(variant));
  }

  rememberAccountIdAlias(value: string | null | undefined): void {
    if (typeof value !== "string") return;
    for (const candidate of SignalChannel.normalizeSignalId(value)) this.accountIdAliases.add(candidate);
  }

  idMatchesAccount(value: string | null | undefined): boolean {
    if (typeof value !== "string") return false;
    return SignalChannel.normalizeSignalId(value).some((candidate) => this.accountIdAliases.has(candidate));
  }

  static collectSenderIdParts(envelope: Record<string, any>): string[] {
    const parts: string[] = [];
    for (const key of ["sourceNumber", "source", "sourceUuid", "sourceServiceId", "sourceAci", "sourceACI"]) {
      const value = envelope[key];
      if (typeof value !== "string") continue;
      const candidate = value.trim();
      if (candidate && !parts.includes(candidate)) parts.push(candidate);
    }
    return parts;
  }

  static primarySenderId(senderParts: string[]): string {
    return senderParts.find((part) => part.startsWith("+") || /^\d+$/.test(part)) ?? senderParts[0] ?? "";
  }

  static extractGroupId(groupInfo: any, groupV2: any): string | null {
    for (const group of [groupInfo, groupV2]) {
      if (!group || typeof group !== "object") continue;
      for (const key of ["groupId", "id", "groupID"]) {
        if (typeof group[key] === "string" && group[key]) return group[key];
      }
    }
    return null;
  }

  static mentionIdCandidates(mention: Record<string, any>): string[] {
    const ids: string[] = [];
    const walk = (value: any, depth = 0): void => {
      if (!value || typeof value !== "object" || depth > 2) return;
      for (const [key, child] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (typeof child === "string" && child && ["number", "uuid", "serviceid", "aci"].some((token) => lower.includes(token))) ids.push(child);
        else if (child && typeof child === "object") walk(child, depth + 1);
      }
    };
    walk(mention);
    return unique(ids);
  }

  static mentionSpan(mention: Record<string, any>): [number, number] | null {
    const start = Number(mention.start ?? 0);
    const length = Number(mention.length ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(length) || start < 0 || length <= 0) return null;
    return [start, length];
  }

  static leadingPlaceholderSpan(text: string | null | undefined): [number, number] | null {
    if (!text) return null;
    let start = 0;
    while (start < text.length && /\s/.test(text[start])) start += 1;
    const marker = text[start];
    if (!["\ufffc", "\ufffd", "\x1b"].includes(marker)) return null;
    const next = start + 1;
    if (next < text.length && !/\s/.test(text[next])) return null;
    return [start, 1];
  }

  shouldRespondInGroup(messageText: string, mentions: any[]): boolean {
    if (!this.config.group.requireMention) return true;
    for (const mention of mentions) {
      if (!mention || typeof mention !== "object") continue;
      if (SignalChannel.mentionIdCandidates(mention).some((id) => this.idMatchesAccount(id))) return true;
    }
    for (const mention of mentions) {
      if (!mention || typeof mention !== "object") continue;
      if (SignalChannel.mentionIdCandidates(mention).length) continue;
      const span = SignalChannel.mentionSpan(mention);
      if (span && !messageText.slice(0, span[0]).trim()) return true;
    }
    if (!mentions.length && SignalChannel.leadingPlaceholderSpan(messageText)) return true;
    return SignalChannel.normalizeSignalId(this.config.phoneNumber).some((id) => Boolean(id && messageText.includes(id)));
  }

  stripBotMention(text: string, mentions: any[]): string {
    if (!text) return text;
    const spans: Array<[number, number]> = [];
    for (const mention of mentions) {
      if (!mention || typeof mention !== "object") continue;
      const span = SignalChannel.mentionSpan(mention);
      if (!span) continue;
      const ids = SignalChannel.mentionIdCandidates(mention);
      if (ids.some((id) => this.idMatchesAccount(id)) || (!ids.length && !text.slice(0, span[0]).trim())) spans.push(span);
    }
    if (!spans.length) {
      const placeholder = SignalChannel.leadingPlaceholderSpan(text);
      if (placeholder) spans.push(placeholder);
    }
    for (const [start, length] of spans.sort((a, b) => b[0] - a[0])) {
      text = text.slice(0, start) + text.slice(Math.min(text.length, start + length));
    }
    return text.trim();
  }

  static isGroupChatId(chatId: string): boolean {
    return String(chatId).includes("=") || (String(chatId).length > 40 && !String(chatId).includes("-"));
  }

  recipientParams(chatId: string): Record<string, any> {
    return SignalChannel.isGroupChatId(chatId) ? { groupId: chatId } : { recipient: [chatId] };
  }

  async startTyping(chatId: string): Promise<void> {
    await this.stopTyping(chatId, false);
    await this.sendTyping(chatId);
    this.typingTasks[chatId] = true;
  }

  async stopTyping(chatId: string, sendStop = true): Promise<void> {
    const hadTask = Boolean(this.typingTasks[chatId]);
    delete this.typingTasks[chatId];
    if (sendStop && hadTask) await this.sendTyping(chatId, true);
  }

  async sendTyping(chatId: string, stop = false): Promise<void> {
    const params = this.recipientParams(chatId);
    if (stop) params.stop = true;
    await this.sendRequest("sendTyping", params);
  }

  async sendRequest(method: string, params: Record<string, any> = {}): Promise<Record<string, any>> {
    this.requestId += 1;
    const request: Record<string, any> = { jsonrpc: "2.0", method, id: this.requestId };
    if (Object.keys(params).length) request.params = params;
    return this.sendHttpRequest(request);
  }

  async sendHttpRequest(request: Record<string, any>): Promise<Record<string, any>> {
    if (!this.httpClient) throw new Error("Not connected to signal-cli daemon");
    try {
      const response = await this.httpClient.post("/api/v1/rpc", { json: request });
      response.raiseForStatus?.();
      return response.json?.() ?? {};
    } catch (error: any) {
      return { error: { message: String(error?.message ?? error) } };
    }
  }

}

function signalBaseUrl(config: SignalConfig): string {
  return `http://${config.daemonHost}:${config.daemonPort}`;
}

function createSignalResponse(response: Response, text: string): any {
  return {
    statusCode: response.status,
    text,
    json: () => JSON.parse(text || "{}"),
    raiseForStatus: () => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
  };
}

function createSignalFetchHttpClient(config: SignalConfig): any {
  const baseUrl = signalBaseUrl(config).replace(/\/+$/, "");
  const eventSources = new Set<any>();
  const request = async (method: string, apiPath: string, options: any = {}): Promise<any> => {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers: options.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
    });
    return createSignalResponse(response, await response.text());
  };
  return {
    get: (apiPath: string, options: any = {}) => request("GET", apiPath, options),
    post: (apiPath: string, options: any = {}) => request("POST", apiPath, options),
    stream: async (method: string, apiPath: string) => {
      if (method.toUpperCase() === "GET") {
        const { EventSource } = await import("eventsource");
        const queue: string[] = [];
        let wake: (() => void) | null = null;
        let closed = false;
        const notify = () => {
          const fn = wake;
          wake = null;
          fn?.();
        };
        const source = new EventSource(`${baseUrl}${apiPath}`);
        eventSources.add(source);
        source.onmessage = (event: any) => {
          queue.push(`data: ${event.data}`, "");
          notify();
        };
        source.onerror = () => {
          closed = true;
          notify();
        };
        return {
          statusCode: 200,
          close: () => {
            closed = true;
            source.close();
            eventSources.delete(source);
            notify();
          },
          async *iterLines() {
            try {
              while (!closed || queue.length) {
                const line = queue.shift();
                if (line !== undefined) {
                  yield line;
                  continue;
                }
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
            } finally {
              closed = true;
              source.close();
              eventSources.delete(source);
            }
          },
        };
      }
      const response = await fetch(`${baseUrl}${apiPath}`, { method });
      return {
        statusCode: response.status,
        async *iterLines() {
          const reader = response.body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.search(/\r?\n/)) >= 0) {
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? idx + 2 : idx + 1);
              yield line;
            }
          }
          if (buffer) yield buffer;
        },
      };
    },
    close: async () => {
      for (const source of eventSources) source.close();
      eventSources.clear();
    },
    aclose: async () => {
      for (const source of eventSources) source.close();
      eventSources.clear();
    },
  };
}
