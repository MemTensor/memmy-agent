/**
 * Local session reader. Lists this machine's agent sessions so a person can pick which ones to associate with an
 * online project, and reads one session's turns so they can be uploaded to it. It runs in the desktop backend on
 * the backend's own agent adapters, so online projects do not depend on the Memory service.
 */
import type { SourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import type { ConversationMessage, SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { rankLocalSessions } from "./local-session-rank.js";
import { readRecentSessionsFromMetadata } from "./session-metadata/index.js";
import { createSessionGrouper, type LocalSessionGroup, type SessionGrouper } from "./session-group.js";
import { finishSession, isInternalUserMessage, stripInjectedContext, type SessionBuilder } from "./session-shape.js";

export type { LocalSessionGroup } from "./session-group.js";
export { cleanQuestion, isHumanQuestion, isInternalUserMessage, stripInjectedContext } from "./session-shape.js";

const DEFAULT_SESSIONS_PER_SOURCE = 30;
/**
 * 列表要的是任务数，而窗口按文件算：空记录、后台派生的记录不出现在列表里。凑不满时向前扩大窗口，
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

/** How one listing reads the stores: through the metadata path, or the full scan it replaces. */
export interface ReadRecentSessionsOptions {
  /**
   * 走不走元数据路径。列表只要四个字段，读会话两端就够了；上传要正文，仍走完整扫描。
   * 关掉它就走原来的扫描路径，用于对照与兜底。
   */
  preferMetadata?: boolean;
}

/** Reads the most recent sessions of one source; a broken or missing source yields none. */
export async function readRecentSessions(
  adapter: SourceAdapter,
  limit: number,
  options: ReadRecentSessionsOptions = {}
): Promise<LocalSession[]> {
  try {
    if (!(await adapter.detect())) {
      return [];
    }
    if (options.preferMetadata !== false) {
      const listed = await readRecentSessionsFromMetadata(adapter, { limit, window: recentScanWindow(limit) });
      if (listed) {
        return listed;
      }
    }
    const grouper = createSessionGrouper(adapter);
    const window = recentScanWindow(limit);
    const builders = new Map<string, SessionBuilder>();
    for await (const message of adapter.scan({ order: "recent_first", maxScanTargets: window, maxConversations: window, fullHistory: true })) {
      let builder = builders.get(message.conversationId);
      if (!builder) {
        builder = { workspacePath: null, updatedAt: "", turns: [], nativeTitle: "" };
        builders.set(message.conversationId, builder);
      }
      appendMessage(builder, message);
    }
    const sessions = [...builders.entries()]
      .map(([conversationId, builder]) => finishSession(adapter, grouper, conversationId, builder))
      .filter((session): session is LocalSession => session !== null);
    // 扫描按最近优先返回，多出来的都是更早的任务。
    return sessions.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 一次读取用的窗口：就是原先逐级扩大能到达的最宽一档。
 *
 * <p>窗口按文件算而列表按任务算，空记录与后台派生的记录占窗口却不进列表，所以窗口要比 `limit` 大。
 * 原先的做法是扫一遍、凑不满就从零再扫一个更大的窗口，前一遍的结果全部作废——同一份存储被读了两三遍。
 * 现在只用最宽那一档扫一遍：会话按最近优先排列，更宽窗口的前若干个正是窄窗口能拿到的那些，
 * 而原先每一遍的结果本来就只有最后一遍会被返回，所以结果集合与顺序不变。</p>
 */
function recentScanWindow(limit: number): number {
  return Math.min(WIDE_SESSIONS_PER_SOURCE, limit * RECENT_SCAN_FACTORS[RECENT_SCAN_FACTORS.length - 1]!);
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
