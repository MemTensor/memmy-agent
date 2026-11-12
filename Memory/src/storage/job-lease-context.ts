import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";

interface JobLeaseContext {
  jobId: string;
  isHeld: () => boolean;
}

const jobLeaseContext = new AsyncLocalStorage<JobLeaseContext>();
const protectedConnections = new WeakSet<Database.Database>();

export class JobLeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`worker lease is no longer held: ${jobId}`);
    this.name = "JobLeaseLostError";
  }
}

/** Carry a claim across model awaits without holding a SQLite transaction open. */
export function withJobLeaseGuard<T>(job: { id: string }, isHeld: () => boolean, work: () => T): T {
  return jobLeaseContext.run({ jobId: job.id, isHeld }, () => {
    assertCurrentJobLease();
    return work();
  });
}

/**
 * Infrastructure with an independent lifecycle (usage accounting and worker
 * wake-ups) must not inherit the business task's expiring ownership. Callers
 * must keep actual task-result persistence inside withJobLeaseGuard.
 */
export function withoutJobLeaseGuard<T>(work: () => T): T {
  return jobLeaseContext.exit(work);
}

/** No active worker context means an ordinary foreground or administrative write. */
export function assertCurrentJobLease(): void {
  const claim = jobLeaseContext.getStore();
  if (claim && !claim.isHeld()) throw new JobLeaseLostError(claim.jobId);
}

/**
 * Guard the actual write boundary rather than relying on every business handler
 * to remember a check after every model await. Better-sqlite3 exposes readonly
 * for prepared statements, including WITH and RETURNING statements.
 *
 * The service has one synchronous SQLite writer. No asynchronous work occurs
 * between a claim check and its statement; multi-statement changes continue to
 * use the repository's synchronous transactions. This is not a cross-process
 * distributed transaction mechanism.
 */
export function protectJobLeaseWrites(db: Database.Database): void {
  if (protectedConnections.has(db)) return;
  protectedConnections.add(db);
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (statement.readonly) return statement;

    for (const name of ["run", "get", "all"] as const) {
      const execute = statement[name];
      Object.defineProperty(statement, name, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          assertCurrentJobLease();
          return Reflect.apply(execute, statement, args);
        }
      });
    }

    const iterate = statement.iterate;
    Object.defineProperty(statement, "iterate", {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        assertCurrentJobLease();
        const iterator = Reflect.apply(iterate, statement, args) as IterableIterator<unknown>;
        return {
          [Symbol.iterator]() { return this; },
          next(...nextArgs: [] | [unknown]) {
            assertCurrentJobLease();
            return iterator.next(...nextArgs);
          },
          return(value?: unknown) {
            return iterator.return ? iterator.return(value) : { done: true, value };
          },
          throw(error?: unknown) {
            if (iterator.throw) return iterator.throw(error);
            throw error;
          }
        };
      }
    });
    return statement;
  }) as typeof db.prepare;

  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    assertCurrentJobLease();
    return exec(sql);
  };
}
