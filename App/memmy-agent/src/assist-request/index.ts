/**
 * 成员协助：由 Memmy 执行另一位成员的请求时，交给模型、但不在任务里显示的那部分要求。
 *
 * <p>请求本身是任务的第一条消息，任务页把它显示成一张请求卡片；结果的写法（「最后另起一段，以『结果：』开头……」）
 * 不是给执行方看的，桌面端后端把它记在会话的 {@code assistRequest.context} 上，这里在每一轮把它放进系统提示词。
 * 同一条任务里的后续请求共用这段要求。</p>
 *
 * <p>这一层还负责协助会话的敏感操作检查：Memmy 没有 Agent 那样的「帮我批准」，工具执行前按规则判断
 * 这一步是不是四类敏感操作之一，是的话拦下它并让模型在结果里说明（见 {@link ./safety}）。</p>
 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { AgentHook, type AgentHookContext, type SystemPromptBuildContext } from "../core/agent-runtime/hook.js";
import { ASSIST_SKIPPED_MARKER, assistSensitiveReason, type AssistApproval } from "./safety.js";

export { ASSIST_SKIPPED_MARKER } from "./safety.js";

const SECTION_ID = "assist-request";
/** 与运行时写入元数据时的上限一致。 */
const MAX_CONTEXT_CHARS = 4_000;

export interface AssistRequestSessions {
  get(key: string): { metadata?: Record<string, any> } | null;
}

/** 读出会话上记着的协助要求；不是协助任务或没有要求时返回 null。 */
export function assistRequestContext(sessions: AssistRequestSessions | null | undefined, sessionKey: string | null): string | null {
  if (!sessions || !sessionKey) return null;
  let session: { metadata?: Record<string, any> } | null = null;
  try {
    session = sessions.get(sessionKey);
  } catch {
    return null;
  }
  const assist = session?.metadata?.assistRequest;
  if (!assist || typeof assist !== "object") return null;
  const context = typeof assist.context === "string" ? assist.context.trim() : "";
  return context ? context.slice(0, MAX_CONTEXT_CHARS) : null;
}

/** 协助会话的批准策略：元数据里没记时按 `deny`（不放行）。 */
export function assistRequestApproval(
  sessions: AssistRequestSessions | null | undefined,
  sessionKey: string | null
): AssistApproval {
  if (!sessions || !sessionKey) return "deny";
  let session: { metadata?: Record<string, any> } | null = null;
  try {
    session = sessions.get(sessionKey);
  } catch {
    return "deny";
  }
  const assist = session?.metadata?.assistRequest;
  return assist && typeof assist === "object" && assist.approval === "allow" ? "allow" : "deny";
}

export function renderAssistRequestSection(context: string): string {
  return [
    "# 成员协助",
    "",
    "这条任务在执行另一位项目成员的协助请求，请求写在用户消息的 <memmy_assist_request> 里。回答时遵循：",
    "",
    context
  ].join("\n");
}

/**
 * 协助任务的系统提示词段落，以及工具执行前的敏感操作检查。会话按需读取，钩子本身不持有会话。
 *
 * <p>{@code reraise} 必须是 true：拦下这一步靠抛错，组合钩子默认会把钩子抛的错吞掉。</p>
 */
export function createAssistRequestHook(sessions: () => AssistRequestSessions | null | undefined): AgentHook {
  return new (class extends AgentHook {
    constructor() {
      super(true);
    }

    override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
      const context = assistRequestContext(sessions(), ctx.sessionKey);
      if (!context) return;
      ctx.upsertSection({ id: SECTION_ID, content: renderAssistRequestSection(context), source: "assist_request" });
    }

    /**
     * 工具执行前：协助会话、且这次是自动开始的那一次（approval 为 deny）时，四类敏感操作一律拦下。
     * 抛出的那句话回给模型，它会在结果里写明要做什么、为什么。
     */
    override async beforeToolCall(ctx: AgentHookContext, toolCall: any): Promise<void> {
      const key = ctx.sessionKey ?? null;
      if (!assistRequestContext(sessions(), key)) return;
      if (assistRequestApproval(sessions(), key) === "allow") return;
      const name = String(toolCall?.name ?? "");
      const args = readArguments(toolCall?.arguments);
      // 写文件时要知道它是不是已经存在：项目文件夹、附件目录与临时目录里的写入不算覆盖。
      const reason = assistSensitiveReason(name, args, {
        workspace: ctx.workspace ?? null,
        allowedRoots: [join(process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"), "media", "assist"), tmpdir(), "/tmp"],
        exists: (path) => existsSync(path)
      });
      if (!reason) return;
      throw new Error(`${ASSIST_SKIPPED_MARKER}${reason}。在结果里写明这一步要做什么、为什么。`);
    }
  })();
}

function readArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}
