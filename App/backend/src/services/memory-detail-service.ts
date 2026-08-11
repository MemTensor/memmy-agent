/** Memory detail service module. */
import type {
  AddMemoryInput,
  AddMemoryOutput,
  GetMemoryOutput,
  DeleteMemoryInput,
  DeleteMemoryOutput
} from "@memmy/local-api-contracts";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { RuntimeContext } from "./runtime-context.js";

export interface MemoryDetailService {
  add(input: AddMemoryInput, ctx: RuntimeContext): Promise<AddMemoryOutput>;
  getById(id: string, ctx: RuntimeContext): Promise<GetMemoryOutput>;
  delete(id: string, input: DeleteMemoryInput, ctx: RuntimeContext): Promise<DeleteMemoryOutput>;
}

export function createMemoryDetailService(deps: {
  memoryClient: MemoryClient;
}): MemoryDetailService {
  return {
    async add(input, ctx) {
      return deps.memoryClient.addMemory(input, ctx);
    },

    async getById(id, ctx) {
      return deps.memoryClient.getMemory({ memoryId: id }, ctx);
    },

    async delete(id, input, ctx) {
      return deps.memoryClient.deleteMemory({ ...input, memoryId: id }, ctx);
    }
  };
}
