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

export interface LocalDataService {
  reveal(): Promise<LocalDataRevealResponse>;
  export(input: ExportLocalDataInput): Promise<LocalDataExportResponse>;
  clear(input: ClearLocalDataInput): Promise<LocalDataClearResponse>;
}

export interface CreateLocalDataServiceOptions {
  localDataStore: LocalDataStore;
  now?: () => Date;
}

/** Creates create local data service. */
export function createLocalDataService(options: CreateLocalDataServiceOptions): LocalDataService {
  const now = options.now ?? (() => new Date());

  return {
    async reveal() {
      const dataPath = options.localDataStore.getDataPath();
      await options.localDataStore.revealDataPath(dataPath);
      return LocalDataRevealResponseSchema.parse({
        ok: true,
        dataPath
      });
    },

    async export(input) {
      return LocalDataExportResponseSchema.parse(options.localDataStore.exportData(input));
    },

    async clear(_input) {
      const clearedAt = now().toISOString();
      options.localDataStore.clearMemoryDatabase(clearedAt);
      return LocalDataClearResponseSchema.parse({
        ok: true,
        clearedAt
      });
    }
  };
}
