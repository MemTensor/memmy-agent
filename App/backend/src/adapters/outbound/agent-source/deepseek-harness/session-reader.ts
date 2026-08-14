import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export interface RawDeepseekHarnessMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  rawMeta: Readonly<Record<string, unknown>>;
}

export async function readDeepseekHarnessSession(
  filePath: string,
  signal?: AbortSignal
): Promise<RawDeepseekHarnessMessage[]> {
  signal?.throwIfAborted();
  const bytes = await readFile(filePath);
  signal?.throwIfAborted();
  const text = filePath.endsWith(".zstd") ? decompressFrames(bytes) : bytes.toString("utf8");
  return parseSessionRows(text, filePath, signal);
}

function decompressFrames(bytes: Buffer): string {
  const offsets: number[] = [];
  for (let offset = 0; offset <= bytes.length - ZSTD_FRAME_MAGIC.length; offset += 1) {
    if (bytes.subarray(offset, offset + ZSTD_FRAME_MAGIC.length).equals(ZSTD_FRAME_MAGIC)) {
      offsets.push(offset);
    }
  }
  if (offsets.length === 0 || offsets[0] !== 0) {
    throw new Error("DeepSeek Harness session has no Zstandard frame header");
  }
  return offsets.map((offset, index) =>
    zstdDecompressSync(bytes.subarray(offset, offsets[index + 1] ?? bytes.length)).toString("utf8")
  ).join("");
}

function parseSessionRows(
  text: string,
  filePath: string,
  signal?: AbortSignal
): RawDeepseekHarnessMessage[] {
  const records = text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const header = records.find((record) => isRecord(record) && record.type === "session");
  const conversationId = isRecord(header) && typeof header.id === "string"
    ? header.id
    : basename(filePath).replace(/\.jsonl(?:\.zstd)?$/u, "");
  const workspacePath = isRecord(header) && typeof header.cwd === "string" ? header.cwd : null;
  const messages: RawDeepseekHarnessMessage[] = [];

  for (const record of records) {
    signal?.throwIfAborted();
    const message = toMessage(record, conversationId, workspacePath);
    if (message) messages.push(message);
  }
  return messages;
}

function toMessage(
  value: unknown,
  conversationId: string,
  workspacePath: string | null
): RawDeepseekHarnessMessage | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const rawMessage = value.type === "user/message"
    ? value.data
    : value.type === "assistant/message" && isRecord(value.data.message)
      ? value.data.message
      : null;
  if (!rawMessage) return null;
  if (value.type === "user/message" && (!isRecord(rawMessage.source) || rawMessage.source.kind !== "user")) {
    return null;
  }
  const role = rawMessage.role;
  if (role !== "user" && role !== "assistant") return null;
  const content = contentText(rawMessage.content);
  if (!content) return null;
  const seq = typeof value.seq === "number" ? value.seq : messagesFallbackSeq(value);
  return {
    messageId: typeof rawMessage.id === "string" ? rawMessage.id : `${conversationId}:${seq}`,
    conversationId,
    role,
    content,
    createdAt: normalizeTimestamp(value.time),
    workspacePath,
    rawMeta: Object.freeze({ seq })
  };
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeTimestamp(value: unknown): string {
  const date = new Date(typeof value === "number" || typeof value === "string" ? value : 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function messagesFallbackSeq(value: Record<string, unknown>): number {
  return typeof value.time === "number" ? value.time : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
