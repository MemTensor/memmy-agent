import { AsyncLocalStorage } from "node:async_hooks";

export class WorkerSchedulerReentryError extends Error {
  constructor() {
    super("A running worker cannot await another drain through the same scheduler");
    this.name = "WorkerSchedulerReentryError";
  }
}

export class WorkerSchedulerStoppedError extends Error {
  constructor() {
    super("Worker scheduler has stopped accepting requests");
    this.name = "WorkerSchedulerStoppedError";
  }
}

interface Execution { active: boolean; scheduler: WorkerScheduler }
const executionContext = new AsyncLocalStorage<Execution>();

/** Fire-and-forget wake callbacks create new requests, not nested awaited work. */
export function withoutWorkerSchedulerContext<T>(work: () => T): T {
  return executionContext.exit(work);
}
interface PendingRequest {
  start: (execution: Execution) => void;
  reject: (error: Error) => void;
}

/**
 * The single execution boundary shared by automatic, manual and retry drains.
 * Requests retain their own budgets and filters. The admitted runner uses the
 * shared resource controller to execute and continuously refill within a drain.
 */
export class WorkerScheduler {
  private readonly pending: PendingRequest[] = [];
  private execution: Execution | undefined;
  private stopped = false;
  private readonly idleWaiters: Array<() => void> = [];

  hasPendingRequests(): boolean { return this.pending.length > 0; }

  run<T>(execute: () => T | Promise<T>): Promise<T> {
    if (this.isReentry()) return Promise.reject(new WorkerSchedulerReentryError());
    if (this.stopped) return Promise.reject(new WorkerSchedulerStoppedError());
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        reject,
        start: (execution) => {
          const finish = () => {
            execution.active = false;
            this.execution = undefined;
            this.startNext();
          };
          try {
            const outcome = executionContext.run(execution, execute);
            void Promise.resolve(outcome).then(
              (value) => { finish(); resolve(value); },
              (error: unknown) => { finish(); reject(error); }
            );
          } catch (error) {
            finish();
            reject(error);
          }
        }
      });
      this.startNext();
    });
  }

  /** Reject requests that have not started; let the current guarded drain settle. */
  close(): Promise<void> {
    // Fail before lifecycle callers mutate their shutdown state. Awaiting our
    // own completion from the running drain would otherwise deadlock.
    if (this.isReentry()) throw new WorkerSchedulerReentryError();
    this.stopped = true;
    for (const request of this.pending.splice(0)) request.reject(new WorkerSchedulerStoppedError());
    return this.execution ? new Promise<void>((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
  }

  private startNext(): void {
    if (this.execution) return;
    const next = this.pending.shift();
    if (next && !this.stopped) {
      const execution = { active: true, scheduler: this };
      this.execution = execution;
      next.start(execution);
      return;
    }
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private isReentry(): boolean {
    const context = executionContext.getStore();
    return context?.scheduler === this && context.active;
  }
}
