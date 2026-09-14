/** Local data service module. */
import {
  LocalDataClearResponseSchema,
  LocalDataExportResponseSchema,
  LocalDataRevealResponseSchema,
  type ClearLocalDataInput,
  type LocalDataClearResponse,
  type ExportLocalDataInput,
  type LocalDataExportResponse,
  type LocalDataRevealResponse
} from "@memmy/local-api-contracts";
import type { LocalDataStore } from "../infrastructure/app-state-store/local-data-store.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";

export interface LocalDataService {
  getPath(): Promise<LocalDataRevealResponse>;
  reveal(): Promise<LocalDataRevealResponse>;
  export(input: ExportLocalDataInput): Promise<LocalDataExportResponse>;
  clear(input: ClearLocalDataInput): Promise<LocalDataClearResponse>;
}

export interface CreateLocalDataServiceOptions {
  localDataStore: LocalDataStore;
  memoryClient: MemoryClient;
}

/** Creates create local data service. */
export function createLocalDataService(options: CreateLocalDataServiceOptions): LocalDataService {
  const getPathResponse = (): LocalDataRevealResponse => LocalDataRevealResponseSchema.parse({
    ok: true,
    dataPath: options.localDataStore.getDataPath()
  });

  return {
    async getPath() {
      return getPathResponse();
    },

    async reveal() {
      const response = getPathResponse();
      await options.localDataStore.revealDataPath(response.dataPath);
      return response;
    },

    async export(input) {
      if (!options.memoryClient.exportBundle) throw new Error("Memory export API is unavailable");
      const bundle = await options.memoryClient.exportBundle();
      return LocalDataExportResponseSchema.parse(options.localDataStore.exportData(input, bundle));
    },

    async clear(_input) {
      if (!options.memoryClient.clearAllData) throw new Error("Memory clear API is unavailable");
      const result = await options.memoryClient.clearAllData();
      options.localDataStore.clearImportState();
      return LocalDataClearResponseSchema.parse({
        ok: true,
        clearedAt: result.clearedAt
      });
    }
  };
}
