/**
 * 成员协助：由 Memmy 执行另一位成员的请求时，交给模型、但不在任务里显示的那部分要求。
 *
 * <p>请求本身是任务的第一条消息，任务页把它显示成一张请求卡片；结果的写法（「最后另起一段，以『结果：』开头……」）
 * 不是给执行方看的，桌面端后端把它记在会话的 {@code assistRequest.context} 上，这里在每一轮把它放进系统提示词。
 * 同一条任务里的后续请求共用这段要求。</p>
 */
import { AgentHook, type SystemPromptBuildContext } from "../core/agent-runtime/hook.js";

const SECTION_ID = "assist-request";
/** 与运行时写入元数据时的上限一致。 */
const MAX_CONTEXT_CHARS = 2_000;

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

export function renderAssistRequestSection(context: string): string {
  return [
    "# 成员协助",
    "",
    "这条任务在执行另一位项目成员的协助请求，请求写在用户消息的 <memmy_assist_request> 里。回答时遵循：",
    "",
    context
  ].join("\n");
}

/** 协助任务的系统提示词段落；会话按需读取，钩子本身不持有会话。 */
export function createAssistRequestHook(sessions: () => AssistRequestSessions | null | undefined): AgentHook {
  return new (class extends AgentHook {
    override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
      const context = assistRequestContext(sessions(), ctx.sessionKey);
      if (!context) return;
      ctx.upsertSection({ id: SECTION_ID, content: renderAssistRequestSection(context), source: "assist_request" });
    }
  })();
}
