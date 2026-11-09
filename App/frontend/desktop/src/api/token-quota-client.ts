import {
  TokenQuotaApplyResultSchema,
  TokenQuotaEligibilitySchema,
  type RuntimeConfig,
  type RequestTokenQuotaInput,
  type TokenQuotaApplyResult,
  type TokenQuotaEligibility
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface TokenQuotaClient {
  /** Gets token quota eligibility for the current account. */
  getEligibility(): Promise<TokenQuotaEligibility>;
  /** Submits a reason and creates a token quota request. */
  requestQuota(input: string | RequestTokenQuotaInput): Promise<TokenQuotaApplyResult>;
}

/** Creates a token quota client backed by the local API. */
export function createHttpTokenQuotaClient(
  config: RuntimeConfig,
  request: typeof requestJson = requestJson
): TokenQuotaClient {
  return {
    async getEligibility() {
      return request({
        config,
        path: "/api/token-quota/eligibility",
        schema: TokenQuotaEligibilitySchema
      });
    },

    async requestQuota(input: string | RequestTokenQuotaInput) {
      return request({
        config,
        path: "/api/token-quota/request",
        body: typeof input === "string" ? { reason: input } : input,
        schema: TokenQuotaApplyResultSchema
      });
    }
  };
}
