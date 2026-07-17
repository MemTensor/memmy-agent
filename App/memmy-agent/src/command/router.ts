import { InboundMessage, OutboundMessage } from "../core/runtime-messages/events.js";

export class CommandContext {
  msg: InboundMessage;
  session: any | null;
  key: string;
  raw: string;
  args: string;
  loop: any;
  metadata: Record<string, any>;
  text: string;
  abortSignal: AbortSignal | null;

  constructor(init: {
    msg?: InboundMessage;
    session?: any | null;
    key?: string;
    raw?: string;
    args?: string;
    loop?: any;
    text?: string;
    metadata?: Record<string, any>;
    abortSignal?: AbortSignal | null;
  } = {}) {
    this.msg = init.msg ?? new InboundMessage({ channel: "", chatId: "", content: init.text ?? init.raw ?? "" });
    this.session = init.session ?? null;
    this.key = init.key ?? this.msg.sessionKey;
    this.raw = init.raw ?? init.text ?? this.msg.content;
    this.args = init.args ?? "";
    this.loop = init.loop;
    this.metadata = init.metadata ?? this.msg.metadata ?? {};
    this.text = init.text ?? this.raw;
    this.abortSignal = init.abortSignal ?? null;
  }
}

export type CommandHandler = (ctx: CommandContext) => OutboundMessage | Promise<OutboundMessage | null> | null;

function norm(text: string): string {
  return text.trim().toLowerCase();
}

function normPrefix(text: string): string {
  return text.toLowerCase();
}

export class CommandRouter {
  priorityHandlers = new Map<string, CommandHandler>();
  exactHandlers = new Map<string, CommandHandler>();
  prefixHandlers: Array<[string, CommandHandler]> = [];

  priority(cmd: string, handler: CommandHandler): void {
    this.priorityHandlers.set(norm(cmd), handler);
  }

  exact(cmd: string, handler: CommandHandler): void {
    this.exactHandlers.set(norm(cmd), handler);
  }

  prefix(prefix: string, handler: CommandHandler): void {
    this.prefixHandlers.push([normPrefix(prefix), handler]);
    this.prefixHandlers.sort((a, b) => b[0].length - a[0].length);
  }

  register(name: string, handler: CommandHandler, { prefix = false, priority = 0 }: { prefix?: boolean; priority?: number } = {}): void {
    if (priority > 0) this.priority(name, handler);
    else if (prefix) this.prefix(name, handler);
    else this.exact(name, handler);
  }

  isPriority(text: string): boolean {
    return this.priorityHandlers.has(norm(text));
  }

  isDispatchableCommand(text: string): boolean {
    const cmd = norm(text);
    if (this.exactHandlers.has(cmd)) return true;
    return this.prefixHandlers.some(([pfx]) => cmd.startsWith(pfx));
  }

  async dispatchPriority(ctx: CommandContext): Promise<OutboundMessage | null> {
    const handler = this.priorityHandlers.get(norm(ctx.raw));
    return handler ? await handler(ctx) : null;
  }

  async dispatch(ctxOrText: CommandContext | string, metadata: Record<string, any> = {}): Promise<OutboundMessage | null> {
    const ctx = typeof ctxOrText === "string" ? new CommandContext({ text: ctxOrText, metadata }) : ctxOrText;
    const cmd = norm(ctx.raw);
    const exact = this.exactHandlers.get(cmd);
    if (exact) return exact(ctx);
    for (const [pfx, handler] of this.prefixHandlers) {
      if (cmd.startsWith(pfx)) {
        ctx.args = ctx.raw.trim().slice(pfx.length);
        return handler(ctx);
      }
    }
    return null;
  }
}
