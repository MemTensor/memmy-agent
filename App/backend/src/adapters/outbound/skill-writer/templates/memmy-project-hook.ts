/** Memmy project hook template. */
import type { MemmyProjectHookMode } from "../project-hook/mode.js";

export type { MemmyProjectHookMode };

export interface RenderMemmyProjectHookScriptOptions {
  source: string;
  mode: MemmyProjectHookMode;
}

/**
 * 渲染项目钩子脚本：把本机项目指令、协作项目段和项目知识库交给宿主 Agent。
 *
 * <p>与记忆钩子的 `memmy-resume-hook.mjs` 是两份独立安装的脚本，各带自己的运行时副本和配置文件，
 * 项目协作怎么改都不会影响记忆钩子的内容与版本指纹，两边也不会读到对方的文件。</p>
 */
export function renderMemmyProjectHookScript(options: RenderMemmyProjectHookScriptOptions): string {
  return String.raw`#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  readCollabProjectInstructions,
  readProjectHookAccess,
  readProjectInstructions,
  recallProjectKnowledge
} from "./memmy-project-runtime.mjs";

const SOURCE = ${JSON.stringify(options.source)};
const MODE = ${JSON.stringify(options.mode)};
const CONFIG_URL = new URL("./memmy-project-config.json", import.meta.url);
// 知识库检索只在带提问的事件上用；提问最多取这么长，与运行时的上限一致。
const KNOWLEDGE_QUERY_MAX_CHARS = 8000;

async function main() {
  const payload = parseJson(await readStdin()) || {};
  // Cursor 会执行一遍从 Claude 设置导入的钩子；它自己的钩子负责这些事件，这里直接跳过，免得同一段输出两遍。
  if (MODE === "claude-code" && normalizeText(payload.cursor_version)) return;
  if (isPromptSubmitEvent(payload)) {
    await writePromptSubmitContext(payload, extractPrompt(payload));
    return;
  }
  if (isLifecycleEvent(payload)) {
    await writeLifecycleContext(payload);
  }
}

/**
 * 提交提示词：Codex 每一轮补一次本机项目指令与协作项目段，Claude Code 的会话开始上下文会持续整个会话、
 * 这里只补这一轮要用的项目知识库。Cursor 的提交事件只给项目指令，与它原来的实际效果一致。
 */
async function writePromptSubmitContext(payload, prompt) {
  try {
    const sections = [];
    if (MODE !== "claude-code") {
      sections.push(await localProjectContext(payload), await collabProjectContextFor(payload));
    }
    if (MODE !== "cursor") {
      sections.push(await projectKnowledgeContext(payload, prompt));
    }
    writePromptOutput(joinSections(sections));
  } catch {
    // 钩子内部出任何问题都不能打断宿主 Agent 的这一轮，按没有内容处理。
    writePromptOutput("");
  }
}

/** 会话开始与压缩后：项目指令要在系统提示词里重新给一次（压缩会把历史丢掉）。 */
async function writeLifecycleContext(payload) {
  try {
    writeLifecycleOutput(payload, joinSections([
      await localProjectContext(payload),
      await collabProjectContextFor(payload)
    ]));
  } catch {
    writeLifecycleOutput(payload, "");
  }
}

/**
 * 本机项目指令：会话的工作目录属于某个本机项目时，把该项目的指令交给 Agent。
 * 与其他进程共用一份文件，读不到就当作这个项目没有设定指令，不影响本轮对话。
 */
async function localProjectContext(payload) {
  try {
    const text = normalizeText(await readProjectInstructions({
      configUrl: CONFIG_URL,
      directory: workspacePath(payload) || null
    }));
    if (!text) return "";
    return [
      '<project_instructions source="memmy">',
      "本项目设定了以下项目指令，在本项目中的任务里遵循：",
      "",
      text,
      "</project_instructions>"
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * 协作内容的总开关：用户授权了协作、且这个 Agent 没有被单独关掉时才给。
 * 每次运行读一次授权文件，所以授权或撤销之后不需要重装钩子。
 */
async function collabAllowed() {
  try {
    const access = await readProjectHookAccess({ configUrl: CONFIG_URL });
    return access.granted === true && !access.disabledAgents.includes(SOURCE);
  } catch {
    return false;
  }
}

/** 协作项目段：工作目录或这个会话属于某个协作项目时，读它的背景与规范。 */
async function collabProjectContextFor(payload) {
  try {
    if (!(await collabAllowed())) return "";
    const hit = await readCollabProjectInstructions({
      configUrl: CONFIG_URL,
      sourceId: SOURCE,
      directory: workspacePath(payload) || null,
      conversationId: sessionStateKey(payload)
    });
    return collabProjectContext(hit);
  } catch {
    return "";
  }
}

/**
 * 协作项目段唯一的输出处。入参是 readCollabProjectInstructions 的结果 { projectId, context }：
 * context 已由契约里的 renderCollabProjectContext 渲染成完整的 <collab_project> 段，
 * 文字只在契约里维护一份，Memmy 自己的任务用的也是它。空串表示这一段没有内容。
 */
function collabProjectContext(hit) {
  if (!hit) return "";
  return normalizeText(hit.context);
}

/**
 * 项目关联的知识库：钩子只把工作目录与这一轮的提问交给本机后端，由它判断属于哪个项目、关联了哪些库。
 * 未授权、未关联、后端没起、检索失败都返回空串，不影响这一轮。
 */
async function projectKnowledgeContext(payload, prompt) {
  try {
    if (!(await collabAllowed())) return "";
    const query = sanitizeCaptureText(prompt).slice(0, KNOWLEDGE_QUERY_MAX_CHARS);
    if (!query) return "";
    return normalizeText(await recallProjectKnowledge({
      configUrl: CONFIG_URL,
      query,
      workspace: workspacePath(payload) || null
    }));
  } catch {
    return "";
  }
}

function joinSections(sections) {
  return sections.map(normalizeText).filter(Boolean).join("\n\n");
}

function writeLifecycleOutput(payload, context) {
  const event = normalizeText(payload.hook_event_name || payload.hookEventName) || "SessionStart";
  if (MODE === "cursor") {
    process.stdout.write(context ? JSON.stringify({ additional_context: context }) : "{}");
    return;
  }
  process.stdout.write(context ? JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context
    }
  }) : JSON.stringify({ continue: true, suppressOutput: true }));
}

function writePromptOutput(context) {
  if (MODE === "cursor") {
    process.stdout.write(context ? JSON.stringify({ additional_context: context }) : "{}");
    return;
  }
  process.stdout.write(context ? JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context
    }
  }) : JSON.stringify({ continue: true, suppressOutput: true }));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
  });
}

function parseJson(value) {
  try {
    return value.trim() ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function hookEventName(payload) {
  return normalizeText(payload.hook_event_name || payload.hookEventName).toLowerCase();
}

function isPromptSubmitEvent(payload) {
  const event = hookEventName(payload);
  return event === "userpromptsubmit" || event === "beforesubmitprompt";
}

function isLifecycleEvent(payload) {
  const event = hookEventName(payload);
  return event === "sessionstart" || event === "postcompact";
}

function extractPrompt(payload) {
  const direct = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.prompt_text,
    payload.promptText,
    payload.input
  ].map(normalizeText).find(Boolean);
  if (direct) {
    return direct;
  }

  if (Array.isArray(payload.messages)) {
    for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
      const message = payload.messages[index];
      if (message && typeof message === "object" && message.role === "user") {
        const text = contentText(message.content);
        if (text) {
          return text;
        }
      }
    }
  }

  return "";
}

function contentText(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(contentText).filter(Boolean).join("\n").trim();
  }
  if (value && typeof value === "object") {
    return normalizeText(value.text) || contentText(value.content);
  }
  return "";
}

function sessionStateKey(payload) {
  return normalizeText(payload.session_id) ||
    normalizeText(payload.sessionId) ||
    normalizeText(payload.conversation_id) ||
    normalizeText(payload.conversationId) ||
    normalizeText(payload.thread_id) ||
    normalizeText(payload.threadId) ||
    normalizeText(payload.cwd) ||
    "default";
}

function workspacePath(payload) {
  const direct = normalizeText(payload.cwd) || normalizeText(payload.workspace_path || payload.workspacePath);
  if (direct) {
    return direct;
  }
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : payload.workspaceRoots;
  if (!Array.isArray(roots)) {
    return "";
  }
  return roots.map(item => normalizeText(item)).find(Boolean) || "";
}

/** 提问里可能带着上一轮注入的段落，检索前先去掉，免得把注入的文字当成用户的问题。 */
function sanitizeCaptureText(value) {
  return normalizeText(value)
    .replace(/<memmy_memory_context\b[\s\S]*?<\/memmy_memory_context>/giu, "")
    .replace(/<current_user_request>[\s\S]*?<\/current_user_request>/giu, "")
    .trim();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch(() => {
  writeLifecycleOutput({}, "");
});
`;
}
