import {
  ByokTokenUsageSummarySchema,
  type ByokTokenUsageSummary,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface ByokTokenUsageClient {
  getSummary(): Promise<ByokTokenUsageSummary>;
}

export function createHttpByokTokenUsageClient(config: RuntimeConfig): ByokTokenUsageClient {
  return {
    async getSummary() {
      return requestJson({
        config,
        path: "/api/app/byok-token-usage/summary",
        schema: ByokTokenUsageSummarySchema
      });
    }
  };
}
