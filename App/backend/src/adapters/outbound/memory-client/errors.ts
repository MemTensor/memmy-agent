/** Errors module. */
import type { AgentSourceScanUnavailable } from "@memmy/local-api-contracts";

/** Optional scan metadata must not prevent the rest of Desktop from starting. */
export function memoryScanUnavailable(error: unknown): AgentSourceScanUnavailable | undefined {
  if (error instanceof MemoryLayerError && error.code === "memory_scan_upgrade_required") {
    return { code: "memory_scan_upgrade_required", message: error.message };
  }
  if (error instanceof MemoryLayerNetworkError ||
      (error instanceof MemoryLayerError && (error.status >= 500 || error.status === 401 || error.status === 403))) {
    return { code: "memory_layer_unavailable", message: "Memory scanning is unavailable. Check the Memory service connection and try again." };
  }
  return undefined;
}

/** Implementation of memory layer error. */
export class MemoryLayerError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "MemoryLayerError";
  }
}

/** Implementation of memory layer network error. */
export class MemoryLayerNetworkError extends Error {
  constructor(public readonly cause: unknown) {
    super("memory layer network error");
    this.name = "MemoryLayerNetworkError";
  }
}
