import { afterEach, describe, expect, it } from "vitest";
import type { MemoryModelTaskRouter } from "../../../src/model/task-routing.js";
import { createBatchReflectionLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
describe("MemoryService model business shutdown", () => {
  it("rejects foreground shutdown reentry without stopping the service", async () => {
    const llm = createBatchReflectionLlm([]);
    const { service } = createTestService({ llm });
    const tasks = (service as unknown as { modelTasks: MemoryModelTaskRouter }).modelTasks;
    llm.complete = async () => {
      await expect(service.stop()).rejects.toThrow(/foreground model task/);
      return "finished after rejected stop";
    };
    expect(await tasks.run(() => tasks.client("summary").complete([], { operation: "test.reentry" })))
      .toBe("finished after rejected stop");
    expect(await tasks.run(() => Promise.resolve("still accepting foreground"))).toBe("still accepting foreground");
    await service.stop();
  });

  it("keeps storage open until foreground post-model processing finishes", async () => {
    let respond!: () => void, finishBusiness!: () => void;
    const response = new Promise<void>(resolve => { respond = resolve; });
    const businessGate = new Promise<void>(resolve => { finishBusiness = resolve; });
    const llm = createBatchReflectionLlm([]);
    llm.complete = async () => { await response; return "response"; };
    const { db, service } = createTestService({ llm });
    db.db.exec("CREATE TABLE shutdown_probe(value INTEGER NOT NULL)");
    // Exercise the same task boundary used by search/startTurn/feedback, with a
    // controlled post-response DB step rather than timing a remote provider.
    const tasks = (service as unknown as { modelTasks: MemoryModelTaskRouter }).modelTasks;
    const business = tasks.run(async () => {
      await tasks.client("summary").complete([], { operation: "test.shutdown" });
      await businessGate;
      db.db.prepare("INSERT INTO shutdown_probe(value) VALUES (1)").run();
    });
    await tick();
    let stopped = false;
    const stop = service.stop().then(() => { stopped = true; });
    try {
      await tick(); expect(stopped).toBe(false);
      respond(); await tick(); expect(stopped).toBe(false);
      finishBusiness(); await Promise.all([business, stop]);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM shutdown_probe").get()).toEqual({ count: 1 });
    } finally {
      respond(); finishBusiness(); await Promise.all([business, stop]);
    }
  });
});
