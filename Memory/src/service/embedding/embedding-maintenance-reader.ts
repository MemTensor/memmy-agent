import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createMemoryLogger, memoryErrorFields } from "../../logging/logger.js";
import type { Repositories } from "../../storage/repositories.js";
import {
  readEmbeddingMaintenanceStats,
  readEmbeddingMaintenanceTargets,
  readEmbeddingUpgradeCandidates,
  type EmbeddingMaintenanceReaderStatsRequest,
  type EmbeddingMaintenanceReaderTargetsRequest,
  type EmbeddingMaintenanceStatsSnapshot,
  type EmbeddingMaintenanceTargetsSnapshot
} from "./embedding-maintenance-reader-query.js";
import type { EmbeddingMaintenanceEntry } from "../../storage/sqlite-vec-store.js";

type ReaderOperation =
  | { type: "stats"; request: EmbeddingMaintenanceReaderStatsRequest }
  | { type: "targets"; request: EmbeddingMaintenanceReaderTargetsRequest }
  | { type: "upgrade-candidates" };

const WORKER_RESTART_BACKOFF_MS = 30_000;
const readerLogger = createMemoryLogger("embedding-maintenance-reader");

interface ReaderRequestMessage {
  type: "request";
  id: number;
  operation: ReaderOperation;
}

interface ReaderResponseMessage {
  type: "response";
  id: number;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  operation: ReaderOperation["type"];
  startedAt: number;
}

export interface EmbeddingMaintenanceReaderOptions {
  repos: Repositories;
  sqlitePath?: string;
}

/**
 * Owns the one read-only execution lane used by embedding maintenance. Compiled
 * file-backed services always use a Worker. Source runners and in-memory tests
 * use the same query implementation inline because Node cannot execute their
 * TypeScript module URL and an in-memory SQLite database cannot be shared.
 */
export class EmbeddingMaintenanceReader {
  private readonly workerBacked: boolean;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<number, PendingRequest>();
  private worker?: Worker;
  private nextId = 1;
  private closing = false;
  private fatalError?: Error;
  private fatalAt = 0;
  private stopped?: Promise<void>;

  constructor(private readonly options: EmbeddingMaintenanceReaderOptions) {
    const extension = extname(fileURLToPath(import.meta.url));
    this.workerBacked = Boolean(options.sqlitePath && options.sqlitePath !== ":memory:" && extension === ".js");
  }

  readStats(request: EmbeddingMaintenanceReaderStatsRequest): Promise<EmbeddingMaintenanceStatsSnapshot> {
    return this.coalesce({ type: "stats", request }) as Promise<EmbeddingMaintenanceStatsSnapshot>;
  }

  readTargets(request: EmbeddingMaintenanceReaderTargetsRequest): Promise<EmbeddingMaintenanceTargetsSnapshot> {
    return this.coalesce({ type: "targets", request }) as Promise<EmbeddingMaintenanceTargetsSnapshot>;
  }

  readUpgradeCandidates(): Promise<EmbeddingMaintenanceEntry[]> {
    return this.coalesce({ type: "upgrade-candidates" }) as Promise<EmbeddingMaintenanceEntry[]>;
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.closing = true;
    const worker = this.worker;
    if (!worker) return this.stopped = Promise.resolve();
    this.stopped = new Promise<void>((resolve) => {
      if (worker.threadId === -1) {
        resolve();
        return;
      }
      worker.once("exit", () => resolve());
      worker.postMessage({ type: "close" });
    });
    return this.stopped;
  }

  private coalesce(operation: ReaderOperation): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Embedding maintenance reader is stopping"));
    if (this.fatalError) {
      if (Date.now() - this.fatalAt < WORKER_RESTART_BACKOFF_MS) return Promise.reject(this.fatalError);
      this.fatalError = undefined;
      this.fatalAt = 0;
    }
    const key = JSON.stringify(operation);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.dispatch(operation).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private dispatch(operation: ReaderOperation): Promise<unknown> {
    if (!this.workerBacked) {
      return new Promise<unknown>((resolve, reject) => {
        setImmediate(() => {
          try {
            resolve(executeInline(this.options.repos, operation));
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, operation: operation.type, startedAt: performance.now() });
      worker.postMessage({ type: "request", id, operation } satisfies ReaderRequestMessage);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./embedding-maintenance-reader-worker.js", import.meta.url), {
      workerData: { sqlitePath: this.options.sqlitePath }
    });
    worker.on("message", (message: ReaderResponseMessage) => {
      if (message.type !== "response") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      const durationMs = performance.now() - pending.startedAt;
      if (message.error) {
        readerLogger.warn("read.failed", { operation: pending.operation, durationMs, errorMessage: message.error });
        pending.reject(new Error(message.error));
      } else {
        readerLogger.debug("read.completed", { operation: pending.operation, durationMs });
        pending.resolve(message.result);
      }
    });
    worker.once("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", (code) => {
      this.worker = undefined;
      if (!this.closing && !this.fatalError) {
        this.fail(new Error(`Embedding maintenance reader exited unexpectedly (${code})`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    readerLogger.error("worker.failed", memoryErrorFields(error));
    this.fatalError = error;
    this.fatalAt = Date.now();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function executeInline(repos: Repositories, operation: ReaderOperation): unknown {
  if (operation.type === "stats") return readEmbeddingMaintenanceStats(repos, operation.request);
  if (operation.type === "targets") return readEmbeddingMaintenanceTargets(repos, operation.request);
  return readEmbeddingUpgradeCandidates(repos);
}
