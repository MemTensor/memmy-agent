import { AppBootstrapResponseSchema, type AppBootstrapResponse, type RuntimeConfig } from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface BootstrapClient {
  getBootstrap(): Promise<AppBootstrapResponse>;
}

export function createHttpBootstrapClient(config: RuntimeConfig): BootstrapClient {
  return {
    async getBootstrap() {
      return requestJson({
        config,
        path: "/api/app/bootstrap",
        schema: AppBootstrapResponseSchema
      });
    }
  };
}
