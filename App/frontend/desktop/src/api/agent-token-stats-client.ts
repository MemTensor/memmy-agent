import {
  AgentTokenStatsResponseSchema,
  type AgentTokenStatsResponse,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface AgentTokenStatsClient {
  getStats(): Promise<AgentTokenStatsResponse>;
}

export function createHttpAgentTokenStatsClient(config: RuntimeConfig): AgentTokenStatsClient {
  return {
    async getStats() {
      return requestJson({
        config,
        path: "/api/app/agent-token-stats",
        schema: AgentTokenStatsResponseSchema
      });
    }
  };
}
