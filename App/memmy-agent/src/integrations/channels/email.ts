import fs from "node:fs";
import path from "node:path";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

export type EmailAuthResult = [spfPass: boolean, dkimPass: boolean];

export type ParsedEmailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

export type ParsedEmail = {
  headers: Record<string, string[]>;
  rawHeaders: Record<string, string>;
  from: string;
  subject: string;
  date: string;
  messageId: string;
  plainBodies: string[];
  htmlBodies: string[];
  attachments: ParsedEmailAttachment[];
};

export type EmailEnvelope = {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
};

const IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IMAP_RECONNECT_MARKERS = [
  "disconnected for inactivity",
  "eof occurred in violation of protocol",
  "socket error",
  "connection reset",
  "broken pipe",
  "bye",
];
const IMAP_MISSING_MAILBOX_MARKERS = ["mailbox doesn't exist", "select failed", "no such mailbox", "can't open mailbox", "does not exist"];

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseAddress(value: string): string {
  const raw = String(value || "").trim();
  const angle = /<([^<>@\s]+@[^<>\s]+)>/.exec(raw);
  if (angle) return angle[1].trim().toLowerCase();
  const match = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(raw);
  return match ? match[1].trim().toLowerCase() : "";
}

function splitHeaderParams(value: string): { value: string; params: Record<string, string> } {
  const parts = value.split(";");
  const first = (parts.shift() ?? "").trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = stripQuotes(part.slice(eq + 1));
    if (key) params[key] = decodeHeaderValue(val);
  }
  return { value: first, params };
}

function decodeQuotedPrintable(value: string): Buffer {
  const softBreaks = value.replace(/=\r?\n/g, "");
  const binary = softBreaks.replace(/=([0-9a-f]{2})/gi, (match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(binary, "binary");
}

function decodeBody(value: string, encoding: string): Buffer {
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "base64") return Buffer.from(value.replace(/\s+/g, ""), "base64");
  if (normalized === "quoted-printable") return decodeQuotedPrintable(value);
  return Buffer.from(value, "utf8");
}

function decodeBuffer(buffer: Buffer, charset = "utf-8"): string {
  const normalized = charset.trim().toLowerCase();
  if (normalized === "utf-8" || normalized === "utf8" || normalized === "us-ascii") return buffer.toString("utf8");
  if (normalized === "latin1" || normalized === "iso-8859-1") return buffer.toString("latin1");
  return buffer.toString("utf8");
}

function decodeHeaderValue(value: string): string {
  if (!value) return "";
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (match, charset: string, encoding: string, payload: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === "b"
          ? Buffer.from(payload, "base64")
          : decodeQuotedPrintable(payload.replaceAll("_", " "));
      return decodeBuffer(bytes, charset);
    } catch {
      return payload;
    }
  });
}

function parseHeaders(raw: string): { headers: Record<string, string[]>; rawHeaders: Record<string, string> } {
  const headers: Record<string, string[]> = {};
  const rawHeaders: Record<string, string> = {};
  let current = "";
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && current) {
      current += ` ${line.trim()}`;
      continue;
    }
    if (current) {
      const idx = current.indexOf(":");
      if (idx >= 0) {
        const name = current.slice(0, idx).trim();
        const key = name.toLowerCase();
        const value = decodeHeaderValue(current.slice(idx + 1).trim());
        (headers[key] ??= []).push(value);
        rawHeaders[name] = value;
      }
    }
    current = line;
  }
  if (current) {
    const idx = current.indexOf(":");
    if (idx >= 0) {
      const name = current.slice(0, idx).trim();
      const key = name.toLowerCase();
      const value = decodeHeaderValue(current.slice(idx + 1).trim());
      (headers[key] ??= []).push(value);
      rawHeaders[name] = value;
    }
  }
  return { headers, rawHeaders };
}

function firstHeader(headers: Record<string, string[]>, name: string): string {
  return headers[name.toLowerCase()]?.[0] ?? "";
}

function splitRawMessage(raw: string): { headerText: string; bodyText: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const idx = normalized.search(/\n\n/);
  if (idx < 0) return { headerText: normalized, bodyText: "" };
  return { headerText: normalized.slice(0, idx), bodyText: normalized.slice(idx + 2) };
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  for (const piece of body.split(marker).slice(1)) {
    if (piece.startsWith("--")) break;
    const cleaned = piece.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (cleaned.trim()) parts.push(cleaned);
  }
  return parts;
}

function safeFilename(name: string): string {
  return path.basename(String(name || "attachment")).replace(/[^\w.\-]+/g, "_") || "attachment";
}

function mimeMatches(contentType: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const lower = contentType.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = String(pattern).trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === "*") return true;
    if (normalized.endsWith("/*")) return lower.startsWith(`${normalized.slice(0, -1)}`);
    if (normalized.includes("*")) {
      const re = new RegExp(`^${normalized.split("*").map(escapeRegExp).join(".*")}$`);
      return re.test(lower);
    }
    return lower === normalized;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

function parseImapStatus(result: any): { status: string; data: any } {
  if (Array.isArray(result)) return { status: String(result[0] ?? ""), data: result[1] ?? [] };
  if (result && typeof result === "object") return { status: String(result.status ?? "OK"), data: result.data ?? result };
  return { status: "", data: [] };
}

function parseImapIds(data: any): any[] {
  const first = Array.isArray(data) ? data[0] : data;
  const text = Buffer.isBuffer(first) ? first.toString("utf8") : String(first ?? "");
  return text.trim() ? text.trim().split(/\s+/).map((id) => Buffer.from(id)) : [];
}

async function maybeAwait<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

export class EmailConfig {
  enabled = false;
  consentGranted = false;
  imapHost = "";
  imapPort = 993;
  imapUsername = "";
  imapPassword = "";
  imapMailbox = "INBOX";
  imapUseSsl = true;
  smtpHost = "";
  smtpPort = 587;
  smtpUsername = "";
  smtpPassword = "";
  smtpUseTls = true;
  smtpUseSsl = false;
  fromAddress = "";
  autoReplyEnabled = true;
  pollIntervalSeconds = 30;
  markSeen = true;
  maxBodyChars = 12_000;
  subjectPrefix = "Re: ";
  allowFrom: string[] = [];
  verifyDkim = true;
  verifySpf = true;
  allowedAttachmentTypes: string[] = [];
  maxAttachmentSize = 2_000_000;
  maxAttachmentsPerEmail = 5;
  imapFactory?: (...args: any[]) => any;
  smtpFactory?: (...args: any[]) => any;
  smtpSslFactory?: (...args: any[]) => any;

  constructor(init: Partial<EmailConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.consentGranted = init.consentGranted ?? this.consentGranted;
    this.imapHost = init.imapHost ?? this.imapHost;
    this.imapPort = Number(init.imapPort ?? this.imapPort);
    this.imapUsername = init.imapUsername ?? this.imapUsername;
    this.imapPassword = init.imapPassword ?? this.imapPassword;
    this.imapMailbox = init.imapMailbox ?? this.imapMailbox;
    this.imapUseSsl = init.imapUseSsl ?? this.imapUseSsl;
    this.smtpHost = init.smtpHost ?? this.smtpHost;
    this.smtpPort = Number(init.smtpPort ?? this.smtpPort);
    this.smtpUsername = init.smtpUsername ?? this.smtpUsername;
    this.smtpPassword = init.smtpPassword ?? this.smtpPassword;
    this.smtpUseTls = init.smtpUseTls ?? this.smtpUseTls;
    this.smtpUseSsl = init.smtpUseSsl ?? this.smtpUseSsl;
    this.fromAddress = init.fromAddress ?? this.fromAddress;
    this.autoReplyEnabled = init.autoReplyEnabled ?? this.autoReplyEnabled;
    this.pollIntervalSeconds = Number(init.pollIntervalSeconds ?? this.pollIntervalSeconds);
    this.markSeen = init.markSeen ?? this.markSeen;
    this.maxBodyChars = Number(init.maxBodyChars ?? this.maxBodyChars);
    this.subjectPrefix = init.subjectPrefix ?? this.subjectPrefix;
    this.allowFrom = asArray(init.allowFrom ?? this.allowFrom);
    this.verifyDkim = init.verifyDkim ?? this.verifyDkim;
    this.verifySpf = init.verifySpf ?? this.verifySpf;
    this.allowedAttachmentTypes = asArray(init.allowedAttachmentTypes ?? this.allowedAttachmentTypes);
    this.maxAttachmentSize = Number(init.maxAttachmentSize ?? this.maxAttachmentSize);
    this.maxAttachmentsPerEmail = Number(init.maxAttachmentsPerEmail ?? this.maxAttachmentsPerEmail);
    this.imapFactory = init.imapFactory ?? this.imapFactory;
    this.smtpFactory = init.smtpFactory ?? this.smtpFactory;
    this.smtpSslFactory = init.smtpSslFactory ?? this.smtpSslFactory;
  }
}

export class EmailChannel extends BaseChannel {
  override name = "email";
  override displayName = "Email";
  override config: EmailConfig;
  selfAddresses: Set<string>;
  lastSubjectByChat: Record<string, string> = {};
  lastMessageIdByChat: Record<string, string> = {};
  processedUids = new Set<string>();
  maxProcessedUids = 100_000;
  pollTimer: NodeJS.Timeout | null = null;

  static override defaultConfig(): Record<string, any> {
    return new EmailConfig() as any;
  }

  constructor(config: Partial<EmailConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof EmailConfig ? config : new EmailConfig(config);
    super("email", normalized, bus);
    this.config = normalized;
    this.selfAddresses = this.collectSelfAddresses();
  }

  async start(): Promise<void> {
    if (!this.config.consentGranted) return;
    if (!this.validateConfig()) return;
    this.running = true;
    const pollMs = Math.max(5, Math.trunc(this.config.pollIntervalSeconds)) * 1000;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, pollMs);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this.config.consentGranted) return;
    if (!this.config.smtpHost) return;

    const toAddr = msg.chatId.trim();
    if (!toAddr) return;

    const isReply = Object.hasOwn(this.lastSubjectByChat, toAddr);
    const forceSend = Boolean(msg.metadata?.force_send ?? msg.metadata?.forceSend);
    if (isReply && !this.config.autoReplyEnabled && !forceSend) return;

    const baseSubject = this.lastSubjectByChat[toAddr] ?? "memmy reply";
    let subject = this.replySubject(baseSubject);
    const override = typeof msg.metadata?.subject === "string" ? msg.metadata.subject.trim() : "";
    if (override) subject = override;

    const headers: Record<string, string> = {
      From: this.config.fromAddress || this.config.smtpUsername || this.config.imapUsername,
      To: toAddr,
      Subject: subject,
    };
    const inReplyTo = this.lastMessageIdByChat[toAddr];
    if (inReplyTo) {
      headers["In-Reply-To"] = inReplyTo;
      headers.References = inReplyTo;
    }
    const envelope: EmailEnvelope = { from: headers.From, to: toAddr, subject, text: msg.content || "", headers };
    await this.smtpSend(envelope);
  }

  validateConfig(): boolean {
    return Boolean(
      this.config.imapHost &&
        this.config.imapUsername &&
        this.config.imapPassword &&
        this.config.smtpHost &&
        this.config.smtpUsername &&
        this.config.smtpPassword,
    );
  }

  async smtpSend(envelope: EmailEnvelope): Promise<void> {
    const factory = this.config.smtpUseSsl ? this.config.smtpSslFactory : this.config.smtpFactory;
    if (!factory) {
      await sendWithNodemailer(this.config, envelope);
      return;
    }
    const client = await maybeAwait(factory(this.config.smtpHost, this.config.smtpPort, { timeout: 30 }));
    try {
      if (!this.config.smtpUseSsl && this.config.smtpUseTls) await maybeAwait(client.startTls?.());
      if (this.config.smtpUsername || this.config.smtpPassword) {
        await maybeAwait(client.login?.(this.config.smtpUsername, this.config.smtpPassword) ?? client.auth?.(this.config.smtpUsername, this.config.smtpPassword));
      }
      await maybeAwait(client.sendMessage?.(envelope) ?? client.send?.(envelope));
    } finally {
      await maybeAwait(client.quit?.() ?? client.close?.() ?? client.end?.());
    }
  }

  fetchNewMessages(): any[] {
    return this.fetchMessages({
      searchCriteria: ["UNSEEN"],
      markSeen: this.config.markSeen,
      dedupe: true,
      limit: 0,
    });
  }

  fetchMessagesBetweenDates(startDate: Date, endDate: Date, limit = 20): any[] {
    if (endDate <= startDate) return [];
    return this.fetchMessages({
      searchCriteria: ["SINCE", EmailChannel.formatImapDate(startDate), "BEFORE", EmailChannel.formatImapDate(endDate)],
      markSeen: false,
      dedupe: false,
      limit: Math.max(1, Math.trunc(limit)),
    });
  }

  fetchMessages({
    searchCriteria,
    markSeen,
    dedupe,
    limit,
  }: {
    searchCriteria: string[];
    markSeen: boolean;
    dedupe: boolean;
    limit: number;
  }): any[] {
    const messages: any[] = [];
    const cycleUids = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.fetchMessagesOnce(searchCriteria, markSeen, dedupe, limit, messages, cycleUids);
        return messages;
      } catch (error: any) {
        if (attempt === 1 || !EmailChannel.isStaleImapError(error)) throw error;
      }
    }
    return messages;
  }

  fetchMessagesOnce(searchCriteria: string[], markSeen: boolean, dedupe: boolean, limit: number, messages: any[], cycleUids: Set<string>): void {
    const factory = this.config.imapFactory;
    if (!factory) return;
    const client = factory(this.config.imapHost, this.config.imapPort, { ssl: this.config.imapUseSsl });
    const mailbox = this.config.imapMailbox || "INBOX";
    try {
      client.login?.(this.config.imapUsername, this.config.imapPassword);
      let selected: any;
      try {
        selected = client.select?.(mailbox);
      } catch (error: any) {
        if (EmailChannel.isMissingMailboxError(error)) return;
        throw error;
      }
      const selectStatus = parseImapStatus(selected);
      if (selectStatus.status && selectStatus.status !== "OK") return;

      const searched = client.search?.(null, ...searchCriteria);
      const searchStatus = parseImapStatus(searched);
      if (searchStatus.status && searchStatus.status !== "OK") return;
      let ids = parseImapIds(searchStatus.data);
      if (limit > 0 && ids.length > limit) ids = ids.slice(-limit);

      for (const imapId of ids) {
        const fetched = client.fetch?.(imapId, "(BODY.PEEK[] UID)");
        const fetchStatus = parseImapStatus(fetched);
        if (fetchStatus.status && fetchStatus.status !== "OK") continue;
        const raw = EmailChannel.extractMessageBytes(fetchStatus.data);
        if (!raw) continue;
        const uid = EmailChannel.extractUid(fetchStatus.data);
        if (uid && cycleUids.has(uid)) continue;
        if (dedupe && uid && this.processedUids.has(uid)) continue;

        const parsed = EmailChannel.parseRawEmail(raw);
        const sender = EmailChannel.normalizeAddress(parsed.from);
        if (!sender) continue;
        if (this.isSelfAddress(sender)) {
          this.rememberProcessedUid(uid, dedupe, cycleUids);
          if (markSeen) client.store?.(imapId, "+FLAGS", "\\Seen");
          continue;
        }

        const [spfPass, dkimPass] = EmailChannel.checkAuthenticationResults(parsed);
        if ((this.config.verifySpf && !spfPass) || (this.config.verifyDkim && !dkimPass)) {
          this.rememberProcessedUid(uid, dedupe, cycleUids);
          continue;
        }

        if (!this.isAllowed(sender)) {
          this.rememberProcessedUid(uid, dedupe, cycleUids);
          if (markSeen) client.store?.(imapId, "+FLAGS", "\\Seen");
          continue;
        }

        const body = (EmailChannel.extractTextBody(parsed) || "(empty email body)").slice(0, this.config.maxBodyChars);
        let content = `[EMAIL-CONTEXT] Email received.\nFrom: ${sender}\nSubject: ${parsed.subject}\nDate: ${parsed.date}\n\n${body}`;
        const media: string[] = [];
        if (this.config.allowedAttachmentTypes.length) {
          for (const saved of EmailChannel.extractAttachments(parsed, uid || "noid", {
            allowedTypes: this.config.allowedAttachmentTypes,
            maxSize: this.config.maxAttachmentSize,
            maxCount: this.config.maxAttachmentsPerEmail,
          })) {
            media.push(saved);
            content += `\n[attachment: ${path.basename(saved)} - saved to ${saved}]`;
          }
        }

        messages.push({
          sender,
          subject: parsed.subject,
          message_id: parsed.messageId,
          messageId: parsed.messageId,
          content,
          metadata: {
            message_id: parsed.messageId,
            messageId: parsed.messageId,
            subject: parsed.subject,
            date: parsed.date,
            sender_email: sender,
            senderEmail: sender,
            uid,
          },
          media,
        });
        this.rememberProcessedUid(uid, dedupe, cycleUids);
        if (markSeen) client.store?.(imapId, "+FLAGS", "\\Seen");
      }
    } finally {
      client.logout?.();
      client.close?.();
    }
  }

  async pollOnce(): Promise<void> {
    const items = await this.fetchNewMessagesRuntime();
    for (const item of items) {
      if (item.subject) this.lastSubjectByChat[item.sender] = item.subject;
      if (item.message_id) this.lastMessageIdByChat[item.sender] = item.message_id;
      await this.handleMessage({
        senderId: item.sender,
        chatId: item.sender,
        content: item.content,
        media: item.media,
        metadata: item.metadata,
      });
    }
  }

  async fetchNewMessagesRuntime(): Promise<any[]> {
    if (this.config.imapFactory) return this.fetchNewMessages();
    return await this.fetchMessagesViaImapFlow({
      searchCriteria: ["UNSEEN"],
      markSeen: this.config.markSeen,
      dedupe: true,
      limit: 0,
    });
  }

  async fetchMessagesViaImapFlow({
    searchCriteria,
    markSeen,
    dedupe,
    limit,
  }: {
    searchCriteria: string[];
    markSeen: boolean;
    dedupe: boolean;
    limit: number;
  }): Promise<any[]> {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.imapUseSsl,
      auth: {
        user: this.config.imapUsername,
        pass: this.config.imapPassword,
      },
      logger: false,
    } as any);
    const messages: any[] = [];
    const cycleUids = new Set<string>();
    await client.connect();
    try {
      try {
        await client.mailboxOpen(this.config.imapMailbox || "INBOX");
      } catch (error: any) {
        if (EmailChannel.isMissingMailboxError(error)) return [];
        throw error;
      }
      let ids = (await client.search(EmailChannel.imapFlowSearchQuery(searchCriteria), { uid: true })) || [];
      if (limit > 0 && ids.length > limit) ids = ids.slice(-limit);
      if (!ids.length) return [];
      for await (const fetched of client.fetch(ids, { uid: true, source: true }, { uid: true })) {
        const raw = fetched.source;
        if (!raw) continue;
        const uid = String(fetched.uid ?? "");
        if (uid && cycleUids.has(uid)) continue;
        if (dedupe && uid && this.processedUids.has(uid)) continue;

        const parsed = EmailChannel.parseRawEmail(raw);
        const sender = EmailChannel.normalizeAddress(parsed.from);
        if (!sender) continue;
        if (this.isSelfAddress(sender)) {
          this.rememberProcessedUid(uid, dedupe, cycleUids);
          if (markSeen && uid) await client.messageFlagsAdd([Number(uid)], ["\\Seen"], { uid: true });
          continue;
        }

        const [spfPass, dkimPass] = EmailChannel.checkAuthenticationResults(parsed);
        if ((this.config.verifySpf && !spfPass) || (this.config.verifyDkim && !dkimPass)) {
          this.rememberProcessedUid(uid, dedupe, cycleUids);
          continue;
        }

        if (!this.isAllowed(sender)) {
          this.rememberProcessedUid(uid, dedupe, cycleUids);
          if (markSeen && uid) await client.messageFlagsAdd([Number(uid)], ["\\Seen"], { uid: true });
          continue;
        }

        const body = (EmailChannel.extractTextBody(parsed) || "(empty email body)").slice(0, this.config.maxBodyChars);
        let content = `[EMAIL-CONTEXT] Email received.\nFrom: ${sender}\nSubject: ${parsed.subject}\nDate: ${parsed.date}\n\n${body}`;
        const media: string[] = [];
        if (this.config.allowedAttachmentTypes.length) {
          for (const saved of EmailChannel.extractAttachments(parsed, uid || "noid", {
            allowedTypes: this.config.allowedAttachmentTypes,
            maxSize: this.config.maxAttachmentSize,
            maxCount: this.config.maxAttachmentsPerEmail,
          })) {
            media.push(saved);
            content += `\n[attachment: ${path.basename(saved)} - saved to ${saved}]`;
          }
        }

        messages.push({
          sender,
          subject: parsed.subject,
          message_id: parsed.messageId,
          messageId: parsed.messageId,
          content,
          metadata: {
            message_id: parsed.messageId,
            messageId: parsed.messageId,
            subject: parsed.subject,
            date: parsed.date,
            sender_email: sender,
            senderEmail: sender,
            uid,
          },
          media,
        });
        this.rememberProcessedUid(uid, dedupe, cycleUids);
        if (markSeen && uid) await client.messageFlagsAdd([Number(uid)], ["\\Seen"], { uid: true });
      }
      return messages;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  collectSelfAddresses(): Set<string> {
    const out = new Set<string>();
    for (const candidate of [this.config.fromAddress, this.config.smtpUsername, this.config.imapUsername]) {
      const normalized = EmailChannel.normalizeAddress(candidate);
      if (normalized) out.add(normalized);
    }
    return out;
  }

  static normalizeAddress(value: string): string {
    return parseAddress(value) || (String(value || "").includes("@") ? String(value).trim().toLowerCase() : "");
  }

  isSelfAddress(sender: string): boolean {
    const normalized = EmailChannel.normalizeAddress(sender);
    return Boolean(normalized && this.selfAddresses.has(normalized));
  }

  rememberProcessedUid(uid: string, dedupe: boolean, cycleUids: Set<string>): void {
    if (!uid) return;
    cycleUids.add(uid);
    if (!dedupe) return;
    this.processedUids.add(uid);
    if (this.processedUids.size > this.maxProcessedUids) {
      this.processedUids = new Set([...this.processedUids].slice(Math.floor(this.processedUids.size / 2)));
    }
  }

  static isStaleImapError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error).toLowerCase();
    return IMAP_RECONNECT_MARKERS.some((marker) => message.includes(marker));
  }

  static isMissingMailboxError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error).toLowerCase();
    return IMAP_MISSING_MAILBOX_MARKERS.some((marker) => message.includes(marker));
  }

  static formatImapDate(value: Date): string {
    return `${String(value.getUTCDate()).padStart(2, "0")}-${IMAP_MONTHS[value.getUTCMonth()]}-${value.getUTCFullYear()}`;
  }

  static imapFlowSearchQuery(criteria: string[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (let i = 0; i < criteria.length; i += 1) {
      const key = String(criteria[i] ?? "").toUpperCase();
      if (key === "UNSEEN") out.seen = false;
      else if (key === "SEEN") out.seen = true;
      else if (key === "SINCE") out.since = criteria[++i];
      else if (key === "BEFORE") out.before = criteria[++i];
    }
    return Object.keys(out).length ? out : { all: true };
  }

  static extractMessageBytes(fetched: any): Buffer | null {
    const items = Array.isArray(fetched) ? fetched : [fetched];
    for (const item of items) {
      if (Array.isArray(item) && item.length >= 2) {
        const buffer = toBuffer(item[1]);
        if (buffer) return buffer;
      }
      if (item && typeof item === "object") {
        const buffer = toBuffer(item.raw ?? item.source ?? item.body ?? item.content);
        if (buffer) return buffer;
      }
    }
    return null;
  }

  static extractUid(fetched: any): string {
    const items = Array.isArray(fetched) ? fetched : [fetched];
    for (const item of items) {
      const header = Array.isArray(item) ? item[0] : item?.header ?? item?.meta;
      const text = Buffer.isBuffer(header) ? header.toString("utf8") : String(header ?? "");
      const match = /\bUID\s+(\d+)/i.exec(text);
      if (match) return match[1];
    }
    return "";
  }

  static decodeHeaderValue(value: string): string {
    return decodeHeaderValue(value);
  }

  static parseRawEmail(raw: string | Buffer | Uint8Array): ParsedEmail {
    const text = Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : String(raw);
    const parsed = this.parseEntity(text);
    return {
      headers: parsed.headers,
      rawHeaders: parsed.rawHeaders,
      from: firstHeader(parsed.headers, "from"),
      subject: firstHeader(parsed.headers, "subject"),
      date: firstHeader(parsed.headers, "date"),
      messageId: firstHeader(parsed.headers, "message-id").trim(),
      plainBodies: parsed.plainBodies,
      htmlBodies: parsed.htmlBodies,
      attachments: parsed.attachments,
    };
  }

  private static parseEntity(raw: string): ParsedEmail {
    const { headerText, bodyText } = splitRawMessage(raw);
    const { headers, rawHeaders } = parseHeaders(headerText);
    const type = splitHeaderParams(firstHeader(headers, "content-type") || "text/plain; charset=utf-8");
    const disposition = splitHeaderParams(firstHeader(headers, "content-disposition"));
    const encoding = firstHeader(headers, "content-transfer-encoding");
    const plainBodies: string[] = [];
    const htmlBodies: string[] = [];
    const attachments: ParsedEmailAttachment[] = [];

    if (type.value.startsWith("multipart/") && type.params.boundary) {
      for (const part of splitMultipart(bodyText, type.params.boundary)) {
        const child = this.parseEntity(part);
        plainBodies.push(...child.plainBodies);
        htmlBodies.push(...child.htmlBodies);
        attachments.push(...child.attachments);
      }
    } else {
      const decoded = decodeBody(bodyText, encoding);
      const charset = type.params.charset ?? "utf-8";
      const isAttachment = disposition.value === "attachment" || disposition.params.filename || type.params.name;
      if (isAttachment) {
        attachments.push({
          filename: disposition.params.filename || type.params.name || "attachment",
          contentType: type.value || "application/octet-stream",
          content: decoded,
        });
      } else if (type.value === "text/html") {
        htmlBodies.push(decodeBuffer(decoded, charset));
      } else {
        plainBodies.push(decodeBuffer(decoded, charset));
      }
    }

    return {
      headers,
      rawHeaders,
      from: firstHeader(headers, "from"),
      subject: firstHeader(headers, "subject"),
      date: firstHeader(headers, "date"),
      messageId: firstHeader(headers, "message-id"),
      plainBodies,
      htmlBodies,
      attachments,
    };
  }

  static extractTextBody(input: ParsedEmail | string | Buffer | Uint8Array | any): string {
    const parsed: ParsedEmail =
      typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array
        ? this.parseRawEmail(input)
        : input?.plainBodies || input?.htmlBodies
          ? input
          : input?.raw
            ? this.parseRawEmail(input.raw)
            : { plainBodies: [], htmlBodies: [], attachments: [], headers: {}, rawHeaders: {}, from: "", subject: "", date: "", messageId: "" };
    if (parsed.plainBodies?.length) return parsed.plainBodies.join("\n\n").trim();
    if (parsed.htmlBodies?.length) return this.htmlToText(parsed.htmlBodies.join("\n\n")).trim();
    if (typeof input?.get_content === "function") return String(input.get_content()).trim();
    return "";
  }

  static checkAuthenticationResults(input: ParsedEmail | string | Buffer | Uint8Array | any): EmailAuthResult {
    let headers: string[] = [];
    if (typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array) {
      headers = this.parseRawEmail(input).headers["authentication-results"] ?? [];
    } else if (input?.headers) {
      headers = input.headers["authentication-results"] ?? input.headers["Authentication-Results"] ?? [];
    } else if (typeof input?.get_all === "function") {
      headers = input.get_all("Authentication-Results") ?? [];
    }
    let spfPass = false;
    let dkimPass = false;
    for (const header of headers) {
      const lower = String(header).toLowerCase();
      if (/\bspf\s*=\s*pass\b/.test(lower)) spfPass = true;
      if (/\bdkim\s*=\s*pass\b/.test(lower)) dkimPass = true;
    }
    return [spfPass, dkimPass];
  }

  static extractAttachments(
    input: ParsedEmail | string | Buffer | Uint8Array,
    uid: string,
    {
      allowedTypes,
      maxSize,
      maxCount,
    }: {
      allowedTypes?: string[];
      maxSize?: number;
      maxCount?: number;
    },
  ): string[] {
    const parsed = typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array ? this.parseRawEmail(input) : input;
    const types = allowedTypes ?? [];
    const limit = maxSize ?? 2_000_000;
    const count = maxCount ?? 5;
    const saved: string[] = [];
    if (!types.length) return saved;
    const mediaDir = getMediaDir("email");
    fs.mkdirSync(mediaDir, { recursive: true });
    for (const attachment of parsed.attachments ?? []) {
      if (saved.length >= count) break;
      if (!mimeMatches(attachment.contentType, types)) continue;
      if (attachment.content.length > limit) continue;
      const dest = path.join(mediaDir, `${uid}_${safeFilename(attachment.filename)}`);
      try {
        fs.writeFileSync(dest, attachment.content);
        saved.push(dest);
      } catch {
        // Attachment persistence is best-effort, matching the channel's poll-and-continue behavior.
      }
    }
    return saved;
  }

  static htmlToText(rawHtml: string): string {
    return String(rawHtml || "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'");
  }

  replySubject(baseSubject: string): string {
    const subject = (baseSubject || "").trim() || "memmy reply";
    if (subject.toLowerCase().startsWith("re:")) return subject;
    return `${this.config.subjectPrefix || "Re: "}${subject}`;
  }
}

async function sendWithNodemailer(config: EmailConfig, envelope: EmailEnvelope): Promise<void> {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpUseSsl,
    requireTLS: config.smtpUseTls && !config.smtpUseSsl,
    auth:
      config.smtpUsername || config.smtpPassword
        ? {
            user: config.smtpUsername,
            pass: config.smtpPassword,
          }
        : undefined,
  } as any);
  try {
    await transport.sendMail({
      from: envelope.from,
      to: envelope.to,
      subject: envelope.subject,
      text: envelope.text,
      headers: envelope.headers,
    });
  } finally {
    transport.close?.();
  }
}
