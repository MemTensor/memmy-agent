import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { PanelBrowse } from "../../../src/service/panel/browse.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
describe("file-backed fixed panel browsing", () => {
  it("uses a readonly worker and preserves membership and visited pages until security invalidation", async () => {
    const { service, db } = createTestService();
    const repos = new Repositories(db.db);
    for (let i = 0; i < 45; i++) service.addMemory({ content: `member ${i}`, source: "codex" });
    const filter = { layer: "L1" as const, section: "items" as const };
    const view = await service.browsePanel({ op: "create", filter }, {});
    expect(view).toHaveProperty("viewId");
    if (!("viewId" in view) || !("items" in view)) throw new Error("missing page");
    expect(view.total).toBe(45);
    expect(view.items).toHaveLength(20);
    const first = view.items![0]!;
    const original = repos.memories.get(first.id)!;
    repos.memories.update({ ...original, memoryValue: "changed text" });
    service.addMemory({ content: "new member", source: "codex" });
    const repeat = await service.browsePanel({ op: "page", viewId: view.viewId, page: 1 }, {});
    expect(repeat).toMatchObject({ items: view.items, total: 45 });
    const second = await service.browsePanel({ op: "page", viewId: view.viewId, page: 2 }, {});
    expect(second).toHaveProperty("total", 45);
    await expect(
      service.browsePanel(
        { op: "page", viewId: view.viewId, page: 1 },
        { namespace: { userId: "other", source: "codex", profileId: "default" } }
      )
    ).rejects.toThrow("expired");
    service.deleteMemory(first.id);
    await expect(service.browsePanel({ op: "page", viewId: view.viewId, page: 1 }, {})).rejects.toThrow("expired");
    await service.stop();
  });
  it("expires whole over-budget views instead of rebuilding a visited page", async () => {
    const browse = new PanelBrowse({
      read: async <T>(method: string) => ({
        safety: "a",
        data: (method === "members" ? ["id"] : { items: [{ id: "id", text: "x".repeat(200) }] }) as T
      }),
      safety: () => "a",
      change: () => 1,
      budget: 100
    });
    await expect(browse.create({})).rejects.toThrow("budget");
  });
  it("executes legacy task, detail and statistics contracts in a real readonly worker", async () => {
    const { service } = createTestService();
    const session = service.openSession({ namespace: { userId: "owner", source: "codex", profileId: "default" } });
    const turn = service.completeTurn("turn", {
      sessionId: session.sessionId,
      query: "worker user",
      answer: "worker answer"
    });
    const legacy = await service.readPanel<{ tasks: Array<{ turns: Array<{ userText: string }> }> }>("legacyTasks", [
      {}
    ]);
    expect(legacy.data.tasks[0]?.turns[0]?.userText).toBe("worker user");
    const detail = await service.readPanel<{ turns: Array<{ rawTurnId: string }> }>("detail", [turn.episodeId, {}]);
    const field = await service.readPanel<{ text: string }>("field", [
      turn.episodeId,
      detail.data.turns[0]!.rawTurnId,
      "userText",
      {}
    ]);
    expect(field.data.text).toBe("worker user");
    const stats = await service.readPanel<{ overview: unknown; analysis: unknown }>("stats", [{ timeZone: "UTC" }]);
    expect(stats.data).toHaveProperty("overview");
    expect(stats.data).toHaveProperty("analysis");
    await service.stop();
    await expect(service.readPanel("items", [{}])).rejects.toThrow("stopping");
  });
});
