/** Memory detail service module. */
import type {
  AddMemoryInput,
  AddMemoryOutput,
  GetMemoryOutput,
  MemoryHistoryOutput,
  RestoreMemoryInput,
  RestoreMemoryOutput,
  DeleteMemoryInput,
  DeleteMemoryOutput
} from "@memmy/local-api-contracts";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { RuntimeContext } from "./runtime-context.js";

export interface MemoryDetailService {
  add(input: AddMemoryInput, ctx: RuntimeContext): Promise<AddMemoryOutput>;
  getById(id: string, ctx: RuntimeContext): Promise<GetMemoryOutput>;
  history(id: string, ctx: RuntimeContext): Promise<MemoryHistoryOutput>;
  restore(id: string, targetVersion: number, input: RestoreMemoryInput, ctx: RuntimeContext): Promise<RestoreMemoryOutput>;
  delete(id: string, input: DeleteMemoryInput, ctx: RuntimeContext): Promise<DeleteMemoryOutput>;
}

export function createMemoryDetailService(deps: {
  memoryClient: MemoryClient;
}): MemoryDetailService {
  return {
    async add(input, _ctx) {
      return deps.memoryClient.addMemory(input);
    },

    async getById(id, _ctx) {
      return deps.memoryClient.getMemory({ memoryId: id });
    },

    async history(id, _ctx) {
      return deps.memoryClient.memoryHistory(id);
    },

    async restore(id, targetVersion, input, _ctx) {
      return deps.memoryClient.restoreMemory({ ...input, memoryId: id, targetVersion });
    },

    async delete(id, input, _ctx) {
      return deps.memoryClient.deleteMemory({ ...input, memoryId: id });
    }
  };
}
