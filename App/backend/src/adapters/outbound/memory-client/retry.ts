/** Contract for retry options. */

export interface RetryOptions {
  /** Max retries. */
  maxRetries: number;
  /** Base delay ms. */
  baseDelayMs: number;
  /** Factor. */
  factor: number;
  /** Jitter. */
  jitter: number;
  /** Signal. */
  signal?: AbortSignal;
  /** Should retry. */
  shouldRetry: (error: unknown) => boolean;
}

/** Handles retry with backoff. */
export async function retryWithBackoff<T>(operation: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= opts.maxRetries || !opts.shouldRetry(error)) {
        throw error;
      }

      await delay(calculateDelayMs(attempt, opts), opts.signal);
    }
  }
}

/** Handles calculate delay ms. */
function calculateDelayMs(attempt: number, opts: RetryOptions): number {
  const base = opts.baseDelayMs * opts.factor ** attempt;
  const jitterRatio = opts.jitter * (2 * Math.random() - 1);
  return Math.max(0, base * (1 + jitterRatio));
}

/** Handles delay. */
async function delay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}
