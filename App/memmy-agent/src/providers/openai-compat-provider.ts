import crypto from "crypto";
import OpenAI from "openai";
import {
  createProviderAbortError,
  isProviderAbortError,
  LLMProvider,
  LLMResponse,
  providerAbortOptions,
  ToolCallRequest,
} from "./base.js";
import {
  consumeSdkStream,
  convertMessages,
  convertTools,
  parseResponseOutput,
} from "./openai-responses/index.js";
import { memmyAccountNoneThinkingStyle } from "./memmy-account.js";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "./openrouter-attribution.js";
import { memmyAccountApiBase } from "./registry.js";
import { normalizeToolArgumentsString, parseToolArguments } from "./tool-json.js";
import { stripThink } from "../utils/helpers.js";

const ALLOWED_MSG_KEYS = new Set([
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "name",
  "reasoning_content",
  "extra_content",
]);
const STANDARD_TC_KEYS = new Set(["id", "type", "index", "function"]);
const STANDARD_FN_KEYS = new Set(["name", "arguments"]);
const KIMI_THINKING_MODELS = new Set(["kimi-k2.5", "kimi-k2.6", "k2.6-code-preview"]);
const MIMO_THINKING_MODELS = new Set(["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni"]);
const MODEL_THINKING_STYLES = new Map<string, string>([
  ...[...KIMI_THINKING_MODELS].map((model) => [model, "thinking_type"] as [string, string]),
  ...[...MIMO_THINKING_MODELS].map((model) => [model, "thinking_type"] as [string, string]),
]);
const THINKING_STYLE_MAP: Record<string, (on: boolean) => Record<string, any>> = {
  thinking_type: (on) => ({ thinking: { type: on ? "enabled" : "disabled" } }),
  enable_thinking: (on) => ({ enable_thinking: on }),
  reasoning_split: (on) => ({ reasoning_split: on }),
};
const GATEWAY_REASONING_STYLE_MAP: Record<string, (effort: string) => Record<string, any>> = {
  reasoning_effort: (effort) => ({ reasoning: { effort } }),
};
const OPENAI_COMPAT_REQUEST_TIMEOUT_S = 120.0;

export const RESPONSES_FAILURE_THRESHOLD = 3;
export const RESPONSES_PROBE_INTERVAL_S = 300;

export function floatEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || !raw.trim()) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

export function openaiCompatTimeoutS(): number {
  return floatEnv("MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S", OPENAI_COMPAT_REQUEST_TIMEOUT_S);
}

type ChatArgs = Parameters<LLMProvider["chat"]>[0] & {
  onContentDelta?: (delta: string) => Promise<void> | void;
  onThinkingDelta?: (delta: string) => Promise<void> | void;
  onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
};

type OpenAICompatApiType = "auto" | "chatCompletions" | "responses";

function normalizeApiType(value: any): OpenAICompatApiType {
  const apiType = value ?? "auto";
  if (apiType === "auto" || apiType === "chatCompletions" || apiType === "responses")
    return apiType;
  return "auto";
}

function visibleAssistantToolCallContent(content: unknown): string | null {
  if (typeof content !== "string") return null;
  return stripThink(content) || null;
}

export class OpenAICompatProvider extends LLMProvider {
  model: string | null = null;
  defaultModel: string;
  spec: any = null;
  client: any = null;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, any>;
  apiType: OpenAICompatApiType = "auto";
  effectiveBase: string | null = null;
  defaultHeaders: Record<string, string>;
  apiKeyForClient: string;
  isLocal: boolean;
  responsesFailures: Record<string, number> = {};
  responsesTrippedAt: Record<string, number> = {};

  constructor(
    apiKeyOrInit:
      | string
      | {
          apiKey?: string | null;
          apiBase?: string | null;
          defaultModel?: string | null;
          spec?: any;
          extraHeaders?: Record<string, string> | null;
          extraBody?: Record<string, any> | null;
          apiType?: OpenAICompatApiType;
        }
      | null = null,
    apiBase: string | null = null,
    defaultModel: string | null = null,
    spec: any = null,
  ) {
    if (apiKeyOrInit && typeof apiKeyOrInit === "object") {
      super(apiKeyOrInit.apiKey ?? null, apiKeyOrInit.apiBase ?? null);
      this.model = apiKeyOrInit.defaultModel ?? null;
      this.spec = apiKeyOrInit.spec ?? null;
      this.extraHeaders = apiKeyOrInit.extraHeaders ?? {};
      this.extraBody = apiKeyOrInit.extraBody ?? {};
      this.apiType = normalizeApiType(apiKeyOrInit.apiType);
    } else {
      super(apiKeyOrInit, apiBase);
      this.model = defaultModel;
      this.spec = spec;
      this.extraHeaders = {};
      this.extraBody = {};
    }

    this.defaultModel = this.model ?? "gpt-4o";
    if (this.apiType !== "auto" && specName(this.spec) !== "openai") {
      this.apiType = "auto";
    }
    if (this.apiKey && this.spec?.envKey) this.setupEnv(this.apiKey, this.apiBase);

    const effectiveBase = this.apiBase || resolveDefaultApiBase(this.spec);
    this.effectiveBase = effectiveBase;
    this.defaultHeaders = { "x-session-affinity": sessionAffinity() };
    if (usesOpenRouterAttribution(this.spec, effectiveBase)) {
      Object.assign(this.defaultHeaders, OPENROUTER_ATTRIBUTION_HEADERS);
    }
    Object.assign(this.defaultHeaders, this.extraHeaders);
    this.apiKeyForClient =
      this.apiKey ??
      (specName(this.spec) === "openai" ? process.env.OPENAI_API_KEY : null) ??
      "no-key";
    this.isLocal = isLocalEndpoint(this.spec, effectiveBase);
  }

  private setupEnv(apiKey: string, apiBase: string | null): void {
    const spec = this.spec;
    const envKey = spec?.envKey;
    if (!envKey) return;
    if (spec?.isGateway) process.env[envKey] = apiKey;
    else process.env[envKey] ??= apiKey;
    const effectiveBase = apiBase || spec.defaultApiBase || "";
    for (const [name, raw] of spec.envExtras ?? []) {
      process.env[name] ??= String(raw)
        .replaceAll("{apiKey}", apiKey)
        .replaceAll("{apiBase}", effectiveBase);
    }
  }

  buildClient(): void {
    const timeoutS = openaiCompatTimeoutS();
    const fetchOptions = this.isLocal ? ({ keepalive: false } as any) : undefined;
    this.client = new OpenAI({
      apiKey: this.apiKeyForClient,
      baseURL: this.effectiveBase ?? undefined,
      defaultHeaders: this.defaultHeaders,
      maxRetries: 0,
      timeout: timeoutS * 1000,
      fetchOptions,
    });
    this.client.defaultHeaders = this.defaultHeaders;
  }

  static extractErrorMetadata(error: any): Record<string, any> {
    const response = error?.response;
    const headers = response?.headers ?? null;
    let payload = error?.body ?? error?.doc ?? response?.text ?? null;
    if (payload == null && response && typeof response.json === "function") {
      try {
        const maybePayload = response.json();
        if (maybePayload && typeof maybePayload !== "object") payload = maybePayload;
        else if (maybePayload && typeof maybePayload.then !== "function") payload = maybePayload;
      } catch {
        payload = null;
      }
    }
    const [errorType, errorCode] = LLMProvider.extractErrorTypeCode(payload);
    const status =
      error?.statusCode ?? error?.statusCode ?? response?.statusCode ?? response?.status ?? null;
    const shouldRetryHeader = headerValue(headers, "x-should-retry");
    const shouldRetry =
      shouldRetryHeader == null ? null : String(shouldRetryHeader).trim().toLowerCase() === "true";
    const errorName = String(
      [
        error?.name,
        error?.constructor?.name,
        error?.message,
        error?.cause?.name,
        error?.cause?.constructor?.name,
        error?.cause?.message,
      ]
        .filter(Boolean)
        .join(" "),
    ).toLowerCase();
    const errorKind =
      errorName.includes("timeout") || errorName.includes("abort")
        ? "timeout"
        : errorName.includes("connection")
          ? "connection"
          : null;
    return {
      errorStatusCode: status == null ? null : Number(status),
      errorKind,
      errorType,
      errorCode,
      errorRetryAfterS: LLMProvider.extractRetryAfterFromHeaders(headers),
      errorShouldRetry: shouldRetry,
    };
  }

  static handleError(error: any, spec: any = null, apiBase: string | null = null): LLMResponse {
    const response = error?.response;
    const headers = response?.headers ?? {};
    const body = error?.body ?? error?.doc ?? response?.text ?? error?.message ?? "";
    const shouldRetryHeader = headerValue(headers, "x-should-retry");
    const shouldRetry =
      shouldRetryHeader == null ? null : String(shouldRetryHeader).trim().toLowerCase() === "true";
    const status =
      error?.statusCode ??
      error?.statusCode ??
      response?.statusCode ??
      response?.status ??
      (String(body).match(/\b([45]\d\d)\b/)
        ? Number(String(body).match(/\b([45]\d\d)\b/)![1])
        : null);
    const errorName = String(
      [
        error?.name,
        error?.constructor?.name,
        error?.message,
        error?.cause?.name,
        error?.cause?.constructor?.name,
        error?.cause?.message,
      ]
        .filter(Boolean)
        .join(" "),
    ).toLowerCase();
    const kind =
      errorName.includes("timeout") || errorName.includes("abort")
        ? "timeout"
        : errorName.includes("connection")
          ? "connection"
          : null;

    const bodyText = typeof body === "string" ? body : JSON.stringify(body);
    let content = bodyText.trim()
      ? `Error: ${bodyText.trim().slice(0, 500)}`
      : `Error calling LLM: ${error}`;
    const effectiveBase = apiBase ?? error?.apiBase ?? error?.api_base ?? null;
    if (
      isLocalEndpoint(spec, effectiveBase) &&
      /502|connection|refused/i.test(`${bodyText} ${error}`)
    ) {
      content +=
        `\nHint: this is a local model endpoint. Check that the local server is reachable at ${effectiveBase ?? spec?.defaultApiBase}, ` +
        "and if you are using a proxy/tunnel, make sure it can reach your local Ollama/vLLM service instead of routing localhost through the remote host.";
    }
    const retryAfter =
      this.extractRetryAfterFromHeaders(headers) ?? this.extractRetryAfter(content);

    const metadata = this.extractErrorMetadata(error);
    return new LLMResponse({
      content,
      finishReason: "error",
      retryAfter,
      ...metadata,
      errorStatusCode: status == null ? null : Number(status),
      errorKind: kind,
      errorRetryAfterS: retryAfter,
      errorShouldRetry: shouldRetry,
    });
  }

  static applyCacheControl(
    messages: Record<string, any>[],
    tools: Record<string, any>[] | null = null,
  ): [Record<string, any>[], Record<string, any>[] | null] {
    const cacheMarker = { type: "ephemeral" };
    const markedMessages = messages.map((message) => ({ ...message }));
    const markMessage = (message: Record<string, any>): Record<string, any> => {
      const content = message.content;
      if (typeof content === "string") {
        return {
          ...message,
          content: [{ type: "text", text: content, cache_control: cacheMarker }],
        };
      }
      if (Array.isArray(content) && content.length) {
        const next = content.map((item) => (item && typeof item === "object" ? { ...item } : item));
        const last = next.length - 1;
        next[last] = { ...next[last], cache_control: cacheMarker };
        return { ...message, content: next };
      }
      return message;
    };
    if (markedMessages[0]?.role === "system") markedMessages[0] = markMessage(markedMessages[0]);
    if (markedMessages.length >= 3)
      markedMessages[markedMessages.length - 2] = markMessage(
        markedMessages[markedMessages.length - 2],
      );

    const markedTools = tools ? tools.map((tool) => ({ ...tool })) : null;
    if (markedTools) {
      for (const idx of this.toolCacheMarkerIndices(markedTools)) {
        markedTools[idx] = { ...markedTools[idx], cache_control: cacheMarker };
      }
    }
    return [markedMessages, markedTools];
  }

  static normalizeToolCallId(toolCallId: any): any {
    if (typeof toolCallId !== "string") return toolCallId;
    if (/^[a-zA-Z0-9]{9}$/.test(toolCallId)) return toolCallId;
    return crypto.createHash("sha1").update(toolCallId).digest("hex").slice(0, 9);
  }

  shouldNormalizeToolCallIds(): boolean {
    return specName(this.spec) === "mistral";
  }

  static normalizeToolCallArguments(argumentsValue: any): string {
    return normalizeToolArgumentsString(argumentsValue);
  }

  static coerceContentToString(content: any): string | null {
    if (content == null || typeof content === "string") return content ?? null;
    const text = this.extractTextContent(content);
    if (text) return text;
    try {
      return JSON.stringify(content) || "(empty)";
    } catch {
      return String(content) || "(empty)";
    }
  }

  static stringifyContentPart(part: any): string {
    if (part == null) return "";
    if (typeof part === "string") return part;
    if (typeof part !== "object") return String(part);
    if (typeof part.text === "string") return part.text;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }

  static stripContentPartMeta(part: any): any {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    if (!("meta" in part)) return part;
    const { meta, ...rest } = part;
    void meta;
    return rest;
  }

  static normalizeToolContentForChat(message: Record<string, any>): Record<string, any> | null {
    if (message.role !== "tool" || !Array.isArray(message.content)) return null;
    const textParts: string[] = [];
    const imageParts: Record<string, any>[] = [];

    for (const item of message.content) {
      if (item && typeof item === "object" && item.type === "image_url") {
        imageParts.push(OpenAICompatProvider.stripContentPartMeta(item));
        continue;
      }
      const text = OpenAICompatProvider.stringifyContentPart(item).trim();
      if (text) textParts.push(text);
    }

    if (imageParts.length) {
      textParts.push(
        `[${imageParts.length} image attachment(s) provided in the following user message.]`,
      );
    }
    message.content = textParts.join("\n") || "(empty)";

    if (!imageParts.length) return null;
    const toolName = String(message.name ?? message.tool_call_id ?? "tool");
    return {
      role: "user",
      content: [
        ...imageParts,
        {
          type: "text",
          text: `Image content returned by ${toolName}. Use it to answer the previous request.`,
        },
      ],
    };
  }

  static prependContentParts(content: any, parts: Record<string, any>[]): any[] {
    if (Array.isArray(content)) return [...parts, ...content];
    if (typeof content === "string") {
      const text = content.trim();
      return text ? [...parts, { type: "text", text }] : [...parts];
    }
    if (content == null) return [...parts];
    return [...parts, content];
  }

  sanitizeMessages(messages: Record<string, any>[]): Record<string, any>[] {
    const sanitized = LLMProvider.sanitizeRequestMessages(messages, ALLOWED_MSG_KEYS);
    const idMap = new Map<string, string>();
    const pendingToolIds = new Map<string, string[]>();
    const forceStringContent = specName(this.spec) === "deepseek";
    const normalizeToolIds = this.shouldNormalizeToolCallIds();

    const mapId = (value: any): any => {
      if (typeof value !== "string") return value;
      if (!normalizeToolIds) return value;
      if (!idMap.has(value)) idMap.set(value, OpenAICompatProvider.normalizeToolCallId(value));
      return idMap.get(value);
    };
    const uniqueToolId = (value: any, used: Set<string>, idx: number): string => {
      let base = typeof value === "string" && value ? mapId(value) : shortToolId();
      if (typeof base !== "string" || !base) base = shortToolId();
      if (!used.has(base)) return base;
      const seed = typeof value === "string" && value ? value : base;
      let salt = 1;
      while (true) {
        const candidate = OpenAICompatProvider.normalizeToolCallId(`${seed}:${idx}:${salt}`);
        if (!used.has(candidate)) return candidate;
        salt += 1;
      }
    };
    const mapToolResultId = (value: any): any => {
      if (typeof value !== "string") return value;
      const queue = pendingToolIds.get(value);
      if (queue?.length) {
        const mapped = queue.shift()!;
        if (!queue.length) pendingToolIds.delete(value);
        return mapped;
      }
      return mapId(value);
    };

    const expanded: Record<string, any>[] = [];
    const pendingToolImageParts: Record<string, any>[] = [];
    const flushPendingToolImages = (targetUser: Record<string, any> | null = null) => {
      if (!pendingToolImageParts.length) return;
      const parts = pendingToolImageParts.splice(0);
      if (targetUser) {
        targetUser.content = OpenAICompatProvider.prependContentParts(targetUser.content, parts);
        return;
      }
      expanded.push({ role: "user", content: parts });
    };

    for (const clean of sanitized) {
      if (Array.isArray(clean.tool_calls)) {
        const normalized = [];
        const usedIds = new Set<string>();
        for (const [idx, raw] of clean.tool_calls.entries()) {
          if (!raw || typeof raw !== "object") {
            normalized.push(raw);
            continue;
          }
          const toolCall = { ...raw };
          const rawId = toolCall.id;
          const mappedId = uniqueToolId(rawId, usedIds, idx);
          toolCall.id = mappedId;
          usedIds.add(mappedId);
          if (typeof rawId === "string" && rawId) {
            const queue = pendingToolIds.get(rawId) ?? [];
            queue.push(mappedId);
            pendingToolIds.set(rawId, queue);
          }
          if (toolCall.function && typeof toolCall.function === "object") {
            toolCall.function = {
              ...toolCall.function,
              arguments: OpenAICompatProvider.normalizeToolCallArguments(
                toolCall.function.arguments,
              ),
            };
          }
          normalized.push(toolCall);
        }
        clean.tool_calls = normalized;
        if (clean.role === "assistant") {
          clean.content = visibleAssistantToolCallContent(clean.content);
        }
      }
      if (clean.tool_call_id) clean.tool_call_id = mapToolResultId(clean.tool_call_id);
      if (forceStringContent && !(clean.role === "assistant" && clean.tool_calls)) {
        clean.content = OpenAICompatProvider.coerceContentToString(clean.content);
      }
      if (clean.role === "tool") {
        const imageMessage = OpenAICompatProvider.normalizeToolContentForChat(clean);
        expanded.push(clean);
        if (Array.isArray(imageMessage?.content))
          pendingToolImageParts.push(...imageMessage.content);
        continue;
      }
      if (clean.role === "user") {
        flushPendingToolImages(clean);
        expanded.push(clean);
        continue;
      }
      flushPendingToolImages();
      expanded.push(clean);
    }
    flushPendingToolImages();
    return LLMProvider.enforceRoleAlternation(expanded);
  }

  static supportsTemperature(modelName: string, reasoningEffort: string | null = null): boolean {
    if (reasoningEffort && reasoningEffort.toLowerCase() !== "none") return false;
    const name = modelName.toLowerCase();
    if (isKimiImmutableTemperatureModel(name)) return false;
    return !["gpt-5", "o1", "o3", "o4"].some((token) => name.includes(token));
  }

  buildKwargs(args: ChatArgs): Record<string, any> {
    const modelNameRaw = args.model ?? this.defaultModel;
    let modelName = String(modelNameRaw);
    let messages = LLMProvider.sanitizeEmptyContent(args.messages);
    let tools = args.tools ?? null;

    if (this.spec?.supportsPromptCaching && /^(anthropic\/|claude)/i.test(modelName)) {
      [messages, tools] = OpenAICompatProvider.applyCacheControl(messages, tools);
    }
    if (this.spec?.stripModelPrefix) modelName = modelName.split("/").at(-1) ?? modelName;

    const reasoningEffort = args.reasoningEffort ?? null;
    const semanticEffort =
      typeof reasoningEffort === "string"
        ? reasoningEffort.toLowerCase() === "minimum"
          ? "minimal"
          : reasoningEffort.toLowerCase()
        : null;
    let wireEffort = reasoningEffort;
    if (specName(this.spec) === "dashscope" && semanticEffort === "minimal") wireEffort = "minimum";
    const maxTokens = Math.max(1, args.maxTokens ?? this.generation.maxTokens);
    const temperature = args.temperature ?? this.generation.temperature;
    const kwargs: Record<string, any> = {
      model: modelName,
      messages: this.sanitizeMessages(messages),
    };

    if (OpenAICompatProvider.supportsTemperature(modelName, reasoningEffort))
      kwargs.temperature = temperature;
    if (this.spec?.supportsMaxCompletionTokens) kwargs.max_completion_tokens = maxTokens;
    else kwargs.max_tokens = maxTokens;

    for (const [pattern, overrides] of this.spec?.modelOverrides ?? []) {
      if (modelName.toLowerCase().includes(String(pattern).toLowerCase())) {
        Object.assign(kwargs, overrides);
        break;
      }
    }

    if (wireEffort && semanticEffort !== "none") kwargs.reasoning_effort = wireEffort;
    if (reasoningEffort !== null) {
      const thinkingEnabled = semanticEffort !== "none" && semanticEffort !== "minimal";
      const styles = thinkingStylesFor(this.spec, modelName);
      const memmyStyle = memmyAccountNoneThinkingStyle(
        specName(this.spec),
        modelName,
        semanticEffort,
      );
      if (memmyStyle && !styles.includes(memmyStyle)) styles.push(memmyStyle);
      for (const style of styles) {
        const extra = thinkingExtraBody(style, thinkingEnabled);
        if (extra) kwargs.extra_body = deepMerge(kwargs.extra_body ?? {}, extra);
      }
      const gatewayStyle = this.spec?.gatewayReasoningStyle ?? "";
      if (gatewayStyle && modelThinkingStyle(modelName) && semanticEffort) {
        const extra = gatewayReasoningExtraBody(gatewayStyle, semanticEffort);
        if (extra) kwargs.extra_body = deepMerge(kwargs.extra_body ?? {}, extra);
      }
      if (KIMI_THINKING_MODELS.has(modelSlug(modelName))) delete kwargs.reasoning_effort;
    }

    if (tools?.length) {
      kwargs.tools = chatCompletionToolsForProvider(tools, specName(this.spec));
      kwargs.tool_choice = args.toolChoice ?? "auto";
    }

    const explicitThinking =
      reasoningEffort !== null &&
      semanticEffort !== "none" &&
      semanticEffort !== "minimal" &&
      Boolean(this.spec?.thinkingStyle || modelThinkingStyle(modelName));
    const implicitDeepseekThinking =
      specName(this.spec) === "deepseek" &&
      !["none", "minimal", "minimum"].includes(String(semanticEffort)) &&
      /deepseek-v4|deepseek-reasoner/i.test(modelName);
    if (explicitThinking || implicitDeepseekThinking) {
      for (const message of kwargs.messages) {
        if (message.role === "assistant" && !("reasoning_content" in message))
          message.reasoning_content = "";
      }
    }

    if (Object.keys(this.extraBody).length) {
      kwargs.extra_body = deepMerge(kwargs.extra_body ?? {}, this.extraBody);
    }
    return kwargs;
  }

  shouldUseResponsesApi(
    model: string | null = null,
    reasoningEffort: string | null = null,
  ): boolean {
    const apiType = this.apiType;
    const activeSpec = this.spec;
    const effectiveBase = this.effectiveBase;
    const name = specName(activeSpec);
    if (apiType === "chatCompletions") return false;
    if (name && !["openai", "github_copilot"].includes(name)) return false;
    if (apiType === "responses") return true;
    if (name !== "github_copilot" && !isDirectOpenAIBase(effectiveBase)) return false;
    const modelName = String(model ?? this.defaultModel).toLowerCase();
    const wants = Boolean(
      (reasoningEffort && reasoningEffort.toLowerCase() !== "none") ||
      ["gpt-5", "o1", "o3", "o4"].some((token) => modelName.includes(token)),
    );
    return wants && this.responsesCircuitAllowsProbe(model, reasoningEffort);
  }

  responsesCircuitAllowsProbe(
    model: string | null = null,
    reasoningEffort: string | null = null,
  ): boolean {
    const key = responsesCircuitKey(model, this.defaultModel, reasoningEffort);
    const failures = this.responsesFailures[key] ?? 0;
    if (failures >= RESPONSES_FAILURE_THRESHOLD) {
      const tripped = this.responsesTrippedAt[key] ?? 0;
      if (Date.now() / 1000 - tripped < RESPONSES_PROBE_INTERVAL_S) return false;
    }
    return true;
  }

  recordResponsesFailure(model: string | null = null, reasoningEffort: string | null = null): void {
    const key = responsesCircuitKey(model, this.defaultModel, reasoningEffort);
    const count = (this.responsesFailures[key] ?? 0) + 1;
    this.responsesFailures[key] = count;
    if (count >= RESPONSES_FAILURE_THRESHOLD) {
      this.responsesTrippedAt[key] = Date.now() / 1000;
    }
  }

  recordResponsesSuccess(model: string | null = null, reasoningEffort: string | null = null): void {
    const key = responsesCircuitKey(model, this.defaultModel, reasoningEffort);
    delete this.responsesFailures[key];
    delete this.responsesTrippedAt[key];
  }

  static shouldFallbackFromResponsesError(error: any): boolean {
    const status =
      error?.statusCode ??
      error?.statusCode ??
      error?.response?.statusCode ??
      error?.response?.status;
    if (![400, 404, 422].includes(Number(status))) return false;
    const body = String(
      error?.body ?? error?.doc ?? error?.response?.text ?? error?.message ?? "",
    ).toLowerCase();
    return [
      "responses",
      "response api",
      "max_output_tokens",
      "instructions",
      "previous_response",
      "unsupported",
      "not supported",
      "unknown parameter",
      "unrecognized request argument",
    ].some((marker) => body.includes(marker));
  }

  buildResponsesBody(args: ChatArgs): Record<string, any> {
    let modelName = String(args.model ?? this.defaultModel);
    if (this.spec?.stripModelPrefix) modelName = modelName.split("/").at(-1) ?? modelName;
    const sanitizedMessages = this.sanitizeMessages(
      LLMProvider.sanitizeEmptyContent(args.messages),
    );
    const [instructions, input] = convertMessages(sanitizedMessages);
    const reasoningEffort = args.reasoningEffort ?? null;
    let body: Record<string, any> = {
      model: modelName,
      instructions: instructions || null,
      input,
      max_output_tokens: Math.max(1, args.maxTokens ?? this.generation.maxTokens),
      store: false,
      stream: false,
    };
    if (OpenAICompatProvider.supportsTemperature(modelName, reasoningEffort))
      body.temperature = args.temperature ?? this.generation.temperature;
    if (reasoningEffort && reasoningEffort.toLowerCase() !== "none") {
      body.reasoning = { effort: reasoningEffort };
      body.include = ["reasoning.encrypted_content"];
    }
    const tools = args.tools ?? null;
    if (tools?.length) {
      body.tools = convertTools(tools);
      body.tool_choice = args.toolChoice ?? "auto";
    }
    if (Object.keys(this.extraBody).length) body = mergeResponsesExtraBody(body, this.extraBody);
    return body;
  }

  static maybeMapping(value: any): Record<string, any> | null {
    if (!value) return null;
    if (typeof value === "object" && !Array.isArray(value)) {
      if (typeof value.toJSON === "function") {
        const dumped = value.toJSON();
        return dumped && typeof dumped === "object" && !Array.isArray(dumped) ? dumped : null;
      }
      if (typeof value.toObject === "function") {
        const dumped = value.toObject();
        return dumped && typeof dumped === "object" && !Array.isArray(dumped) ? dumped : null;
      }
      return value;
    }
    return null;
  }

  static extractTextContent(value: any): string | null {
    if (value == null) return null;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        const itemMap = this.maybeMapping(item);
        if (typeof itemMap?.text === "string") parts.push(itemMap.text);
        else if (typeof item === "string") parts.push(item);
      }
      return parts.join("") || null;
    }
    return String(value);
  }

  static extractUsage(response: any): Record<string, any> {
    const responseMap = this.maybeMapping(response);
    const usageObj = responseMap?.usage ?? response?.usage;
    const usageMap = this.maybeMapping(usageObj);
    if (!usageMap && !usageObj) return {};
    const result: Record<string, any> = usageMap ? { ...usageMap } : {};
    result.prompt_tokens = Number(
      getNested(usageObj, ["prompt_tokens"]) ?? result.prompt_tokens ?? 0,
    );
    result.completion_tokens = Number(
      getNested(usageObj, ["completion_tokens"]) ?? result.completion_tokens ?? 0,
    );
    result.total_tokens = Number(getNested(usageObj, ["total_tokens"]) ?? result.total_tokens ?? 0);
    for (const path of [
      ["prompt_tokens_details", "cached_tokens"],
      ["cached_tokens"],
      ["prompt_cache_hit_tokens"],
    ]) {
      const cached = Number(getNested(usageObj, path) ?? 0);
      if (cached) {
        result.cached_tokens = cached;
        break;
      }
    }
    return result;
  }

  parseResponse(response: any): LLMResponse {
    if (typeof response === "string")
      return new LLMResponse({ content: response, finishReason: "stop" });
    const responseMap = OpenAICompatProvider.maybeMapping(response);
    const choices = responseMap?.choices ?? response?.choices ?? [];
    if (!Array.isArray(choices) || choices.length === 0) {
      const content = OpenAICompatProvider.extractTextContent(
        responseMap?.content ?? responseMap?.output_text,
      );
      if (content != null) {
        return new LLMResponse({
          content,
          reasoningContent: OpenAICompatProvider.extractTextContent(responseMap?.reasoning_content),
          finishReason: String(responseMap?.finish_reason ?? "stop"),
          usage: OpenAICompatProvider.extractUsage(response),
        });
      }
      // Some gateways (e.g. the memmy account gateway) return business errors (such as quota exceeded) as an HTTP 200 + {code, message} envelope
      // with no choices. Pass the gateway's message through so upper layers can localize it into a specific message instead of a generic "empty choices".
      const gatewayMessage = OpenAICompatProvider.extractTextContent(
        responseMap?.message ?? (response as any)?.message,
      );
      const gatewayCode = responseMap?.code ?? (response as any)?.code;
      if (gatewayMessage && gatewayCode != null && Number(gatewayCode) !== 0) {
        return new LLMResponse({
          content: `Error calling LLM: ${gatewayMessage}`,
          finishReason: "error",
        });
      }
      return new LLMResponse({
        content: "Error: API returned empty choices.",
        finishReason: "error",
      });
    }

    let content: string | null = null;
    let reasoningContent: string | null = null;
    let finishReason = "stop";
    const rawToolCalls: any[] = [];
    for (const choice of choices) {
      const choiceMap = OpenAICompatProvider.maybeMapping(choice) ?? {};
      const msg = OpenAICompatProvider.maybeMapping(choiceMap.message ?? choice?.message) ?? {};
      if (choiceMap.finish_reason) finishReason = String(choiceMap.finish_reason);
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        rawToolCalls.push(...msg.tool_calls);
        if (["tool_calls", "stop"].includes(String(choiceMap.finish_reason)))
          finishReason = String(choiceMap.finish_reason);
      }
      if (!content) content = OpenAICompatProvider.extractTextContent(msg.content);
      if (!content && msg.reasoning && this.spec?.reasoningAsContent) {
        content = OpenAICompatProvider.extractTextContent(msg.reasoning);
      }
      if (!reasoningContent)
        reasoningContent = OpenAICompatProvider.extractTextContent(
          msg.reasoning_content ?? msg.reasoning,
        );
    }

    return new LLMResponse({
      content,
      toolCalls: parseToolCalls(rawToolCalls),
      finishReason,
      usage: OpenAICompatProvider.extractUsage(response),
      reasoningContent,
    });
  }

  static parse(response: any): LLMResponse {
    return new OpenAICompatProvider().parseResponse(response);
  }

  static parseChunks(chunks: any[]): LLMResponse {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolBuffers = new Map<
      number,
      {
        id: string;
        name: string;
        arguments: string;
        extraContent?: any;
        providerSpecific?: any;
        functionProviderSpecific?: any;
      }
    >();
    let finishReason = "stop";
    let usage: Record<string, any> = {};

    const accumToolCall = (toolCall: any, idxHint: number) => {
      const index = Number(getValue(toolCall, "index") ?? idxHint);
      const buf = toolBuffers.get(index) ?? { id: "", name: "", arguments: "" };
      const callId = getValue(toolCall, "id");
      if (callId) buf.id = String(callId);
      const fn = getValue(toolCall, "function");
      const fnName = getValue(fn, "name");
      const fnArgs = getValue(fn, "arguments");
      if (fnName) buf.name = String(fnName);
      if (fnArgs) buf.arguments += String(fnArgs);
      const [extraContent, providerSpecific, functionProviderSpecific] =
        extractToolCallExtras(toolCall);
      if (extraContent) buf.extraContent = extraContent;
      if (providerSpecific) buf.providerSpecific = providerSpecific;
      if (functionProviderSpecific) buf.functionProviderSpecific = functionProviderSpecific;
      toolBuffers.set(index, buf);
    };
    const accumLegacyFunctionCall = (functionCall: any) => {
      if (!functionCall) return;
      const buf = toolBuffers.get(0) ?? { id: "", name: "", arguments: "" };
      const fnName = getValue(functionCall, "name");
      const fnArgs = getValue(functionCall, "arguments");
      if (fnName) buf.name = String(fnName);
      if (fnArgs) buf.arguments += String(fnArgs);
      toolBuffers.set(0, buf);
    };

    for (const chunk of chunks) {
      if (typeof chunk === "string") {
        contentParts.push(chunk);
        continue;
      }
      const chunkMap = OpenAICompatProvider.maybeMapping(chunk);
      const choices = chunkMap?.choices ?? chunk?.choices ?? [];
      if (!Array.isArray(choices) || choices.length === 0) {
        usage = OpenAICompatProvider.extractUsage(chunk) || usage;
        const text = OpenAICompatProvider.extractTextContent(
          chunkMap?.content ?? chunkMap?.output_text,
        );
        if (text) contentParts.push(text);
        continue;
      }
      const choice = OpenAICompatProvider.maybeMapping(choices[0]) ?? {};
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
      const delta = OpenAICompatProvider.maybeMapping(choice.delta) ?? {};
      const text = OpenAICompatProvider.extractTextContent(delta.content);
      if (text) contentParts.push(text);
      const reasoning = OpenAICompatProvider.extractTextContent(
        delta.reasoning_content ?? delta.reasoning,
      );
      if (reasoning) reasoningParts.push(reasoning);
      for (const [idx, toolCall] of (delta.tool_calls ?? []).entries())
        accumToolCall(toolCall, idx);
      accumLegacyFunctionCall(delta.function_call);
      usage = OpenAICompatProvider.extractUsage(chunk) || usage;
    }

    const seen = new Set<string>();
    const toolCalls = [...toolBuffers.values()].map((buf) => {
      let id = buf.id || shortToolId();
      if (seen.has(id)) id = shortToolId();
      seen.add(id);
      return new ToolCallRequest({
        id,
        name: buf.name,
        arguments: parseToolArguments(buf.arguments),
        extraContent: buf.extraContent ?? null,
        providerSpecificFields: buf.providerSpecific ?? null,
        functionProviderSpecificFields: buf.functionProviderSpecific ?? null,
      });
    });
    return new LLMResponse({
      content: contentParts.join("") || null,
      toolCalls,
      finishReason,
      usage,
      reasoningContent: reasoningParts.join("") || null,
    });
  }

  async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    this.buildClient();
    return this.client;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  protected normalizeModel(model: string): string {
    if (this.spec?.stripModelPrefix) return model.split("/").at(-1) ?? model;
    return model;
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    await this.ensureClient();
    const model = args.model ?? this.getDefaultModel();
    const reasoningEffort = args.reasoningEffort ?? null;
    try {
      if (args.signal?.aborted) throw createProviderAbortError();
      if (this.shouldUseResponsesApi(model, reasoningEffort)) {
        try {
          const body = this.buildResponsesBody(args);
          const options = providerAbortOptions(args.signal);
          const response = options
            ? await this.client.responses.create(body, options as any)
            : await this.client.responses.create(body);
          this.recordResponsesSuccess(model, reasoningEffort);
          return parseResponseOutput(response);
        } catch (responsesError) {
          if (isProviderAbortError(responsesError)) throw responsesError;
          if (specName(this.spec) === "github_copilot" || this.apiType === "responses")
            throw responsesError;
          if (!OpenAICompatProvider.shouldFallbackFromResponsesError(responsesError))
            throw responsesError;
          this.recordResponsesFailure(model, reasoningEffort);
        }
      }
      const kwargs = flattenChatExtraBody(this.buildKwargs(args));
      if (args.signal?.aborted) throw createProviderAbortError();
      const options = providerAbortOptions(args.signal);
      const response = options
        ? await this.client.chat.completions.create(kwargs as any, options as any)
        : await this.client.chat.completions.create(kwargs as any);
      return this.parseResponse(response);
    } catch (error) {
      if (isProviderAbortError(error)) throw error;
      return OpenAICompatProvider.handleError(error, this.spec, this.apiBase);
    }
  }

  async chatStream(args: ChatArgs): Promise<LLMResponse> {
    await this.ensureClient();
    const model = args.model ?? this.getDefaultModel();
    const reasoningEffort = args.reasoningEffort ?? null;
    const idleTimeoutS = Number(process.env.MEMMY_AGENT_STREAM_IDLE_TIMEOUT_S ?? "90");
    const onContentDelta = args.onContentDelta;
    const onThinkingDelta = args.onThinkingDelta;
    const onToolCallDelta = args.onToolCallDelta;
    try {
      if (args.signal?.aborted) throw createProviderAbortError();
      if (this.shouldUseResponsesApi(model, reasoningEffort)) {
        try {
          const body = { ...this.buildResponsesBody(args), stream: true };
          const options = providerAbortOptions(args.signal);
          const stream = options
            ? await this.client.responses.create(body as any, options as any)
            : await this.client.responses.create(body as any);
          const [content, toolCalls, finishReason, usage, reasoningContent] =
            await consumeSdkStream(timedAsyncIterable(stream, idleTimeoutS), {
              onContentDelta,
              onToolCallDelta,
              signal: args.signal ?? null,
            });
          this.recordResponsesSuccess(model, reasoningEffort);
          return new LLMResponse({
            content: content || null,
            toolCalls,
            finishReason,
            usage,
            reasoningContent,
          });
        } catch (responsesError) {
          if (isProviderAbortError(responsesError)) throw responsesError;
          if (specName(this.spec) === "github_copilot" || this.apiType === "responses")
            throw responsesError;
          if (!OpenAICompatProvider.shouldFallbackFromResponsesError(responsesError))
            throw responsesError;
          this.recordResponsesFailure(model, reasoningEffort);
        }
      }

      const kwargs: Record<string, any> = flattenChatExtraBody({
        ...this.buildKwargs(args),
        stream: true,
        stream_options: { include_usage: true },
      });
      if (specName(this.spec) === "zhipu" && args.tools?.length && onToolCallDelta) {
        kwargs.extra_body = { ...(kwargs.extra_body ?? {}), tool_stream: true };
      }
      if (args.signal?.aborted) throw createProviderAbortError();
      const options = providerAbortOptions(args.signal);
      const stream = options
        ? await this.client.chat.completions.create(kwargs as any, options as any)
        : await this.client.chat.completions.create(kwargs as any);
      const chunks: any[] = [];
      for await (const chunk of timedAsyncIterable(stream, idleTimeoutS)) {
        if (args.signal?.aborted) throw createProviderAbortError();
        chunks.push(chunk);
        const choice =
          OpenAICompatProvider.maybeMapping(
            (OpenAICompatProvider.maybeMapping(chunk)?.choices ?? chunk?.choices ?? [])[0],
          ) ?? {};
        const delta = OpenAICompatProvider.maybeMapping(choice.delta) ?? {};
        const text = OpenAICompatProvider.extractTextContent(delta.content);
        if (text && !args.signal?.aborted) await onContentDelta?.(text);
        const reasoning = OpenAICompatProvider.extractTextContent(
          delta.reasoning_content ?? delta.reasoning,
        );
        if (reasoning && !args.signal?.aborted) await onThinkingDelta?.(reasoning);
        if (onToolCallDelta) {
          for (const [idx, toolDelta] of (delta.tool_calls ?? []).entries()) {
            if (args.signal?.aborted) throw createProviderAbortError();
            const fn = getValue(toolDelta, "function");
            const index = getValue(toolDelta, "index");
            await onToolCallDelta({
              index: index ?? idx,
              call_id: String(getValue(toolDelta, "id") ?? ""),
              name: fn ? String(getValue(fn, "name") ?? "") : "",
              arguments_delta: fn ? String(getValue(fn, "arguments") ?? "") : "",
            });
          }
          const functionCall = delta.function_call;
          if (functionCall) {
            if (args.signal?.aborted) throw createProviderAbortError();
            await onToolCallDelta({
              index: 0,
              call_id: "",
              name: String(getValue(functionCall, "name") ?? ""),
              arguments_delta: String(getValue(functionCall, "arguments") ?? ""),
            });
          }
        }
      }
      return OpenAICompatProvider.parseChunks(chunks);
    } catch (error) {
      if (isProviderAbortError(error)) throw error;
      if ((error as Error).message === "stream_idle_timeout") {
        return new LLMResponse({
          content: `Error calling LLM: stream stalled for more than ${idleTimeoutS} seconds`,
          finishReason: "error",
          errorKind: "timeout",
        });
      }
      return OpenAICompatProvider.handleError(error, this.spec, this.apiBase);
    }
  }
}

function sessionAffinity(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function specName(spec: any): string {
  return String(spec?.name ?? "").toLowerCase();
}

// memmy_account's real API base is resolved lazily (see providers/registry.ts): only a genuine attempt
// to build a request for it (no explicit apiBase override) resolves MEMMY_CLOUD_SERVICE and throws the
// clear "not configured" error. Every other provider keeps reading its precomputed defaultApiBase.
function resolveDefaultApiBase(spec: any): string | null {
  if (specName(spec) === "memmy_account") return memmyAccountApiBase();
  return spec?.defaultApiBase || null;
}

function chatCompletionToolsForProvider(
  tools: Record<string, any>[],
  providerName: string,
): Record<string, any>[] {
  if (providerName !== "qianfan") return tools;
  return tools.map((tool) => {
    const normalized = structuredClone(tool);
    const fn = normalized.function ?? normalized;
    if (fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)) {
      fn.parameters = normalizeNullableTypeArrays(fn.parameters);
    }
    return normalized;
  });
}

function normalizeNullableTypeArrays(value: any): any {
  if (Array.isArray(value)) return value.map((item) => normalizeNullableTypeArrays(item));
  if (!value || typeof value !== "object") return value;
  const normalized: Record<string, any> = { ...value };
  if (Array.isArray(normalized.type)) {
    const nonNullTypes = normalized.type.filter((type) => type !== "null");
    if (normalized.type.includes("null") && nonNullTypes.length === 1) {
      normalized.type = nonNullTypes[0];
      normalized.nullable = true;
    }
  }
  for (const [key, child] of Object.entries(normalized)) {
    if (key !== "type") normalized[key] = normalizeNullableTypeArrays(child);
  }
  return normalized;
}

export function modelSlug(modelName: string): string {
  return modelName.toLowerCase().split("/").at(-1) ?? modelName.toLowerCase();
}

function isKimiImmutableTemperatureModel(modelName: string): boolean {
  const slug = modelSlug(modelName);
  return (
    slug.includes("kimi-k2.5") ||
    slug.includes("kimi-k2.6") ||
    slug.includes("k2.6-code-preview") ||
    slug.startsWith("kimi-k2.7-code")
  );
}

export function modelThinkingStyle(modelName: string): string {
  return MODEL_THINKING_STYLES.get(modelSlug(modelName)) ?? "";
}

export function thinkingStylesFor(spec: any, modelName: string): string[] {
  const styles: string[] = [];
  const specStyle = spec?.thinkingStyle ?? "";
  if (specStyle) styles.push(specStyle);
  const modelStyle = modelThinkingStyle(modelName);
  if (modelStyle && !styles.includes(modelStyle)) styles.push(modelStyle);
  return styles;
}

export function thinkingExtraBody(style: string, enabled: boolean): Record<string, any> | null {
  return THINKING_STYLE_MAP[style]?.(enabled) ?? null;
}

export function gatewayReasoningExtraBody(
  style: string,
  effort: string,
): Record<string, any> | null {
  return GATEWAY_REASONING_STYLE_MAP[style]?.(effort) ?? null;
}

export function usesOpenRouterAttribution(spec: any, apiBase: string | null): boolean {
  return specName(spec) === "openrouter" || Boolean(apiBase?.toLowerCase().includes("openrouter"));
}

export function shortToolId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 9; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function getValue(obj: any, key: string): any {
  if (!obj) return undefined;
  if (typeof obj === "object" && key in obj) return obj[key];
  return undefined;
}

export function coerceDict(value: any): Record<string, any> | null {
  if (!value) return null;
  if (typeof value.toJSON === "function") value = value.toJSON();
  else if (typeof value.toObject === "function") value = value.toObject();
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length
    ? value
    : null;
}

export function extractToolCallExtras(
  toolCall: any,
): [Record<string, any> | null, Record<string, any> | null, Record<string, any> | null] {
  const extraContent = coerceDict(getValue(toolCall, "extra_content"));
  const toolDict = coerceDict(toolCall);
  let providerSpecific: Record<string, any> | null = null;
  let functionProviderSpecific: Record<string, any> | null = null;
  if (toolDict) {
    const directProviderSpecific = coerceDict(getValue(toolCall, "provider_specific_fields"));
    const leftovers = Object.fromEntries(
      Object.entries(toolDict).filter(
        ([key, value]) =>
          !STANDARD_TC_KEYS.has(key) &&
          key !== "extra_content" &&
          key !== "provider_specific_fields" &&
          value != null,
      ),
    );
    const mergedProviderSpecific = { ...(directProviderSpecific ?? {}), ...leftovers };
    if (Object.keys(mergedProviderSpecific).length) providerSpecific = mergedProviderSpecific;
    const fn = coerceDict(toolDict.function);
    if (fn) {
      const directFunctionProviderSpecific = coerceDict(getValue(fn, "provider_specific_fields"));
      const fnLeftovers = Object.fromEntries(
        Object.entries(fn).filter(
          ([key, value]) =>
            !STANDARD_FN_KEYS.has(key) && key !== "provider_specific_fields" && value != null,
        ),
      );
      const mergedFunctionProviderSpecific = {
        ...(directFunctionProviderSpecific ?? {}),
        ...fnLeftovers,
      };
      if (Object.keys(mergedFunctionProviderSpecific).length)
        functionProviderSpecific = mergedFunctionProviderSpecific;
    }
  }
  return [extraContent, providerSpecific, functionProviderSpecific];
}

function parseToolCalls(calls: any[]): ToolCallRequest[] {
  return (Array.isArray(calls) ? calls : []).map((call: any) => {
    const fn = OpenAICompatProvider.maybeMapping(getValue(call, "function")) ?? {};
    const [extraContent, providerSpecific, functionProviderSpecific] = extractToolCallExtras(call);
    return new ToolCallRequest({
      id: String(getValue(call, "id") ?? getValue(call, "call_id") ?? shortToolId()),
      name: String(fn.name ?? getValue(call, "name") ?? ""),
      arguments: parseToolArguments(fn.arguments ?? getValue(call, "arguments")),
      extraContent,
      providerSpecificFields: providerSpecific,
      functionProviderSpecificFields: functionProviderSpecific,
    });
  });
}

export function isLocalEndpoint(spec: any, apiBase?: string | null): boolean {
  if (spec?.isLocal) return true;
  if (!apiBase) return false;
  let raw = String(apiBase).trim();
  if (!raw) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (["localhost", "host.docker.internal", "::1", "[::1]"].includes(host)) return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  const parts = host.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

export function isDirectOpenAIBase(apiBase?: string | null): boolean {
  if (!apiBase) return true;
  const normalized = apiBase.trim().toLowerCase().replace(/\/+$/, "");
  return normalized.includes("api.openai.com") && !normalized.includes("openrouter");
}

export function responsesCircuitKey(
  model: string | null | undefined,
  defaultModel: string,
  reasoningEffort: string | null | undefined,
): string {
  const modelName = String(model ?? defaultModel).toLowerCase();
  const effort = typeof reasoningEffort === "string" ? reasoningEffort.toLowerCase() : "";
  return `${modelName}:${effort}`;
}

export function deepMerge(
  base: Record<string, any>,
  override: Record<string, any>,
): Record<string, any> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in merged &&
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key]) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function mergeUniqueList(base: any, override: any): any {
  if (!Array.isArray(base) || !Array.isArray(override)) return override;
  const result: any[] = [];
  const seen = new Set<string>();
  for (const value of [...base, ...override]) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function mergeResponsesExtraBody(
  body: Record<string, any>,
  extraBody: Record<string, any>,
): Record<string, any> {
  const regularExtra = Object.fromEntries(
    Object.entries(extraBody).filter(([key]) => !["include", "tools"].includes(key)),
  );
  const merged = deepMerge(body, regularExtra);
  if ("include" in extraBody) merged.include = mergeUniqueList(body.include, extraBody.include);
  if ("tools" in extraBody) {
    merged.tools =
      Array.isArray(body.tools) && Array.isArray(extraBody.tools)
        ? [...body.tools, ...extraBody.tools]
        : extraBody.tools;
  }
  return merged;
}

function flattenChatExtraBody(body: Record<string, any>): Record<string, any> {
  if (!body.extra_body || typeof body.extra_body !== "object" || Array.isArray(body.extra_body))
    return body;
  const { extra_body: extraBody, ...rest } = body;
  return { ...extraBody, ...rest };
}

function headerValue(headers: any, name: string): any {
  if (!headers) return null;
  if (typeof headers.get === "function")
    return headers.get(name) ?? headers.get(name.toLowerCase());
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name.toLowerCase()) return value;
  return null;
}

function getNested(obj: any, path: string[]): any {
  let current = obj;
  for (const segment of path) {
    if (current == null) return undefined;
    current = typeof current === "object" ? current[segment] : undefined;
  }
  return current;
}

export function getNestedInt(obj: any, path: string[]): number {
  const value = getNested(obj, path);
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function getOrNull(obj: any, key: string): any {
  const value = getValue(obj, key);
  return value === undefined ? null : value;
}

async function* timedAsyncIterable(
  stream: AsyncIterable<any>,
  idleTimeoutS: number,
): AsyncGenerator<any> {
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<any>>((resolve, reject) => {
          void resolve;
          timer = setTimeout(
            () => reject(new Error("stream_idle_timeout")),
            Math.max(0, idleTimeoutS) * 1000,
          );
        }),
      ]);
      if (next.done) return;
      yield next.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function enforceRoleAlternation(messages: Record<string, any>[]): Record<string, any>[] {
  return OpenAICompatProvider.enforceRoleAlternation(messages);
}
