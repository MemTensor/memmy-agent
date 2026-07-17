import { LLMProvider, LLMResponse, ToolCallRequest } from "../../providers/base.js";
import { ToolRegistry } from "./tools/registry.js";
import type { ToolExecutionContext } from "./tools/base.js";
import { AgentHook, AgentHookContext } from "./hook.js";
import {
  buildFinalizationRetryMessage,
  buildGoalContinueMessage,
  buildLengthRecoveryMessage,
  EMPTY_FINAL_RESPONSE_MESSAGE,
  ensureNonemptyToolResult,
  isBlankText,
  repeatedExternalLookupError,
  repeatedWorkspaceViolationError,
} from "../../utils/runtime.js";
import {
  estimateMessageTokens,
  estimatePromptTokensChain,
  extractReasoning,
  findLegalMessageStart,
  IncrementalThinkExtractor,
  maybePersistToolResult,
  stripThink,
  truncateText,
} from "../../utils/helpers.js";
import {
  buildFileEditEndEvent,
  buildFileEditErrorEvent,
  buildFileEditStartEvent,
  prepareFileEditTrackers,
  StreamingFileEditTracker,
} from "../../utils/file-edit-events.js";
import {
  invokeFileEditProgress,
  onProgressAcceptsFileEditEvents,
} from "../../utils/progress-events.js";
import { renderTemplate } from "../../utils/prompt-templates.js";
import type { TurnCancellationBoundary } from "./turn-cancellation-boundary.js";
import { resolveToolResultMaxChars, type ToolResultMaxCharsByName } from "./tool-result-budget.js";

const DEFAULT_ERROR_MESSAGE = "Sorry, I encountered an error calling the AI model.";
const PERSISTED_MODEL_ERROR_PLACEHOLDER = "[Assistant reply unavailable due to model error.]";
export const MAX_EMPTY_RETRIES = 2;
const MAX_LENGTH_RECOVERIES = 3;
export const MAX_INJECTIONS_PER_TURN = 3;
const SNIP_SAFETY_BUFFER = 1024;
const MICROCOMPACT_MIN_CHARS = 500;
const COMPACTABLE_TOOLS = new Set([
  "read_file",
  "exec",
  "grep",
  "find_files",
  "web_search",
  "web_fetch",
  "list_dir",
  "list_exec_sessions",
]);
export const BACKFILL_CONTENT = "[Tool result unavailable - call was interrupted or lost]";

export const MAX_INJECTION_CYCLES = 5;
export const MICROCOMPACT_KEEP_RECENT = 10;

export class AgentRunSpec {
  messages: Record<string, any>[];
  initialMessages: Record<string, any>[];
  tools?: ToolRegistry | any;
  provider?: LLMProvider;
  model?: string | null;
  maxIterations: number;
  maxTokens: number;
  temperature: number | null;
  reasoningEffort?: string | null;
  maxToolResultChars: number;
  toolResultMaxCharsByName: ToolResultMaxCharsByName;
  failOnToolError: boolean;
  concurrentTools: boolean;
  hook?: AgentHook | null;
  errorMessage: string | null;
  maxIterationsMessage: string | null;
  workspace?: string | null;
  sessionKey?: string | null;
  contextWindowTokens?: number | null;
  contextBlockLimit?: number | null;
  providerRetryMode: string;
  progressCallback?: any;
  streamProgressDeltas: boolean;
  retryWaitCallback?: any;
  checkpointCallback?: ((payload: Record<string, any>) => Promise<void> | void) | null;
  injectionCallback?: ((opts?: { limit?: number }) => Promise<any[]> | any[]) | null;
  llmTimeoutS?: number | null;
  abortSignal?: AbortSignal | null;
  turnId?: string | null;
  boundary?: TurnCancellationBoundary | null;
  goalActivePredicate?: (() => boolean) | null;
  goalContinueMessage?: string | null;

  constructor(init: {
    messages?: Record<string, any>[];
    initialMessages?: Record<string, any>[];
    provider?: LLMProvider;
    tools?: ToolRegistry | any;
    model?: string | null;
    maxIterations?: number;
    maxTokens?: number;
    temperature?: number | null;
    reasoningEffort?: string | null;
    maxToolResultChars?: number;
    toolResultMaxCharsByName?: ToolResultMaxCharsByName;
    failOnToolError?: boolean;
    concurrentTools?: boolean;
    hook?: AgentHook | null;
    errorMessage?: string | null;
    maxIterationsMessage?: string | null;
    workspace?: string | null;
    sessionKey?: string | null;
    contextWindowTokens?: number | null;
    contextBlockLimit?: number | null;
    providerRetryMode?: string;
    progressCallback?: any;
    streamProgressDeltas?: boolean;
    retryWaitCallback?: any;
    checkpointCallback?: ((payload: Record<string, any>) => Promise<void> | void) | null;
    injectionCallback?: ((opts?: { limit?: number }) => Promise<any[]> | any[]) | null;
    llmTimeoutS?: number | null;
    abortSignal?: AbortSignal | null;
    turnId?: string | null;
    boundary?: TurnCancellationBoundary | null;
    goalActivePredicate?: (() => boolean) | null;
    goalContinueMessage?: string | null;
  } = {}) {
    this.messages = this.initialMessages = init.messages ?? init.initialMessages ?? [];
    this.provider = init.provider;
    this.tools = init.tools;
    this.model = init.model ?? null;
    this.maxIterations = init.maxIterations ?? 200;
    this.maxTokens = init.maxTokens ?? 4096;
    this.temperature = init.temperature ?? 0.7;
    this.reasoningEffort = init.reasoningEffort ?? null;
    this.maxToolResultChars = init.maxToolResultChars ?? 100_000;
    this.toolResultMaxCharsByName = init.toolResultMaxCharsByName ?? {};
    this.failOnToolError = init.failOnToolError ?? false;
    this.concurrentTools = init.concurrentTools ?? false;
    this.hook = init.hook ?? null;
    this.errorMessage = init.errorMessage === undefined ? DEFAULT_ERROR_MESSAGE : init.errorMessage;
    this.maxIterationsMessage = init.maxIterationsMessage ?? null;
    this.workspace = init.workspace ?? null;
    this.sessionKey = init.sessionKey ?? null;
    this.contextWindowTokens = init.contextWindowTokens ?? null;
    this.contextBlockLimit = init.contextBlockLimit ?? null;
    this.providerRetryMode = init.providerRetryMode ?? "standard";
    this.progressCallback = init.progressCallback ?? null;
    this.streamProgressDeltas = init.streamProgressDeltas ?? true;
    this.retryWaitCallback = init.retryWaitCallback ?? null;
    this.checkpointCallback = init.checkpointCallback ?? null;
    this.injectionCallback = init.injectionCallback ?? null;
    this.llmTimeoutS = init.llmTimeoutS ?? null;
    this.abortSignal = init.abortSignal ?? null;
    this.turnId = init.turnId ?? null;
    this.boundary = init.boundary ?? null;
    this.goalActivePredicate = init.goalActivePredicate ?? null;
    this.goalContinueMessage = init.goalContinueMessage ?? null;
  }
}

export class AgentRunResult {
  finalContent: string | null;
  finalContentStreamed: boolean;
  content: string;
  messages: Record<string, any>[];
  toolCalls: any[];
  toolsUsed: string[];
  toolEvents: Record<string, any>[];
  usage: Record<string, any>;
  response: LLMResponse;
  stopReason: string;
  finishReason: string;
  error: string | null;
  hadInjections: boolean;

  constructor(init: {
    finalContent?: string | null;
    finalContentStreamed?: boolean;
    content?: string | null;
    messages?: Record<string, any>[];
    toolCalls?: any[];
    toolsUsed?: string[];
    toolEvents?: Record<string, any>[];
    usage?: Record<string, any>;
    response?: LLMResponse;
    stopReason?: string;
    finishReason?: string;
    error?: string | null;
    hadInjections?: boolean;
  }) {
    const response = init.response ?? new LLMResponse({ content: init.content ?? init.finalContent ?? "" });
    this.finalContent = init.finalContent ?? init.content ?? response.content ?? "";
    this.finalContentStreamed = Boolean(init.finalContentStreamed);
    this.content = init.content ?? this.finalContent ?? "";
    this.messages = init.messages ?? [];
    this.toolCalls = init.toolCalls ?? [];
    this.toolsUsed = init.toolsUsed ?? [];
    this.toolEvents = init.toolEvents ?? [];
    this.usage = init.usage ?? {};
    this.response = response;
    this.stopReason = init.stopReason ?? "completed";
    this.finishReason = init.finishReason ?? response.finishReason;
    this.error = init.error ?? null;
    this.hadInjections = init.hadInjections ?? false;
  }
}

export class AgentRunner {
  provider?: LLMProvider;

  constructor(provider?: LLMProvider | null) {
    this.provider = provider ?? undefined;
  }

  static mergeMessageContent(left: any, right: any): string | Array<Record<string, any>> {
    if (typeof left === "string" && typeof right === "string") return left ? `${left}\n\n${right}` : right;
    const toBlocks = (value: any): Array<Record<string, any>> => {
      if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? item : { type: "text", text: String(item) }));
      if (value == null) return [];
      return [{ type: "text", text: String(value) }];
    };
    return [...toBlocks(left), ...toBlocks(right)];
  }

  static appendInjectedMessages(messages: Record<string, any>[], injections: Record<string, any>[]): void {
    for (const injection of injections) {
      if (messages.length && injection.role === "user" && messages.at(-1)?.role === "user") {
        const merged = { ...messages.at(-1)! };
        merged.content = AgentRunner.mergeMessageContent(merged.content, injection.content);
        messages[messages.length - 1] = merged;
      } else {
        messages.push(injection);
      }
    }
  }

  async drainInjections(spec: AgentRunSpec): Promise<Record<string, any>[]> {
    const callback = spec.injectionCallback;
    if (!callback) return [];
    let items: any[] = [];
    try {
      items = await callback({ limit: MAX_INJECTIONS_PER_TURN });
    } catch {
      try {
        items = await (callback as any)();
      } catch {
        return [];
      }
    }
    if (!Array.isArray(items) || !items.length) return [];
    const messages: Record<string, any>[] = [];
    for (const item of items) {
      if (item && typeof item === "object" && item.role === "user" && "content" in item) {
        const content = item.content;
        if (typeof content === "string" && !content.trim()) continue;
        messages.push({ role: "user", content });
      } else {
        const text = String(item?.content ?? item ?? "");
        if (text.trim()) messages.push({ role: "user", content: text });
      }
    }
    return messages.slice(0, MAX_INJECTIONS_PER_TURN);
  }

  private async tryDrainInjections(
    spec: AgentRunSpec,
    messages: Record<string, any>[],
    assistantMessage: Record<string, any> | null,
    injectionCycles: number,
    opts: { phase?: string; iteration?: number | null; allowGoalContinue?: boolean } = {},
  ): Promise<[boolean, number]> {
    let injections: Record<string, any>[] = [];
    let realInjection = false;
    if (injectionCycles < MAX_INJECTION_CYCLES) {
      injections = await this.drainInjections(spec);
      realInjection = injections.length > 0;
    }
    const predicate = spec.goalActivePredicate;
    if (!injections.length && opts.allowGoalContinue && assistantMessage && predicate?.()) {
      injections = [buildGoalContinueMessage(spec.goalContinueMessage ?? null)];
    }
    if (!injections.length) return [false, injectionCycles];
    if (realInjection) injectionCycles += 1;
    if (assistantMessage) {
      messages.push(assistantMessage);
      if (opts.iteration != null) {
        await this.emitCheckpoint(spec, {
          phase: "finalResponse",
          iteration: opts.iteration,
          model: spec.model,
          assistantMessage,
          completedToolResults: [],
          pendingToolCalls: [],
        });
      }
    }
    AgentRunner.appendInjectedMessages(messages, injections);
    return [true, injectionCycles];
  }

  private buildRequestArgs(spec: AgentRunSpec, messages: Record<string, any>[], tools: Record<string, any>[] | null): Record<string, any> {
    const args: Record<string, any> = {
      messages: messages.map((message) => {
        const providerMessage = { ...message };
        delete providerMessage.finish_reason;
        return providerMessage;
      }),
      tools,
      model: spec.model,
      retryMode: spec.providerRetryMode,
      onRetryWait: spec.retryWaitCallback,
    };
    if (spec.temperature != null) args.temperature = spec.temperature;
    if (spec.maxTokens != null) args.maxTokens = spec.maxTokens;
    if (spec.reasoningEffort != null) args.reasoningEffort = spec.reasoningEffort;
    return args;
  }

  private async callProvider(provider: any, args: any, stream = false): Promise<LLMResponse> {
    if (stream) {
      if (typeof provider.chatStreamWithRetry === "function") return provider.chatStreamWithRetry(args);
      if (typeof provider.chatStream === "function") return provider.chatStream(args);
    }
    if (typeof provider.chatWithRetry === "function") return provider.chatWithRetry(args);
    return provider.chat(args);
  }

  private async requestModel(spec: AgentRunSpec, messages: Record<string, any>[], hook: AgentHook, context: AgentHookContext): Promise<LLMResponse> {
    const provider = spec.provider ?? this.provider;
    if (!provider) throw new Error("AgentRunSpec.provider is required");
    if (spec.abortSignal?.aborted) return abortedResponse();
    const boundary = spec.boundary ?? null;
    const shouldEmitLive = (): boolean => boundary?.shouldEmitLive() ?? spec.abortSignal?.aborted !== true;
    const timeoutS = normalizeTimeout(spec.llmTimeoutS);
    const tools = spec.tools?.getDefinitions?.() ?? [];
    const wantsStreaming = hook.wantsStreaming();
    const providerRuntime = provider as any;
    const wantsProgressStreaming =
      !wantsStreaming &&
      spec.streamProgressDeltas &&
      spec.progressCallback &&
      (
        providerRuntime.supportsProgressDeltas === true ||
        (provider.constructor as any)?.supportsProgressDeltas === true
      );
    const args = this.buildRequestArgs(spec, messages, tools);
    const liveFileEdits = spec.progressCallback && onProgressAcceptsFileEditEvents(spec.progressCallback)
      ? new StreamingFileEditTracker({
        workspace: spec.workspace ?? null,
        tools: spec.tools,
        emit: (events) => invokeFileEditProgress(spec.progressCallback, events),
      })
      : null;

    const attachToolCallDelta = (): void => {
      if (!liveFileEdits) return;
      args.onToolCallDelta = async (delta: Record<string, any>) => {
        if (!shouldEmitLive()) return;
        await liveFileEdits.update(delta);
      };
    };

    const finishLiveFileEdits = async (response: LLMResponse): Promise<LLMResponse> => {
      if (!liveFileEdits) return response;
      await liveFileEdits.flush();
      if (response.shouldExecuteTools) liveFileEdits.applyFinalCallIds(response.toolCalls);
      await liveFileEdits.errorUnmatched(
        response.shouldExecuteTools ? response.toolCalls : [],
        "Tool call did not complete.",
      );
      liveFileEdits.close();
      return response;
    };

    const abortLiveFileEdits = async (): Promise<void> => {
      boundary?.close("aborted");
      await liveFileEdits?.abort("Task cancelled.");
    };

    if (wantsStreaming) {
      attachToolCallDelta();
      if (spec.abortSignal) args.signal = spec.abortSignal;
      args.onContentDelta = async (delta: string) => {
        if (!shouldEmitLive()) return;
        if (delta) context.streamedContent = true;
        await hook.onStream(context, delta);
      };
      args.onThinkingDelta = async (delta: string) => {
        if (!delta || !shouldEmitLive()) return;
        context.streamedReasoning = true;
        await hook.emitReasoning(delta);
      };
      try {
        return finishLiveFileEdits(await withAbort(this.callProvider(provider, args, true), spec.abortSignal));
      } catch (error) {
        if (isAbortError(error)) {
          await abortLiveFileEdits();
          return abortedResponse();
        }
        throw error;
      }
    }

    if (wantsProgressStreaming) {
      attachToolCallDelta();
      if (spec.abortSignal) args.signal = spec.abortSignal;
      let streamBuf = "";
      const thinkExtractor = new IncrementalThinkExtractor();
      const progressState = { reasoningOpen: false };
      args.onContentDelta = async (delta: string) => {
        if (!delta || !shouldEmitLive()) return;
        const previousVisible = stripThink(streamBuf);
        streamBuf += delta;
        const nextVisible = stripThink(streamBuf);
        const incremental = nextVisible.slice(previousVisible.length);
        if (await thinkExtractor.feed(streamBuf, (text) => shouldEmitLive() ? hook.emitReasoning(text) : undefined)) {
          context.streamedReasoning = true;
          progressState.reasoningOpen = true;
        }
        if (incremental && shouldEmitLive()) {
          if (progressState.reasoningOpen) {
            await hook.emitReasoningEnd();
            progressState.reasoningOpen = false;
          }
          context.streamedContent = true;
          await spec.progressCallback?.(incremental);
        }
      };
      let response: LLMResponse;
      try {
        response = await finishLiveFileEdits(await withAbort(this.callProvider(provider, args, true), spec.abortSignal));
      } catch (error) {
        if (isAbortError(error)) {
          await abortLiveFileEdits();
          return abortedResponse();
        }
        throw error;
      }
      if (progressState.reasoningOpen && shouldEmitLive()) await hook.emitReasoningEnd();
      return response;
    }

    try {
      if (spec.abortSignal) args.signal = spec.abortSignal;
      const promise = this.callProvider(provider, args, false);
      const timed = timeoutS == null ? promise : withTimeout(promise, timeoutS);
      return await withAbort(timed, spec.abortSignal);
    } catch (error) {
      if (isAbortError(error)) return abortedResponse();
      if ((error as Error).message === "llmTimeout") {
        return new LLMResponse({
          content: `Error calling LLM: timed out after ${timeoutS}s`,
          finishReason: "error",
          errorKind: "timeout",
        });
      }
      throw error;
    }
  }

  private async requestFinalizationRetry(spec: AgentRunSpec, messages: Record<string, any>[]): Promise<LLMResponse> {
    const provider = spec.provider ?? this.provider;
    if (!provider) throw new Error("AgentRunSpec.provider is required");
    const retryMessages = [...messages, buildFinalizationRetryMessage()];
    const args = this.buildRequestArgs(spec, retryMessages, null);
    if (spec.abortSignal) args.signal = spec.abortSignal;
    try {
      return await withAbort(this.callProvider(provider, args, false), spec.abortSignal);
    } catch (error) {
      if (isAbortError(error)) return abortedResponse();
      throw error;
    }
  }

  private usageDict(usage: Record<string, any> | null | undefined): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(usage ?? {})) {
      const num = Number(value);
      if (Number.isFinite(num)) result[key] = Math.trunc(num);
    }
    return result;
  }

  private accumulateUsage(target: Record<string, any>, usage: Record<string, any> | null | undefined): void {
    for (const [key, value] of Object.entries(this.usageDict(usage))) target[key] = Number(target[key] ?? 0) + value;
  }

  private mergeUsage(left: Record<string, any>, right: Record<string, any>): Record<string, any> {
    const merged = { ...left };
    this.accumulateUsage(merged, right);
    return merged;
  }

  private assistantMessage(response: LLMResponse): Record<string, any> {
    return buildAssistantMessage(response.content ?? "", {
      toolCalls: response.toolCalls.map((call) => call.toOpenAIToolCall()),
      reasoningContent: response.reasoningContent,
      thinkingBlocks: response.thinkingBlocks,
      finishReason: response.finishReason,
    });
  }

  private normalizeToolResult(spec: AgentRunSpec, callId: string, name: string, result: any): any {
    const wasEmpty =
      result == null ||
      (typeof result === "string" && (!result.trim() || /^\(.+ completed with no output\)$/.test(result.trim()))) ||
      (Array.isArray(result) && result.length === 0);
    let content = ensureNonemptyToolResult(name, result);
    const maxChars = resolveToolResultMaxChars(name, spec.maxToolResultChars, spec.toolResultMaxCharsByName);
    try {
      content = maybePersistToolResult(
        spec.workspace ?? undefined,
        spec.sessionKey ?? "default",
        callId,
        content,
        { maxChars },
      );
    } catch {
      content = result;
    }
    if (!wasEmpty && typeof content === "string" && content.length > maxChars) {
      return truncateText(content, maxChars);
    }
    return content;
  }

  async executeTools(
    spec: AgentRunSpec,
    calls: ToolCallRequest[],
    externalLookupCounts: Record<string, number> = {},
    workspaceViolationCounts: Record<string, number> = {},
  ): Promise<Array<{ call: any; result: any; event: Record<string, any>; error?: any }>> {
    if (!spec.tools) return [];
    if (spec.abortSignal?.aborted) return [];
    const batches = this.partitionToolBatches(spec, calls);
    const out: Array<{ call: any; result: any; event: Record<string, any>; error?: any }> = [];
    for (const batch of batches) {
      if (spec.concurrentTools && batch.length > 1) {
        out.push(...(await Promise.all(batch.map((call) => this.runTool(spec, call, externalLookupCounts, workspaceViolationCounts)))));
      } else {
        for (const call of batch) {
          if (spec.abortSignal?.aborted) break;
          out.push(await this.runTool(spec, call, externalLookupCounts, workspaceViolationCounts));
        }
      }
    }
    return out;
  }

  private async runTool(
    spec: AgentRunSpec,
    call: ToolCallRequest,
    externalLookupCounts: Record<string, number>,
    workspaceViolationCounts: Record<string, number>,
  ): Promise<{ call: ToolCallRequest; result: any; event: Record<string, any>; error?: any }> {
    const hint = "\n\n[Analyze the error above and try a different approach.]";
    if (spec.abortSignal?.aborted) {
      const event = { name: call.name, status: "error", detail: "task cancelled" };
      return { call, result: "Error: task cancelled", event, error: spec.failOnToolError ? createAbortError() : null };
    }
    const repeatedLookup = repeatedExternalLookupError(call.name, call.arguments, externalLookupCounts);
    if (repeatedLookup) {
      const event = { name: call.name, status: "error", detail: "repeated external lookup blocked" };
      return { call, result: repeatedLookup + hint, event, error: spec.failOnToolError ? new Error(repeatedLookup) : null };
    }

    const prepare = spec.tools?.prepareCall;
    let tool: any = null;
    let params: any = call.arguments;
    let prepError: string | null = null;
    if (typeof prepare === "function") {
      try {
        const prepared = prepare.call(spec.tools, call.name, call.arguments);
        if (Array.isArray(prepared) && prepared.length === 3) [tool, params, prepError] = prepared;
      } catch (error) {
        prepError = String((error as Error).message ?? error);
      }
    }
    if (prepError) {
      const event = { name: call.name, status: "error", detail: eventDetail("", prepError, 120) };
      const handled = this.classifyViolation(prepError, prepError + hint, event, call, workspaceViolationCounts);
      if (handled) return { call, ...handled };
      return { call, result: prepError + hint, event, error: spec.failOnToolError ? new Error(prepError) : null };
    }

    const progressCallback = spec.progressCallback && onProgressAcceptsFileEditEvents(spec.progressCallback)
      ? spec.progressCallback
      : null;
    const fileEditTrackers = progressCallback
      ? prepareFileEditTrackers({
        callId: call.id,
        toolName: call.name,
        tool,
        workspace: spec.workspace,
        params: params && typeof params === "object" && !Array.isArray(params) ? params : null,
      })
      : [];
    if (spec.abortSignal?.aborted) {
      const event = { name: call.name, status: "error", detail: "task cancelled" };
      return { call, result: "Error: task cancelled", event, error: spec.failOnToolError ? createAbortError() : null };
    }
    if (progressCallback && fileEditTrackers.length) {
      await invokeFileEditProgress(
        progressCallback,
        fileEditTrackers.map((tracker) => buildFileEditStartEvent(
          tracker,
          params && typeof params === "object" && !Array.isArray(params) ? params : null,
        )),
      );
    }

    try {
      let raw: any;
      await spec.hook?.beforeToolCall(new AgentHookContext({ spec, toolCalls: [call] }), call);
      const toolContext: ToolExecutionContext = {
        abortSignal: spec.abortSignal ?? null,
        toolName: call.name,
        callId: call.id ?? null,
      };
      const run = tool && typeof tool.execute === "function"
        ? tool.execute(params, toolContext)
        : spec.tools.execute(call.name, params, toolContext);
      raw = await withAbort(Promise.resolve(run), spec.abortSignal);
      if (spec.abortSignal?.aborted) throw createAbortError();
      let event: Record<string, any>;
      let error: any = null;
      if (typeof raw === "string" && raw.startsWith("Error")) {
        if (progressCallback && fileEditTrackers.length) {
          await invokeFileEditProgress(
            progressCallback,
            fileEditTrackers.map((tracker) => buildFileEditErrorEvent(tracker, raw)),
          );
        }
        event = { name: call.name, status: "error", detail: eventDetail("", raw, 120) };
        const handled = this.classifyViolation(raw, raw + hint, event, call, workspaceViolationCounts);
        if (handled) {
          await spec.hook?.afterToolCall(new AgentHookContext({ spec, toolCalls: [call], toolResults: [handled.result], toolEvents: [handled.event] }), call, handled.result);
          return { call, ...handled };
        }
        error = spec.failOnToolError ? new Error(raw) : null;
        raw = raw + hint;
      } else {
        const detail = toolEventDetail(raw);
        event = { name: call.name, status: "ok", detail };
      }
      if (spec.abortSignal?.aborted) throw createAbortError();
      if (progressCallback && fileEditTrackers.length) {
        await invokeFileEditProgress(
          progressCallback,
          fileEditTrackers.map((tracker) => buildFileEditEndEvent(
            tracker,
            params && typeof params === "object" && !Array.isArray(params) ? params : null,
          )),
        );
      }
      const result = this.normalizeToolResult(spec, call.id, call.name, raw);
      await spec.hook?.afterToolCall(new AgentHookContext({ spec, toolCalls: [call], toolResults: [result], toolEvents: [event] }), call, result);
      return { call, result, event, error };
    } catch (error) {
      const message = isAbortError(error)
        ? "Error: task cancelled"
        : `Error: ${(error as Error).constructor?.name ?? "Error"}: ${(error as Error).message ?? error}`;
      if (progressCallback && fileEditTrackers.length) {
        await invokeFileEditProgress(
          progressCallback,
          fileEditTrackers.map((tracker) => buildFileEditErrorEvent(tracker, message)),
        );
      }
      const event = { name: call.name, status: "error", detail: eventDetail("", message, 120) };
      const handled = this.classifyViolation(String((error as Error).message ?? error), message, event, call, workspaceViolationCounts);
      if (handled) return { call, ...handled };
      const result = this.normalizeToolResult(spec, call.id, call.name, message);
      return { call, result, event, error: spec.failOnToolError ? error : null };
    }
  }

  private classifyViolation(
    rawText: string,
    softPayload: string,
    event: Record<string, any>,
    call: ToolCallRequest,
    workspaceViolationCounts: Record<string, number>,
  ): { result: string; event: Record<string, any>; error?: any } | null {
    if (AgentRunner.isSsrfViolation(rawText)) {
      event.detail = eventDetail("ssrf_violation: ", rawText, 160);
      return { result: AgentRunner.ssrfSoftPayload(rawText), event, error: null };
    }
    if (AgentRunner.isWorkspaceViolation(rawText)) {
      const escalation = repeatedWorkspaceViolationError(call.name, call.arguments, workspaceViolationCounts);
      event.detail = eventDetail(escalation ? "workspace_violation_escalated: " : "workspace_violation: ", rawText, 160);
      return { result: escalation ?? softPayload, event, error: null };
    }
    return null;
  }

  static isSsrfViolation(text: string): boolean {
    const lowered = text.toLowerCase();
    return ["internal/private url detected", "private/internal address", "private address"].some((marker) => lowered.includes(marker));
  }

  static isWorkspaceViolation(text: string): boolean {
    const lowered = text.toLowerCase();
    return (
      this.isSsrfViolation(text) ||
      [
        "outside the configured workspace",
        "outside allowed directory",
        "working_dir is outside",
        "working_dir could not be resolved",
        "path outside working dir",
        "path traversal detected",
      ].some((marker) => lowered.includes(marker))
    );
  }

  static ssrfSoftPayload(rawText: string): string {
    const note =
      "This is a non-bypassable security boundary. Stop trying to access private/internal URLs. Do not retry with curl, wget, encoded IPs, alternate DNS, redirects, proxies, or another tool. Ask the user for local files, logs, screenshots, or an explicit safe public URL instead. Only the user can relax this with tools.ssrfWhitelist in config.";
    return `${rawText.trim() || "Error: request blocked by SSRF guard"}\n\n${note}`;
  }

  private async emitCheckpoint(spec: AgentRunSpec, payload: Record<string, any>): Promise<void> {
    await spec.checkpointCallback?.(payload);
  }

  static appendFinalMessage(messages: Record<string, any>[], content: string | null): void {
    if (!content) return;
    if (messages.length && messages.at(-1)?.role === "assistant" && !messages.at(-1)?.tool_calls?.length) {
      if (messages.at(-1)?.content === content) return;
      messages[messages.length - 1] = buildAssistantMessage(content);
      return;
    }
    messages.push(buildAssistantMessage(content));
  }

  static appendModelErrorPlaceholder(messages: Record<string, any>[]): void {
    if (messages.length && messages.at(-1)?.role === "assistant" && !messages.at(-1)?.tool_calls?.length) return;
    messages.push(buildAssistantMessage(PERSISTED_MODEL_ERROR_PLACEHOLDER));
  }

  static dropOrphanToolResults(messages: Record<string, any>[]): Record<string, any>[] {
    const declared = new Set<string>();
    const out: Record<string, any>[] = [];
    let changed = false;
    for (const msg of messages) {
      if (msg.role === "assistant") {
        for (const tc of msg.tool_calls ?? []) if (tc?.id) declared.add(String(tc.id));
      }
      if (msg.role === "tool" && msg.tool_call_id && !declared.has(String(msg.tool_call_id))) {
        changed = true;
        continue;
      }
      out.push(msg);
    }
    return changed ? out.map((msg) => ({ ...msg })) : messages;
  }

  static backfillMissingToolResults(messages: Record<string, any>[]): Record<string, any>[] {
    const fulfilled = new Set<string>();
    const declared: Array<{ index: number; id: string; name: string }> = [];
    messages.forEach((msg, index) => {
      if (msg.role === "assistant") {
        for (const tc of msg.tool_calls ?? []) {
          if (tc?.id) declared.push({ index, id: String(tc.id), name: String(tc.function?.name ?? tc.name ?? "") });
        }
      } else if (msg.role === "tool" && msg.tool_call_id) fulfilled.add(String(msg.tool_call_id));
    });
    const missing = declared.filter((item) => !fulfilled.has(item.id));
    if (!missing.length) return messages;
    const out = messages.map((msg) => ({ ...msg }));
    let offset = 0;
    for (const item of missing) {
      let insertAt = item.index + 1 + offset;
      while (insertAt < out.length && out[insertAt].role === "tool") insertAt += 1;
      out.splice(insertAt, 0, { role: "tool", tool_call_id: item.id, name: item.name, content: BACKFILL_CONTENT });
      offset += 1;
    }
    return out;
  }

  static microcompact(messages: Record<string, any>[]): Record<string, any>[] {
    const compactable = messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role === "tool" && COMPACTABLE_TOOLS.has(String(msg.name)));
    if (compactable.length <= MICROCOMPACT_KEEP_RECENT) return messages;
    const stale = compactable.slice(0, compactable.length - MICROCOMPACT_KEEP_RECENT);
    let out: Record<string, any>[] | null = null;
    for (const { msg, index } of stale) {
      if (typeof msg.content !== "string" || msg.content.length < MICROCOMPACT_MIN_CHARS) continue;
      out ??= messages.map((m) => ({ ...m }));
      out[index].content = `[${msg.name ?? "tool"} result omitted from context]`;
    }
    return out ?? messages;
  }

  private applyToolResultBudget(spec: AgentRunSpec, messages: Record<string, any>[]): Record<string, any>[] {
    let out = messages;
    for (const [idx, msg] of messages.entries()) {
      if (msg.role !== "tool") continue;
      const normalized = this.normalizeToolResult(spec, String(msg.tool_call_id ?? `tool_${idx}`), String(msg.name ?? "tool"), msg.content);
      if (normalized !== msg.content) {
        if (out === messages) out = messages.map((m) => ({ ...m }));
        out[idx].content = normalized;
      }
    }
    return out;
  }

  snipHistory(spec: AgentRunSpec, messages: Record<string, any>[]): Record<string, any>[] {
    if (!messages.length || !spec.contextWindowTokens) return messages;
    const generation = (this.provider as any)?.generation;
    const providerMaxTokens = generation?.maxTokens ?? 4096;
    const maxOutput = Number.isInteger(spec.maxTokens)
      ? spec.maxTokens
      : Number.isInteger(providerMaxTokens)
        ? Number(providerMaxTokens)
        : 4096;
    const budget = spec.contextBlockLimit ?? spec.contextWindowTokens - maxOutput - SNIP_SAFETY_BUFFER;
    if (budget <= 0) return messages;
    const estimateResult = estimatePromptTokensChain(this.provider, spec.model ?? null, messages, spec.tools?.getDefinitions?.() ?? []);
    const estimate = Array.isArray(estimateResult) ? estimateResult[0] : estimateResult;
    if (estimate <= budget) return messages;
    const system = messages.filter((msg) => msg.role === "system").map((msg) => ({ ...msg }));
    const rest = messages.filter((msg) => msg.role !== "system").map((msg) => ({ ...msg }));
    if (!rest.length) return messages;
    const kept: Record<string, any>[] = [];
    const systemTokens = system.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
    const remainingBudget = Math.max(128, budget - systemTokens);
    let keptTokens = 0;
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      const size = estimateMessageTokens(rest[i]);
      if (kept.length && keptTokens + size > remainingBudget) break;
      kept.unshift(rest[i]);
      keptTokens += size;
    }
    if (kept.length) {
      const firstUser = kept.findIndex((msg) => msg.role === "user");
      if (firstUser >= 0) {
        if (firstUser > 0) kept.splice(0, firstUser);
      } else {
        for (let idx = rest.length - 1; idx >= 0; idx -= 1) {
          if (rest[idx].role === "user") {
            kept.splice(0, kept.length, ...rest.slice(idx));
            break;
          }
        }
      }
      const legalStart = findLegalMessageStart(kept);
      if (legalStart) kept.splice(0, legalStart);
    }
    if (!kept.length) {
      kept.push(...rest.slice(-Math.min(rest.length, 4)));
      const legalStart = findLegalMessageStart(kept);
      if (legalStart) kept.splice(0, legalStart);
    }
    return [...system, ...kept];
  }

  private partitionToolBatches(spec: AgentRunSpec, calls: ToolCallRequest[]): ToolCallRequest[][] {
    if (!spec.concurrentTools) return calls.map((call) => [call]);
    const batches: ToolCallRequest[][] = [];
    let current: ToolCallRequest[] = [];
    for (const call of calls) {
      const tool = spec.tools?.get?.(call.name);
      const readOnlySafe = Boolean(tool?.readOnly && !tool?.exclusive);
      const safe = Boolean(tool?.concurrencySafe ?? readOnlySafe);
      if (safe) {
        current.push(call);
        continue;
      }
      if (current.length) batches.push(current);
      current = [];
      batches.push([call]);
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    spec.provider ??= this.provider;
    if (!spec.provider) throw new Error("AgentRunSpec.provider is required");
    const hook = spec.hook ?? new AgentHook();
    const messages = [...spec.initialMessages];
    const toolCalls: any[] = [];
    const toolEvents: Record<string, any>[] = [];
    const toolsUsed: string[] = [];
    const usage: Record<string, any> = {};
    const externalLookupCounts: Record<string, number> = {};
    const workspaceViolationCounts: Record<string, number> = {};
    let response = new LLMResponse({ content: "" });
    let finalContent: string | null = null;
    let finalContentStreamed = false;
    let stopReason = "completed";
    let error: string | null = null;
    let emptyContentRetries = 0;
    let lengthRecoveries = 0;
    let injectionCycles = 0;
    let hadInjections = false;

    const runCtx = new AgentHookContext({ spec, messages });
    await hook.beforeRun(runCtx);

    for (let iteration = 0; iteration < spec.maxIterations; iteration += 1) {
      let messagesForModel = messages;
      if (spec.abortSignal?.aborted) {
        finalContent = "Error: task cancelled";
        stopReason = "cancelled";
        error = finalContent;
        break;
      }
      try {
        messagesForModel = AgentRunner.dropOrphanToolResults(messagesForModel);
        messagesForModel = AgentRunner.backfillMissingToolResults(messagesForModel);
        messagesForModel = AgentRunner.microcompact(messagesForModel);
        messagesForModel = this.applyToolResultBudget(spec, messagesForModel);
        messagesForModel = this.snipHistory(spec, messagesForModel);
        messagesForModel = AgentRunner.dropOrphanToolResults(messagesForModel);
        messagesForModel = AgentRunner.backfillMissingToolResults(messagesForModel);
      } catch {
        try {
          messagesForModel = AgentRunner.dropOrphanToolResults(messages);
          messagesForModel = AgentRunner.backfillMissingToolResults(messagesForModel);
        } catch {
          messagesForModel = messages;
        }
      }

      const context = new AgentHookContext({ spec, messages, iteration, usage });
      await hook.beforeIteration(context);
      response = await this.requestModel(spec, messagesForModel, hook, context);
      const rawUsage = this.usageDict(response.usage);
      this.accumulateUsage(usage, rawUsage);
      (context as any).response = response;
      context.usage = rawUsage;
      context.toolCalls = [...response.toolCalls];
      if (spec.abortSignal?.aborted || response.errorKind === "aborted") {
        finalContent = "Error: task cancelled";
        stopReason = "cancelled";
        error = finalContent;
        context.finalContent = finalContent;
        context.error = error;
        context.stopReason = stopReason;
        await hook.afterIteration(context);
        break;
      }

      const [reasoningText, cleanedContent] = extractReasoning(response.reasoningContent, response.thinkingBlocks, response.content);
      response.content = cleanedContent;
      if (reasoningText && !context.streamedReasoning) {
        await hook.emitReasoning(reasoningText);
        await hook.emitReasoningEnd();
        context.streamedReasoning = true;
      }

      if (response.shouldExecuteTools && spec.tools && response.toolCalls.length) {
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(context, { resuming: true });
        }
        const assistant = this.assistantMessage(response);
        messages.push(assistant);
        toolsUsed.push(...response.toolCalls.map((call) => call.name));
        await this.emitCheckpoint(spec, {
          phase: "awaitingTools",
          iteration,
          model: spec.model,
          assistantMessage: assistant,
          completedToolResults: [],
          pendingToolCalls: response.toolCalls.map((call) => call.toOpenAIToolCall()),
        });
        await hook.beforeExecuteTools(context);
        const executed = await this.executeTools(spec, response.toolCalls, externalLookupCounts, workspaceViolationCounts);
        const completed: Record<string, any>[] = [];
        for (const item of executed) {
          toolCalls.push(item.call);
          toolEvents.push(item.event);
          const toolMessage = { role: "tool", tool_call_id: item.call.id, name: item.call.name, content: item.result };
          messages.push(toolMessage);
          completed.push(toolMessage);
        }
        context.toolResults = executed.map((item) => item.result);
        context.toolEvents = executed.map((item) => item.event);
        if (spec.abortSignal?.aborted) {
          const completedIds = new Set(completed.map((item) => String(item.tool_call_id ?? "")));
          const pendingToolCalls = response.toolCalls
            .filter((call) => !completedIds.has(String(call.id)))
            .map((call) => call.toOpenAIToolCall());
          if (completed.length || pendingToolCalls.length) {
            await this.emitCheckpoint(spec, {
              phase: "toolsInterrupted",
              iteration,
              model: spec.model,
              assistantMessage: assistant,
              completedToolResults: completed,
              pendingToolCalls,
            });
          }
          finalContent = "Error: task cancelled";
          stopReason = "cancelled";
          error = finalContent;
          context.finalContent = finalContent;
          context.error = error;
          context.stopReason = stopReason;
          await hook.afterIteration(context);
          break;
        }
        const fatal = executed.find((item) => item.error)?.error;
        if (fatal) {
          error = `Error: ${fatal.constructor?.name ?? "Error"}: ${fatal.message ?? fatal}`;
          finalContent = error;
          stopReason = "toolError";
          AgentRunner.appendFinalMessage(messages, finalContent);
          context.finalContent = finalContent;
          context.error = error;
          context.stopReason = stopReason;
          await hook.afterIteration(context);
          const [shouldContinue, cycles] = await this.tryDrainInjections(spec, messages, null, injectionCycles, { phase: "after tool error" });
          injectionCycles = cycles;
          if (shouldContinue) {
            hadInjections = true;
            continue;
          }
          break;
        }
        await this.emitCheckpoint(spec, {
          phase: "toolsCompleted",
          iteration,
          model: spec.model,
          assistantMessage: assistant,
          completedToolResults: completed,
          pendingToolCalls: [],
        });
        emptyContentRetries = 0;
        lengthRecoveries = 0;
        const [drained, cycles] = await this.tryDrainInjections(spec, messages, null, injectionCycles, { phase: "after tool execution" });
        injectionCycles = cycles;
        if (drained) hadInjections = true;
        await hook.afterIteration(context);
        continue;
      }

      let clean = hook.finalizeContent(context, response.content);
      if (response.finishReason !== "error" && isBlankText(clean)) {
        emptyContentRetries += 1;
        if (emptyContentRetries < MAX_EMPTY_RETRIES) {
          if (hook.wantsStreaming()) {
            await hook.onStreamEnd(context, { resuming: false });
          }
          await hook.afterIteration(context);
          continue;
        }
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(context, { resuming: false });
        }
        response = await this.requestFinalizationRetry(spec, messagesForModel);
        const retryUsage = this.usageDict(response.usage);
        this.accumulateUsage(usage, retryUsage);
        context.usage = this.mergeUsage(rawUsage, retryUsage);
        clean = hook.finalizeContent(context, response.content);
      }

      if (response.finishReason === "length" && !isBlankText(clean)) {
        lengthRecoveries += 1;
        if (lengthRecoveries <= MAX_LENGTH_RECOVERIES) {
          messages.push(buildAssistantMessage(clean, {
            reasoningContent: response.reasoningContent,
            thinkingBlocks: response.thinkingBlocks,
            finishReason: response.finishReason,
          }));
          messages.push(buildLengthRecoveryMessage());
          await hook.afterIteration(context);
          continue;
        }
      }

      const assistant = response.finishReason !== "error" && !isBlankText(clean)
        ? buildAssistantMessage(clean, {
          reasoningContent: response.reasoningContent,
          thinkingBlocks: response.thinkingBlocks,
          finishReason: response.finishReason,
        })
        : null;
      const [shouldContinue, cycles] = await this.tryDrainInjections(spec, messages, assistant, injectionCycles, {
        phase: "after final response",
        iteration,
        allowGoalContinue: true,
      });
      injectionCycles = cycles;
      if (shouldContinue) hadInjections = true;
      if (hook.wantsStreaming()) {
        await hook.onStreamEnd(context, { resuming: shouldContinue });
      }
      if (shouldContinue) {
        await hook.afterIteration(context);
        continue;
      }

      if (response.finishReason === "error") {
        finalContent = clean || spec.errorMessage || DEFAULT_ERROR_MESSAGE;
        stopReason = "error";
        error = finalContent;
        AgentRunner.appendModelErrorPlaceholder(messages);
        context.finalContent = finalContent;
        context.error = error;
        context.stopReason = stopReason;
        await hook.afterIteration(context);
        const [drained, nextCycles] = await this.tryDrainInjections(spec, messages, null, injectionCycles, { phase: "after LLM error" });
        injectionCycles = nextCycles;
        if (drained) {
          hadInjections = true;
          continue;
        }
        break;
      }

      if (isBlankText(clean)) {
        finalContent = EMPTY_FINAL_RESPONSE_MESSAGE;
        stopReason = "emptyFinalResponse";
        error = finalContent;
        AgentRunner.appendFinalMessage(messages, finalContent);
        context.finalContent = finalContent;
        context.error = error;
        context.stopReason = stopReason;
        await hook.afterIteration(context);
        const [drained, nextCycles] = await this.tryDrainInjections(spec, messages, null, injectionCycles, { phase: "after empty response" });
        injectionCycles = nextCycles;
        if (drained) {
          hadInjections = true;
          continue;
        }
        break;
      }

      messages.push(assistant ?? buildAssistantMessage(clean));
      await this.emitCheckpoint(spec, {
        phase: "finalResponse",
        iteration,
        model: spec.model,
        assistantMessage: messages.at(-1),
        completedToolResults: [],
        pendingToolCalls: [],
      });
      finalContent = clean;
      finalContentStreamed = Boolean(context.streamedContent);
      context.finalContent = finalContent;
      context.stopReason = stopReason;
      await hook.afterIteration(context);
      break;
    }

    if (finalContent == null) {
      stopReason = "maxIterations";
      finalContent =
        spec.maxIterationsMessage?.replaceAll("{maxIterations}", String(spec.maxIterations)) ??
        renderTemplate("agent/max-iterations-message.md", {
          strip: true,
          maxIterations: spec.maxIterations,
        });
      AgentRunner.appendFinalMessage(messages, finalContent);
      const [drained, cycles] = await this.tryDrainInjections(spec, messages, null, injectionCycles, { phase: "after maxIterations" });
      injectionCycles = cycles;
      if (drained) hadInjections = true;
    }

    const result = new AgentRunResult({
      finalContent,
      finalContentStreamed,
      content: finalContent,
      messages,
      toolCalls,
      toolsUsed,
      toolEvents,
      usage,
      response,
      stopReason,
      error,
      hadInjections,
    });
    await hook.afterRun(runCtx, result);
    return result;
  }
}

function buildAssistantMessage(
  content: string | null,
  opts: {
    toolCalls?: Record<string, any>[];
    reasoningContent?: string | null;
    thinkingBlocks?: Record<string, any>[] | null;
    finishReason?: string | null;
  } = {},
): Record<string, any> {
  const message: Record<string, any> = { role: "assistant", content: content ?? "" };
  if (opts.toolCalls?.length) message.tool_calls = opts.toolCalls;
  if (opts.reasoningContent) message.reasoning_content = opts.reasoningContent;
  if (opts.thinkingBlocks?.length) message.thinking_blocks = opts.thinkingBlocks;
  if (typeof opts.finishReason === "string" && opts.finishReason.length > 0) message.finish_reason = opts.finishReason;
  return message;
}

function normalizeTimeout(value: number | null | undefined): number | null {
  if (value == null) {
    const raw = process.env.MEMMY_AGENT_LLM_TIMEOUT_S ?? "300";
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return value > 0 ? value : null;
}

function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = String(error.name ?? error.constructor?.name ?? "").toLowerCase();
  return name.includes("abort") || error.message === "aborted";
}

function abortedResponse(): LLMResponse {
  return new LLMResponse({
    content: "Error calling LLM: aborted",
    finishReason: "error",
    errorKind: "aborted",
  });
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutS: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("llmTimeout")), timeoutS * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toolEventDetail(result: any): string {
  let detail = result == null ? "" : String(result);
  detail = detail.replace(/\n/g, " ").trim();
  if (!detail) return "(empty)";
  return detail.length > 120 ? `${detail.slice(0, 120)}...` : detail;
}

function eventDetail(prefix: string, text: string, limit: number): string {
  return `${prefix}${text.replace(/\n/g, " ").trim()}`.slice(0, limit);
}
