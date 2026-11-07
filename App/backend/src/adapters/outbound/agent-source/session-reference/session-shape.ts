/**
 * The four fields the association picker shows, and the rules that decide them.
 *
 * <p>Two paths read the agents' stores: the scan path streams every message of a session, and the metadata
 * path reads only the ends of a session file. Both must produce the same title, last question, directory and
 * time for the same conversation, otherwise a session would read one way in the list and another after it is
 * uploaded. The rules therefore live here, once, and both paths finish a session through {@link finishSession}.</p>
 */
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import type { LocalSession, LocalSessionTurn } from "./local-session-reader.js";
import type { SessionGrouper } from "./session-group.js";

export const TITLE_MAX_CHARS = 40;

/** What one conversation collected while its store was read. */
export interface SessionBuilder {
  workspacePath: string | null;
  updatedAt: string;
  turns: LocalSessionTurn[];
  /** The title the agent generated; the last one seen wins, since an agent may retitle as the work changes. */
  nativeTitle: string;
}

/**
 * The listed fields of one conversation, or `null` when nobody asked anything in it: an empty record or a
 * background-derived one never reaches the picker.
 */
export function finishSession(
  adapter: SourceAdapter,
  grouper: SessionGrouper,
  conversationId: string,
  builder: SessionBuilder
): LocalSession | null {
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
  if (/^#/u.test(text) || /^<\/?[a-z]/iu.test(text) || /^https?:\/\//u.test(text)) {
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

/** Drops context that memory plugins and hosts inject into the prompt, keeping what the person typed. */
export function stripInjectedContext(text: string): string {
  return text
    .replace(/<(system[_-]reminder|[a-z_]*memory_context|memmy_reference|project_context)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .trim();
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

function oneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}
