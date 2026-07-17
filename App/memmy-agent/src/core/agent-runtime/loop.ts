import path from "node:path";
import { AsyncQueue, MessageBus, OutboundMessage, InboundMessage } from "../runtime-messages/index.js";
import { CommandContext, CommandRouter } from "../../command/router.js";
import { registerBuiltinCommands } from "../../command/builtin.js";
import { Config, ModelPresetConfig } from "../../config/schema.js";
import { getWorkspacePath } from "../../config/paths.js";
import { CronService } from "../../cron/service.js";
import { makeProvider } from "../../providers/factory.js";
import { makeReloadingProviderSnapshotLoader, makeReloadingToolsSnapshotLoader } from "../../providers/snapshot-loader.js";
import { Session, SessionManager } from "../session/manager.js";
import { goalStateRuntimeLines, runnerWallLlmTimeoutS, sustainedGoalActive } from "../session/goal-state.js";
import { finishWebuiTurn, markWebuiSession, publishTurnRunStatus, publishWebuiThreadSessionUpdated, shouldPublishWebuiRunStatus, WEBUI_LANGUAGE_METADATA_KEY } from "../session/webui-turns.js";
import { extractDocuments } from "../../utils/document.js";
import { imageGenerationPrompt } from "../../utils/image-generation-intent.js";
import { LLMRuntime } from "../../utils/llm-runtime.js";
import { withProgressCapabilities } from "../../utils/progress-events.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE, SUSTAINED_GOAL_CONTINUE_PROMPT } from "../../utils/runtime.js";
import { AgentRunner, AgentRunSpec } from "./runner.js";
import { resolveToolResultMaxChars, SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME } from "./tool-result-budget.js";
import { AgentProgressHook } from "./progress-hook.js";
import { createTurnCancellationBoundary, type TurnCancellationBoundary } from "./turn-cancellation-boundary.js";
import { ToolLoader } from "./tools/loader.js";
import { RequestContext, ToolContext } from "./tools/context.js";
import { ExecSessionManager } from "./tools/exec-session.js";
import { MessageTool, type MessageSendCallback } from "./tools/message.js";
import { MyTool } from "./tools/self.js";
import { FileStateStore } from "./tools/file-state.js";
import { connectMissingServers, runtimeLines as mcpRuntimeLines, sessionExtra as mcpSessionExtra } from "./tools/mcp.js";
import { ContextBuilder } from "./context.js";
import { Consolidator, Dream, type TokenCompactionStatus } from "./memory.js";
import { AgentHook, AgentHookContext, CompositeAgentHook } from "./hook.js";
import { SubagentManager } from "./subagent.js";
import { AutoCompact } from "./autocompact.js";
import { configuredModelPresets, defaultSelectionSignature, makePresetSnapshotLoader, normalizePresetName } from "./model-presets.js";
import { installMemmyMemory } from "../../memmy-memory/index.js";
import { createByokTokenUsageRecorder, installByokTokenUsage } from "../../integrations/byok-token-usage/index.js";
import { SessionDagQueueManager, SessionDagUsageReporter, type DagTurnInput } from "../../session-dag/index.js";

export const UNIFIED_SESSION_KEY = "unified:default";
type ToolRegistryInstance = ReturnType<ToolLoader["loadRegistry"]>;

export enum TurnState {
  RESTORE = "restore",
  COMPACT = "compact",
  COMMAND = "command",
  BUILD = "build",
  RUN = "run",
  SAVE = "save",
  RESPOND = "respond",
  DONE = "done",
}

export class StateTraceEntry {
  state: TurnState;
  startedAt: number;
  durationMs: number;
  event: string;
  error: string | null;

  constructor(init: { state: TurnState; startedAt?: number; durationMs?: number; event: string; error?: string | null }) {
    this.state = init.state;
    this.startedAt = init.startedAt ?? Date.now() / 1000;
    this.durationMs = init.durationMs ?? 0;
    this.event = init.event;
    this.error = init.error ?? null;
  }
}

export class TurnContext {
  msg: InboundMessage;
  sessionKey: string;
  state: TurnState;
  turnId: string;
  session: Session | null;
  history: Record<string, any>[] = [];
  initialMessages: Record<string, any>[] = [];
  finalContent: string | null = null;
  finalContentStreamed = false;
  toolsUsed: string[] = [];
  allMessages: Record<string, any>[] = [];
  stopReason = "";
  hadInjections = false;
  userPersistedEarly = false;
  saveSkip = 0;
  outbound: OutboundMessage | null = null;
  onProgress: any = null;
  onStream: any = null;
  onStreamEnd: any = null;
  onRetryWait: any = null;
  pendingQueue: AsyncQueue<InboundMessage> | null = null;
  pendingSummary: string | null = null;
  abortSignal: AbortSignal | null = null;
  boundary: TurnCancellationBoundary | null = null;
  turnWallStartedAt: number;
  turnLatencyMs: number | null = null;
  trace: StateTraceEntry[] = [];
  tools: ToolRegistryInstance | null = null;
  messageSendCallback: MessageSendCallback | null = null;

  constructor(init: { msg: InboundMessage; sessionKey?: string; state?: TurnState; turnId?: string; session?: Session | null }) {
    this.msg = init.msg;
    this.sessionKey = init.sessionKey ?? init.msg.sessionKey;
    this.state = init.state ?? TurnState.RESTORE;
    this.turnId = init.turnId ?? cryptoRandomId();
    this.session = init.session ?? null;
    this.turnWallStartedAt = Date.now() / 1000;
  }
}

type AgentLoopInit = {
  bus?: MessageBus;
  config?: Config;
  provider?: any;
  workspace?: string;
  model?: string | null;
  sessionDir?: string;
  sessionManager?: SessionManager;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextBlockLimit?: number | null;
  providerRetryMode?: string;
  toolHintMaxLength?: number;
  maxToolResultChars?: number;
  maxMessages?: number;
  unifiedSession?: boolean;
  timezone?: string | null;
  consolidationRatio?: number;
  sessionTtlMinutes?: number;
  modelPresets?: Record<string, ModelPresetConfig | Record<string, any>>;
  modelPreset?: string | null;
  providerSnapshotLoader?: ((opts?: any) => any) | null;
  toolsSnapshotLoader?: (() => any) | null;
  presetSnapshotLoader?: ((name: string) => any) | null;
  providerSignature?: any[] | string | null;
  runtimeModelPublisher?: ((model: string | null, modelPreset?: string | null) => void) | null;
  mcpServers?: Record<string, any>;
  cronService?: CronService;
  hooks?: AgentHook[];
  sessionDagQueue?: SessionDagQueueManager | null;
};

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function stripRuntimeContext(content: string): string {
  const pos = content.indexOf(ContextBuilder.RUNTIME_CONTEXT_TAG);
  return pos >= 0 ? content.slice(0, pos).trimEnd() : content;
}

const PLATFORM_API_ERROR_FALLBACK_ZH = "平台服务响应异常，请稍后重试。";
const PLATFORM_API_ERROR_FALLBACK_EN = "The platform service returned an unexpected response. Please try again later.";
const USER_FACING_API_ERROR_PATTERNS = [
  /\bAPI returned empty choices\b/i,
  /^Error calling LLM:/i,
  /\bAPI\b/i,
];

function usesChineseWebuiLanguage(language: any): boolean {
  return String(language ?? "").toLowerCase().startsWith("zh");
}

function platformApiErrorFallback(language: any): string {
  return usesChineseWebuiLanguage(language)
    ? PLATFORM_API_ERROR_FALLBACK_ZH
    : PLATFORM_API_ERROR_FALLBACK_EN;
}

const QUOTA_API_ERROR_FALLBACK_ZH = "当前账号的模型 Token 额度已用完，请充值或更换模型后重试。";
const QUOTA_API_ERROR_FALLBACK_EN = "Your model token quota has been used up. Please top up or switch models, then try again.";
const QUOTA_API_ERROR_PATTERNS = [
  /quota[\s_]*(exceeded|exhausted)/i,
  /insufficient[\s_]*quota/i,
  /REQUEST_TOKEN_QUOTA_EXCEEDED/i,
  /out of quota/i,
  /额度.*(用完|不足|超限)/,
];

function isQuotaApiError(content: string | null | undefined): boolean {
  const text = String(content ?? "");
  return QUOTA_API_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function userFacingApiErrorFallback(language: any, content: string | null | undefined): string {
  if (isQuotaApiError(content)) {
    return usesChineseWebuiLanguage(language) ? QUOTA_API_ERROR_FALLBACK_ZH : QUOTA_API_ERROR_FALLBACK_EN;
  }
  return platformApiErrorFallback(language);
}

function isUserFacingApiError(content: string | null | undefined, stopReason: string): boolean {
  if (stopReason !== "error") return false;
  const text = String(content ?? "").trim();
  if (!text) return false;
  return USER_FACING_API_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function isWebuiVisible(channel: string, metadata?: Record<string, any> | null): boolean {
  return channel === "websocket" || metadata?.webui === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function firstString(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function turnMetadata(turnId: string | null | undefined): Record<string, string> {
  return turnId ? { turnId, turn_id: turnId } : {};
}

function isTestRuntime(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "test" || Boolean(env.VITEST_WORKER_ID);
}

function messageText(message: Record<string, any>): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => block && typeof block === "object" && block.type === "text" ? String(block.text ?? "") : "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function firstMessageText(messages: Record<string, any>[], role: string): string {
  for (const message of messages) {
    if (message.role !== role) continue;
    const text = messageText(message);
    if (text) return truncateText(text, 2000);
  }
  return "";
}

function lastMessageText(messages: Record<string, any>[], role: string): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== role) continue;
    const text = messageText(messages[i]);
    if (text) return truncateText(text, 2000);
  }
  return "";
}

function sameSignature(left: any, right: any): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function normalizeUsageRecord(usage: Record<string, any> | null | undefined): Record<string, any> {
  const out = { ...(usage ?? {}) };
  out.prompt_tokens = Number(out.prompt_tokens ?? 0);
  out.completion_tokens = Number(out.completion_tokens ?? 0);
  return out;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

type CancelableDispatchTask = Promise<void> & {
  cancel: () => boolean;
  done: () => boolean;
  cancelled: () => boolean;
  signal: AbortSignal;
  settled: boolean;
};

type CancelActiveTasksOptions = {
  excludeSignal?: AbortSignal | null;
};

function makeCancelableDispatchTask(run: (isCancelled: () => boolean, signal: AbortSignal) => Promise<void>): CancelableDispatchTask {
  const controller = new AbortController();
  const state = { cancelled: false, settled: false };
  const task = (async () => {
    try {
      if (!state.cancelled) await run(() => state.cancelled || controller.signal.aborted, controller.signal);
    } finally {
      state.settled = true;
    }
  })() as CancelableDispatchTask;
  Object.defineProperty(task, "settled", { get: () => state.settled });
  task.signal = controller.signal;
  task.cancel = () => {
    if (state.settled) return false;
    state.cancelled = true;
    if (!controller.signal.aborted) controller.abort();
    return true;
  };
  task.done = () => state.settled;
  task.cancelled = () => state.cancelled || controller.signal.aborted;
  return task;
}

function createTaskCancelledError(): Error {
  const error = new Error("task cancelled");
  error.name = "TaskCancelledError";
  return error;
}

function isTaskCancelledError(error: unknown): boolean {
  return error instanceof Error && error.name === "TaskCancelledError";
}

export class AgentLoop {
  bus: MessageBus;
  config: Config;
  toolsConfig: Config["tools"];
  webConfig: any;
  execConfig: any;
  provider: any;
  workspace: string;
  model: string | null;
  modelPresets: Record<string, ModelPresetConfig>;
  private defaultModelPreset: ModelPresetConfig;
  sessions: SessionManager;
  cronService: CronService;
  execSessionManager: ExecSessionManager;
  fileStateStore: FileStateStore;
  subagents: SubagentManager;
  runner: AgentRunner;
  context: ContextBuilder;
  tools: ReturnType<ToolLoader["loadRegistry"]>;
  commands: CommandRouter;
  consolidator: Consolidator;
  sessionDagQueue: SessionDagQueueManager | null;
  autoCompact: AutoCompact;
  dream: Dream;
  maxIterations: number;
  contextWindowTokens: number;
  contextBlockLimit: number | null;
  providerRetryMode: string;
  toolHintMaxLength: number;
  maxToolResultChars: number;
  maxMessages: number;
  unifiedSession: boolean;
  backgroundTasks: Array<Promise<any>> = [];
  extraHooks: AgentHook[] = [];
  startTime: number;
  lastUsage: Record<string, number>;
  activeTasks: Map<string, any[]>;
  pendingQueues: Map<string, AsyncQueue<InboundMessage>>;
  sessionLocks: Map<string, AsyncMutex>;
  running: boolean;
  currentIterationValue = 0;
  providerSignature: any[] | string | null = null;
  providerSnapshotLoader: ((opts?: any) => any) | null = null;
  toolsSnapshotLoader: (() => any) | null = null;
  presetSnapshotLoader: ((name: string) => any) | null = null;
  runtimeModelPublisher: ((model: string | null, modelPreset?: string | null) => void) | null = null;
  private activePresetValue: string | null = null;
  defaultSelectionSignature: any[] | null = null;
  mcpServers: Record<string, any>;
  mcpStacks: Record<string, any>;
  mcpConnected: boolean;
  mcpConnecting: boolean;
  subagentPendingWaitMs = 300_000;
  static readonly RUNTIME_CHECKPOINT_KEY = "runtimeCheckpoint";
  static readonly PENDING_USER_TURN_KEY = "pendingUserTurn";

  constructor(init: AgentLoopInit = {}) {
    this.startTime = Date.now() / 1000;
    this.lastUsage = {};
    this.activeTasks = new Map();
    this.pendingQueues = new Map();
    this.sessionLocks = new Map();
    this.running = false;
    this.providerSnapshotLoader = init.providerSnapshotLoader ?? null;
    this.toolsSnapshotLoader = init.toolsSnapshotLoader ?? null;
    this.presetSnapshotLoader = init.presetSnapshotLoader ?? null;
    this.providerSignature = init.providerSignature ?? null;
    this.defaultSelectionSignature = defaultSelectionSignature(Array.isArray(this.providerSignature) ? this.providerSignature : null);
    this.runtimeModelPublisher = init.runtimeModelPublisher ?? null;
    this.extraHooks = [...(init.hooks ?? [])];
    this.bus = init.bus ?? new MessageBus();
    const initConfig = init.config ?? new Config();
    this.config = new Config(initConfig.toObject());
    this.mcpServers = init.mcpServers ?? this.config.tools.mcpServers ?? {};
    this.mcpStacks = {};
    this.mcpConnected = false;
    this.mcpConnecting = false;
    this.toolsConfig = this.config.tools;
    this.webConfig = { search: this.config.tools.webSearch, fetch: this.config.tools.webFetch };
    this.execConfig = (this.config.tools as any).exec ?? {};
    const defaults = this.config.agents.defaults;
    this.workspace = path.resolve(getWorkspacePath(init.workspace ?? defaults.workspace ?? process.cwd()));
    installMemmyMemory(this.config, { workspace: this.workspace, hooks: this.extraHooks });
    installByokTokenUsage(this.config, { hooks: this.extraHooks });
    this.provider = init.provider ?? makeProvider(this.config);
    this.model = init.model ?? defaults.model ?? this.provider?.model ?? null;
    this.maxIterations = init.maxIterations ?? defaults.maxToolIterations;
    this.contextWindowTokens = init.contextWindowTokens ?? defaults.contextWindowTokens;
    this.contextBlockLimit = init.contextBlockLimit ?? defaults.contextBlockLimit;
    this.providerRetryMode = init.providerRetryMode ?? defaults.providerRetryMode;
    this.toolHintMaxLength = init.toolHintMaxLength ?? defaults.toolHintMaxLength;
    this.maxToolResultChars = init.maxToolResultChars ?? defaults.maxToolResultChars;
    const requestedMaxMessages = init.maxMessages ?? defaults.maxMessages;
    const normalizedMaxMessages = requestedMaxMessages > 0 ? requestedMaxMessages : 120;
    this.maxMessages = normalizedMaxMessages;
    this.defaultModelPreset = new ModelPresetConfig({
      model: this.model ?? this.provider?.getDefaultModel?.() ?? this.provider?.getDefaultModel?.() ?? defaults.model,
      provider: defaults.provider,
      maxTokens: this.provider?.generation?.maxTokens ?? defaults.maxTokens,
      contextWindowTokens: this.contextWindowTokens,
      temperature: this.provider?.generation?.temperature ?? defaults.temperature,
      reasoningEffort: this.provider?.generation?.reasoningEffort ?? defaults.reasoningEffort,
    });
    const rawPresets = init.modelPresets ?? this.config.modelPresets;
    this.modelPresets = Object.fromEntries(Object.entries(rawPresets).map(([name, preset]) => [name, preset instanceof ModelPresetConfig ? preset : new ModelPresetConfig(preset)]));
    this.unifiedSession = init.unifiedSession ?? defaults.unifiedSession;
    this.sessions = init.sessionManager ?? new SessionManager(init.sessionDir ?? path.join(this.workspace, "sessions"));
    this.cronService = init.cronService ?? new CronService(path.join(this.workspace, "cron", "jobs.json"));
    this.sessionDagQueue = init.sessionDagQueue ?? this.createSessionDagQueue();
    this.execSessionManager = new ExecSessionManager();
    this.fileStateStore = new FileStateStore();
    this.subagents = new SubagentManager({
      provider: this.provider,
      workspace: this.workspace,
      bus: this.bus,
      model: this.model,
      toolsConfig: this.config.tools,
      maxIterations: this.maxIterations,
      maxConcurrent: defaults.maxConcurrentSubagents,
      maxToolResultChars: this.maxToolResultChars,
      llmWallTimeoutForSession: (sessionKey) => runnerWallLlmTimeoutS(this.sessions, sessionKey),
      lifecycleHook: () => this.lifecycleHook(),
    });
    this.context = new ContextBuilder({
      workspace: this.workspace,
      timezone: init.timezone ?? defaults.timezone,
    });
    this.runner = new AgentRunner();
    this.tools = this.createToolRegistry("init");
    this.commands = new CommandRouter();
    registerBuiltinCommands(this.commands);
    this.consolidator = new Consolidator({
      store: this.context.memory,
      provider: this.provider,
      model: this.model ?? "",
      sessions: this.sessions,
      contextWindowTokens: this.contextWindowTokens,
      buildMessages: (args: any) => this.context.buildMessages({ ...(args ?? {}), hook: args?.hook ?? this.lifecycleHook() }),
      getToolDefinitions: () => this.tools.getDefinitions(),
      maxCompletionTokens: this.provider?.generation?.maxTokens ?? defaults.maxTokens,
      consolidationRatio: init.consolidationRatio ?? defaults.consolidationRatio,
      unifiedSession: this.unifiedSession,
      lifecycleHook: () => this.lifecycleHook(),
      summaryMode: this.config.contextCompaction.summaryMode,
      dagQueue: this.sessionDagQueue,
      dagCatchupTimeoutMs: this.config.sessionDag.compactionCatchupTimeoutMs,
    });
    this.autoCompact = new AutoCompact(this.sessions, this.consolidator, init.sessionTtlMinutes ?? defaults.sessionTtlMinutes);
    this.dream = new Dream({
      store: this.context.memory,
      provider: this.provider,
      model: this.model ?? "",
    });
    const requestedPreset = init.modelPreset ?? defaults.modelPreset;
    if (requestedPreset) this.setModelPreset(requestedPreset, { publishUpdate: false });
  }

  get currentIteration(): number {
    return this.currentIterationValue;
  }

  get modelPreset(): string | null {
    return this.activePresetValue;
  }

  set modelPreset(name: string | null) {
    if (name == null) {
      this.activePresetValue = null;
      return;
    }
    this.setModelPreset(name);
  }

  get toolNames(): string[] {
    return this.tools.toolNames ?? [];
  }

  llmRuntime(): LLMRuntime {
    this.refreshProviderSnapshot();
    return new LLMRuntime(this.provider, this.model ?? "");
  }

  static fromConfig(config: Config, bus: MessageBus = new MessageBus(), extra: AgentLoopInit = {}): AgentLoop {
    const runtimeConfig = new Config(config.toObject());
    const defaults = runtimeConfig.agents.defaults;
    const provider = extra.provider ?? makeProvider(runtimeConfig);
    const resolved = runtimeConfig.resolvePreset();
    const providerSnapshotLoader = extra.providerSnapshotLoader ?? (extra.provider ? null : makeReloadingProviderSnapshotLoader());
    const toolsSnapshotLoader = extra.toolsSnapshotLoader ?? makeReloadingToolsSnapshotLoader();
    const presetSnapshotLoader = extra.presetSnapshotLoader ?? makePresetSnapshotLoader(runtimeConfig, providerSnapshotLoader);
    return new AgentLoop({
      ...extra,
      config: runtimeConfig,
      bus,
      provider,
      model: extra.model ?? resolved.model,
      contextWindowTokens: extra.contextWindowTokens ?? resolved.contextWindowTokens,
      contextBlockLimit: extra.contextBlockLimit ?? defaults.contextBlockLimit,
      providerRetryMode: extra.providerRetryMode ?? defaults.providerRetryMode,
      toolHintMaxLength: extra.toolHintMaxLength ?? defaults.toolHintMaxLength,
      modelPresets: extra.modelPresets ?? configuredModelPresets(runtimeConfig),
      modelPreset: extra.modelPreset ?? defaults.modelPreset,
      providerSnapshotLoader,
      toolsSnapshotLoader,
      presetSnapshotLoader,
    });
  }

  sessionKey(message: InboundMessage): string {
    return this.effectiveSessionKey(message);
  }

  private createToolContext(messageSendCallback: MessageSendCallback | null = null): ToolContext {
    return new ToolContext({
      config: this.config.tools,
      workspace: this.workspace,
      bus: this.bus,
      subagentManager: this.subagents,
      cronService: this.cronService,
      sessions: this.sessions,
      execSessionManager: this.execSessionManager,
      fileStateStore: this.fileStateStore,
      timezone: this.context.timezone || this.config.agents.defaults.timezone || "UTC",
      runtimeState: this,
      messageSendCallback,
    } as any);
  }

  private createToolRegistry(
    phase: string,
    {
      includeConnectedMcp = false,
      messageSendCallback = null,
    }: { includeConnectedMcp?: boolean; messageSendCallback?: MessageSendCallback | null } = {},
  ): ToolRegistryInstance {
    this.refreshToolsSnapshot();
    const toolCtx = this.createToolContext(messageSendCallback);
    const registry = new ToolLoader({ workspace: this.workspace, ctx: toolCtx }).loadRegistry(toolCtx);
    if (this.config.tools.my.enable && !registry.get("my")) registry.register(new MyTool({ runtime: this as any }));
    if (includeConnectedMcp) this.copyConnectedMcpTools(registry);
    this.registerHookTools(toolCtx, phase, registry);
    return registry;
  }

  private copyConnectedMcpTools(registry: ToolRegistryInstance): void {
    if (!this.tools) return;
    for (const [name, tool] of this.tools) {
      if (String(name).startsWith("mcp_")) registry.register(tool);
    }
  }

  setToolContext(
    channel: string,
    chatId: string,
    messageId: string | null = null,
    metadata: Record<string, any> = {},
    sessionKey: string | null = null,
    tools: ToolRegistryInstance = this.tools,
  ): void {
    const effectiveKey = sessionKey ?? (this.unifiedSession ? UNIFIED_SESSION_KEY : `${channel}:${chatId}`);
    const ctx = new RequestContext({
      channel,
      chatId,
      messageId,
      sessionKey: effectiveKey,
      metadata,
    });
    for (const name of tools.toolNames) {
      const tool: any = tools.get(name);
      if (typeof tool?.setContext === "function") tool.setContext(ctx);
    }
  }

  registerDefaultTools(): void {
    this.tools = this.createToolRegistry("refresh");
  }

  async connectMcp(): Promise<void> {
    await connectMissingServers(this as any, this.tools);
  }

  async closeMcp(): Promise<void> {
    const stacks = this.mcpStacks;
    if (!stacks || typeof stacks !== "object") return;
    for (const stack of Object.values(stacks) as any[]) {
      if (typeof stack?.aclose === "function") await stack.aclose().catch(() => undefined);
      else if (typeof stack?.close === "function") await stack.close().catch(() => undefined);
      else {
        const closers = Array.isArray(stack?.closers) ? stack.closers : [];
        for (const close of closers.reverse()) await close().catch(() => undefined);
      }
    }
    this.mcpStacks = {};
    this.mcpConnected = false;
  }

  effectiveSessionKey(message: InboundMessage): string {
    const override = message.sessionKeyOverride;
    if (this.unifiedSession && !override) return UNIFIED_SESSION_KEY;
    return override ?? message.sessionKey;
  }

  lifecycleHook(): AgentHook {
    return this.extraHooks.length ? new CompositeAgentHook([...this.extraHooks]) : new AgentHook();
  }

  private createSessionDagQueue(): SessionDagQueueManager | null {
    if (!this.config.sessionDag.enabled) return null;
    if (isTestRuntime(process.env)) return null;
    return new SessionDagQueueManager({
      config: this.config.sessionDag,
      sessions: this.sessions,
      provider: () => this.provider,
      model: () => this.model ?? this.provider?.getDefaultModel?.() ?? "",
      usageReporter: new SessionDagUsageReporter(createByokTokenUsageRecorder(this.config)),
    });
  }

  registerHookTools(toolCtx: ToolContext, phase: string, registry: ToolRegistryInstance = this.tools): void {
    this.lifecycleHook().onRegisterTools({
      registry,
      toolContext: toolCtx,
      workspace: this.workspace,
      metadata: { phase },
    });
  }

  async emitSessionStart(session: Session, sessionKey: string, reason = "created"): Promise<void> {
    await this.lifecycleHook().sessionStart(
      new AgentHookContext({
        session,
        sessionKey,
        reason,
        metadata: { lifecycle: "session" },
      }),
    );
  }

  async emitSessionEnd(session: Session | null, sessionKey: string, reason: string): Promise<void> {
    await this.lifecycleHook().sessionEnd(
      new AgentHookContext({
        session,
        sessionKey,
        reason,
        metadata: { lifecycle: "session" },
      }),
    );
  }

  async getOrCreateSession(sessionKey: string, reason = "created"): Promise<Session> {
    const usesDefaultGetOrCreate = this.sessions instanceof SessionManager && this.sessions.getOrCreate === SessionManager.prototype.getOrCreate;
    if (!usesDefaultGetOrCreate) return this.sessions.getOrCreate(sessionKey);
    const getWithInfo = this.sessions.getOrCreateWithInfo;
    if (typeof getWithInfo !== "function") return this.sessions.getOrCreate(sessionKey);
    const { session, created } = getWithInfo.call(this.sessions, sessionKey);
    if (created) await this.emitSessionStart(session, sessionKey, reason);
    return session;
  }

  static runtimeChatId(msg: InboundMessage): string {
    return String(msg.metadata?.contextChatId ?? msg.chatId);
  }

  runtimeChatId(msg: InboundMessage): string {
    return AgentLoop.runtimeChatId(msg);
  }

  replayTokenBudget(): number {
    if (this.contextWindowTokens <= 0) return 0;
    const reserved = Number(this.provider?.generation?.maxTokens ?? 4096);
    const budget = this.contextWindowTokens - Math.max(1, reserved) - 1024;
    return budget > 0 ? budget : Math.max(128, Math.floor(this.contextWindowTokens / 2));
  }

  scheduleBackground(promise: Promise<any>): void {
    this.backgroundTasks.push(promise);
    promise.finally(() => {
      const idx = this.backgroundTasks.indexOf(promise);
      if (idx >= 0) this.backgroundTasks.splice(idx, 1);
    });
  }

  private lockFor(key: string): AsyncMutex {
    let lock = this.sessionLocks.get(key);
    if (!lock) {
      lock = new AsyncMutex();
      this.sessionLocks.set(key, lock);
    }
    return lock;
  }

  isSessionBusy(sessionKey: string): boolean {
    const tasks = this.activeTasks.get(sessionKey) ?? [];
    const hasActiveTask = tasks.some((task) => {
      if (typeof task?.done === "function") return !task.done();
      return true;
    });
    return hasActiveTask || this.pendingQueues.has(sessionKey);
  }

  isSessionGoalActive(sessionKey: string): boolean {
    const session = this.sessions.getOrCreate(sessionKey);
    return sustainedGoalActive(session.metadata);
  }

  isCronTargetBlocked(channel: string, sessionKey: string): boolean {
    if (channel !== "websocket") return false;
    return this.isSessionBusy(sessionKey) || this.isSessionGoalActive(sessionKey);
  }

  async waitForCronTargetAvailable(channel: string, sessionKey: string): Promise<void> {
    if (channel !== "websocket") return;
    while (this.isCronTargetBlocked(channel, sessionKey)) {
      await sleep(50);
    }
  }

  private normalizedPresetName(name: string | null | undefined): string {
    return normalizePresetName(name, { ...this.modelPresets, default: this.defaultModelPreset });
  }

  syncSubagentRuntimeLimits(): void {
    if (this.subagents) (this.subagents as any).maxIterations = this.maxIterations;
  }

  buildModelPresetSnapshot(name: string): Record<string, any> {
    if (this.presetSnapshotLoader) return this.presetSnapshotLoader(name);
    const normalized = this.normalizedPresetName(name);
    const preset = normalized === "default" ? this.defaultModelPreset : this.modelPresets[normalized];
    if (!preset) throw new Error(`modelPreset '${name}' not found`);
    return {
      provider: this.provider,
      model: preset.model,
      contextWindowTokens: preset.contextWindowTokens,
      maxTokens: preset.maxTokens,
      temperature: preset.temperature,
      reasoningEffort: preset.reasoningEffort,
      signature: `${normalized}:${preset.model}:${preset.contextWindowTokens}:${preset.maxTokens}`,
    };
  }

  applyProviderSnapshot(
    snapshot: Record<string, any>,
    {
      publishUpdate = true,
      modelPreset = null,
    }: {
      publishUpdate?: boolean;
      modelPreset?: string | null;
    } = {},
  ): void {
    const provider = snapshot.provider ?? this.provider;
    const model = snapshot.model ?? this.model;
    const contextWindowTokens = snapshot.contextWindowTokens ?? this.contextWindowTokens;
    this.provider = provider;
    this.model = model;
    this.contextWindowTokens = contextWindowTokens;
    if (snapshot.maxTokens != null) {
      const maxTokens = snapshot.maxTokens;
      if (this.provider?.generation) this.provider.generation.maxTokens = maxTokens;
    }
    if (snapshot.temperature != null && this.provider?.generation) this.provider.generation.temperature = snapshot.temperature;
    const reasoningEffort = snapshot.reasoningEffort;
    if (reasoningEffort !== undefined && this.provider?.generation) {
      this.provider.generation.reasoningEffort = reasoningEffort;
    }
    (this.runner as any).provider = provider;
    if (typeof (this.subagents as any)?.setProvider === "function") (this.subagents as any).setProvider(provider, model);
    else if (this.subagents) (this.subagents as any).model = model;
    if (typeof (this.consolidator as any)?.setProvider === "function") (this.consolidator as any).setProvider(provider, model, contextWindowTokens);
    else (this.consolidator as any).model = model;
    if (typeof (this.dream as any)?.setProvider === "function") (this.dream as any).setProvider(provider, model);
    else (this.dream as any).model = model;
    this.providerSignature = snapshot.signature ?? JSON.stringify({ model, contextWindowTokens });
    if (publishUpdate && this.runtimeModelPublisher) this.runtimeModelPublisher(this.model, modelPreset ?? this.modelPreset);
  }

  refreshProviderSnapshot(): void {
    if (!this.providerSnapshotLoader) return;
    let snapshot: any;
    try {
      snapshot = this.providerSnapshotLoader();
    } catch {
      return;
    }
    if (!snapshot || typeof snapshot !== "object") return;
    let defaultSelection = defaultSelectionSignature(snapshot.signature);
    if (this.activePresetValue && (sameSignature(this.defaultSelectionSignature, null) || sameSignature(this.defaultSelectionSignature, defaultSelection))) {
      this.defaultSelectionSignature = defaultSelection;
      try {
        snapshot = this.buildModelPresetSnapshot(this.activePresetValue);
      } catch {
        return;
      }
    } else {
      this.activePresetValue = null;
      this.defaultSelectionSignature = defaultSelection;
    }
    const signature = snapshot.signature ?? JSON.stringify({ model: snapshot.model, contextWindowTokens: snapshot.contextWindowTokens });
    if (sameSignature(signature, this.providerSignature)) return;
    defaultSelection = defaultSelectionSignature(Array.isArray(signature) ? signature : null);
    this.defaultSelectionSignature = defaultSelection;
    this.applyProviderSnapshot({ ...snapshot, signature });
  }

  refreshToolsSnapshot(): void {
    if (!this.toolsSnapshotLoader) return;
    let snapshot: any;
    try {
      snapshot = this.toolsSnapshotLoader();
    } catch {
      return;
    }
    if (!snapshot || typeof snapshot !== "object" || !snapshot.imageGeneration) return;
    this.config.tools.imageGeneration = snapshot.imageGeneration;
    this.toolsConfig = this.config.tools;
  }

  setModelPreset(name: string | null | undefined, opts: { publishUpdate?: boolean } = {}): void {
    const normalized = this.normalizedPresetName(name);
    const snapshot = this.buildModelPresetSnapshot(normalized);
    this.applyProviderSnapshot(snapshot, {
      publishUpdate: opts.publishUpdate ?? true,
      modelPreset: normalized,
    });
    this.activePresetValue = normalized;
  }

  async cancelActiveTasks(key: string, options: CancelActiveTasksOptions = {}): Promise<number> {
    const tasks = this.activeTasks.get(key) ?? [];
    const excludeSignal = options.excludeSignal ?? null;
    const retained = excludeSignal ? tasks.filter((task) => task?.signal === excludeSignal) : [];
    const cancellable = excludeSignal ? tasks.filter((task) => task?.signal !== excludeSignal) : tasks;
    if (retained.length) this.activeTasks.set(key, retained);
    else this.activeTasks.delete(key);
    let cancelled = 0;
    const waits: Promise<unknown>[] = [];

    for (const task of cancellable) {
      if (!task) continue;
      const done = typeof task.done === "function" ? task.done() : Boolean(task.done ?? task.settled);
      let didCancel = false;
      if (!done && typeof task.cancel === "function") {
        didCancel = task.cancel() !== false;
      } else if (!done && typeof task.abort === "function") {
        task.abort();
        didCancel = true;
      }
      if (didCancel) {
        cancelled += 1;
        if (typeof task.then === "function") waits.push(Promise.resolve(task).catch(() => undefined));
      }
    }

    if (waits.length) await Promise.allSettled(waits);
    const subagents = this.subagents as any;
    const subCancelled = subagents?.cancelBySession ? await subagents.cancelBySession(key) : subagents?.cancel_by_session ? await subagents.cancel_by_session(key) : 0;
    return cancelled + Number(subCancelled || 0);
  }

  private async pendingToUserMessage(msg: InboundMessage): Promise<Record<string, any> | null> {
    let content = msg.content;
    let media = msg.media ?? [];
    if (media.length) [content, media] = await extractDocuments(content, media);
    const hasText = typeof content === "string" && content.trim().length > 0;
    if (!hasText && !media.length) return null;
    return { role: "user", content: this.context.buildUserContent(content, media) };
  }

  private async waitForPendingMessage(queue: AsyncQueue<InboundMessage>, timeoutMs: number): Promise<InboundMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const item = queue.getNowait();
      if (item) return item;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return queue.getNowait() ?? null;
  }

  private async drainPendingQueue(queue?: AsyncQueue<InboundMessage> | null, limit = 3, sessionKey?: string | null): Promise<Record<string, any>[]> {
    if (!queue) return [];
    const injections: Record<string, any>[] = [];
    while (injections.length < limit) {
      const msg = queue.getNowait();
      if (!msg) break;
      const userMessage = await this.pendingToUserMessage(msg);
      if (userMessage) injections.push(userMessage);
    }
    if (!injections.length && sessionKey && this.subagents?.getRunningCountBySession?.(sessionKey) > 0) {
      const timeoutMs = Number(this.subagentPendingWaitMs ?? 300_000);
      const msg = await this.waitForPendingMessage(queue, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000);
      const userMessage = msg ? await this.pendingToUserMessage(msg) : null;
      if (userMessage) injections.push(userMessage);
      while (injections.length < limit) {
        const next = queue.getNowait();
        if (!next) break;
        const nextUserMessage = await this.pendingToUserMessage(next);
        if (nextUserMessage) injections.push(nextUserMessage);
      }
    }
    return injections;
  }

  async buildBusProgressCallback(input: TurnContext | InboundMessage): Promise<(...args: any[]) => Promise<void>> {
    const ctx = input instanceof TurnContext ? input : null;
    const msg = ctx?.msg ?? (input as InboundMessage);
    const boundary = ctx?.boundary ?? null;
    const callback = async (content: string, opts: Record<string, any> = {}) => {
      const { toolEvents, fileEditEvents, reasoning, reasoningEnd, ...rest } = opts ?? {};
      const isCancellationTerminalFileEdit =
        Array.isArray(fileEditEvents) &&
        fileEditEvents.length > 0 &&
        fileEditEvents.every((event) => event?.cancellation_terminal === true);
      if (boundary?.shouldEmitLive() === false && !isCancellationTerminalFileEdit) return;
      const metadata: Record<string, any> = {
        ...(msg.metadata ?? {}),
        ...(boundary?.metadata() ?? {}),
        agentProgress: true,
        ...rest,
      };
      if (reasoning) metadata.reasoningDelta = true;
      if (reasoningEnd) metadata.reasoningEnd = true;
      if (toolEvents) metadata.toolEvents = toolEvents;
      if (msg.channel === "websocket" && fileEditEvents) {
        metadata.fileEditEvents = fileEditEvents;
      }
      await this.bus.publishOutbound(
        new OutboundMessage({
          channel: msg.channel,
          chatId: msg.chatId,
          content,
          metadata,
        }),
      );
    };
    return withProgressCapabilities(callback, {
      toolEvents: true,
      reasoning: true,
      fileEditEvents: msg.channel === "websocket",
    });
  }

  private contextCompactionLabel(ctx: TurnContext, status: TokenCompactionStatus): string {
    const language = ctx.msg.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? ctx.session?.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? null;
    const labels: Record<TokenCompactionStatus, { zh: string; en: string }> = {
      running: { zh: "会话压缩中", en: "Summarizing chat context" },
      done: { zh: "压缩已完成", en: "Context summary complete" },
      error: { zh: "压缩失败", en: "Context summary failed" },
    };
    return usesChineseWebuiLanguage(language) ? labels[status].zh : labels[status].en;
  }

  private async publishWebuiContextCompaction(ctx: TurnContext, status: TokenCompactionStatus): Promise<void> {
    if (ctx.msg.channel !== "websocket") return;
    if (ctx.boundary?.shouldEmitLive() === false) return;
    try {
      await this.bus.publishOutbound(
        new OutboundMessage({
          channel: ctx.msg.channel,
          chatId: ctx.msg.chatId,
          content: this.contextCompactionLabel(ctx, status),
          metadata: {
            ...(ctx.msg.metadata ?? {}),
            ...(ctx.boundary?.metadata() ?? turnMetadata(ctx.turnId)),
            contextCompaction: true,
            compactionId: `context-compaction:${ctx.turnId}`,
            compactionStatus: status,
          },
        }),
      );
    } catch {
      // WebUI status is best-effort and must not affect the active turn.
    }
  }

  async buildRetryWaitCallback(msg: InboundMessage): Promise<(content: string) => Promise<void>> {
    return async (content: string) => {
      await this.bus.publishOutbound(
        new OutboundMessage({
          channel: msg.channel,
          chatId: msg.chatId,
          content,
          metadata: { ...(msg.metadata ?? {}), retryWait: true },
        }),
      );
    };
  }

  persistUserMessageEarly(msg: InboundMessage, session: Session, extra: Record<string, any> = {}): boolean {
    const mediaPaths = (msg.media ?? []).filter((item) => typeof item === "string" && item);
    const hasText = typeof msg.content === "string" && msg.content.trim().length > 0;
    if (!hasText && !mediaPaths.length) return false;
    const metadataExtra = {
      ...(mediaPaths.length ? { media: [...mediaPaths] } : {}),
      ...mcpSessionExtra(msg.metadata),
      ...extra,
    };
    session.addMessage("user", typeof msg.content === "string" ? msg.content : "", metadataExtra);
    this.markPendingUserTurn(session);
    this.sessions.save(session);
    return true;
  }

  localizeUserFacingApiError(
    channel: string,
    metadata: Record<string, any> | null | undefined,
    session: Session | null | undefined,
    content: string | null | undefined,
    stopReason: string,
  ): string | null {
    if (!isWebuiVisible(channel, metadata) || !isUserFacingApiError(content, stopReason)) return content ?? null;
    const language = metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? session?.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? null;
    return userFacingApiErrorFallback(language, content);
  }

  buildInitialMessages(msg: InboundMessage, session: Session, history: Record<string, any>[], pendingSummary: string | null): Record<string, any>[] {
    return this.context.buildMessages({
      history,
      currentMessage: imageGenerationPrompt(msg.content, msg.metadata),
      media: msg.media.length ? msg.media : null,
      channel: msg.channel,
      chatId: this.runtimeChatId(msg),
      senderId: msg.senderId,
      sessionSummary: pendingSummary ?? session.metadata?.lastSummary?.text ?? null,
      sessionMetadata: session.metadata,
      responseLanguage: msg.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? session.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? null,
      sessionKey: session.key,
      unifiedSession: this.unifiedSession,
      currentRuntimeLines: [
        ...mcpRuntimeLines(msg, {
          availableServerNames: new Set(Object.keys(this.mcpServers ?? {})),
        }),
      ],
      hook: this.lifecycleHook(),
    });
  }

  private goalContinueMessage(session: Session | null | undefined): string {
    const goalLines = goalStateRuntimeLines(session?.metadata ?? null);
    if (!goalLines.length) return SUSTAINED_GOAL_CONTINUE_PROMPT;
    return "You have an active sustained goal:\n\n" + `${goalLines.join("\n")}\n\n` + "Please continue working toward the objective using your tools, or call complete_goal if the work is truly finished.";
  }

  async dispatchCommandInline(msg: InboundMessage, key: string, raw: string, dispatchFn: (ctx: CommandContext) => Promise<OutboundMessage | null> | OutboundMessage | null): Promise<void> {
    const result = await dispatchFn(new CommandContext({ msg, session: null, key, raw, loop: this }));
    if (result) await this.bus.publishOutbound(result);
  }

  sanitizePersistedBlocks(
    content: Array<Record<string, any>>,
    {
      shouldTruncateText = false,
      dropRuntime = false,
      maxTextChars = this.maxToolResultChars,
    }: { shouldTruncateText?: boolean; dropRuntime?: boolean; maxTextChars?: number } = {},
  ): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        out.push(block);
        continue;
      }
      if (dropRuntime && block.type === "text" && typeof block.text === "string" && block.text.startsWith(ContextBuilder.RUNTIME_CONTEXT_TAG)) {
        continue;
      }
      if (block.type === "image_url" && String(block.image_url?.url ?? "").startsWith("data:image/")) {
        const file = block.meta?.path ? `: ${block.meta.path}` : "";
        out.push({ type: "text", text: `[image${file}]` });
        continue;
      }
      if (block.type === "text" && typeof block.text === "string" && shouldTruncateText) {
        out.push({ ...block, text: truncateText(block.text, maxTextChars) });
        continue;
      }
      out.push(block);
    }
    return out;
  }

  saveTurn(session: Session, messages: Record<string, any>[], skip: number, { turnLatencyMs }: { turnLatencyMs?: number } = {}): void {
    let lastAssistantIdx: number | null = null;
    for (const message of messages.slice(skip)) {
      const entry = { ...message };
      const role = entry.role;
      let content = entry.content;
      if (role === "assistant" && !content && !entry.tool_calls?.length) continue;
      if (role === "tool") {
        const maxChars = resolveToolResultMaxChars(entry.name, this.maxToolResultChars, SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME);
        if (typeof content === "string" && content.length > maxChars) entry.content = truncateText(content, maxChars);
        else if (Array.isArray(content)) {
          const filtered = this.sanitizePersistedBlocks(content, { shouldTruncateText: true, maxTextChars: maxChars });
          if (!filtered.length) continue;
          entry.content = filtered;
        }
      } else if (role === "user") {
        if (typeof content === "string") {
          content = stripRuntimeContext(content);
          if (!content) continue;
          entry.content = content;
        } else if (Array.isArray(content)) {
          const filtered = this.sanitizePersistedBlocks(content, { dropRuntime: true });
          if (!filtered.length) continue;
          entry.content = filtered;
        }
      }
      entry.timestamp ??= new Date().toISOString();
      session.messages.push(entry);
      if (role === "assistant") lastAssistantIdx = session.messages.length - 1;
    }
    if (turnLatencyMs != null && lastAssistantIdx != null) session.messages[lastAssistantIdx].latency_ms = Math.max(0, Math.floor(turnLatencyMs));
    session.updatedAt = new Date().toISOString();
  }

  enqueueSessionDagTurn(session: Session, turnId: string, messageStart: number, messageEnd: number): void {
    if (!this.sessionDagQueue || !this.config.sessionDag.enabled) return;
    if (messageEnd <= messageStart) return;
    const turnMessages = session.messages.slice(messageStart, messageEnd);
    const turn: DagTurnInput = {
      turn_id: turnId,
      message_start: messageStart,
      message_end: messageEnd,
      user_text: firstMessageText(turnMessages, "user"),
      assistant_text: lastMessageText(turnMessages, "assistant"),
    };
    try {
      this.sessionDagQueue.enqueueSavedTurn(session.key, turn);
    } catch (error) {
      console.warn("Session DAG enqueue failed:", error);
    }
  }

  persistSubagentFollowup(session: Session, msg: InboundMessage): boolean {
    if (!msg.content) return false;
    const taskId = msg.metadata?.subagentTaskId ?? null;
    if (taskId && session.messages.some((entry) => entry.injectedEvent === "subagentResult" && entry.subagentTaskId === taskId)) {
      return false;
    }
    session.addMessage("assistant", msg.content, {
      senderId: msg.senderId,
      injectedEvent: "subagentResult",
      ...(taskId ? { subagentTaskId: taskId } : {}),
    });
    return true;
  }

  setRuntimeCheckpoint(session: Session, payload: Record<string, any>): void {
    session.metadata[AgentLoop.RUNTIME_CHECKPOINT_KEY] = payload;
    this.sessions.save(session);
  }

  markPendingUserTurn(session: Session): void {
    session.metadata[AgentLoop.PENDING_USER_TURN_KEY] = true;
  }

  clearPendingUserTurn(session: Session): void {
    delete session.metadata[AgentLoop.PENDING_USER_TURN_KEY];
  }

  clearRuntimeCheckpoint(session: Session): void {
    delete session.metadata[AgentLoop.RUNTIME_CHECKPOINT_KEY];
  }

  static checkpointMessageKey(message: Record<string, any>): any[] {
    return [
      message.role,
      JSON.stringify(message.content ?? null),
      message.tool_call_id ?? null,
      message.name ?? null,
      JSON.stringify(message.tool_calls ?? null),
      message.reasoning_content ?? null,
      JSON.stringify(message.thinking_blocks ?? null),
    ];
  }

  checkpointMessageKey(message: Record<string, any>): any[] {
    return AgentLoop.checkpointMessageKey(message);
  }

  restoreRuntimeCheckpoint(session: Session): boolean {
    const checkpoint = session.metadata[AgentLoop.RUNTIME_CHECKPOINT_KEY];
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return false;
    const restoredMessages: Record<string, any>[] = [];
    const assistant = checkpoint.assistantMessage;
    if (assistant && typeof assistant === "object" && !Array.isArray(assistant)) {
      restoredMessages.push({
        ...assistant,
        timestamp: assistant.timestamp ?? new Date().toISOString(),
      });
    }
    for (const item of checkpoint.completedToolResults ?? []) {
      if (item && typeof item === "object" && !Array.isArray(item)) restoredMessages.push({ ...item, timestamp: item.timestamp ?? new Date().toISOString() });
    }
    for (const call of checkpoint.pendingToolCalls ?? []) {
      if (!call || typeof call !== "object" || Array.isArray(call)) continue;
      restoredMessages.push({
        role: "tool",
        tool_call_id: call.id ?? null,
        name: call.function?.name ?? call.name ?? "tool",
        content: "Error: Task interrupted before this tool finished.",
        timestamp: new Date().toISOString(),
      });
    }
    let overlap = 0;
    const maxOverlap = Math.min(session.messages.length, restoredMessages.length);
    for (let size = maxOverlap; size > 0; size -= 1) {
      const existing = session.messages.slice(-size);
      const restored = restoredMessages.slice(0, size);
      if (existing.every((left, index) => JSON.stringify(this.checkpointMessageKey(left)) === JSON.stringify(this.checkpointMessageKey(restored[index])))) {
        overlap = size;
        break;
      }
    }
    session.messages.push(...restoredMessages.slice(overlap));
    this.clearPendingUserTurn(session);
    this.clearRuntimeCheckpoint(session);
    session.updatedAt = new Date().toISOString();
    return true;
  }

  restorePendingUserTurn(session: Session): boolean {
    if (!session.metadata[AgentLoop.PENDING_USER_TURN_KEY]) return false;
    if (session.messages.at(-1)?.role === "user") {
      session.messages.push({
        role: "assistant",
        content: "Error: Task interrupted before a response was generated.",
        timestamp: new Date().toISOString(),
      });
      session.updatedAt = new Date().toISOString();
    }
    this.clearPendingUserTurn(session);
    return true;
  }

  async dispatchCommand(msg: InboundMessage, session: Session, key: string, abortSignal: AbortSignal | null = null): Promise<OutboundMessage | null | "continue"> {
    const raw = msg.content.trim();
    const result = await this.commands.dispatch(new CommandContext({ msg, session, key, raw, loop: this, abortSignal }));
    if (result == null) {
      return raw.startsWith("/") && msg.content !== raw ? "continue" : null;
    }
    if (raw.toLowerCase() !== "/new") {
      session.addMessage("user", msg.content, { commandMessage: true });
      session.addMessage("assistant", result.content, { commandMessage: true });
      this.sessions.save(session);
    }
    return result;
  }

  async runAgentLoop(
    initialMessages: Record<string, any>[],
    {
      onProgress = null,
      onStream = null,
      onStreamEnd = null,
      onRetryWait = null,
      session = null,
      channel = null,
      chatId = null,
      messageId = null,
      metadata = {},
      sessionKey = null,
      pendingQueue = null,
      abortSignal = null,
      turnId = null,
      boundary = null,
      tools = null,
    }: {
      onProgress?: any;
      onStream?: any;
      onStreamEnd?: any;
      onRetryWait?: any;
      session?: Session | null;
      channel?: string | null;
      chatId?: string | null;
      messageId?: string | null;
      metadata?: Record<string, any>;
      sessionKey?: string | null;
      pendingQueue?: AsyncQueue<InboundMessage> | null;
      abortSignal?: AbortSignal | null;
      turnId?: string | null;
      boundary?: TurnCancellationBoundary | null;
      tools?: ToolRegistryInstance | null;
    } = {},
  ): Promise<[string, string[], Record<string, any>[], string, boolean, boolean]> {
    this.refreshProviderSnapshot();
    this.syncSubagentRuntimeLimits();
    const activeTools = tools ?? this.tools;
    const checkpointSession = session;
    const checkpoint = checkpointSession ? (payload: Record<string, any>) => this.setRuntimeCheckpoint(checkpointSession, payload) : null;
    const activeSessionKey = session?.key ?? sessionKey ?? null;
    const loopHook = new AgentProgressHook(onProgress, onStream, onStreamEnd, {
      channel: channel ?? "cli",
      chatId: chatId ?? "direct",
      messageId: messageId ?? null,
      metadata: metadata ?? {},
      sessionKey: activeSessionKey,
      toolHintMaxLength: this.toolHintMaxLength,
      setToolContext: (...args: any[]) => this.setToolContext(args[0], args[1], args[2], args[3], args[4], activeTools),
      onIteration: (iteration: number) => {
        this.currentIterationValue = iteration;
      },
    });
    const hook = this.extraHooks.length ? new CompositeAgentHook([loopHook, ...this.extraHooks]) : loopHook;
    const result = await this.runner.run(
      new AgentRunSpec({
        messages: initialMessages,
        provider: this.provider,
        tools: activeTools,
        model: this.model,
        maxIterations: this.maxIterations,
        maxTokens: this.provider?.generation?.maxTokens ?? this.config.agents.defaults.maxTokens,
        temperature: this.provider?.generation?.temperature ?? this.config.agents.defaults.temperature,
        reasoningEffort: this.provider?.generation?.reasoningEffort ?? this.config.agents.defaults.reasoningEffort,
        maxToolResultChars: this.maxToolResultChars,
        toolResultMaxCharsByName: SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME,
        workspace: this.workspace,
        sessionKey: activeSessionKey,
        contextWindowTokens: this.contextWindowTokens,
        contextBlockLimit: this.contextBlockLimit,
        providerRetryMode: this.providerRetryMode,
        progressCallback: onProgress,
        streamProgressDeltas: Boolean(onStream),
        retryWaitCallback: onRetryWait,
        checkpointCallback: checkpoint,
        llmTimeoutS: runnerWallLlmTimeoutS(this.sessions, activeSessionKey, {
          metadata: session?.metadata ?? null,
        }),
        turnId,
        boundary,
        goalActivePredicate: session ? () => sustainedGoalActive(session.metadata) : null,
        goalContinueMessage: this.goalContinueMessage(session),
        abortSignal,
        hook,
        concurrentTools: true,
        injectionCallback: ({ limit = 3 } = {}) => this.drainPendingQueue(pendingQueue, limit, session?.key ?? sessionKey),
      }),
    );
    this.lastUsage = normalizeUsageRecord(result.usage ?? result.response?.usage);
    const toolsUsed = (result.toolCalls ?? []).map((call: any) => call?.function?.name ?? call?.name).filter(Boolean);
    return [
      result.finalContent ?? result.content ?? EMPTY_FINAL_RESPONSE_MESSAGE,
      toolsUsed,
      result.messages ?? [],
      result.stopReason ?? "",
      Boolean(result.hadInjections),
      Boolean(result.finalContentStreamed),
    ];
  }

  assembleOutbound(
    msg: InboundMessage,
    finalContent: string,
    allMessages: Record<string, any>[],
    stopReason: string,
    hadInjections: boolean,
    { turnLatencyMs = null, tools = null, finalContentStreamed = false }: {
      turnLatencyMs?: number | null;
      tools?: ToolRegistryInstance | null;
      finalContentStreamed?: boolean;
    } = {},
  ): OutboundMessage | null {
    void allMessages;
    const messageTool = (tools ?? this.tools).get("message");
    if (messageTool instanceof MessageTool && messageTool.sentInTurn) {
      if (!hadInjections || stopReason === "emptyFinalResponse") return null;
    }
    return new OutboundMessage({
      channel: msg.channel,
      chatId: msg.chatId,
      content: finalContent,
      metadata: {
        ...(msg.metadata ?? {}),
        ...(finalContentStreamed && !["error", "toolError"].includes(stopReason) ? { streamed: true } : {}),
        ...(turnLatencyMs != null ? { latencyMs: Math.trunc(turnLatencyMs) } : {}),
      },
    });
  }

  async stateRestore(ctx: TurnContext): Promise<string> {
    let msg = ctx.msg;
    if (msg.media.length) {
      const [content, imageOnly] = await extractDocuments(msg.content, msg.media);
      msg = ctx.msg = new InboundMessage({
        channel: msg.channel,
        chatId: msg.chatId,
        senderId: msg.senderId,
        content,
        media: imageOnly,
        metadata: msg.metadata,
        sessionKey: ctx.sessionKey,
        sessionKeyOverride: msg.sessionKeyOverride,
        timestamp: msg.timestamp,
      });
    }
    if (!ctx.session) ctx.session = await this.getOrCreateSession(ctx.sessionKey);
    markWebuiSession(ctx.session, msg.metadata);
    let changed = this.restoreRuntimeCheckpoint(ctx.session);
    changed = this.restorePendingUserTurn(ctx.session) || changed;
    if (changed) this.sessions.save(ctx.session);
    return "ok";
  }

  async stateCompact(ctx: TurnContext): Promise<string> {
    const prepared = this.autoCompact.prepareSession(ctx.session!, ctx.sessionKey);
    ctx.session = prepared[0];
    ctx.pendingSummary = prepared[1];
    return "ok";
  }

  async stateCommand(ctx: TurnContext): Promise<string> {
    const command = await this.dispatchCommand(ctx.msg, ctx.session!, ctx.sessionKey, ctx.abortSignal);
    if (command && command !== "continue") {
      ctx.outbound = command;
      return "shortcut";
    }
    return "dispatch";
  }

  async stateBuild(ctx: TurnContext): Promise<string> {
    const compactionOptions: {
      replayMaxMessages: number | null;
      notifyOnLockWait?: boolean;
      onCompactionEvent?: (event: { status: TokenCompactionStatus }) => Promise<void>;
    } = {
      replayMaxMessages: this.maxMessages,
    };
    if (ctx.msg.channel === "websocket") {
      compactionOptions.notifyOnLockWait = true;
      compactionOptions.onCompactionEvent = async (event) => {
        await this.publishWebuiContextCompaction(ctx, event.status);
      };
    }
    await this.consolidator.maybeConsolidateByTokens(ctx.session!, compactionOptions);
    ctx.tools = this.createToolRegistry("turn", {
      includeConnectedMcp: true,
      messageSendCallback: ctx.messageSendCallback,
    });
    this.setToolContext(
      ctx.msg.channel,
      ctx.msg.chatId,
      ctx.msg.metadata?.message_id ?? ctx.msg.metadata?.messageId ?? null,
      ctx.msg.metadata ?? {},
      ctx.sessionKey,
      ctx.tools,
    );
    const messageTool = ctx.tools.get("message");
    if (messageTool instanceof MessageTool) messageTool.startTurn();
    ctx.history = ctx.session!.getHistory({
      maxMessages: this.maxMessages,
      maxTokens: this.replayTokenBudget(),
      includeTimestamps: true,
    });
    ctx.initialMessages = this.buildInitialMessages(ctx.msg, ctx.session!, ctx.history, ctx.pendingSummary);
    ctx.userPersistedEarly = this.persistUserMessageEarly(ctx.msg, ctx.session!);
    if (ctx.userPersistedEarly) await publishWebuiThreadSessionUpdated(this.bus, ctx.msg);
    ctx.onProgress ??= await this.buildBusProgressCallback(ctx);
    ctx.onRetryWait ??= await this.buildRetryWaitCallback(ctx.msg);
    return "ok";
  }

  async stateRun(ctx: TurnContext): Promise<string> {
    const [finalContent, toolsUsed, allMessages, stopReason, hadInjections, finalContentStreamed] = await this.runAgentLoop(ctx.initialMessages, {
      onProgress: ctx.onProgress,
      onStream: ctx.onStream,
      onStreamEnd: ctx.onStreamEnd,
      onRetryWait: ctx.onRetryWait,
      session: ctx.session,
      channel: ctx.msg.channel,
      chatId: ctx.msg.chatId,
      messageId: ctx.msg.metadata?.message_id ?? ctx.msg.metadata?.messageId,
      metadata: ctx.msg.metadata,
      sessionKey: ctx.sessionKey,
      pendingQueue: ctx.pendingQueue,
      abortSignal: ctx.abortSignal,
      turnId: ctx.turnId,
      boundary: ctx.boundary,
      tools: ctx.tools,
    });
    if (ctx.abortSignal?.aborted || stopReason === "cancelled") {
      throw createTaskCancelledError();
    }
    ctx.finalContent = this.localizeUserFacingApiError(ctx.msg.channel, ctx.msg.metadata, ctx.session, finalContent, stopReason);
    ctx.toolsUsed = toolsUsed;
    ctx.allMessages = allMessages;
    ctx.stopReason = stopReason;
    ctx.hadInjections = hadInjections;
    ctx.finalContentStreamed = finalContentStreamed;
    return "ok";
  }

  async stateSave(ctx: TurnContext): Promise<string> {
    if (!ctx.finalContent?.trim()) ctx.finalContent = EMPTY_FINAL_RESPONSE_MESSAGE;
    ctx.saveSkip = 1 + ctx.history.length + (ctx.userPersistedEarly ? 1 : 0);
    ctx.turnLatencyMs = Math.max(0, Math.trunc((Date.now() / 1000 - ctx.turnWallStartedAt) * 1000));
    const dagMessageStart = Math.max(0, ctx.session!.messages.length - (ctx.userPersistedEarly ? 1 : 0));
    this.saveTurn(ctx.session!, ctx.allMessages, ctx.saveSkip, {
      turnLatencyMs: ctx.turnLatencyMs,
    });
    this.clearPendingUserTurn(ctx.session!);
    this.clearRuntimeCheckpoint(ctx.session!);
    ctx.session!.enforceFileCap((messages) =>
      this.context.memory.rawArchive(messages, { sessionKey: ctx.sessionKey }),
    );
    this.sessions.save(ctx.session!);
    this.enqueueSessionDagTurn(ctx.session!, ctx.turnId, dagMessageStart, ctx.session!.messages.length);
    this.scheduleBackground(
      this.consolidator.maybeConsolidateByTokens(ctx.session!, {
        replayMaxMessages: this.maxMessages,
      }),
    );
    return "ok";
  }

  async stateRespond(ctx: TurnContext): Promise<string> {
    ctx.outbound = this.assembleOutbound(ctx.msg, ctx.finalContent ?? EMPTY_FINAL_RESPONSE_MESSAGE, ctx.allMessages, ctx.stopReason, ctx.hadInjections, {
      turnLatencyMs: ctx.turnLatencyMs,
      tools: ctx.tools,
      finalContentStreamed: ctx.finalContentStreamed,
    });
    return "ok";
  }

  async processSystemMessage(
    msg: InboundMessage,
    sessionKey?: string | null,
    {
      onProgress,
      onStream,
      onStreamEnd,
      pendingQueue,
      abortSignal,
      turnId,
    }: {
      onProgress?: (...args: any[]) => Promise<void> | void;
      onStream?: (delta: string) => Promise<void> | void;
      onStreamEnd?: (...args: any[]) => Promise<void> | void;
      pendingQueue?: AsyncQueue<InboundMessage> | null;
      abortSignal?: AbortSignal | null;
      turnId?: string | null;
      boundary?: TurnCancellationBoundary | null;
    } = {},
  ): Promise<OutboundMessage | null> {
    this.refreshProviderSnapshot();
    const rawChatId = String(msg.chatId ?? "");
    const separator = rawChatId.indexOf(":");
    const channel = separator >= 0 ? rawChatId.slice(0, separator) : "cli";
    const chatId = separator >= 0 ? rawChatId.slice(separator + 1) : rawChatId;
    const key = sessionKey ?? msg.sessionKeyOverride ?? `${channel}:${chatId}`;
    let session = await this.getOrCreateSession(key);
    if (this.restoreRuntimeCheckpoint(session)) this.sessions.save(session);
    if (this.restorePendingUserTurn(session)) this.sessions.save(session);

    const prepared = this.autoCompact.prepareSession(session, key);
    session = prepared[0];
    const pendingSummary = prepared[1];
    await this.consolidator.maybeConsolidateByTokens(session, {
      replayMaxMessages: this.maxMessages,
    });
    const tools = this.createToolRegistry("system-turn", { includeConnectedMcp: true });

    const isSubagent = msg.senderId === "subagent";
    if (isSubagent && this.persistSubagentFollowup(session, msg)) this.sessions.save(session);
    this.setToolContext(channel, chatId, msg.metadata?.message_id ?? msg.metadata?.messageId ?? null, msg.metadata ?? {}, key, tools);

    const history = session.getHistory({
      maxMessages: this.maxMessages,
      maxTokens: this.replayTokenBudget(),
      includeTimestamps: true,
    });
    const currentRole = isSubagent ? "assistant" : "user";
    const messages = this.context.buildMessages({
      history,
      currentMessage: isSubagent ? "" : msg.content,
      channel,
      chatId,
      currentRole,
      senderId: msg.senderId,
      sessionSummary: pendingSummary ?? session.metadata?.lastSummary?.text ?? null,
      sessionMetadata: session.metadata,
      responseLanguage: msg.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? session.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? null,
      sessionKey: key,
      unifiedSession: this.unifiedSession,
      currentRuntimeLines: isSubagent
        ? []
        : [
            ...mcpRuntimeLines(msg, {
              availableServerNames: new Set(Object.keys(this.mcpServers ?? {})),
            }),
          ],
      hook: this.lifecycleHook(),
    });

    const started = Date.now();
    const [rawFinalContent, , allMessages, stopReason] = await this.runAgentLoop(messages, {
      onProgress,
      onStream,
      onStreamEnd,
      session,
      channel,
      chatId,
      messageId: msg.metadata?.message_id ?? msg.metadata?.messageId ?? null,
      metadata: msg.metadata,
      sessionKey: key,
      pendingQueue,
      abortSignal,
      tools,
    });
    if (abortSignal?.aborted || stopReason === "cancelled") {
      throw createTaskCancelledError();
    }
    const finalContent = this.localizeUserFacingApiError(channel, msg.metadata, session, rawFinalContent, stopReason);
    const latencyMs = Math.max(0, Date.now() - started);
    const dagMessageStart = session.messages.length;
    this.saveTurn(session, allMessages, 1 + history.length, { turnLatencyMs: latencyMs });
    this.clearRuntimeCheckpoint(session);
    session.enforceFileCap((messages) =>
      this.context.memory.rawArchive(messages, { sessionKey: key }),
    );
    this.sessions.save(session);
    this.enqueueSessionDagTurn(session, turnId ?? firstString(msg.metadata?.turn_id, msg.metadata?.turnId) ?? cryptoRandomId(), dagMessageStart, session.messages.length);
    this.scheduleBackground(this.consolidator.maybeConsolidateByTokens(session, { replayMaxMessages: this.maxMessages }));

    const metadata: Record<string, any> = {};
    if (channel === "slack" && key.startsWith("slack:") && key.split(":").length >= 3) {
      metadata.slack = { thread_ts: key.split(":", 3)[2] };
    }
    const originMessageId = msg.metadata?.originMessageId;
    if (originMessageId) metadata.originMessageId = originMessageId;
    return new OutboundMessage({
      channel,
      chatId,
      content: finalContent?.trim() || (stopReason === "error" ? EMPTY_FINAL_RESPONSE_MESSAGE : "Background task completed."),
      metadata,
    });
  }

  async processMessageInternal(
    message: InboundMessage,
    sessionKey?: string,
    {
      onProgress,
      onStream,
      onStreamEnd,
      pendingQueue,
      abortSignal,
      turnId,
      boundary,
      messageSendCallback,
    }: {
      onProgress?: (...args: any[]) => Promise<void> | void;
      onStream?: (delta: string) => Promise<void> | void;
      onStreamEnd?: (...args: any[]) => Promise<void> | void;
      pendingQueue?: AsyncQueue<InboundMessage> | null;
      abortSignal?: AbortSignal | null;
      turnId?: string | null;
      boundary?: TurnCancellationBoundary | null;
      messageSendCallback?: MessageSendCallback | null;
    } = {},
  ): Promise<OutboundMessage | null> {
    this.refreshProviderSnapshot();
    if (message.channel === "system") {
      return this.processSystemMessage(message, sessionKey, {
        onProgress,
        onStream,
        onStreamEnd,
        pendingQueue,
        abortSignal,
      });
    }
    const key = sessionKey ?? this.sessionKey(message);
    const resolvedTurnId = turnId ?? firstString(message.metadata?.turn_id, message.metadata?.turnId) ?? undefined;
    const ctx = new TurnContext({ msg: message, sessionKey: key, turnId: resolvedTurnId });
    ctx.onProgress = onProgress ?? null;
    ctx.onStream = onStream ?? null;
    ctx.onStreamEnd = onStreamEnd ?? null;
    ctx.pendingQueue = pendingQueue ?? null;
    ctx.abortSignal = abortSignal ?? null;
    ctx.boundary = boundary ?? createTurnCancellationBoundary({ turnId: ctx.turnId, signal: ctx.abortSignal });
    ctx.messageSendCallback = messageSendCallback ?? null;

    await this.stateRestore(ctx);
    this.autoCompact.checkExpired((promise) => this.scheduleBackground(promise), this.activeTasks.keys());
    await this.stateCompact(ctx);
    const commandState = await this.stateCommand(ctx);
    if (commandState === "shortcut") return ctx.outbound;
    await this.stateBuild(ctx);
    await this.stateRun(ctx);
    await this.stateSave(ctx);
    await this.stateRespond(ctx);
    return ctx.outbound;
  }

  async processMessage(message: InboundMessage, sessionKey?: string, opts: Parameters<AgentLoop["processMessageInternal"]>[2] = {}): Promise<OutboundMessage | null> {
    return this.processMessageInternal(message, sessionKey, opts);
  }

  async dispatchMessage(msg: InboundMessage, isCancelled: () => boolean = () => false, abortSignal: AbortSignal | null = null): Promise<void> {
    const sessionKey = this.effectiveSessionKey(msg);
    const turnId = firstString(msg.metadata?.turn_id, msg.metadata?.turnId) ?? cryptoRandomId();
    const effectiveMsg = new InboundMessage({
      channel: msg.channel,
      chatId: msg.chatId,
      senderId: msg.senderId,
      content: msg.content,
      media: msg.media,
      metadata: {
        ...(msg.metadata ?? {}),
        ...turnMetadata(turnId),
      },
      timestamp: msg.timestamp,
      sessionKey: msg.sessionKey,
      sessionKeyOverride: sessionKey !== msg.sessionKey ? sessionKey : msg.sessionKeyOverride,
    });
    const boundary = createTurnCancellationBoundary({ turnId, signal: abortSignal });
    const pending = new AsyncQueue<InboundMessage>();
    this.pendingQueues.set(sessionKey, pending);
    const lock = this.lockFor(sessionKey);
    const publishRunStatus = shouldPublishWebuiRunStatus(effectiveMsg);
    let didPublishRunning = false;
    try {
      await lock.runExclusive(async () => {
        if (isCancelled()) return;
        if (publishRunStatus) {
          await publishTurnRunStatus(this.bus, effectiveMsg, "running");
          didPublishRunning = true;
        }
        let onStream: ((delta: string) => Promise<void>) | undefined;
        let onStreamEnd: ((opts?: { resuming?: boolean }) => Promise<void>) | undefined;
        if (effectiveMsg.metadata?.wantsStream) {
          const streamBaseId = `${effectiveMsg.sessionKey}:${Date.now()}`;
          let streamSegment = 0;
          const currentStreamId = () => `${streamBaseId}:${streamSegment}`;
          onStream = async (delta: string) => {
            if (isCancelled() || boundary.shouldEmitLive() === false) return;
            await this.bus.publishOutbound(
              new OutboundMessage({
                channel: effectiveMsg.channel,
                chatId: effectiveMsg.chatId,
                content: delta,
                metadata: {
                  ...(effectiveMsg.metadata ?? {}),
                  ...boundary.metadata(),
                  streamDelta: true,
                  streamId: currentStreamId(),
                },
              }),
            );
          };
          onStreamEnd = async ({ resuming = false }: { resuming?: boolean } = {}) => {
            if (isCancelled() || boundary.shouldEmitLive() === false) return;
            await this.bus.publishOutbound(
              new OutboundMessage({
                channel: effectiveMsg.channel,
                chatId: effectiveMsg.chatId,
                content: "",
                metadata: {
                  ...(effectiveMsg.metadata ?? {}),
                  ...boundary.metadata(),
                  streamEnd: true,
                  resuming: resuming,
                  streamId: currentStreamId(),
                },
              }),
            );
            streamSegment += 1;
          };
        }
        const response = await this.processMessageInternal(effectiveMsg, sessionKey, {
          onStream,
          onStreamEnd,
          pendingQueue: pending,
          abortSignal,
          turnId,
          boundary,
        });
        if (!isCancelled() && response) await this.bus.publishOutbound(response);
        if (!isCancelled() && effectiveMsg.channel === "cli") {
          await this.bus.publishOutbound(
            new OutboundMessage({
              channel: effectiveMsg.channel,
              chatId: effectiveMsg.chatId,
              content: "",
              metadata: effectiveMsg.metadata ?? {},
            }),
          );
        }
      });
    } catch (error) {
      try {
        const session = this.sessions.getOrCreate(sessionKey);
        const restored = this.restoreRuntimeCheckpoint(session) || this.restorePendingUserTurn(session);
        if (restored) this.sessions.save(session);
      } catch {
        // Preserve the original dispatch failure; checkpoint restore is best-effort.
      }
      if (isTaskCancelledError(error)) {
        boundary.close("aborted");
        return;
      }
      throw error;
    } finally {
      if (didPublishRunning) {
        await finishWebuiTurn({
          bus: this.bus,
          msg: effectiveMsg,
          sessionKey,
          sessions: this.sessions,
        });
      }
      boundary.close(abortSignal?.aborted ? "aborted" : "ended");
      const queue = this.pendingQueues.get(sessionKey);
      this.pendingQueues.delete(sessionKey);
      while (queue) {
        const item = queue.getNowait();
        if (!item) break;
        await this.bus.publishInbound(item);
      }
    }
  }

  async run(): Promise<void> {
    this.running = true;
    await this.connectMcp();
    if (!this.running) return;
    while (this.running) {
      const msg = this.bus.inbound.getNowait();
      if (!msg) {
        this.autoCompact.checkExpired((promise) => this.scheduleBackground(promise), this.pendingQueues.keys());
        await sleep(100);
        continue;
      }
      const raw = msg.content.trim();
      if (this.commands.isPriority(raw)) {
        await this.dispatchCommandInline(msg, msg.sessionKey, raw, (ctx) => this.commands.dispatchPriority(ctx));
        continue;
      }
      const effectiveKey = this.effectiveSessionKey(msg);
      const pending = this.pendingQueues.get(effectiveKey);
      if (pending) {
        if (this.commands.isDispatchableCommand(raw)) {
          await this.dispatchCommandInline(msg, effectiveKey, raw, (ctx) => this.commands.dispatch(ctx));
          continue;
        }
        const queued =
          effectiveKey === msg.sessionKey
            ? msg
            : new InboundMessage({
                channel: msg.channel,
                chatId: msg.chatId,
                senderId: msg.senderId,
                content: msg.content,
                media: msg.media,
                metadata: msg.metadata,
                timestamp: msg.timestamp,
                sessionKeyOverride: effectiveKey,
              });
        try {
          pending.put(queued);
        } catch {
          const task = makeCancelableDispatchTask((isCancelled, signal) => this.dispatchMessage(msg, isCancelled, signal));
          const list = this.activeTasks.get(effectiveKey) ?? [];
          list.push(task);
          this.activeTasks.set(effectiveKey, list);
          task
            .finally(() => {
              const current = this.activeTasks.get(effectiveKey) ?? [];
              const next = current.filter((item) => item !== task);
              if (next.length) this.activeTasks.set(effectiveKey, next);
              else this.activeTasks.delete(effectiveKey);
            })
            .catch(() => undefined);
        }
        continue;
      }
      const task = makeCancelableDispatchTask((isCancelled, signal) => this.dispatchMessage(msg, isCancelled, signal));
      const list = this.activeTasks.get(effectiveKey) ?? [];
      list.push(task);
      this.activeTasks.set(effectiveKey, list);
      task
        .finally(() => {
          const current = this.activeTasks.get(effectiveKey) ?? [];
          const next = current.filter((item) => item !== task);
          if (next.length) this.activeTasks.set(effectiveKey, next);
          else this.activeTasks.delete(effectiveKey);
        })
        .catch(() => undefined);
    }
  }

  stop(): void {
    this.running = false;
  }

  async processDirect(
    content: string,
    {
      sessionKey = "cli:direct",
      channel = "cli",
      chatId = "direct",
      media = [],
      metadata = {},
      onProgress,
      onStream,
      onStreamEnd,
      messageSendCallback,
    }: {
      sessionKey?: string;
      channel?: string;
      chatId?: string;
      media?: string[];
      metadata?: Record<string, any>;
      onProgress?: (...args: any[]) => Promise<void> | void;
      onStream?: (delta: string) => Promise<void> | void;
      onStreamEnd?: (...args: any[]) => Promise<void> | void;
      messageSendCallback?: MessageSendCallback | null;
    } = {},
  ): Promise<OutboundMessage | null> {
    await this.connectMcp();
    const key = this.unifiedSession ? UNIFIED_SESSION_KEY : sessionKey;
    const msg = new InboundMessage({
      channel,
      chatId,
      senderId: "user",
      content,
      media,
      metadata,
      sessionKey: key,
    });
    return this.processMessageInternal(msg, key, { onProgress, onStream, onStreamEnd, messageSendCallback });
  }
}
