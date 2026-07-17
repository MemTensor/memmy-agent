export type SystemPromptSection = {
  id: string;
  content: string;
  title?: string;
  source?: string;
  metadata?: Record<string, any>;
};

export type SystemPromptSectionPlacement = {
  before?: string;
  after?: string;
};

export class SystemPromptBuildContext {
  sections: SystemPromptSection[];
  skillNames: string[] | null;
  channel: string | null;
  sessionSummary: string | null;
  workspace: string | null;
  metadata: Record<string, any>;

  constructor(init: {
    sections?: SystemPromptSection[];
    skillNames?: string[] | null;
    channel?: string | null;
    sessionSummary?: string | null;
    workspace?: string | null;
    metadata?: Record<string, any>;
  } = {}) {
    this.sections = [...(init.sections ?? [])];
    this.skillNames = init.skillNames ? [...init.skillNames] : null;
    this.channel = init.channel ?? null;
    this.sessionSummary = init.sessionSummary ?? null;
    this.workspace = init.workspace ?? null;
    this.metadata = init.metadata ?? {};
  }

  getSection(id: string): SystemPromptSection | null {
    return this.sections.find((section) => section.id === id) ?? null;
  }

  removeSection(id: string): SystemPromptSection | null {
    const index = this.sections.findIndex((section) => section.id === id);
    if (index < 0) return null;
    return this.sections.splice(index, 1)[0] ?? null;
  }

  upsertSection(section: SystemPromptSection, placement: SystemPromptSectionPlacement = {}): void {
    const next = { ...section };
    const existingIndex = this.sections.findIndex((item) => item.id === next.id);
    if (existingIndex >= 0) this.sections.splice(existingIndex, 1);

    let insertIndex = existingIndex >= 0 ? Math.min(existingIndex, this.sections.length) : this.sections.length;
    if (placement.before) {
      const beforeIndex = this.sections.findIndex((item) => item.id === placement.before);
      if (beforeIndex >= 0) insertIndex = beforeIndex;
    } else if (placement.after) {
      const afterIndex = this.sections.findIndex((item) => item.id === placement.after);
      if (afterIndex >= 0) insertIndex = afterIndex + 1;
    }
    this.sections.splice(insertIndex, 0, next);
  }

  render(separator = "\n\n---\n\n"): string {
    return this.sections
      .map((section) => section.content)
      .filter(Boolean)
      .join(separator);
  }
}

export type AgentToolRegistrationContext = {
  registry: any;
  toolContext?: any;
  workspace?: string | null;
  metadata: Record<string, any>;
};

export class AgentHookContext {
  spec?: any;
  sessionKey?: string | null;
  session?: any;
  reason?: string | null;
  compaction?: Record<string, any> | null;
  subagent?: Record<string, any> | null;
  messages: Record<string, any>[];
  iteration?: number;
  response?: any;
  toolCalls?: any[];
  toolResults?: any[];
  toolEvents?: Record<string, any>[];
  streamedContent?: boolean;
  streamedReasoning?: boolean;
  finalContent?: string | null;
  stopReason?: string | null;
  error?: string | null;
  usage?: Record<string, any>;
  metadata: Record<string, any>;
  constructor(init: Partial<AgentHookContext> = {}) {
    Object.assign(this, init);
    this.sessionKey = init.sessionKey ?? null;
    this.session = init.session ?? null;
    this.reason = init.reason ?? null;
    this.compaction = init.compaction ?? null;
    this.subagent = init.subagent ?? null;
    this.iteration = init.iteration ?? 0;
    this.messages = init.messages ?? [];
    this.response = init.response ?? null;
    this.toolCalls = init.toolCalls ?? [];
    this.toolResults = init.toolResults ?? [];
    this.toolEvents = init.toolEvents ?? [];
    this.streamedContent = init.streamedContent ?? false;
    this.streamedReasoning = init.streamedReasoning ?? false;
    this.finalContent = init.finalContent ?? null;
    this.stopReason = init.stopReason ?? null;
    this.error = init.error ?? null;
    this.usage = init.usage ?? {};
    this.metadata = init.metadata ?? {};
  }
}

export class AgentHook {
  reraise: boolean;

  constructor(reraise = false) {
    this.reraise = reraise;
  }

  wantsStreaming(): boolean {
    return false;
  }

  async beforeIteration(ctx: AgentHookContext): Promise<void> {}
  async onStream(ctx: AgentHookContext, delta: string): Promise<void> {}
  async onStreamEnd(ctx: AgentHookContext, opts: { resuming?: boolean } = {}): Promise<void> {}
  async beforeExecuteTools(ctx: AgentHookContext): Promise<void> {}
  async emitReasoning(reasoningContent?: string | null): Promise<void> {}
  async emitReasoningEnd(): Promise<void> {}
  finalizeContent(ctx: AgentHookContext, content: string | null): string | null {
    return content;
  }
  onRegisterTools(ctx: AgentToolRegistrationContext): void {}
  onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {}
  async beforeRun(ctx: AgentHookContext): Promise<void> {}
  async afterRun(ctx: AgentHookContext, result: any): Promise<void> {}
  async beforeToolCall(ctx: AgentHookContext, toolCall: any): Promise<void> {}
  async afterToolCall(ctx: AgentHookContext, toolCall: any, result: any): Promise<void> {}
  async afterIteration(ctx: AgentHookContext): Promise<void> {}
  async sessionStart(ctx: AgentHookContext): Promise<void> {}
  async sessionEnd(ctx: AgentHookContext): Promise<void> {}
  async beforeCompaction(ctx: AgentHookContext): Promise<void> {}
  async afterCompaction(ctx: AgentHookContext): Promise<void> {}
  async subagentStart(ctx: AgentHookContext): Promise<void> {}
  async subagentStop(ctx: AgentHookContext): Promise<void> {}
}

export class CompositeHook extends AgentHook {
  hooks: AgentHook[];

  constructor(hooks: AgentHook[] = []) {
    super();
    this.hooks = [...hooks];
  }

  override wantsStreaming(): boolean {
    return this.hooks.some((hook) => hook.wantsStreaming());
  }

  async forEachHookSafe(methodName: string, ...args: any[]): Promise<void> {
    for (const hook of this.hooks) {
      try {
        const fn = (hook as any)[methodName];
        if (typeof fn !== "function") continue;
        await fn.apply(hook, args);
      } catch (error) {
        if (hook.reraise) throw error;
        console.error(`AgentHook.${methodName} error in ${hook.constructor.name}:`, error);
      }
    }
  }

  forEachHookSyncSafe(methodName: string, ...args: any[]): void {
    for (const hook of this.hooks) {
      try {
        const fn = (hook as any)[methodName];
        if (typeof fn !== "function") continue;
        fn.apply(hook, args);
      } catch (error) {
        if (hook.reraise) throw error;
        console.error(`AgentHook.${methodName} error in ${hook.constructor.name}:`, error);
      }
    }
  }

  override async beforeRun(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("beforeRun", ctx);
  }
  override async beforeIteration(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("beforeIteration", ctx);
  }
  override async onStream(ctx: AgentHookContext, delta: string): Promise<void> {
    await this.forEachHookSafe("onStream", ctx, delta);
  }
  override async onStreamEnd(ctx: AgentHookContext, opts: { resuming?: boolean } = {}): Promise<void> {
    await this.forEachHookSafe("onStreamEnd", ctx, opts);
  }
  override async beforeExecuteTools(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("beforeExecuteTools", ctx);
  }
  override async emitReasoning(reasoningContent?: string | null): Promise<void> {
    await this.forEachHookSafe("emitReasoning", reasoningContent);
  }
  override async emitReasoningEnd(): Promise<void> {
    await this.forEachHookSafe("emitReasoningEnd");
  }
  override finalizeContent(ctx: AgentHookContext, content: string | null): string | null {
    let next = content;
    for (const hook of this.hooks) next = hook.finalizeContent(ctx, next);
    return next;
  }
  override onRegisterTools(ctx: AgentToolRegistrationContext): void {
    this.forEachHookSyncSafe("onRegisterTools", ctx);
  }
  override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
    this.forEachHookSyncSafe("onBuildSystemPrompt", ctx);
  }
  override async afterRun(ctx: AgentHookContext, result: any): Promise<void> {
    await this.forEachHookSafe("afterRun", ctx, result);
  }
  override async beforeToolCall(ctx: AgentHookContext, toolCall: any): Promise<void> {
    await this.forEachHookSafe("beforeToolCall", ctx, toolCall);
  }
  override async afterToolCall(ctx: AgentHookContext, toolCall: any, result: any): Promise<void> {
    await this.forEachHookSafe("afterToolCall", ctx, toolCall, result);
  }
  override async afterIteration(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("afterIteration", ctx);
  }
  override async sessionStart(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("sessionStart", ctx);
  }
  override async sessionEnd(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("sessionEnd", ctx);
  }
  override async beforeCompaction(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("beforeCompaction", ctx);
  }
  override async afterCompaction(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("afterCompaction", ctx);
  }
  override async subagentStart(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("subagentStart", ctx);
  }
  override async subagentStop(ctx: AgentHookContext): Promise<void> {
    await this.forEachHookSafe("subagentStop", ctx);
  }
}

export class CompositeAgentHook extends CompositeHook {}

export class SDKCaptureHook extends AgentHook {
  toolsUsed: string[] = [];
  messages: Record<string, any>[] = [];

  override async afterIteration(ctx: AgentHookContext): Promise<void> {
    for (const call of ctx.toolCalls ?? []) {
      const name = call?.name ?? call?.function?.name;
      if (name) this.toolsUsed.push(String(name));
    }
    if (ctx.messages) this.messages = ctx.messages.map((message) => ({ ...message }));
  }

  override async afterRun(ctx: AgentHookContext, result: any): Promise<void> {
    const tools = result?.toolsUsed ?? [];
    if (Array.isArray(tools) && tools.length) this.toolsUsed.push(...tools.map(String));
    if (Array.isArray(result?.messages)) this.messages = result.messages.map((message: Record<string, any>) => ({ ...message }));
  }
}
