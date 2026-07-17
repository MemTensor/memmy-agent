import {
  ClearLocalDataInputSchema,
  ExportLocalDataInputSchema,
  LocalDataClearResponseSchema,
  LocalDataExportResponseSchema,
  LocalDataRevealResponseSchema,
  type ClearLocalDataInput,
  type ExportLocalDataInput,
  type LocalDataClearResponse,
  type LocalDataExportResponse,
  type LocalDataRevealResponse,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface LocalDataClient {
  reveal(): Promise<LocalDataRevealResponse>;
  export(input: ExportLocalDataInput): Promise<LocalDataExportResponse>;
  clear(input: ClearLocalDataInput): Promise<LocalDataClearResponse>;
}

export function createHttpLocalDataClient(config: RuntimeConfig): LocalDataClient {
  return {
    async reveal() {
      return requestJson({
        config,
        path: "/api/local-data/reveal",
        schema: LocalDataRevealResponseSchema,
        body: {}
      });
    },

    async export(input) {
      return requestJson({
        config,
        path: "/api/local-data/export",
        schema: LocalDataExportResponseSchema,
        body: ExportLocalDataInputSchema.parse(input)
      });
    },

    async clear(input) {
      return requestJson({
        config,
        path: "/api/local-data",
        schema: LocalDataClearResponseSchema,
        init: { method: "DELETE" },
        body: ClearLocalDataInputSchema.parse(input)
      });
    }
  };
}
