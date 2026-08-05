export type ProviderErrorCategory = "quota_exhausted";

export type ProviderErrorFacts = {
  provider: string | null;
  httpStatus: number | null;
  errorType: string | null;
  errorCode: string | null;
  metadataErrorType: string | null;
  baseRespStatusCode: string | null;
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

function normalizeToken(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value)
    .trim()
    .replace(/[A-Z]/g, (character) => character.toLowerCase());
  return normalized || null;
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
