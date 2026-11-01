/**
 * Local session reader. Lists this machine's agent sessions so a person can pick which ones to associate with an
 * online project, and reads one session's turns so they can be uploaded to it. It runs in the desktop backend on
 * the backend's own agent adapters, so online projects do not depend on the Memory service.
 */
import type { SourceRegistry } from "../source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../types.js";
import { rankLocalSessions } from "./local-session-rank.js";
import { createSessionGrouper, type LocalSessionGroup, type SessionGrouper } from "./session-group.js";

export type { LocalSessionGroup } from "./session-group.js";

const DEFAULT_SESSIONS_PER_SOURCE = 30;
/**
 * 列表要的是任务数，而窗口按文件算：空记录、后台派生的记录不出现在列表里。凑不满时按倍数向前扩大窗口，
 * 直到拿到要求数量的任务或到达这个上限。
 */
const RECENT_SCAN_FACTORS = [1, 2, 4] as const;
/** A wider window used only when the recent list comes up short. */
const WIDE_SESSIONS_PER_SOURCE = 200;
const DEFAULT_SNAPSHOT_TTL_MS = 15_000;
const DEFAULT_AVAILABLE_LIMIT = 50;
const MAX_AVAILABLE_LIMIT = 500;
/** Sessions one batch read may ask for; their turns all travel in one response. */
export const MAX_READ_MANY = 50;
const TITLE_MAX_CHARS = 40;

/** One question and everything the agent did until the next question. */
export interface LocalSessionTurn {
  question: string;
  reply: string;
  steps: string[];
  startedAt: string;
}

/** A local agent session reduced to what association and reading need. */
export interface LocalSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  /** The agent's project or workspace, or the directory; null outside every unit. */
  group: LocalSessionGroup | null;
  updatedAt: string;
  turns: LocalSessionTurn[];
}

/** A session as listed in the association picker, without its turns. */
export interface LocalSessionCandidate {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  group: LocalSessionGroup | null;
  updatedAt: string;
  turnCount: number;
}

/** The candidate pool, and whether a newer scan is running behind it. */
export interface LocalSessionListing {
  sessions: LocalSessionCandidate[];
  /** True when these came from the previous scan; asking again with `fresh` returns the newer one. */
  refreshing: boolean;
}

/** Contract for the candidate pool the association picker chooses from. */
export interface LocalSessionAvailableInput {
  query?: string;
  /** Sessions in this directory rank first. */
  cwd?: string | null;
  /** Only sessions of these agents, e.g. ["workbuddy"]; all agents when absent. */
  sourceIds?: readonly string[];
  limit?: number;
  /** Waits for a current scan instead of answering from the previous one. */
  fresh?: boolean;
}

/** Contract for local session reader. */
export interface LocalSessionReader {
  /** The agents' sessions, most relevant first; answers from the last scan while a newer one runs. */
  available(input: LocalSessionAvailableInput): Promise<LocalSessionListing>;
  /** Rereads one session so an upload carries its latest turns. */
  read(input: { sourceId: string; conversationId: string }): Promise<LocalSession>;
  /**
   * Rereads several sessions of one agent with one pass over its store. Reading them one by one costs a pass each,
   * since a store is only read whole; `missing` lists the requested sessions it no longer has.
   */
  readMany(input: { sourceId: string; conversationIds: readonly string[] }): Promise<{ sessions: LocalSession[]; missing: string[] }>;
}

/** A read the caller can explain: an unknown agent or session, or a batch larger than one read allows. */
export class LocalSessionReadError extends Error {
  constructor(readonly code: "not_found" | "invalid_argument", message: string) {
    super(message);
    this.name = "LocalSessionReadError";
  }
}

export interface CreateLocalSessionReaderDeps {
  registry: SourceRegistry;
  /** When set, each scan reads this list instead of `registry.list()`, so added agents can be loaded from disk. */
  adapters?: () => Promise<readonly SourceAdapter[]>;
  sessionsPerSource?: number;
  snapshotTtlMs?: number;
  now?: () => number;
}

/** Creates the local session reader. */
export function createLocalSessionReader(deps: CreateLocalSessionReaderDeps): LocalSessionReader {
  const sessionsPerSource = deps.sessionsPerSource ?? DEFAULT_SESSIONS_PER_SOURCE;
  const snapshotTtlMs = deps.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const now = deps.now ?? Date.now;
  let snapshot: { loadedAt: number; sessions: LocalSession[] } | null = null;
  let loading: Promise<LocalSession[]> | null = null;

  /** One live read of the agents' stores at a time, shared by every caller waiting on it. */
  async function adapters(): Promise<readonly SourceAdapter[]> {
    return deps.adapters ? deps.adapters() : deps.registry.list();
  }

  function scan(): Promise<LocalSession[]> {
    loading ??= adapters().then((list) => Promise.all(list.map((adapter) => readRecentSessions(adapter, sessionsPerSource))))
      .then((perSource) => {
        const sessions = perSource.flat();
        snapshot = { loadedAt: now(), sessions };
        return sessions;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  /**
   * Scanning every agent takes seconds, so an expired snapshot is still answered at once while a new scan runs
   * behind it. Only the first request, or one that asks for `fresh`, waits for the scan.
   */
  async function allSessions(fresh: boolean): Promise<{ sessions: LocalSession[]; refreshing: boolean }> {
    if (snapshot && now() - snapshot.loadedAt < snapshotTtlMs) {
      return { sessions: snapshot.sessions, refreshing: false };
    }
    if (snapshot && !fresh) {
      void scan();
      return { sessions: snapshot.sessions, refreshing: true };
    }
    return { sessions: await scan(), refreshing: false };
  }

  return {
    async available(input) {
      const sources = input.sourceIds?.length ? new Set(input.sourceIds) : null;
      const limit = Math.min(MAX_AVAILABLE_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_AVAILABLE_LIMIT)));
      const { sessions: all, refreshing } = await allSessions(input.fresh === true);
      const sessions = all.filter((session) => !sources || sources.has(session.sourceId));
      return {
        sessions: rankLocalSessions(sessions, { query: input.query?.trim() ?? "", cwd: input.cwd ?? null })
          .slice(0, limit)
          .map(toCandidate),
        refreshing
      };
    },

    async read(input) {
      const adapter = (await adapters()).find((item) => item.descriptor.sourceId === input.sourceId);
      if (!adapter) {
        throw new LocalSessionReadError("not_found", `Unknown agent source: ${input.sourceId}`);
      }
      const [session] = await readSessions(adapter, [input.conversationId], sessionsPerSource);
      if (!session) {
        throw new LocalSessionReadError("not_found", `Session not found: ${input.sourceId}/${input.conversationId}`);
      }
      return session;
    },

    async readMany(input) {
      const adapter = (await adapters()).find((item) => item.descriptor.sourceId === input.sourceId);
      if (!adapter) {
        throw new LocalSessionReadError("not_found", `Unknown agent source: ${input.sourceId}`);
      }
      const wanted = [...new Set(input.conversationIds)];
      if (wanted.length > MAX_READ_MANY) {
        throw new LocalSessionReadError("invalid_argument", `At most ${MAX_READ_MANY} sessions per read`);
      }
      const sessions = await readSessions(adapter, wanted, sessionsPerSource);
      const found = new Set(sessions.map((session) => session.conversationId));
      return { sessions, missing: wanted.filter((id) => !found.has(id)) };
    }
  };
}

/** Reads the most recent sessions of one source; a broken or missing source yields none. */
export async function readRecentSessions(adapter: SourceAdapter, limit: number): Promise<LocalSession[]> {
  try {
    if (!(await adapter.detect())) {
      return [];
    }
    const grouper = createSessionGrouper(adapter);
    let sessions: LocalSession[] = [];
    // 窗口里的空记录、后台派生的记录不计入列表，所以不能把窗口大小当成条数：凑不满就向前补。
    for (const factor of RECENT_SCAN_FACTORS) {
      const window = Math.min(WIDE_SESSIONS_PER_SOURCE, limit * factor);
      const builders = new Map<string, SessionBuilder>();
      for await (const message of adapter.scan({ order: "recent_first", maxScanTargets: window, maxConversations: window, fullHistory: true })) {
        let builder = builders.get(message.conversationId);
        if (!builder) {
          builder = { workspacePath: null, updatedAt: "", turns: [], nativeTitle: "" };
          builders.set(message.conversationId, builder);
        }
        appendMessage(builder, message);
      }
      sessions = [...builders.entries()]
        .map(([conversationId, builder]) => finishSession(adapter, grouper, conversationId, builder))
        .filter((session): session is LocalSession => session !== null);
      if (sessions.length >= limit || window >= WIDE_SESSIONS_PER_SOURCE) {
        break;
      }
    }
    // 扫描按最近优先返回，多出来的都是更早的任务。
    return sessions.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Reads the requested conversations in one pass over the recent window, then one wider pass for any that are older.
 * Only requested conversations are built; the others in the window are skipped as they stream past.
 */
async function readSessions(adapter: SourceAdapter, conversationIds: readonly string[], recentLimit: number): Promise<LocalSession[]> {
  try {
    if (!(await adapter.detect())) {
      return [];
    }
    const grouper = createSessionGrouper(adapter);
    const found: LocalSession[] = [];
    let remaining = new Set(conversationIds);
    for (const limit of [recentLimit, WIDE_SESSIONS_PER_SOURCE]) {
      if (!remaining.size) break;
      const builders = new Map<string, SessionBuilder>();
      for await (const message of adapter.scan({ order: "recent_first", maxScanTargets: limit, maxConversations: limit, fullHistory: true })) {
        if (!remaining.has(message.conversationId)) {
          continue;
        }
        let builder = builders.get(message.conversationId);
        if (!builder) {
          builder = { workspacePath: null, updatedAt: "", turns: [], nativeTitle: "" };
          builders.set(message.conversationId, builder);
        }
        appendMessage(builder, message);
      }
      for (const [conversationId, builder] of builders) {
        const session = finishSession(adapter, grouper, conversationId, builder);
        if (session) found.push(session);
      }
      remaining = new Set([...remaining].filter((id) => !builders.has(id)));
    }
    return found;
  } catch {
    return [];
  }
}

interface SessionBuilder {
  workspacePath: string | null;
  updatedAt: string;
  turns: LocalSessionTurn[];
  /** The title the agent generated; the last one seen wins, since an agent may retitle as the work changes. */
  nativeTitle: string;
}

function appendMessage(builder: SessionBuilder, message: ConversationMessage): void {
  builder.workspacePath ??= message.workspacePath;
  if (message.createdAt > builder.updatedAt) {
    builder.updatedAt = message.createdAt;
  }
  const nativeTitle = message.sessionTitle?.trim();
  if (nativeTitle) {
    builder.nativeTitle = nativeTitle;
  }
  if (message.role === "system") {
    return;
  }
  if (message.role === "user") {
    // 宿主与 Agent 自己写进用户消息的东西不算一问：打断标记、工作区说明、技能正文。
    if (isInternalUserMessage(message.content)) return;
    builder.turns.push({ question: stripInjectedContext(message.content), reply: "", steps: [], startedAt: message.createdAt });
    return;
  }
  let turn = builder.turns.at(-1);
  if (!turn) {
    turn = { question: "", reply: "", steps: [], startedAt: message.createdAt };
    builder.turns.push(turn);
  }
  if (message.role === "assistant") {
    const text = message.content.trim();
    if (text) {
      turn.reply = turn.reply ? `${turn.reply}\n\n${text}` : text;
    }
    return;
  }
  turn.steps.push(toolName(message));
}

function finishSession(adapter: SourceAdapter, grouper: SessionGrouper, conversationId: string, builder: SessionBuilder): LocalSession | null {
  const asked = builder.turns.filter((turn) => turn.question);
  if (!asked.length) {
    return null;
  }
  const questions = asked.map((turn) => cleanQuestion(turn.question)).filter((text) => text.length > 0);
  return {
    sourceId: adapter.descriptor.sourceId,
    agentName: adapter.descriptor.displayName,
    conversationId,
    title: builder.nativeTitle ? oneLine(builder.nativeTitle, TITLE_MAX_CHARS) : pickTitle(questions, adapter, builder.workspacePath, builder.updatedAt),
    lastQuestion: oneLine(questions.at(-1) ?? asked.at(-1)!.question, 120),
    workspacePath: builder.workspacePath,
    group: grouper({ workspacePath: builder.workspacePath, conversationId }),
    updatedAt: builder.updatedAt,
    turns: builder.turns
  };
}

/**
 * 任务的第一条用户消息常常是宿主注入的上下文（AGENTS.md、推荐插件、环境说明、文件清单），
 * 直接拿来当标题会出现大量重复且无意义的条目。这里把它剥掉，留下人真正问的那句。
 */
export function cleanQuestion(text: string): string {
  let value = text;
  // 宿主注入的整块内容：已知标签 + 任意带属性/无属性的成对标签
  value = value.replace(/<(recommended_plugins|environment_context|user_instructions|system[_-]reminder|pasted_content|local-command-[a-z]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/giu, " ");
  // HTML 注释与引用前缀：Agent 之间互相引用任务时留下 `<!-- reply 2 --> > 原话` 这类排版标记，不该出现在标题里
  value = value.replace(/<!--[\s\S]*?-->/gu, " ");
  value = value.replace(/(^|[\n。！？；：])\s*>\s*/gu, "$1 ");
  // 自动任务：只保留任务名，去掉 ID 与 memory 路径
  const automation = /^Automation:\s*([^\n]+?)\s*(?:Automation ID|$)/iu.exec(value.trim());
  if (automation) {
    value = automation[1] ?? value;
  }
  const lines = value
    .split("\n")
    // 引用前缀 `> ` 只是排版，去掉后才是原话
    .map((line) => line.replace(/^\s*>\s?/u, ""))
    // markdown 标题式的文件说明、文件清单头、代码围栏
    .filter((line) => {
      const trimmed = line.trim();
      if (/^```/u.test(trimmed)) return false;
      if (/^#\s*(AGENTS\.md|CLAUDE\.md|Files mentioned by the user|Relevant code)/iu.test(trimmed)) return false;
      if (/^<\/?[a-z_-]+>/iu.test(trimmed)) return false;
      return true;
    })
    .join(" ");
  return collapse(lines);
}

/**
 * 有些内容写在用户消息里，但没有人说过：
 * - `[Request interrupted by user for tool use]`：按停止键时宿主补的一条；
 * - `Repository: … / Branch: …` 加一整棵目录树：宿主在开头塞的工作区说明；
 * - `Base directory for this skill:`：Agent 加载技能时把技能正文写了进来。
 * 它们不该成为一问，也不该被拿来当任务标题。
 */
export function isInternalUserMessage(text: string): boolean {
  const trimmed = text.trim();
  // 按停止键时宿主补的一句：先写打断标记，有时只写这句指令
  if (/^\[Request interrupted by user[^\]]*\]/iu.test(trimmed)) return true;
  if (/^Do not call any more tools\./iu.test(trimmed)) return true;
  if (/^Base directory for this skill:/iu.test(trimmed)) return true;
  // 工作区与模块说明：一段标签加一整棵目录树
  if (/^Repository:[^\n]*\nBranch:[^\n]*/iu.test(trimmed) && /==\s*Root-level Directory Tree/iu.test(trimmed)) return true;
  return /^Module: [^\n]*\nSlug:/iu.test(trimmed) && /Directory tree for this module/iu.test(trimmed);
}

/** 判断一段用户消息像不像人真的问的问题，而不是宿主或自动化塞进来的模板。 */
export function isHumanQuestion(text: string): boolean {
  if (text.length < 4 || !/[\p{L}\p{N}]/u.test(text)) {
    return false;
  }
  // 纯链接、纯路径
  if (/^(https?:\/\/\S+|\/\S+|@\S+)$/u.test(text)) {
    return false;
  }
  // 常见注入模板的开头
  if (/^(你现在的任务是|你的任务是|You are an? (AI|assistant)|Your task is|You MUST follow|Please follow these steps|Target file this round|Current (file|working))/iu.test(text)) {
    return false;
  }
  // 文档标题、残留标签、以链接开头的消息：都不是「人问的那句话」
  if (/^#/u.test(text) || /^<\/?[a-z]/iu.test(text) || /^https?:\/\//iu.test(text)) {
    return false;
  }
  // 以标点或代码围栏开头的碎片
  if (/^[.。,、:：\-–—]\s*/u.test(text) && !/[一-龥]/u.test(text.slice(0, 4))) {
    return false;
  }
  // 链接占了大半内容
  const urlChars = text.match(/https?:\/\/\S+/gu)?.join("").length ?? 0;
  if (urlChars > 0 && urlChars / text.length > 0.6) {
    return false;
  }
  // 一大段文件清单式的 markdown
  if ((text.match(/\n#/gu)?.length ?? 0) >= 2) {
    return false;
  }
  return true;
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 选一个能代表任务的标题：优先人问的第一句，否则退回到目录或时间。 */
function pickTitle(
  questions: readonly string[],
  adapter: SourceAdapter,
  workspacePath: string | null,
  updatedAt: string
): string {
  const usable = questions.find((question) => isHumanQuestion(question.trim()));
  if (usable) {
    return oneLine(usable, TITLE_MAX_CHARS);
  }
  const folder = (workspacePath ?? "").replace(/\/+$/u, "").split("/").filter(Boolean).pop();
  const date = Number.isNaN(Date.parse(updatedAt))
    ? ""
    : new Date(updatedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  return oneLine([folder || adapter.descriptor.displayName, date].filter(Boolean).join(" · "), TITLE_MAX_CHARS);
}

function toCandidate(session: LocalSession): LocalSessionCandidate {
  return {
    sourceId: session.sourceId,
    agentName: session.agentName,
    conversationId: session.conversationId,
    title: session.title,
    lastQuestion: session.lastQuestion,
    workspacePath: session.workspacePath,
    group: session.group,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length
  };
}

function toolName(message: ConversationMessage): string {
  const fromMeta = message.rawMeta?.toolName;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim();
  }
  return /^Tool:\s*(\S+)/u.exec(message.content)?.[1] ?? "tool";
}

/** Drops context that memory plugins and hosts inject into the prompt, keeping what the person typed. */
function stripInjectedContext(text: string): string {
  return text
    .replace(/<(system[_-]reminder|[a-z_]*memory_context|memmy_reference|project_context)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .trim();
}

function oneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}
