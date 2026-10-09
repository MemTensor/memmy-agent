import {
  ByokTokenUsageSummarySchema,
  MemoryTokenBudgetDtoSchema,
  type ByokTokenUsageSummary,
  type MemoryTokenBudgetDto,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface ByokTokenUsageClient {
  getSummary(): Promise<ByokTokenUsageSummary>;
  getMemoryBudget(): Promise<MemoryTokenBudgetDto>;
}

export function createHttpByokTokenUsageClient(config: RuntimeConfig): ByokTokenUsageClient {
  return {
    async getSummary() {
      return requestJson({
        config,
        path: "/api/app/byok-token-usage/summary",
        schema: ByokTokenUsageSummarySchema
      });
    },
    async getMemoryBudget() {
      return requestJson({
        config,
        path: "/api/app/byok-token-usage/memory-budget",
        schema: MemoryTokenBudgetDtoSchema
      });
    }
  };
}
