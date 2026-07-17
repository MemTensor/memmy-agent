import { InboundMessage, OutboundMessage } from "../runtime-messages/events.js";
import { MessageBus } from "../runtime-messages/queue.js";
import { LLMProvider } from "../../providers/base.js";
import { goalStateWsBlob } from "./goal-state.js";
import { Session, SessionManager } from "./manager.js";
import { truncateText } from "../../utils/helpers.js";
import { withProgressCapabilities } from "../../utils/progress-events.js";

export const WEBUI_SESSION_METADATA_KEY = "webui";
export const WEBUI_LANGUAGE_METADATA_KEY = "webui_language";
export const WEBUI_TITLE_METADATA_KEY = "title";
export const WEBUI_TITLE_USER_EDITED_METADATA_KEY = "titleUserEdited";
export const TITLE_MAX_CHARS = 60;
export const TITLE_GENERATION_MAX_TOKENS = 96;
export const TITLE_GENERATION_REASONING_EFFORT = "none";
export const websocketTurnWallStartTimes = new Map<string, number>();

export function markWebuiSession(session: any, metadata: Record<string, any>): boolean {
  if (metadata?.[WEBUI_SESSION_METADATA_KEY] !== true) return false;
  session.metadata ??= {};
  session.metadata[WEBUI_SESSION_METADATA_KEY] = true;
  if (metadata?.[WEBUI_LANGUAGE_METADATA_KEY] === "zh-CN" || metadata?.[WEBUI_LANGUAGE_METADATA_KEY] === "en-US") {
    session.metadata[WEBUI_LANGUAGE_METADATA_KEY] = metadata[WEBUI_LANGUAGE_METADATA_KEY];
  }
  return true;
}

export function cleanGeneratedTitle(raw?: string | null): string {
  let text = (raw ?? "").trim();
  if (!text) return "";
  text = text.replace(/^\s*(title|标题)\s*[:：]\s*/i, "");
  text = text.trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/[。.!！?？,，;；:]+$/g, "");
  if (text.length > TITLE_MAX_CHARS) text = `${text.slice(0, TITLE_MAX_CHARS - 3).trimEnd()}...`;
  return text;
}

function titleInputs(session: Session | any): [string, string] {
  let userText = "";
  let assistantText = "";
  for (const message of session?.messages ?? []) {
    if (message?.commandMessage === true) continue;
    const role = message?.role;
    const content = message?.content;
    if (typeof content !== "string" || !content.trim()) continue;
    if (role === "user" && !userText) userText = content.trim();
    else if (role === "assistant" && !assistantText) assistantText = content.trim();
    if (userText && assistantText) break;
  }
  return [userText, assistantText];
}

export async function maybeGenerateWebuiTitle({ sessions, sessionKey, provider, model }: { sessions: SessionManager; sessionKey?: string; provider: LLMProvider | any; model: string }): Promise<boolean> {
  const key = sessionKey;
  if (!key) return false;
  const session = sessions.getOrCreate(key);
  if (session.metadata?.[WEBUI_SESSION_METADATA_KEY] !== true) return false;
  if (session.metadata?.[WEBUI_TITLE_USER_EDITED_METADATA_KEY] === true) return false;
  const currentTitle = session.metadata?.[WEBUI_TITLE_METADATA_KEY];
  if (typeof currentTitle === "string" && currentTitle.trim()) return false;

  const [userText, assistantText] = titleInputs(session);
  if (!userText) return false;
  let prompt = [
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
  if (assistantText) prompt += `\nAssistant: ${truncateText(assistantText, 1_000)}`;

  let response: any;
  try {
    const args = {
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
    };
    response = await provider.chatWithRetry(args);
  } catch {
    return false;
  }
  const title = cleanGeneratedTitle(response?.content);
  if (!title || title.toLowerCase().startsWith("error")) return false;
  session.metadata[WEBUI_TITLE_METADATA_KEY] = title;
  sessions.save(session);
  return true;
}

export async function maybeGenerateWebuiTitleAfterTurn({
  channel,
  metadata,
  sessions,
  sessionKey,
  provider,
  model,
}: {
  channel: string;
  metadata: Record<string, any>;
  sessions: SessionManager;
  sessionKey?: string;
  provider: LLMProvider | any;
  model: string;
}): Promise<boolean> {
  if (channel !== "websocket" || metadata?.[WEBUI_SESSION_METADATA_KEY] !== true) return false;
  return maybeGenerateWebuiTitle({ sessions, sessionKey, provider, model });
}

export function websocketTurnWallStartedAt(chatId: string): number | null {
  return websocketTurnWallStartTimes.get(chatId) ?? null;
}

export type WebuiRunStatus = "running" | "idle";

export function shouldPublishWebuiRunStatus(msg: InboundMessage): boolean {
  return msg.channel === "websocket"
    && msg.metadata?.[WEBUI_SESSION_METADATA_KEY] === true
    && msg.metadata?.webui_ephemeral_command == null;
}

export function shouldPublishWebuiThreadSessionUpdated(msg: InboundMessage): boolean {
  return msg.channel === "websocket"
    && msg.metadata?.[WEBUI_SESSION_METADATA_KEY] === true
    && msg.metadata?.webui_ephemeral_command == null;
}

export async function publishTurnRunStatus(bus: MessageBus | any, msg: InboundMessage, status: WebuiRunStatus): Promise<void> {
  if (msg.channel !== "websocket") return;
  const chatId = String(msg.chatId);
  const metadata: Record<string, any> = {
    ...(msg.metadata ?? {}),
    goalStatusEvent: true,
    goalStatus: status,
  };
  if (status === "running") {
    const startedAt = Date.now() / 1000;
    metadata.startedAt = startedAt;
    websocketTurnWallStartTimes.set(chatId, startedAt);
  } else {
    websocketTurnWallStartTimes.delete(chatId);
  }
  const outbound = new OutboundMessage({ channel: msg.channel, chatId, content: "", metadata });
  await bus.publishOutbound(outbound);
}

export async function finishWebuiTurn(input: {
  bus: MessageBus | any;
  msg: InboundMessage;
  sessionKey: string;
  sessions: SessionManager;
  latencyMs?: number | null;
  goalState?: Record<string, any> | null;
}): Promise<void> {
  const { bus, msg, sessionKey, sessions, latencyMs } = input;
  if (msg.channel !== "websocket") return;
  const session = sessions.getOrCreate(sessionKey);
  const metadata: Record<string, any> = {
    ...(msg.metadata ?? {}),
    turnEnd: true,
    goalState: input.goalState ?? goalStateWsBlob(session.metadata),
  };
  if (latencyMs != null) metadata.latencyMs = Math.floor(latencyMs);
  await bus.publishOutbound(new OutboundMessage({
    channel: msg.channel,
    chatId: msg.chatId,
    content: "",
    metadata,
  }));
  await publishTurnRunStatus(bus, msg, "idle");
}

export async function publishWebuiThreadSessionUpdated(bus: MessageBus | any, msg: InboundMessage): Promise<void> {
  if (!shouldPublishWebuiThreadSessionUpdated(msg)) return;
  const outbound = new OutboundMessage({
    channel: msg.channel,
    chatId: msg.chatId,
    content: "",
    metadata: {
      ...(msg.metadata ?? {}),
      sessionUpdated: true,
      sessionUpdateScope: "thread",
    },
  });
  await bus.publishOutbound(outbound);
}

export function buildBusProgressCallback(bus: MessageBus | any, msg: InboundMessage): (content: string, opts?: Record<string, any>) => Promise<void> {
  return withProgressCapabilities(
    async (content: string, opts: Record<string, any> = {}) => {
      const metadata: Record<string, any> = {
        ...(msg.metadata ?? {}),
        agentProgress: true,
        toolHint: Boolean(opts.toolHint),
      };
      if (opts.reasoning) metadata.reasoningDelta = true;
      if (opts.reasoningEnd) metadata.reasoningEnd = true;
      if (opts.toolEvents) metadata.toolEvents = opts.toolEvents;
      if (opts.fileEditEvents && msg.channel === "websocket") metadata.fileEditEvents = opts.fileEditEvents;
      const outbound = new OutboundMessage({
        channel: msg.channel,
        chatId: msg.chatId,
        content,
        metadata,
      });
      await bus.publishOutbound(outbound);
    },
    { toolEvents: true, reasoning: true, fileEditEvents: msg.channel === "websocket" },
  );
}

export class WebuiTurnCoordinator {
  bus: MessageBus | any;
  sessions: SessionManager;
  scheduleBackground: (promise: Promise<any>) => void;
  private titleContexts = new Map<string, { provider: LLMProvider | any; model: string }>();

  constructor(init: { bus: MessageBus | any; sessions: SessionManager; scheduleBackground?: (promise: Promise<any>) => void }) {
    this.bus = init.bus;
    this.sessions = init.sessions;
    this.scheduleBackground = init.scheduleBackground ?? ((promise) => void promise);
  }

  captureTitleContext(sessionKey: string, msg: InboundMessage, llm: { provider: LLMProvider | any; model: string }): void {
    if (msg.channel === "websocket" && msg.metadata?.[WEBUI_SESSION_METADATA_KEY] === true) {
      this.titleContexts.set(sessionKey, llm);
    }
  }

  discard(sessionKey: string): void {
    this.titleContexts.delete(sessionKey);
  }

  async publishRunStatus(msg: InboundMessage, status: WebuiRunStatus): Promise<void> {
    await publishTurnRunStatus(this.bus, msg, status);
  }

  async handleTurnEnd(msg: InboundMessage, { sessionKey, latencyMs }: { sessionKey?: string; latencyMs?: number | null }): Promise<void> {
    if (msg.channel !== "websocket") return;
    const key = sessionKey;
    if (!key) return;
    await finishWebuiTurn({
      bus: this.bus,
      msg,
      sessionKey: key,
      sessions: this.sessions,
      latencyMs,
    });
    this.scheduleTitleUpdate(msg, key);
  }

  private scheduleTitleUpdate(msg: InboundMessage, sessionKey: string): void {
    const titleContext = this.titleContexts.get(sessionKey);
    this.titleContexts.delete(sessionKey);
    if (msg.metadata?.[WEBUI_SESSION_METADATA_KEY] !== true || !titleContext) return;
    this.scheduleBackground(
      (async () => {
        const generated = await maybeGenerateWebuiTitleAfterTurn({
          channel: msg.channel,
          metadata: msg.metadata,
          sessions: this.sessions,
          sessionKey,
          provider: titleContext.provider,
          model: titleContext.model,
        });
        if (generated) {
          const outbound = new OutboundMessage({
            channel: msg.channel,
            chatId: msg.chatId,
            content: "",
            metadata: {
              ...(msg.metadata ?? {}),
              sessionUpdated: true,
              sessionUpdateScope: "metadata",
            },
          });
          await this.bus.publishOutbound(outbound);
        }
      })(),
    );
  }
}
