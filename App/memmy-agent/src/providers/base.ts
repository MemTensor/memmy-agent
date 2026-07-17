import { imagePlaceholderText } from "../utils/helpers.js";

export class ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, any>;
  extraContent?: Record<string, any> | null;
  providerSpecificFields?: Record<string, any> | null;
  functionProviderSpecificFields?: Record<string, any> | null;

  constructor(init: {
    id: string;
    name: string;
    arguments?: Record<string, any>;
    extraContent?: Record<string, any> | null;
    providerSpecificFields?: Record<string, any> | null;
    functionProviderSpecificFields?: Record<string, any> | null;
  }) {
    this.id = init.id;
    this.name = init.name;
    this.arguments = init.arguments ?? {};
    this.extraContent = init.extraContent ?? null;
    this.providerSpecificFields = init.providerSpecificFields ?? null;
    this.functionProviderSpecificFields = init.functionProviderSpecificFields ?? null;
  }

  toOpenAIToolCall(): Record<string, any> {
    const toolCall: Record<string, any> = {
      id: this.id,
      type: "function",
      function: {
        name: this.name,
        arguments: JSON.stringify(this.arguments),
      },
    };
    if (this.extraContent) toolCall.extra_content = this.extraContent;
    if (this.providerSpecificFields) toolCall.provider_specific_fields = this.providerSpecificFields;
    if (this.functionProviderSpecificFields) {
      toolCall.function.provider_specific_fields = this.functionProviderSpecificFields;
    }
    return toolCall;
  }
}

export class LLMResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: string;
  usage: Record<string, any>;
  retryAfter?: number | null;
  reasoningContent?: string | null;
  thinkingBlocks?: Record<string, any>[] | null;
  errorStatusCode?: number | null;
  errorKind?: string | null;
  errorType?: string | null;
  errorCode?: string | null;
  errorRetryAfterS?: number | null;
  errorShouldRetry?: boolean | null;

  constructor(init: {
    content: string | null;
    toolCalls?: ToolCallRequest[];
    finishReason?: string;
    usage?: Record<string, any>;
    retryAfter?: number | null;
    reasoningContent?: string | null;
    thinkingBlocks?: Record<string, any>[] | null;
    errorStatusCode?: number | null;
    errorKind?: string | null;
    errorType?: string | null;
    errorCode?: string | null;
    errorRetryAfterS?: number | null;
    errorShouldRetry?: boolean | null;
  }) {
    this.content = init.content;
    this.toolCalls = init.toolCalls ?? [];
    this.finishReason = init.finishReason ?? "stop";
    this.usage = init.usage ?? {};
    this.retryAfter = init.retryAfter ?? null;
    this.reasoningContent = init.reasoningContent ?? null;
    this.thinkingBlocks = init.thinkingBlocks ?? null;
    this.errorStatusCode = init.errorStatusCode ?? null;
    this.errorKind = init.errorKind ?? null;
    this.errorType = init.errorType ?? null;
    this.errorCode = init.errorCode ?? null;
    this.errorRetryAfterS = init.errorRetryAfterS ?? null;
    this.errorShouldRetry = init.errorShouldRetry ?? null;
  }

  get hasToolCalls(): boolean {
    return this.toolCalls.length > 0;
  }

  get shouldExecuteTools(): boolean {
    return (
      this.hasToolCalls &&
      (this.finishReason === "tool_calls" ||
        this.finishReason === "function_call" ||
        this.finishReason === "stop")
    );
  }

}

export class GenerationSettings {
  temperature: number;
  maxTokens: number;
  reasoningEffort: string | null;

  constructor(init: { temperature?: number; maxTokens?: number; reasoningEffort?: string | null } = {}) {
    this.temperature = init.temperature ?? 0.7;
    this.maxTokens = init.maxTokens ?? 4096;
    this.reasoningEffort = init.reasoningEffort ?? null;
  }
}

export const SYNTHETIC_USER_CONTENT = "(conversation continued)";

export abstract class LLMProvider {
  static supportsProgressDeltas = false;
  protected static CHAT_RETRY_DELAYS = [1, 2, 4];
  protected static PERSISTENT_MAX_DELAY = 60;
  protected static PERSISTENT_IDENTICAL_ERROR_LIMIT = 10;
  protected static RETRY_HEARTBEAT_CHUNK = 30;
  protected static TRANSIENT_ERROR_MARKERS = [
    "429",
    "rate limit",
    "500",
    "502",
    "503",
    "504",
    "overloaded",
    "timeout",
    "timed out",
    "connection",
    "server error",
    "temporarily unavailable",
    "速率限制",
    "访问量过大",
  ];
  protected static RETRYABLE_STATUS_CODES = new Set([408, 409, 429]);
  protected static TRANSIENT_ERROR_KINDS = new Set(["timeout", "connection"]);
  protected static NON_RETRYABLE_429_ERROR_TOKENS = new Set([
    "insufficient_quota",
    "quota_exceeded",
    "quota_exhausted",
    "billing_hard_limit_reached",
    "insufficient_balance",
    "credit_balance_too_low",
    "billing_not_active",
    "payment_required",
  ]);
  protected static RETRYABLE_429_ERROR_TOKENS = new Set([
    "rate_limit_exceeded",
    "rate_limit_error",
    "too_many_requests",
    "request_limit_exceeded",
    "requests_limit_exceeded",
    "overloaded_error",
  ]);
  protected static NON_RETRYABLE_429_TEXT_MARKERS = [
    "insufficient_quota",
    "insufficient quota",
    "quota exceeded",
    "quota exhausted",
    "billing hard limit",
    "billing_hard_limit_reached",
    "billing not active",
    "insufficient balance",
    "insufficient_balance",
    "credit balance too low",
    "payment required",
    "out of credits",
    "out of quota",
    "exceeded your current quota",
  ];
  protected static RETRYABLE_429_TEXT_MARKERS = [
    "rate limit",
    "rate_limit",
    "too many requests",
    "retry after",
    "try again in",
    "temporarily unavailable",
    "overloaded",
    "concurrency limit",
    "速率限制",
  ];

  apiKey: string | null;
  apiBase: string | null;
  generation: GenerationSettings;

  constructor(apiKey: string | null = null, apiBase: string | null = null) {
    this.apiKey = apiKey;
    this.apiBase = apiBase;
    this.generation = new GenerationSettings();
  }

  static sanitizeEmptyContent(messages: Record<string, any>[]): Record<string, any>[] {
    return messages.map((msg) => {
      const content = msg.content;
      if (typeof content === "string" && !content) {
        return { ...msg, content: msg.role === "assistant" && msg.tool_calls ? null : "(empty)" };
      }
      if (Array.isArray(content)) {
        let changed = false;
        const items = content
          .filter((item) => {
            if (
              item &&
              typeof item === "object" &&
              ["text", "input_text", "output_text"].includes(item.type) &&
              !item.text
            ) {
              changed = true;
              return false;
            }
            return true;
          })
          .map((item) => {
            if (item && typeof item === "object" && "meta" in item) {
              changed = true;
              const { meta, ...rest } = item;
              void meta;
              return rest;
            }
            return item;
          });
        if (changed) {
          return {
            ...msg,
            content: items.length ? items : msg.role === "assistant" && msg.tool_calls ? null : "(empty)",
          };
        }
      }
      if (content && typeof content === "object" && !Array.isArray(content)) {
        return { ...msg, content: [content] };
      }
      return msg;
    });
  }

  static toolName(tool: Record<string, any>): string {
    if (typeof tool.name === "string") return tool.name;
    if (tool.function && typeof tool.function.name === "string") return tool.function.name;
    return "";
  }

  static toolCacheMarkerIndices(tools: Record<string, any>[]): number[] {
    if (!tools.length) return [];
    const tail = tools.length - 1;
    let lastBuiltin: number | null = null;
    for (let i = tail; i >= 0; i -= 1) {
      if (!this.toolName(tools[i]).startsWith("mcp_")) {
        lastBuiltin = i;
        break;
      }
    }
    return [...new Set([lastBuiltin, tail].filter((x): x is number => x != null))];
  }

  static sanitizeRequestMessages(messages: Record<string, any>[], allowedKeys: Set<string>): Record<string, any>[] {
    return messages.map((msg) => {
      const clean: Record<string, any> = {};
      for (const key of Object.keys(msg)) if (allowedKeys.has(key)) clean[key] = msg[key];
      if (clean.role === "assistant" && !("content" in clean)) clean.content = null;
      return clean;
    });
  }

  abstract chat(args: {
    messages: Record<string, any>[];
    tools?: Record<string, any>[] | null;
    model?: string | null;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string | null;
    toolChoice?: string | Record<string, any> | null;
    signal?: AbortSignal | null;
  }): Promise<LLMResponse>;

  static isTransientError(content: string | null | undefined): boolean {
    const text = (content ?? "").toLowerCase();
    return this.TRANSIENT_ERROR_MARKERS.some((marker) => text.includes(marker));
  }

  static normalizeErrorToken(value: any): string | null {
    if (value == null) return null;
    const token = String(value).trim().toLowerCase();
    return token || null;
  }

  static extractErrorTypeCode(payload: any): [string | null, string | null] {
    let data: any = null;
    if (payload && typeof payload === "object") data = payload;
    else if (typeof payload === "string" && payload.trim()) {
      try {
        data = JSON.parse(payload);
      } catch {
        data = null;
      }
    }
    if (!data || typeof data !== "object") return [null, null];
    const err = data.error && typeof data.error === "object" ? data.error : {};
    return [
      this.normalizeErrorToken(err.type ?? data.type),
      this.normalizeErrorToken(err.code ?? data.code),
    ];
  }

  static isRetryable429Response(response: LLMResponse): boolean {
    const tokens = [response.errorType, response.errorCode]
      .map((x) => this.normalizeErrorToken(x))
      .filter((x): x is string => Boolean(x));
    if (tokens.some((token) => this.NON_RETRYABLE_429_ERROR_TOKENS.has(token))) return false;
    const content = (response.content ?? "").toLowerCase();
    if (this.NON_RETRYABLE_429_TEXT_MARKERS.some((marker) => content.includes(marker))) return false;
    if (tokens.some((token) => this.RETRYABLE_429_ERROR_TOKENS.has(token))) return true;
    if (this.RETRYABLE_429_TEXT_MARKERS.some((marker) => content.includes(marker))) return true;
    return true;
  }

  static isTransientResponse(response: LLMResponse): boolean {
    if (response.errorShouldRetry != null) return Boolean(response.errorShouldRetry);
    if (response.errorStatusCode != null) {
      const status = response.errorStatusCode;
      if (status === 429) return this.isRetryable429Response(response);
      if (this.RETRYABLE_STATUS_CODES.has(status) || status >= 500) return true;
    }
    const kind = (response.errorKind ?? "").trim().toLowerCase();
    if (this.TRANSIENT_ERROR_KINDS.has(kind)) return true;
    return this.isTransientError(response.content);
  }

  static enforceRoleAlternation(messages: Record<string, any>[]): Record<string, any>[] {
    if (!messages.length) return messages;
    const merged: Record<string, any>[] = [];
    for (const msg of messages) {
      const role = msg.role;
      const prev = merged.at(-1);
      if (
        prev &&
        role !== "system" &&
        role !== "tool" &&
        prev.role === role &&
        (role === "user" || role === "assistant")
      ) {
        if (role === "assistant") {
          if (msg.tool_calls?.length) {
            merged[merged.length - 1] = { ...msg };
            continue;
          }
          if (prev.tool_calls?.length) continue;
        }
        if (typeof prev.content === "string" && typeof msg.content === "string") {
          prev.content = `${prev.content || ""}\n\n${msg.content || ""}`.trim();
        } else {
          merged[merged.length - 1] = { ...msg };
        }
      } else {
        merged.push({ ...msg });
      }
    }
    let lastPopped: Record<string, any> | null = null;
    while (merged.length && merged.at(-1)?.role === "assistant") {
      lastPopped = merged.pop() ?? null;
    }
    if (merged.length && lastPopped && !merged.some((msg) => msg.role === "user" || msg.role === "tool")) {
      merged.push({ ...lastPopped, role: "user" });
    }
    const firstNonSystem = merged.findIndex((msg) => msg.role !== "system");
    if (
      firstNonSystem >= 0 &&
      merged[firstNonSystem].role === "assistant" &&
      !merged[firstNonSystem].tool_calls?.length
    ) {
      merged.splice(firstNonSystem, 0, { role: "user", content: SYNTHETIC_USER_CONTENT });
    }
    return merged;
  }

  static stripImageContent(messages: Record<string, any>[]): Record<string, any>[] | null {
    let found = false;
    const result = messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const content = msg.content.map((block: any) => {
        if (block?.type === "image_url") {
          found = true;
          return { type: "text", text: imagePlaceholderText(block.meta?.path ?? "", "[image omitted]") };
        }
        return block;
      });
      return { ...msg, content };
    });
    return found ? result : null;
  }

  static stripImageContentInplace(messages: Record<string, any>[]): boolean {
    let found = false;
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      msg.content = msg.content.map((block: any) => {
        if (block?.type === "image_url") {
          found = true;
          return { type: "text", text: imagePlaceholderText(block.meta?.path ?? "", "[image omitted]") };
        }
        return block;
      });
    }
    return found;
  }

  async chatStream(args: Parameters<LLMProvider["chat"]>[0] & {
    onContentDelta?: (delta: string) => Promise<void> | void;
    signal?: AbortSignal | null;
  }): Promise<LLMResponse> {
    if (args.signal?.aborted) throw createProviderAbortError();
    const response = await this.chat(args);
    if (args.signal?.aborted) throw createProviderAbortError();
    const cb = args.onContentDelta;
    if (cb && response.content && !args.signal?.aborted) await cb(response.content);
    return response;
  }

  static extractRetryAfter(content: string | null | undefined): number | null {
    const text = (content ?? "").toLowerCase();
    const patterns: Array<[RegExp, string | null]> = [
      [/retry after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)?/, null],
      [/try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)/, null],
      [/wait\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)\s*before retry/, null],
      [/retry[_-]?after["'\s:=]+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)?/, "s"],
    ];
    for (const [pattern, defaultUnit] of patterns) {
      const match = text.match(pattern);
      if (match) return this.toRetrySeconds(Number(match[1]), match[2] ?? defaultUnit ?? "s");
    }
    return null;
  }

  static toRetrySeconds(value: number, unit = "s"): number {
    const normalized = unit.toLowerCase();
    if (normalized === "ms" || normalized === "milliseconds") return Math.max(0.1, value / 1000);
    if (normalized === "m" || normalized === "min" || normalized === "minutes") return Math.max(0.1, value * 60);
    return Math.max(0.1, value);
  }

  static extractRetryAfterFromHeaders(headers: any): number | null {
    if (!headers) return null;
    const get = (name: string): any => {
      if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name.toLowerCase()) return value;
      }
      return null;
    };
    const retryMs = get("retry-after-ms");
    if (retryMs != null && Number(retryMs) > 0) return Number(retryMs) / 1000;
    const retryAfter = get("retry-after");
    if (retryAfter == null) return null;
    const text = String(retryAfter).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return this.toRetrySeconds(Number(text), "s");
    const timestamp = Date.parse(text);
    if (Number.isNaN(timestamp)) return null;
    return Math.max(0.1, (timestamp - Date.now()) / 1000);
  }

  static extractRetryAfterFromResponse(response: LLMResponse): number | null {
    if (response.errorRetryAfterS && response.errorRetryAfterS > 0) return response.errorRetryAfterS;
    if (response.retryAfter && response.retryAfter > 0) return response.retryAfter;
    return this.extractRetryAfter(response.content);
  }

  protected sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  protected async sleepWithHeartbeat(
    seconds: number,
    onRetryWait?: (message: string) => Promise<void> | void,
  ): Promise<void> {
    let remaining = Math.max(0, seconds);
    while (remaining > 0) {
      const chunk = Math.min(remaining, LLMProvider.RETRY_HEARTBEAT_CHUNK);
      await this.sleep(chunk);
      remaining -= chunk;
      if (remaining > 0) {
        await onRetryWait?.(`Model request still waiting to retry in ${Math.ceil(remaining)}s...`);
      }
    }
  }

  private buildRetryArgs(args: Parameters<LLMProvider["chat"]>[0]): Parameters<LLMProvider["chat"]>[0] {
    return {
      ...args,
      maxTokens: args.maxTokens ?? this.generation.maxTokens,
      temperature: args.temperature ?? this.generation.temperature,
      reasoningEffort: args.reasoningEffort ?? this.generation.reasoningEffort,
    };
  }

  protected safeChat(args: Parameters<LLMProvider["chat"]>[0]): Promise<LLMResponse> {
    return this.chat(args).catch((err) => {
      if ((err as any)?.name === "CancelledError" || isProviderAbortError(err)) throw err;
      return new LLMResponse({
        content: `Error calling LLM: ${(err as any)?.message ?? String(err)}`,
        finishReason: "error",
      });
    });
  }

  protected safeChatStream(
    args: Parameters<LLMProvider["chat"]>[0] & {
      onContentDelta?: (delta: string) => Promise<void> | void;
      onThinkingDelta?: (delta: string) => Promise<void> | void;
      onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
    },
  ): Promise<LLMResponse> {
    return this.chatStream(args).catch((err) => {
      if ((err as any)?.name === "CancelledError" || isProviderAbortError(err)) throw err;
      return new LLMResponse({
        content: `Error calling LLM: ${(err as any)?.message ?? String(err)}`,
        finishReason: "error",
      });
    });
  }

	  protected async runWithRetry<TArgs extends Parameters<LLMProvider["chat"]>[0]>(
	    args: TArgs & {
	      retryMode?: "standard" | "persistent";
	      onRetryWait?: (message: string) => Promise<void> | void;
	    },
	    operation: (requestArgs: TArgs) => Promise<LLMResponse>,
	  ): Promise<LLMResponse> {
	    const retryMode = args.retryMode ?? "standard";
    const onRetryWait = args.onRetryWait;
    const requestArgs = this.buildRetryArgs(args) as TArgs;
    let imageFallbackTried = false;
    let identicalErrors = 0;
    let lastError = "";
    let attempt = 0;

    while (true) {
      const response = await operation(requestArgs);

      if (response.finishReason !== "error") return response;

      const strippedMessages = !imageFallbackTried ? LLMProvider.stripImageContent(requestArgs.messages) : null;
      if (strippedMessages) {
        imageFallbackTried = true;
        const retryArgs = { ...requestArgs, messages: strippedMessages } as TArgs;
        const retry = await operation(retryArgs);
        if (retry.finishReason !== "error") {
          LLMProvider.stripImageContentInplace(requestArgs.messages);
        }
        return retry;
      }

      if (!LLMProvider.isTransientResponse(response)) return response;

      const errorKey = `${response.errorStatusCode ?? ""}|${response.errorKind ?? ""}|${response.errorType ?? ""}|${response.errorCode ?? ""}|${response.content ?? ""}`;
      identicalErrors = errorKey === lastError ? identicalErrors + 1 : 1;
      lastError = errorKey;
      if (retryMode === "persistent" && identicalErrors >= LLMProvider.PERSISTENT_IDENTICAL_ERROR_LIMIT) {
        await onRetryWait?.(`Persistent retry stopped after ${LLMProvider.PERSISTENT_IDENTICAL_ERROR_LIMIT} identical errors.`);
        return response;
      }

      const delay =
        LLMProvider.extractRetryAfterFromResponse(response) ??
        (retryMode === "persistent"
          ? Math.min(LLMProvider.PERSISTENT_MAX_DELAY, LLMProvider.CHAT_RETRY_DELAYS[Math.min(attempt, LLMProvider.CHAT_RETRY_DELAYS.length - 1)])
          : LLMProvider.CHAT_RETRY_DELAYS[attempt]);

      if (delay == null) {
        await onRetryWait?.(`Model request failed after ${LLMProvider.CHAT_RETRY_DELAYS.length + 1} retries, giving up.`);
        return response;
      }
      const retryAttempt = attempt + 1;
      await onRetryWait?.(`Model request failed, retrying attempt ${retryAttempt} in ${delay}s...`);
      await this.sleepWithHeartbeat(delay, (message) => onRetryWait?.(`Retry attempt ${retryAttempt}: ${message}`));
      attempt += 1;
    }
  }

  async chatWithRetry(
    args: Parameters<LLMProvider["chat"]>[0] & {
      retryMode?: "standard" | "persistent";
      onRetryWait?: (message: string) => Promise<void> | void;
    },
  ): Promise<LLMResponse> {
    return this.runWithRetry(args, (requestArgs) => this.safeChat(requestArgs));
  }

  async chatStreamWithRetry(
    args: Parameters<LLMProvider["chatWithRetry"]>[0] & {
      onContentDelta?: (delta: string) => Promise<void> | void;
      onThinkingDelta?: (delta: string) => Promise<void> | void;
      onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
    },
  ): Promise<LLMResponse> {
    return this.runWithRetry(args, (requestArgs) => this.safeChatStream(requestArgs));
  }

  abstract getDefaultModel(): string;
}

export function createProviderAbortError(): Error {
  const error = new Error("task cancelled");
  error.name = "AbortError";
  return error;
}

export function isProviderAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = String(error.name ?? error.constructor?.name ?? "");
  return name === "AbortError" || name.toLowerCase().includes("abort");
}

export function providerAbortOptions(signal?: AbortSignal | null): { signal: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}
