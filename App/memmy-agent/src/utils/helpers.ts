import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { get_encoding } from "tiktoken";
import { GitStore } from "./gitstore.js";

const THINK_BLOCK_RE = /<(think|thought)>([\s\S]*?)<\/\1>/gi;
// Claude-family internal artifact tags (antThinking / antArtifact / antml:* …)
// occasionally leak into visible output, including typo'd variants like
// `</antThthinking>`. Blocks are dropped with their content; orphan tags are
// only stripped at line/edge positions so backticked or prose mentions survive.
const ANT_TAG_NAME = "ant[A-Za-z][\\w:-]*";
const ANT_BLOCK_RE = new RegExp(`<(${ANT_TAG_NAME})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`, "g");
const ANT_ORPHAN_LINE_RE = new RegExp(`(^|\\n)[ \\t]*</?${ANT_TAG_NAME}(?:\\s[^>]*)?>[ \\t]*(?=\\n|$)`, "g");
const ANT_ORPHAN_START_RE = new RegExp(`^\\s*</?${ANT_TAG_NAME}(?:\\s[^>]*)?>`);
const ANT_ORPHAN_END_RE = new RegExp(`</?${ANT_TAG_NAME}(?:\\s[^>]*)?>\\s*$`);
const ANT_PARTIAL_END_RE = new RegExp(`\\s*</?${ANT_TAG_NAME}$`);
const TOOL_RESULT_PREVIEW_CHARS = 1200;
const TOOL_RESULTS_DIR = ".memmy/tool-results";
const TOOL_RESULT_RETENTION_SECS = 7 * 24 * 60 * 60;
const TOOL_RESULT_MAX_BUCKETS = 32;
const UNSAFE_CHARS_RE = /[<>:"/\\|?*]/g;
let tiktokenEncoder: ReturnType<typeof get_encoding> | null | undefined;

export function stripThink(text: string): string {
  if (!text) return "";
  let out = text.replace(THINK_BLOCK_RE, "");
  if (/^\s*<(think|thought)>/i.test(out)) {
    const close = out.search(/<\/(think|thought)>/i);
    out = close >= 0 ? out.slice(close).replace(/^<\/(think|thought)>/i, "") : "";
  }
  out = out.replace(/^\s*<\/(think|thought)>/i, "");
  out = out.replace(/<\/(think|thought)>\s*$/i, "");
  out = out.replace(/^\s*<\|?channel\|?>/i, "");
  out = out.replace(/^\s*<(thi|thin|think|thought)(?![-_:\w/>])\s*/i, "");
  out = out.replace(/^\s*<(think|thought)(?![-_:\w/>])\s*/i, "");
  out = out.replace(/\s*<(thi|thin|think|thought|channel|\|chan|\|channel\|?)>?$/i, "");
  out = out.replace(/\s+<(think|thought)>\s*$/i, "");
  out = out.replace(ANT_BLOCK_RE, "");
  out = out.replace(ANT_ORPHAN_LINE_RE, "$1");
  out = out.replace(ANT_ORPHAN_START_RE, "");
  out = out.replace(ANT_ORPHAN_END_RE, "");
  out = out.replace(ANT_PARTIAL_END_RE, "");
  return out.trim();
}

export function extractThink(text: string): [string | null, string] {
  const parts: string[] = [];
  for (const match of text.matchAll(THINK_BLOCK_RE)) {
    parts.push(match[2].trim());
  }
  if (!parts.length) return [null, stripThink(text)];
  return [parts.join("\n\n"), stripThink(text.replace(THINK_BLOCK_RE, ""))];
}

export class IncrementalThinkExtractor {
  private emitted = "";

  reset(): void {
    this.emitted = "";
  }

  async feed(buf: string, emit: (text: string) => Promise<void> | void): Promise<boolean> {
    const [thinking] = extractThink(buf);
    if (!thinking || thinking === this.emitted) return false;
    const next = thinking.slice(this.emitted.length).trim();
    this.emitted = thinking;
    if (!next) return false;
    await emit(next);
    return true;
  }
}

export function extractReasoning(
  reasoningContent: string | null | undefined,
  thinkingBlocks: Array<Record<string, any>> | null | undefined,
  content: string | null | undefined,
): [string | null, string] {
  const cleanContent = stripThink(content ?? "");
  if (reasoningContent) return [reasoningContent, cleanContent];
  if (thinkingBlocks?.length) {
    const thoughts = thinkingBlocks
      .filter((block) => block.type === "thinking" && block.thinking)
      .map((block) => String(block.thinking));
    if (thoughts.length) return [thoughts.join("\n\n"), cleanContent];
  }
  const [thinking, clean] = extractThink(content ?? "");
  return [thinking, clean];
}

export function detectImageMime(data: Uint8Array): string | null {
  if (
    data.length >= 8 &&
    Buffer.from(data.slice(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  const head6 = Buffer.from(data.slice(0, 6)).toString("ascii");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (
    data.length >= 12 &&
    Buffer.from(data.slice(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.slice(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function buildImageContentBlocks(
  raw: Uint8Array,
  mime: string,
  filePath: string,
  label: string,
): Array<Record<string, any>> {
  const b64 = Buffer.from(raw).toString("base64");
  return [
    {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${b64}` },
      meta: { path: filePath },
    },
    { type: "text", text: label },
  ];
}

export function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function timestamp(): string {
  return new Date().toISOString();
}

function normalizeUtcOffset(value: string): string {
  const text = value.replace(/^GMT/, "UTC");
  if (text === "UTC") return "UTC+00:00";
  const match = text.match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return text;
  const [, sign, hours, minutes = "00"] = match;
  return `UTC${sign}${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

export function currentTimeStr(timezone: string | null = null): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const tzName = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const offset = normalizeUtcOffset(String(parts.timeZoneName ?? "GMT+00:00"));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${parts.weekday}) (${tzName}, ${offset})`;
}

export function safeFilename(name: string): string {
  return name.replace(UNSAFE_CHARS_RE, "_").trim();
}

export function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let idx = rest.lastIndexOf("\n", limit);
    if (idx < limit * 0.5) idx = rest.lastIndexOf(" ", limit);
    if (idx < limit * 0.5) idx = limit;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function imagePlaceholderText(filePath: string, empty = "[image]"): string {
  if (!filePath) return empty;
  return `[image: ${filePath}]`;
}

export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

export function findLegalMessageStart(messages: Array<Record<string, any>>): number {
  const declared = new Set<string>();
  let start = 0;
  messages.forEach((msg, index) => {
    if (msg.role === "assistant") {
      for (const call of msg.tool_calls ?? []) {
        if (call?.id) declared.add(String(call.id));
      }
    } else if (msg.role === "tool") {
      const id = msg.tool_call_id;
      if (id && !declared.has(String(id))) {
        start = index + 1;
        declared.clear();
      }
    }
  });
  return start;
}

export function stringifyTextBlocks(content: Array<Record<string, any>>): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      block.type !== "text" ||
      typeof block.text !== "string"
    )
      return null;
    parts.push(block.text);
  }
  return parts.join("\n");
}

function renderToolResultReference(
  filePath: string,
  {
    originalSize,
    preview,
    truncatedPreview,
  }: { originalSize: number; preview: string; truncatedPreview: boolean },
): string {
  let result = `[tool output persisted]\nFull output saved to: ${filePath}\nOriginal size: ${originalSize} chars\nPreview:\n${preview}`;
  if (truncatedPreview) result += "\n...\n(Read the saved file if you need the full output.)";
  return result;
}

function bucketMtime(dirPath: string): number {
  try {
    return fs.statSync(dirPath).mtimeMs / 1000;
  } catch {
    return 0;
  }
}

function cleanupToolResultBuckets(root: string, currentBucket: string): void {
  if (!fs.existsSync(root)) return;
  const cutoff = Date.now() / 1000 - TOOL_RESULT_RETENTION_SECS;
  let siblings = fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter(
      (entry) =>
        entry !== currentBucket && fs.existsSync(entry) && fs.statSync(entry).isDirectory(),
    );
  for (const entry of siblings) {
    if (bucketMtime(entry) < cutoff) fs.rmSync(entry, { recursive: true, force: true });
  }
  const keep = Math.max(TOOL_RESULT_MAX_BUCKETS - 1, 0);
  siblings = siblings.filter((entry) => fs.existsSync(entry));
  if (siblings.length <= keep) return;
  siblings.sort((a, b) => bucketMtime(b) - bucketMtime(a));
  for (const entry of siblings.slice(keep)) fs.rmSync(entry, { recursive: true, force: true });
}

function writeTextAtomic(filePath: string, content: string): void {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

export function buildAssistantMessage(
  content: string | null,
  toolCalls: Array<Record<string, any>> | null = null,
  reasoningContent: string | null = null,
  thinkingBlocks: Array<Record<string, any>> | null = null,
): Record<string, any> {
  const msg: Record<string, any> = { role: "assistant", content: content ?? "" };
  if (toolCalls?.length) msg.tool_calls = toolCalls;
  if (reasoningContent != null || thinkingBlocks?.length)
    msg.reasoning_content = reasoningContent ?? "";
  if (thinkingBlocks?.length) msg.thinking_blocks = thinkingBlocks;
  return msg;
}

function roughTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function tiktokenCount(text: string): number | null {
  if (!text) return 0;
  try {
    tiktokenEncoder ??= get_encoding("cl100k_base");
    return tiktokenEncoder.encode(text).length;
  } catch {
    tiktokenEncoder = null;
    return null;
  }
}

function countTextTokens(text: string): number {
  return tiktokenCount(text) ?? roughTokenCount(text);
}

export function estimateMessageTokens(message: Record<string, any>): number {
  const parts: string[] = [];
  const content = message.content;
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
        parts.push(part.text);
      else parts.push(JSON.stringify(part));
    }
  } else if (content != null) {
    parts.push(JSON.stringify(content));
  }
  for (const key of ["name", "tool_call_id"]) {
    if (typeof message[key] === "string" && message[key]) parts.push(message[key]);
  }
  if (message.tool_calls) parts.push(JSON.stringify(message.tool_calls));
  if (typeof message.reasoning_content === "string" && message.reasoning_content)
    parts.push(message.reasoning_content);
  const payload = parts.join("\n");
  return payload ? Math.max(4, countTextTokens(payload) + 4) : 4;
}

export function estimatePromptTokens(
  messages: Array<Record<string, any>>,
  tools: Array<Record<string, any>> | null = null,
): number {
  const messageTokens = messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
  return messageTokens + (tools?.length ? countTextTokens(JSON.stringify(tools)) : 0);
}

export function estimatePromptTokensChain(
  providerOrMessages: any,
  model: string | null = null,
  messages: Array<Record<string, any>> | null = null,
  tools: Array<Record<string, any>> | null = null,
): [number, string] | number {
  if (Array.isArray(providerOrMessages) && messages == null)
    return estimatePromptTokens(providerOrMessages, tools);
  const provider = providerOrMessages;
  const providerCounter = provider?.estimatePromptTokens;
  if (typeof providerCounter === "function") {
    try {
      const result = providerCounter.call(provider, messages ?? [], tools ?? null, model);
      const tokens = Array.isArray(result) ? result[0] : result;
      const source = Array.isArray(result) ? result[1] : "provider_counter";
      if (Number(tokens) > 0)
        return [Math.floor(Number(tokens)), String(source || "provider_counter")];
    } catch {
      // Fall through to JSON estimate.
    }
  }
  const estimated = estimatePromptTokens(messages ?? [], tools);
  return [Math.max(1, estimated), tiktokenEncoder ? "tiktoken" : "rough_estimate"];
}

export function buildStatusContent(
  input:
    | string[]
    | {
        version: string;
        model: string | null;
        startTime?: number;
        lastUsage?: Record<string, number>;
        contextWindowTokens?: number;
        sessionMsgCount?: number;
        contextTokensEstimate?: number;
        searchUsageText?: string | null;
        activeTaskCount?: number;
        maxCompletionTokens?: number;
      },
): string {
  if (Array.isArray(input)) return input.filter(Boolean).join("\n");
  const startTime = input.startTime ?? Date.now() / 1000;
  const uptimeS = Math.max(0, Math.floor(Date.now() / 1000 - startTime));
  const uptime =
    uptimeS >= 3600
      ? `${Math.floor(uptimeS / 3600)}h ${Math.floor((uptimeS % 3600) / 60)}m`
      : `${Math.floor(uptimeS / 60)}m ${uptimeS % 60}s`;
  const usage = input.lastUsage ?? {};
  const lastIn = usage.prompt_tokens ?? 0;
  const lastOut = usage.completion_tokens ?? 0;
  const cached = usage.cached_tokens ?? 0;
  const contextTotal = Math.max(input.contextWindowTokens ?? 0, 0);
  const maxCompletion = input.maxCompletionTokens ?? 8192;
  const contextBudget = Math.max(contextTotal - Math.floor(maxCompletion) - 1024, 1);
  const contextEstimate = input.contextTokensEstimate ?? 0;
  const contextPct =
    contextBudget > 0 ? Math.min(Math.floor((contextEstimate / contextBudget) * 100), 999) : 0;
  const contextUsed =
    contextEstimate >= 1000 ? `${Math.floor(contextEstimate / 1000)}k` : String(contextEstimate);
  const contextWindow = contextTotal > 0 ? `${Math.floor(contextTotal / 1000)}k` : "n/a";
  let tokenLine = `Tokens: ${lastIn} in / ${lastOut} out`;
  if (cached && lastIn) tokenLine += ` (${Math.floor((cached * 100) / lastIn)}% cached)`;
  const lines = [
    `memmy v${input.version}`,
    `Model: ${input.model ?? "unknown"}`,
    tokenLine,
    `Context: ${contextUsed}/${contextWindow} (${contextPct}% of input budget)`,
    `Session: ${input.sessionMsgCount ?? 0} messages`,
    `Uptime: ${uptime}`,
    `Tasks: ${input.activeTaskCount ?? 0} active`,
  ];
  const searchUsageText = input.searchUsageText;
  if (searchUsageText) lines.push(searchUsageText);
  return lines.join("\n");
}

export function maybePersistToolResult(
  workspaceOrContent: string | null | undefined | any,
  sessionKeyOrWorkspace?: string | null,
  toolCallId?: string,
  content?: any,
  opts: { maxChars?: number } = {},
): any {
  const legacySignature = arguments.length >= 4;
  const workspace = legacySignature ? workspaceOrContent : sessionKeyOrWorkspace;
  const sessionKey = legacySignature ? sessionKeyOrWorkspace : "default";
  const callId = legacySignature ? (toolCallId ?? "tool") : "tool";
  const payload = legacySignature ? content : workspaceOrContent;
  const maxChars = opts.maxChars ?? 16_000;
  if (!workspace || maxChars <= 0) return payload;

  let textPayload: string | null = null;
  let suffix = "txt";
  if (typeof payload === "string") textPayload = payload;
  else if (Array.isArray(payload)) {
    textPayload = stringifyTextBlocks(payload);
    if (textPayload == null) return payload;
    suffix = "json";
  } else {
    return payload;
  }
  if (textPayload.length <= maxChars) return payload;

  const root = ensureDir(path.join(workspace, TOOL_RESULTS_DIR));
  const bucket = ensureDir(path.join(root, safeFilename(sessionKey || "default")));
  cleanupToolResultBuckets(root, bucket);
  const filePath = path.join(bucket, `${safeFilename(callId)}.${suffix}`);
  if (!fs.existsSync(filePath)) {
    writeTextAtomic(filePath, suffix === "json" ? JSON.stringify(payload, null, 2) : textPayload);
  }
  const preview = textPayload.slice(0, TOOL_RESULT_PREVIEW_CHARS);
  return renderToolResultReference(filePath, {
    originalSize: textPayload.length,
    preview,
    truncatedPreview: textPayload.length > TOOL_RESULT_PREVIEW_CHARS,
  });
}

export function syncWorkspaceTemplates(workspace: string, templatesDir?: string): string[] {
  const src =
    templatesDir ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "templates");
  fs.mkdirSync(workspace, { recursive: true });
  const added: string[] = [];
  const copyIfMissing = (source: string | null, target: string, content = "") => {
    if (fs.existsSync(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (source && fs.existsSync(source)) fs.copyFileSync(source, target);
    else fs.writeFileSync(target, content, "utf8");
    added.push(path.relative(workspace, target));
  };
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md"]) {
    const source = path.join(src, name);
    const target = path.join(workspace, name);
    if (fs.existsSync(source)) copyIfMissing(source, target);
  }
  copyIfMissing(path.join(src, "memory", "MEMORY.md"), path.join(workspace, "memory", "MEMORY.md"));
  copyIfMissing(null, path.join(workspace, "memory", "history.jsonl"));
  fs.mkdirSync(path.join(workspace, "skills"), { recursive: true });
  new GitStore(workspace, ["SOUL.md", "USER.md", "memory/MEMORY.md", "memory/.dreamCursor"]).init();
  return added;
}
