import { setImmediate as nextTurn } from "node:timers/promises";

export type StartupSteps<T> = Generator<void | Promise<void>, T>;

/** Explicit maintenance callers drain the same steps synchronously. HTTP yields between commits. */
export function finishStartupSteps<T>(steps: StartupSteps<T>): T {
  let step = steps.next();
  while (!step.done) {
    if (step.value) throw new Error("Asynchronous startup work in synchronous maintenance");
    step = steps.next();
  }
  return step.value;
}

export async function runStartupSteps<T>(steps: StartupSteps<T>, signal: AbortSignal): Promise<T> {
  await nextTurn();
  signal.throwIfAborted();
  let step = steps.next();
  while (!step.done) {
    try {
      await step.value;
    } catch (error) {
      signal.throwIfAborted();
      // Deliver worker errors at the yield site so the same recovery retry policy applies.
      step = steps.throw(error);
      continue;
    }
    await nextTurn();
    signal.throwIfAborted();
    step = steps.next();
  }
  return step.value;
}
