import { describe, expect, it } from "vitest";
import {
  WorkerScheduler, WorkerSchedulerReentryError, WorkerSchedulerStoppedError, withoutWorkerSchedulerContext
} from "../../../src/service/worker/worker-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("single worker scheduling boundary", () => {
  it("starts queued requests FIFO and preserves each result", async () => {
    const scheduler = new WorkerScheduler(), gate = deferred();
    const started: string[] = [];
    const a = scheduler.run(async () => { started.push("A"); await gate.promise; return "result-A"; });
    const b = scheduler.run(() => { started.push("B"); return "result-B"; });
    const c = scheduler.run(async () => { started.push("C"); return "result-C"; });
    expect(started).toEqual(["A"]);
    gate.resolve();
    expect(await Promise.all([a, b, c])).toEqual(["result-A", "result-B", "result-C"]);
    expect(started).toEqual(["A", "B", "C"]);
  });

  it.each(["synchronous", "asynchronous"] as const)("releases the boundary after %s failure", async (mode) => {
    const scheduler = new WorkerScheduler(), gate = deferred();
    const error = new Error(`controlled ${mode} failure`);
    const first = scheduler.run(async () => { await gate.promise; });
    const failing = scheduler.run(mode === "synchronous" ? () => { throw error; } : async () => { throw error; });
    const failureObserved = expect(failing).rejects.toBe(error);
    const later = scheduler.run(() => "later-result");
    gate.resolve();
    await first;
    await failureObserved;
    expect(await later).toBe("later-result");
  });

  it("rejects nested run and close instead of deadlocking the active request", async () => {
    const scheduler = new WorkerScheduler();
    await scheduler.run(async () => {
      await expect(scheduler.run(() => "nested")).rejects.toBeInstanceOf(WorkerSchedulerReentryError);
      expect(() => scheduler.close()).toThrow(WorkerSchedulerReentryError);
    });
    expect(await scheduler.run(() => "still-open")).toBe("still-open");
    await scheduler.close();
  });

  it("lets an old async descendant submit after its parent execution has ended", async () => {
    const scheduler = new WorkerScheduler(), afterParent = deferred(), childDone = deferred<string>();
    await scheduler.run(() => {
      void afterParent.promise.then(async () => {
        try { childDone.resolve(await scheduler.run(() => "descendant-result")); }
        catch (error) { childDone.reject(error); }
      });
    });
    afterParent.resolve();
    expect(await childDone.promise).toBe("descendant-result");
  });

  it("rejects pending requests on close but waits for active work and rejects new requests", async () => {
    const scheduler = new WorkerScheduler(), gate = deferred();
    let pendingStarted = false, stopped = false;
    const active = scheduler.run(async () => { await gate.promise; return "active-result"; });
    const pending = scheduler.run(() => { pendingStarted = true; });
    const pendingRejected = expect(pending).rejects.toBeInstanceOf(WorkerSchedulerStoppedError);
    const stopping = scheduler.close().then(() => { stopped = true; });
    const stoppingAgain = scheduler.close();
    await pendingRejected;
    expect(pendingStarted).toBe(false);
    expect(stopped).toBe(false);
    await expect(scheduler.run(() => "new")).rejects.toBeInstanceOf(WorkerSchedulerStoppedError);
    gate.resolve();
    expect(await active).toBe("active-result");
    await Promise.all([stopping, stoppingAgain]);
    expect(stopped).toBe(true);
  });

  it("settles close even if its active work fails", async () => {
    const scheduler = new WorkerScheduler(), gate = deferred();
    const error = new Error("failure while stopping");
    const active = scheduler.run(async () => { await gate.promise; throw error; });
    const failed = expect(active).rejects.toBe(error);
    const stopping = scheduler.close();
    gate.resolve();
    await failed;
    await stopping;
  });

  it("closes an unused scheduler idempotently", async () => {
    const scheduler = new WorkerScheduler();
    await scheduler.close(); await scheduler.close();
    await expect(scheduler.run(() => 1)).rejects.toBeInstanceOf(WorkerSchedulerStoppedError);
  });
});

it("accepts an independent wake request from an active job without overlapping execution", async () => {
  const scheduler = new WorkerScheduler(), gate = deferred();
  const started: string[] = [];
  let wake!: Promise<string>;
  const active = scheduler.run(async () => {
    started.push("active");
    wake = withoutWorkerSchedulerContext(() => scheduler.run(() => { started.push("wake"); return "woken"; }));
    await gate.promise;
  });
  expect(started).toEqual(["active"]);
  gate.resolve(); await active;
  expect(await wake).toBe("woken");
  expect(started).toEqual(["active", "wake"]);
});
