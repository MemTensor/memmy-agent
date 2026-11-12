/** Admission happens before SQLite transactions. A worker holds a lease for only
 * one batch; foreground capture waits asynchronously and retains its dedupe transaction. */
export class PanelWriteCoordinator {
  private held = false;
  private closed = false;
  private waiters: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void }> = [];
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed || signal?.aborted) return Promise.reject(new DOMException("Write admission cancelled", "AbortError"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new DOMException("Write admission cancelled", "AbortError"));
      }};
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }
  private drain() {
    if (this.held || this.closed) return;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    waiter.signal?.removeEventListener("abort", waiter.abort);
    this.held = true;
    let released = false;
    waiter.resolve(() => { if (released) return; released = true; this.held = false; this.drain(); });
  }
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const release = await this.acquire(signal);
      try { signal?.throwIfAborted(); return await operation(); }
      catch (error) {
        if (attempt >= 3 || !isSqliteBusy(error)) throw error;
      } finally { release(); }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException("Write cancelled", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 25 * 2 ** attempt);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(new DOMException("Write coordinator stopped", "AbortError"));
    }
  }
}
export function isSqliteBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("SQLITE_BUSY");
}
