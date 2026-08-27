export type ProviderErrorCategory =
  | "quota_exhausted"
  | "image_input_unsupported"
  | "image_analysis_failed";

export type ProviderErrorFacts = {
  provider: string | null;
  httpStatus: number | null;
  errorType: string | null;
  errorCode: string | null;
  metadataErrorType: string | null;
  baseRespStatusCode: string | null;
};

export type ImageInputErrorFacts = {
  hasImageInput: boolean;
  httpStatus: number | null;
  errorKind: string | null;
  errorType: string | null;
  errorCode: string | null;
  content: string | null;
  errorCategory?: ProviderErrorCategory | null;
};

const OPENAI_QUOTA_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);
const ZHIPU_QUOTA_CODES = new Set([
  "1113",
  "1308",
  "1310",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
]);
const MINIMAX_QUOTA_CODES = new Set(["1008", "2056"]);
const QIANFAN_CODING_PLAN_QUOTA_CODES = new Set([
  "coding_plan_hour_quota_exceeded",
  "coding_plan_week_quota_exceeded",
  "coding_plan_month_quota_exceeded",
]);
const IMAGE_INPUT_UNSUPPORTED_PATTERNS = [
  /only\s+text\s+content\s+type\s+is\s+supported/u,
  /image_url\s+is\s+not\s+supported/u,
  /image\s+content\s+is\s+not\s+supported/u,
  /multimodal\s+(?:input|content)\s+is\s+not\s+supported/u,
  /vision\s+input\s+is\s+not\s+supported/u,
  /does\s+not\s+support\s+(?:image(?:\s+input|s)?|multimodal|vision)\b/u,
  /model\s+does\s+not\s+support\s+image/u,
  /unknown\s+variant\s+image_url\s*,?\s*expected\s+text/u,
  /no\s+endpoints?\s+found\s+that\s+support\s+image\s+input/u,
  /(?:input_image|image_url).{0,120}(?:unsupported|not\s+allowed|expected\s+text(?:\s+content)?\s+only)/u,
];
const ABORT_ERROR_TOKENS = ["abort", "cancelled", "canceled"];

function normalizeToken(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value)
    .trim()
    .replace(/[A-Z]/g, (character) => character.toLowerCase());
  return normalized || null;
}

function normalizeImageErrorText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[`'"]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function classifyImageInputUnsupported(
  facts: ImageInputErrorFacts,
): ProviderErrorCategory | null {
  if (!facts.hasImageInput || facts.errorCategory === "quota_exhausted") return null;
  const status = facts.httpStatus;
  if (status != null && (status < 400 || status > 499)) return null;
  if (status != null && [408, 409, 429].includes(status)) return null;

  const errorTokens = [facts.errorKind, facts.errorType, facts.errorCode]
    .map(normalizeImageErrorText)
    .filter(Boolean);
  if (errorTokens.some((token) => ABORT_ERROR_TOKENS.some((marker) => token.includes(marker)))) {
    return null;
  }

  const text = normalizeImageErrorText([
    facts.errorKind,
    facts.errorType,
    facts.errorCode,
    facts.content,
  ].filter(Boolean).join("\n"));
  return IMAGE_INPUT_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text))
    ? "image_input_unsupported"
    : null;
}

export function classifyQuotaExhaustion(
  facts: ProviderErrorFacts,
): ProviderErrorCategory | null {
  const provider = normalizeToken(facts.provider);
  const errorType = normalizeToken(facts.errorType);
  const errorCode = normalizeToken(facts.errorCode);
  const metadataErrorType = normalizeToken(facts.metadataErrorType);
  const baseRespStatusCode = normalizeToken(facts.baseRespStatusCode);

  switch (provider) {
    case "memmy_account":
      return errorCode === "40309" ? "quota_exhausted" : null;
    case "openai":
      if (errorCode && OPENAI_QUOTA_CODES.has(errorCode)) return "quota_exhausted";
      return errorCode == null && errorType === "insufficient_quota"
        ? "quota_exhausted"
        : null;
    case "openrouter":
      return facts.httpStatus === 402 || metadataErrorType === "payment_required"
        ? "quota_exhausted"
        : null;
    case "deepseek":
    case "stepfun":
      return facts.httpStatus === 402 ? "quota_exhausted" : null;
    case "dashscope":
      return errorCode === "allocationquota.freetieronly" ? "quota_exhausted" : null;
    case "zhipu":
      return errorCode && ZHIPU_QUOTA_CODES.has(errorCode) ? "quota_exhausted" : null;
    case "moonshot":
      return errorType === "exceeded_current_quota_error" ? "quota_exhausted" : null;
    case "minimax":
    case "minimax_anthropic":
      return baseRespStatusCode && MINIMAX_QUOTA_CODES.has(baseRespStatusCode)
        ? "quota_exhausted"
        : null;
    case "longcat":
      return facts.httpStatus === 402 || errorCode === "insufficient_quota"
        ? "quota_exhausted"
        : null;
    case "qianfan":
      return errorCode === "account_overdue" ||
        (errorCode != null && QIANFAN_CODING_PLAN_QUOTA_CODES.has(errorCode))
        ? "quota_exhausted"
        : null;
    default:
      return null;
  }
}
