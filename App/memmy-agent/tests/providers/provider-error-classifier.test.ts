import { describe, expect, it } from "vitest";
import {
  classifyImageInputUnsupported,
  classifyQuotaExhaustion,
  type ImageInputErrorFacts,
  type ProviderErrorFacts,
} from "../../src/providers/provider-error-classifier.js";

function facts(overrides: Partial<ProviderErrorFacts>): ProviderErrorFacts {
  return {
    provider: null,
    httpStatus: null,
    errorType: null,
    errorCode: null,
    metadataErrorType: null,
    baseRespStatusCode: null,
    ...overrides,
  };
}

function imageFacts(overrides: Partial<ImageInputErrorFacts> = {}): ImageInputErrorFacts {
  return {
    hasImageInput: true,
    httpStatus: 400,
    errorKind: null,
    errorType: null,
    errorCode: null,
    content: null,
    ...overrides,
  };
}

describe("classifyQuotaExhaustion", () => {
  it.each([
    facts({ provider: "memmy_account", errorCode: "40309" }),
    facts({ provider: "openai", errorCode: "credit_balance_exhausted" }),
    facts({ provider: "openai", errorCode: "organization_spend_limit_exceeded" }),
    facts({ provider: "openai", errorCode: "project_spend_limit_exceeded" }),
    facts({ provider: "openai", errorCode: "organization_usage_limit_exceeded" }),
    facts({ provider: "openai", errorCode: "insufficient_quota" }),
    facts({ provider: "openai", errorType: "insufficient_quota" }),
    facts({ provider: "openrouter", metadataErrorType: "payment_required" }),
    facts({ provider: "openrouter", httpStatus: 402 }),
    facts({ provider: "deepseek", httpStatus: 402 }),
    facts({ provider: "dashscope", errorCode: "AllocationQuota.FreeTierOnly" }),
    ...["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"].map(
      (errorCode) => facts({ provider: "zhipu", errorCode }),
    ),
    facts({ provider: "moonshot", errorType: "exceeded_current_quota_error" }),
    facts({ provider: "minimax", baseRespStatusCode: "1008" }),
    facts({ provider: "minimax", baseRespStatusCode: "2056" }),
    facts({ provider: "minimax_anthropic", baseRespStatusCode: "1008" }),
    facts({ provider: "minimax_anthropic", baseRespStatusCode: "2056" }),
    facts({ provider: "stepfun", httpStatus: 402 }),
    facts({ provider: "longcat", httpStatus: 402 }),
    facts({ provider: "longcat", errorCode: "insufficient_quota" }),
    facts({ provider: "qianfan", errorCode: "account_overdue" }),
    facts({ provider: "qianfan", errorCode: "coding_plan_hour_quota_exceeded" }),
    facts({ provider: "qianfan", errorCode: "coding_plan_week_quota_exceeded" }),
    facts({ provider: "qianfan", errorCode: "coding_plan_month_quota_exceeded" }),
  ])("classifies an exact provider-scoped quota signature", (input) => {
    expect(classifyQuotaExhaustion(input)).toBe("quota_exhausted");
  });

  it.each([
    facts({ provider: "custom", errorCode: "40309" }),
    facts({ provider: "openai", errorCode: "prefix_insufficient_quota_suffix" }),
    facts({ provider: "openai", errorType: "insufficient_quota", errorCode: "rate_limit_exceeded" }),
    facts({ provider: "openai", httpStatus: 429, errorCode: "rate_limit_exceeded" }),
    facts({ provider: "openrouter", httpStatus: 429, errorCode: "insufficient_quota" }),
    facts({ provider: "dashscope", errorCode: "insufficient_quota" }),
    facts({ provider: "zhipu", errorCode: "1302" }),
    facts({ provider: "zhipu", errorCode: "1305" }),
    facts({ provider: "zhipu", errorCode: "1309" }),
    facts({ provider: "moonshot", errorType: "rate_limit_reached_error" }),
    facts({ provider: "moonshot", errorType: "engine_overloaded_error" }),
    facts({ provider: "qianfan", errorCode: "rpm_rate_limit_exceeded" }),
    facts({ provider: "qianfan", errorCode: "tpm_rate_limit_exceeded" }),
    facts({ provider: "qianfan", errorCode: "coding_plan_rate_limit_exceeded" }),
    facts({ provider: "qianfan", errorCode: "coding_plan_cluster_rate_limited" }),
    facts({ provider: "qianfan", errorCode: "coding_plan_subscription_expired" }),
    facts({ provider: "anthropic", httpStatus: 402, errorType: "billing_error" }),
    facts({ provider: "gemini", httpStatus: 429, errorType: "RESOURCE_EXHAUSTED" }),
    facts({ provider: "azure_openai", httpStatus: 429, errorCode: "insufficient_quota" }),
    facts({ provider: "bedrock", errorType: "ServiceQuotaExceededException" }),
    facts({ provider: "siliconflow", httpStatus: 403 }),
    facts({ provider: "novita", httpStatus: 403 }),
    facts({ provider: "groq", httpStatus: 429 }),
    facts({ provider: "custom", httpStatus: 402 }),
  ])("does not classify ambiguous or cross-provider signatures", (input) => {
    expect(classifyQuotaExhaustion(input)).toBeNull();
  });

  it("normalizes only token formatting needed for exact matching", () => {
    expect(
      classifyQuotaExhaustion(
        facts({ provider: " OPENAI ", errorCode: " CREDIT_BALANCE_EXHAUSTED " }),
      ),
    ).toBe("quota_exhausted");
  });

  it("ignores natural-language quota text outside the structured facts contract", () => {
    const input = {
      ...facts({ provider: "custom" }),
      message: "quota exhausted; balance and credit unavailable",
      content: "额度已用完",
    } as ProviderErrorFacts;

    expect(classifyQuotaExhaustion(input)).toBeNull();
  });
});

describe("classifyImageInputUnsupported", () => {
  it.each([
    "Only text content type is supported",
    "`image_url` is not supported",
    "Image content is not supported",
    "Multimodal input is not supported",
    "Vision input is not supported",
    "This model does not support images",
    "Model does not support image input",
    "unknown variant 'image_url', expected 'text'",
    "No endpoints found that support image input",
    "input_image is not allowed; expected text content only",
  ])("classifies explicit image rejection %j", (content) => {
    expect(classifyImageInputUnsupported(imageFacts({ content }))).toBe("image_input_unsupported");
  });

  it("accepts an explicit rejection without an HTTP status", () => {
    expect(classifyImageInputUnsupported(imageFacts({
      httpStatus: null,
      errorCode: "IMAGE_URL_UNSUPPORTED",
    }))).toBe("image_input_unsupported");
  });

  it.each([
    imageFacts({ hasImageInput: false, content: "image_url is not supported" }),
    imageFacts({ httpStatus: 200, content: "image_url is not supported" }),
    imageFacts({ httpStatus: 401, content: "unauthorized" }),
    imageFacts({ httpStatus: 408, content: "image_url is not supported" }),
    imageFacts({ httpStatus: 409, content: "image_url is not supported" }),
    imageFacts({ httpStatus: 429, content: "image_url is not supported" }),
    imageFacts({ httpStatus: 500, content: "image_url is not supported" }),
    imageFacts({ errorKind: "aborted", content: "image_url is not supported" }),
    imageFacts({ errorCategory: "quota_exhausted", content: "image_url is not supported" }),
    imageFacts({ content: "400 invalid_request: bad request" }),
    imageFacts({ content: "invalid image_url: malformed base64 data" }),
    imageFacts({ content: "unsupported image MIME type image/tiff" }),
    imageFacts({ content: "image dimensions exceed the maximum size" }),
  ])("does not classify ambiguous, transient, quota, or invalid-image errors", (input) => {
    expect(classifyImageInputUnsupported(input)).toBeNull();
  });
});
