import type { Config } from "../config/schema.js";
import type { MemmyMemoryLayer, MemmyMemoryResolvedConfig } from "./types.js";

const MEMORY_LAYERS = new Set<MemmyMemoryLayer>(["L1", "L2", "L3", "Skill"]);

export function resolveMemmyMemoryConfig(config: Config | Record<string, any> | null | undefined): MemmyMemoryResolvedConfig {
  const raw = (config as any)?.memmyMemory ?? {};
  return {
    enabled: Boolean(raw?.enabled ?? raw?.enable ?? true),
    userId: "local-user",
    retrievalLayers: memoryLayersOrUndefined(raw?.retrievalLayers),
  };
}

function memoryLayersOrUndefined(value: any): MemmyMemoryLayer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((layer): layer is MemmyMemoryLayer => MEMORY_LAYERS.has(layer)))];
}
