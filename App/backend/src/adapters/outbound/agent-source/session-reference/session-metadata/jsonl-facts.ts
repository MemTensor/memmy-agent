/**
 * Reads the listed fields of JSONL-backed sessions from the ends of their files.
 *
 * <p>The scan path streams every message of every session, which is what an upload needs and what a list does not.
 * A list needs two things per conversation: the title the agent gave it (or, without one, the first question a
 * person asked) and the last one. So a file is read at its tail, row by row from the end, until the last question
 * is in hand; its head is read only as far as the conversation's identity. Rows in between are never parsed.</p>
 *
 * <p>The rules that turn those facts into a title, a preview, a directory and a time live in session-shape, shared
 * with the scan path, so a session reads the same either way.</p>
 */
import { readJsonlObjects } from "@memmy/agent-source-readers/adapters/jsonl-lines";
import { readJsonlRowsCheap } from "./jsonl-lines-cheap.js";
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import type { LocalSession } from "../local-session-reader.js";
import {
  cleanQuestion,
  finishSession,
  isHumanQuestion,
  isInternalUserMessage,
  stripInjectedContext,
  type SessionBuilder
} from "../session-shape.js";
import { createSessionGrouper } from "../session-group.js";
import { fileSize, lineBoundaryBefore, MAX_WINDOW_BYTES, readFileWindow, readTailChunk, WINDOW_GROWTH } from "./file-window.js";

/** One question a person asked, and when. */
export interface QuestionFact {
  question: string;
  startedAt: string;
}

/** What one conversation's rows told us while its file was read. */
export interface ConversationFact {
  conversationId: string;
  /** Questions asked, in the order the rows appeared. */
  questions: QuestionFact[];
  /** The latest time any of its messages carried. */
  updatedAt: string;
}

/** What one file told us. */
export interface FileFacts {
  conversations: Map<string, ConversationFact>;
  /** A title the file applies to the whole of it (Claude Code, WorkBuddy). */
  fileTitle: string;
  /** A title tied to one conversation (Codex keeps them in a separate index). */
  titles: Map<string, string>;
  /** The first conversation named by a row, used to seed the tail read of a file whose head says it only once. */
  firstConversationId: string;
  /** Questions that survived the filters, and how many of them read like something a person asked. */
  questionCount: number;
  humanCount: number;
  /**
   * Whether the newest question is also the newest thing the file holds.
   *
   * <p>只读到一问就停下是不够的：文件里最后一句提问之后往往还有几十兆工具输出，先读到的那一问并不是最新的一问。
   * 只有它后面的记录也都读过了，它才真的是「最后一问」。</p>
   */
  trailingAfterLastQuestion: boolean;
  /** The time of the newest question seen so far, so a record older than it never counts as coming after. */
  newestQuestionAt: string;
  /** The conversation the file is currently in, so a row that is not parsed still knows who it belongs to. */
  lastConversationId: string;
  /**
   * The newest timestamp any row of the file carried, parsed or not.
   *
   * <p>跳过解析不代表跳过时间：会话的最后活动时间取自最后一条记录，那条记录常常是助手正文或工具输出。</p>
   */
  fileUpdatedAt: string;
}

/** What a source's rows report as they stream past. */
export interface FactSink {
  /** What a person typed; only counted when it survives the injected-context filters. */
  user(conversationId: string, content: string, createdAt: string): void;
  /** Any other message the scan would emit; it only moves the conversation's time. */
  message(conversationId: string, createdAt: string): void;
  /** A title record: `null` for one that names the whole file. */
  title(conversationId: string | null, text: string): void;
}

/** Reads one row of a source's own format and reports what the scan would have emitted for it. */
export type RowObserver = ((record: Record<string, unknown>, sink: FactSink) => void) & {
  /** What a later window of the same file needs to know about the rows this one read, if anything. */
  resume?: () => unknown;
};

/** What a window tells an observer about the rows it is about to hand over. */
export interface ObserverContext {
  /** The conversation the file's head named, for stores that write the identity once at the top. */
  seedConversationId: string;
  /** True when the window's rows arrive newest first, i.e. the read walks the file backwards. */
  backward: boolean;
  /**
   * What the rows before this window decided, when the read resumes after them.
   *
   * <p>一个回合是 Codex 自己发起的这件事，只写在回合开头那条记录上。尾窗口从中间开始读，看不到那条，
   * 于是同一个文件里前半段的评审回合会被当成人的提问——头窗口读过那些记录，把结论带过来。</p>
   */
  resume?: unknown;
}

/** How one JSONL source's rows become facts; a source without an entry keeps the scan path. */
export interface JsonlMetadataSource {
  sourceId: string;
  /**
   * A fresh observer per window: rows carry state as they stream (the conversation they belong to, a title that
   * applies to everything after it), and each window starts from whatever its first row says.
   */
  createObserver(filePath: string, context: ObserverContext): RowObserver;
  /**
   * How the tail is walked. Backwards suits stores whose rows stand alone; a store that decides per turn whether a
   * turn was the person's own must be read forwards, since that judgement is written above the rows it covers.
   */
  tailScan?: "backward" | "forward";
  /**
   * Whether a row has to be parsed, judged from its raw text.
   *
   * <p>会话文件里绝大多数记录是工具输出与助手正文，列表不为它们要内容，只要一个时间。用一行正则挡掉它们，
   * 解析量从「每条记录」降到「人的提问与记账记录」，实测不到 15%。默认全解析，宁可慢一点也不猜错。</p>
   */
  wantsParse?: (line: string) => boolean;
}

/** One file to list, as the source's own discovery found it. */
export interface JsonlSessionFile {
  sessionFilePath: string;
  workspacePath: string | null;
  /** A title the agent keeps outside the session file, when it keeps one. */
  title?: string | null;
}

/** How far a head window may grow while looking for the first question; the tail may grow to the widest size. */
const HEAD_MAX_BYTES = 256 * 1024;

/** The sizes a head window tries: small at first, since a session states its identity in its first rows. */
const HEAD_GROWTH = WINDOW_GROWTH.filter((bytes) => bytes <= HEAD_MAX_BYTES);

/** How much of a file's tail one chunk parses before the next chunk continues before it. */
const TAIL_CHUNK_BYTES = 32 * 1024;

/** The widest chunk a tail read grows to when the records in it are longer than a chunk. */
const TAIL_MAX_CHUNK_BYTES = 512 * 1024;

/**
 * Reads one file's ends.
 *
 * @param hasTitle Whether the agent keeps this session's title outside the file; when it does not, the head is
 * read far enough to find the first question the title would come from.
 */
export async function summarizeJsonlFile(
  filePath: string,
  source: JsonlMetadataSource,
  options: { hasTitle: boolean }
): Promise<FileFacts> {
  if ((await fileSize(filePath)) === 0) {
    return createFileFacts();
  }
  // 整份顺序读一遍，不解析没人说的话。
  //
  // <p>只读文件两头会取错「最后一问」：一句提问之后 Agent 常会再跑很久，它的输出在文件里可以占几十兆，
  // 而窗口必须设上界，否则就退化成读整个文件。整份读解决了这个矛盾——代价本来也不在字节数上：
  // 会话文件里绝大多数记录是工具输出与助手正文，它们用正则取个时间就够了，只有人的提问与记账记录需要
  // JSON.parse（实测不到 15%）。一个 50MB 的会话全文读完约 0.1 秒，峰值内存 50MB 量级。</p>
  //
  // <p>只读两端的前提是「文件中间没有要看的东西」，而列表要的恰好是文件里最新的一问，它在哪里事先不知道。
  // 顺序读一遍没有这个前提，标题、最后一问、最后活动时间因此与完整扫描逐字相同。</p>
  const facts = createFileFacts();
  await readWholeFile(filePath, source, facts);
  // 文件级的最后一个时间属于这个文件里最后出现的那个会话（记录按时间写）。
  if (facts.fileUpdatedAt) {
    const owner = facts.conversations.get(facts.lastConversationId) ?? [...facts.conversations.values()].at(-1);
    if (owner && facts.fileUpdatedAt > owner.updatedAt) {
      owner.updatedAt = facts.fileUpdatedAt;
    }
  }
  return facts;
}

function createFileFacts(): FileFacts {
  return {
    conversations: new Map(),
    fileTitle: "",
    titles: new Map(),
    firstConversationId: "",
    questionCount: 0,
    humanCount: 0,
    trailingAfterLastQuestion: false,
    newestQuestionAt: "",
    lastConversationId: "",
    fileUpdatedAt: ""
  };
}

interface HeadOutcome {
  facts: FileFacts;
  /** Byte offset the read stopped at; the tail starts from there and never re-reads those bytes. */
  end: number;
  /** What the head's rows decided, for the tail read that resumes after them. */
  resume: unknown;
}

/**
 * Reads from the file's start, widening the window while it holds nothing that answers why it was read.
 *
 * @param needQuestion Whether the read must find a question, not just the conversation's identity.
 */
async function scanHead(filePath: string, source: JsonlMetadataSource, needQuestion: boolean): Promise<HeadOutcome> {
  let outcome: HeadOutcome = { facts: createFileFacts(), end: 0, resume: undefined };
  for (const bytes of HEAD_GROWTH) {
    const window = await readFileWindow(filePath, "head", bytes);
    if (!window) {
      return outcome;
    }
    const facts = createFileFacts();
    const sink = createSink(facts, false);
    const observer = source.createObserver(filePath, { seedConversationId: "", backward: false });
    for (const line of window.lines) {
      if (!observeLine(line, sink, observer)) {
        continue;
      }
      if (isReadEnough(facts, needQuestion)) {
        break;
      }
    }
    // 头窗口读过的行决定的回合归属，尾窗口续读时要用：否则同一个文件后半段的评审回合会被当成人问的话。
    outcome = { facts, end: window.end, resume: observer.resume?.() };
    if (isReadEnough(facts, needQuestion)) {
      return outcome;
    }
    // 已经读到文件末尾：再放大也只是重复读同样的字节。
    if (window.end >= window.size) {
      return outcome;
    }
  }
  return outcome;
}

/**
 * Reads backwards from the file's end, one chunk at a time, until the last question is in hand.
 *
 * <p>A chat's last turn is usually its last few records, so the first chunk answers the question. Later chunks
 * continue before it rather than reading it again, and stop at the widest size a listing may read.</p>
 */
async function scanTail(
  filePath: string,
  source: JsonlMetadataSource,
  size: number,
  floor: number,
  seedConversationId: string,
  resume: unknown
): Promise<FileFacts> {
  const facts = createFileFacts();
  const forward = source.tailScan === "forward";
  const sink = createSink(facts, !forward);
  let endOffset = size;
  let readable = 0;
  let chunkBytes = TAIL_CHUNK_BYTES;
  while (endOffset > floor && readable <= MAX_WINDOW_BYTES) {
    const chunk = await readTailChunk(filePath, endOffset, chunkBytes, floor);
    if (!chunk) {
      return facts;
    }
    readable += endOffset - chunk.start;
    if (chunk.lines.length === 0) {
      // 窗口整个落在一条过长的记录里。加大窗口，再不行就跳到这条记录之前的一条记录开头：
      // 窗口的边界必须落在记录边界上，否则跨过边界的记录永远读不到。
      if (chunkBytes < TAIL_MAX_CHUNK_BYTES && chunk.start > floor) {
        chunkBytes = Math.min(chunkBytes * 2, TAIL_MAX_CHUNK_BYTES);
        continue;
      }
      const boundary = await lineBoundaryBefore(filePath, chunk.start);
      if (boundary >= endOffset || boundary <= floor) {
        return facts;
      }
      endOffset = boundary;
      continue;
    }
    chunkBytes = TAIL_CHUNK_BYTES;
    const observer = source.createObserver(filePath, { seedConversationId, backward: !forward, ...(resume === undefined ? {} : { resume }) });
    if (forward) {
      // 正着读一个窗口，行序就是文件里的顺序：按回合判断的存储只能这样读。
      for (const line of chunk.lines) {
        observeLine(line, sink, observer);
      }
    } else {
      for (let index = chunk.lines.length - 1; index >= 0; index -= 1) {
        observeLine(chunk.lines[index]!, sink, observer);
      }
    }
    if (isTailReadEnough(facts)) {
      return facts;
    }
    if (chunk.nextEnd >= endOffset) {
      return facts;
    }
    endOffset = chunk.nextEnd;
  }
  return facts;
}

/**
 * Whether the tail has answered what it was read for: one file can hold several conversations (a resumed session
 * writes its rows into another session's file), and the list needs the last question of each of them, not just of
 * whichever came first while walking backwards.
 */
function isTailReadEnough(facts: FileFacts): boolean {
  if (facts.questionCount === 0) {
    return false;
  }
  for (const fact of facts.conversations.values()) {
    if (fact.questions.length === 0) {
      return false;
    }
  }
  // 最后一句问话后面还有内容，说明这一块没读到真正的最新一问：一问之后 Agent 还会跑很久，它的输出在文件里
  // 可能占几十兆。只有最新一问之后的记录都看过了，才敢说它就是最后一问。
  return facts.trailingAfterLastQuestion;
}

/**
 * Whether the head has answered what it was read for: the conversation's identity, and either a question or, when
 * the agent named the conversation itself, nothing more.
 */
function isReadEnough(facts: FileFacts, needQuestion: boolean): boolean {
  if (!facts.firstConversationId) {
    return false;
  }
  // 标题已经出现（Agent 写在文件里，或者索引里查到了），标题就轮不到「第一句问话」去猜了。
  if (!needQuestion || facts.questionCount > 0 || facts.titles.size > 0 || facts.fileTitle) {
    return true;
  }
  return false;
}

/** Parses one line and hands it to the observer; false when the line is not a whole record. */
function observeLine(line: string, sink: FactSink, observer: RowObserver): boolean {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // 窗口可能切在一条记录中间，坏行跳过，后面的照读。
    return false;
  }
  if (!isRecord(record)) {
    return false;
  }
  observer(record, sink);
  return true;
}

function createSink(facts: FileFacts, backward: boolean): FactSink {
  const conversation = (conversationId: string): ConversationFact => {
    facts.firstConversationId ||= conversationId;
    facts.lastConversationId = conversationId;
    let fact = facts.conversations.get(conversationId);
    if (!fact) {
      fact = { conversationId, questions: [], updatedAt: "" };
      facts.conversations.set(conversationId, fact);
    }
    return fact;
  };
  return {
    user(conversationId, content, createdAt) {
      const fact = conversation(conversationId);
      if (createdAt > fact.updatedAt) {
        fact.updatedAt = createdAt;
      }
      // 比最新一问更晚的一问出现后，先前那一问就不再是最后一问。
      if (facts.questionCount > 0 && startedAtNewer(createdAt, facts.newestQuestionAt)) {
        facts.trailingAfterLastQuestion = false;
      }
      if (!content.trim() || isInternalUserMessage(content)) {
        return;
      }
      const question = stripInjectedContext(content);
      if (!question) {
        return;
      }
      if (backward) {
        // 倒着读时先遇到的是最新的一问，它排在最前。
        fact.questions.unshift({ question, startedAt: createdAt });
      } else {
        fact.questions.push({ question, startedAt: createdAt });
      }
      facts.questionCount += 1;
      if (startedAtNewer(createdAt, facts.newestQuestionAt)) {
        facts.newestQuestionAt = createdAt;
      }
      if (isHumanQuestion(cleanQuestion(question))) {
        facts.humanCount += 1;
      }
    },
    message(conversationId, createdAt) {
      const fact = conversation(conversationId);
      if (createdAt > fact.updatedAt) {
        fact.updatedAt = createdAt;
      }
      // 只有比最新一问更晚的记录，才算「这一问之后还有内容」。
      if (facts.questionCount > 0 && createdAt >= facts.newestQuestionAt) {
        facts.trailingAfterLastQuestion = true;
      }
    },
    title(conversationId, text) {
      const value = text.replace(/\s+/gu, " ").trim();
      if (!value) {
        return;
      }
      if (conversationId === null) {
        // 倒着读时先遇到的是文件里最后一个标题；正着读时是最后一个看到的。
        if (!backward || !facts.fileTitle) {
          facts.fileTitle = value;
        }
        return;
      }
      if (!backward || !facts.titles.has(conversationId)) {
        facts.titles.set(conversationId, value);
      }
    }
  };
}

/** Head first, then tail: a conversation's questions stay in the order its rows were written. */
function mergeFacts(head: FileFacts, tail: FileFacts): FileFacts {
  const merged = createFileFacts();
  mergeSide(merged, head);
  mergeSide(merged, tail);
  merged.firstConversationId = head.firstConversationId || tail.firstConversationId;
  return merged;
}

function mergeSide(merged: FileFacts, side: FileFacts): void {
  for (const [conversationId, fact] of side.conversations) {
    const existing = merged.conversations.get(conversationId);
    if (!existing) {
      merged.conversations.set(conversationId, { ...fact, questions: [...fact.questions] });
      continue;
    }
    for (const question of fact.questions) {
      // 两个窗口可能覆盖同一条记录（文件很短时），同一问句不会重复出现。
      if (!existing.questions.some((known) => known.question === question.question && known.startedAt === question.startedAt)) {
        existing.questions.push(question);
      }
    }
    // 头窗口从头读、尾窗口从尾读，两边的问句拼起来不一定还按文件顺序：按时间排回去，
    // 否则「最后一问」会取到更早的那一句。
    existing.questions.sort((left, right) => (Date.parse(left.startedAt) || 0) - (Date.parse(right.startedAt) || 0));
    if (fact.updatedAt > existing.updatedAt) {
      existing.updatedAt = fact.updatedAt;
    }
  }
  for (const [conversationId, title] of side.titles) {
    merged.titles.set(conversationId, title);
  }
  if (side.fileTitle) {
    merged.fileTitle = side.fileTitle;
  }
  merged.questionCount += side.questionCount;
  merged.humanCount += side.humanCount;
}

async function readWholeFile(filePath: string, source: JsonlMetadataSource, facts: FileFacts): Promise<void> {
  const observer = source.createObserver(filePath, { seedConversationId: facts.firstConversationId, backward: false });
  const sink = createSink(facts, false);
  // 每一行只在「可能含要看的记录」时解析：文件里绝大多数是工具输出，解析它们只为了取一个时间戳。
  const wantsParse = wantsParseFor(source);
  try {
    for await (const row of readJsonlRowsCheap(filePath, wantsParse)) {
      const record = row.parsed;
      if (record) {
        observer(record, sink);
      } else {
        // 没解析的行仍然带着时间：会话的最后活动时间是最后一条记录的时间，不管它是什么记录。
        observerTimestampOnly(row.text, facts);
      }
    }
  } catch {
    // 读不动就用手上已有的事实。
  }
}

/**
 * The timestamp a raw row carries, applied to the conversation the file is currently in.
 *
 * <p>一行不解析也能读出时间，而会话的最后活动时间是最后一条记录的时间——那条记录往往是工具输出或助手正文，
 * 不做 JSON.parse 也照样知道它是何时写下的。归属用最近一次出现过的会话：同一个文件里的记录是按时间写的，
 * 最后那几条属于最后那个会话。</p>
 */
function observerTimestampOnly(line: string, facts: FileFacts): void {
  const stamped = TIMESTAMP_FIELD.exec(line)?.[1];
  if (!stamped || !Number.isFinite(Date.parse(stamped))) {
    return;
  }
  // 没有解析的行不参与时间：完整扫描只为「会变成消息的记录」更新时间，记账行、附件行、请求行都不算。
  // 那些行交给 wantsParse 决定是否解析，这里什么都不做。
  void stamped;
}

/** A source that does not say otherwise parses every row: correct beats fast. */
function wantsParseFor(source: JsonlMetadataSource): (line: string) => boolean {
  return source.wantsParse ?? (() => true);
}

/**
 * A row's own timestamp, read without parsing the row.
 *
 * <p>键的顺序由写出方决定：Codex 把 timestamp 放在第一个，Claude Code 却把 type 放在前面。只在行首找会
 * 全部落空，于是时间退回成最后一个能解析的记录——恰好是人的提问，比真实最后活动时间早几十秒。</p>
 */
const TIMESTAMP_FIELD = /"timestamp"\s*:\s*"([^"]+)"/u;

/**
 * Lists the sessions these files hold, in the order the scan would emit them, keeping only conversations someone
 * asked something in.
 */
export async function listJsonlSessions(
  adapter: SourceAdapter,
  source: JsonlMetadataSource,
  files: readonly JsonlSessionFile[],
  limit: number
): Promise<LocalSession[]> {
  const grouper = createSessionGrouper(adapter);
  const builders = new Map<string, SessionBuilder>();
  for (const file of files) {
    const facts = await summarizeJsonlFile(file.sessionFilePath, source, { hasTitle: Boolean(file.title) });
    for (const [conversationId, fact] of facts.conversations) {
      let builder = builders.get(conversationId);
      if (!builder) {
        builder = { workspacePath: null, updatedAt: "", turns: [], nativeTitle: "" };
        builders.set(conversationId, builder);
      }
      // 扫描时目录、时间都取自第一条见到的消息，这里也只补空位、只往后推时间。
      builder.workspacePath ??= file.workspacePath;
      if (fact.updatedAt > builder.updatedAt) {
        builder.updatedAt = fact.updatedAt;
      }
      for (const question of fact.questions) {
        builder.turns.push({ question: question.question, reply: "", steps: [], startedAt: question.startedAt });
      }
      const title = facts.titles.get(conversationId) || facts.fileTitle || file.title || "";
      if (title) {
        builder.nativeTitle = title;
      }
    }
  }
  return [...builders.entries()]
    .map(([conversationId, builder]) => finishSession(adapter, grouper, conversationId, builder))
    .filter((session): session is LocalSession => session !== null)
    .slice(0, limit);
}

/** Whether `candidate` is later than `current`, both ISO timestamps; an unreadable time never wins. */
function startedAtNewer(candidate: string, current: string): boolean {
  const a = Date.parse(candidate);
  if (Number.isNaN(a)) return false;
  const b = Date.parse(current);
  return Number.isNaN(b) || a > b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}