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

/**
 * Whether a read may be thrown away when the service is stopping.
 *
 * `discardable-stats` only feeds a panel; dropping it costs a recomputation.
 * `business-required` decides whether a maintenance run is finished, so a waiter
 * must either receive a result or be told explicitly that it was cancelled.
 */
export type ReaderCancelKind = "discardable-stats" | "business-required";

const WORKER_RESTART_BACKOFF_MS = 30_000;
/** A panel read may be dropped; it must not hold the lane for long. */
const STATS_TIMEOUT_MS = 30_000;
/** Progress decides whether a run finished, so it gets longer than a display read. */
const BUSINESS_TIMEOUT_MS = 60_000;
/** How long stop() lets in-flight business reads finish before forcing the worker out. */
const STOP_GRACE_MS = 5_000;
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

interface QueuedRequest {
  id: number;
  operation: ReaderOperation;
  cancelKind: ReaderCancelKind;
  /** Higher runs first; progress must not queue behind panel statistics. */
  priority: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  startedAt: number;
  timer?: NodeJS.Timeout;
  settled: boolean;
}

export class EmbeddingMaintenanceReaderCancelled extends Error {
  constructor(readonly cancelKind: ReaderCancelKind) {
    super(`Embedding maintenance ${cancelKind} read was cancelled`);
    this.name = "EmbeddingMaintenanceReaderCancelled";
  }
}

export interface EmbeddingMaintenanceReaderOptions {
  repos: Repositories;
  sqlitePath?: string;
  /** Overridable only so tests can exercise timeouts without waiting 15s. */
  statsTimeoutMs?: number;
  businessTimeoutMs?: number;
  /** How long stop() waits for an in-flight business read before terminating. */
  stopGraceMs?: number;
  /** Test seam for a deterministic worker that speaks the production protocol. */
  workerUrl?: URL;
}

/**
 * Owns the one read-only execution lane used by embedding maintenance. Compiled
 * file-backed services always use a Worker. Source runners and in-memory tests
 * use the same query implementation inline because Node cannot execute their
 * TypeScript module URL and an in-memory SQLite database cannot be shared.
 *
 * Requests are queued in the main thread and handed to the worker one at a time.
 * That keeps priority meaningful (the worker itself is single-threaded) and lets
 * a timeout or cancellation retire a stuck read by restarting the worker.
 */
export class EmbeddingMaintenanceReader {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Last complete panel snapshots, keyed by their exact model/dimension scope. */
  private readonly completedStats = new Map<string, EmbeddingMaintenanceStatsSnapshot>();
  private readonly queue: QueuedRequest[] = [];
  private readonly retirements = new Set<Promise<void>>();
  private running?: QueuedRequest;
  private worker?: Worker;
  private nextId = 1;
  private closing = false;
  private fatalError?: Error;
  private fatalAt = 0;
  private stopped?: Promise<void>;
  private stopResolve?: () => void;
  private stopTimer?: NodeJS.Timeout;
  /** SQLite file this lane reads, when one was threaded through by the caller. */
  readonly sqlitePath?: string;
  /** Diagnostic: whether reads run in a worker lane instead of inline on the caller. */
  readonly workerBacked: boolean;

  constructor(private readonly options: EmbeddingMaintenanceReaderOptions) {
    const extension = extname(fileURLToPath(import.meta.url));
    this.sqlitePath = options.sqlitePath;
    this.workerBacked = Boolean(options.sqlitePath && options.sqlitePath !== ":memory:" && extension === ".js");
  }

  /** Global counters are discardable; a target plan is business-required. */
  readStats(request: EmbeddingMaintenanceReaderStatsRequest): Promise<EmbeddingMaintenanceStatsSnapshot> {
    const planning = request.includePlan === true;
    return this.coalesce(
      { type: "stats", request },
      planning ? "business-required" : "discardable-stats",
      planning ? 10 : 0
    ) as Promise<EmbeddingMaintenanceStatsSnapshot>;
  }

  /** Fixed-target progress. Business-required: a run's completion depends on it. */
  readTargets(request: EmbeddingMaintenanceReaderTargetsRequest): Promise<EmbeddingMaintenanceTargetsSnapshot> {
    return this.coalesce({ type: "targets", request }, "business-required", 10) as Promise<EmbeddingMaintenanceTargetsSnapshot>;
  }

  /** The candidate set a one-time upgrade plans over. Also business-required. */
  readUpgradeCandidates(): Promise<EmbeddingMaintenanceEntry[]> {
    return this.coalesce({ type: "upgrade-candidates" }, "business-required", 10) as Promise<EmbeddingMaintenanceEntry[]>;
  }

  /**
   * Drop every queued display read. An in-flight display read is retired by
   * restarting the worker, because a synchronous SQLite scan cannot be
   * interrupted from the outside.
   */
  cancelDiscardableStats(): number {
    let cancelled = 0;
    const retained: QueuedRequest[] = [];
    for (const request of this.queue.splice(0)) {
      if (request.cancelKind !== "discardable-stats") {
        retained.push(request);
        continue;
      }
      this.settle(request, () => request.reject(new EmbeddingMaintenanceReaderCancelled("discardable-stats")));
      cancelled += 1;
    }
    this.queue.push(...retained);
    const running = this.running;
    if (running?.cancelKind === "discardable-stats") {
      this.cancelRunning(new EmbeddingMaintenanceReaderCancelled("discardable-stats"), "cancelled");
      cancelled += 1;
    }
    this.checkStopped();
    return cancelled;
  }

  /**
   * Stop the lane. New reads are refused, display reads are cancelled, in-flight
   * business reads get a bounded grace period, and the worker is terminated so a
   * stuck synchronous query cannot hold shutdown open indefinitely.
   */
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.closing = true;
    this.stopped = new Promise<void>(resolve => { this.stopResolve = resolve; });
    this.cancelDiscardableStats();
    // Business reads still queued will never run: tell their waiters now instead
    // of leaving them to time out after shutdown.
    for (const request of this.queue.splice(0)) {
      this.settle(request, () => request.reject(new EmbeddingMaintenanceReaderCancelled(request.cancelKind)));
    }
    const worker = this.worker;
    if (worker) {
      const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
      this.stopTimer = setTimeout(() => {
        readerLogger.warn("worker.stop.forced", { graceMs: grace });
        if (this.running) {
          this.cancelRunning(
            new EmbeddingMaintenanceReaderCancelled(this.running.cancelKind),
            "stop-timeout"
          );
        } else if (this.worker === worker) {
          this.retireWorker(worker, "stop-timeout");
        }
        this.checkStopped();
      }, grace);
      this.stopTimer.unref?.();
      // Ask the worker to close its connection and exit on its own; if it is
      // mid-query the grace timer above terminates it.
      try {
        worker.postMessage({ type: "close" });
      } catch {
        if (this.running) {
          this.cancelRunning(
            new EmbeddingMaintenanceReaderCancelled(this.running.cancelKind),
            "stop-dispatch-failed"
          );
        } else {
          this.retireWorker(worker, "stop-dispatch-failed");
        }
      }
    }
    this.checkStopped();
    return this.stopped;
  }

  private coalesce(
    operation: ReaderOperation,
    cancelKind: ReaderCancelKind,
    priority: number
  ): Promise<unknown> {
    if (this.closing) {
      // A caller arriving after shutdown started has not been cancelled mid-read;
      // say so plainly instead of reporting a cancellation it never had.
      return Promise.reject(new Error("Embedding maintenance reader is stopping"));
    }
    const key = `${cancelKind}:${JSON.stringify(operation)}`;
    const completedStats = operation.type === "stats" && cancelKind === "discardable-stats"
      ? this.completedStats.get(key)
      : undefined;
    if (this.fatalError) {
      if (Date.now() - this.fatalAt < WORKER_RESTART_BACKOFF_MS) {
        return completedStats ? Promise.resolve(completedStats) : Promise.reject(this.fatalError);
      }
      this.fatalError = undefined;
      this.fatalAt = 0;
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.dispatch(operation, cancelKind, priority)
      .then(
        value => {
          if (operation.type === "stats" && cancelKind === "discardable-stats") {
            this.rememberStats(key, value as EmbeddingMaintenanceStatsSnapshot);
          }
          return value;
        },
        error => {
          // A panel refresh may be preempted by business progress or lose its
          // worker. Preserve the last complete snapshot for this exact scope;
          // never substitute it for fixed-target or candidate reads.
          if (completedStats) return completedStats;
          throw error;
        }
      )
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });
    // Cancellation can reject a cached read after its original caller stopped
    // listening; keep that from surfacing as an unhandled rejection. Callers of
    // the returned promise still observe the rejection.
    void request.catch(() => undefined);
    this.inFlight.set(key, request);
    return request;
  }

  private rememberStats(key: string, stats: EmbeddingMaintenanceStatsSnapshot): void {
    // Model changes are rare, but bound the cache so repeated reconfiguration
    // cannot retain snapshots forever.
    this.completedStats.delete(key);
    this.completedStats.set(key, stats);
    while (this.completedStats.size > 8) {
      const oldest = this.completedStats.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completedStats.delete(oldest);
    }
  }

  private dispatch(
    operation: ReaderOperation,
    cancelKind: ReaderCancelKind,
    priority: number
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const request: QueuedRequest = {
        id,
        operation,
        cancelKind,
        priority,
        resolve,
        reject,
        startedAt: performance.now(),
        settled: false
      };
      this.queue.push(request);
      // A fixed-target read is business progress. If a discardable global scan
      // is already running, retire that scan so progress does not sit behind its
      // full timeout. The caller of the scan receives an explicit cancellation.
      if (this.running?.cancelKind === "discardable-stats" && priority > this.running.priority) {
        this.cancelRunning(new EmbeddingMaintenanceReaderCancelled("discardable-stats"), "preempted");
      } else {
        this.pump();
      }
    });
  }

  /** Start the highest-priority queued read if the lane is free. */
  private pump(): void {
    if (this.running || this.closing || this.retirements.size > 0 || this.queue.length === 0) return;
    let nextIndex = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      if (this.queue[index]!.priority > this.queue[nextIndex]!.priority) nextIndex = index;
    }
    const [request] = this.queue.splice(nextIndex, 1);
    if (!request) return;
    this.running = request;
    const timeoutMs = request.cancelKind === "discardable-stats"
      ? this.options.statsTimeoutMs ?? STATS_TIMEOUT_MS
      : this.options.businessTimeoutMs ?? BUSINESS_TIMEOUT_MS;
    request.timer = setTimeout(() => {
      if (request.settled) return;
      const durationMs = performance.now() - request.startedAt;
      const error = new Error(`Embedding maintenance ${request.cancelKind} read timed out after ${timeoutMs}ms`);
      readerLogger.warn("read.timed_out", { operation: request.operation.type, durationMs, timeoutMs });
      // A synchronous SQLite scan cannot be interrupted. Reject all queued
      // work, retire the lane, and enter the same controlled backoff used for a
      // worker crash instead of immediately starting an infinite restart loop.
      this.abort(error, "timeout");
    }, timeoutMs);
    request.timer.unref?.();
    if (!this.workerBacked) {
      // Source runners and in-memory tests share the queue and cancellation
      // semantics but run the query on this thread; keep them off the pump's
      // synchronous frame so scheduling stays observable.
      setImmediate(() => {
        if (request.settled) {
          this.complete(request);
          return;
        }
        try {
          const result = executeInline(this.options.repos, request.operation);
          this.settle(request, () => request.resolve(result));
        } catch (error) {
          this.settle(request, () => request.reject(error));
        }
        this.complete(request);
      });
      return;
    }
    try {
      this.ensureWorker().postMessage({
        type: "request",
        id: request.id,
        operation: request.operation
      } satisfies ReaderRequestMessage);
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error(String(error)), "dispatch-failed");
    }
  }

  /** Mark a request settled exactly once and release its timer. */
  private settle(request: QueuedRequest, complete: () => void): void {
    if (request.settled) return;
    request.settled = true;
    if (request.timer) clearTimeout(request.timer);
    complete();
  }

  private complete(request: QueuedRequest): void {
    if (this.running === request) this.running = undefined;
    this.pump();
    this.checkStopped();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      this.options.workerUrl ?? new URL("./embedding-maintenance-reader-worker.js", import.meta.url), {
      workerData: { sqlitePath: this.options.sqlitePath }
      }
    );
    worker.on("message", (message: ReaderResponseMessage) => {
      if (this.worker !== worker) return;
      if (message.type !== "response") return;
      const request = this.running;
      if (!request || request.id !== message.id) return;
      const durationMs = performance.now() - request.startedAt;
      if (message.error) {
        readerLogger.warn("read.failed", { operation: request.operation.type, durationMs, errorMessage: message.error });
        this.settle(request, () => request.reject(new Error(message.error!)));
      } else {
        readerLogger.debug("read.completed", { operation: request.operation.type, durationMs });
        this.settle(request, () => request.resolve(message.result));
      }
      this.complete(request);
    });
    worker.once("error", (error) => {
      if (this.worker !== worker) return;
      this.abort(error instanceof Error ? error : new Error(String(error)), "worker-error");
    });
    worker.once("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      if (this.closing) {
        if (this.running) {
          const running = this.running;
          this.running = undefined;
          this.settle(running, () => running.reject(
            new EmbeddingMaintenanceReaderCancelled(running.cancelKind)
          ));
        }
        this.checkStopped();
        return;
      }
      if (!this.fatalError) {
        this.fail(new Error(`Embedding maintenance reader exited unexpectedly (${code})`));
      }
    });
    this.worker = worker;
    return worker;
  }

  /** Cancel the active request and retire the worker that owns it. */
  private cancelRunning(error: Error, reason: string): void {
    const running = this.running;
    if (!running) return;
    this.running = undefined;
    this.settle(running, () => running.reject(error));
    const worker = this.worker;
    if (worker) {
      this.retireWorker(worker, reason);
    } else {
      this.pump();
      this.checkStopped();
    }
  }

  /** Retire a worker and wait for its thread to exit before starting another. */
  private retireWorker(worker: Worker, reason: string): void {
    if (this.worker === worker) this.worker = undefined;
    readerLogger.warn("worker.restart", { reason });
    let retirement: Promise<void>;
    try {
      retirement = worker.terminate().then(() => undefined, error => {
        readerLogger.warn("worker.terminate.failed", memoryErrorFields(error));
      });
    } catch (error) {
      readerLogger.warn("worker.terminate.failed", memoryErrorFields(error));
      retirement = Promise.resolve();
    }
    this.retirements.add(retirement);
    void retirement.then(() => {
      this.retirements.delete(retirement);
      this.pump();
      this.checkStopped();
    });
  }

  /** Fail the lane, reject every waiter, and apply restart backoff. */
  private abort(error: Error, reason: string): void {
    this.fail(error);
    const worker = this.worker;
    if (worker) this.retireWorker(worker, reason);
  }

  private fail(error: Error): void {
    readerLogger.error("worker.failed", memoryErrorFields(error));
    this.fatalError = error;
    this.fatalAt = Date.now();
    const running = this.running;
    this.running = undefined;
    if (running) this.settle(running, () => running.reject(error));
    for (const request of this.queue.splice(0)) {
      this.settle(request, () => request.reject(error));
    }
    this.checkStopped();
  }

  /** Resolve stop only after every waiter and every worker thread is gone. */
  private checkStopped(): void {
    if (!this.closing || !this.stopResolve) return;
    if (this.queue.length > 0 || this.running || this.worker || this.retirements.size > 0) return;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    const resolve = this.stopResolve;
    this.stopResolve = undefined;
    resolve();
  }
}

function executeInline(repos: Repositories, operation: ReaderOperation): unknown {
  if (operation.type === "stats") return readEmbeddingMaintenanceStats(repos, operation.request);
  if (operation.type === "targets") return readEmbeddingMaintenanceTargets(repos, operation.request);
  return readEmbeddingUpgradeCandidates(repos);
}
