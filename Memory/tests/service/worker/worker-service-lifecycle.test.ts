import { afterEach, expect, it } from "vitest";
import type { LlmCompletionOptions, LlmMessage } from "../../../src/model/types.js";
import { WorkerSchedulerReentryError, WorkerSchedulerStoppedError } from "../../../src/service/worker/worker-scheduler.js";
import { addAgentSourceImport, createBatchReflectionLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const namespace = { source: "codex", profileId: "scheduler-lifecycle", userId: "scheduler-lifecycle-user" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("rejects a worker's attempt to await its own service shutdown without poisoning later shutdown", async () => {
  const llm = createBatchReflectionLlm([]), complete = llm.completeJson.bind(llm);
  let stopInside!: () => Promise<void>;
  let refused = 0;
  llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
    await expect(stopInside()).rejects.toBeInstanceOf(WorkerSchedulerReentryError);
    refused++;
    return complete<T>(messages, options);
  };
  const { service } = fixture.createTestService({ llm });
  stopInside = () => service.stop();
  const memory = addAgentSourceImport(service, namespace, "shutdown reentry does not close the service", "reentry");
  expect(await service.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 1 });
  expect(refused).toBeGreaterThan(0);
  await service.runWorkerOnce(4);
  expect(service.memoryProcessingStatus([memory.id], { namespace }).items[0]?.state).toBe("ready");
  await service.stop();
  await expect(service.runWorkerOnce(1)).rejects.toBeInstanceOf(WorkerSchedulerStoppedError);
});

it("waits for admitted service work before storage may close and cancels unstarted requests", async () => {
  const entered = deferred(), gate = deferred();
  const llm = createBatchReflectionLlm([]), complete = llm.completeJson.bind(llm);
  llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
    entered.resolve(); await gate.promise; return complete<T>(messages, options);
  };
  const { service, db } = fixture.createTestService({ llm });
  const active = addAgentSourceImport(service, namespace, "active summary", "active");
  const waiting = addAgentSourceImport(service, namespace, "waiting summary", "waiting");
  const run = service.runWorkerOnce(1, { targetMemoryIds: [active.id] });
  await entered.promise;
  const pending = service.runWorkerOnce(1, { targetMemoryIds: [waiting.id] });
  const pendingRejected = expect(pending).rejects.toBeInstanceOf(WorkerSchedulerStoppedError);
  await Promise.resolve();
  const stop = service.stop(), repeatedStop = service.stop();
  let closed = false;
  const closeStorage = stop.then(() => { db.close(); closed = true; });
  try {
    await pendingRejected;
    expect(closed).toBe(false);
    expect(service.memoryProcessingStatus([waiting.id], { namespace }).items[0]?.state).toBe("summary_pending");
  } finally { gate.resolve(); }
  await Promise.all([stop, repeatedStop, closeStorage]);
  expect(await run).toMatchObject({ leased: 1, succeeded: 1 });
  expect(closed).toBe(true);
});

it("does not let an active job await an already requested external shutdown", async () => {
  const entered = deferred(), gate = deferred();
  const llm = createBatchReflectionLlm([]), complete = llm.completeJson.bind(llm);
  let stopInside!: () => Promise<void>;
  llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
    entered.resolve(); await gate.promise;
    await expect(stopInside()).rejects.toBeInstanceOf(WorkerSchedulerReentryError);
    return complete<T>(messages, options);
  };
  const { service } = fixture.createTestService({ llm });
  stopInside = () => service.stop();
  addAgentSourceImport(service, namespace, "nested shutdown after external close", "external-close");
  const active = service.runWorkerOnce(1);
  await entered.promise;
  const stopped = service.stop();
  gate.resolve();
  expect(await active).toMatchObject({ leased: 1, succeeded: 1 });
  await stopped;
});
