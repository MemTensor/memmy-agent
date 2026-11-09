import { creditCheckpoint } from "./credit-checkpoint.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import type { ActualModelContext } from "../contracts/index.js";

const logger = createMemoryLogger("model-http");

export class ModelHttpError extends Error {
  override readonly name = "ModelHttpError";

  constructor(
    message: string,
    readonly provider: string,
    readonly httpStatus: number,
    readonly errorCode: string | undefined,
    readonly detail: string,
    readonly actualModelContext?: Readonly<ActualModelContext>
  ) {
    super(message);
  }
}

/** Credit failures must reach the job owner before any retry or fallback model call. */
export function isCreditModelError(error: unknown): boolean {
  const codes = ["CREDIT_INSUFFICIENT", "CREDIT_BALANCE_RESERVED", "CREDIT_CALL_UNCERTAIN", "40308", "40309"];
  if (error instanceof ModelHttpError && error.errorCode !== undefined) {
    return codes.includes(error.errorCode.toUpperCase());
  }
  return error instanceof Error && /\b(?:CREDIT_INSUFFICIENT|CREDIT_BALANCE_RESERVED|CREDIT_CALL_UNCERTAIN|40308|40309)\b/i.test(error.message);
}

export async function postJsonWithRetry<T>(
  input: {
    provider: string;
    operation?: string;
    model?: string;
    url: string;
    headers?: Record<string, string>;
    body: unknown;
    timeoutMs: number;
    maxRetries: number;
    actualModelContext?: Readonly<ActualModelContext>;
  }
): Promise<T> {
  const checkpoint = creditCheckpoint(input.operation, input.body);
  const completed = checkpoint?.read();
  if (completed !== undefined) return completed as T;
  let lastError: unknown;
  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const response = await fetch(input.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.headers ?? {})
          },
          body: JSON.stringify(input.body),
          signal: controller.signal
        });
        const text = await response.text();
        const failure = parseProviderFailure(text);
        if (!response.ok || failure.isBusinessError) {
          throw new ModelHttpError(
            formatHttpFailure(input.provider, response, text),
            input.provider,
            response.status,
            failure.errorCode,
            failure.detail,
            input.actualModelContext
          );
        }
        const result = parseJsonResponse<T>(input.provider, response, text);
        checkpoint?.save(result);
        return result;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      // Without a cloud call ID, transport failure cannot prove the paid request was not accepted.
      if (input.actualModelContext?.source === "account" &&
          (!(error instanceof ModelHttpError) || error.httpStatus >= 500)) {
        error = new ModelHttpError("平台调用结果待核实，已停止自动重试", input.provider, 502,
          "CREDIT_CALL_UNCERTAIN", "平台调用结果待核实；请先核对消费明细，再手动重试未完成步骤。", input.actualModelContext);
      }
      lastError = error;
      if (!isCreditModelError(error) && input.actualModelContext?.source !== "account" && attempt < input.maxRetries && isRetryableModelRequestError(error)) {
        const delayMs = Math.min(1_000 * Math.pow(2, attempt), 8_000);
        logger.warn("request.retry_scheduled", {
          provider: input.provider,
          operation: input.operation,
          model: input.model,
          endpoint: safeEndpoint(input.url),
          attempt: attempt + 1,
          maxAttempts: input.maxRetries + 1,
          delayMs,
          ...memoryErrorFields(error)
        });
        await sleep(delayMs);
        continue;
      }
      logger.error("request.failed", {
        provider: input.provider,
        operation: input.operation,
        model: input.model,
        endpoint: safeEndpoint(input.url),
        attempt: attempt + 1,
        maxAttempts: input.maxRetries + 1,
        ...memoryErrorFields(error)
      });
      break;
    }
  }
  const normalized = lastError instanceof Error ? lastError : new Error(String(lastError));
  if (input.actualModelContext && !("actualModelContext" in normalized)) {
    Object.assign(normalized, { actualModelContext: input.actualModelContext });
  }
  throw normalized;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function bearer(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableModelRequestError(error: unknown): boolean {
  if (error instanceof ModelHttpError) {
    return error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function parseJsonResponse<T>(provider: string, response: Response, text: string): T {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`${provider} HTTP ${response.status}: expected JSON but received an empty response`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const responseType = describeResponseType(response, trimmed);
    throw new Error(
      `${provider} HTTP ${response.status}: expected JSON but received ${responseType}; check the configured model endpoint`
    );
  }
}

function formatHttpFailure(provider: string, response: Response, text: string): string {
  const prefix = `${provider} HTTP ${response.status}`;
  const trimmed = text.trim();
  if (!trimmed) {
    return `${prefix}: empty response`;
  }
  if (looksLikeHtml(response, trimmed)) {
    return `${prefix}: endpoint returned HTML instead of JSON; check the configured model endpoint`;
  }
  const providerMessage = extractProviderErrorMessage(trimmed);
  return `${prefix}: ${clip(providerMessage ?? compact(trimmed), 800)}`;
}

function extractProviderErrorMessage(text: string): string | undefined {
  return parseProviderFailure(text).message;
}

function parseProviderFailure(text: string): {
  detail: string;
  errorCode?: string;
  isBusinessError: boolean;
  message?: string;
} {
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      error?: string | { code?: unknown; message?: unknown };
      message?: unknown;
    };
    const rawCode = parsed.error && typeof parsed.error === "object"
      ? parsed.error.code ?? parsed.code
      : parsed.code;
    const errorCode = typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode)
      : undefined;
    const normalizedCode = errorCode?.trim().toLowerCase();
    const isQuotaCode = ["40309", "40308", "credit_insufficient"].includes(normalizedCode ?? "");
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return { detail: parsed.error, errorCode, isBusinessError: true, message: parsed.error.trim() };
    }
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
      return {
        detail: parsed.error.message,
        errorCode,
        isBusinessError: true,
        message: parsed.error.message.trim() || undefined
      };
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      const message = parsed.message.trim();
      const isMemoryEvolutionQuota = isMemoryEvolutionQuotaMessage(message);
      return {
        detail: parsed.message,
        errorCode: errorCode ?? (isMemoryEvolutionQuota ? "40309" : undefined),
        isBusinessError: isQuotaCode || isMemoryEvolutionQuota,
        message
      };
    }
    return { detail: text, errorCode, isBusinessError: isQuotaCode };
  } catch {
    return { detail: text, isBusinessError: false };
  }
}

function isMemoryEvolutionQuotaMessage(message: string): boolean {
  const normalized = message.toLowerCase().replace(/\s+/gu, " ").trim();
  return normalized.includes("memory_evolution")
    && /(token 用量不足|额度(?:不足|耗尽)|quota(?:\s+)?(?:exhausted|insufficient))/u.test(normalized);
}

function describeResponseType(response: Response, text: string): string {
  if (looksLikeHtml(response, text)) return "HTML instead of a model API response";
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType ? `invalid JSON (${contentType})` : "invalid JSON";
}

function looksLikeHtml(response: Response, text: string): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/html") || /^\s*(?:<!doctype\s+html|<html)\b/i.test(text);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?", 1)[0] ?? "<invalid-url>";
  }
}
