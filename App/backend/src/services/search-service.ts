/** Search service module. */
import type { SearchInput, SearchOutput } from "@memmy/local-api-contracts";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { RuntimeContext } from "./runtime-context.js";

export interface SearchService {
  search(input: SearchInput, ctx: RuntimeContext): Promise<SearchOutput>;
}

export function createSearchService(deps: {
  memoryClient: MemoryClient;
}): SearchService {
  return {
    async search(input, _ctx) {
      return deps.memoryClient.search(input);
    }
  };
}
