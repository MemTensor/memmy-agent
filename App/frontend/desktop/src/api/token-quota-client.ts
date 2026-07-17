import {
  TokenQuotaApplyResultSchema,
  type RuntimeConfig,
  type TokenQuotaApplyResult
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface TokenQuotaClient {
  requestQuota(reason: string): Promise<TokenQuotaApplyResult>;
}

export function createHttpTokenQuotaClient(
  config: RuntimeConfig,
  request: typeof requestJson = requestJson
): TokenQuotaClient {
  return {
    async requestQuota(reason: string) {
      return request({
        config,
        path: "/api/token-quota/request",
        body: { reason },
        schema: TokenQuotaApplyResultSchema
      });
    }
  };
}
