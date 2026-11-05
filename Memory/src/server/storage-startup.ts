import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MemoryDb, type MemoryDbStartupStage } from "../storage/db.js";

interface StorageStartupMessage {
  type: "stage" | "ready" | "failed";
  stage?: MemoryDbStartupStage;
  error?: string;
}

export interface PrepareSqliteStorageOptions {
  sqlitePath: string;
  signal?: AbortSignal;
  onStage?: (stage: MemoryDbStartupStage) => void;
}

/**
 * Prepare SQLite away from the HTTP event loop. Production runs compiled JavaScript
 * in a Worker; source-only test/dev runners fall back to the same implementation
 * after yielding because Node cannot execute their TypeScript module URL directly.
 */
export async function prepareSqliteStorage(options: PrepareSqliteStorageOptions): Promise<void> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Memory startup was cancelled");
  const extension = extname(fileURLToPath(import.meta.url));
  if (extension !== ".js") {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const database = new MemoryDb({ path: options.sqlitePath, onStartupStage: options.onStage });
    database.close();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./storage-startup-worker.js", import.meta.url), {
      workerData: { sqlitePath: options.sqlitePath }
    });
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => {
      void worker.terminate();
      finish(options.signal?.reason ?? new Error("Memory startup was cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    worker.on("message", (message: StorageStartupMessage) => {
      if (message.type === "stage" && message.stage) options.onStage?.(message.stage);
      else if (message.type === "ready") finish();
      else if (message.type === "failed") finish(new Error(message.error || "Memory database preparation failed"));
    });
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`Memory database preparation worker exited (${code})`));
    });
  });
}
