import { api } from "./client.js";
import type { EmbeddingMaintenanceRunResult } from "../../../src/service/embedding/embedding-maintenance.js";
export type { EmbeddingMaintenanceStats, EmbeddingMaintenanceRunResult } from "../../../src/service/embedding/embedding-maintenance.js";

/** One POST starts a durable run; polling must never enqueue the next batch again. */
export async function followEmbeddingMaintenance(
  initial: EmbeddingMaintenanceRunResult,
  onProgress: (result: EmbeddingMaintenanceRunResult) => void,
  signal: AbortSignal
): Promise<void> {
  let result = initial;
  for (;;) {
    if (signal.aborted) return;
    onProgress(result);
    if (result.done || result.error) return;
    await pause(signal);
    if (signal.aborted) return;
    result = await api.get<EmbeddingMaintenanceRunResult>(
      `/api/v1/embeddings/rebuild?runId=${encodeURIComponent(result.runId)}`, { signal }
    );
    if (!result) throw new Error("Embedding maintenance run is no longer available");
  }
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, 1000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
