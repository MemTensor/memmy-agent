import type { JsonRecord, NormalizedByokTokenUsage } from "./types.js";

export function normalizeByokTokenUsage(
  usage: Record<string, unknown> | null | undefined,
): NormalizedByokTokenUsage | null {
  const rawUsage = isRecord(usage) ? { ...usage } : {};
  const inputTokens = nonNegativeInteger(rawUsage.prompt_tokens);
  const outputTokens = nonNegativeInteger(rawUsage.completion_tokens);
  const totalTokens = hasPositiveNumericValue(rawUsage.total_tokens)
    ? nonNegativeInteger(rawUsage.total_tokens)
    : inputTokens + outputTokens;
  const cachedInputTokens = hasPositiveNumericValue(rawUsage.cached_tokens)
    ? nonNegativeInteger(rawUsage.cached_tokens)
    : nonNegativeInteger(rawUsage.cache_read_input_tokens);
  const cacheCreationInputTokens = nonNegativeInteger(rawUsage.cache_creation_input_tokens);

  if (inputTokens + outputTokens + totalTokens + cachedInputTokens + cacheCreationInputTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    rawUsage,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasPositiveNumericValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Number(trimmed)) && Number(trimmed) > 0;
}

function nonNegativeInteger(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.trunc(numeric);
}
