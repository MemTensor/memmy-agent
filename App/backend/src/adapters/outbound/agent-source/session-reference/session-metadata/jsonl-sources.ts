/**
 * How each JSONL-backed agent's rows become listable facts.
 *
 * <p>Every profile below reads the agent's own record format and reports the three things the list needs: what a
 * person typed, when the conversation last moved, and the title the agent gave it. Discovery comes from the same
 * functions the scan uses, so both paths see the same files in the same order.</p>
 */
import { basename, dirname, join } from "node:path";
import { discoverClaudeCodeSessions } from "@memmy/agent-source-readers/adapters/claude-code/project-discovery";
import { discoverCodexSessions } from "@memmy/agent-source-readers/adapters/codex/session-discovery";
import { readJsonlObjects } from "@memmy/agent-source-readers/adapters/jsonl-lines";
import { readJsonlSessionTitle } from "@memmy/agent-source-readers/adapters/jsonl-session-title";
import { extractWorkbuddyMessage } from "@memmy/agent-source-readers/adapters/workbuddy/history-reader";
import { discoverWorkbuddySessions } from "@memmy/agent-source-readers/adapters/workbuddy/session-discovery";
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { iso, redactSecrets, text } from "@memmy/agent-source-core";
import { readLastLineWhere } from "./file-window.js";
import type { FactSink, JsonlMetadataSource, JsonlSessionFile, ObserverContext, RowObserver } from "./jsonl-facts.js";

const CLAUDE_CODE_SOURCE_ID = "claude_code";
const WORKBUDDY_SOURCE_ID = "workbuddy";
const CODEX_SOURCE_ID = "codex";

/** What one JSONL source needs to be listed: the files to read and the rules that read them. */
export interface JsonlMetadataPlan {
  source: JsonlMetadataSource;
  files: JsonlSessionFile[];
}

/** Returns how to list this agent's sessions from metadata, or `null` when it has no such path. */
export async function planJsonlSessions(adapter: SourceAdapter, window: number): Promise<JsonlMetadataPlan | null> {
  switch (adapter.descriptor.sourceId) {
    case CLAUDE_CODE_SOURCE_ID:
      return planClaudeCode(adapter, window);
    case WORKBUDDY_SOURCE_ID:
      return planWorkbuddy(adapter, window);
    case CODEX_SOURCE_ID:
      return planCodex(adapter, window);
    default:
      return null;
  }
}

async function planClaudeCode(adapter: SourceAdapter, window: number): Promise<JsonlMetadataPlan> {
  const sessions = await discoverClaudeCodeSessions({
    root: adapter.descriptor.dataPath,
    order: "recent_first",
    maxSessions: window
  });
  const files = await Promise.all(sessions.map(async (session) => ({
    sessionFilePath: session.sessionFilePath,
    workspacePath: session.workspacePath,
    // The name a person sees in Claude Code lives in its own title record, read the way the scan reads it.
    title: await readJsonlSessionTitle(session.sessionFilePath)
  })));
  return {
    source: {
      sourceId: CLAUDE_CODE_SOURCE_ID,
      createObserver: createClaudeObserver,
      // 人的提问要看内容；助手行与回合结束行决定「最后活动时间」，也要解析（完整扫描只为它们产生的消息更新时间）。
      // 附件、请求、记账、标题一类行在完整扫描里根本不产生消息，既不解析也不计时间。
      wantsParse: (line) => line.includes('"type":"user"') || line.includes('"type": "user"')
        || line.includes('"type":"assistant"') || line.includes('"type": "assistant"')
        || line.includes('"type":"system"') || line.includes('"type": "system"')
    },
    files
  };
}

async function planWorkbuddy(adapter: SourceAdapter, window: number): Promise<JsonlMetadataPlan> {
  const sessions = await discoverWorkbuddySessions({
    projectsRoot: adapter.descriptor.dataPath,
    order: "recent_first",
    maxSessions: window
  });
  // WorkBuddy rewrites its name as the work changes and the last one is the name a person sees. That row can sit a
  // few megabytes before the end, so it is searched for by its marker instead of being looked for in a window.
  const files = await Promise.all(sessions.map(async (session) => ({
    sessionFilePath: session.sessionFilePath,
    workspacePath: session.workspacePath,
    title: await readWorkbuddyTitle(session.sessionFilePath)
  })));
  return {
    source: {
      sourceId: WORKBUDDY_SOURCE_ID,
      createObserver: createWorkbuddyObserver,
      // WorkBuddy 的消息类型由 type 与 role 共同决定：message 行带 role，工具行与推理行只有 type。
      // 完整扫描会为所有这些行产生消息并推进最后活动时间，所以它们都要解析；ai-title 决定标题。
      // 只有明确不产生消息的行才跳过。
      wantsParse: (line) => {
        if (line.includes('"ai-title"')) return true;
        if (line.includes('"role"')) return true;
        return line.includes('"type":"message"') || line.includes('"type":"function_call"')
          || line.includes('"type":"function_call_result"') || line.includes('"type":"reasoning"');
      }
    },
    files
  };
}

/** The newest name WorkBuddy wrote for a conversation, or "" when it has not named one. */
async function readWorkbuddyTitle(filePath: string): Promise<string> {
  return (await readLastLineWhere(filePath, "ai-title", (line) => {
    try {
      const record: unknown = JSON.parse(line);
      return isRecord(record) && record.type === "ai-title" ? workbuddyTitle(record) || null : null;
    } catch {
      return null;
    }
  })) ?? "";
}

async function planCodex(adapter: SourceAdapter, window: number): Promise<JsonlMetadataPlan> {
  const sessions = await discoverCodexSessions({
    root: adapter.descriptor.dataPath,
    order: "recent_first",
    maxSessions: window
  });
  const titles = await readCodexThreadTitles(adapter.descriptor.dataPath);
  return {
    source: {
      sourceId: CODEX_SOURCE_ID,
      // Codex names its threads in one index beside the session files, keyed by thread id.
      createObserver: createCodexObserver((conversationId) => titles.get(conversationId)),
      // 一个回合是不是用户自己发起的，写在它的行上面（turn_context 的 model），所以要正着读。
      tailScan: "forward",
      // 记账记录（谁是本文件、回合开始结束、模型）与人的消息要解析；工具输出与助手正文只用来推时间。
      wantsParse: (line) => {
        if (line.includes('"type":"session_meta"') || line.includes('"type":"turn_context"')
          || line.includes('"type":"event_msg"')) return true;
        return line.includes('"type":"response_item"') && line.includes('"role":"user"');
      }
    },
    files: sessions.map((session) => ({ sessionFilePath: session.sessionFilePath, workspacePath: session.workspacePath }))
  };
}

/**
 * Rows Claude Code writes for its own bookkeeping. `last-prompt` in particular is only a snapshot of the latest
 * input, so it must never be read as a question.
 */
const CLAUDE_IGNORED_ROW_TYPES = new Set([
  "attachment", "file-history-snapshot", "mode", "permission-mode", "atis-latch", "last-prompt", "cost-state"
]);

/**
 * Claude Code writes one row per event; a row is a question only when Claude marked its origin as human, because a
 * tool result is also written as a `type: user` row.
 */
function createClaudeObserver(_filePath: string, context: ObserverContext): RowObserver {
  let conversationId = context.seedConversationId;
  /**
   * Claude stages rows only once a turn is open, so rows before the file's first question belong to no
   * conversation. A tail read starts after that question, so everything it sees is staged.
   */
  let open = context.backward;
  return (record, sink) => {
    conversationId = text(record.sessionId) || conversationId;
    const type = text(record.type);
    if (!type || CLAUDE_IGNORED_ROW_TYPES.has(type) || record.isSidechain === true) {
      return;
    }
    // A turn_duration row closes a turn; it carries no message of its own.
    if (type === "system") {
      return;
    }
    const message = isRecord(record.message) ? record.message : undefined;
    const blocks = Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
    let userText = typeof message?.content === "string" ? message.content : "";
    let assistantText = "";
    let hasTool = false;
    for (const block of blocks) {
      const kind = text(block.type);
      if (kind === "text" && type === "assistant") {
        const value = text(block.text);
        assistantText = assistantText ? `${assistantText}\n${value}` : value;
      } else if (kind === "text" && type === "user") {
        const value = text(block.text);
        userText = userText ? `${userText}\n${value}` : value;
      } else if (kind === "tool_use" || kind === "tool_result") {
        hasTool = true;
      }
    }
    const createdAt = iso(record.timestamp);
    const fromHuman = text(isRecord(record.origin) ? record.origin.kind : undefined) === "human";
    const isHuman = type === "user" && fromHuman && Boolean(userText.trim());
    if (isHuman) {
      open = true;
      if (conversationId) {
        sink.user(conversationId, redactSecrets(userText), createdAt);
      }
      return;
    }
    if (open && conversationId && (assistantText || hasTool)) {
      sink.message(conversationId, createdAt);
    }
  };
}

/** WorkBuddy writes roles, tool events and its own title record into one file; the extractor is the scan's own. */
function createWorkbuddyObserver(filePath: string, _context: ObserverContext): RowObserver {
  const fallbackConversationId = basename(filePath, ".jsonl");
  let lineNumber = 0;
  return (record, sink) => {
    lineNumber += 1;
    if (record.type === "ai-title") {
      sink.title(null, workbuddyTitle(record));
      return;
    }
    const message = extractWorkbuddyMessage(record, fallbackConversationId, lineNumber);
    if (!message) {
      return;
    }
    if (message.role === "user") {
      sink.user(message.conversationId, redactSecrets(message.content), message.createdAt);
    }
    sink.message(message.conversationId, message.createdAt);
  };
}

function workbuddyTitle(record: Record<string, unknown>): string {
  const value = [record.aiTitle, record.title].find(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  );
  return value ?? "";
}

/** Codex runs its own auxiliary prompts as ordinary messages; those turns are Codex talking to itself. */
const INTERNAL_CODEX_MODELS = new Set(["codex-auto-review"]);

/** The trigger Codex records for a turn it started on its own to review the thread. */
const GUARDIAN_REVIEW_TRIGGER = "guardian_review";

/** The trigger written on the turn's own opening record, when it carries one. */
function turnTrigger(payload: Record<string, unknown>): string {
  const attribution = payload.turn_attribution;
  return isRecord(attribution) ? text(attribution.turn_trigger) : "";
}

/** The one content kind that carries what the person actually typed. */
const USER_CONTENT_ITEM_KIND = "user.text";

const CODEX_TOOL_EVENTS = new Set([
  "function_call", "custom_tool_call", "web_search_call", "function_call_output", "custom_tool_call_output"
]);

/**
 * Codex records a turn as events around its response items. A user message counts only when the turn was the
 * person's own, and a finished turn also leaves a record that moves the conversation's time.
 */
function createCodexObserver(titleOf: (conversationId: string) => string | undefined): (filePath: string, context: ObserverContext) => RowObserver {
  return (_filePath, context) => createCodexReader(titleOf, context.seedConversationId, context.resume);
}

function createCodexReader(titleOf: (conversationId: string) => string | undefined, seedConversationId: string, resume?: unknown): RowObserver {
  const carried = isRecord(resume) ? resume : undefined;
  let conversationId = seedConversationId || text(carried?.conversationId);
  let turnModel = text(carried?.turnModel);
  let turnInternal = carried?.turnInternal === true;
  let titleReported = "";
  const observer: RowObserver = (record, sink) => {
    const payload = isRecord(record.payload) ? record.payload : {};
    const type = text(record.type);
    const timestamp = iso(record.timestamp);
    if (type === "session_meta") {
      conversationId = text(payload.session_id) || text(payload.id) || conversationId;
      reportTitle(sink);
      return;
    }
    if (type === "turn_context" || (type === "event_msg" && text(payload.type) === "task_started")) {
      // 一个回合是不是 Codex 自己发起的，写在回合开头：辅助模型的名字，或它自建评审回合的触发标记。
      // 两样都认，因为读到的那一行不一定带得出模型名。
      const model = text(payload.model);
      const trigger = turnTrigger(payload);
      if (model) {
        turnInternal = INTERNAL_CODEX_MODELS.has(model);
        turnModel = model;
      }
      if (trigger) {
        turnInternal = trigger === GUARDIAN_REVIEW_TRIGGER;
      }
      return;
    }
    if (type === "event_msg" && text(payload.type) === "task_complete") {
      // 扫描为这一条补一条 system 消息，它的时间也算进会话的最后活动时间。
      if (conversationId) {
        sink.message(conversationId, timestamp);
      }
      return;
    }
    if (type !== "response_item" || !conversationId || turnInternal || INTERNAL_CODEX_MODELS.has(turnModel)) {
      return;
    }
    const payloadType = text(payload.type);
    if (payloadType === "message") {
      const role = text(payload.role);
      if (role !== "user" && role !== "assistant" && role !== "developer" && role !== "system") {
        return;
      }
      const content = messageContent(payload, role);
      if (!content) {
        return;
      }
      if (role === "user") {
        sink.user(conversationId, redactSecrets(content), timestamp);
      } else {
        sink.message(conversationId, timestamp);
      }
      return;
    }
    if (CODEX_TOOL_EVENTS.has(payloadType)) {
      sink.message(conversationId, timestamp);
    }
  };

  function messageContent(payload: Record<string, unknown>, role: string): string {
    if (!Array.isArray(payload.content)) {
      return "";
    }
    const kinds = role === "user" ? contentItemKinds(payload) : undefined;
    return payload.content
      .map((item, index) => (isRecord(item) && keepsUserContentItem(kinds, index) ? text(item.text) : ""))
      .filter(Boolean)
      .join("\n");
  }

  function reportTitle(sink: FactSink): void {
    const title = conversationId ? titleOf(conversationId) : undefined;
    if (title && title !== titleReported) {
      titleReported = title;
      sink.title(conversationId, title);
    }
  }

  // 回合归属与当前回合的模型都写在文件前段的记录里，续读窗口要继承，否则评审回合会被当成人的提问。
  observer.resume = () => ({ conversationId, turnModel, turnInternal });
  return observer;
}

/** Codex labels every content item it packs into a message, so the injected ones can be dropped. */
function contentItemKinds(payload: Record<string, unknown>): string[] | undefined {
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!isRecord(meta) || !Array.isArray(meta.content_item_kinds)) {
    return undefined;
  }
  return meta.content_item_kinds.map((kind) => text(kind));
}

function keepsUserContentItem(kinds: string[] | undefined, index: number): boolean {
  if (!kinds) {
    return true;
  }
  const kind = kinds[index];
  return kind === undefined || kind === "" || kind === USER_CONTENT_ITEM_KIND;
}

/** Codex keeps the names it generated in one index next to the session files, by thread id. */
async function readCodexThreadTitles(sessionsRoot: string): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  try {
    for await (const record of readJsonlObjects(join(dirname(sessionsRoot), "session_index.jsonl"))) {
      const id = text(record.id).trim();
      const title = text(record.thread_name).replace(/\s+/gu, " ").trim();
      if (id && title) {
        titles.set(id, title);
      }
    }
  } catch {
    // 老版本 Codex 没有这份索引，标题退回人问的第一句。
  }
  return titles;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}