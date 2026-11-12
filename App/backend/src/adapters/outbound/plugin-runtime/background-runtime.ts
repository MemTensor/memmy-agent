/** Shared preparation for command runtimes that are only needed by some calls. */
import type { CapabilityEvent } from "@memmy/local-api-contracts";

export type RuntimePreparationProgress = Pick<Extract<CapabilityEvent, { type: "progress" }>, "current" | "total" | "message" | "phase" | "runtimeStage">;

export class BackgroundRuntime<T> {
  ready?: T;
  private pending?: Promise<T | undefined>;
  private scheduled?: ReturnType<typeof setImmediate>;

  constructor(
    private readonly resolve: () => Promise<T>,
    private readonly progress: () => RuntimePreparationProgress
  ) {
    // Let activation and the startup/login continuation finish first.
    this.scheduled = setImmediate(() => { this.scheduled = undefined; void this.prepare(); });
    this.scheduled.unref();
  }

  prepare(): Promise<T | undefined> {
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
    if (this.ready) return Promise.resolve(this.ready);
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(this.resolve).then(runtime => {
      this.ready = runtime;
      return runtime;
    }).catch(() => undefined).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  stopScheduling(): void {
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    // An already-running, Host-owned cache install may be shared with other sessions.
  }

  async *wait(signal: AbortSignal, expiresAt: number): AsyncGenerator<CapabilityEvent, T | undefined> {
    assertWaiting(signal, expiresAt);
    if (this.ready) return this.ready;
    let settled = false;
    let result: T | undefined;
    const pending = this.prepare().then(runtime => { result = runtime; settled = true; });
    while (!settled) {
      assertWaiting(signal, expiresAt);
      yield { type: "progress", ...this.progress(), cancellable: true };
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(cancelled()); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(1000, Math.max(1, expiresAt - Date.now())));
        signal.addEventListener("abort", abort, { once: true });
        // Cancellation can happen while the consumer is processing the progress event.
        if (signal.aborted) abort();
        void pending.then(() => { cleanup(); resolve(); });
      });
    }
    assertWaiting(signal, expiresAt);
    return result;
  }
}

function cancelled(): Error {
  return Object.assign(new Error("Plugin call was cancelled"), { code: "plugin_cancelled" });
}

function assertWaiting(signal: AbortSignal, expiresAt: number): void {
  if (signal.aborted) throw cancelled();
  if (Date.now() >= expiresAt) throw Object.assign(new Error("Plugin call timed out"), { code: "plugin_timeout" });
}
