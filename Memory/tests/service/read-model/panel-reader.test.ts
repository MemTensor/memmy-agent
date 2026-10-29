import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("shares one completed statistics read between overview and analysis", async () => {
    const {db,service}=createTestService();
    const safety=String(db.db.prepare("SELECT value_json FROM runtime_kv WHERE key='panel_safety_token'").pluck().get());
    const data={overview:{counts:{memories:12}},analysis:{metrics:{recallEvents:3}}};
    const read=vi.spyOn(service,"readPanel").mockResolvedValue({safety,data});
    const input={userId:"owner",timeZone:"+00:00"};
    service.panelOverviewStatsSnapshot(input);
    service.panelStatsSnapshot(input);
    await vi.waitFor(()=>expect(service.panelStatsSnapshot(input).status).toBe("ready"));
    expect(read).toHaveBeenCalledExactlyOnceWith("stats",[input]);
    expect(service.panelOverviewStatsSnapshot(input).data).toEqual(data.overview);
    expect(service.panelStatsSnapshot(input).data).toEqual(data);
    service.addMemory({content:"incremental write",source:"codex"});
    expect(service.panelOverviewStatsSnapshot(input)).toMatchObject({status:"ready",data:data.overview});
    await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(2));
  });
  it("loads an isolated log detail without materializing unrelated logs", async () => {
    const {db}=createTestService();
    const repos=new Repositories(db.db);
    const add=(query:string)=>repos.runtime.insertApiLog({toolName:"memory_search",inputJson:JSON.stringify({query}),outputJson:"{}",durationMs:1,success:true,calledAt:"2026-10-29T00:00:00Z"});
    const first=add("requested"),second=add("unrelated");
    const reader=new PanelReader(db.path);
    try{
      expect((await reader.run("logDetail",[first.id])).data).toMatchObject({log:{id:first.id,inputJson:'{"query":"requested"}'}});
      expect(db.db.prepare("SELECT id FROM panel_log_dirty").pluck().all()).toEqual([second.id]);
    }finally{await reader.stop();}
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
