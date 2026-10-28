import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { PanelReader } from "../../../src/service/panel/reader.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createPanelReaderModel } from "../../../src/service/panel/reader-model.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
describe("bounded readonly executor", () => {
  it("preserves all statistics across multiple yielded batches and a foreground interruption", async () => {
    const { db, service } = createTestService();
    service.addMemory({ content: "Synthetic statistics source", source: "codex" });
    const repos = new Repositories(db.db);
    const source = repos.memories.list({})[0]!;
    db.db.transaction(() => {
      for (let i = 0; i < 600; i++) {
        repos.memories.insert({ ...source, id: `statistics_${i}`, memoryKey: `statistics_${i}`,
          deletedAt: i % 5 === 0 ? "2026-01-01T00:00:00Z" : undefined,
          createdAt: i % 2 ? "2026-10-26T23:30:00Z" : "2026-10-27T01:30:00Z" });
      }
    })();
    const input = { userId: "local-user", timeZone: "+08:00" };
    const expected = createPanelReaderModel(db).panelStatistics(input);
    const reader = new PanelReader(db.path);
    try {
      const stats = reader.run("stats", [input], 1);
      const foreground = reader.run<string[]>("members", [{ layer: "L1" }]);
      expect((await foreground).data.length).toBe(expected.overview.counts.memories);
      expect((await stats).data).toEqual(expected);
      expect((await reader.run("overviewStats", [input], 1)).data).toEqual(expected.overview);
      expect((await reader.run("stats", [input], 1)).data).toEqual(expected);
    } finally {
      await reader.stop();
    }
  });
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
