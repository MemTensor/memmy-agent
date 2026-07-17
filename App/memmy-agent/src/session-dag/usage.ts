import type { Session } from "../core/session/manager.js";
import { WEBUI_SESSION_METADATA_KEY } from "../core/session/webui-turns.js";
import type { ByokTokenUsageRecorderLike } from "../integrations/byok-token-usage/recorder.js";

export type SessionDagBuilderUsageInput = {
  usage: Record<string, unknown> | null | undefined;
  session: Session | null | undefined;
  sessionKey: string;
  turnId: string;
  attempt: number;
  messageStart: number;
  messageEnd: number;
  contextNodeCount: number;
  contextEdgeCount: number;
  provider?: string | null;
  modelId?: string | null;
};

export class SessionDagUsageReporter {
  constructor(private readonly recorder: ByokTokenUsageRecorderLike | null = null) {}

  async recordBuilderUsage(input: SessionDagBuilderUsageInput): Promise<boolean> {
    if (!this.recorder) return false;
    if (input.session?.metadata?.[WEBUI_SESSION_METADATA_KEY] !== true) return false;
    return this.recorder.recordAgentChatUsage({
      usage: input.usage,
      sessionKey: input.sessionKey,
      chatId: chatIdFromSessionKey(input.sessionKey),
      provider: input.provider,
      modelId: input.modelId,
      operation: "session_dag_builder",
      operationId: `session-dag-builder:${input.sessionKey}:${input.turnId}:attempt:${input.attempt}`,
      metadata: {
        turnId: input.turnId,
        attempt: input.attempt,
        messageStart: input.messageStart,
        messageEnd: input.messageEnd,
        contextNodeCount: input.contextNodeCount,
        contextEdgeCount: input.contextEdgeCount,
      },
    });
  }
}

function chatIdFromSessionKey(sessionKey: string): string | null {
  return sessionKey.startsWith("websocket:") ? sessionKey.slice("websocket:".length) || null : null;
}
