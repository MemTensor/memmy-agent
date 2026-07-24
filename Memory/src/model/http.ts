import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";

const logger = createMemoryLogger("model-http");

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
        if (!response.ok) {
          throw new Error(formatHttpFailure(input.provider, response, text));
        }
        return parseJsonResponse<T>(input.provider, response, text);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (attempt < input.maxRetries) {
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
      } else {
        logger.error("request.failed", {
          provider: input.provider,
          operation: input.operation,
          model: input.model,
          endpoint: safeEndpoint(input.url),
          attempt: attempt + 1,
          maxAttempts: input.maxRetries + 1,
          ...memoryErrorFields(error)
        });
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { message?: unknown };
      message?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
      return parsed.error.message.trim() || undefined;
    }
    return typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : undefined;
  } catch {
    return undefined;
  }
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
