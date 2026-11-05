/** One owner across history and task recording, including asynchronous startup/teardown. */
export class CollectorGate {
  private owner: "history" | "task" | null = null;
  get busy(): boolean { return this.owner !== null; }
  get taskActive(): boolean { return this.owner === "task"; }
  acquire(owner: "history" | "task"): () => void {
    if (this.owner) throw new CollectorBusyError();
    this.owner = owner;
    let released = false;
    return () => { if (!released) { released = true; this.owner = null; } };
  }
}
export class CollectorBusyError extends Error {
  readonly status = 409;
  constructor() { super("collector_busy: pause Computer History or stop the active recording first"); }
}
export const collectorGate = new CollectorGate();
