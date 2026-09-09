import { z } from "zod";
import {
  EmbeddingInferenceInputSchema,
  type EmbeddingInferenceInput,
  type EmbeddingInferenceOutput,
  type ModelSelectionResolution
} from "@memmy/local-api-contracts";
import type { PluginHostServiceCall, PluginHostServiceInvoker } from "../adapters/outbound/plugin-runtime/index.js";

const MAX_INPUT_CHARACTERS = 200_000;
const MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_OUTPUT_TOKENS = 2_048;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 2;

const ModelInferenceInputSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(MAX_INPUT_CHARACTERS)
  })).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS).optional(),
  responseFormat: z.enum(["text", "json"]).default("text"),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
  thinkingMode: z.literal("disabled").optional(),
  thinkingBudgetTokens: z.number().int().min(1).max(8_192).optional(),
  maxAttempts: z.number().int().min(1).max(DEFAULT_MAX_ATTEMPTS).optional()
}).superRefine((input, context) => {
  const total = input.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total > MAX_INPUT_CHARACTERS) context.addIssue({ code: "custom", path: ["messages"], message: `Total message content exceeds ${MAX_INPUT_CHARACTERS} characters` });
});

export type PluginModelInferenceInput = z.input<typeof ModelInferenceInputSchema>;
export interface PluginModelInferenceResult {
  content: string;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number };
  model: { provider: string; model: string };
}

export interface CreatePluginModelInferenceServiceOptions {
  resolveModel: () => Promise<ModelSelectionResolution | null>;
  embeddingInference?: (input: EmbeddingInferenceInput, options?: { signal?: AbortSignal }) => Promise<EmbeddingInferenceOutput>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

export function createPluginModelInferenceService(options: CreatePluginModelInferenceServiceOptions): PluginHostServiceInvoker {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async invoke(call) {
      throwIfCallerAborted(call.signal);
      if (call.service === "embedding-inference") {
        if (!options.embeddingInference) {
          throw serviceError("embedding_unavailable", "The current embedding model is not available to plugins", false);
        }
        const input = EmbeddingInferenceInputSchema.parse(call.input);
        try {
          return await raceWithAbort(options.embeddingInference(input, { signal: call.signal }), call.signal);
        } catch (error) {
          if (hasServiceErrorCode(error)) throw error;
          throw serviceError(
            "embedding_inference_failed",
            error instanceof Error ? error.message : "Embedding inference failed",
            true
          );
        }
      }
      if (call.service !== "model-inference") throw serviceError("host_service_unavailable", `Unknown Host service: ${call.service}`, false);
      const input = ModelInferenceInputSchema.parse(call.input);
      const resolved = await options.resolveModel();
      if (!resolved?.ok) throw serviceError("model_unavailable", "The current user model is not configured or available", false);
      const configuredAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      const maxAttempts = input.maxAttempts === undefined ? configuredAttempts : Math.min(configuredAttempts, input.maxAttempts);
      let lastError: unknown;
      let attemptInput = input;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          throwIfCallerAborted(call.signal);
          const timeoutMs = Math.min(
            deadlineTimeout(call, options.timeoutMs ?? attemptInput.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            attemptInput.timeoutMs ?? DEFAULT_TIMEOUT_MS
          );
          return await infer(resolved, attemptInput, fetchImpl, timeoutMs, call.signal);
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts || !isRetryableServiceError(error)) throw error;
          // Some OpenAI-compatible gateways occasionally return an empty choice
          // when response_format=json_object is requested. The prompt still asks
          // for JSON, so retrying without the transport-level JSON constraint is
          // a safe compatibility fallback and keeps credentials inside the Host.
          if (serviceErrorCode(error) === "model_empty_response" && attemptInput.responseFormat === "json") {
            attemptInput = { ...attemptInput, responseFormat: "text" };
          }
          const baseDelayMs = Math.max(0, Math.min(30_000, options.retryBaseDelayMs ?? 250));
          const exponentialDelayMs = baseDelayMs * (2 ** (attempt - 1));
          const jitterMs = baseDelayMs > 0 ? Math.floor(Math.random() * Math.max(1, baseDelayMs * 0.2)) : 0;
          await abortableDelay(exponentialDelayMs + jitterMs, call.signal);
        }
      }
      throw lastError;
    }
  };
}

async function infer(
  resolved: Extract<ModelSelectionResolution, { ok: true }>,
  input: z.output<typeof ModelInferenceInputSchema>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<PluginModelInferenceResult> {
  const protocol = resolved.context.protocol;
  const maxTokens = input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    throwIfCallerAborted(callerSignal);
    const request = requestForProtocol(resolved, input, maxTokens, controller.signal);
    const response = await fetchImpl(request.url, request.init);
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw serviceError("model_inference_failed", `Current user model returned HTTP ${response.status}`, retryable);
    }
    const body = await response.json();
    const parsed = extractResponse(protocol, body);
    if (!parsed.content.trim()) throw serviceError("model_empty_response", "Current user model returned no content", true);
    return { ...parsed, model: { provider: resolved.context.provider, model: resolved.context.model } };
  } catch (error) {
    if (callerSignal?.aborted) throw cancelledError();
    if (controller.signal.aborted) throw serviceError("model_inference_timeout", "Current user model request timed out", true);
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  throwIfCallerAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfCallerAborted(signal);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function throwIfCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): Error {
  return serviceError("plugin_call_cancelled", "The owning plugin call was cancelled", false);
}

function requestForProtocol(
  resolved: Extract<ModelSelectionResolution, { ok: true }>,
  input: z.output<typeof ModelInferenceInputSchema>,
  maxTokens: number,
  signal: AbortSignal
): { url: string; init: RequestInit } {
  const { context, provider } = resolved;
  const headers = { "content-type": "application/json", ...(provider.extraHeaders ?? {}) };
  const common = { method: "POST", signal };
  if (context.protocol === "anthropic-messages") {
    const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    return {
      url: endpoint(provider.apiBase, "/v1/messages"),
      init: { ...common, headers: { ...headers, "x-api-key": provider.apiKey ?? "", "anthropic-version": "2023-06-01" }, body: JSON.stringify({
        model: context.model, ...(system ? { system } : {}), messages: input.messages.filter((message) => message.role !== "system"),
        max_tokens: maxTokens, temperature: input.temperature ?? 0.2, ...(provider.extraBody ?? {})
      }) }
    };
  }
  if (context.protocol === "gemini-generate-content") {
    const url = new URL(endpoint(provider.apiBase, `/v1beta/models/${encodeURIComponent(context.model)}:generateContent`));
    if (provider.apiKey) url.searchParams.set("key", provider.apiKey);
    const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    return {
      url: url.href,
      init: { ...common, headers, body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: input.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
        generationConfig: { maxOutputTokens: maxTokens, temperature: input.temperature ?? 0.2, ...(input.responseFormat === "json" ? { responseMimeType: "application/json" } : {}) },
        ...(provider.extraBody ?? {})
      }) }
    };
  }
  if (context.protocol === "openai-responses") {
    return {
      url: endpoint(provider.apiBase, "/v1/responses"),
      init: { ...common, headers: { ...headers, authorization: `Bearer ${provider.apiKey ?? ""}` }, body: JSON.stringify({
        model: context.model, input: input.messages, max_output_tokens: maxTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}), ...(provider.extraBody ?? {})
      }) }
    };
  }
  // Opt-in only. Do not send vendor-specific parameters to unrelated models,
  // or mutate provider defaults shared with the main Agent and other plugins.
  const extraBody = { ...(provider.extraBody ?? {}) };
  const supportsQwenThinkingControl = /^qwen3\.(?:[5-9]|[1-9]\d+)-(?:flash|plus|max)(?:$|-)/iu.test(context.model)
    && !/^qwen3\.[56]-max(?:$|-)/iu.test(context.model);
  const disableThinking = input.thinkingMode === "disabled" && supportsQwenThinkingControl;
  const boundedQwen = input.thinkingBudgetTokens !== undefined && supportsQwenThinkingControl;
  let tokenLimits: Record<string, unknown> = { max_tokens: maxTokens };
  if (disableThinking) {
    // Copy and override only this request; never modify the user's shared model settings.
    for (const key of ["reasoning_effort", "thinking_budget", "thinking", "enable_thinking", "max_tokens", "max_completion_tokens"]) delete extraBody[key];
    if (extraBody.chat_template_kwargs && typeof extraBody.chat_template_kwargs === "object") {
      extraBody.chat_template_kwargs = { ...record(extraBody.chat_template_kwargs), enable_thinking: false };
    }
    tokenLimits = { enable_thinking: false, max_completion_tokens: maxTokens };
  } else if (boundedQwen) {
    delete extraBody.reasoning_effort;
    delete extraBody.thinking_budget;
    delete extraBody.max_tokens;
    delete extraBody.max_completion_tokens;
    tokenLimits = {
      thinking_budget: input.thinkingBudgetTokens,
      max_completion_tokens: maxTokens + input.thinkingBudgetTokens!
    };
  }
  return {
    url: endpoint(provider.apiBase, "/v1/chat/completions"),
    init: { ...common, headers: { ...headers, authorization: `Bearer ${provider.apiKey ?? ""}` }, body: JSON.stringify({
      model: context.model, messages: input.messages, ...tokenLimits, temperature: input.temperature ?? 0.2,
      ...(input.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}), ...extraBody
    }) }
  };
}

function extractResponse(protocol: string, value: unknown): Omit<PluginModelInferenceResult, "model"> {
  const body = record(value);
  if (protocol === "anthropic-messages") {
    const content = Array.isArray(body.content) ? body.content.map(record).filter((item) => item.type === "text").map((item) => string(item.text)).join("") : "";
    return { content, finishReason: string(body.stop_reason) || "stop", usage: usage(body.usage, "input_tokens", "output_tokens") };
  }
  if (protocol === "gemini-generate-content") {
    const candidates = Array.isArray(body.candidates) ? body.candidates.map(record) : [];
    const parts = Array.isArray(record(candidates[0]?.content).parts) ? (record(candidates[0]?.content).parts as unknown[]).map(record) : [];
    return { content: parts.map((part) => string(part.text)).join(""), finishReason: string(candidates[0]?.finishReason) || "stop", usage: usage(body.usageMetadata, "promptTokenCount", "candidatesTokenCount", "totalTokenCount") };
  }
  if (protocol === "openai-responses") {
    const output = Array.isArray(body.output) ? body.output.map(record) : [];
    const content = output.flatMap((item) => Array.isArray(item.content) ? (item.content as unknown[]).map(record) : []).filter((item) => item.type === "output_text").map((item) => string(item.text)).join("");
    return { content: string(body.output_text) || content, finishReason: string(body.status) || "completed", usage: usage(body.usage, "input_tokens", "output_tokens", "total_tokens") };
  }
  const choice = Array.isArray(body.choices) ? record(body.choices[0]) : {};
  const reasoningTokens = numeric(record(record(body.usage).completion_tokens_details).reasoning_tokens);
  return { content: string(record(choice.message).content), finishReason: string(choice.finish_reason) || "stop", usage: {
    ...usage(body.usage, "prompt_tokens", "completion_tokens", "total_tokens"),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
  } };
}

function endpoint(base: string, suffix: string): string {
  const normalized = base.replace(/\/+$/, "");
  if (normalized.endsWith(suffix)) return normalized;
  const versioned = suffix.match(/^\/(v\d+(?:beta\d*)?)(\/.*)$/u);
  if (versioned && normalized.endsWith(`/${versioned[1]}`)) return `${normalized}${versioned[2]}`;
  return `${normalized}${suffix}`;
}

function usage(value: unknown, inputKey: string, outputKey: string, totalKey?: string): PluginModelInferenceResult["usage"] {
  const source = record(value); const inputTokens = numeric(source[inputKey]); const outputTokens = numeric(source[outputKey]); const totalTokens = numeric(totalKey ? source[totalKey] : undefined) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) };
}

function deadlineTimeout(call: PluginHostServiceCall, fallback: number): number {
  if (!call.deadline) return fallback;
  return Math.max(1, Math.min(fallback, Date.parse(call.deadline) - Date.now()));
}
function serviceError(code: string, message: string, retryable: boolean): Error { return Object.assign(new Error(message), { code, retryable }); }
function hasServiceErrorCode(error: unknown): error is Error & { code: string; retryable?: boolean } {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string";
}
function isRetryableServiceError(error: unknown): error is Error & { retryable: true } {
  return error instanceof Error && (error as Error & { retryable?: unknown }).retryable === true;
}
function serviceErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
