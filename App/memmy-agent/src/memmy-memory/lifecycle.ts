/** A transport may ignore cancellation, so callers must also guard commits. */
export async function waitForMemory<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error("memory operation cancelled");
  if (timeoutMs <= 0) throw new Error("memory interactive deadline exceeded");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (reason: unknown): void => {
      controller.abort(reason);
      reject(reason);
    };
    onAbort = () => stop(signal?.reason ?? new Error("memory operation cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => stop(new Error(`memory did not answer within ${Math.ceil(timeoutMs)}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Bounded, process-local writes. This is not a durable outbox. */
export class MemoryWriteQueue {
  private readonly tails = new Map<object, Promise<void>>();
  private readonly controller = new AbortController();
  private count = 0;
  private bytes = 0;

  enqueue(
    key: object,
    bytes: number,
    operation: (signal: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void,
    closing = false,
  ): boolean {
    if (
      this.controller.signal.aborted ||
      (!closing && (this.count >= 100 || this.bytes + bytes > 10 * 1024 * 1024))
    ) {
      onError(new Error("memory background queue capacity exceeded; capture was not stored"));
      return false;
    }
    this.count += 1;
    this.bytes += bytes;
    const deadline = performance.now() + 120_000;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const job = previous
      .then(async () => {
        await waitForMemory(operation, deadline - performance.now(), this.controller.signal);
      })
      .catch(onError)
      .finally(() => {
        this.count -= 1;
        this.bytes -= bytes;
        if (this.tails.get(key) === job) this.tails.delete(key);
      });
    this.tails.set(key, job);
    return true;
  }

  has(key: object): boolean {
    return this.tails.has(key);
  }

  stop(): void {
    this.controller.abort(new Error("memory background queue stopped"));
  }

  async flush(key?: object): Promise<void> {
    await Promise.all(key ? [this.tails.get(key)] : [...this.tails.values()]);
  }
}
