import { AgentHook, AgentHookContext } from "./hook.js";
import { IncrementalThinkExtractor, stripThink } from "../../utils/helpers.js";
import {
  buildToolEventFinishPayloads,
  buildToolEventStartPayload,
  invokeOnProgress,
  onProgressAcceptsReasoning,
  onProgressAcceptsToolEvents,
} from "../../utils/progress-events.js";
import { formatToolHints } from "../../utils/tool-hints.js";

type ProgressCallback = (content: string, opts?: Record<string, any>) => Promise<void> | void;

export class AgentProgressHook extends AgentHook {
  private onProgressCb?: ProgressCallback | null;
  private onStreamCb?: ((delta: string) => Promise<void> | void) | null;
  private onStreamEndCb?: ((opts?: Record<string, any>) => Promise<void> | void) | null;
  private channel: string;
  private chatId: string;
  private messageId?: string | null;
  private metadata: Record<string, any>;
  private sessionKey?: string | null;
  private toolHintMaxLength: number;
  private setToolContext?: (...args: any[]) => void;
  private onIteration?: (iteration: number) => void;
  private streamBuf = "";
  private thinkExtractor = new IncrementalThinkExtractor();
  private reasoningOpen = false;

  constructor(
    onProgress?: ProgressCallback | null,
    onStream?: ((delta: string) => Promise<void> | void) | null,
    onStreamEnd?: ((opts?: Record<string, any>) => Promise<void> | void) | null,
    {
      channel = "cli",
      chatId = "direct",
      messageId = null,
      metadata = {},
      sessionKey = null,
      toolHintMaxLength = 40,
      setToolContext = null,
      onIteration = null,
    }: {
      channel?: string;
      chatId?: string;
      messageId?: string | null;
      metadata?: Record<string, any>;
      sessionKey?: string | null;
      toolHintMaxLength?: number;
      setToolContext?: ((...args: any[]) => void) | null;
      onIteration?: ((iteration: number) => void) | null;
    } = {},
  ) {
    super(true);
    this.onProgressCb = onProgress;
    this.onStreamCb = onStream;
    this.onStreamEndCb = onStreamEnd;
    this.channel = channel;
    this.chatId = chatId;
    this.messageId = messageId;
    this.metadata = metadata;
    this.sessionKey = sessionKey;
    this.toolHintMaxLength = toolHintMaxLength;
    this.setToolContext = setToolContext ?? undefined;
    this.onIteration = onIteration ?? undefined;
  }

  wantsStreaming(): boolean {
    return Boolean(this.onStreamCb);
  }

  static stripThinkContent(text?: string | null): string | null {
    if (!text) return null;
    return stripThink(text) || null;
  }

  private toolHint(toolCalls: any[]): string {
    return formatToolHints(toolCalls, this.toolHintMaxLength);
  }

  override async onStream(context: AgentHookContext, delta: string): Promise<void> {
    const before = stripThink(this.streamBuf);
    this.streamBuf += delta;
    const after = stripThink(this.streamBuf);
    const incremental = after.slice(before.length);
    if (await this.thinkExtractor.feed(this.streamBuf, (text) => this.emitReasoning(text))) {
      context.streamedReasoning = true;
    }
    if (incremental) {
      await this.emitReasoningEnd();
      await this.onStreamCb?.(incremental);
    }
    context.streamedContent = Boolean(after);
  }

  override async onStreamEnd(context: AgentHookContext, opts: { resuming?: boolean } = {}): Promise<void> {
    await this.emitReasoningEnd();
    await this.onStreamEndCb?.({ resuming: Boolean(opts.resuming) });
    this.streamBuf = "";
    this.thinkExtractor.reset();
  }

  override async beforeIteration(context: AgentHookContext): Promise<void> {
    if (this.onIteration) this.onIteration(context.iteration ?? 0);
  }

  override async beforeExecuteTools(context: AgentHookContext): Promise<void> {
    if (this.onProgressCb) {
      const response = (context as any).response;
      if (!this.onStreamCb && !context.streamedContent) {
        const thought = AgentProgressHook.stripThinkContent(response?.content);
        if (thought) await this.onProgressCb(thought);
      }
      const calls = context.toolCalls ?? [];
      const hint = AgentProgressHook.stripThinkContent(this.toolHint(calls)) ?? "";
      const toolEvents = calls.map((call) => buildToolEventStartPayload(call));
      await invokeOnProgress(this.onProgressCb, hint, { toolHint: true, toolEvents });
    }
    if (this.setToolContext) {
      this.setToolContext(this.channel, this.chatId, this.messageId, this.metadata, this.sessionKey);
    }
  }

  override async emitReasoning(reasoningContent?: string | null): Promise<void> {
    if (this.onProgressCb && reasoningContent && onProgressAcceptsReasoning(this.onProgressCb)) {
      this.reasoningOpen = true;
      await this.onProgressCb(reasoningContent, { reasoning: true });
    }
  }

  override async emitReasoningEnd(): Promise<void> {
    if (this.reasoningOpen && this.onProgressCb) await this.onProgressCb("", { reasoningEnd: true });
    this.reasoningOpen = false;
  }

  override async afterIteration(context: AgentHookContext): Promise<void> {
    if (
      this.onProgressCb &&
      (context.toolCalls ?? []).length &&
      (context.toolEvents ?? []).length &&
      onProgressAcceptsToolEvents(this.onProgressCb)
    ) {
      const toolEvents = buildToolEventFinishPayloads(context);
      if (toolEvents.length) await invokeOnProgress(this.onProgressCb, "", { toolHint: false, toolEvents });
    }
  }

  override finalizeContent(context: AgentHookContext, content: string | null): string | null {
    return AgentProgressHook.stripThinkContent(content);
  }
}
