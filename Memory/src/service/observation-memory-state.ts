import type { MemoryRow } from "../types.js";
import { isRecord } from "../utils/json.js";

export const OBSERVATION_MEMORY_SCHEMA_VERSION = 1;
export const OBSERVATION_SUMMARY_MODEL_UNCONFIGURED = {
  retryAction: "open_settings" as const,
  errorCode: "summary_model_unconfigured",
  errorMessage: "Configure a summary model to process Computer History into useful memory."
};

/** Passive observations keep their provenance even after semantic processing. */
export function isObservationMemory(memory: MemoryRow): boolean {
  return memory.properties.internal_info.memory_kind === "observed_activity";
}

export function observationMemoryState(memory: MemoryRow): Record<string, unknown> | undefined {
  const state = memory.properties.internal_info.observation_memory;
  return isRecord(state) ? state : undefined;
}

export function isObservationMemoryProcessed(memory: MemoryRow): boolean {
  const state = observationMemoryState(memory);
  return isObservationMemory(memory) && state?.schema_version === OBSERVATION_MEMORY_SCHEMA_VERSION
    && state.status === "processed" && memory.status === "activated";
}

export function observationJobPayload(memory: MemoryRow): Record<string, unknown> {
  const state = observationMemoryState(memory);
  return { contentHash: memory.contentHash, observationGeneration: state?.generation };
}
