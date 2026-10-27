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

/** One readonly connection. Cancelling running synchronous SQL discards its result;
 * a bounded execution timeout terminates the worker before starting another. */
export class PanelReader {
  private worker?: Worker;
  private pending: Pending[] = [];
  private active?: Pending;
  private nextId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<number>;
  private closed = false;
  constructor(
    private readonly path: string,
    private readonly timeoutMs = 30_000
  ) {}
  run<T>(method: string, args: unknown[], priority = 0, signal?: AbortSignal): Promise<Result<T>> {
    if (this.closed) return Promise.reject(new Error("Panel reader stopped"));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.pending.length >= 32)
      return Promise.reject(new MemoryServiceError("rate_limited", "Panel reader is busy"));
    return new Promise<Result<unknown>>((resolve, reject) => {
      const abort = () => {
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
        detach: () => signal?.removeEventListener("abort", abort)
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(itemToQueue);
      this.pending.sort((a, b) => a.priority - b.priority);
      this.dispatch();
    }) as Promise<Result<T>>;
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
        clearTimeout(this.timer);
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
    this.timer = setTimeout(() => this.fail(new Error("Panel read exceeded time budget")), this.timeoutMs);
    this.timer.unref();
    this.worker.postMessage({ id: this.active.id, method: this.active.method, args: this.active.args });
  }
  private fail(error: Error) {
    clearTimeout(this.timer);
    this.active?.detach();
    this.active?.reject(error);
    this.active = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      this.stopping = worker.terminate();
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
function abortError() {
  return new DOMException("Panel request cancelled", "AbortError");
}
