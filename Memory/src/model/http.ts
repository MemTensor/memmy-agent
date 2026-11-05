import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import type { ActualModelContext } from "../contracts/index.js";

const logger = createMemoryLogger("model-http");

export type ModelErrorCategory =
  | "authentication_required"
  | "permission_denied"
  | "quota_exhausted"
  | "rate_limited"
  | "invalid_model_request"
  | "provider_server_error";

export type ProviderBusinessEnvelope = "memmy_account";

export class ModelHttpError extends Error {
  override readonly name = "ModelHttpError";

  constructor(
    message: string,
    readonly provider: string,
    readonly httpStatus: number,
    readonly errorCode: string | undefined,
    readonly detail: string,
    readonly actualModelContext?: Readonly<ActualModelContext>,
    readonly errorType?: string,
    readonly errorCategory?: ModelErrorCategory
  ) {
    super(message);
  }
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
    businessEnvelope?: ProviderBusinessEnvelope;
  }
): Promise<T> {
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
        const failure = parseProviderFailure(text, input.businessEnvelope);
        if (!response.ok || failure.isBusinessError) {
          throw new ModelHttpError(
            formatHttpFailure(input.provider, response, text, failure.message),
            input.provider,
            response.status,
            failure.errorCode,
            failure.detail,
            input.actualModelContext,
            failure.errorType,
            failure.errorCategory
          );
        }
        return parseJsonResponse<T>(input.provider, response, text);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (attempt < input.maxRetries && isRetryableModelRequestError(error)) {
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
    if (error.errorCategory === "quota_exhausted") return false;
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

function formatHttpFailure(provider: string, response: Response, text: string, providerMessage?: string): string {
  const prefix = `${provider} HTTP ${response.status}`;
  const trimmed = text.trim();
  if (!trimmed) {
    return `${prefix}: empty response`;
  }
  if (looksLikeHtml(response, trimmed)) {
    return `${prefix}: endpoint returned HTML instead of JSON; check the configured model endpoint`;
  }
  return `${prefix}: ${clip(providerMessage ?? compact(trimmed), 800)}`;
}

function parseProviderFailure(text: string, businessEnvelope?: ProviderBusinessEnvelope): {
  detail: string;
  errorCode?: string;
  errorType?: string;
  errorCategory?: ModelErrorCategory;
  isBusinessError: boolean;
  message?: string;
} {
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      memmy_code?: unknown;
      type?: unknown;
      error?: string | { code?: unknown; memmy_code?: unknown; type?: unknown; message?: unknown };
      message?: unknown;
    };
    const nestedError = parsed.error && typeof parsed.error === "object" ? parsed.error : undefined;
    const memmyCode = businessEnvelope === "memmy_account"
      ? nestedError?.memmy_code ?? parsed.memmy_code
      : undefined;
    const rawCode = memmyCode ?? (nestedError
      ? nestedError.code ?? parsed.code
      : parsed.code);
    const errorCode = typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode)
      : undefined;
    const rawType = nestedError?.type ?? parsed.type;
    const errorType = typeof rawType === "string" && rawType.trim() ? rawType.trim() : undefined;
    const normalizedCode = errorCode?.trim().toLowerCase();
    const isMemmyBusinessCode = businessEnvelope === "memmy_account" && normalizedCode !== undefined &&
      normalizedCode !== "0" && normalizedCode !== "success";
    const isLegacyQuotaCode = normalizedCode === "40309";
    const errorCategory = classifyProviderFailure(errorCode, errorType, businessEnvelope);
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return { detail: parsed.error, errorCode, errorType, errorCategory,
        isBusinessError: true, message: parsed.error.trim() };
    }
    if (nestedError) {
      const message = typeof nestedError.message === "string" && nestedError.message.trim()
        ? nestedError.message.trim()
        : undefined;
      return {
        detail: typeof nestedError.message === "string" ? nestedError.message : text,
        errorCode,
        errorType,
        errorCategory,
        isBusinessError: true,
        message
      };
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      const message = parsed.message.trim();
      const isMemoryEvolutionQuota = isMemoryEvolutionQuotaMessage(message);
      const resolvedCategory = errorCategory ?? (isMemoryEvolutionQuota ? "quota_exhausted" : undefined);
      return {
        detail: parsed.message,
        errorCode: errorCode ?? (isMemoryEvolutionQuota ? "40309" : undefined),
        errorType,
        errorCategory: resolvedCategory,
        isBusinessError: isMemmyBusinessCode || isLegacyQuotaCode || isMemoryEvolutionQuota,
        message
      };
    }
    return { detail: text, errorCode, errorType, errorCategory,
      isBusinessError: isMemmyBusinessCode || isLegacyQuotaCode };
  } catch {
    return { detail: text, isBusinessError: false };
  }
}

function classifyProviderFailure(
  errorCode: string | undefined,
  errorType: string | undefined,
  businessEnvelope: ProviderBusinessEnvelope | undefined
): ModelErrorCategory | undefined {
  const code = errorCode?.trim().toLowerCase().replace(/[\s_-]/gu, "");
  const type = errorType?.trim().toLowerCase().replace(/[\s_-]/gu, "");
  if (code === "40308" || code === "40309" || code === "insufficientquota" || type === "insufficientquota") {
    return "quota_exhausted";
  }
  // Other categories come only from the Memmy gateway's own numeric codes. OpenAI-style
  // types are not enough: OpenAI answers a bad key or an unknown model with
  // invalid_request_error, and the gateway passes upstream errors through unchanged, so
  // the type alone would hide configuration and input-length failures.
  if (businessEnvelope !== "memmy_account") return undefined;
  if (code === "40100") return "authentication_required";
  if (code === "40101") return "permission_denied";
  if (code === "40300") return "rate_limited";
  if (code !== undefined && /^400\d\d$/u.test(code)) return "invalid_model_request";
  if (code !== undefined && /^500\d\d$/u.test(code)) return "provider_server_error";
  return undefined;
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
