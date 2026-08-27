/** Source registry module. */
import type { SourceAdapter } from "./types.js";

/** Contract for source registry. */
export interface SourceRegistry {
  list(): readonly SourceAdapter[];
  get(sourceId: string): SourceAdapter | undefined;
  require(sourceId: string): SourceAdapter;
}

/** Creates create source registry. */
export function createSourceRegistry(adapters: readonly SourceAdapter[]): SourceRegistry {
  const adapterMap = new Map(adapters.map((adapter) => [adapter.descriptor.sourceId, adapter]));

  return Object.freeze({
    list() {
      return [...adapterMap.values()];
    },

    get(sourceId: string) {
      return adapterMap.get(sourceId);
    },

    require(sourceId: string) {
      const adapter = adapterMap.get(sourceId);
      if (!adapter) {
        throw new Error(`Unknown agent source: ${sourceId}`);
      }

      return adapter;
    }
  });
}
