import type { Config } from "../config/schema.js";
import type { MemmyMemoryLayer, MemmyMemoryResolvedConfig } from "./types.js";

const MEMORY_LAYERS = new Set<MemmyMemoryLayer>(["L1", "L2", "L3", "Skill"]);

export function resolveMemmyMemoryConfig(config: Config | Record<string, any> | null | undefined): MemmyMemoryResolvedConfig {
  const raw = (config as any)?.memmyMemory ?? {};
  return {
    enabled: Boolean(raw?.enabled ?? raw?.enable ?? true),
    userId: stringOrUndefined(raw?.userId) ?? "local-user",
    retrievalLayers: memoryLayersOrUndefined(raw?.retrievalLayers),
  };
}

function stringOrUndefined(value: any): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function memoryLayersOrUndefined(value: any): MemmyMemoryLayer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((layer): layer is MemmyMemoryLayer => MEMORY_LAYERS.has(layer)))];
}
