import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AsyncQueue,
  MessageBus,
  OutboundMessage,
  InboundMessage,
  parseTurnSource,
  type TurnSource,
} from "../runtime-messages/index.js";
import { CommandContext, CommandRouter } from "../../command/router.js";
import { registerBuiltinCommands } from "../../command/builtin.js";
import { Config, ModelPresetConfig } from "../../config/schema.js";
import { getWorkspacePath } from "../../config/paths.js";
import { CONTEXT_SAFETY_BUFFER_TOKENS } from "../../token-budget.js";
import { CronService } from "../../cron/service.js";
import { makeProvider } from "../../providers/factory.js";
import {
  committedSelectionFromMetadata,
  modelSelectionWire,
  persistedModelSelection,
  resolveModelSelection,
  type ModelSelectionInput,
  type ResolvedModelSelection,
} from "../../providers/model-catalog.js";
import type { ProviderErrorCategory } from "../../providers/provider-error-classifier.js";

type UserFacingModelErrorCategory = ProviderErrorCategory | "model_failed";
type UserFacingModelError = {
  category: UserFacingModelErrorCategory;
  detail?: string;
  presetId?: string;
  source?: "account" | "byok";
  provider?: string;
  model?: string;
  capability?: string;
  failedProvider?: string;
  failedModel?: string;
};

function userFacingModelError(
  category: UserFacingModelErrorCategory,
  detail: string | null | undefined,
  selection: ResolvedModelSelection | null | undefined,
  failure: { failedProvider?: string | null; failedModel?: string | null } = {},
): UserFacingModelError {
  return {
    category,
    ...(detail ? { detail } : {}),
    ...(selection ? {
      presetId: selection.presetId,
      source: selection.source,
      provider: selection.provider,
      model: selection.model,
      capability: selection.capability,
    } : {}),
    ...(failure.failedProvider ? { failedProvider: failure.failedProvider } : {}),
    ...(failure.failedModel ? { failedModel: failure.failedModel } : {}),
  };
}
import { makeReloadingProviderSnapshotLoader, makeReloadingToolsSnapshotLoader } from "../../providers/snapshot-loader.js";
import {
  readWebuiSessionBinding,
  Session,
  SessionManager,
  type WebuiSessionBinding,
  WEBUI_PROJECT_ID_METADATA_KEY,
  WEBUI_WORKSPACE_CWD_METADATA_KEY,
} from "../session/manager.js";
import {
  TerminalRunControl,
  TerminalSessionTurnLock,
} from "../session/terminal-session-control.js";
import {
  goalSummary,
  readGoalState,
  runnerWallLlmTimeoutS,
  type GoalState,
  type GoalStatus,
} from "../session/goal-state.js";
import { finishWebuiTurn, markWebuiSession, maybeGenerateWebuiTitle, publishTurnRunStatus, publishWebuiThreadSessionUpdated, shouldPublishWebuiRunStatus, WEBUI_LANGUAGE_METADATA_KEY } from "../session/webui-turns.js";
import { extractDocuments } from "../../utils/document.js";
import { renderTemplate } from "../../utils/prompt-templates.js";
import { imageGenerationPrompt } from "../../utils/image-generation-intent.js";
import { LLMRuntime } from "../../utils/llm-runtime.js";
import { withProgressCapabilities } from "../../utils/progress-events.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../../utils/runtime.js";
import {
  AgentRunner,
  AgentRunSpec,
  type AgentInternalTurnContext,
  type FollowupModelContextUpdate,
  type FollowupModelRequestContext,
} from "./runner.js";
import {
  GoalRuntime,
  GoalRuntimeError,
  WEBUI_QUEUE_STEER_TRANSFERS_KEY,
  type GoalTurnInboxEntry,
  type WebuiQueueSteerTransferRecord,
} from "./goal-runtime.js";
import { resolveToolResultMaxChars, SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME } from "./tool-result-budget.js";
import { AgentProgressHook } from "./progress-hook.js";
import { createTurnCancellationBoundary, type TurnCancellationBoundary } from "./turn-cancellation-boundary.js";
import { ToolLoader } from "./tools/loader.js";
import { RequestContext, ToolContext } from "./tools/context.js";
import { ExecSessionManager } from "./tools/exec-session.js";
import { MessageTool, type MessageSendCallback } from "./tools/message.js";
import { FileStateStore } from "./tools/file-state.js";
import { connectMissingServers, handleRuntimeControl, reloadLock, runtimeLines as mcpRuntimeLines, sessionExtra as mcpSessionExtra } from "./tools/mcp.js";
import { BrowserSessionManager, type BrowserScope } from "./tools/browser.js";
import { ContextBuilder } from "./context.js";
import { BUILTIN_SKILLS_DIR } from "./skills.js";
import {
  Consolidator,
  Dream,
  type TokenCompactionEvent,
  type TokenCompactionStatus,
} from "./memory.js";
import { AgentHook, AgentHookContext, CompositeAgentHook } from "./hook.js";
import { SubagentManager } from "./subagent.js";
import { AutoCompact } from "./autocompact.js";
import { configuredModelPresets, defaultSelectionSignature, makePresetSnapshotLoader, normalizePresetName } from "./model-presets.js";
import { installMemmyMemory, type MemmyMemoryIntegration } from "../../memmy-memory/index.js";
import { createByokTokenUsageRecorder, installByokTokenUsage } from "../../integrations/byok-token-usage/index.js";
import {
  SessionDagQueueManager,
  SessionDagUsageReporter,
  type DagGoalContext,
  type DagTurnInput,
} from "../../session-dag/index.js";
import {
  assertWebuiWorkspaceAvailable,
  ProjectStore,
  WebuiProjectError,
} from "../../entrypoints/frontend-bridge/projects.js";
import { isGuiImChannel } from "../../entrypoints/frontend-bridge/gui-session-projection.js";

export const UNIFIED_SESSION_KEY = "unified:default";
const WEBUI_CHAT_COMPOSER_QUEUE_SURFACE = "chat_composer";

function sharedTurnSource(message: InboundMessage): TurnSource | null {
  return message.turnSource ?? parseTurnSource(message.metadata?.turn_source);
}

function isSharedQueueMessage(message: InboundMessage): boolean {
  return sharedTurnSource(message) !== null
    && typeof message.metadata?.client_request_id === "string";
}

function isImmediateGoalControlCommand(raw: string): boolean {
  const command = raw.trim().toLowerCase();
  if (command === "/goal") return true;
  if (!command.startsWith("/goal ")) return false;
  const subcommand = command.slice("/goal ".length).trim().split(/\s+/, 1)[0] ?? "";
  return ["status", "help", "pause", "resume", "edit", "budget", "clear"].includes(subcommand);
}

function isSessionOrderedCommand(raw: string): boolean {
  const command = raw.trim().toLowerCase();
  return command === "/model"
    || command.startsWith("/model ")
    || ((command === "/goal" || command.startsWith("/goal "))
      && !isImmediateGoalControlCommand(command));
}

type ToolRegistryInstance = ReturnType<ToolLoader["loadRegistry"]>;
type GuiMirrorTurn = {
  sessionKey: string;
  chatId: string;
  turnId: string;
  source: TurnSource | null;
  clientRequestId: string | null;
};
type GuiTranscriptMirrorLike = {
  sessionKeyForMessage: (message: InboundMessage) => string | null;
  prepareSession: (
    message: InboundMessage,
    session: Session,
    sessionKey: string,
  ) => WebuiSessionBinding | null;
  sessionUpdated: (sessionKey: string) => void;
  turn: (
    sessionKey: string,
    turnId: string,
    source?: TurnSource | null,
    clientRequestId?: string | null,
  ) => GuiMirrorTurn | null;
  running: (turn: GuiMirrorTurn, startedAt: number) => void;
  user: (turn: GuiMirrorTurn, text: string, mediaPaths?: string[]) => void;
  progress: (turn: GuiMirrorTurn, content: string, options?: Record<string, any>) => void;
  delta: (turn: GuiMirrorTurn, text: string, streamId: string) => void;
  streamEnd: (turn: GuiMirrorTurn, streamId: string, resuming?: boolean) => void;
  contextCompaction: (
    turn: GuiMirrorTurn,
    text: string,
    status: TokenCompactionStatus,
  ) => void;
  retryWait: (turn: GuiMirrorTurn, text: string) => void;
  final: (
    turn: GuiMirrorTurn,
    text: string,
    latencyMs?: number | null,
    agentUi?: unknown,
    errorCategory?: ProviderErrorCategory | null,
    modelError?: UserFacingModelError | null,
  ) => void;
  ended: (
    turn: GuiMirrorTurn,
    latencyMs?: number | null,
    goalId?: string | null,
    goalOutcome?: GoalStatus | null,
  ) => void;
};

type AgentLoopResult = [
  finalContent: string,
  toolsUsed: string[],
  allMessages: Record<string, any>[],
  stopReason: string,
  hadInjections: boolean,
  finalContentStreamed: boolean,
  actualModelProvider: string | null,
  actualModel: string | null,
  errorCategory: ProviderErrorCategory | null,
  usage: Record<string, number>,
  failedProvider: string | null,
  failedModel: string | null,
];

type MidTurnContextDescriptor = {
  transcriptStartIndex: number;
  protectedSessionMessageStart: number;
  sessionTailMessagesRepresentedInTranscript: number;
  rebuildProjection: (
    session: Session,
    currentTurnMessages: readonly Record<string, any>[],
    options?: {
      visibleMessageStart?: number;
      summaryOverride?: string | null;
    },
  ) => Record<string, any>[];
};

type TokenCompactionEventCallback = (event: TokenCompactionEvent) => Promise<void> | void;

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
  errorDetail: string | null = null;
  finalContentStreamed = false;
  errorCategory: ProviderErrorCategory | null = null;
  failedProvider: string | null = null;
  failedModel: string | null = null;
  usage: Record<string, number> = {};
  goalIdForTurn: string | null = null;
  dagGoalContext: DagGoalContext | null = null;
  goalOutcome: GoalStatus | null = null;
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
  sessionWorkspace: string | null = null;
  sessionProjectId: string | null = null;
  trustedSessionBinding: WebuiSessionBinding | null = null;
  mirrorTurn: GuiMirrorTurn | null = null;
  modelSelection: ResolvedModelSelection | null = null;
  actualModelProvider: string | null = null;
  actualModel: string | null = null;
  consolidator: Consolidator | null = null;
  slot: TurnSlot | null = null;
  midTurnContext: MidTurnContextDescriptor | null = null;
  onTokenCompactionEvent: TokenCompactionEventCallback | null = null;

  constructor(init: {
    msg: InboundMessage;
    sessionKey?: string;
    state?: TurnState;
    turnId?: string;
    session?: Session | null;
    slot?: TurnSlot | null;
  }) {
    this.msg = init.msg;
    this.sessionKey = init.sessionKey ?? init.msg.sessionKey;
    this.state = init.state ?? TurnState.RESTORE;
    this.turnId = init.turnId ?? cryptoRandomId();
    this.session = init.session ?? null;
    this.slot = init.slot ?? null;
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
  modelSelectionResolver?: ((input: ModelSelectionInput) => ResolvedModelSelection | null) | null;
  mcpServers?: Record<string, any>;
  cronService?: CronService;
  hooks?: AgentHook[];
  sessionDagQueue?: SessionDagQueueManager | null;
  projectStore?: ProjectStore | null;
  guiTranscriptMirror?: GuiTranscriptMirrorLike | null;
};

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function mergedRuntimeRecord(
  defaults: Record<string, any> | null | undefined,
  overrides: Record<string, any> | null | undefined,
): Record<string, any> {
  return { ...(defaults ?? {}), ...(overrides ?? {}) };
}

function stripRuntimeContext(content: string): string {
  const pos = content.indexOf(ContextBuilder.RUNTIME_CONTEXT_TAG);
  return pos >= 0 ? content.slice(0, pos).trimEnd() : content;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

const QUOTA_API_ERROR_FALLBACK_ZH = "当前模型额度已用完";
const QUOTA_API_ERROR_FALLBACK_EN = "This model's quota has been used up.";
const IMAGE_INPUT_UNSUPPORTED_ZH = "当前模型不支持图片输入，请切换到支持多模态能力的模型后重试";
const IMAGE_INPUT_UNSUPPORTED_EN = "The current model does not support image input. Switch to a multimodal model and try again.";
const IMAGE_ANALYSIS_FAILED_ZH = "图片解析失败，请稍后重试";
const IMAGE_ANALYSIS_FAILED_EN = "Image analysis failed. Please try again later.";

function quotaApiErrorFallback(language: any): string {
  return usesChineseWebuiLanguage(language)
    ? QUOTA_API_ERROR_FALLBACK_ZH
    : QUOTA_API_ERROR_FALLBACK_EN;
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

function withoutTurnMetadata(metadata: Record<string, any>): Record<string, any> {
  const copy = { ...metadata };
  delete copy.turnId;
  delete copy.turn_id;
  return copy;
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

export function normalizeUsageRecord(
  usage: Record<string, unknown> | null | undefined,
): Record<string, number> {
  const normalize = (value: unknown): number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0
  );
  return {
    prompt_tokens: normalize(usage?.prompt_tokens),
    completion_tokens: normalize(usage?.completion_tokens),
    total_tokens: normalize(usage?.total_tokens),
    cached_tokens: normalize(usage?.cached_tokens),
  };
}

export function hasReportedInOutUsage(
  usage: Record<string, unknown> | null | undefined,
): boolean {
  return ["prompt_tokens", "completion_tokens"].every((field) => {
    const value = usage?.[field];
    return Object.prototype.hasOwnProperty.call(usage ?? {}, field)
      && typeof value === "number"
      && Number.isFinite(value)
      && value >= 0;
  });
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

export type QueueMessageDescriptor = {
  clientRequestId: string;
  content: string;
  media: string[];
  queuedAt: string;
  sessionKey: string;
  source: TurnSource;
  queueSurface: "chat_composer" | null;
  turnAdmission?: "steer";
  turnId?: string;
};

export type QueueSnapshotDescriptor = {
  revision: number;
  items: QueueMessageDescriptor[];
  startedItems: QueueMessageDescriptor[];
};

export type RemoveQueuedMessageResult = {
  outcome: "removed" | "already_dequeued" | "missing";
  revision: number;
};

export type SteerQueuedMessageResult = {
  outcome: "steered" | "not_steerable" | "already_dequeued" | "missing";
  revision: number;
  turnId?: string;
  descriptor?: QueueMessageDescriptor;
};

export type StopExpectedTurnResult = "stopped" | "already_finished" | "not_owned";

export type WebuiQueueMessageDescriptor = QueueMessageDescriptor;
export type WebuiQueueSnapshotDescriptor = QueueSnapshotDescriptor;
export type RemoveQueuedWebuiMessageResult = RemoveQueuedMessageResult;

type TurnSlotAnnouncementGate = {
  promise: Promise<void>;
  open: () => void;
};

type TurnSlotState = "queued" | "running" | "settling" | "closed";
type TurnRootDelivery = "pending" | "accepted" | "rejected";

type TurnSlot = {
  route: string;
  root: InboundMessage;
  turnId: string;
  state: TurnSlotState;
  acceptingSteer: boolean;
  pendingSteer: AsyncQueue<InboundMessage>;
  rootDelivery: TurnRootDelivery;
  owner: symbol;
  stopReason: string | null;
  announcedToWebui: boolean;
  dispatchTask: CancelableDispatchTask | null;
  announcementGate: TurnSlotAnnouncementGate | null;
};

type QueueSteerAdmission = {
  turnId: string;
  revision: number;
  descriptor: QueueMessageDescriptor;
  message: InboundMessage;
  store: "slot" | "goal";
  phase: "pending" | "consumed";
};

function createTurnSlotAnnouncementGate(): TurnSlotAnnouncementGate {
  let opened = false;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    open: () => {
      if (opened) return;
      opened = true;
      release();
    },
  };
}

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

export class SessionWorkspaceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SessionWorkspaceError";
    this.code = code;
  }
}

export class AgentLoop {
  bus: MessageBus;
  config: Config;
  toolsConfig: Config["tools"];
  webConfig: any;
  execConfig: any;
  provider: any;
  workspace: string;
  readonly fileMemoryEnabled: boolean;
  model: string | null;
  modelPresets: Record<string, ModelPresetConfig>;
  private defaultModelPreset: ModelPresetConfig;
  sessions: SessionManager;
  cronService: CronService;
  execSessionManager: ExecSessionManager;
  fileStateStore: FileStateStore;
  browserSessionManager: BrowserSessionManager;
  subagents: SubagentManager;
  runner: AgentRunner;
  context: ContextBuilder;
  tools: ReturnType<ToolLoader["loadRegistry"]>;
  commands: CommandRouter;
  consolidator: Consolidator;
  sessionDagQueue: SessionDagQueueManager | null;
  projectStore: ProjectStore | null;
  guiTranscriptMirror: GuiTranscriptMirrorLike | null;
  terminalTurnLock: TerminalSessionTurnLock;
  terminalRunControl: TerminalRunControl;
  autoCompact: AutoCompact;
  dream: Dream | null;
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
  lastUsageBySession: Map<string, Record<string, number>>;
  goalRuntime: GoalRuntime;
  scheduledGoalSessions: Map<string, { goalId: string; updatedAt: string }>;
  activeTasks: Map<string, any[]>;
  pendingQueues: Map<string, AsyncQueue<InboundMessage>>;
  turnSlots: Map<string, TurnSlot[]>;
  sessionDeletionQueues: Map<string, InboundMessage[]>;
  sessionLocks: Map<string, AsyncMutex>;
  queueMutationLocks: Map<string, AsyncMutex>;
  queueRevisionBySession: Map<string, number>;
  queueSteerAdmissionsBySession: Map<string, Map<string, QueueSteerAdmission>>;
  lastQueuedAtBySession: Map<string, number>;
  running: boolean;
  currentIterationValue = 0;
  providerSignature: any[] | string | null = null;
  providerSnapshotLoader: ((opts?: any) => any) | null = null;
  toolsSnapshotLoader: (() => any) | null = null;
  presetSnapshotLoader: ((name: string) => any) | null = null;
  runtimeModelPublisher: ((model: string | null, modelPreset?: string | null) => void) | null = null;
  private channelCapabilitiesResolver: ((channel: string) => { supportsStreaming: boolean } | null) | null = null;
  private readonly modelSelectionResolver: ((input: ModelSelectionInput) => ResolvedModelSelection | null) | null;
  private activePresetValue: string | null = null;
  defaultSelectionSignature: any[] | null = null;
  mcpServers: Record<string, any>;
  mcpStacks: Record<string, any>;
  mcpConnected: boolean;
  mcpConnecting: boolean;
  private browserRegistryInitialized = false;
  private readonly memmyMemoryIntegration: MemmyMemoryIntegration;
  subagentPendingWaitMs = 300_000;
  static readonly RUNTIME_CHECKPOINT_KEY = "runtimeCheckpoint";
  static readonly PENDING_USER_TURN_KEY = "pendingUserTurn";

  constructor(init: AgentLoopInit = {}) {
    this.startTime = Date.now() / 1000;
    this.lastUsageBySession = new Map();
    this.scheduledGoalSessions = new Map();
    this.activeTasks = new Map();
    this.pendingQueues = new Map();
    this.turnSlots = new Map();
    this.sessionDeletionQueues = new Map();
    this.sessionLocks = new Map();
    this.queueMutationLocks = new Map();
    this.queueRevisionBySession = new Map();
    this.queueSteerAdmissionsBySession = new Map();
    this.lastQueuedAtBySession = new Map();
    this.running = false;
    this.providerSnapshotLoader = init.providerSnapshotLoader ?? null;
    this.toolsSnapshotLoader = init.toolsSnapshotLoader ?? null;
    this.presetSnapshotLoader = init.presetSnapshotLoader ?? null;
    this.providerSignature = init.providerSignature ?? null;
    this.defaultSelectionSignature = defaultSelectionSignature(Array.isArray(this.providerSignature) ? this.providerSignature : null);
    this.runtimeModelPublisher = init.runtimeModelPublisher ?? null;
    this.modelSelectionResolver = init.modelSelectionResolver ?? null;
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
    this.fileMemoryEnabled = this.config.fileMemory.enabled;
    const defaults = this.config.agents.defaults;
    this.workspace = path.resolve(getWorkspacePath(init.workspace ?? defaults.workspace ?? process.cwd()));
    this.memmyMemoryIntegration = installMemmyMemory(this.config, {
      workspace: this.workspace,
      hooks: this.extraHooks,
    });
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
      endpoint: "default",
      model: this.model ?? this.provider?.getDefaultModel?.() ?? this.provider?.getDefaultModel?.() ?? defaults.model,
      provider: defaults.provider,
      source: "byok",
      capabilities: ["agent"],
      maxTokens: this.provider?.generation?.maxTokens ?? defaults.maxTokens,
      contextWindowTokens: this.contextWindowTokens,
      temperature: this.provider?.generation?.temperature ?? defaults.temperature,
      reasoningEffort: this.provider?.generation?.reasoningEffort ?? defaults.reasoningEffort,
    });
    const rawPresets = init.modelPresets ?? this.config.modelPresets;
    this.modelPresets = Object.fromEntries(Object.entries(rawPresets).map(([name, preset]) => [name, preset instanceof ModelPresetConfig ? preset : new ModelPresetConfig(preset)]));
    this.unifiedSession = init.unifiedSession ?? defaults.unifiedSession;
    this.sessions = init.sessionManager ?? new SessionManager(
      init.sessionDir ?? path.join(this.workspace, "sessions"),
      { legacyWebuiWorkspaceCwd: this.workspace },
    );
    this.goalRuntime = new GoalRuntime({
      sessions: this.sessions,
      bus: this.bus,
      cancelActiveTasks: (sessionKey) => this.cancelActiveTasks(sessionKey),
      scheduleGoalWork: (sessionKey, goal) => this.scheduleGoalWork(sessionKey, goal),
      invalidateGoalWork: (sessionKey) => this.scheduledGoalSessions.delete(sessionKey),
    });
    this.projectStore = init.projectStore ?? null;
    this.guiTranscriptMirror = init.guiTranscriptMirror ?? null;
    const terminalControlRoot = this.sessions.root
      ?? init.sessionDir
      ?? path.join(this.workspace, "sessions");
    this.terminalTurnLock = new TerminalSessionTurnLock(terminalControlRoot);
    this.terminalRunControl = new TerminalRunControl(terminalControlRoot);
    this.cronService = init.cronService ?? new CronService(path.join(this.workspace, "cron", "jobs.json"));
    this.sessionDagQueue = init.sessionDagQueue ?? this.createSessionDagQueue();
    this.execSessionManager = new ExecSessionManager();
    this.fileStateStore = new FileStateStore();
    this.browserSessionManager = new BrowserSessionManager(
      this.config.tools.browser,
      {
        restrictLocalFiles: Boolean(
          this.config.tools.restrictToWorkspace
          || this.config.tools.exec.sandbox,
        ),
      },
    );
    this.subagents = new SubagentManager({
      provider: this.provider,
      workspace: this.workspace,
      bus: this.bus,
      model: this.model,
      contextWindowTokens: this.contextWindowTokens,
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
      fileMemoryEnabled: this.fileMemoryEnabled,
    });
    this.runner = new AgentRunner();
    this.tools = this.createToolRegistry("init", this.workspace);
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
    this.dream = this.fileMemoryEnabled
      ? new Dream({
          store: this.context.memory,
          provider: this.provider,
          model: this.model ?? "",
        })
      : null;
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

  llmRuntime(modelPreset?: string | null): LLMRuntime {
    if (!this.modelSelectionResolver && modelPreset === undefined) {
      this.refreshProviderSnapshot();
      return new LLMRuntime(this.provider, this.model ?? "");
    }
    const selection = this.resolveTurnModelSelection({
      ...(modelPreset !== undefined ? { requestedPreset: modelPreset } : {}),
    });
    if (!selection) throw new SessionWorkspaceError("model_selection_unavailable");
    return new LLMRuntime(selection.snapshot.provider, selection.snapshot.model);
  }

  static fromConfig(config: Config, bus: MessageBus = new MessageBus(), extra: AgentLoopInit = {}): AgentLoop {
    const runtimeConfig = new Config(config.toObject());
    const defaults = runtimeConfig.agents.defaults;
    const resolved = runtimeConfig.resolvePreset();
    let provider = extra.provider;
    if (!provider) {
      try {
        provider = makeProvider(runtimeConfig);
      } catch {
        // Keep history/settings surfaces available when the model catalog is
        // empty or incomplete. Every real turn is still rejected by the live
        // model resolver before a Session or message is created.
        provider = makeProvider("openai", { model: resolved.model });
      }
    }
    const providerSnapshotLoader = extra.providerSnapshotLoader ?? (extra.provider ? null : makeReloadingProviderSnapshotLoader());
    const toolsSnapshotLoader = extra.toolsSnapshotLoader ?? makeReloadingToolsSnapshotLoader();
    const presetSnapshotLoader = extra.presetSnapshotLoader
      ?? makePresetSnapshotLoader(runtimeConfig, providerSnapshotLoader);
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
      modelSelectionResolver: extra.modelSelectionResolver
        ?? (extra.provider
          ? null
          : (input) => resolveModelSelection(input)),
    });
  }

  sessionKey(message: InboundMessage): string {
    return this.effectiveSessionKey(message);
  }

  private createToolContext(
    capturedSessionWorkspace: string,
    readonlySkillRoots: readonly string[] | undefined,
    messageSendCallback: MessageSendCallback | null = null,
    modelSelection: ResolvedModelSelection | null = null,
  ): ToolContext {
    const subagentManager = modelSelection
      ? this.createTurnSubagentManager(modelSelection)
      : this.subagents;
    return new ToolContext({
      config: this.config.tools,
      workspace: capturedSessionWorkspace,
      bus: this.bus,
      subagentManager,
      cronService: this.cronService,
      sessions: this.sessions,
      execSessionManager: this.execSessionManager,
      fileStateStore: this.fileStateStore,
      browserSessionManager: this.browserSessionManager,
      goalRuntime: this.goalRuntime,
      readonlySkillRoots,
      timezone: this.context.timezone || this.config.agents.defaults.timezone || "UTC",
      runtimeState: this,
      messageSendCallback,
      modelSelectionResolver: this.modelSelectionResolver,
    } as any);
  }

  private createToolRegistry(
    phase: string,
    capturedSessionWorkspace: string,
    {
      includeConnectedMcp = false,
      messageSendCallback = null,
      readonlySkillRoots,
      modelSelection = null,
    }: {
      includeConnectedMcp?: boolean;
      messageSendCallback?: MessageSendCallback | null;
      readonlySkillRoots?: readonly string[];
      modelSelection?: ResolvedModelSelection | null;
    } = {},
  ): ToolRegistryInstance {
    this.refreshToolsSnapshot();
    const toolCtx = this.createToolContext(
      capturedSessionWorkspace,
      readonlySkillRoots,
      messageSendCallback,
      modelSelection ?? null,
    );
    const registry = new ToolLoader({ workspace: this.workspace, ctx: toolCtx }).loadRegistry(toolCtx);
    if (includeConnectedMcp) this.copyConnectedMcpTools(registry);
    this.registerHookTools(toolCtx, phase, registry);
    return registry;
  }

  private createTurnSubagentManager(selection: ResolvedModelSelection): Record<string, any> {
    const manager = this.subagents;
    return {
      get maxConcurrent() {
        return manager.maxConcurrent;
      },
      get maxConcurrentSubagents() {
        return manager.maxConcurrentSubagents;
      },
      getRunningCount: () => manager.getRunningCount(),
      spawn: (input: Record<string, any>) => manager.spawn({
        ...input,
        provider: selection.snapshot.provider,
        model: selection.snapshot.model,
        contextWindowTokens: selection.snapshot.contextWindowTokens,
        modelPreset: selection.preset,
        modelProvider: selection.provider,
        actualModelContext: persistedModelSelection(selection),
      }),
    };
  }

  private projectReadonlySkillRoots(): readonly string[] {
    const roots = [path.join(this.workspace, "skills"), BUILTIN_SKILLS_DIR]
      .flatMap((root) => {
        try {
          return fs.statSync(root).isDirectory() ? [fs.realpathSync(root)] : [];
        } catch {
          return [];
        }
      });
    return Object.freeze([...new Set(roots)]);
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
    capturedSessionWorkspace: string = this.workspace,
    tools: ToolRegistryInstance = this.tools,
  ): void {
    const effectiveKey = sessionKey ?? (this.unifiedSession ? UNIFIED_SESSION_KEY : `${channel}:${chatId}`);
    const projectedBrowserScope = metadata?.webui === true
      && !effectiveKey.startsWith("websocket:")
      ? {
          sessionKey: effectiveKey,
          channel: "projected-session",
          chatId: effectiveKey,
        }
      : null;
    const ctx = new RequestContext({
      channel,
      chatId,
      messageId,
      sessionKey: effectiveKey,
      workspace: capturedSessionWorkspace,
      browserScope: projectedBrowserScope,
      metadata,
    });
    for (const name of tools.toolNames) {
      const tool: any = tools.get(name);
      if (typeof tool?.setContext === "function") tool.setContext(ctx);
    }
  }

  registerDefaultTools(): void {
    this.tools = this.createToolRegistry("refresh", this.workspace);
  }

  async connectMcp(): Promise<void> {
    await connectMissingServers(this as any, this.tools);
  }

  async initializeRuntimeTools(): Promise<void> {
    await this.connectMcp();
    await this.browserSessionManager.initialize();
    if (!this.browserRegistryInitialized) {
      this.tools = this.createToolRegistry("runtime-init", this.workspace, {
        includeConnectedMcp: true,
      });
      this.browserRegistryInitialized = true;
    }
  }

  async closeRuntimeTools(): Promise<void> {
    await this.browserSessionManager.close();
    await this.closeMcp();
    await this.memmyMemoryIntegration.dispose?.();
  }

  async closeBrowserSession(
    sessionKey: string,
    channel: string,
    chatId: string,
  ): Promise<void> {
    const scope: BrowserScope = { sessionKey, channel, chatId };
    await this.browserSessionManager.closeSession(scope);
  }

  async closeBrowserChat(channel: string, chatId: string): Promise<void> {
    await this.browserSessionManager.closeChat(channel, chatId);
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
    const projected = this.guiTranscriptMirror?.sessionKeyForMessage(message) ?? null;
    if (projected) return projected;
    if (this.unifiedSession && !override) return UNIFIED_SESSION_KEY;
    return override ?? message.sessionKey;
  }

  private cloneInboundMessage(
    message: InboundMessage,
    {
      sessionKeyOverride = message.sessionKeyOverride,
      turnAdmission = message.turnAdmission,
      expectedTurnId = message.expectedTurnId,
      turnSource = message.turnSource,
      metadata = message.metadata,
      turnId = null,
    }: {
      sessionKeyOverride?: string | null;
      turnAdmission?: InboundMessage["turnAdmission"];
      expectedTurnId?: string | null;
      turnSource?: TurnSource | null;
      metadata?: Record<string, any>;
      turnId?: string | null;
    } = {},
  ): InboundMessage {
    return new InboundMessage({
      channel: message.channel,
      chatId: message.chatId,
      senderId: message.senderId,
      content: message.content,
      media: message.media,
      metadata: turnId
        ? { ...metadata, ...turnMetadata(turnId) }
        : metadata,
      timestamp: message.timestamp,
      internal: message.internal,
      sessionKey: message.sessionKey,
      sessionKeyOverride,
      turnAdmission,
      expectedTurnId,
      turnSource,
    });
  }

  private busySessionKeysForAutoCompact(): Iterable<string> {
    return new Set([
      ...this.pendingQueues.keys(),
      ...this.turnSlots.keys(),
      ...this.sessionDeletionQueues.keys(),
    ]);
  }

  resolveSessionWorkspace(
    message: InboundMessage,
    session: Session | null,
    reservation: WebuiSessionBinding | null = null,
    trustedOverride: WebuiSessionBinding | null = null,
  ): WebuiSessionBinding {
    let binding: WebuiSessionBinding;
    let requiresAvailabilityCheck = false;
    if (trustedOverride) {
      binding = trustedOverride;
      requiresAvailabilityCheck = true;
    } else if (
      message.channel === "websocket"
      && (
        session?.metadata?.webui === true
        || reservation !== null
        || message.metadata?.webui === true
      )
    ) {
      if (session) {
        binding = readWebuiSessionBinding(session);
      } else if (reservation) {
        binding = reservation;
      } else {
        throw new SessionWorkspaceError("workspace_missing");
      }
      requiresAvailabilityCheck = true;
    } else {
      binding = { projectId: null, cwd: this.workspace };
    }

    if (binding.projectId !== null && this.projectStore) {
      const snapshot = this.projectStore.snapshot();
      if (snapshot.state === "corrupt") {
        throw new SessionWorkspaceError("project_registry_corrupt");
      }
      if (this.projectStore.isDeleting(binding.projectId)) {
        throw new SessionWorkspaceError("project_removed");
      }
    }

    if (!requiresAvailabilityCheck) return binding;

    let canonical: string;
    try {
      canonical = assertWebuiWorkspaceAvailable(binding.cwd);
    } catch (error) {
      if (error instanceof WebuiProjectError) {
        throw new SessionWorkspaceError(
          error.code === "project_directory_unavailable"
            ? "workspace_unavailable"
            : "workspace_missing",
        );
      }
      throw error;
    }
    if (canonical !== binding.cwd) {
      throw new SessionWorkspaceError("workspace_unavailable");
    }
    return { projectId: binding.projectId, cwd: canonical };
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

  async getOrCreateSession(
    sessionKey: string,
    reason = "created",
    requireWebuiBinding = false,
  ): Promise<Session> {
    const usesDefaultGetOrCreate = this.sessions instanceof SessionManager && this.sessions.getOrCreate === SessionManager.prototype.getOrCreate;
    if (!usesDefaultGetOrCreate) return this.sessions.getOrCreate(sessionKey);
    const getWithInfo = this.sessions.getOrCreateWithInfo;
    if (typeof getWithInfo !== "function") return this.sessions.getOrCreate(sessionKey);
    let expectedBinding: WebuiSessionBinding | null = null;
    if (requireWebuiBinding && sessionKey.startsWith("websocket:") && !this.sessions.has(sessionKey)) {
      expectedBinding = this.sessions.peekWebuiSessionBindingReservation(sessionKey);
      if (!expectedBinding) throw new SessionWorkspaceError("workspace_missing");
      if (expectedBinding.projectId !== null && this.projectStore) {
        const snapshot = this.projectStore.snapshot();
        if (snapshot.state === "corrupt") {
          throw new SessionWorkspaceError("project_registry_corrupt");
        }
        if (this.projectStore.isDeleting(expectedBinding.projectId)) {
          throw new SessionWorkspaceError("project_removed");
        }
      }
      let canonical: string;
      try {
        canonical = assertWebuiWorkspaceAvailable(expectedBinding.cwd);
      } catch {
        throw new SessionWorkspaceError("workspace_unavailable");
      }
      if (canonical !== expectedBinding.cwd) {
        throw new SessionWorkspaceError("workspace_unavailable");
      }
    }
    const { session, created } = getWithInfo.call(this.sessions, sessionKey);
    if (created && requireWebuiBinding && sessionKey.startsWith("websocket:")) {
      const binding = this.sessions.consumeWebuiSessionBindingReservation(sessionKey);
      if (
        expectedBinding
        && (
          expectedBinding.projectId !== binding.projectId
          || expectedBinding.cwd !== binding.cwd
        )
      ) {
        this.sessions.delete(sessionKey);
        throw new SessionWorkspaceError("workspace_conflict");
      }
      session.metadata ??= {};
      session.metadata.webui = true;
      session.metadata[WEBUI_PROJECT_ID_METADATA_KEY] = binding.projectId;
      session.metadata[WEBUI_WORKSPACE_CWD_METADATA_KEY] = binding.cwd;
      this.sessions.save(session, { fsync: true });
    }
    if (created) await this.emitSessionStart(session, sessionKey, reason);
    return session;
  }

  static runtimeChatId(msg: InboundMessage): string {
    return String(msg.metadata?.contextChatId ?? msg.chatId);
  }

  runtimeChatId(msg: InboundMessage): string {
    return AgentLoop.runtimeChatId(msg);
  }

  setChannelCapabilitiesResolver(
    resolver: (channel: string) => { supportsStreaming: boolean } | null,
  ): void {
    this.channelCapabilitiesResolver = resolver;
  }

  private resolveChannelCapabilities(channel: string): { supportsStreaming: boolean } | null {
    if (channel === "cli") return { supportsStreaming: false };
    return this.channelCapabilitiesResolver?.(channel) ?? null;
  }

  private renderGoalContinuation(goal: GoalState): string {
    const remainingTokens = goal.tokenBudget === null
      ? "unbounded"
      : Math.max(0, goal.tokenBudget - goal.tokensUsed);
    return renderTemplate("agent/goal-continuation.md", {
      objective: escapeXmlText(goal.objective),
      tokens_used: goal.tokensUsed,
      token_budget: goal.tokenBudget ?? "none",
      remaining_tokens: remainingTokens,
      strip: true,
    });
  }

  scheduleGoalWork(sessionKey: string, goal: GoalState): void {
    if (goal.status !== "active") {
      this.scheduledGoalSessions.delete(sessionKey);
      return;
    }
    this.scheduledGoalSessions.set(sessionKey, {
      goalId: goal.goalId,
      updatedAt: goal.updatedAt,
    });
    if (!(this.activeTasks.get(sessionKey)?.length ?? 0) && !this.goalRuntime.hasGoalLease(sessionKey)) {
      void this.dispatchNextGoalWork(sessionKey);
    }
  }

  private async dispatchNextGoalWork(sessionKey: string): Promise<void> {
    if (
      (this.activeTasks.get(sessionKey)?.length ?? 0) > 0
      || this.goalRuntime.hasGoalLease(sessionKey)
      || this.goalRuntime.hasWorkReservation(sessionKey)
      || this.sessionDeletionQueues.has(sessionKey)
    ) return;
    const scheduled = this.scheduledGoalSessions.get(sessionKey);
    const inbox = this.goalRuntime.inbox(sessionKey);
    if (inbox.length) {
      const turnId = cryptoRandomId();
      if (!this.goalRuntime.reserveWork(sessionKey, turnId, "inbox")) return;
      try {
        const reservation = await this.queueMutationLockFor(sessionKey).runExclusive(async () => {
          const reservedEntry = await this.goalRuntime.reserveInboxEntry(sessionKey, turnId);
          const descriptor = reservedEntry
            ? this.queueDescriptorFromInboxEntry(sessionKey, reservedEntry)
            : null;
          return {
            entry: reservedEntry,
            queueDescriptor: descriptor,
            dequeuedRevision: descriptor
              ? this.advanceQueueRevision(sessionKey)
              : this.queueRevision(sessionKey),
          };
        });
        const { entry, queueDescriptor, dequeuedRevision } = reservation;
        if (!entry) {
          this.goalRuntime.releaseWork(sessionKey, turnId);
          return;
        }
        const metadata = {
          ...entry.metadata,
          ...turnMetadata(turnId),
          ...(entry.metadata.webui_queue_surface === WEBUI_CHAT_COMPOSER_QUEUE_SURFACE
            ? { webui_queue_dequeued: true }
            : {}),
        };
        const inboxMessage = new InboundMessage({
          channel: entry.channel,
          chatId: entry.chatId,
          senderId: entry.senderId,
          content: entry.content,
          media: entry.media,
          metadata,
          timestamp: entry.receivedAt,
          sessionKeyOverride: sessionKey,
          turnSource: parseTurnSource(entry.metadata.turn_source),
        });
        if (queueDescriptor) {
          await this.publishWebuiMessageDequeued(inboxMessage, queueDescriptor, dequeuedRevision);
        }
        await this.bus.publishInbound(inboxMessage);
      } catch (error) {
        this.goalRuntime.releaseWork(sessionKey, turnId);
        throw error;
      }
      return;
    }
    if (!scheduled) return;
    const goal = this.goalRuntime.get(sessionKey);
    const route = this.goalRuntime.route(sessionKey);
    if (
      !goal
      || goal.status !== "active"
      || goal.goalId !== scheduled.goalId
      || goal.updatedAt !== scheduled.updatedAt
      || !route
    ) {
      this.scheduledGoalSessions.delete(sessionKey);
      if (goal?.status === "active" && !route) {
        const blocked = await this.goalRuntime.updateFromModel(sessionKey, goal.goalId, "blocked");
        await this.goalRuntime.flushEffects(sessionKey);
        console.warn("[goal] route unavailable", { sessionKey, goalId: blocked.goalId });
      }
      return;
    }
    const capabilities = this.resolveChannelCapabilities(route.channel);
    if (!capabilities) {
      this.scheduledGoalSessions.delete(sessionKey);
      const blocked = await this.goalRuntime.updateFromModel(sessionKey, goal.goalId, "blocked");
      await this.goalRuntime.flushEffects(sessionKey);
      console.warn("[goal] route unavailable", {
        sessionKey,
        goalId: blocked.goalId,
        channel: route.channel,
      });
      return;
    }
    const turnId = cryptoRandomId();
    if (!this.goalRuntime.reserveWork(sessionKey, turnId, "continuation")) return;
    this.scheduledGoalSessions.delete(sessionKey);
    try {
      await this.bus.publishInbound(new InboundMessage({
        channel: route.channel,
        chatId: route.chatId,
        senderId: "goal-runtime",
        content: this.renderGoalContinuation(goal),
        metadata: {
          webui: route.channel === "websocket"
            && this.sessions.get(sessionKey)?.metadata?.webui === true,
          wantsStream: capabilities.supportsStreaming,
          ...(route.source ? { turn_source: route.source } : {}),
          ...turnMetadata(turnId),
        },
        internal: {
          kind: "goal_continuation",
          goalId: goal.goalId,
          goalUpdatedAt: goal.updatedAt,
        },
        sessionKeyOverride: sessionKey,
        turnSource: route.source ?? null,
      }));
    } catch (error) {
      this.goalRuntime.releaseWork(sessionKey, turnId);
      this.scheduleGoalWork(sessionKey, goal);
      throw error;
    }
  }

  private async recoverGoalWork(): Promise<void> {
    for (const session of this.sessions.listSessionRecords()) {
      const inbox = this.goalRuntime.inbox(session.key);
      if (inbox.some((entry) => entry.turnId !== null)) {
        await this.goalRuntime.resetDispatchingInbox(session.key);
      }
      const goal = readGoalState(session.metadata);
      if (inbox.length) {
        if (goal?.status === "active") this.scheduleGoalWork(session.key, goal);
        else void this.dispatchNextGoalWork(session.key);
        continue;
      }
      if (goal?.status === "active") this.scheduleGoalWork(session.key, goal);
    }
  }

  private async recoverQueueSteerTransfers(): Promise<void> {
    for (const session of this.sessions.listSessionRecords()) {
      const transfers = this.goalRuntime.queueSteerTransfers(session.key)
        .sort((left, right) => (
          left.descriptor.queuedAt.localeCompare(right.descriptor.queuedAt)
          || left.clientRequestId.localeCompare(right.clientRequestId)
        ));
      for (const transfer of transfers) {
        const persisted = session.messages.some((message) => (
          message?.role === "user"
          && message?.client_request_id === transfer.clientRequestId
          && firstString(message?.turn_id, message?.turnId) === transfer.expectedTurnId
        ));
        if (persisted) {
          await this.goalRuntime.completeQueueSteerTransfer(
            session.key,
            transfer.clientRequestId,
          );
          continue;
        }
        let recovered: InboundMessage | null = null;
        let revision = this.queueRevision(session.key);
        await this.queueMutationLockFor(session.key).runExclusive(async () => {
          const queuedAt = this.nextQueuedAt(session.key);
          recovered = this.recoveredQueueMessage(transfer, queuedAt);
          if (transfer.store === "goal") {
            await this.goalRuntime.restoreGoalQueueSteerTransfer(
              session.key,
              transfer.clientRequestId,
              queuedAt,
            );
          } else {
            this.scheduleRecoveredQueueSlot(session.key, recovered);
          }
          revision = this.advanceQueueRevision(session.key);
        });
        if (recovered) {
          await this.publishWebuiMessageQueued(recovered, {
            visible: true,
            revision,
          });
          const recoveredSlot = (this.turnSlots.get(session.key) ?? []).find((slot) => (
            slot.root.metadata?.client_request_id === transfer.clientRequestId
            && slot.root.metadata?.webui_queue_steer_origin !== true
          ));
          recoveredSlot?.announcementGate?.open();
        }
      }
    }
  }

  replayTokenBudget(modelSelection: ResolvedModelSelection | null = null): number {
    const contextWindowTokens = modelSelection?.snapshot.contextWindowTokens
      ?? this.contextWindowTokens;
    const provider = modelSelection?.snapshot.provider ?? this.provider;
    if (contextWindowTokens <= 0) return 0;
    const reserved = Number(provider?.generation?.maxTokens ?? 4096);
    const budget = contextWindowTokens
      - Math.max(1, reserved)
      - CONTEXT_SAFETY_BUFFER_TOKENS;
    return budget > 0 ? budget : Math.max(128, Math.floor(contextWindowTokens / 2));
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

  private queueMutationLockFor(key: string): AsyncMutex {
    let lock = this.queueMutationLocks.get(key);
    if (!lock) {
      lock = new AsyncMutex();
      this.queueMutationLocks.set(key, lock);
    }
    return lock;
  }

  private async tryAdmitDirectSteer(
    sessionKey: string,
    message: InboundMessage,
  ): Promise<string | null> {
    if (message.turnAdmission !== "steer") return null;
    const route = `${message.channel}\0${String(message.chatId)}`;
    const requestedSource = sharedTurnSource(message);
    return this.queueMutationLockFor(sessionKey).runExclusive(async () => {
      const activeSlot = (this.turnSlots.get(sessionKey) ?? []).find((slot) => {
        if (
          slot.state !== "running"
          || !slot.acceptingSteer
          || slot.route !== route
        ) return false;
        if (requestedSource?.kind !== "tui") return true;
        const activeSource = sharedTurnSource(slot.root);
        return slot.turnId === message.expectedTurnId
          && activeSource?.kind === "tui"
          && activeSource.channel === requestedSource.channel;
      });
      if (!activeSlot) return null;
      const steer = this.cloneInboundMessage(
        message,
        requestedSource?.kind === "tui" ? { turnId: activeSlot.turnId } : {},
      );
      try {
        activeSlot.pendingSteer.put(steer);
        return activeSlot.turnId;
      } catch {
        return null;
      }
    });
  }

  private queueRevision(sessionKey: string): number {
    return this.queueRevisionBySession.get(sessionKey) ?? 0;
  }

  private advanceQueueRevision(sessionKey: string): number {
    const revision = this.queueRevision(sessionKey) + 1;
    this.queueRevisionBySession.set(sessionKey, revision);
    return revision;
  }

  private nextQueuedAt(sessionKey: string): string {
    let previous = this.lastQueuedAtBySession.get(sessionKey);
    if (previous === undefined) {
      previous = this.goalRuntime.inbox(sessionKey).reduce((latest, entry) => {
        const value = Date.parse(String(entry.metadata.queued_at ?? entry.receivedAt));
        return Number.isFinite(value) ? Math.max(latest, value) : latest;
      }, 0);
    }
    const next = Math.max(Date.now(), previous + 1);
    this.lastQueuedAtBySession.set(sessionKey, next);
    return new Date(next).toISOString();
  }

  private queueSteerAdmissionsFor(sessionKey: string): Map<string, QueueSteerAdmission> {
    let admissions = this.queueSteerAdmissionsBySession.get(sessionKey);
    if (!admissions) {
      admissions = new Map();
      this.queueSteerAdmissionsBySession.set(sessionKey, admissions);
    }
    return admissions;
  }

  private queueSteerTransferFromMessage(
    sessionKey: string,
    message: InboundMessage,
    descriptor: QueueMessageDescriptor,
    expectedTurnId: string,
    store: "slot" | "goal",
  ): WebuiQueueSteerTransferRecord {
    return {
      clientRequestId: descriptor.clientRequestId,
      expectedTurnId,
      store,
      descriptor: structuredClone(descriptor),
      messageFields: {
        channel: message.channel,
        chatId: message.chatId,
        senderId: message.senderId,
        content: message.content,
        media: [...message.media],
        metadata: structuredClone(message.metadata ?? {}),
        timestamp: message.timestamp.toISOString(),
        sessionKey,
        turnSource: sharedTurnSource(message),
      },
    };
  }

  private messageFromQueueSteerTransfer(
    transfer: WebuiQueueSteerTransferRecord,
    turnId: string,
  ): InboundMessage {
    const fields = transfer.messageFields;
    return new InboundMessage({
      channel: fields.channel,
      chatId: fields.chatId,
      senderId: fields.senderId,
      content: fields.content,
      media: [...fields.media],
      metadata: {
        ...structuredClone(fields.metadata),
        ...turnMetadata(turnId),
        webui_queue_steer_origin: true,
        webui_queue_steer_recovery: {
          client_request_id: transfer.clientRequestId,
          content: transfer.descriptor.content,
          media: [...transfer.descriptor.media],
          source: { ...transfer.descriptor.source },
          queue_surface: transfer.descriptor.queueSurface,
          turn_id: turnId,
        },
      },
      timestamp: new Date(fields.timestamp),
      sessionKeyOverride: fields.sessionKey,
      turnAdmission: "steer",
      expectedTurnId: turnId,
      turnSource: fields.turnSource,
    });
  }

  private removeQueuedSlotTask(sessionKey: string, slot: TurnSlot): void {
    slot.acceptingSteer = false;
    slot.state = "closed";
    slot.announcementGate?.open();
    this.removeTurnSlot(sessionKey, slot);
    const task = slot.dispatchTask;
    if (!task) return;
    const tasks = this.activeTasks.get(sessionKey) ?? [];
    const remaining = tasks.filter((candidate) => candidate !== task);
    if (remaining.length) this.activeTasks.set(sessionKey, remaining);
    else this.activeTasks.delete(sessionKey);
    task.cancel();
  }

  private clearQueueSteerTransferMetadata(session: Session, clientRequestId: string): void {
    const transfers = this.goalRuntime.queueSteerTransfers(session.key)
      .filter((item) => item.clientRequestId !== clientRequestId);
    if (transfers.length) session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY] = transfers;
    else delete session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY];
  }

  private recoveredQueueMessage(
    transfer: WebuiQueueSteerTransferRecord,
    queuedAt: string,
  ): InboundMessage {
    const fields = transfer.messageFields;
    const metadata: Record<string, any> = {
      ...structuredClone(fields.metadata),
      queued_at: queuedAt,
    };
    delete metadata.turn_id;
    delete metadata.turnId;
    delete metadata.webui_queue_dequeued;
    delete metadata.webui_queue_steer_origin;
    delete metadata.webui_queue_steer_recovery;
    return new InboundMessage({
      channel: fields.channel,
      chatId: fields.chatId,
      senderId: fields.senderId,
      content: fields.content,
      media: [...fields.media],
      metadata,
      timestamp: new Date(),
      sessionKeyOverride: fields.sessionKey,
      turnAdmission: "queue",
      turnSource: fields.turnSource,
    });
  }

  private scheduleRecoveredQueueSlot(
    sessionKey: string,
    root: InboundMessage,
  ): TurnSlot {
    const owner = Symbol("queue-steer-recovery-owner");
    const route = `${root.channel}\0${String(root.chatId)}`;
    const slot = this.createTurnSlot(root, route, owner);
    slot.announcementGate = createTurnSlotAnnouncementGate();
    slot.announcedToWebui = true;
    const slots = this.turnSlots.get(sessionKey) ?? [];
    slots.push(slot);
    this.turnSlots.set(sessionKey, slots);
    const task = makeCancelableDispatchTask(
      async (isCancelled, signal) => {
        await slot.announcementGate!.promise;
        if (isCancelled()) return;
        await this.dispatchSlot(sessionKey, slot, isCancelled, signal);
      },
    );
    slot.dispatchTask = task;
    const active = this.activeTasks.get(sessionKey) ?? [];
    active.push(task);
    this.activeTasks.set(sessionKey, active);
    task
      .finally(() => {
        const current = this.activeTasks.get(sessionKey) ?? [];
        const remaining = current.filter((item) => item !== task);
        if (remaining.length) this.activeTasks.set(sessionKey, remaining);
        else this.activeTasks.delete(sessionKey);
        void this.dispatchNextGoalWork(sessionKey);
      })
      .catch(() => undefined);
    return slot;
  }

  private normalizeSharedInboundMessage(message: InboundMessage): InboundMessage {
    let source: TurnSource | null = null;
    if (message.internal) {
      source = sharedTurnSource(message);
    } else if (message.channel === "websocket") {
      const candidate = sharedTurnSource(message);
      if (candidate?.channel === "websocket" && (candidate.kind === "gui" || candidate.kind === "tui")) {
        source = candidate;
      } else if (message.metadata?.webui_queue_surface === WEBUI_CHAT_COMPOSER_QUEUE_SURFACE) {
        source = { kind: "gui", channel: "websocket" };
      }
    } else if (isGuiImChannel(message.channel)) {
      source = { kind: "im", channel: message.channel };
    }
    if (!source) return message;
    const metadata = {
      ...(message.metadata ?? {}),
      turn_source: source,
      ...(
        source.kind === "im" && typeof message.metadata?.client_request_id !== "string"
          ? { client_request_id: randomUUID() }
          : {}
      ),
    };
    return new InboundMessage({
      channel: message.channel,
      chatId: message.chatId,
      senderId: message.senderId,
      content: message.content,
      media: message.media,
      metadata,
      timestamp: message.timestamp,
      internal: message.internal,
      sessionKey: message.sessionKey,
      sessionKeyOverride: message.sessionKeyOverride,
      turnAdmission: message.turnAdmission,
      expectedTurnId: message.expectedTurnId,
      turnSource: source,
    });
  }

  isSessionBusy(sessionKey: string): boolean {
    const tasks = this.activeTasks.get(sessionKey) ?? [];
    const hasActiveTask = tasks.some((task) => {
      if (typeof task?.done === "function") return !task.done();
      return true;
    });
    return hasActiveTask
      || this.pendingQueues.has(sessionKey)
      || (this.turnSlots.get(sessionKey)?.length ?? 0) > 0;
  }

  async getQueueSnapshot(sessionKey: string): Promise<QueueSnapshotDescriptor> {
    return this.queueMutationLockFor(sessionKey).runExclusive(async () => {
      const queued = new Map<string, QueueMessageDescriptor>();
      const started = new Map<string, QueueMessageDescriptor>();
      const add = (
        target: Map<string, QueueMessageDescriptor>,
        descriptor: QueueMessageDescriptor | null,
      ) => {
        if (!descriptor) return;
        target.set(descriptor.clientRequestId, { ...descriptor, sessionKey });
      };

      for (const slot of this.turnSlots.get(sessionKey) ?? []) {
        if (!slot.announcedToWebui || !isSharedQueueMessage(slot.root)) continue;
        const descriptor = this.queueDescriptorFromMessage(slot.root);
        if (slot.state === "queued") add(queued, descriptor);
        else if (
          (slot.state === "running" || slot.state === "settling")
          && slot.rootDelivery === "pending"
        ) add(started, descriptor);
      }

      for (const entry of this.goalRuntime.inbox(sessionKey)) {
        const descriptor = this.queueDescriptorFromInboxEntry(sessionKey, entry);
        if (entry.turnId === null) add(queued, descriptor);
        else add(started, descriptor);
      }

      for (const admission of this.queueSteerAdmissionsBySession.get(sessionKey)?.values() ?? []) {
        add(started, {
          ...admission.descriptor,
          turnAdmission: "steer",
          turnId: admission.turnId,
        });
      }

      for (const clientRequestId of started.keys()) queued.delete(clientRequestId);
      const ordered = (items: Iterable<QueueMessageDescriptor>) => [...items].sort((left, right) => (
        left.queuedAt.localeCompare(right.queuedAt)
        || left.clientRequestId.localeCompare(right.clientRequestId)
      ));
      return {
        revision: this.queueRevision(sessionKey),
        items: ordered(queued.values()),
        startedItems: ordered(started.values()),
      };
    });
  }

  async getWebuiQueueSnapshot(sessionKey: string): Promise<QueueSnapshotDescriptor> {
    return this.getQueueSnapshot(sessionKey);
  }

  async removeQueuedMessage(
    sessionKey: string,
    clientRequestId: string,
  ): Promise<RemoveQueuedMessageResult> {
    let removedInbox = false;
    const result = await this.queueMutationLockFor(sessionKey).runExclusive(async () => {
      if (this.queueSteerAdmissionsBySession.get(sessionKey)?.has(clientRequestId)) {
        return {
          outcome: "already_dequeued" as const,
          revision: this.queueRevision(sessionKey),
        };
      }
      const slot = (this.turnSlots.get(sessionKey) ?? []).find((candidate) => (
        candidate.root.metadata?.client_request_id === clientRequestId
        && isSharedQueueMessage(candidate.root)
      ));
      if (slot) {
        if (slot.state !== "queued" || !slot.announcedToWebui) {
          return { outcome: "already_dequeued" as const, revision: this.queueRevision(sessionKey) };
        }
        slot.acceptingSteer = false;
        slot.state = "closed";
        slot.announcementGate?.open();
        this.removeTurnSlot(sessionKey, slot);
        const task = slot.dispatchTask;
        if (task) {
          const tasks = this.activeTasks.get(sessionKey) ?? [];
          const remaining = tasks.filter((candidate) => candidate !== task);
          if (remaining.length) this.activeTasks.set(sessionKey, remaining);
          else this.activeTasks.delete(sessionKey);
          task.cancel();
        }
        return { outcome: "removed" as const, revision: this.advanceQueueRevision(sessionKey) };
      }

      let inboxResult: "removed" | "reserved" | "missing" = "missing";
      try {
        inboxResult = await this.goalRuntime.removeUnreservedInboxEntry(sessionKey, clientRequestId);
      } catch (error) {
        if (!(error instanceof GoalRuntimeError) || error.code !== "goal_not_found") throw error;
      }
      if (inboxResult === "removed") {
        removedInbox = true;
        return { outcome: "removed" as const, revision: this.advanceQueueRevision(sessionKey) };
      }
      if (inboxResult === "reserved") {
        return { outcome: "already_dequeued" as const, revision: this.queueRevision(sessionKey) };
      }

      const session = this.sessions.get(sessionKey);
      const accepted = session?.messages.some((message) => (
        message?.role === "user"
        && message?.client_request_id === clientRequestId
      ));
      return {
        outcome: accepted ? "already_dequeued" as const : "missing" as const,
        revision: this.queueRevision(sessionKey),
      };
    });
    if (removedInbox) void this.dispatchNextGoalWork(sessionKey);
    return result;
  }

  async removeQueuedWebuiMessage(
    sessionKey: string,
    clientRequestId: string,
  ): Promise<RemoveQueuedMessageResult> {
    return this.removeQueuedMessage(sessionKey, clientRequestId);
  }

  async steerQueuedWebuiMessage(
    sessionKey: string,
    clientRequestId: string,
    expectedTurnId: string,
  ): Promise<SteerQueuedMessageResult> {
    const result = await this.queueMutationLockFor(sessionKey).runExclusive(async () => {
      const revision = this.queueRevision(sessionKey);
      if (this.queueSteerAdmissionsBySession.get(sessionKey)?.has(clientRequestId)) {
        return { outcome: "already_dequeued" as const, revision };
      }
      const slots = this.turnSlots.get(sessionKey) ?? [];
      const activeGoal = this.goalRuntime.get(sessionKey);
      const activeGoalRoute = this.goalRuntime.route(sessionKey);
      const activeSlot = slots.find((slot) => {
        const source = sharedTurnSource(slot.root);
        const ownsGuiTurn = source?.kind === "gui" && source.channel === "websocket";
        const ownsLegacyGuiGoalTurn = !source
          && activeGoal?.status === "active"
          && activeGoalRoute?.channel === slot.root.channel
          && activeGoalRoute.chatId === slot.root.chatId;
        return slot.turnId === expectedTurnId
          && slot.state === "running"
          && slot.acceptingSteer
          && (ownsGuiTurn || ownsLegacyGuiGoalTurn);
      });
      if (!activeSlot) return { outcome: "not_steerable" as const, revision };

      const queuedSlot = slots.find((slot) => (
        slot.root.metadata?.client_request_id === clientRequestId
        && isSharedQueueMessage(slot.root)
      ));
      if (queuedSlot) {
        if (queuedSlot.state !== "queued" || !queuedSlot.announcedToWebui) {
          return { outcome: "already_dequeued" as const, revision };
        }
        const rawDescriptor = this.queueDescriptorFromMessage(queuedSlot.root);
        const descriptor = rawDescriptor ? { ...rawDescriptor, sessionKey } : null;
        const source = sharedTurnSource(queuedSlot.root);
        if (
          !descriptor
          || descriptor.queueSurface !== WEBUI_CHAT_COMPOSER_QUEUE_SURFACE
          || source?.kind !== "gui"
          || source.channel !== "websocket"
          || queuedSlot.route !== activeSlot.route
          || queuedSlot.root.content.trimStart().startsWith("/")
        ) {
          return { outcome: "not_steerable" as const, revision };
        }
        const session = this.sessions.get(sessionKey);
        if (!session) return { outcome: "not_steerable" as const, revision };
        const transfers = this.goalRuntime.queueSteerTransfers(sessionKey);
        const transfer = this.queueSteerTransferFromMessage(
          sessionKey,
          queuedSlot.root,
          descriptor,
          expectedTurnId,
          "slot",
        );
        session.metadata[WEBUI_QUEUE_STEER_TRANSFERS_KEY] = [
          ...transfers.filter((item) => item.clientRequestId !== clientRequestId),
          transfer,
        ];
        this.sessions.save(session, { fsync: true });

        const steer = this.messageFromQueueSteerTransfer(transfer, expectedTurnId);
        activeSlot.pendingSteer.put(steer);
        this.removeQueuedSlotTask(sessionKey, queuedSlot);
        const nextRevision = this.advanceQueueRevision(sessionKey);
        this.queueSteerAdmissionsFor(sessionKey).set(clientRequestId, {
          turnId: expectedTurnId,
          revision: nextRevision,
          descriptor,
          message: steer,
          store: "slot",
          phase: "pending",
        });
        return {
          outcome: "steered" as const,
          revision: nextRevision,
          turnId: expectedTurnId,
          descriptor: {
            ...descriptor,
            turnAdmission: "steer" as const,
            turnId: expectedTurnId,
          },
        };
      }

      const inboxEntry = this.goalRuntime.inbox(sessionKey).find((entry) => (
        entry.id === clientRequestId
      ));
      if (inboxEntry?.turnId !== null && inboxEntry) {
        return { outcome: "already_dequeued" as const, revision };
      }
      const goalResult = await this.goalRuntime.beginQueueSteerTransfer(
        sessionKey,
        clientRequestId,
        expectedTurnId,
        WEBUI_CHAT_COMPOSER_QUEUE_SURFACE,
        {
          channel: activeSlot.root.channel,
          chatId: activeSlot.root.chatId,
        },
      ).catch((error) => {
        if (error instanceof GoalRuntimeError && error.code === "goal_not_found") {
          return { outcome: "missing" as const };
        }
        throw error;
      });
      if (goalResult.outcome === "reserved") {
        return { outcome: "already_dequeued" as const, revision };
      }
      if (goalResult.outcome !== "transferred" || !goalResult.transfer) {
        const session = this.sessions.get(sessionKey);
        const accepted = session?.messages.some((message) => (
          message?.role === "user"
          && message?.client_request_id === clientRequestId
        ));
        return {
          outcome: accepted
            ? "already_dequeued" as const
            : goalResult.outcome === "not_steerable"
              ? "not_steerable" as const
              : "missing" as const,
          revision,
        };
      }
      const descriptor = goalResult.transfer.descriptor as QueueMessageDescriptor;
      const steer = this.messageFromQueueSteerTransfer(goalResult.transfer, expectedTurnId);
      activeSlot.pendingSteer.put(steer);
      const nextRevision = this.advanceQueueRevision(sessionKey);
      this.queueSteerAdmissionsFor(sessionKey).set(clientRequestId, {
        turnId: expectedTurnId,
        revision: nextRevision,
        descriptor,
        message: steer,
        store: "goal",
        phase: "pending",
      });
      return {
        outcome: "steered" as const,
        revision: nextRevision,
        turnId: expectedTurnId,
        descriptor: {
          ...descriptor,
          turnAdmission: "steer" as const,
          turnId: expectedTurnId,
        },
      };
    });

    return result;
  }

  isSessionGoalActive(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    return readGoalState(session?.metadata ?? null)?.status === "active";
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

  resolveTurnModelSelection(input: ModelSelectionInput): ResolvedModelSelection | null {
    if (this.modelSelectionResolver) {
      try {
        return this.modelSelectionResolver(input);
      } catch {
        return null;
      }
    }

    const defaultPreset = this.activePresetValue
      ?? this.config.agents.defaults.modelPreset
      ?? "default";
    let selected = defaultPreset;
    if (Object.prototype.hasOwnProperty.call(input, "requestedPreset")) {
      if (input.requestedPreset) {
        try {
          selected = this.normalizedPresetName(input.requestedPreset);
        } catch {
          return null;
        }
      }
    } else if (input.sessionPreset) {
      try {
        selected = this.normalizedPresetName(input.sessionPreset);
      } catch {
        return null;
      }
    }

    try {
      const snapshot = !this.modelSelectionResolver && selected === "default"
        ? {
            provider: this.provider,
            model: this.model ?? this.defaultModelPreset.model,
            contextWindowTokens: this.contextWindowTokens,
            signature: ["default", this.model ?? this.defaultModelPreset.model]
          }
        : this.buildModelPresetSnapshot(selected);
      const provider = String(
        snapshot.provider?.spec?.name
        ?? snapshot.provider?.name
        ?? this.config.getProviderName(snapshot.model, {
          preset: selected === "default"
            ? this.defaultModelPreset
            : this.modelPresets[selected],
        })
        ?? "unknown",
      );
      const preset = selected === "default"
        ? this.defaultModelPreset
        : this.modelPresets[selected];
      const endpoint = this.config.providers[provider]?.endpoints[preset.endpoint];
      return {
        preset: selected,
        presetId: selected,
        provider,
        endpointId: preset.endpoint,
        protocol: endpoint?.protocol ?? "openai-chat-completions",
        model: String(snapshot.model),
        source: preset.source,
        ownerAccountId: preset.ownerAccountId ?? null,
        capability: "agent",
        capabilities: Object.freeze([...preset.capabilities]),
        providerConfig: Object.freeze({
          provider,
          endpointId: preset.endpoint,
          protocol: endpoint?.protocol ?? "openai-chat-completions",
          apiBase: endpoint?.apiBase ?? "",
          ...(endpoint?.apiKey ?? this.config.providers[provider]?.apiKey
            ? { apiKey: endpoint?.apiKey ?? this.config.providers[provider]?.apiKey ?? undefined }
            : {}),
          ownerAccountId: this.config.providers[provider]?.ownerAccountId ?? null,
          extraHeaders: Object.freeze(mergedRuntimeRecord(
            this.config.providers[provider]?.extraHeaders,
            endpoint?.extraHeaders,
          )),
          extraBody: Object.freeze(mergedRuntimeRecord(
            this.config.providers[provider]?.extraBody,
            endpoint?.extraBody,
          )),
        }),
        snapshot: {
          provider: snapshot.provider,
          model: String(snapshot.model),
          contextWindowTokens: Number(snapshot.contextWindowTokens),
          signature: Array.isArray(snapshot.signature) ? snapshot.signature : [snapshot.signature],
        },
      };
    } catch {
      return null;
    }
  }

  private persistedSessionSelection(session: Session | null): ModelSelectionInput {
    const committedSelection = committedSelectionFromMetadata(session?.metadata);
    if (committedSelection) return { committedSelection };
    return {
      sessionPreset: typeof session?.metadata?.modelPreset === "string"
        ? session.metadata.modelPreset
        : null,
    };
  }

  /**
   * Persists a TUI/CLI model choice while the caller already owns this Session's turn lock.
   *
   * This method deliberately does not acquire the lock itself; command dispatch runs inside
   * the same ordered Session turn as ordinary messages.
   */
  applySessionModelPresetLocked(session: Session, requestedPreset: string): ResolvedModelSelection {
    const selection = this.resolveTurnModelSelection({ requestedPreset });
    if (!selection || selection.preset !== requestedPreset) {
      throw new Error(`Unknown or unavailable model preset '${requestedPreset}'`);
    }
    session.metadata.modelPreset = selection.preset;
    session.metadata.modelSelection = persistedModelSelection(selection);
    this.sessions.save(session, { fsync: true });
    this.guiTranscriptMirror?.sessionUpdated(session.key);
    return selection;
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
    if (typeof (this.subagents as any)?.setProvider === "function") {
      (this.subagents as any).setProvider(provider, model, contextWindowTokens);
    }
    else if (this.subagents) (this.subagents as any).model = model;
    if (typeof (this.consolidator as any)?.setProvider === "function") (this.consolidator as any).setProvider(provider, model, contextWindowTokens);
    else (this.consolidator as any).model = model;
    if (this.dream) {
      if (typeof (this.dream as any).setProvider === "function") {
        (this.dream as any).setProvider(provider, model);
      } else {
        (this.dream as any).model = model;
      }
    }
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

  async stopExpectedTurn(
    sessionKey: string,
    expectedTurnId: string,
    requiredSource: TurnSource["kind"] = "tui",
  ): Promise<StopExpectedTurnResult> {
    const result = await this.queueMutationLockFor(sessionKey).runExclusive(async () => {
      const slot = (this.turnSlots.get(sessionKey) ?? []).find((candidate) => (
        candidate.turnId === expectedTurnId
        && (candidate.state === "running" || candidate.state === "settling")
      ));
      if (!slot) return { outcome: "already_finished" as const, task: null };
      if (sharedTurnSource(slot.root)?.kind !== requiredSource) {
        return { outcome: "not_owned" as const, task: null };
      }
      return { outcome: "stopped" as const, task: slot.dispatchTask };
    });
    const { outcome, task } = result;
    if (outcome !== "stopped") return outcome;
    if (!task || task.done() || task.cancel() === false) return "already_finished";
    await Promise.resolve(task).catch(() => undefined);
    const subagents = this.subagents as any;
    if (typeof subagents?.cancelBySession === "function") {
      await subagents.cancelBySession(sessionKey);
    } else if (typeof subagents?.cancel_by_session === "function") {
      await subagents.cancel_by_session(sessionKey);
    }
    return "stopped";
  }

  private async pendingToUserMessage(msg: InboundMessage): Promise<Record<string, any> | null> {
    let content = msg.content;
    let media = msg.media ?? [];
    if (media.length) [content, media] = await extractDocuments(content, media);
    const hasText = typeof content === "string" && content.trim().length > 0;
    if (!hasText && !media.length) return null;
    const clientRequestId = typeof msg.metadata?.client_request_id === "string"
      ? msg.metadata.client_request_id
      : null;
    const queueSteerOrigin = msg.metadata?.webui_queue_steer_origin === true
      && clientRequestId !== null;
    if (queueSteerOrigin) {
      const admission = this.queueSteerAdmissionsBySession
        .get(this.effectiveSessionKey(msg))
        ?.get(clientRequestId);
      if (admission?.phase === "pending") admission.phase = "consumed";
    }
    return {
      role: "user",
      content: this.context.buildUserContent(content, media),
      ...(clientRequestId
        ? { client_request_id: clientRequestId }
        : {}),
      ...(queueSteerOrigin && typeof msg.metadata?.webui_request_digest === "string"
        ? { webui_request_digest: msg.metadata.webui_request_digest }
        : {}),
      ...(firstString(msg.metadata?.turn_id, msg.metadata?.turnId)
        ? { turn_id: firstString(msg.metadata?.turn_id, msg.metadata?.turnId) }
        : {}),
      ...(sharedTurnSource(msg) ? { turn_source: sharedTurnSource(msg) } : {}),
      ...(queueSteerOrigin ? { webui_queue_steer_origin: true } : {}),
      ...(queueSteerOrigin && msg.metadata?.webui_queue_steer_recovery
        ? { webui_queue_steer_recovery: structuredClone(msg.metadata.webui_queue_steer_recovery) }
        : {}),
    };
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

  private appendUserMessage(
    msg: InboundMessage,
    session: Session,
    extra: Record<string, any> = {},
    timestamp?: string,
  ): boolean {
    const mediaPaths = (msg.media ?? []).filter((item) => typeof item === "string" && item);
    const hasText = typeof msg.content === "string" && msg.content.trim().length > 0;
    if (!hasText && !mediaPaths.length) return false;
    if (
      typeof msg.metadata?.client_request_id === "string"
      && msg.metadata?.webui_queue_steer_origin !== true
    ) {
      this.clearQueueSteerTransferMetadata(session, msg.metadata.client_request_id);
    }
    const metadataExtra = {
      ...(mediaPaths.length ? { media: [...mediaPaths] } : {}),
      ...mcpSessionExtra(msg.metadata),
      ...(typeof msg.metadata?.client_request_id === "string"
        ? {
            client_request_id: msg.metadata.client_request_id,
            webui_request_digest: msg.metadata.webui_request_digest,
          }
        : {}),
      ...(
        firstString(msg.metadata?.turn_id, msg.metadata?.turnId)
          ? { turn_id: firstString(msg.metadata?.turn_id, msg.metadata?.turnId) }
          : {}
      ),
      ...(sharedTurnSource(msg) ? { turn_source: sharedTurnSource(msg) } : {}),
      ...(typeof msg.metadata?.model_preset === "string"
        ? {
            model_preset: msg.metadata.model_preset,
            model_provider: msg.metadata.model_provider ?? null,
            model: msg.metadata.model ?? null,
            model_selection: msg.metadata.model_selection ?? null,
          }
        : {}),
      ...extra,
    };
    session.addMessage("user", typeof msg.content === "string" ? msg.content : "", metadataExtra);
    if (timestamp) session.messages.at(-1)!.timestamp = timestamp;
    this.markPendingUserTurn(session);
    return true;
  }

  persistUserMessageEarly(msg: InboundMessage, session: Session, extra: Record<string, any> = {}): boolean {
    if (!this.appendUserMessage(msg, session, extra)) return false;
    this.sessions.save(session, {
      fsync: typeof msg.metadata?.client_request_id === "string",
    });
    return true;
  }

  private persistGoalContinuationContext(ctx: TurnContext): boolean {
    const content = ctx.msg.content;
    if (!content.trim()) return false;
    ctx.session!.addMessage("user", content, {
      internal_context: "goal_continuation",
      ...(sharedTurnSource(ctx.msg) ? { turn_source: sharedTurnSource(ctx.msg) } : {}),
    });
    this.sessions.save(ctx.session!, { fsync: true });
    return true;
  }

  private queueDescriptorFromMessage(msg: InboundMessage): QueueMessageDescriptor | null {
    const clientRequestId = msg.metadata?.client_request_id;
    const source = sharedTurnSource(msg);
    const queuedAt = msg.metadata?.queued_at;
    if (typeof clientRequestId !== "string" || !source || typeof queuedAt !== "string") return null;
    return {
      clientRequestId,
      content: msg.content,
      media: [...msg.media],
      queuedAt,
      sessionKey: msg.sessionKey,
      source,
      queueSurface: msg.metadata?.webui_queue_surface === WEBUI_CHAT_COMPOSER_QUEUE_SURFACE
        ? WEBUI_CHAT_COMPOSER_QUEUE_SURFACE
        : null,
    };
  }

  private queueDescriptorFromInboxEntry(
    sessionKey: string,
    entry: GoalTurnInboxEntry,
  ): QueueMessageDescriptor | null {
    const source = parseTurnSource(entry.metadata.turn_source);
    const queuedAt = entry.metadata.queued_at;
    if (typeof entry.metadata.client_request_id !== "string" || !source || typeof queuedAt !== "string") return null;
    return {
      clientRequestId: entry.metadata.client_request_id,
      content: entry.content,
      media: [...entry.media],
      queuedAt,
      sessionKey,
      source,
      queueSurface: entry.metadata.webui_queue_surface === WEBUI_CHAT_COMPOSER_QUEUE_SURFACE
        ? WEBUI_CHAT_COMPOSER_QUEUE_SURFACE
        : null,
    };
  }

  async publishWebuiMessageQueued(
    msg: InboundMessage,
    { visible = false, revision = this.queueRevision(this.effectiveSessionKey(msg)) }: {
      visible?: boolean;
      revision?: number;
    } = {},
  ): Promise<void> {
    const clientRequestId = msg.metadata?.client_request_id;
    if (typeof clientRequestId !== "string" || !sharedTurnSource(msg)) return;
    const item = visible ? this.queueDescriptorFromMessage(msg) : null;
    await this.bus.publishOutbound(
      new OutboundMessage({
        channel: "websocket",
        chatId: msg.chatId,
        content: "",
        metadata: {
          webuiMessageQueued: true,
          webuiRequestSessionKey: msg.sessionKey,
          clientRequestId,
          queueRevision: revision,
          ...(item ? { webuiQueueItem: item } : {}),
        },
      }),
    );
  }

  async publishWebuiMessageDequeued(
    msg: InboundMessage,
    descriptor = this.queueDescriptorFromMessage(msg),
    revision = this.queueRevision(descriptor?.sessionKey ?? this.effectiveSessionKey(msg)),
  ): Promise<void> {
    if (!descriptor) return;
    await this.bus.publishOutbound(
      new OutboundMessage({
        channel: "websocket",
        chatId: msg.chatId,
        content: "",
        metadata: {
          webuiMessageDequeued: true,
          webuiRequestSessionKey: descriptor.sessionKey,
          clientRequestId: descriptor.clientRequestId,
          webuiQueueItem: descriptor,
          queueRevision: revision,
          ...(descriptor.turnAdmission ? { turnAdmission: descriptor.turnAdmission } : {}),
          ...(descriptor.turnId ? { turnId: descriptor.turnId } : {}),
        },
      }),
    );
  }

  async publishWebuiMessageQueueRemoved(
    msg: InboundMessage,
    revision: number,
  ): Promise<void> {
    const clientRequestId = msg.metadata?.client_request_id;
    if (typeof clientRequestId !== "string" || !sharedTurnSource(msg)) return;
    await this.bus.publishOutbound(
      new OutboundMessage({
        channel: "websocket",
        chatId: msg.chatId,
        content: "",
        metadata: {
          webuiMessageQueueRemoved: true,
          webuiRequestSessionKey: msg.sessionKey,
          clientRequestId,
          queueRevision: revision,
        },
      }),
    );
  }

  async publishWebuiMessageSteered(
    msg: InboundMessage,
    turnId: string,
    { queueOrigin = false }: { queueOrigin?: boolean } = {},
  ): Promise<void> {
    const clientRequestId = msg.metadata?.client_request_id;
    if (msg.channel !== "websocket" || typeof clientRequestId !== "string") return;
    await this.bus.publishOutbound(
      new OutboundMessage({
        channel: "websocket",
        chatId: msg.chatId,
        content: "",
        metadata: {
          webuiMessageSteered: true,
          webuiRequestSessionKey: msg.sessionKey,
          clientRequestId,
          turnId,
          steeredContent: msg.content,
          steeredMedia: [...msg.media],
          ...(queueOrigin ? { queueOrigin: true } : {}),
          ...(sharedTurnSource(msg) ? { turnSource: sharedTurnSource(msg) } : {}),
        },
      }),
    );
  }

  async publishWebuiMessageAccepted(msg: InboundMessage, slot: TurnSlot | null = null): Promise<void> {
    const clientRequestId = msg.metadata?.client_request_id;
    if (msg.channel === "websocket" && typeof clientRequestId === "string") {
      await this.bus.publishOutbound(
        new OutboundMessage({
          channel: "websocket",
          chatId: msg.chatId,
          content: "",
          metadata: {
            webuiMessageAccepted: true,
            webuiRequestSessionKey: slot?.root.sessionKey ?? msg.sessionKey,
            clientRequestId,
            ...(firstString(msg.metadata?.turn_id, msg.metadata?.turnId)
              ? { turnId: firstString(msg.metadata?.turn_id, msg.metadata?.turnId) }
              : {}),
            ...(msg.metadata?.webui_queue_steer_recovery
              ? { queueSteerRecovery: msg.metadata.webui_queue_steer_recovery }
              : {}),
            modelPreset: msg.metadata?.model_preset ?? null,
            modelProvider: msg.metadata?.model_provider ?? null,
            model: msg.metadata?.model ?? null,
            modelSelection: msg.metadata?.model_selection ?? null,
          },
        }),
      );
    }
    if (slot && (slot.root === msg || slot.root.metadata?.client_request_id === clientRequestId)) {
      const matchedSlot = slot;
      await this.queueMutationLockFor(this.effectiveSessionKey(matchedSlot.root)).runExclusive(async () => {
        matchedSlot.rootDelivery = "accepted";
      });
    }
  }

  async publishWebuiMessageRejected(
    msg: InboundMessage,
    reason: string,
    slot: TurnSlot | null = null,
  ): Promise<void> {
    const clientRequestId = msg.metadata?.client_request_id;
    if (msg.channel === "websocket" && typeof clientRequestId === "string") {
      await this.bus.publishOutbound(
        new OutboundMessage({
          channel: "websocket",
          chatId: msg.chatId,
          content: "",
          metadata: {
            webuiMessageRejected: true,
            webuiRequestSessionKey: slot?.root.sessionKey ?? msg.sessionKey,
            clientRequestId,
            reason,
          },
        }),
      );
    }
    if (slot && (slot.root === msg || slot.root.metadata?.client_request_id === clientRequestId)) {
      const matchedSlot = slot;
      await this.queueMutationLockFor(this.effectiveSessionKey(matchedSlot.root)).runExclusive(async () => {
        matchedSlot.rootDelivery = "rejected";
      });
    }
  }

  localizeUserFacingApiError(
    channel: string,
    metadata: Record<string, any> | null | undefined,
    session: Session | null | undefined,
    content: string | null | undefined,
    stopReason: string,
    errorCategory: ProviderErrorCategory | null = null,
  ): string | null {
    const language = metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? session?.metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? null;
    if (stopReason === "error" && errorCategory === "image_input_unsupported") {
      return usesChineseWebuiLanguage(language)
        ? IMAGE_INPUT_UNSUPPORTED_ZH
        : IMAGE_INPUT_UNSUPPORTED_EN;
    }
    if (stopReason === "error" && errorCategory === "image_analysis_failed") {
      return usesChineseWebuiLanguage(language)
        ? IMAGE_ANALYSIS_FAILED_ZH
        : IMAGE_ANALYSIS_FAILED_EN;
    }
    if (!isWebuiVisible(channel, metadata)) return content ?? null;
    if (stopReason === "error" && errorCategory === "quota_exhausted") {
      return quotaApiErrorFallback(language);
    }
    if (!isUserFacingApiError(content, stopReason)) return content ?? null;
    return platformApiErrorFallback(language);
  }

  buildInitialMessages(
    msg: InboundMessage,
    session: Session,
    history: Record<string, any>[],
    pendingSummary: string | null,
    sessionWorkspace: string,
  ): Record<string, any>[] {
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
      sessionWorkspace,
    });
  }

  private sessionSummaryText(session: Session): string | null {
    const summary = session.metadata?.lastSummary;
    if (typeof summary === "string") return summary;
    return summary && typeof summary === "object" && typeof summary.text === "string"
      ? summary.text
      : null;
  }

  private createMidTurnContextDescriptor(
    session: Session,
    initialMessages: Record<string, any>[],
    sessionTailMessagesRepresentedInTranscript: number,
    modelSelection: ResolvedModelSelection | null,
    buildMessages: (
      history: Record<string, any>[],
      summary: string | null,
      currentSession: Session,
    ) => Record<string, any>[],
  ): MidTurnContextDescriptor {
    const protectedTailCount = Math.max(
      0,
      Math.min(sessionTailMessagesRepresentedInTranscript, session.messages.length),
    );
    const protectedSessionMessageStart = session.messages.length - protectedTailCount;
    return {
      transcriptStartIndex: Math.max(0, initialMessages.length - 1),
      protectedSessionMessageStart,
      sessionTailMessagesRepresentedInTranscript: protectedTailCount,
      rebuildProjection: (currentSession, currentTurnMessages, options = {}) => {
        const visibleMessageStart = Math.max(
          0,
          Math.min(options.visibleMessageStart ?? currentSession.lastConsolidated, currentSession.messages.length),
        );
        const view = new Session({
          key: currentSession.key,
          messages: currentSession.messages,
          metadata: currentSession.metadata,
          lastConsolidated: visibleMessageStart,
          createdAt: currentSession.createdAt,
          updatedAt: currentSession.updatedAt,
        });
        const visibleHistory = view.getHistory({
          maxMessages: this.maxMessages,
          maxTokens: this.replayTokenBudget(modelSelection),
          includeTimestamps: true,
          targetProvider: modelSelection?.provider,
        });
        const retainedHistory = protectedTailCount > 0
          ? visibleHistory.slice(0, Math.max(0, visibleHistory.length - protectedTailCount))
          : visibleHistory;
        const hasSummaryOverride = Object.prototype.hasOwnProperty.call(options, "summaryOverride");
        const summary = hasSummaryOverride
          ? options.summaryOverride ?? null
          : this.sessionSummaryText(currentSession);
        const rebuilt = buildMessages(retainedHistory, summary, currentSession);
        const systemMessages = rebuilt.filter((message) => message.role === "system");
        return [
          ...systemMessages,
          ...retainedHistory,
          ...currentTurnMessages.map((message) => ({ ...message })),
        ];
      },
    };
  }

  private async compactBeforeFollowupModelRequest(
    session: Session,
    consolidator: Consolidator,
    descriptor: MidTurnContextDescriptor,
    request: FollowupModelRequestContext,
    onCompactionEvent: TokenCompactionEventCallback | null,
  ): Promise<FollowupModelContextUpdate> {
    if (request.inputTokenBudget == null || request.inputTokenBudget <= 0) return null;
    try {
      const result = await consolidator.maybeConsolidateByTokens(session, {
        replayMaxMessages: this.maxMessages,
        inputTokenBudget: request.inputTokenBudget,
        maxMessageEndExclusive: descriptor.protectedSessionMessageStart,
        estimateProjectionTokens: (candidateSession, projection) => {
          const messages = descriptor.rebuildProjection(
            candidateSession,
            request.currentTurnMessages,
            projection,
          );
          return [request.estimatePromptTokens(messages), "runner-live"];
        },
        ...(onCompactionEvent
          ? {
              notifyOnLockWait: true,
              onCompactionEvent,
            }
          : {}),
      });
      if (!result.changed) return null;
      const currentSession = this.sessions.get(session.key) ?? session;
      try {
        return {
          messages: descriptor.rebuildProjection(
            currentSession,
            request.currentTurnMessages,
          ),
        };
      } catch {
        try {
          await onCompactionEvent?.({
            kind: "token",
            status: "error",
            replayMaxMessages: this.maxMessages,
            changed: true,
          });
        } catch {
          // UI notification is best-effort and must not affect the active turn.
        }
        return null;
      }
    } catch {
      return null;
    }
  }

  async dispatchCommandInline(msg: InboundMessage, key: string, raw: string, dispatchFn: (ctx: CommandContext) => Promise<OutboundMessage | null> | OutboundMessage | null): Promise<void> {
    const result = await dispatchFn(new CommandContext({ msg, session: null, key, raw, loop: this }));
    if (!result) return;
    const source = sharedTurnSource(msg);
    if (
      msg.channel === "websocket"
      && source?.kind === "tui"
      && typeof msg.metadata?.client_request_id === "string"
    ) {
      result.metadata = { ...(result.metadata ?? {}), turn_source: source };
      await this.publishWebuiMessageAccepted(msg);
    }
    await this.bus.publishOutbound(result);
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

  saveTurn(
    session: Session,
    messages: Record<string, any>[],
    skip: number,
    {
      turnLatencyMs,
      modelPreset,
      modelProvider,
      modelName,
      modelSelection,
      modelError,
    }: {
      turnLatencyMs?: number;
      modelPreset?: string | null;
      modelProvider?: string | null;
      modelName?: string | null;
      modelSelection?: ResolvedModelSelection | null;
      modelError?: UserFacingModelError | null;
    } = {},
  ): void {
    let lastAssistantIdx: number | null = null;
    for (const message of messages.slice(skip)) {
      const entry = { ...message };
      delete entry.webui_queue_steer_origin;
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
      if (role === "assistant") {
        if (modelPreset) entry.model_preset = modelPreset;
        if (modelProvider) entry.model_provider = modelProvider;
        if (modelName) entry.model_name = modelName;
        if (modelSelection) entry.model_selection = modelSelectionWire(modelSelection);
      }
      entry.timestamp ??= new Date().toISOString();
      session.messages.push(entry);
      if (role === "assistant") lastAssistantIdx = session.messages.length - 1;
    }
    if (modelError && lastAssistantIdx == null) {
      const entry: Record<string, any> = {
        role: "assistant",
        content: modelError.detail ?? EMPTY_FINAL_RESPONSE_MESSAGE,
        timestamp: new Date().toISOString(),
        model_error: modelError,
      };
      if (modelPreset) entry.model_preset = modelPreset;
      if (modelProvider) entry.model_provider = modelProvider;
      if (modelName) entry.model_name = modelName;
      if (modelSelection) entry.model_selection = modelSelectionWire(modelSelection);
      session.messages.push(entry);
      lastAssistantIdx = session.messages.length - 1;
    }
    if (turnLatencyMs != null && lastAssistantIdx != null) session.messages[lastAssistantIdx].latency_ms = Math.max(0, Math.floor(turnLatencyMs));
    if (modelError && lastAssistantIdx != null) session.messages[lastAssistantIdx].model_error = modelError;
    session.updatedAt = new Date().toISOString();
  }

  enqueueSessionDagTurn(
    session: Session,
    turnId: string,
    messageStart: number,
    messageEnd: number,
    modelSelection: ResolvedModelSelection | null = null,
    goalContext: DagGoalContext | null = null,
  ): void {
    if (!this.sessionDagQueue || !this.config.sessionDag.enabled) return;
    if (messageEnd <= messageStart) return;
    const turnMessages = session.messages.slice(messageStart, messageEnd);
    const turn: DagTurnInput = {
      turn_id: turnId,
      message_start: messageStart,
      message_end: messageEnd,
      user_text: turnMessages.some((message) => message.internal_context === "goal_continuation")
        && goalContext
        ? `Goal continuation: ${goalSummary(goalContext.objective)}`
        : firstMessageText(turnMessages, "user"),
      assistant_text: lastMessageText(turnMessages, "assistant"),
      goal_context: goalContext,
    };
    try {
      this.sessionDagQueue.enqueueSavedTurn(
        session.key,
        turn,
        modelSelection
          ? {
              provider: modelSelection.snapshot.provider,
              model: modelSelection.snapshot.model,
            }
          : undefined,
      );
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
    if (
      session.messages.at(-1)?.role === "user"
      && session.messages.at(-1)?.internal_context === "goal_continuation"
    ) {
      session.messages.pop();
      session.updatedAt = new Date().toISOString();
      this.clearPendingUserTurn(session);
      return true;
    }
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

  async dispatchCommand(
    msg: InboundMessage,
    session: Session,
    key: string,
    abortSignal: AbortSignal | null = null,
    turnId: string | null = null,
    slot: TurnSlot | null = null,
  ): Promise<OutboundMessage | null | "continue"> {
    const raw = msg.content.trim();
    const result = await this.commands.dispatch(new CommandContext({
      msg,
      session,
      key,
      raw,
      loop: this,
      abortSignal,
      turnId,
    }));
    if (result == null) {
      return raw.startsWith("/") && msg.content !== raw ? "continue" : null;
    }
    if (raw.toLowerCase() !== "/new") {
      const persistedTurnSource = sharedTurnSource(msg);
      const persistedTurnId = turnId ?? firstString(
        msg.metadata?.turn_id,
        msg.metadata?.turnId,
      );
      session.addMessage("user", msg.content, {
        commandMessage: true,
        ...(typeof msg.metadata?.client_request_id === "string"
          ? {
              client_request_id: msg.metadata.client_request_id,
              webui_request_digest: msg.metadata.webui_request_digest,
            }
          : {}),
        ...(persistedTurnId ? { turn_id: persistedTurnId } : {}),
        ...(persistedTurnSource ? { turn_source: persistedTurnSource } : {}),
      });
      session.addMessage("assistant", result.content, {
        commandMessage: true,
        ...(persistedTurnId ? { turn_id: persistedTurnId } : {}),
        ...(persistedTurnSource ? { turn_source: persistedTurnSource } : {}),
      });
      this.sessions.save(session, {
        fsync: typeof msg.metadata?.client_request_id === "string",
      });
      await this.publishWebuiMessageAccepted(msg, slot);
      await publishWebuiThreadSessionUpdated(this.bus, msg);
    } else if (typeof msg.metadata?.client_request_id === "string") {
      this.sessions.save(session, { fsync: true });
      await this.publishWebuiMessageAccepted(msg, slot);
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
      sessionWorkspace = this.workspace,
      hostProjectId = null,
      modelSelection = null,
      internalTurnContext = null,
      onMaxFinalizationStarting = null,
      midTurnContext = null,
      consolidator = null,
      onTokenCompactionEvent = null,
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
      sessionWorkspace?: string;
      hostProjectId?: string | null;
      modelSelection?: ResolvedModelSelection | null;
      internalTurnContext?: AgentInternalTurnContext | null;
      onMaxFinalizationStarting?: (() => void) | null;
      midTurnContext?: MidTurnContextDescriptor | null;
      consolidator?: Consolidator | null;
      onTokenCompactionEvent?: TokenCompactionEventCallback | null;
    } = {},
  ): Promise<AgentLoopResult> {
    if (!modelSelection) this.refreshProviderSnapshot();
    this.syncSubagentRuntimeLimits();
    const activeProvider = modelSelection?.snapshot.provider ?? this.provider;
    const activeModel = modelSelection?.snapshot.model ?? this.model;
    const activeContextWindowTokens = modelSelection?.snapshot.contextWindowTokens
      ?? this.contextWindowTokens;
    const activeTools = tools ?? this.tools;
    const checkpointSession = session;
    const checkpoint = checkpointSession ? (payload: Record<string, any>) => this.setRuntimeCheckpoint(checkpointSession, payload) : null;
    const activeSessionKey = session?.key ?? sessionKey ?? null;
    const loopHook = new AgentProgressHook(onProgress, onStream, onStreamEnd, {
      channel: channel ?? "cli",
      chatId: chatId ?? "direct",
      messageId: messageId ?? null,
      metadata: { ...(metadata ?? {}), ...(turnId ? turnMetadata(turnId) : {}) },
      sessionKey: activeSessionKey,
      toolHintMaxLength: this.toolHintMaxLength,
      setToolContext: (...args: any[]) => this.setToolContext(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        sessionWorkspace,
        activeTools,
      ),
      onIteration: (iteration: number) => {
        this.currentIterationValue = iteration;
      },
    });
    const hook = this.extraHooks.length ? new CompositeAgentHook([loopHook, ...this.extraHooks]) : loopHook;
    const result = await this.runner.run(
      new AgentRunSpec({
        messages: initialMessages,
        provider: activeProvider,
        tools: activeTools,
        model: activeModel,
        maxIterations: this.maxIterations,
        maxIterationsFinalPrompt: renderTemplate("agent/max-iterations-final-response.md", { strip: true }),
        maxTokens: activeProvider?.generation?.maxTokens ?? this.config.agents.defaults.maxTokens,
        temperature: activeProvider?.generation?.temperature ?? this.config.agents.defaults.temperature,
        reasoningEffort: activeProvider?.generation?.reasoningEffort ?? this.config.agents.defaults.reasoningEffort,
        maxToolResultChars: this.maxToolResultChars,
        toolResultMaxCharsByName: SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME,
        workspace: sessionWorkspace,
        sessionKey: activeSessionKey,
        hostProjectId,
        contextWindowTokens: activeContextWindowTokens,
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
        abortSignal,
        hook,
        concurrentTools: true,
        injectionCallback: ({ limit = 3 } = {}) => this.drainPendingQueue(pendingQueue, limit, session?.key ?? sessionKey),
        internalTurnContext,
        actualModelContext: modelSelection ? persistedModelSelection(modelSelection) : null,
        onMaxFinalizationStarting,
        currentTurnMessageStartIndex: midTurnContext?.transcriptStartIndex ?? null,
        beforeFollowupModelRequest: midTurnContext && session && consolidator
          ? (request) => this.compactBeforeFollowupModelRequest(
              session,
              consolidator,
              midTurnContext,
              request,
              onTokenCompactionEvent,
            )
          : null,
      }),
    );
    const rawUsage = result.usage ?? result.response?.usage;
    const usage = normalizeUsageRecord(rawUsage);
    if (activeSessionKey) {
      if (hasReportedInOutUsage(rawUsage)) this.lastUsageBySession.set(activeSessionKey, usage);
      else this.lastUsageBySession.delete(activeSessionKey);
    }
    const toolsUsed = (result.toolCalls ?? []).map((call: any) => call?.function?.name ?? call?.name).filter(Boolean);
    return [
      result.finalContent ?? result.content ?? EMPTY_FINAL_RESPONSE_MESSAGE,
      toolsUsed,
      result.messages ?? [],
      result.stopReason ?? "",
      Boolean(result.hadInjections),
      Boolean(result.finalContentStreamed),
      firstString(result.response?.actualProvider, activeProvider?.spec?.name),
      firstString(result.response?.actualModel, activeModel),
      result.response?.errorCategory ?? null,
      usage,
      firstString(result.response?.failedProvider),
      firstString(result.response?.failedModel),
    ];
  }

  assembleOutbound(
    msg: InboundMessage,
    finalContent: string,
    allMessages: Record<string, any>[],
    stopReason: string,
    hadInjections: boolean,
    {
      turnLatencyMs = null,
      tools = null,
      finalContentStreamed = false,
      errorCategory = null,
      errorDetail = null,
      usage = null,
      goalId = null,
      goalOutcome = null,
      modelSelection = null,
      failedProvider = null,
      failedModel = null,
    }: {
      turnLatencyMs?: number | null;
      tools?: ToolRegistryInstance | null;
      finalContentStreamed?: boolean;
      errorCategory?: ProviderErrorCategory | null;
      errorDetail?: string | null;
      usage?: Record<string, number> | null;
      goalId?: string | null;
      goalOutcome?: GoalStatus | null;
      modelSelection?: ResolvedModelSelection | null;
      failedProvider?: string | null;
      failedModel?: string | null;
    } = {},
  ): OutboundMessage | null {
    void allMessages;
    const modelErrorCategory: UserFacingModelErrorCategory | null = stopReason === "error"
      ? errorCategory ?? "model_failed"
      : null;
    const messageTool = (tools ?? this.tools).get("message");
    if (messageTool instanceof MessageTool && messageTool.sentInTurn) {
      if (stopReason !== "maxIterations" && (!hadInjections || stopReason === "emptyFinalResponse")) return null;
    }
    return new OutboundMessage({
      channel: msg.channel,
      chatId: msg.chatId,
      content: finalContent,
      metadata: {
        ...(msg.metadata ?? {}),
        ...(finalContentStreamed && !["error", "toolError"].includes(stopReason) ? { streamed: true } : {}),
        ...(turnLatencyMs != null ? { latencyMs: Math.trunc(turnLatencyMs) } : {}),
        ...(modelErrorCategory ? { modelErrorCategory } : {}),
        ...(modelErrorCategory && errorDetail ? { modelErrorDetail: errorDetail } : {}),
        ...(modelErrorCategory && modelSelection ? {
          modelErrorContext: userFacingModelError(modelErrorCategory, null, modelSelection, {
            failedProvider,
            failedModel,
          })
        } : {}),
        ...(usage ? { usage } : {}),
        ...(goalId && goalOutcome ? { goalId, goalOutcome } : {}),
      },
    });
  }

  async stateRestore(ctx: TurnContext): Promise<string> {
    let msg = ctx.msg;
    const existingSession = this.sessions.get(ctx.sessionKey);
    const hasRequestedPreset = Object.prototype.hasOwnProperty.call(
      msg.metadata ?? {},
      "model_preset",
    );
    const modelSelection = this.resolveTurnModelSelection({
      ...(hasRequestedPreset
        ? {
            requestedPreset: typeof msg.metadata?.model_preset === "string"
              ? msg.metadata.model_preset
              : null,
          }
        : this.persistedSessionSelection(existingSession)),
    });
    if (!modelSelection) throw new SessionWorkspaceError("model_selection_unavailable");
    ctx.modelSelection = modelSelection;
    ctx.consolidator = this.modelSelectionResolver
      ? this.consolidator.withProviderSnapshot(
          modelSelection.snapshot.provider,
          modelSelection.snapshot.model,
          modelSelection.snapshot.contextWindowTokens,
        )
      : this.consolidator;
    msg = ctx.msg = new InboundMessage({
      channel: msg.channel,
      chatId: msg.chatId,
      senderId: msg.senderId,
      content: msg.content,
      media: msg.media,
      metadata: msg.channel === "websocket" || msg.metadata?.webui === true
        ? {
            ...(msg.metadata ?? {}),
            model_preset: modelSelection.preset,
            model_provider: modelSelection.provider,
            model: modelSelection.model,
            model_selection: modelSelectionWire(modelSelection),
          }
        : { ...(msg.metadata ?? {}) },
      sessionKey: ctx.sessionKey,
      sessionKeyOverride: msg.sessionKeyOverride,
      timestamp: msg.timestamp,
      internal: msg.internal,
      turnAdmission: msg.turnAdmission,
      expectedTurnId: msg.expectedTurnId,
      turnSource: msg.turnSource,
    });
    const reservation = existingSession
      || msg.channel !== "websocket"
      || msg.metadata?.webui !== true
      ? null
      : this.sessions.peekWebuiSessionBindingReservation(ctx.sessionKey);
    if (!ctx.session) {
      ctx.session = existingSession ?? await this.getOrCreateSession(
        ctx.sessionKey,
        "created",
        reservation !== null,
      );
    }
    ctx.session.metadata.modelPreset = modelSelection.preset;
    ctx.session.metadata.modelSelection = persistedModelSelection(modelSelection);
    const projectedBinding = this.guiTranscriptMirror?.prepareSession(
      msg,
      ctx.session,
      ctx.sessionKey,
    ) ?? null;
    if (!ctx.trustedSessionBinding && projectedBinding) {
      ctx.trustedSessionBinding = projectedBinding;
    }
    if (projectedBinding && msg.metadata?.webui !== true) {
      msg = ctx.msg = new InboundMessage({
        channel: msg.channel,
        chatId: msg.chatId,
        senderId: msg.senderId,
        content: msg.content,
        media: msg.media,
        metadata: { ...(msg.metadata ?? {}), webui: true },
        sessionKey: ctx.sessionKey,
        sessionKeyOverride: msg.sessionKeyOverride,
        timestamp: msg.timestamp,
        internal: msg.internal,
        turnAdmission: msg.turnAdmission,
        expectedTurnId: msg.expectedTurnId,
        turnSource: msg.turnSource,
      });
    }
    const binding = this.resolveSessionWorkspace(
      msg,
      ctx.session,
      reservation,
      ctx.trustedSessionBinding,
    );
    ctx.sessionWorkspace = binding.cwd;
    ctx.sessionProjectId = binding.projectId;
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
        internal: msg.internal,
        turnAdmission: msg.turnAdmission,
        expectedTurnId: msg.expectedTurnId,
        turnSource: msg.turnSource,
      });
    }
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
    const command = await this.dispatchCommand(
      ctx.msg,
      ctx.session!,
      ctx.sessionKey,
      ctx.abortSignal,
      ctx.turnId,
      ctx.slot,
    );
    if (command && command !== "continue") {
      ctx.outbound = command;
      return "shortcut";
    }
    return "dispatch";
  }

  async stateBuild(ctx: TurnContext): Promise<string> {
    const sessionWorkspace = ctx.sessionWorkspace;
    if (!sessionWorkspace) throw new SessionWorkspaceError("workspace_missing");
    const goal = this.goalRuntime.get(ctx.sessionKey);
    const internalGoal = ctx.msg.internal?.kind === "goal_continuation"
      ? ctx.msg.internal
      : null;
    if (internalGoal) {
      if (
        !goal
        || goal.status !== "active"
        || goal.goalId !== internalGoal.goalId
        || goal.updatedAt !== internalGoal.goalUpdatedAt
      ) throw createTaskCancelledError();
      this.goalRuntime.registerLease(ctx.sessionKey, goal.goalId, ctx.turnId);
      ctx.goalIdForTurn = goal.goalId;
      ctx.dagGoalContext = {
        goalId: goal.goalId,
        objective: goal.objective,
        status: goal.status,
      };
      ctx.userPersistedEarly = this.persistGoalContinuationContext(ctx);
    } else {
      if (goal?.status === "active") {
        this.goalRuntime.registerLease(ctx.sessionKey, goal.goalId, ctx.turnId);
        ctx.goalIdForTurn = goal.goalId;
      }
      if (goal && goal.status !== "completed") {
        ctx.dagGoalContext = {
          goalId: goal.goalId,
          objective: goal.objective,
          status: goal.status,
        };
      }
      const hasReservedInbox = this.goalRuntime.inbox(ctx.sessionKey)
        .some((entry) => entry.turnId === ctx.turnId);
      if (goal || hasReservedInbox) {
        const persisted = await this.goalRuntime.persistGoalUserTurn(
          ctx.sessionKey,
          ctx.turnId,
          {
            channel: ctx.msg.channel,
            chatId: ctx.msg.chatId,
            ...(sharedTurnSource(ctx.msg) ? { source: sharedTurnSource(ctx.msg)! } : {}),
          },
          (session, entry) => {
            const source = entry
              ? new InboundMessage({
                  channel: entry.channel,
                  chatId: entry.chatId,
                  senderId: entry.senderId,
                  content: entry.content,
                  media: entry.media,
                  metadata: entry.metadata,
                  timestamp: entry.receivedAt,
                  sessionKeyOverride: ctx.sessionKey,
                  turnSource: parseTurnSource(entry.metadata.turn_source),
                })
              : ctx.msg;
            this.appendUserMessage(source, session, {}, entry?.receivedAt);
          },
        );
        ctx.userPersistedEarly = Boolean(persisted.entry || ctx.msg.content.trim() || ctx.msg.media.length);
      } else {
        ctx.userPersistedEarly = this.persistUserMessageEarly(ctx.msg, ctx.session!);
      }
    }
    if (ctx.userPersistedEarly && !internalGoal) {
      if (ctx.mirrorTurn) {
        this.guiTranscriptMirror?.user(
          ctx.mirrorTurn,
          ctx.msg.content,
          ctx.msg.media,
        );
      }
      await this.publishWebuiMessageAccepted(ctx.msg, ctx.slot);
      await publishWebuiThreadSessionUpdated(this.bus, ctx.msg);
    }
    const revalidated = this.resolveSessionWorkspace(
      ctx.msg,
      ctx.session,
      null,
      ctx.trustedSessionBinding,
    );
    if (revalidated.cwd !== sessionWorkspace || revalidated.projectId !== ctx.sessionProjectId) {
      throw new SessionWorkspaceError("workspace_conflict");
    }
    await this.lifecycleHook().beforeBuildSystemPrompt(new AgentHookContext({
      session: ctx.session,
      sessionKey: ctx.sessionKey,
      reason: "system_prompt_build",
      spec: { hostProjectId: ctx.sessionProjectId, workspace: sessionWorkspace },
      metadata: { lifecycle: "system_prompt" },
    }));
    const compactionOptions: {
      replayMaxMessages: number | null;
      notifyOnLockWait?: boolean;
      onCompactionEvent?: TokenCompactionEventCallback;
    } = {
      replayMaxMessages: this.maxMessages,
    };
    if (ctx.msg.channel === "websocket" || ctx.mirrorTurn) {
      compactionOptions.notifyOnLockWait = true;
      ctx.onTokenCompactionEvent = async (event) => {
        const text = this.contextCompactionLabel(ctx, event.status);
        if (ctx.mirrorTurn) {
          if (ctx.boundary?.shouldEmitLive() !== false) {
            this.guiTranscriptMirror?.contextCompaction(
              ctx.mirrorTurn,
              text,
              event.status,
            );
          }
        } else {
          await this.publishWebuiContextCompaction(ctx, event.status);
        }
      };
      compactionOptions.onCompactionEvent = ctx.onTokenCompactionEvent;
    }
    await (ctx.consolidator ?? this.consolidator).maybeConsolidateByTokens(
      ctx.session!,
      compactionOptions,
    );
    ctx.tools = this.createToolRegistry("turn", sessionWorkspace, {
      includeConnectedMcp: true,
      messageSendCallback: ctx.messageSendCallback,
      ...(ctx.sessionProjectId !== null
        ? { readonlySkillRoots: this.projectReadonlySkillRoots() }
        : {}),
      modelSelection: ctx.modelSelection,
    });
    this.setToolContext(
      ctx.msg.channel,
      ctx.msg.chatId,
      ctx.msg.metadata?.message_id ?? ctx.msg.metadata?.messageId ?? null,
      {
        ...(ctx.msg.metadata ?? {}),
        ...(sharedTurnSource(ctx.msg) ? { turn_source: sharedTurnSource(ctx.msg)! } : {}),
        ...turnMetadata(ctx.turnId),
      },
      ctx.sessionKey,
      sessionWorkspace,
      ctx.tools,
    );
    const messageTool = ctx.tools.get("message");
    if (messageTool instanceof MessageTool) messageTool.startTurn();
    ctx.history = ctx.session!.getHistory({
      maxMessages: this.maxMessages,
      maxTokens: this.replayTokenBudget(ctx.modelSelection),
      includeTimestamps: true,
      targetProvider: ctx.modelSelection?.provider,
    });
    if (
      ctx.userPersistedEarly
      && ctx.history.at(-1)?.role === "user"
    ) {
      ctx.history = ctx.history.slice(0, -1);
    }
    ctx.initialMessages = this.buildInitialMessages(
      ctx.msg,
      ctx.session!,
      ctx.history,
      ctx.pendingSummary,
      sessionWorkspace,
    );
    ctx.midTurnContext = this.createMidTurnContextDescriptor(
      ctx.session!,
      ctx.initialMessages,
      ctx.userPersistedEarly ? 1 : 0,
      ctx.modelSelection,
      (history, summary, currentSession) => this.context.buildMessages({
        history,
        currentMessage: imageGenerationPrompt(ctx.msg.content, ctx.msg.metadata),
        media: ctx.msg.media.length ? ctx.msg.media : null,
        channel: ctx.msg.channel,
        chatId: this.runtimeChatId(ctx.msg),
        senderId: ctx.msg.senderId,
        sessionSummary: summary,
        sessionMetadata: currentSession.metadata,
        responseLanguage: ctx.msg.metadata?.[WEBUI_LANGUAGE_METADATA_KEY]
          ?? currentSession.metadata?.[WEBUI_LANGUAGE_METADATA_KEY]
          ?? null,
        sessionKey: currentSession.key,
        unifiedSession: this.unifiedSession,
        currentRuntimeLines: [
          ...mcpRuntimeLines(ctx.msg, {
            availableServerNames: new Set(Object.keys(this.mcpServers ?? {})),
          }),
        ],
        hook: this.lifecycleHook(),
        sessionWorkspace,
      }),
    );
    ctx.onProgress ??= await this.buildBusProgressCallback(ctx);
    if (ctx.mirrorTurn && this.guiTranscriptMirror) {
      const mirror = this.guiTranscriptMirror;
      const turn = ctx.mirrorTurn;
      const downstream = ctx.onProgress;
      ctx.onProgress = withProgressCapabilities(
        async (content: string, options: Record<string, any> = {}) => {
          mirror.progress(turn, content, options);
          await downstream?.(content, options);
        },
        { toolEvents: true, fileEditEvents: true, reasoning: true },
      );
      const downstreamStream = ctx.onStream;
      const downstreamStreamEnd = ctx.onStreamEnd;
      if (downstreamStream) {
        const streamId = `${ctx.sessionKey}:${ctx.turnId}`;
        ctx.onStream = async (delta: string) => {
          mirror.delta(turn, delta, streamId);
          await downstreamStream(delta);
        };
        ctx.onStreamEnd = async (options: { resuming?: boolean } = {}) => {
          mirror.streamEnd(turn, streamId, Boolean(options.resuming));
          await downstreamStreamEnd?.(options);
        };
      }
    }
    ctx.onRetryWait ??= await this.buildRetryWaitCallback(ctx.msg);
    if (ctx.mirrorTurn && this.guiTranscriptMirror) {
      const mirror = this.guiTranscriptMirror;
      const turn = ctx.mirrorTurn;
      const downstreamRetryWait = ctx.onRetryWait;
      ctx.onRetryWait = async (content: string) => {
        mirror.retryWait(turn, content);
        await downstreamRetryWait?.(content);
      };
    }
    return "ok";
  }

  async stateRun(ctx: TurnContext): Promise<string> {
    if (ctx.slot?.state === "running") ctx.slot.acceptingSteer = true;
    const settleSlot = (): void => {
      if (!ctx.slot || ctx.slot.state === "closed") return;
      ctx.slot.acceptingSteer = false;
      ctx.slot.state = "settling";
    };
    const [
      finalContent,
      toolsUsed,
      allMessages,
      stopReason,
      hadInjections,
      finalContentStreamed,
      actualModelProvider,
      actualModel,
      errorCategory,
      usage,
      failedProvider,
      failedModel,
    ] = await this.runAgentLoop(ctx.initialMessages, {
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
      sessionWorkspace: ctx.sessionWorkspace ?? this.workspace,
      hostProjectId: ctx.sessionProjectId,
      modelSelection: ctx.modelSelection,
      internalTurnContext: ctx.msg.internal?.kind === "goal_continuation" && ctx.dagGoalContext
        ? {
            kind: "goal_continuation",
            goalId: ctx.dagGoalContext.goalId,
            objective: ctx.dagGoalContext.objective,
          }
        : null,
      onMaxFinalizationStarting: settleSlot,
      midTurnContext: ctx.midTurnContext,
      consolidator: ctx.consolidator ?? this.consolidator,
      onTokenCompactionEvent: ctx.onTokenCompactionEvent,
    });
    ctx.stopReason = stopReason;
    if (ctx.slot) ctx.slot.stopReason = stopReason;
    settleSlot();
    ctx.errorCategory = errorCategory;
    ctx.failedProvider = failedProvider;
    ctx.failedModel = failedModel;
    ctx.usage = usage;
    if (ctx.abortSignal?.aborted || stopReason === "cancelled") {
      throw createTaskCancelledError();
    }
    ctx.errorDetail = stopReason === "error" ? finalContent : null;
    ctx.finalContent = this.localizeUserFacingApiError(
      ctx.msg.channel,
      ctx.msg.metadata,
      ctx.session,
      finalContent,
      stopReason,
      errorCategory,
    );
    ctx.toolsUsed = toolsUsed;
    ctx.allMessages = allMessages;
    ctx.hadInjections = hadInjections;
    ctx.finalContentStreamed = finalContentStreamed;
    ctx.actualModelProvider = actualModelProvider;
    ctx.actualModel = actualModel;
    return "ok";
  }

  private async settleCancelledGoalTurn(ctx: TurnContext): Promise<void> {
    const goalId = ctx.goalIdForTurn ?? this.goalRuntime.goalIdForTurn(ctx.sessionKey, ctx.turnId);
    if (!goalId) return;
    ctx.goalIdForTurn = goalId;
    ctx.turnLatencyMs = Math.max(0, Math.trunc((Date.now() / 1000 - ctx.turnWallStartedAt) * 1000));
    const settlement = await this.goalRuntime.settleTurn({
      sessionKey: ctx.sessionKey,
      turnId: ctx.turnId,
      goalId,
      usage: ctx.usage,
      latencyMs: ctx.turnLatencyMs,
      stopReason: "cancelled",
      errorCategory: ctx.errorCategory,
    });
    ctx.goalOutcome = settlement.goal?.status ?? null;
    if (settlement.goal) {
      ctx.dagGoalContext = {
        goalId: settlement.goal.goalId,
        objective: settlement.goal.objective,
        status: settlement.goal.status,
      };
    }
    await this.goalRuntime.flushEffects(ctx.sessionKey);
  }

  async stateSave(ctx: TurnContext): Promise<string> {
    if (!ctx.finalContent?.trim()) ctx.finalContent = EMPTY_FINAL_RESPONSE_MESSAGE;
    ctx.saveSkip = 1 + ctx.history.length + (ctx.userPersistedEarly ? 1 : 0);
    ctx.turnLatencyMs = Math.max(0, Math.trunc((Date.now() / 1000 - ctx.turnWallStartedAt) * 1000));
    const dagMessageStart = Math.max(0, ctx.session!.messages.length - (ctx.userPersistedEarly ? 1 : 0));
    this.saveTurn(ctx.session!, ctx.allMessages, ctx.saveSkip, {
      turnLatencyMs: ctx.turnLatencyMs,
      modelPreset: ctx.modelSelection?.preset,
      modelProvider: ctx.actualModelProvider ?? ctx.modelSelection?.provider,
      modelName: ctx.actualModel ?? ctx.modelSelection?.model,
      modelSelection: ctx.modelSelection,
      modelError: ctx.stopReason === "error"
        ? userFacingModelError(ctx.errorCategory ?? "model_failed", ctx.errorDetail, ctx.modelSelection, {
            failedProvider: ctx.failedProvider,
            failedModel: ctx.failedModel,
          })
        : null,
    });
    this.clearPendingUserTurn(ctx.session!);
    this.clearRuntimeCheckpoint(ctx.session!);
    ctx.session!.enforceFileCap((messages) =>
      this.context.memory.rawArchive(messages, { sessionKey: ctx.sessionKey }),
    );
    ctx.goalIdForTurn ??= this.goalRuntime.goalIdForTurn(ctx.sessionKey, ctx.turnId);
    if (ctx.goalIdForTurn) {
      const settlement = await this.goalRuntime.settleTurn({
        sessionKey: ctx.sessionKey,
        turnId: ctx.turnId,
        goalId: ctx.goalIdForTurn,
        usage: ctx.usage,
        latencyMs: ctx.turnLatencyMs,
        stopReason: ctx.stopReason,
        errorCategory: ctx.errorCategory,
      });
      ctx.goalOutcome = settlement.goal?.status ?? null;
      if (settlement.goal) {
        ctx.dagGoalContext = {
          goalId: settlement.goal.goalId,
          objective: settlement.goal.objective,
          status: settlement.goal.status,
        };
      }
      if (settlement.shouldContinue && settlement.goal) {
        this.scheduleGoalWork(ctx.sessionKey, settlement.goal);
      }
      await this.goalRuntime.flushEffects(ctx.sessionKey);
    } else {
      this.sessions.save(ctx.session!);
    }
    if (ctx.mirrorTurn && ctx.finalContent) {
      this.guiTranscriptMirror?.final(
        ctx.mirrorTurn,
        ctx.finalContent,
        ctx.turnLatencyMs,
        null,
        ctx.errorCategory,
        ctx.stopReason === "error"
          ? userFacingModelError(ctx.errorCategory ?? "model_failed", ctx.errorDetail, ctx.modelSelection, {
              failedProvider: ctx.failedProvider,
              failedModel: ctx.failedModel,
            })
          : null,
      );
    }
    if (
      ctx.msg.metadata?.webui === true
      && !ctx.sessionKey.startsWith("websocket:")
    ) {
      await maybeGenerateWebuiTitle({
        sessions: this.sessions,
        sessionKey: ctx.sessionKey,
        provider: ctx.modelSelection?.snapshot.provider ?? this.provider,
        model: ctx.modelSelection?.snapshot.model
          ?? this.model
          ?? this.provider?.getDefaultModel?.()
          ?? "",
      });
    }
    this.enqueueSessionDagTurn(
      ctx.session!,
      ctx.turnId,
      dagMessageStart,
      ctx.session!.messages.length,
      ctx.modelSelection,
      ctx.dagGoalContext,
    );
    return "ok";
  }

  async stateRespond(ctx: TurnContext): Promise<string> {
    ctx.outbound = this.assembleOutbound(ctx.msg, ctx.finalContent ?? EMPTY_FINAL_RESPONSE_MESSAGE, ctx.allMessages, ctx.stopReason, ctx.hadInjections, {
      turnLatencyMs: ctx.turnLatencyMs,
      tools: ctx.tools,
      finalContentStreamed: ctx.finalContentStreamed,
      errorCategory: ctx.errorCategory,
      errorDetail: ctx.errorDetail,
      usage: ctx.usage,
      goalId: ctx.goalIdForTurn,
      goalOutcome: ctx.goalOutcome,
      modelSelection: ctx.modelSelection,
      failedProvider: ctx.failedProvider,
      failedModel: ctx.failedModel,
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
      sessionBindingOverride,
    }: {
      onProgress?: (...args: any[]) => Promise<void> | void;
      onStream?: (delta: string) => Promise<void> | void;
      onStreamEnd?: (...args: any[]) => Promise<void> | void;
      pendingQueue?: AsyncQueue<InboundMessage> | null;
      abortSignal?: AbortSignal | null;
      turnId?: string | null;
      boundary?: TurnCancellationBoundary | null;
      sessionBindingOverride?: WebuiSessionBinding | null;
    } = {},
  ): Promise<OutboundMessage | null> {
    const rawChatId = String(msg.chatId ?? "");
    const separator = rawChatId.indexOf(":");
    const channel = separator >= 0 ? rawChatId.slice(0, separator) : "cli";
    const chatId = separator >= 0 ? rawChatId.slice(separator + 1) : rawChatId;
    const key = sessionKey ?? msg.sessionKeyOverride ?? `${channel}:${chatId}`;
    const existingSession = this.sessions.get(key);
    const hasRequestedPreset = Object.prototype.hasOwnProperty.call(
      msg.metadata ?? {},
      "model_preset",
    );
    const modelSelection = this.resolveTurnModelSelection({
      ...(hasRequestedPreset
        ? {
            requestedPreset: typeof msg.metadata?.model_preset === "string"
              ? msg.metadata.model_preset
              : null,
          }
        : this.persistedSessionSelection(existingSession)),
    });
    if (!modelSelection) throw new SessionWorkspaceError("model_selection_unavailable");
    const scopedConsolidator = this.modelSelectionResolver
      ? this.consolidator.withProviderSnapshot(
          modelSelection.snapshot.provider,
          modelSelection.snapshot.model,
          modelSelection.snapshot.contextWindowTokens,
        )
      : this.consolidator;
    msg = new InboundMessage({
      channel: msg.channel,
      chatId: msg.chatId,
      senderId: msg.senderId,
      content: msg.content,
      media: msg.media,
      metadata: msg.channel === "websocket" || msg.metadata?.webui === true
        ? {
            ...(msg.metadata ?? {}),
            model_preset: modelSelection.preset,
            model_provider: modelSelection.provider,
            model: modelSelection.model,
            model_selection: modelSelectionWire(modelSelection),
          }
        : { ...(msg.metadata ?? {}) },
      sessionKey: key,
      sessionKeyOverride: msg.sessionKeyOverride,
      timestamp: msg.timestamp,
      internal: msg.internal,
      turnAdmission: msg.turnAdmission,
      expectedTurnId: msg.expectedTurnId,
      turnSource: msg.turnSource,
    });
    let session = existingSession ?? await this.getOrCreateSession(key);
    session.metadata.modelPreset = modelSelection.preset;
    session.metadata.modelSelection = persistedModelSelection(modelSelection);
    const sessionBinding = this.resolveSessionWorkspace(
      msg,
      session,
      null,
      sessionBindingOverride ?? null,
    );
    const sessionWorkspace = sessionBinding.cwd;
    await this.lifecycleHook().beforeBuildSystemPrompt(new AgentHookContext({
      session,
      sessionKey: key,
      reason: "system_prompt_build",
      spec: { hostProjectId: sessionBinding.projectId, workspace: sessionWorkspace },
      metadata: { lifecycle: "system_prompt" },
    }));
    if (this.restoreRuntimeCheckpoint(session)) this.sessions.save(session);
    if (this.restorePendingUserTurn(session)) this.sessions.save(session);

    const prepared = this.autoCompact.prepareSession(session, key);
    session = prepared[0];
    const pendingSummary = prepared[1];
    await scopedConsolidator.maybeConsolidateByTokens(session, {
      replayMaxMessages: this.maxMessages,
    });
    const tools = this.createToolRegistry(
      "system-turn",
      sessionWorkspace,
      {
        includeConnectedMcp: true,
        ...(sessionBinding.projectId !== null
          ? { readonlySkillRoots: this.projectReadonlySkillRoots() }
          : {}),
        modelSelection,
      },
    );

    const isSubagent = msg.senderId === "subagent";
    const subagentFollowupPersisted = isSubagent && this.persistSubagentFollowup(session, msg);
    if (subagentFollowupPersisted) this.sessions.save(session);
    this.setToolContext(
      channel,
      chatId,
      msg.metadata?.message_id ?? msg.metadata?.messageId ?? null,
      msg.metadata ?? {},
      key,
      sessionWorkspace,
      tools,
    );

    const history = session.getHistory({
      maxMessages: this.maxMessages,
      maxTokens: this.replayTokenBudget(modelSelection),
      includeTimestamps: true,
      targetProvider: modelSelection.provider,
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
      sessionWorkspace,
    });
    const midTurnContext = this.createMidTurnContextDescriptor(
      session,
      messages,
      subagentFollowupPersisted ? 1 : 0,
      modelSelection,
      (visibleHistory, summary, currentSession) => this.context.buildMessages({
        history: visibleHistory,
        currentMessage: isSubagent ? "" : msg.content,
        channel,
        chatId,
        currentRole,
        senderId: msg.senderId,
        sessionSummary: summary,
        sessionMetadata: currentSession.metadata,
        responseLanguage: msg.metadata?.[WEBUI_LANGUAGE_METADATA_KEY]
          ?? currentSession.metadata?.[WEBUI_LANGUAGE_METADATA_KEY]
          ?? null,
        sessionKey: currentSession.key,
        unifiedSession: this.unifiedSession,
        currentRuntimeLines: isSubagent
          ? []
          : [
              ...mcpRuntimeLines(msg, {
                availableServerNames: new Set(Object.keys(this.mcpServers ?? {})),
              }),
            ],
        hook: this.lifecycleHook(),
        sessionWorkspace,
      }),
    );

    const started = Date.now();
    const [
      rawFinalContent,
      ,
      allMessages,
      stopReason,
      ,
      ,
      actualModelProvider,
      actualModel,
      errorCategory,
      ,
      failedProvider,
      failedModel,
    ] = await this.runAgentLoop(messages, {
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
      sessionWorkspace,
      hostProjectId: sessionBinding.projectId,
      modelSelection,
      midTurnContext,
      consolidator: scopedConsolidator,
    });
    if (abortSignal?.aborted || stopReason === "cancelled") {
      throw createTaskCancelledError();
    }
    const finalContent = this.localizeUserFacingApiError(
      channel,
      msg.metadata,
      session,
      rawFinalContent,
      stopReason,
      errorCategory,
    );
    const latencyMs = Math.max(0, Date.now() - started);
    const dagMessageStart = session.messages.length;
    this.saveTurn(session, allMessages, 1 + history.length, {
      turnLatencyMs: latencyMs,
      modelPreset: modelSelection.preset,
      modelProvider: actualModelProvider ?? modelSelection.provider,
      modelName: actualModel ?? modelSelection.model,
      modelSelection,
      modelError: stopReason === "error"
        ? userFacingModelError(errorCategory ?? "model_failed", rawFinalContent, modelSelection, {
            failedProvider,
            failedModel,
          })
        : null,
    });
    this.clearRuntimeCheckpoint(session);
    session.enforceFileCap((messages) =>
      this.context.memory.rawArchive(messages, { sessionKey: key }),
    );
    this.sessions.save(session);
    this.enqueueSessionDagTurn(
      session,
      turnId ?? firstString(msg.metadata?.turn_id, msg.metadata?.turnId) ?? cryptoRandomId(),
      dagMessageStart,
      session.messages.length,
      modelSelection,
    );

    const metadata: Record<string, any> = {};
    if (channel === "slack" && key.startsWith("slack:") && key.split(":").length >= 3) {
      metadata.slack = { thread_ts: key.split(":", 3)[2] };
    }
    const originMessageId = msg.metadata?.originMessageId;
    if (originMessageId) metadata.originMessageId = originMessageId;
    if (stopReason === "error") metadata.modelErrorCategory = errorCategory ?? "model_failed";
    if (stopReason === "error" && rawFinalContent) metadata.modelErrorDetail = rawFinalContent;
    if (stopReason === "error") {
      metadata.modelErrorContext = userFacingModelError(errorCategory ?? "model_failed", null, modelSelection, {
        failedProvider,
        failedModel,
      });
    }
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
      sessionBindingOverride,
      slot,
    }: {
      onProgress?: (...args: any[]) => Promise<void> | void;
      onStream?: (delta: string) => Promise<void> | void;
      onStreamEnd?: (...args: any[]) => Promise<void> | void;
      pendingQueue?: AsyncQueue<InboundMessage> | null;
      abortSignal?: AbortSignal | null;
      turnId?: string | null;
      boundary?: TurnCancellationBoundary | null;
      messageSendCallback?: MessageSendCallback | null;
      sessionBindingOverride?: WebuiSessionBinding | null;
      slot?: TurnSlot | null;
    } = {},
  ): Promise<OutboundMessage | null> {
    if (!this.modelSelectionResolver) this.refreshProviderSnapshot();
    if (message.channel === "system") {
      return this.processSystemMessage(message, sessionKey, {
        onProgress,
        onStream,
        onStreamEnd,
        pendingQueue,
        abortSignal,
        sessionBindingOverride,
      });
    }
    const key = sessionKey ?? this.sessionKey(message);
    const resolvedTurnId = turnId ?? firstString(message.metadata?.turn_id, message.metadata?.turnId) ?? undefined;
    const ctx = new TurnContext({
      msg: message,
      sessionKey: key,
      turnId: resolvedTurnId,
      slot: slot ?? null,
    });
    ctx.onProgress = onProgress ?? null;
    ctx.onStream = onStream ?? null;
    ctx.onStreamEnd = onStreamEnd ?? null;
    ctx.pendingQueue = pendingQueue ?? null;
    ctx.abortSignal = abortSignal ?? null;
    ctx.boundary = boundary ?? createTurnCancellationBoundary({ turnId: ctx.turnId, signal: ctx.abortSignal });
    ctx.messageSendCallback = messageSendCallback ?? null;
    ctx.trustedSessionBinding = sessionBindingOverride ?? null;

    await this.stateRestore(ctx);
    if (message.channel !== "websocket") {
      ctx.mirrorTurn = this.guiTranscriptMirror?.turn(
        key,
        ctx.turnId,
        sharedTurnSource(ctx.msg),
        typeof ctx.msg.metadata?.client_request_id === "string"
          ? ctx.msg.metadata.client_request_id
          : null,
      ) ?? null;
      if (ctx.mirrorTurn) {
        this.guiTranscriptMirror?.running(ctx.mirrorTurn, ctx.turnWallStartedAt);
      }
    }
    try {
      this.autoCompact.checkExpired(
        (promise) => this.scheduleBackground(promise),
        this.busySessionKeysForAutoCompact(),
      );
      await this.stateCompact(ctx);
      const commandState = await this.stateCommand(ctx);
      if (commandState === "shortcut") {
        if (ctx.mirrorTurn && ctx.outbound?.content) {
          this.guiTranscriptMirror?.final(
            ctx.mirrorTurn,
            ctx.outbound.content,
            null,
            ctx.outbound.metadata?.agentUi,
          );
        }
        return ctx.outbound;
      }
      await this.stateBuild(ctx);
      await this.stateRun(ctx);
      await this.stateSave(ctx);
      await this.stateRespond(ctx);
      return ctx.outbound;
    } catch (error) {
      if (isTaskCancelledError(error)) {
        try {
          await this.settleCancelledGoalTurn(ctx);
        } catch (settlementError) {
          console.warn("[goal] cancelled turn settlement failed", {
            sessionKey: ctx.sessionKey,
            turnId: ctx.turnId,
            error: settlementError,
          });
        }
      }
      throw error;
    } finally {
      if (ctx.slot && ctx.slot.state !== "closed") {
        ctx.slot.acceptingSteer = false;
        ctx.slot.state = "settling";
      }
      if (ctx.mirrorTurn) {
        this.guiTranscriptMirror?.ended(
          ctx.mirrorTurn,
          ctx.turnLatencyMs,
          ctx.goalIdForTurn,
          ctx.goalOutcome,
        );
      }
    }
  }

  async processMessage(message: InboundMessage, sessionKey?: string, opts: Parameters<AgentLoop["processMessageInternal"]>[2] = {}): Promise<OutboundMessage | null> {
    return this.processMessageInternal(message, sessionKey, opts);
  }

  private async withTerminalTurn<T>(
    sessionKey: string,
    channel: string,
    turnId: string,
    signal: AbortSignal | null,
    operation: (signal: AbortSignal | null) => Promise<T>,
  ): Promise<T> {
    const runOperation = async (turnSignal: AbortSignal | null): Promise<T> => {
      try {
        return await operation(turnSignal);
      } catch (error) {
        if (isTaskCancelledError(error)) {
          const getSession = this.sessions.get;
          const session = typeof getSession === "function"
            ? getSession.call(this.sessions, sessionKey)
            : null;
          if (session) {
            if (!this.restoreRuntimeCheckpoint(session)) {
              this.clearPendingUserTurn(session);
              this.clearRuntimeCheckpoint(session);
            }
            this.sessions.save(session, { fsync: sessionKey.startsWith("cli:") });
          }
        }
        throw error;
      }
    };
    if (!sessionKey.startsWith("cli:")) return runOperation(signal);
    return this.terminalTurnLock.runExclusive(sessionKey, async () => {
      this.sessions.invalidate(sessionKey);
      if (signal?.aborted) throw createTaskCancelledError();
      if (channel !== "cli") return runOperation(signal);
      const controller = new AbortController();
      const relayAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", relayAbort, { once: true });
      await this.terminalRunControl.create(sessionKey, turnId);
      const stopOwner = this.terminalRunControl.startOwner(sessionKey, turnId, controller);
      try {
        return await runOperation(controller.signal);
      } finally {
        signal?.removeEventListener("abort", relayAbort);
        await stopOwner();
      }
    }, signal);
  }

  async withSessionTurnBarrier<T>(
    sessionKey: string,
    operation: () => Promise<T>,
    signal: AbortSignal | null = null,
  ): Promise<T> {
    return this.lockFor(sessionKey).runExclusive(() => (
      this.terminalTurnLock.runExclusive(sessionKey, async () => {
        this.sessions.invalidate(sessionKey);
        return operation();
      }, signal)
    ));
  }

  async withSessionDeletionBarrier<T>(
    sessionKey: string,
    prepare: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.sessionDeletionQueues.has(sessionKey)) {
      throw new Error("session_deletion_in_progress");
    }
    const deferred: InboundMessage[] = [];
    this.goalRuntime.beginSessionDeletion(sessionKey);
    this.sessionDeletionQueues.set(sessionKey, deferred);
    try {
      this.scheduledGoalSessions.delete(sessionKey);
      this.lastUsageBySession.delete(sessionKey);
      await prepare();
      await this.goalRuntime.drainSessionDeletion(sessionKey);
      void this.memmyMemoryIntegration.closeSession?.(sessionKey, "deleted").catch(() => undefined);
      const result = await this.withSessionTurnBarrier(sessionKey, operation);
      this.scheduledGoalSessions.delete(sessionKey);
      this.lastUsageBySession.delete(sessionKey);
      return result;
    } finally {
      await this.goalRuntime.drainSessionDeletion(sessionKey);
      this.goalRuntime.endSessionDeletion(sessionKey);
      this.sessionDeletionQueues.delete(sessionKey);
      for (const message of deferred) {
        if (!message.internal) await this.bus.publishInbound(message);
      }
    }
  }

  private rootDeliveryFor(message: InboundMessage): TurnRootDelivery {
    return isSharedQueueMessage(message)
      ? "pending"
      : "accepted";
  }

  private createTurnSlot(
    root: InboundMessage,
    route: string,
    owner: symbol,
    turnId = firstString(root.metadata?.turn_id, root.metadata?.turnId) ?? cryptoRandomId(),
  ): TurnSlot {
    return {
      route,
      root,
      turnId,
      state: "queued",
      acceptingSteer: false,
      pendingSteer: new AsyncQueue<InboundMessage>(),
      rootDelivery: this.rootDeliveryFor(root),
      owner,
      stopReason: null,
      announcedToWebui: false,
      dispatchTask: null,
      announcementGate: null,
    };
  }

  private removeTurnSlot(sessionKey: string, slot: TurnSlot): void {
    const slots = this.turnSlots.get(sessionKey) ?? [];
    const next = slots.filter((item) => item !== slot);
    if (next.length) this.turnSlots.set(sessionKey, next);
    else this.turnSlots.delete(sessionKey);
  }

  private drainInboundQueue(queue: AsyncQueue<InboundMessage>): InboundMessage[] {
    const messages: InboundMessage[] = [];
    while (true) {
      const message = queue.getNowait();
      if (!message) return messages;
      messages.push(message);
    }
  }

  private discardQueueSteerResiduals(
    sessionKey: string,
    turnId: string,
    queue: AsyncQueue<InboundMessage>,
  ): void {
    for (const message of this.drainInboundQueue(queue)) {
      const clientRequestId = message.metadata?.client_request_id;
      const admission = typeof clientRequestId === "string"
        ? this.queueSteerAdmissionsBySession.get(sessionKey)?.get(clientRequestId)
        : null;
      if (
        message.metadata?.webui_queue_steer_origin === true
        && admission?.turnId === turnId
      ) continue;
      queue.put(message);
    }
  }

  private async cleanupOwnedSlots(
    sessionKey: string,
    owner: symbol,
    reason: "turn_queue_cancelled" | "turn_start_failed",
  ): Promise<void> {
    const removedRevisions = new Map<TurnSlot, number>();
    const owned = await this.queueMutationLockFor(sessionKey).runExclusive(async () => {
      const slots = this.turnSlots.get(sessionKey) ?? [];
      const matching = slots.filter((slot) => slot.owner === owner);
      if (!matching.length) return [];
      const remaining = slots.filter((slot) => slot.owner !== owner);
      if (remaining.length) this.turnSlots.set(sessionKey, remaining);
      else this.turnSlots.delete(sessionKey);
      for (const slot of matching) {
        if (slot.state === "queued" && slot.announcedToWebui) {
          removedRevisions.set(slot, this.advanceQueueRevision(sessionKey));
        }
        slot.acceptingSteer = false;
        slot.state = "closed";
      }
      return matching;
    });
    if (!owned.length) return;
    for (const slot of owned) {
      const removedRevision = removedRevisions.get(slot);
      if (removedRevision !== undefined) {
        try {
          await this.publishWebuiMessageQueueRemoved(slot.root, removedRevision);
        } catch {
          // The rejection below still terminates the originating request.
        }
      }
      if (slot.rootDelivery !== "pending") continue;
      try {
        await this.publishWebuiMessageRejected(slot.root, reason, slot);
      } catch {
        // Cleanup must not hide the dispatch result.
      }
    }
  }

  private async finalizeQueueSteerAdmissions(
    sessionKey: string,
    turnId: string,
  ): Promise<void> {
    const accepted: QueueSteerAdmission[] = [];
    const requeued: Array<{
      message: InboundMessage;
      revision: number;
      store: "slot" | "goal";
    }> = [];
    await this.queueMutationLockFor(sessionKey).runExclusive(async () => {
      const admissions = this.queueSteerAdmissionsBySession.get(sessionKey);
      if (!admissions) return;
      const session = this.sessions.get(sessionKey);
      for (const [clientRequestId, admission] of admissions) {
        if (admission.turnId !== turnId) continue;
        const persisted = session?.messages.some((message) => (
          message?.role === "user"
          && message?.client_request_id === clientRequestId
          && firstString(message?.turn_id, message?.turnId) === turnId
        ));
        if (persisted) {
          await this.goalRuntime.completeQueueSteerTransfer(sessionKey, clientRequestId);
          admissions.delete(clientRequestId);
          accepted.push(admission);
          continue;
        }

        const queuedAt = this.nextQueuedAt(sessionKey);
        const transfer = this.goalRuntime.queueSteerTransfers(sessionKey)
          .find((item) => item.clientRequestId === clientRequestId);
        if (!transfer) {
          admissions.delete(clientRequestId);
          continue;
        }
        const message = this.recoveredQueueMessage(transfer, queuedAt);
        if (admission.store === "goal") {
          await this.goalRuntime.restoreGoalQueueSteerTransfer(
            sessionKey,
            clientRequestId,
            queuedAt,
          );
        } else {
          this.scheduleRecoveredQueueSlot(sessionKey, message);
        }
        admissions.delete(clientRequestId);
        requeued.push({
          message,
          revision: this.advanceQueueRevision(sessionKey),
          store: admission.store,
        });
      }
      if (!admissions.size) this.queueSteerAdmissionsBySession.delete(sessionKey);
    });

    for (const admission of accepted) {
      await this.publishWebuiMessageAccepted(admission.message);
    }
    for (const item of requeued) {
      await this.publishWebuiMessageQueued(item.message, {
        visible: true,
        revision: item.revision,
      });
      if (item.store === "goal") void this.dispatchNextGoalWork(sessionKey);
    }
  }

  private async runTurnWithinLock(
    msg: InboundMessage,
    sessionKey: string,
    turnId: string,
    pending: AsyncQueue<InboundMessage>,
    isCancelled: () => boolean,
    abortSignal: AbortSignal | null,
    slot: TurnSlot | null,
  ): Promise<void> {
    const effectiveMsg = this.cloneInboundMessage(msg, {
      sessionKeyOverride: sessionKey !== msg.sessionKey ? sessionKey : msg.sessionKeyOverride,
      turnId,
    });
    let effectiveAbortSignal = abortSignal;
    let boundary = createTurnCancellationBoundary({ turnId, signal: effectiveAbortSignal });
    const publishRunStatus = shouldPublishWebuiRunStatus(effectiveMsg);
    let didPublishRunning = false;
    let goalTurnResult: { goalId: string; goalOutcome: GoalStatus } | null = null;
    if (slot) {
      let dequeuedDescriptor: QueueMessageDescriptor | null = null;
      let dequeuedRevision = this.queueRevision(sessionKey);
      await this.queueMutationLockFor(sessionKey).runExclusive(async () => {
        slot.state = "running";
        slot.acceptingSteer = false;
        slot.stopReason = null;
        if (
          slot.announcedToWebui
          && slot.root.metadata?.webui_queue_dequeued !== true
        ) {
          dequeuedDescriptor = this.queueDescriptorFromMessage(slot.root);
          if (dequeuedDescriptor) dequeuedRevision = this.advanceQueueRevision(sessionKey);
        }
      });
      if (dequeuedDescriptor) {
        await this.publishWebuiMessageDequeued(slot.root, dequeuedDescriptor, dequeuedRevision);
      }
    }
    try {
      await this.withTerminalTurn(
        sessionKey,
        effectiveMsg.channel,
        turnId,
        abortSignal,
        async (turnSignal) => {
          effectiveAbortSignal = turnSignal;
          boundary = createTurnCancellationBoundary({ turnId, signal: turnSignal });
          if (isCancelled()) return;
          if (effectiveMsg.channel === "websocket" && effectiveMsg.metadata?.webui === true) {
            const getSession = this.sessions.get;
            const existing = typeof getSession === "function"
              ? getSession.call(this.sessions, sessionKey)
              : null;
            if (!existing) {
              const peekReservation = this.sessions.peekWebuiSessionBindingReservation;
              if (typeof peekReservation === "function") {
                peekReservation.call(this.sessions, sessionKey);
              }
            }
          }
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
                    resuming,
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
            abortSignal: turnSignal,
            turnId,
            boundary,
            slot,
          });
          if (
            typeof response?.metadata?.goalId === "string"
            && typeof response?.metadata?.goalOutcome === "string"
          ) {
            goalTurnResult = {
              goalId: response.metadata.goalId,
              goalOutcome: response.metadata.goalOutcome as GoalStatus,
            };
          }
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
        },
      );
    } catch (error) {
      if (
        error instanceof SessionWorkspaceError
        && effectiveMsg.channel === "websocket"
        && typeof effectiveMsg.metadata?.client_request_id === "string"
      ) {
        const getSession = this.sessions.get;
        const session = typeof getSession === "function"
          ? getSession.call(this.sessions, sessionKey)
          : null;
        if (session) {
          this.clearPendingUserTurn(session);
          this.clearRuntimeCheckpoint(session);
          this.sessions.save(session, { fsync: true });
        }
        await this.bus.publishOutbound(
          new OutboundMessage({
            channel: "websocket",
            chatId: effectiveMsg.chatId,
            content: "",
            metadata: {
              webuiSessionWorkspaceLost: true,
              webuiRequestSessionKey: slot?.root.sessionKey ?? effectiveMsg.sessionKey,
              clientRequestId: effectiveMsg.metadata.client_request_id,
              reason: error.code === "workspace_missing"
                ? "workspace_missing"
                : "workspace_unavailable",
            },
          }),
        );
        if (slot) slot.rootDelivery = "rejected";
        return;
      }
      if (isTaskCancelledError(error)) {
        boundary.close("aborted");
        return;
      }
      try {
        const getSession = this.sessions.get;
        const session = typeof getSession === "function"
          ? getSession.call(this.sessions, sessionKey)
          : this.sessions.getOrCreate(sessionKey);
        if (!session) throw error;
        const restored = this.restoreRuntimeCheckpoint(session) || this.restorePendingUserTurn(session);
        if (restored) this.sessions.save(session);
      } catch {
        // Preserve the original dispatch failure; checkpoint restore is best-effort.
      }
      if (effectiveMsg.internal?.kind === "goal_continuation") {
        const currentGoal = this.goalRuntime.get(sessionKey);
        if (
          currentGoal?.status === "active"
          && currentGoal.goalId === effectiveMsg.internal.goalId
        ) {
          this.scheduleGoalWork(sessionKey, currentGoal);
        }
      }
      throw error;
    } finally {
      if (slot && slot.state !== "closed") {
        slot.acceptingSteer = false;
        slot.state = "settling";
      }
      this.discardQueueSteerResiduals(sessionKey, turnId, pending);
      await this.finalizeQueueSteerAdmissions(sessionKey, turnId);
      if (didPublishRunning) {
        await finishWebuiTurn({
          bus: this.bus,
          msg: effectiveMsg,
          sessionKey,
          sessions: this.sessions,
          ...(goalTurnResult ?? {}),
        });
      }
      boundary.close(effectiveAbortSignal?.aborted ? "aborted" : "ended");
      this.goalRuntime.releaseTurn(sessionKey, turnId);
      this.goalRuntime.releaseWork(sessionKey, turnId);
    }
  }

  private async dispatchSlot(
    sessionKey: string,
    initialSlot: TurnSlot,
    isCancelled: () => boolean,
    abortSignal: AbortSignal,
  ): Promise<void> {
    try {
      await this.lockFor(sessionKey).runExclusive(async () => {
        let slot = initialSlot;
        while (!isCancelled()) {
          await this.runTurnWithinLock(
            slot.root,
            sessionKey,
            slot.turnId,
            slot.pendingSteer,
            isCancelled,
            abortSignal,
            slot,
          );
          slot.acceptingSteer = false;
          slot.state = "closed";
          const residual = this.drainInboundQueue(slot.pendingSteer);
          if (slot.stopReason === "maxIterations" && residual.length && !isCancelled()) {
            const successorRoot = this.cloneInboundMessage(residual[0], {
              turnAdmission: "queue",
              metadata: withoutTurnMetadata(residual[0].metadata),
            });
            const successor = this.createTurnSlot(
              successorRoot,
              `${successorRoot.channel}\0${String(successorRoot.chatId)}`,
              slot.owner,
            );
            for (const message of residual.slice(1)) successor.pendingSteer.put(message);
            const slots = this.turnSlots.get(sessionKey) ?? [];
            const currentIndex = slots.indexOf(slot);
            if (currentIndex >= 0) slots.splice(currentIndex, 1, successor);
            else slots.unshift(successor);
            this.turnSlots.set(sessionKey, slots);
            slot = successor;
            continue;
          }
          this.removeTurnSlot(sessionKey, slot);
          if (!isCancelled()) {
            for (const message of residual) {
              await this.bus.publishInbound(this.cloneInboundMessage(message, {
                turnAdmission: "queue",
              }));
            }
          }
          return;
        }
      });
    } finally {
      await this.cleanupOwnedSlots(
        sessionKey,
        initialSlot.owner,
        isCancelled() ? "turn_queue_cancelled" : "turn_start_failed",
      );
    }
  }

  async dispatchMessage(
    msg: InboundMessage,
    isCancelled: () => boolean = () => false,
    abortSignal: AbortSignal | null = null,
    slotPending: AsyncQueue<InboundMessage> | null = null,
  ): Promise<void> {
    const sessionKey = this.effectiveSessionKey(msg);
    const turnId = firstString(msg.metadata?.turn_id, msg.metadata?.turnId) ?? cryptoRandomId();
    const pending = slotPending ?? new AsyncQueue<InboundMessage>();
    if (!slotPending) this.pendingQueues.set(sessionKey, pending);
    try {
      await this.lockFor(sessionKey).runExclusive(
        () => this.runTurnWithinLock(
          msg,
          sessionKey,
          turnId,
          pending,
          isCancelled,
          abortSignal,
          null,
        ),
      );
    } finally {
      if (!slotPending && this.pendingQueues.get(sessionKey) === pending) {
        this.pendingQueues.delete(sessionKey);
      }
      if (!isCancelled()) {
        for (const message of this.drainInboundQueue(pending)) {
          await this.bus.publishInbound(this.cloneInboundMessage(message, {
            turnAdmission: "queue",
          }));
        }
      }
    }
  }

  async run(): Promise<void> {
    this.running = true;
    await this.initializeRuntimeTools();
    if (!this.running) return;
    await this.recoverQueueSteerTransfers();
    await this.recoverGoalWork();
    while (this.running) {
      const inbound = this.bus.inbound.getNowait();
      if (!inbound) {
        this.autoCompact.checkExpired(
          (promise) => this.scheduleBackground(promise),
          this.busySessionKeysForAutoCompact(),
        );
        await sleep(100);
        continue;
      }
      const msg = this.normalizeSharedInboundMessage(inbound);
      const canReloadMcp = this.activeTasks.size === 0 && this.pendingQueues.size === 0 && this.turnSlots.size === 0;
      if (await handleRuntimeControl(this, msg, this.tools, canReloadMcp)) continue;
      const raw = msg.content.trim();
      const effectiveKey = this.effectiveSessionKey(msg);
      const deletionQueue = this.sessionDeletionQueues.get(effectiveKey);
      if (deletionQueue) {
        const deferred = this.cloneInboundMessage(msg, {
          turnAdmission: "queue",
        });
        deletionQueue.push(deferred);
        await this.publishWebuiMessageQueued(deferred);
        continue;
      }
      if (this.commands.isPriority(raw)) {
        if (
          sharedTurnSource(msg)?.kind === "tui"
          && ["/restart", "/stop"].includes(raw.toLowerCase())
        ) {
          await this.publishWebuiMessageRejected(msg, "tui_targeted_control_required");
          continue;
        }
        await this.dispatchCommandInline(msg, msg.sessionKey, raw, (ctx) => this.commands.dispatchPriority(ctx));
        continue;
      }
      const reservedTurnId = firstString(msg.metadata?.turn_id, msg.metadata?.turnId);
      const ownsGoalReservation = reservedTurnId
        ? this.goalRuntime.ownsWorkReservation(effectiveKey, reservedTurnId)
        : false;
      if (msg.internal?.kind === "goal_continuation" && !ownsGoalReservation) {
        continue;
      }
      const dispatchableCommand = this.commands.isDispatchableCommand(raw);
      if (
        !msg.internal
        && !ownsGoalReservation
        && dispatchableCommand
        && isImmediateGoalControlCommand(raw)
      ) {
        await this.dispatchCommandInline(msg, effectiveKey, raw, (ctx) => this.commands.dispatch(ctx));
        continue;
      }
      const shouldTryEarlyTuiSteer = msg.turnAdmission === "steer"
        && sharedTurnSource(msg)?.kind === "tui"
        && !msg.content.trimStart().startsWith("/");
      let didTryDirectSteer = false;
      if (shouldTryEarlyTuiSteer) {
        didTryDirectSteer = true;
        const steeredTurnId = await this.tryAdmitDirectSteer(effectiveKey, msg);
        if (steeredTurnId) {
          await this.publishWebuiMessageSteered(msg, steeredTurnId);
          continue;
        }
      }
      const goal = this.goalRuntime.get(effectiveKey);
      const shouldPersistGoalInbox = !msg.internal
        && !ownsGoalReservation
        && (
          this.goalRuntime.hasGoalLease(effectiveKey)
          || this.goalRuntime.hasWorkReservation(effectiveKey)
          || this.scheduledGoalSessions.has(effectiveKey)
          || (goal?.status === "active" && (this.activeTasks.get(effectiveKey)?.length ?? 0) > 0)
      );
      if (shouldPersistGoalInbox) {
        let enqueuedEntry: GoalTurnInboxEntry | null = null;
        let queuedRevision = this.queueRevision(effectiveKey);
        try {
          if (isSharedQueueMessage(msg)) {
            await this.queueMutationLockFor(effectiveKey).runExclusive(async () => {
              msg.metadata.queued_at = this.nextQueuedAt(effectiveKey);
              enqueuedEntry = await this.goalRuntime.enqueueUserMessage(effectiveKey, msg);
              queuedRevision = this.advanceQueueRevision(effectiveKey);
            });
            await this.publishWebuiMessageQueued(msg, {
              visible: true,
              revision: queuedRevision,
            });
          } else {
            enqueuedEntry = await this.goalRuntime.enqueueUserMessage(effectiveKey, msg);
          }
          await this.publishWebuiMessageAccepted(msg);
          void this.dispatchNextGoalWork(effectiveKey);
        } catch (error) {
          if (enqueuedEntry && isSharedQueueMessage(msg)) {
            await this.queueMutationLockFor(effectiveKey).runExclusive(async () => {
              const removed = await this.goalRuntime.removeUnreservedInboxEntry(
                effectiveKey,
                enqueuedEntry!.id,
              ).catch(() => "missing" as const);
              if (removed === "removed") this.advanceQueueRevision(effectiveKey);
            });
          }
          const reason = error instanceof GoalRuntimeError ? error.code : "goal_inbox_unavailable";
          await this.publishWebuiMessageRejected(msg, reason);
        }
        continue;
      }
      const route = `${msg.channel}\0${String(msg.chatId)}`;
      let slots = this.turnSlots.get(effectiveKey) ?? [];
      const lastSlot = slots.at(-1);
      const directPending = this.pendingQueues.get(effectiveKey) ?? null;
      if (
        dispatchableCommand
        && !isSessionOrderedCommand(raw)
        && (directPending !== null || lastSlot?.route === route)
      ) {
        await this.dispatchCommandInline(msg, effectiveKey, raw, (ctx) => this.commands.dispatch(ctx));
        continue;
      }
      if (msg.turnAdmission === "steer" && !didTryDirectSteer) {
        const requestedSource = sharedTurnSource(msg);
        const steeredTurnId = await this.tryAdmitDirectSteer(effectiveKey, msg);
        if (steeredTurnId) {
          if (requestedSource?.kind === "tui") {
            await this.publishWebuiMessageSteered(msg, steeredTurnId);
          }
          continue;
        }
      }
      const root = this.cloneInboundMessage(msg, {
        turnAdmission: "queue",
      });
      const owner = Symbol("turn-slot-owner");
      let hadEarlierSessionWork = false;
      let visibleQueueItem = false;
      let queuedRevision = this.queueRevision(effectiveKey);
      let slot!: TurnSlot;
      await this.queueMutationLockFor(effectiveKey).runExclusive(async () => {
        slots = this.turnSlots.get(effectiveKey) ?? [];
        hadEarlierSessionWork = this.isSessionBusy(effectiveKey);
        visibleQueueItem = hadEarlierSessionWork
          && !ownsGoalReservation
          && isSharedQueueMessage(root);
        if (visibleQueueItem) {
          root.metadata.queued_at = this.nextQueuedAt(effectiveKey);
        }
        slot = this.createTurnSlot(root, route, owner);
        if (visibleQueueItem) {
          slot.announcementGate = createTurnSlotAnnouncementGate();
          slot.announcedToWebui = true;
          queuedRevision = this.advanceQueueRevision(effectiveKey);
        }
        if (ownsGoalReservation && isSharedQueueMessage(root)) {
          slot.announcedToWebui = true;
        }
        slots.push(slot);
        this.turnSlots.set(effectiveKey, slots);
      });
      const task = makeCancelableDispatchTask(
        async (isCancelled, signal) => {
          if (slot.announcementGate) await slot.announcementGate.promise;
          if (isCancelled()) return;
          await this.dispatchSlot(effectiveKey, slot, isCancelled, signal);
        },
      );
      slot.dispatchTask = task;
      const list = this.activeTasks.get(effectiveKey) ?? [];
      list.push(task);
      this.activeTasks.set(effectiveKey, list);
      task
        .finally(() => {
          const current = this.activeTasks.get(effectiveKey) ?? [];
          const next = current.filter((item) => item !== task);
          if (next.length) this.activeTasks.set(effectiveKey, next);
          else this.activeTasks.delete(effectiveKey);
          void this.dispatchNextGoalWork(effectiveKey);
        })
        .catch(() => undefined);
      if (hadEarlierSessionWork) {
        try {
          await this.publishWebuiMessageQueued(root, {
            visible: visibleQueueItem,
            revision: queuedRevision,
          });
        } catch {
          await this.queueMutationLockFor(effectiveKey).runExclusive(async () => {
            slot.announcedToWebui = false;
            slot.state = "closed";
            slot.announcementGate?.open();
            this.removeTurnSlot(effectiveKey, slot);
            const active = this.activeTasks.get(effectiveKey) ?? [];
            const remaining = active.filter((candidate) => candidate !== task);
            if (remaining.length) this.activeTasks.set(effectiveKey, remaining);
            else this.activeTasks.delete(effectiveKey);
            task.cancel();
            if (visibleQueueItem) this.advanceQueueRevision(effectiveKey);
          });
          try {
            await this.publishWebuiMessageRejected(root, "turn_start_failed", slot);
          } catch {
            // The original queue publication error remains the dispatch result.
          }
          continue;
        }
      }
      slot.announcementGate?.open();
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
      sessionBindingOverride,
      abortSignal = null,
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
      sessionBindingOverride?: WebuiSessionBinding | null;
      abortSignal?: AbortSignal | null;
    } = {},
  ): Promise<OutboundMessage | null> {
    await reloadLock(this);
    const key = sessionKey.startsWith("cli:")
      ? sessionKey
      : this.unifiedSession
        ? UNIFIED_SESSION_KEY
        : sessionKey;
    const turnId = cryptoRandomId();
    const pendingMarker = new AsyncQueue<InboundMessage>();
    this.pendingQueues.set(key, pendingMarker);
    try {
      await this.initializeRuntimeTools();
      const msg = new InboundMessage({
        channel,
        chatId,
        senderId: "user",
        content,
        media,
        metadata,
        sessionKey: key,
      });
      return await this.lockFor(key).runExclusive(() => this.withTerminalTurn(
        key,
        channel,
        turnId,
        abortSignal,
        (turnSignal) => this.processMessageInternal(msg, key, {
          onProgress,
          onStream,
          onStreamEnd,
          messageSendCallback,
          sessionBindingOverride,
          abortSignal: turnSignal,
          turnId,
        }),
      ));
    } catch (error) {
      if (isTaskCancelledError(error)) return null;
      throw error;
    } finally {
      if (this.pendingQueues.get(key) === pendingMarker) this.pendingQueues.delete(key);
      this.goalRuntime.releaseTurn(key, turnId);
      void this.dispatchNextGoalWork(key);
    }
  }
}
