import type { LlmConfig } from "../config/index.js";
import { bearer, postJsonWithRetry, trimTrailingSlash } from "./http.js";
import {
  HttpByokTokenUsageRecorder,
  extractModelTokenUsage,
  type MemoryLlmModelRole
} from "./token-usage.js";
import type { LlmClient, LlmCompletionOptions, LlmMessage, ModelStatus } from "./types.js";

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: Record<string, unknown>;
}

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: Record<string, unknown>;
}

interface BedrockResponse {
  output?: { message?: { content?: Array<{ text?: string }> } };
  usage?: Record<string, unknown>;
}

interface HostResponse {
  text?: string;
  content?: string;
  output?: string;
  usage?: Record<string, unknown>;
}

const OPENAI_COMPAT_THINKING_EFFORT = "medium";
const ANTHROPIC_THINKING_BUDGET_TOKENS = 4096;
const ANTHROPIC_MIN_THINKING_OUTPUT_TOKENS = ANTHROPIC_THINKING_BUDGET_TOKENS + 4096;
const GEMINI_THINKING_BUDGET_ENABLED = -1;
const GEMINI_THINKING_BUDGET_DISABLED = 0;

interface ThinkingControl {
  enabled: boolean;
  fields: Record<string, unknown>;
}

export interface CreateLlmClientOptions {
  modelRole?: MemoryLlmModelRole;
}

export function createLlmClient(config: LlmConfig, options: CreateLlmClientOptions = {}): LlmClient {
  return new HttpLlmClient(config, options);
}

class HttpLlmClient implements LlmClient {
  private lastOkAt: string | undefined;
  private lastError: string | undefined;
  private readonly usageRecorder = new HttpByokTokenUsageRecorder();

  constructor(readonly config: LlmConfig, private readonly options: CreateLlmClientOptions = {}) {}

  isConfigured(): boolean {
    if (!this.config.provider || this.config.provider === "local_only") {
      return false;
    }
    if (this.config.provider === "host") {
      return Boolean(this.config.endpoint);
    }
    if (this.config.provider === "bedrock") {
      return Boolean(this.config.endpoint && this.config.model);
    }
    return Boolean(this.config.model && (this.config.apiKey || this.config.endpoint));
  }

  async complete(messages: LlmMessage[], options: LlmCompletionOptions): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(`LLM provider is not configured: ${this.config.provider || "(empty)"}`);
    }
    const callOptions = {
      ...options,
      temperature: options.temperature ?? this.config.temperature,
      maxTokens: options.maxTokens ?? this.config.maxTokens
    };
    try {
      const result = await this.completeOnce(messages, callOptions);
      this.lastOkAt = new Date().toISOString();
      this.lastError = undefined;
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async completeJson<T extends Record<string, unknown>>(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.malformedRetries; attempt += 1) {
      const withJsonHint = jsonMessages(messages, attempt > 0 ? lastError : undefined);
      const text = await this.complete(withJsonHint, {
        ...options,
        jsonMode: true
      });
      try {
        return parseJsonObject(text) as T;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  status(): ModelStatus {
    return {
      provider: this.config.provider,
      model: this.config.model,
      configured: this.isConfigured(),
      remote: this.isConfigured(),
      lastOkAt: this.lastOkAt,
      lastError: this.lastError
    };
  }

  private completeOnce(messages: LlmMessage[], options: Required<Pick<LlmCompletionOptions, "operation">> & LlmCompletionOptions): Promise<string> {
    switch (this.config.provider) {
      case "openai_compatible":
        return this.completeOpenAiCompatible(messages, options);
      case "gemini":
        return this.completeGemini(messages, options);
      case "anthropic":
        return this.completeAnthropic(messages, options);
      case "bedrock":
        return this.completeBedrock(messages, options);
      case "host":
        return this.completeHost(messages, options);
      default:
        throw new Error(`unsupported LLM provider: ${this.config.provider}`);
    }
  }

  private async completeOpenAiCompatible(messages: LlmMessage[], options: LlmCompletionOptions): Promise<string> {
    const base = trimTrailingSlash(this.config.endpoint || "https://api.openai.com/v1");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const thinking = openAiCompatibleThinkingControl({
      vendor: this.config.vendor ?? "",
      endpoint: base,
      model: this.config.model ?? "",
      requested: resolveThinkingEnabled(this.config.enableThinking, options.thinkingMode)
    });
    const model = this.config.model ?? "";
    const omitTemperature = isKimiImmutableTemperatureModel(model) ||
      (thinking.enabled && shouldOmitOpenAiCompatibleTemperature(this.config.vendor ?? "", base, model));
    const omitJsonMode = thinking.enabled && (
      thinkingUsesEnableThinking(this.config.vendor ?? "", base, model) ||
      isAlibabaCompatibleEndpoint(base)
    );
    const thinkingBudget = thinking.enabled && thinkingUsesEnableThinking(this.config.vendor ?? "", base, model)
      ? this.config.thinkingBudget
      : undefined;
    const response = await postJsonWithRetry<OpenAiChatResponse>({
      provider: "openai_compatible",
      url,
      headers: bearer(this.config.apiKey),
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      body: {
        model: this.config.model,
        messages,
        ...(!omitTemperature ? { temperature: options.temperature ?? this.config.temperature } : {}),
        max_tokens: options.maxTokens ?? this.config.maxTokens,
        stream: false,
        ...thinking.fields,
        ...(thinkingBudget !== undefined ? { thinking_budget: thinkingBudget } : {}),
        ...(options.jsonMode && !omitJsonMode ? { response_format: { type: "json_object" } } : {})
      }
    });
    const text = response.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("openai_compatible response missing choices[0].message.content");
    }
    this.recordTokenUsage(response, options);
    return text;
  }

  private async completeGemini(messages: LlmMessage[], options: LlmCompletionOptions): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error("gemini provider requires apiKey");
    }
    const base = trimTrailingSlash(this.config.endpoint || "https://generativelanguage.googleapis.com/v1beta");
    const model = encodeURIComponent(this.config.model || "gemini-1.5-flash");
    const thinking = geminiThinkingControl(
      this.config.model || "gemini-1.5-flash",
      resolveThinkingEnabled(this.config.enableThinking, options.thinkingMode)
    );
    const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
    const systemParts = messages
      .filter((message) => message.role === "system")
      .map((message) => ({ text: message.content }));
    const body: Record<string, unknown> = {
      contents: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }]
        })),
      generationConfig: {
        temperature: options.temperature ?? this.config.temperature,
        maxOutputTokens: options.maxTokens ?? this.config.maxTokens,
        ...thinking.fields,
        ...(options.jsonMode ? { responseMimeType: "application/json" } : {})
      }
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: systemParts };
    }
    const response = await postJsonWithRetry<GeminiGenerateResponse>({
      provider: "gemini",
      url,
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      body
    });
    const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
    if (typeof text !== "string") {
      throw new Error("gemini response missing candidates[0].content.parts");
    }
    this.recordTokenUsage(response, options);
    return text;
  }

  private async completeAnthropic(messages: LlmMessage[], options: LlmCompletionOptions): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error("anthropic provider requires apiKey");
    }
    const url = normalizeAnthropicEndpoint(this.config.endpoint || "https://api.anthropic.com/v1/messages");
    const thinking = anthropicThinkingControl(
      this.config.model || "claude-3-5-haiku-latest",
      resolveThinkingEnabled(this.config.enableThinking, options.thinkingMode),
      options.maxTokens ?? this.config.maxTokens ?? 1200
    );
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const response = await postJsonWithRetry<AnthropicResponse>({
      provider: "anthropic",
      url,
      headers: {
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      body: {
        model: this.config.model || "claude-3-5-haiku-latest",
        ...thinking.fields,
        ...(!thinking.enabled && !isAnthropicFixedTemperatureModel(this.config.model || "")
          ? { temperature: options.temperature ?? this.config.temperature }
          : {}),
        stream: false,
        ...(system ? { system } : {}),
        messages: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content
          }))
      }
    });
    const text = (response.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("");
    this.recordTokenUsage(response, options);
    return text;
  }

  private async completeBedrock(messages: LlmMessage[], options: LlmCompletionOptions): Promise<string> {
    if (!this.config.endpoint) {
      throw new Error("bedrock provider requires endpoint");
    }
    const base = trimTrailingSlash(this.config.endpoint);
    const modelName = this.config.model || "anthropic.claude-3-5-haiku-20241022-v1:0";
    const thinking = bedrockThinkingControl(
      modelName,
      resolveThinkingEnabled(this.config.enableThinking, options.thinkingMode)
    );
    const model = encodeURIComponent(modelName);
    const requestedMaxTokens = options.maxTokens ?? this.config.maxTokens;
    const maxTokens = thinking.enabled
      ? Math.max(requestedMaxTokens ?? 1200, ANTHROPIC_MIN_THINKING_OUTPUT_TOKENS)
      : requestedMaxTokens;
    const response = await postJsonWithRetry<BedrockResponse>({
      provider: "bedrock",
      url: `${base}/model/${model}/converse`,
      headers: this.config.apiKey ? { authorization: this.config.apiKey } : {},
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      body: {
        system: messages
          .filter((message) => message.role === "system")
          .map((message) => ({ text: message.content })),
        messages: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: [{ text: message.content }]
          })),
        inferenceConfig: {
          ...(!thinking.enabled && !isAnthropicFixedTemperatureModel(modelName)
            ? { temperature: options.temperature ?? this.config.temperature }
            : {}),
          maxTokens
        },
        ...thinking.fields
      }
    });
    const text = response.output?.message?.content?.map((part) => part.text ?? "").join("");
    if (typeof text !== "string") {
      throw new Error("bedrock response missing output.message.content");
    }
    this.recordTokenUsage(response, options);
    return text;
  }

  private async completeHost(messages: LlmMessage[], options: LlmCompletionOptions): Promise<string> {
    if (!this.config.endpoint) {
      throw new Error("host provider requires endpoint");
    }
    const response = await postJsonWithRetry<HostResponse>({
      provider: "host",
      url: this.config.endpoint,
      headers: bearer(this.config.apiKey),
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      body: {
        messages,
        operation: options.operation,
        temperature: options.temperature ?? this.config.temperature,
        maxTokens: options.maxTokens ?? this.config.maxTokens,
        enableThinking: resolveThinkingEnabled(this.config.enableThinking, options.thinkingMode),
        jsonMode: options.jsonMode ?? false
      }
    });
    const text = response.text ?? response.content ?? response.output;
    if (typeof text !== "string") {
      throw new Error("host response missing text/content/output");
    }
    this.recordTokenUsage(response, options);
    return text;
  }

  private recordTokenUsage(response: unknown, options: LlmCompletionOptions): void {
    if (!this.options.modelRole) {
      return;
    }

    this.usageRecorder.record({
      kind: this.options.modelRole,
      operation: options.operation,
      provider: this.config.provider,
      model: this.config.model,
      endpoint: this.config.endpoint,
      usage: extractModelTokenUsage(response)
    });
  }
}

function openAiCompatibleThinkingControl(input: {
  vendor: string;
  endpoint: string;
  model: string;
  requested: boolean;
}): ThinkingControl {
  const style = openAiCompatibleThinkingStyle(input.vendor, input.endpoint, input.model);
  const enabled = input.requested || isOpenAiCompatibleThinkingOnlyModel(input.vendor, input.endpoint, input.model);
  if (isAlwaysOnModelWithoutThinkingToggle(input.model)) {
    return { enabled: true, fields: {} };
  }
  switch (style) {
    case "reasoning_effort":
      return {
        enabled,
        fields: { reasoning_effort: enabled ? OPENAI_COMPAT_THINKING_EFFORT : "none" }
      };
    case "reasoning":
      return {
        enabled,
        fields: { reasoning: { effort: enabled ? OPENAI_COMPAT_THINKING_EFFORT : "none" } }
      };
    case "thinking_type":
      return { enabled, fields: { thinking: { type: enabled ? "enabled" : "disabled" } } };
    case "thinking_adaptive":
      return { enabled, fields: { thinking: { type: enabled ? "adaptive" : "disabled" } } };
    case "enable_thinking":
      return { enabled, fields: { enable_thinking: enabled } };
    case "minimax_direct":
      if (isMiniMaxM2ThinkingOnlyModel(input.model)) {
        return {
          enabled: true,
          fields: { reasoning_split: true }
        };
      }
      if (isMiniMaxM3Model(input.model)) {
        return {
          enabled,
          fields: {
            thinking: { type: enabled ? "adaptive" : "disabled" },
            ...(enabled ? { reasoning_split: true } : {})
          }
        };
      }
      return {
        enabled,
        fields: enabled ? { reasoning_split: true } : {}
      };
    case "none":
      return { enabled: false, fields: {} };
  }
}

type OpenAiCompatibleThinkingStyle =
  | "reasoning_effort"
  | "reasoning"
  | "thinking_type"
  | "thinking_adaptive"
  | "enable_thinking"
  | "minimax_direct"
  | "none";

function openAiCompatibleThinkingStyle(
  vendor: string,
  endpoint: string,
  model: string
): OpenAiCompatibleThinkingStyle {
  const haystack = `${endpoint} ${model}`.toLowerCase();
  const slug = modelSlug(model);
  if (haystack.includes("openrouter")) return "reasoning";
  if (isAlibabaCompatibleEndpoint(endpoint)) {
    return vendor === "minimax" || slug.includes("minimax") ? "thinking_adaptive" : "enable_thinking";
  }
  if (vendor === "qwen") return "enable_thinking";
  if (vendor === "minimax") return "minimax_direct";
  if (vendor === "baidu" && (slug.includes("ernie") || slug.includes("qwen"))) return "enable_thinking";
  if (["deepseek", "zhipu", "kimi", "baidu", "doubao"].includes(vendor)) return "thinking_type";
  if (vendor === "openai_compatible" && isOpenAiReasoningModel(slug)) return "reasoning_effort";
  if (haystack.includes("dashscope") || haystack.includes("qwen")) return "enable_thinking";
  if (haystack.includes("minimax")) return "minimax_direct";
  if (haystack.includes("qianfan") && slug.includes("ernie")) return "enable_thinking";
  if (
    haystack.includes("volces") ||
    haystack.includes("volcengine") ||
    haystack.includes("byteplus") ||
    haystack.includes("deepseek") ||
    haystack.includes("bigmodel") ||
    haystack.includes("zhipu") ||
    haystack.includes("moonshot") ||
    haystack.includes("qianfan") ||
    haystack.includes("xiaomimimo") ||
    slug.includes("glm-") ||
    slug.includes("kimi-k2.5") ||
    slug.includes("kimi-k2.6") ||
    slug.includes("kimi-k2.7") ||
    slug.includes("k2.6-code-preview") ||
    slug.includes("mimo-v2")
  ) {
    return "thinking_type";
  }
  if (isOpenAiReasoningModel(slug)) return "reasoning_effort";
  return "none";
}

function shouldOmitOpenAiCompatibleTemperature(vendor: string, endpoint: string, model: string): boolean {
  const style = openAiCompatibleThinkingStyle(vendor, endpoint, model);
  return style === "reasoning_effort" || style === "reasoning";
}

function thinkingUsesEnableThinking(vendor: string, endpoint: string, model: string): boolean {
  return openAiCompatibleThinkingStyle(vendor, endpoint, model) === "enable_thinking";
}

function geminiThinkingControl(model: string, requested: boolean): ThinkingControl {
  const slug = modelSlug(model);
  if (/^gemini-3(?:[.-]|$)/.test(slug)) {
    return {
      enabled: true,
      fields: { thinkingConfig: { thinkingLevel: "high" } }
    };
  }
  if (slug.startsWith("gemini-2.5-pro")) {
    return {
      enabled: true,
      fields: { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET_ENABLED } }
    };
  }
  if (slug.startsWith("gemini-2.5")) {
    return {
      enabled: requested,
      fields: {
        thinkingConfig: {
          thinkingBudget: requested ? GEMINI_THINKING_BUDGET_ENABLED : GEMINI_THINKING_BUDGET_DISABLED
        }
      }
    };
  }
  return { enabled: false, fields: {} };
}

function anthropicThinkingControl(model: string, requested: boolean, maxTokens: number): ThinkingControl {
  if (!isAnthropicThinkingCapableModel(model)) {
    return { enabled: false, fields: { max_tokens: maxTokens } };
  }
  const enabled = requested || isAnthropicAlwaysThinkingModel(model);
  if (!enabled) {
    return {
      enabled: false,
      fields: {
        max_tokens: maxTokens,
        thinking: { type: "disabled" }
      }
    };
  }
  if (isAnthropicAdaptiveThinkingModel(model)) {
    return {
      enabled: true,
      fields: {
        max_tokens: Math.max(maxTokens, ANTHROPIC_MIN_THINKING_OUTPUT_TOKENS),
        thinking: { type: "adaptive" },
        output_config: { effort: OPENAI_COMPAT_THINKING_EFFORT }
      }
    };
  }
  return {
    enabled: true,
    fields: {
      max_tokens: Math.max(maxTokens, ANTHROPIC_MIN_THINKING_OUTPUT_TOKENS),
      temperature: 1,
      thinking: {
        type: "enabled",
        budget_tokens: ANTHROPIC_THINKING_BUDGET_TOKENS
      }
    }
  };
}

function bedrockThinkingControl(model: string, requested: boolean): ThinkingControl {
  if (!isAnthropicThinkingCapableModel(model)) {
    return { enabled: false, fields: {} };
  }
  const enabled = requested || isBedrockAdaptiveOnlyModel(model);
  if (!enabled) {
    return {
      enabled: false,
      fields: {
        additionalModelRequestFields: { thinking: { type: "disabled" } }
      }
    };
  }
  if (isAnthropicAdaptiveThinkingModel(model)) {
    return {
      enabled: true,
      fields: {
        additionalModelRequestFields: {
          thinking: { type: "adaptive" },
          output_config: { effort: OPENAI_COMPAT_THINKING_EFFORT }
        }
      }
    };
  }
  return {
    enabled: true,
    fields: {
      additionalModelRequestFields: {
        thinking: {
          type: "enabled",
          budget_tokens: ANTHROPIC_THINKING_BUDGET_TOKENS
        }
      }
    }
  };
}

function isAnthropicThinkingCapableModel(model: string): boolean {
  const slug = modelSlug(model);
  return (
    slug.includes("claude-3-7") ||
    /claude-(?:opus|sonnet|haiku)?-?4(?:[.-]|$)/.test(slug) ||
    /claude-(?:opus|sonnet|haiku)?-?5(?:[.-]|$)/.test(slug) ||
    slug.includes("fable") ||
    slug.includes("mythos")
  );
}

function isAnthropicAdaptiveThinkingModel(model: string): boolean {
  const slug = modelSlug(model);
  return (
    slug.includes("4-6") ||
    slug.includes("4.6") ||
    slug.includes("4-7") ||
    slug.includes("4.7") ||
    slug.includes("4-8") ||
    slug.includes("4.8") ||
    /claude-(?:opus|sonnet|haiku)?-?5(?:[.-]|$)/.test(slug) ||
    slug.includes("fable") ||
    slug.includes("mythos")
  );
}

function isAnthropicAlwaysThinkingModel(model: string): boolean {
  const slug = modelSlug(model);
  return (
    slug.includes("fable") ||
    slug.includes("mythos")
  );
}

function isAnthropicFixedTemperatureModel(model: string): boolean {
  const slug = modelSlug(model);
  return isAnthropicAlwaysThinkingModel(model) ||
    /claude-sonnet-5(?:[.-]|$)/.test(slug) ||
    slug.includes("opus-4-7") ||
    slug.includes("opus-4.7") ||
    slug.includes("opus-4-8") ||
    slug.includes("opus-4.8");
}

function isBedrockAdaptiveOnlyModel(model: string): boolean {
  const slug = modelSlug(model);
  return isAnthropicAlwaysThinkingModel(model) ||
    slug.includes("opus-4-7") ||
    slug.includes("opus-4.7") ||
    slug.includes("opus-4-8") ||
    slug.includes("opus-4.8");
}

function isOpenAiCompatibleThinkingOnlyModel(vendor: string, endpoint: string, model: string): boolean {
  const slug = modelSlug(model);
  if (isOpenAiReasoningModel(slug) && !supportsOpenAiReasoningNone(slug)) return true;
  if (slug.includes("deepseek-r1") || slug.includes("deepseek-reasoner")) return true;
  if (slug.startsWith("kimi-k2.7-code")) return true;
  if (/^gemini-3(?:[.-]|$)/.test(slug) || slug.startsWith("gemini-2.5-pro")) return true;
  if (isAnthropicAlwaysThinkingModel(slug) || isMiniMaxM2ThinkingOnlyModel(slug)) return true;
  if (slug.startsWith("qwq") || (slug.includes("-thinking") && !slug.startsWith("ernie-"))) return true;
  if (slug === "qwen3.7-max-preview" || slug.includes("qwen3.7-max-2026-05-17")) return true;
  return vendor === "minimax" && endpoint.toLowerCase().includes("minimax.io") &&
    isMiniMaxM2ThinkingOnlyModel(model);
}

function isAlwaysOnModelWithoutThinkingToggle(model: string): boolean {
  const slug = modelSlug(model);
  return (
    slug.includes("deepseek-r1") ||
    slug.includes("deepseek-reasoner") ||
    slug.startsWith("kimi-k2.7-code") ||
    slug.startsWith("qwq") ||
    (slug.includes("-thinking") && !slug.startsWith("ernie-")) ||
    slug === "qwen3.7-max-preview" ||
    slug.includes("qwen3.7-max-2026-05-17")
  );
}

function supportsOpenAiReasoningNone(slug: string): boolean {
  const version = slug.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 1);
}

function isMiniMaxM2ThinkingOnlyModel(model: string): boolean {
  return /^minimax-m2(?:[.\-]|$)/.test(modelSlug(model));
}

function isMiniMaxM3Model(model: string): boolean {
  return /^minimax-m3(?:[.\-]|$)/.test(modelSlug(model));
}

function isAlibabaCompatibleEndpoint(endpoint: string): boolean {
  const normalized = endpoint.toLowerCase();
  return normalized.includes("dashscope") ||
    normalized.includes("aliyuncs.com") ||
    normalized.includes("alibabacloud.com");
}

function resolveThinkingEnabled(
  configured: boolean,
  mode: LlmCompletionOptions["thinkingMode"]
): boolean {
  if (mode === "enabled") return true;
  if (mode === "disabled") return false;
  return configured;
}

function isKimiImmutableTemperatureModel(model: string): boolean {
  const slug = modelSlug(model);
  return (
    slug.includes("kimi-k2.5") ||
    slug.includes("kimi-k2.6") ||
    slug.includes("k2.6-code-preview") ||
    slug.startsWith("kimi-k2.7-code")
  );
}

function isOpenAiReasoningModel(slug: string): boolean {
  return /^(o[134]\b|o[134][.-]|gpt-[5-9]\b|gpt-[5-9][.-])/.test(slug);
}

function modelSlug(model: string): string {
  return model.trim().toLowerCase().split("/").at(-1) ?? model.trim().toLowerCase();
}

function jsonMessages(messages: LlmMessage[], previousError?: unknown): LlmMessage[] {
  const hint = [
    "Return exactly one valid JSON object. Do not include markdown fences or explanatory text.",
    previousError ? `Previous JSON parse error: ${previousError instanceof Error ? previousError.message : String(previousError)}` : undefined
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: hint },
    ...messages
  ];
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("LLM output does not contain a JSON object");
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM JSON output is not an object");
  }
  return parsed as Record<string, unknown>;
}

function normalizeAnthropicEndpoint(value: string): string {
  const stripped = trimTrailingSlash(value);
  return stripped.endsWith("/v1/messages") ? stripped : `${stripped}/v1/messages`;
}
