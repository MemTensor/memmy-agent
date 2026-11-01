/**
 * 已加入项目的任务在本机的记录文件：定位、用哪种方式读、读出来是什么。
 *
 * 用户添加的 Agent 把任务交给 Memmy 时只提交了内容，之后这条任务的进展还在它自己的记录文件里。
 * 这里按提交的提问原文找到那个文件，再试出能读懂它的读取器；绑定之后由同步逻辑按文件更新项目中的任务。
 * 全过程是文件与字符串比较，不调用 AI，也不按 Agent 做专门处理。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readCodexRollout } from "../adapters/outbound/agent-source/codex/rollout-reader.js";
import { readClaudeCodeTranscript } from "../adapters/outbound/agent-source/claude-code/transcript-reader.js";
import { readDeepseekHarnessSession } from "../adapters/outbound/agent-source/deepseek-harness/session-reader.js";
import { readPiHistory } from "../adapters/outbound/agent-source/pi/history-reader.js";

/** 一个任务在本机记录文件里的一轮：问、答、这一轮开始的时间。 */
export interface RecordedTurn {
  question: string;
  reply: string;
  at?: string;
}

/** 试出来的读取方式。绑定后同步沿用同一种，不再重新试。 */
export type RecordReaderId = "pi" | "claude_code" | "codex" | "deepseek_harness" | "generic";

/** 绑定到一条任务上的记录文件。 */
export interface RecordBinding {
  path: string;
  reader: RecordReaderId;
  /** 上次同步时文件的修改时间，用来判断要不要重读。 */
  mtimeMs: number;
}

/** 搜索时只看最近两天的文件，更早的与这次提交无关。 */
const RECENT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** 超过这个大小的文件不读：会话记录通常只有几百 KB。 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 一次最多试这么多候选文件，避免在巨大的目录里长时间阻塞。 */
const MAX_CANDIDATES = 40;
/** 匹配时取提问里的一段连续文字，太短容易误命中。 */
const MATCH_SNIPPET_CHARS = 24;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__"]);

const HOME_DIRECTORIES = (): string[] => [
  homedir(),
  process.env.APPDATA ?? "",
  process.env.LOCALAPPDATA ?? ""
].filter(Boolean).map((entry) => entry.replace(/\/+$/u, ""));

/**
 * 该 Agent 的配置目录：技能目录落在用户目录下的第一级目录时，取那一级（`~/.proma/default-skills` → `~/.proma`），
 * 否则取技能目录的上一级。搜索以它为界，不会扫整个磁盘。
 */
export function configDirectoryFor(skillDirectory: string): string {
  const directory = resolve(skillDirectory);
  for (const home of HOME_DIRECTORIES()) {
    if (!directory.startsWith(`${home}/`)) continue;
    const [first] = directory.slice(home.length + 1).split("/");
    if (first) return join(home, first);
  }
  return dirname(directory);
}

/**
 * 判定「这个文件是不是这条任务的记录」时用的一段原文：提问里最长的一行，去掉首尾空白。
 * 换行会把 JSON 记录切成两段，所以只用不含换行的一段。
 */
export function matchSnippet(question: string): string {
  const lines = question
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
  const longest = lines.sort((left, right) => right.length - left.length)[0] ?? question.trim();
  return longest.slice(0, MATCH_SNIPPET_CHARS);
}

/** JSON 记录里的中文可能写成 `\uXXXX`，换行写成 `\n`：原样与转义两种写法都要认。 */
export function matchVariants(snippet: string): string[] {
  const variants = new Set<string>([snippet]);
  const jsonEscaped = JSON.stringify(snippet).slice(1, -1);
  if (jsonEscaped !== snippet) variants.add(jsonEscaped);
  const unicodeEscaped = Array.from(snippet)
    .map((char) => (/[\u0080-\uffff]/u.test(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : char))
    .join("");
  if (unicodeEscaped !== snippet) variants.add(unicodeEscaped);
  return [...variants];
}

/** 文件内容里是否出现过这段原文（任一种写法）。 */
export function fileMentions(content: string, questions: readonly string[]): boolean {
  return questions.some((question) => {
    const snippet = matchSnippet(question);
    if (!snippet) return false;
    return matchVariants(snippet).some((variant) => content.includes(variant));
  });
}

interface CandidateFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** 在配置目录里找最近修改过、含提交原文的文件，最新的在前。 */
async function candidatesIn(directory: string, questions: readonly string[], now: Date): Promise<CandidateFile[]> {
  const found: CandidateFile[] = [];
  const cutoff = now.getTime() - RECENT_WINDOW_MS;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 6 || found.length >= MAX_CANDIDATES * 4) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (found.length >= MAX_CANDIDATES * 4) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < cutoff || info.size > MAX_FILE_BYTES || info.size === 0) continue;
      const content = await readFile(path, "utf8").catch(() => null);
      if (content === null || !fileMentions(content, questions)) continue;
      found.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    }
  };
  await walk(directory, 0);
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, MAX_CANDIDATES);
}

interface RawRecordMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt?: string;
}

/**
 * 把原始消息配成轮次：一条用户消息开一轮，随后的助手消息接在回复里。
 * 与内置读取器的口径一致：工具返回不算一轮，也不进回复正文。
 */
export function turnsOf(messages: readonly RawRecordMessage[]): RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "tool") continue;
    const text = message.content.trim();
    if (!text) continue;
    if (message.role === "user") {
      turns.push({ question: text, reply: "", ...(message.createdAt ? { at: message.createdAt } : {}) });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) {
      turns.push({ question: "", reply: text, ...(message.createdAt ? { at: message.createdAt } : {}) });
      continue;
    }
    turn.reply = turn.reply ? `${turn.reply}\n\n${text}` : text;
  }
  return turns.filter((turn) => turn.question || turn.reply);
}

/** 内置读取器：这些 Agent 的会话就是一个文件，直接复用它们自己的解析。 */
const BUILTIN_READERS: Array<{ id: RecordReaderId; read: (path: string) => Promise<RawRecordMessage[]> }> = [
  { id: "pi", read: (path) => collect(readPiHistory(path)) },
  { id: "claude_code", read: (path) => collect(readClaudeCodeTranscript(path)) },
  { id: "codex", read: (path) => collect(readCodexRollout(path)) },
  { id: "deepseek_harness", read: (path) => readDeepseekHarnessSession(path) }
];

async function collect(source: AsyncIterable<{ role: string; content: string; createdAt?: string }>): Promise<RawRecordMessage[]> {
  const messages: RawRecordMessage[] = [];
  for await (const message of source) {
    const role = message.role === "user" || message.role === "assistant" || message.role === "system" ? message.role : "tool";
    messages.push({ role, content: message.content, ...(message.createdAt ? { createdAt: message.createdAt } : {}) });
  }
  return messages;
}

/**
 * 通用读取器：不认识这个格式时按常见字段解析 JSON 行或整份 JSON。
 * 角色看 `role`、`type`、`sender`，正文看 `content`、`text`、`message.content`。
 */
export function readGenericRecord(raw: string): RawRecordMessage[] {
  const messages: RawRecordMessage[] = [];
  const push = (record: unknown): void => {
    if (!record || typeof record !== "object") return;
    const value = record as Record<string, unknown>;
    const role = roleOf(value);
    if (!role) return;
    const content = textOf(value);
    if (!content) return;
    const createdAt = timeField(value, ["createdAt", "created_at", "timestamp", "_createdAt", "time"]);
    messages.push({ role, content, ...(createdAt ? { createdAt } : {}) });
  };
  const whole = raw.trim();
  // JSONL 也以 `{` 开头：先试整份解析，解析不了（多行各是一份 JSON）再按行读。
  const parsedWhole = whole.startsWith("{") || whole.startsWith("[") ? safeJson(whole) : null;
  if (Array.isArray(parsedWhole)) {
    parsedWhole.forEach(push);
    return messages;
  }
  if (parsedWhole && typeof parsedWhole === "object") {
    const value = parsedWhole as Record<string, unknown>;
    // 整份 JSON 里的会话数组，例如 { messages: [...] } 或 { turns: [...] }
    const array = [value.messages, value.turns, value.history, value.events].find(Array.isArray);
    if (Array.isArray(array)) {
      array.forEach(push);
      return messages;
    }
    push(parsedWhole);
    return messages;
  }
  for (const line of whole.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    push(safeJson(trimmed));
  }
  return messages;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function roleOf(record: Record<string, unknown>): RawRecordMessage["role"] | null {
  const raw = stringField(record, ["role", "type", "sender"]);
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === "tool" || value === "tool_result" || value === "toolresult" || value === "function") return "tool";
  // `type: "message"` 这类外层包装不算角色，交给 message.role 判断。
  if (value === "system" || value === "developer") return "system";
  if (value === "user" || value === "human") return "user";
  if (value === "assistant" || value === "ai" || value === "bot" || value === "model") return "assistant";
  const nested = record.message;
  if (nested && typeof nested === "object") return roleOf(nested as Record<string, unknown>);
  return null;
}

/** 正文可能在 `content`、`text`，或 `message.content`；数组里只取文本块，工具结果与思考都不算。 */
function textOf(record: Record<string, unknown>): string {
  const nested = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : null;
  for (const holder of [record, nested]) {
    if (!holder) continue;
    const direct = stringField(holder, ["content", "text"]);
    if (direct) return direct;
    const blocks = Array.isArray(holder.content) ? holder.content : [];
    const text = blocks.map(textOfBlock).filter(Boolean).join("\n").trim();
    if (text) return text;
  }
  return "";
}

function textOfBlock(block: unknown): string {
  if (typeof block === "string") return block.trim();
  if (!block || typeof block !== "object") return "";
  const value = block as Record<string, unknown>;
  const type = stringField(value, ["type"]);
  if (type && type !== "text" && type !== "input_text" && type !== "output_text") return "";
  return stringField(value, ["text", "content"]);
}

/** 时间既可能是 ISO 字符串，也可能是毫秒数（Proma 的旧记录就是毫秒）。 */
function timeField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  }
  return "";
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 用指定的读取方式读一个文件，成轮次。读不出来时返回空数组。
 * 这里不做回退：绑定记录里存的是真正读通的那个读取器，回退会让记录与实际不符。
 */
export async function readRecordFile(path: string, reader: RecordReaderId): Promise<RecordedTurn[]> {
  if (reader === "generic") {
    const raw = await readFile(path, "utf8").catch(() => null);
    return raw === null ? [] : turnsOf(readGenericRecord(raw));
  }
  const builtin = BUILTIN_READERS.find((entry) => entry.id === reader);
  if (!builtin) return [];
  const messages = await builtin.read(path).catch(() => []);
  return turnsOf(messages);
}

/**
 * 读出来的提问是否覆盖了 Agent 提交的每一轮提问。
 * 比较时去掉空白并采用包含关系：读取器常把系统附加内容一起读出来，前后多出的部分不算错。
 */
export function readCoversSubmitted(read: readonly RecordedTurn[], submitted: readonly RecordedTurn[]): boolean {
  const squash = (value: string) => value.replace(/\s+/gu, "");
  const asked = read.map((turn) => squash(turn.question)).filter(Boolean);
  return submitted
    .map((turn) => squash(turn.question))
    .filter(Boolean)
    .every((question) => asked.some((candidate) => sameQuestion(candidate, question)));
}

/** 一段连续原文的长度：清理过的提问会在中间断开，取这么长的片段来比。 */
const QUESTION_WINDOW = 40;
/** 再短就不足以说明是同一问。 */
const QUESTION_MIN_WINDOW = 12;

/**
 * 提交的提问是否就是读取器读到的那一问。
 * Agent 常把宿主注入的部分去掉（时间戳、工作区说明、附件清单、引用标签），
 * 于是两段文字不再互相包含，但去掉的位置之间仍然是原文的连续片段：
 * 所以短问题用包含判断，长的按窗口逐个找，命中一个就算同一问。
 */
function sameQuestion(candidate: string, question: string): boolean {
  if (candidate.includes(question) || question.includes(candidate)) return true;
  // 短问题也要能比：窗口取问题长度的一半（至少 12 个字符），避免太短的片段误命中。
  if (question.length < QUESTION_MIN_WINDOW) return false;
  const window = Math.min(QUESTION_WINDOW, Math.max(QUESTION_MIN_WINDOW, Math.floor(question.length / 2)));
  const stride = Math.max(1, Math.floor(window / 2));
  for (let start = 0; start + window <= question.length; start += stride) {
    if (candidate.includes(question.slice(start, start + window))) return true;
  }
  return false;
}

/** 依次试读取方式，返回第一个通过的文件与读取方式。 */
async function tryReaders(path: string, submitted: readonly RecordedTurn[]): Promise<RecordReaderId | null> {
  for (const reader of ["pi", "claude_code", "codex", "deepseek_harness", "generic"] as const) {
    const turns = await readRecordFile(path, reader).catch(() => []);
    if (turns.length && readCoversSubmitted(turns, submitted)) return reader;
  }
  return null;
}

/**
 * 找这条任务的记录文件。给了 `sourcePath` 就只核对它；没给就在配置目录里按提交原文搜索，
 * 候选按修改时间从新到旧逐个试读取方式，第一个通过的就是绑定结果。
 */
export async function locateRecordFile(input: {
  skillDirectory: string;
  submitted: readonly RecordedTurn[];
  sourcePath?: string;
  now?: Date;
  /** 搜索范围；默认由技能目录推出，测试里可以直接指定。 */
  configDirectory?: string;
}): Promise<RecordBinding | null> {
  const questions = input.submitted.map((turn) => turn.question).filter(Boolean);
  if (!questions.length) return null;
  if (input.sourcePath?.trim()) {
    const path = resolve(input.sourcePath.trim());
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    const reader = await tryReaders(path, input.submitted);
    return reader ? { path, reader, mtimeMs: info.mtimeMs } : null;
  }
  const directory = input.configDirectory ?? configDirectoryFor(input.skillDirectory);
  const candidates = await candidatesIn(directory, questions, input.now ?? new Date());
  for (const candidate of candidates) {
    const reader = await tryReaders(candidate.path, input.submitted);
    if (reader) return { path: candidate.path, reader, mtimeMs: candidate.mtimeMs };
  }
  return null;
}
