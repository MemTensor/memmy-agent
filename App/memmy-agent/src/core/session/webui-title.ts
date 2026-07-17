import { randomUUID } from "node:crypto";
import { OutboundMessage } from "../runtime-messages/events.js";
import type { MessageBus } from "../runtime-messages/queue.js";
import type { LLMProvider } from "../../providers/base.js";
import type { LLMRuntimeResolver } from "../../utils/llm-runtime.js";
import { truncateText } from "../../utils/helpers.js";
import type { ByokTokenUsageRecorderLike } from "../../integrations/byok-token-usage/recorder.js";
import { Session, SessionManager } from "./manager.js";
import {
  cleanGeneratedTitle,
  TITLE_GENERATION_MAX_TOKENS,
  TITLE_GENERATION_REASONING_EFFORT,
  WEBUI_SESSION_METADATA_KEY,
  WEBUI_TITLE_METADATA_KEY,
  WEBUI_TITLE_USER_EDITED_METADATA_KEY,
} from "./webui-turns.js";

export type WebuiTitleTrackInput = {
  chatId: string;
  content: string;
  metadata: Record<string, any>;
  mediaPaths?: string[];
};

type PendingTitleRequest = {
  chatId: string;
  sessionKey: string;
  content: string;
  mediaPaths: string[];
  provider: LLMProvider | any;
  model: string;
};

export type WebuiTitleServiceOptions = {
  bus: MessageBus | any;
  sessions: SessionManager;
  llmRuntime: LLMRuntimeResolver;
  scheduleBackground: (promise: Promise<any>) => void;
  tokenUsageRecorder: ByokTokenUsageRecorderLike;
};

export class WebuiTitleService {
  private readonly bus: MessageBus | any;
  private readonly sessions: SessionManager;
  private readonly llmRuntime: LLMRuntimeResolver;
  private readonly scheduleBackground: (promise: Promise<any>) => void;
  private readonly tokenUsageRecorder: ByokTokenUsageRecorderLike;
  private readonly pendingByChatId = new Map<string, PendingTitleRequest>();
  private readonly inFlightSessionKeys = new Set<string>();

  constructor(options: WebuiTitleServiceOptions) {
    this.bus = options.bus;
    this.sessions = options.sessions;
    this.llmRuntime = options.llmRuntime;
    this.scheduleBackground = options.scheduleBackground;
    this.tokenUsageRecorder = options.tokenUsageRecorder;
  }

  trackUserMessage(input: WebuiTitleTrackInput): void {
    if (input.metadata?.[WEBUI_SESSION_METADATA_KEY] !== true) return;
    if (input.metadata?.webui_ephemeral_command != null) return;
    const mediaPaths = Array.isArray(input.mediaPaths) ? input.mediaPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0) : [];
    if (isCommandOnlyText(input.content, mediaPaths)) return;

    let runtime: ReturnType<LLMRuntimeResolver>;
    try {
      runtime = this.llmRuntime();
    } catch (error) {
      console.error("WebUI title runtime capture failed:", error);
      return;
    }

    if (!runtime?.provider) return;
    const sessionKey = `websocket:${input.chatId}`;
    this.pendingByChatId.set(input.chatId, {
      chatId: input.chatId,
      sessionKey,
      content: input.content,
      mediaPaths,
      provider: runtime.provider,
      model: runtime.model,
    });
  }

  onUserMessagePersisted(chatId: string): void {
    const pending = this.pendingByChatId.get(chatId);
    if (!pending) return;
    this.pendingByChatId.delete(chatId);
    if (this.inFlightSessionKeys.has(pending.sessionKey)) return;

    this.scheduleBackground(
      (async () => {
        try {
          await this.generateTitle(pending);
        } catch (error) {
          console.error("WebUI title generation failed:", error);
        }
      })(),
    );
  }

  private async generateTitle(pending: PendingTitleRequest): Promise<boolean> {
    if (this.inFlightSessionKeys.has(pending.sessionKey)) return false;
    this.inFlightSessionKeys.add(pending.sessionKey);
    try {
      const session = this.sessions.loadSession(pending.sessionKey);
      if (!this.canWriteModelTitle(session)) return false;
      if (countTitleUserMessages(session) !== 1) return false;
      const userText = firstTitleUserMessage(session);
      if (!userText) return false;

      const response = await this.requestModelTitle(pending.provider, pending.model, userText);
      this.recordTitleUsage(pending, response?.usage);

      const title = cleanGeneratedTitle(response?.content);
      if (!title || title.toLowerCase().startsWith("error")) return false;

      const latest = this.sessions.loadSession(pending.sessionKey);
      if (!this.canWriteModelTitle(latest)) return false;
      const target = this.writeTargetSession(pending.sessionKey, latest);
      if (!this.canWriteModelTitle(target)) return false;

      target.metadata ??= {};
      target.metadata[WEBUI_TITLE_METADATA_KEY] = title;
      this.sessions.save(target);

      await this.bus.publishOutbound(new OutboundMessage({
        channel: "websocket",
        chatId: pending.chatId,
        content: "",
        metadata: {
          [WEBUI_SESSION_METADATA_KEY]: true,
          sessionUpdated: true,
          sessionUpdateScope: "metadata",
        },
      }));
      return true;
    } catch {
      return false;
    } finally {
      this.inFlightSessionKeys.delete(pending.sessionKey);
    }
  }

  private async requestModelTitle(provider: LLMProvider | any, model: string, userText: string): Promise<any> {
    const prompt = [
      "Generate a concise title for this chat.",
      "Rules:",
      "- Use the same language as the user when practical.",
      "- 3 to 8 words.",
      "- No quotes.",
      "- No punctuation at the end.",
      "- Return only the title.",
      "",
      `User: ${truncateText(userText, 1_000)}`,
    ].join("\n");

    return provider.chatWithRetry({
      messages: [
        {
          role: "system",
          content: "You write short, neutral chat titles. Return only the title text.",
        },
        { role: "user", content: prompt },
      ],
      tools: null,
      model,
      maxTokens: TITLE_GENERATION_MAX_TOKENS,
      temperature: 0.2,
      reasoningEffort: TITLE_GENERATION_REASONING_EFFORT,
      retryMode: "standard",
    });
  }

  private recordTitleUsage(pending: PendingTitleRequest, usage: Record<string, unknown> | null | undefined): void {
    void this.tokenUsageRecorder.recordAgentChatUsage({
      usage,
      sessionKey: pending.sessionKey,
      chatId: pending.chatId,
      provider: stringOrNull(pending.provider?.spec?.name),
      modelId: stringOrNull(pending.model) ?? stringOrNull(pending.provider?.getDefaultModel?.()),
      operation: "session_title",
      operationId: randomUUID(),
    }).catch((error) => {
      console.error("WebUI title usage recording failed:", error);
    });
  }

  private canWriteModelTitle(session: Session | null | undefined): session is Session {
    if (!session) return false;
    if (session.metadata?.[WEBUI_SESSION_METADATA_KEY] !== true) return false;
    if (session.metadata?.[WEBUI_TITLE_USER_EDITED_METADATA_KEY] === true) return false;
    const currentTitle = session.metadata?.[WEBUI_TITLE_METADATA_KEY];
    return !(typeof currentTitle === "string" && currentTitle.trim());
  }

  private writeTargetSession(sessionKey: string, latest: Session | null): Session {
    const cached = this.sessions.sessions.get(sessionKey);
    return cached ?? latest!;
  }
}

export function firstTitleUserMessage(session: Session | any): string {
  for (const message of session?.messages ?? []) {
    if (message?.commandMessage === true) continue;
    if (message?.role !== "user") continue;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    if (!content) continue;
    if (isCommandOnlyText(content, [])) continue;
    return content;
  }
  return "";
}

function countTitleUserMessages(session: Session | any): number {
  let count = 0;
  for (const message of session?.messages ?? []) {
    if (message?.commandMessage === true) continue;
    if (message?.role === "user") count += 1;
  }
  return count;
}

function isCommandOnlyText(content: string, mediaPaths: string[]): boolean {
  const text = content.trim();
  return Boolean(text) && text.startsWith("/") && mediaPaths.length === 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
