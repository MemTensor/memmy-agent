interface Subscriber<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}
interface Pending<T> {
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<T>;
  subscribers: Set<Subscriber<T>>;
  started: boolean;
}

/** One queue per runtime client: sharing never gives one caller ownership of another's cancellation. */
export class PanelRequestQueue {
  private readonly pending = new Map<string, Pending<unknown>>();
  private active = 0;
  get idle(): boolean {
    return this.active === 0 && this.pending.size === 0;
  }

  constructor(private readonly concurrency = 2) {}

  clear(): void {
    for (const task of this.pending.values()) {
      for (const subscriber of task.subscribers) {
        subscriber.detach();
        subscriber.reject(abortError());
      }
      task.subscribers.clear();
      task.controller.abort();
    }
    this.pending.clear();
  }

  request<T>(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    let entry = this.pending.get(key) as Pending<T> | undefined;
    if (!entry) {
      entry = { run, controller: new AbortController(), subscribers: new Set(), started: false };
      this.pending.set(key, entry as Pending<unknown>);
    }
    const task = entry;
    const promise = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        task.subscribers.delete(subscriber);
        subscriber.detach();
        reject(signal?.reason ?? abortError());
        if (task.subscribers.size === 0) {
          if (this.pending.get(key) === task) this.pending.delete(key);
          task.controller.abort();
          this.drain();
        }
      };
      const subscriber = { resolve, reject, detach: () => signal?.removeEventListener("abort", onAbort) };
      task.subscribers.add(subscriber);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.drain();
    return promise;
  }

  private drain(): void {
    for (const [key, task] of this.pending) {
      if (this.active >= this.concurrency) break;
      if (task.started || task.subscribers.size === 0) continue;
      task.started = true;
      this.active++;
      void Promise.resolve()
        .then(() => {
          if (task.controller.signal.aborted) throw abortError();
          return task.run(task.controller.signal);
        })
        .then(
          (value) => {
            this.finish(key, task, (subscriber) => subscriber.resolve(value));
          },
          (error) => {
            this.finish(key, task, (subscriber) => subscriber.reject(error));
          }
        );
    }
  }

  private finish(key: string, task: Pending<unknown>, notify: (subscriber: Subscriber<unknown>) => void): void {
    // A consumer can request the same key in its next microtask. Retire this
    // execution completely before resolving/rejecting any of its subscribers.
    if (this.pending.get(key) === task) this.pending.delete(key);
    this.active--;
    const subscribers = [...task.subscribers];
    task.subscribers.clear();
    for (const subscriber of subscribers) { subscriber.detach(); notify(subscriber); }
    this.drain();
  }
}

function abortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}
