import { PanelWriteCoordinator } from "./write-coordinator.js";
import { Worker } from "node:worker_threads";
import { MemoryServiceError } from "../../utils/error.js";
type Result<T> = { safety: string; data: T };
interface Pending {
  id: number;
  method: string;
  args: unknown[];
  resolve: (value: Result<unknown>) => void;
  reject: (error: Error) => void;
  priority: number;
  detach: () => void;
}

/** Source reads use one readonly connection; derived cache writes use bounded
 * worker transactions. Cancellation and timeout terminate a running worker
 * before dispatching another read; replies from the old worker are discarded. */
export class PanelReader {
  private worker?: Worker;
  private pending: Pending[] = [];
  private active?: Pending;
  private nextId = 0;
  private stopping?: Promise<number>;
  private closed = false;
  private resumeTimer?: ReturnType<typeof setTimeout>;
  private writeRelease?: () => void;
  private writeAbort?: AbortController;
  constructor(
    private readonly path: string,
    private readonly timeoutMs = 30_000,
    private readonly backgroundBusy: () => boolean = () => false,
    private readonly writes = new PanelWriteCoordinator()
  ) {}
  run<T>(method: string, args: unknown[], priority = 0, signal?: AbortSignal): Promise<Result<T>> {
    if (this.closed) return Promise.reject(new Error("Panel reader stopped"));
    if (signal?.aborted) return Promise.reject(abortError());
    const interruptStats = isStatisticsMethod(this.active?.method) && priority < this.active!.priority;
    if (this.pending.length + (interruptStats ? 1 : 0) >= 32)
      return Promise.reject(new MemoryServiceError("rate_limited", "Panel reader is busy"));
    return new Promise<Result<unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error("Panel read exceeded time budget");
        if (this.active === itemToQueue) this.fail(error);
        else {
          this.pending = this.pending.filter(item => item !== itemToQueue);
          itemToQueue.detach();
          reject(error);
        }
      }, this.timeoutMs);
      timeout.unref();
      const abort = () => {
        if (this.active === itemToQueue) {
          this.fail(abortError());
          return;
        }
        this.pending = this.pending.filter((item) => item !== itemToQueue);
        itemToQueue.detach();
        reject(abortError());
      };
      const itemToQueue: Pending = {
        id: ++this.nextId,
        method,
        args,
        resolve,
        reject,
        priority,
        detach: () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(itemToQueue);
      this.pending.sort((a, b) => a.priority - b.priority);
      if (interruptStats) this.yieldStatistics();
      this.dispatch();
    }) as Promise<Result<T>>;
  }
  /** Synchronous statistics cannot yield inside SQLite. End that readonly worker
   * before starting another, and retry the unpublished statistics after foreground
   * work. Keep the caller's promise and cancellation listener attached. */
  private yieldStatistics() {
    const active = this.active;
    const worker = this.worker;
    if (!active || !isStatisticsMethod(active.method) || !worker) return;
    clearTimeout(this.resumeTimer);
    this.active = undefined;
    this.worker = undefined;
    this.pending.push(active);
    this.pending.sort((a, b) => a.priority - b.priority);
    this.writeAbort?.abort();
    const releaseWrite = this.writeRelease; this.writeRelease = undefined;
    this.stopping = this.retire(worker).finally(() => releaseWrite?.());
    void this.stopping.finally(() => {
      this.stopping = undefined;
      this.dispatch();
    });
  }
  private dispatch() {
    if (this.closed || this.stopping || this.active || !this.pending.length) return;
    if (!this.worker) {
      const source = import.meta.url.endsWith(".ts");
      const url = new URL(source ? "./reader-worker.ts" : "./reader-worker.js", import.meta.url);
      const worker = source
        ? new Worker(
            `import('tsx/esm/api').then(({register})=>{register();return import(${JSON.stringify(url.href)})})`,
            { eval: true, workerData: { path: this.path } }
          )
        : new Worker(url, { workerData: { path: this.path } });
      this.worker = worker;
      worker.on("message", (message) => {
        if (this.worker !== worker) return;
        const active = this.active;
        if (!active || active.id !== message.id) return;
        if (message.write === "acquire") {
          const controller = new AbortController();
          this.writeAbort = controller;
          void this.writes.acquire(controller.signal).then(release => {
            if (this.worker !== worker || this.active !== active) { release(); return; }
            this.writeRelease = release;
            worker.postMessage({ writeGranted: active.id });
          }).catch(() => undefined);
          return;
        }
        if (message.write === "release") {
          this.writeRelease?.(); this.writeRelease = undefined;
          return;
        }
        if (message.yield && isStatisticsMethod(active.method)) {
          // Model wait is not a database writer. Give foreground work one turn,
          // but never suspend statistics until all background jobs have ended.
          this.resumeTimer = setTimeout(() => {
            if (this.worker === worker && this.active === active)
              worker.postMessage({ resume: active.id });
          }, this.backgroundBusy() ? 10 : 0);
          return;
        }
        active.detach();
        this.active = undefined;
        if (message.error) active.reject(new MemoryServiceError(message.error.code, message.error.message));
        else active.resolve(message.result);
        this.dispatch();
        if (!this.active && !this.pending.length) worker.unref();
      });
      worker.on("error", (error) => {
        if (this.worker === worker) this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      worker.on("exit", (code) => {
        if (this.worker === worker) this.fail(new Error(`Panel reader stopped (${code})`));
      });
      worker.unref();
    }
    this.worker.ref();
    this.active = this.pending.shift()!;
    this.worker.postMessage({ id: this.active.id, method: this.active.method, args: this.active.args });
  }
  private retire(worker: Worker): Promise<number> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { void worker.terminate().then(resolve); }, 2000);
      worker.once("exit", code => { clearTimeout(timer); resolve(code); });
      worker.postMessage({stop:true});
    });
  }
  private fail(error: Error) {
    clearTimeout(this.resumeTimer);
    this.active?.detach();
    this.active?.reject(error);
    this.active = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      this.writeAbort?.abort();
      const releaseWrite = this.writeRelease; this.writeRelease = undefined;
      this.stopping = this.retire(worker).finally(() => releaseWrite?.());
      void this.stopping.finally(() => {
        this.stopping = undefined;
        this.dispatch();
      });
    }
  }
  async stop() {
    this.closed = true;
    for (const item of this.pending) {
      item.detach();
      item.reject(new Error("Panel reader stopped"));
    }
    this.pending = [];
    this.fail(new Error("Panel reader stopped"));
    await this.stopping;
  }
}

function isStatisticsMethod(method: string | undefined): boolean {
  return method === "stats" || method === "overviewStats";
}
function abortError() {
  return new DOMException("Panel request cancelled", "AbortError");
}
