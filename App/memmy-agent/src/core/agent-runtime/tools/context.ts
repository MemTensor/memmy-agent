import { AsyncLocalStorage } from "node:async_hooks";

export class RequestContext {
  channel?: string | null;
  chatId?: string | null;
  senderId?: string | null;
  workspace?: string | null;
  messageId?: string | null;
  sessionKey?: string | null;
  metadata: Record<string, any>;

  constructor(init: Partial<RequestContext> = {}) {
    Object.assign(this, init);
    this.chatId = init.chatId ?? null;
    this.senderId = init.senderId ?? null;
    this.messageId = init.messageId ?? null;
    this.sessionKey = init.sessionKey ?? null;
    this.metadata = init.metadata ?? {};
  }
}

export interface ContextAware {
  setContext?: (ctx: RequestContext) => void;
}

export function isContextAware(value: any): value is ContextAware {
  return Boolean(
    value &&
      typeof value.setContext === "function",
  );
}

export class ToolContext extends RequestContext {
  config?: any;
  registry?: any;
  session?: any;
  bus?: any;
  subagentManager?: any;
  cronService?: any;
  sessions?: any;
  fileStateStore?: any;
  messageSendCallback?: any;
  providerSnapshotLoader?: (() => any) | null;
  execSessionManager?: any;
  timezone: string;

  constructor(init: Partial<ToolContext> = {}) {
    super(init);
    Object.assign(this, init);
    this.subagentManager = init.subagentManager;
    this.cronService = init.cronService;
    this.fileStateStore = init.fileStateStore;
    this.providerSnapshotLoader = init.providerSnapshotLoader ?? null;
    this.execSessionManager = init.execSessionManager;
    this.timezone = init.timezone ?? "UTC";
  }
}

export class RequestContextStore {
  private readonly storage = new AsyncLocalStorage<RequestContext | null>();
  private fallback: RequestContext | null = null;

  set(ctx: RequestContext | null): void {
    this.fallback = ctx;
    this.storage.enterWith(ctx);
  }

  get(): RequestContext | null {
    return this.storage.getStore() ?? this.fallback;
  }

  clear(): void {
    this.fallback = null;
    this.storage.enterWith(null);
  }
}
