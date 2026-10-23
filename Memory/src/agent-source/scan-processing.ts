import { setTimeout as waitForScanProgress } from "node:timers/promises";
import type { MemoryService } from "../service/memory-service.js";
import type { MemoryAgentSourceScanStore } from "./scan-store.js";
import type { ScanProgress } from "./adapters/types.js";

const IMPORT_IDLE_TIMEOUT_MS = 2_400_000;

export async function waitForImportProcessing(
  service: MemoryService, store: MemoryAgentSourceScanStore, sourceId: string,
  signal: AbortSignal, waitIfPaused: () => Promise<void>, onProgress: (progress: ScanProgress) => void,
  trackWorker: (worker: Promise<unknown>) => void
): Promise<string[]> {
  const failures: string[] = [];
  let current = 0;
  for (const ids of store.importMemoryPages(sourceId)) {
    service.enqueuePendingImportSummaries(1000, ids);
    const pending = new Set(ids);
    let lastProgressAt = Date.now();
    const waitUntilResumed = async () => {
      const before = Date.now();
      await waitIfPaused();
      // A user's pause is not evidence that the worker has stalled.
      lastProgressAt += Math.max(0, Date.now() - before);
      signal.throwIfAborted();
    };
    let worker: Promise<{ error?: unknown }> | undefined;
    let workerFinished = false;
    while (pending.size) {
      await waitUntilResumed();
      if (!worker || workerFinished) {
        workerFinished = false;
        worker = service.runWorkerOnce(1, { targetMemoryIds: [...pending], priorityCohortOnly: true })
          .then(() => ({}), (error: unknown) => ({ error }))
          .finally(() => { workerFinished = true; });
        trackWorker(worker);
      }
      const outcome = await Promise.race([worker, waitForScanProgress(250, {}, { signal })]);
      if ("error" in outcome) throw outcome.error;
      await waitUntilResumed();
      const previousPending = pending.size;
      const states = new Map(service.memoryProcessingStatus([...pending]).items.map((item) => [item.memoryId, item]));
      for (const id of pending) {
        const item = states.get(id);
        if (item && ["summary_pending", "summarizing", "embedding_pending", "embedding"].includes(item.state)) continue;
        if (!item || item.state === "failed") failures.push(item?.errorMessage || `Processing state unavailable for ${id}`);
        pending.delete(id);
        current += 1;
      }
      if (pending.size < previousPending) lastProgressAt = Date.now();
      onProgress({ sourceId, phase: "summarize", current, total: store.importMemoryCount(sourceId), message: "Summarizing and indexing imported memories" });
      if (pending.size === 0) break;
      if (Date.now() - lastProgressAt >= IMPORT_IDLE_TIMEOUT_MS) {
        throw new Error("Timed out waiting for imported memories to finish indexing");
      }
      if (workerFinished) await waitForScanProgress(250, undefined, { signal });
    }
  }
  return failures;
}
