import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { PanelReader } from "../../../src/service/panel/reader.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
describe("bounded readonly executor", () => {
  it("cancels queued work and preserves other requests, then rejects work after stop", async () => {
    const { db } = createTestService();
    const reader = new PanelReader(db.path);
    try {
      const first = reader.run("members", [{ layer: "L1" }]);
      const controller = new AbortController();
      const cancelled = reader.run("items", [{}], 0, controller.signal).catch((error) => error);
      controller.abort();
      const next = reader.run("items", [{}]);
      expect((await cancelled).name).toBe("AbortError");
      expect(await first).toHaveProperty("data");
      expect(await next).toHaveProperty("data");
    } finally {
      await reader.stop();
    }
    await expect(reader.run("items", [{}])).rejects.toThrow("stopped");
  });
  it("rejects timed-out work, releases the worker and terminates cleanly", async () => {
    const { db } = createTestService();
    const reader = new PanelReader(db.path, 1);
    await expect(reader.run("members", [{}])).rejects.toThrow("time budget");
    await reader.stop();
  });
});
