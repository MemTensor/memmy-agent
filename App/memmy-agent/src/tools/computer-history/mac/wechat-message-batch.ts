import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decompress } from "fzstd";
import { WeChatHistoryConsentStore } from "./wechat-consent.js";
import { physicalRuntimeAsset } from "./native-helper.js";

const runFile = promisify(execFile);
const ZSTD_MAGIC = "28b52ffd";
const MESSAGE_TABLE = /^Msg_[0-9a-f]{32}$/u;
const MAX_MESSAGES = 200;
const READER_CATEGORY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

/** Carries the reader's stable reason; never its output, which can contain messages. */
export class WeChatReaderError extends Error {
  constructor(readonly category: string) {
    super("WeChat local reader failed");
  }
}

function readerFailureCategory(error: unknown): string {
  const failure = error as { code?: unknown; killed?: unknown; stderr?: unknown } | null;
  if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "reader_output_too_large";
  if (failure?.killed) return "reader_timeout";
  const last = typeof failure?.stderr === "string" ? failure.stderr.trim().split(/\r?\n/u).at(-1) ?? "" : "";
  try {
    const reported = (JSON.parse(last) as { error?: unknown }).error;
    if (typeof reported === "string" && READER_CATEGORY.test(reported)) return reported;
  } catch { /* Not the reader's own error line. */ }
  return "reader_failed";
}

function hasCursorFile(file: string): boolean {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("WeChat cursor is unreadable");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("WeChat cursor is unreadable");
  }
}

export interface WeChatMessageEvidence {
  source: "personal_wechat";
  accountFingerprint: string;
  conversationId: string;
  messageId: string;
  senderId: string | null;
  direction: "self" | "other" | "unknown";
  chatKind: "private" | "group" | "file_transfer" | "unknown";
  chatName: string | null;
  senderName: string | null;
  fromSelf: boolean | null;
  createdAt: string;
  kind: "text" | "unsupported";
  text: string | null;
  database: string;
  localId: number;
}

interface RawRow {
  database: string;
  table: string;
  localId: number;
  serverId: string | null;
  messageType: number;
  createdAtSeconds: number;
  senderId: string | null;
  bodyHex: string;
  chatKind?: "private" | "group" | "file_transfer" | "unknown";
  chatName?: string | null;
  senderName?: string | null;
  fromSelf?: boolean | null;
}

interface RawBatch {
  messages: RawRow[];
  nextCursor: Record<string, number>;
  databaseCount: number;
}

function assertRawBatch(value: unknown): RawBatch {
  if (!value || typeof value !== "object") throw new Error("invalid WeChat reader response");
  const batch = value as Record<string, unknown>;
  if (!Array.isArray(batch.messages) || batch.messages.length > MAX_MESSAGES
    || !batch.nextCursor || typeof batch.nextCursor !== "object"
    || !Number.isInteger(batch.databaseCount)) throw new Error("invalid WeChat reader response");
  for (const row of batch.messages) {
    if (!row || typeof row !== "object") throw new Error("invalid WeChat message row");
    const message = row as Record<string, unknown>;
    if (typeof message.database !== "string" || !/^message_\d+\.db$/u.test(message.database)
      || typeof message.table !== "string" || !MESSAGE_TABLE.test(message.table)
      || !Number.isSafeInteger(message.localId) || Number(message.localId) < 0
      || !Number.isSafeInteger(message.createdAtSeconds)
      || !Number.isInteger(message.messageType)
      || (message.senderId !== null && typeof message.senderId !== "string")
      || (message.serverId !== null && typeof message.serverId !== "string")
      || typeof message.bodyHex !== "string" || !/^(?:[0-9a-fA-F]{2})*$/u.test(message.bodyHex)
      || (message.chatKind !== undefined && !["private", "group", "file_transfer", "unknown"].includes(String(message.chatKind)))
      || (message.chatName !== undefined && message.chatName !== null && typeof message.chatName !== "string")
      || (message.senderName !== undefined && message.senderName !== null && typeof message.senderName !== "string")
      || (message.fromSelf !== undefined && message.fromSelf !== null && typeof message.fromSelf !== "boolean")) {
      throw new Error("invalid WeChat message row");
    }
  }
  const nextCursor = batch.nextCursor as Record<string, unknown>;
  if (Object.entries(nextCursor).some(([name, cursor]) =>
    !/^message_\d+\.db:Msg_[0-9a-f]{32}$/u.test(name)
    || !Number.isSafeInteger(cursor) || Number(cursor) < 0)) {
    throw new Error("invalid WeChat reader cursor");
  }
  return batch as unknown as RawBatch;
}

function messageKind(localType: number): number {
  return localType % 2 ** 32;
}

function decodeText(row: RawRow): string | null {
  const kind = messageKind(row.messageType);
  if (!row.bodyHex) return null;
  const bytes = Buffer.from(row.bodyHex, "hex");
  const body = row.bodyHex.toLowerCase().startsWith(ZSTD_MAGIC) ? decompress(bytes) : bytes;
  if (kind === 1) return new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (kind === 3) return "发了一张图片";
  if (kind === 49) {
    const xml = new TextDecoder("utf-8", { fatal: false }).decode(body);
    const title = xml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/u);
    const name = title?.[1]?.trim();
    return name ? `发了文件 ${name}` : "发了一个文件";
  }
  return null;
}

export function normalizeWeChatBatch(batch: RawBatch, databaseRoot: string): WeChatMessageEvidence[] {
  const accountFingerprint = crypto.createHash("sha256").update(path.resolve(databaseRoot)).digest("hex");
  return batch.messages.map((row) => {
    const text = decodeText(row);
    const server = row.serverId && row.serverId !== "0" ? row.serverId : null;
    return {
      source: "personal_wechat",
      accountFingerprint,
      conversationId: row.table.slice(4),
      messageId: server ? `${accountFingerprint}:${row.table}:server:${server}`
        : `${accountFingerprint}:${row.database}:${row.table}:${row.localId}`,
      senderId: row.senderId,
      direction: row.fromSelf === true ? "self" : row.fromSelf === false ? "other" : "unknown",
      chatKind: row.chatKind ?? "unknown",
      chatName: row.chatName ?? null,
      senderName: row.senderName ?? null,
      fromSelf: row.fromSelf ?? null,
      createdAt: new Date(row.createdAtSeconds * 1000).toISOString(),
      kind: text === null ? "unsupported" : "text",
      text,
      database: row.database,
      localId: row.localId,
    };
  });
}

/**
 * Reads a batch without acknowledging it. The History intake must persist the
 * normalized messages before atomically saving nextCursor; retry is expected.
 */
export class WeChatMessageBatchReader {
  constructor(
    private readonly options: {
      databaseRoot: string;
      keyFile: string;
      cursorFile: string;
      sqlcipherLibrary: string;
      python?: string;
      pythonArgs?: string[];
      helper?: string;
      consent?: WeChatHistoryConsentStore;
      /** Windows takes its baseline on the first poll, after key capture has already taken time. */
      baselineFromConsent?: boolean;
      /** New accounts begin at their own connection time; old account files fall back to consent time. */
      baselineSince?: number;
    },
  ) {}

  async read(): Promise<{
    messages: WeChatMessageEvidence[];
    nextCursor: Record<string, number>;
    consentId: string;
    /** Freshest resolved display names for self-healing stale captures. */
    names?: unknown;
  }> {
    const consent = this.options.consent ?? new WeChatHistoryConsentStore();
    const current = consent.read();
    const consentId = current.consentId;
    if (!consentId) throw new Error("WeChat chat access is disabled");
    const helper = physicalRuntimeAsset(this.options.helper
      ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "wechat", "read_messages.py"));
    // Baseline once, before any checkpoint exists. A saved checkpoint, even an
    // empty one, belongs to an established connection and must be resumed.
    const hasCursor = hasCursorFile(this.options.cursorFile);
    const mode = hasCursor ? "poll" : "baseline";
    const args = [...(this.options.pythonArgs ?? []), helper, mode, "--root", this.options.databaseRoot,
      "--keys", this.options.keyFile, "--library", this.options.sqlcipherLibrary,
      "--limit", String(MAX_MESSAGES)];
    if (hasCursor) args.push("--cursor", this.options.cursorFile);
    const consentedAt = current.consentedAt ? Date.parse(current.consentedAt) : Number.NaN;
    if (this.options.baselineFromConsent && !Number.isFinite(consentedAt)) {
      throw new Error("WeChat consent time is invalid");
    }
    const since = this.options.baselineFromConsent
      ? Math.max(Math.ceil(consentedAt / 1000), this.options.baselineSince ?? 0)
      : null;
    if (!hasCursor && since !== null) {
      // A failed first read leaves no cursor. Keep the fixed consent/account
      // boundary so a later successful read can recover authorized messages.
      args.push("--since", String(since));
    }
    let stdout: string;
    try {
      ({ stdout } = await runFile(this.options.python ?? "/usr/bin/python3", args, {
        maxBuffer: 16 * 1024 * 1024,
        timeout: this.options.sqlcipherLibrary === "builtin" ? 60_000 : 15_000,
      }));
    } catch (error) {
      // Child output can contain private messages; do not include it in logs.
      throw new WeChatReaderError(readerFailureCategory(error));
    }
    if (consent.read().consentId !== consentId) throw new Error("WeChat chat access was revoked");
    const parsed = JSON.parse(stdout);
    const batch = assertRawBatch(parsed);
    const names = (parsed as { names?: unknown }).names;
    // Local IDs can be out of timestamp order. A baseline cursor alone does not
    // prevent an older message from appearing in later batches.
    const eligible = since === null ? batch.messages
      : batch.messages.filter((row) => row.createdAtSeconds >= since);
    return { messages: normalizeWeChatBatch({ ...batch, messages: eligible }, this.options.databaseRoot),
      nextCursor: batch.nextCursor, consentId,
      ...(names && typeof names === "object" && !Array.isArray(names) ? { names } : {}) };
  }

  /** Call only after the History intake durably accepts every message in the batch. */
  acknowledge(nextCursor: Record<string, number>, consentId: string): void {
    const consent = this.options.consent ?? new WeChatHistoryConsentStore();
    if (!consentId || consent.read().consentId !== consentId) {
      throw new Error("WeChat chat access was revoked");
    }
    if (Object.entries(nextCursor).some(([key, value]) =>
      !/^message_\d+\.db:Msg_[0-9a-f]{32}$/u.test(key)
      || !Number.isSafeInteger(value) || value < 0)) throw new Error("invalid WeChat cursor");
    let previous: Record<string, number> = {};
    try {
      previous = JSON.parse(fs.readFileSync(this.options.cursorFile, "utf8")) as Record<string, number>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("WeChat cursor is unreadable");
    }
    for (const [key, value] of Object.entries(previous)) {
      if (!Number.isSafeInteger(value) || value < 0 || (nextCursor[key] ?? -1) < value) {
        throw new Error("WeChat cursor regressed");
      }
    }
    const directory = path.dirname(this.options.cursorFile);
    hasCursorFile(this.options.cursorFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.cursor-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(nextCursor)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      if (consent.read().consentId !== consentId) throw new Error("WeChat chat access was revoked");
      fs.renameSync(temporary, this.options.cursorFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
