import { Tool } from "./base.js";
import { RequestContextStore } from "./context.js";

export class SpawnTool extends Tool {
  static scopes = new Set(["core"]);
  manager: any;
  originChannel = "cli";
  originChatId = "direct";
  sessionKey = "cli:direct";
  originMessageId: string | null = null;
  private readonly requestContext = new RequestContextStore();

  constructor(options: { manager?: any } | any = {}) {
    super();
    this.manager = options && typeof options === "object" && "manager" in options ? options.manager : options;
  }

  static enabled(ctx: any): boolean {
    return Boolean(ctx?.subagentManager);
  }

  static create(ctx: any): Tool {
    return new SpawnTool({ manager: ctx?.subagentManager });
  }

  get name(): string {
    return "spawn";
  }

  get description(): string {
    return "Spawn a subagent task.";
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        task: { type: "string" },
        label: { type: "string" },
        temperature: { type: "number", minimum: 0, maximum: 2 },
      },
      required: ["task"],
    };
  }

  setContext(ctx: any): void {
    this.requestContext.set(ctx);
    this.originChannel = ctx.channel ?? "cli";
    this.originChatId = ctx.chatId ?? "direct";
    this.sessionKey = ctx.sessionKey ?? `${this.originChannel}:${this.originChatId}`;
    this.originMessageId = ctx.messageId ?? null;
  }

  async execute(params: { task?: string; label?: string; temperature?: number } = {}): Promise<string> {
    if (!params.task) return "Error: missing task";
    if (!this.manager || typeof this.manager.spawn !== "function") {
      return "Error: subagent manager is unavailable; cannot spawn subagent.";
    }
    const requestContext = this.requestContext.get();
    const originChannel = requestContext?.channel ?? this.originChannel;
    const originChatId = requestContext?.chatId ?? this.originChatId;
    const sessionKey = requestContext
      ? (requestContext.sessionKey ?? `${originChannel}:${originChatId}`)
      : this.sessionKey;
    const originMessageId = requestContext?.messageId ?? this.originMessageId;
    const running = this.manager.getRunningCount?.() ?? 0;
    const limit = this.manager.maxConcurrentSubagents ?? this.manager.maxConcurrent;
    if (limit != null && running >= limit) {
      return (
        `Cannot spawn subagent: concurrency limit reached (${running}/${limit} running). ` +
        "Wait for a running subagent to complete before spawning a new one."
      );
    }
    return String(
      await this.manager.spawn({
        task: params.task,
        label: params.label,
        originChannel,
        originChatId,
        sessionKey,
        originMessageId,
        temperature: params.temperature,
      }),
    );
  }
}
