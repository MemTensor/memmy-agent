import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { Repositories, RuntimeRepository } from "../../../src/storage/repositories.js";
import { PanelTaskDetailOutputSchema, PanelTaskSummariesOutputSchema } from "../../../src/contracts/memory-runtime.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(() => {
  vi.restoreAllMocks();
  return cleanup();
});

async function setup() {
  const fixture = createTestService();
  const namespace = { userId: "task-owner", source: "codex", profileId: "default" };
  const session = fixture.service.openSession({ namespace });
  const first = await fixture.service.completeTurn("first", {
    sessionId: session.sessionId,
    query: "First user request",
    answer: "First answer"
  });
  const repos = new Repositories(fixture.db.db);
  const id = first.episodeId;
  if (!id) throw new Error("Fixture turn must be assigned to a task");
  const raw = repos.runtime.listRawTurnsByEpisode(id)[0]!;
  return { ...fixture, repos, raw, namespace, id };
}

describe("bounded panel task reads", () => {
  it("returns an explicit summary without reading dialogue objects and keeps legacy turns", async () => {
    const { service, raw, repos, id } = await setup();
    repos.runtime.updateRawTurn({ ...raw, toolCalls: [{ name: "test", input: "x".repeat(7_000_000) }] });
    const read = vi.spyOn(RuntimeRepository.prototype, "listRawTurnsByEpisode").mockImplementation(() => {
      throw new Error("eager turns");
    });
    const result = PanelTaskSummariesOutputSchema.parse(service.panelTaskSummaries({}));
    expect(result.tasks[0]).toMatchObject({
      id,
      firstUserText: "First user request",
      firstAssistantText: "First answer",
      toolCallCount: 1
    });
    expect(result.tasks[0]).not.toHaveProperty("turns");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(10000);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(service.panelTasks({}).tasks[0]?.turns).toHaveLength(1);
  });

  it("paginates same-timestamp turns without duplicates and bounds huge text and tool payloads", async () => {
    const { service, repos, raw, id } = await setup();
    for (let i = 0; i < 45; i++)
      repos.runtime.insertRawTurn({
        ...raw,
        id: `turn-${String(i).padStart(3, "0")}`,
        turnId: `turn-${i}`,
        createdAt: "2026-10-26T00:00:00.000Z",
        userText: "😀".repeat(5000),
        toolCalls: [{ name: "large", output: "x".repeat(200000) }]
      });
    const first = PanelTaskDetailOutputSchema.parse(service.panelTaskDetail(id, {}));
    expect(first.turns).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
    expect(first.turns.some((turn) => turn.moreFields.includes("userText"))).toBe(true);
    const ids = first.turns.map((turn) => turn.rawTurnId);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = service.panelTaskDetail(id, { cursor });
      ids.push(...page.turns.map((turn) => turn.rawTurnId));
      cursor = page.nextCursor;
    }
    expect(new Set(ids).size).toBe(46);
    expect(ids).toHaveLength(46);
    repos.runtime.insertRawTurn({ ...raw, id: "newest", turnId: "newest", createdAt: "2099-01-01T00:00:00.000Z" });
    expect(service.panelTaskDetail(id, { cursor: first.nextCursor }).hasNewer).toBe(true);
    expect(() => service.panelTaskDetail(id, { cursor: "garbage" })).toThrow("Invalid task turn cursor");
  });

  it("reconstructs full Unicode fields and rejects changed, redacted or invisible content", async () => {
    const { service, repos, raw, id } = await setup();
    const content = "正文😀".repeat(6000);
    repos.runtime.updateRawTurn({ ...raw, userText: content });
    let page = service.panelTaskField(id, raw.id, "userText", {});
    let reconstructed = page.text;
    while (page.nextOffset !== undefined) {
      page = service.panelTaskField(id, raw.id, "userText", { offset: page.nextOffset, revision: page.revision });
      reconstructed += page.text;
    }
    expect(reconstructed).toBe(content);
    const first = service.panelTaskField(id, raw.id, "userText", {});
    repos.runtime.updateRawTurn({ ...raw, userText: "changed" });
    expect(() =>
      service.panelTaskField(id, raw.id, "userText", { offset: first.nextOffset, revision: first.revision })
    ).toThrow("changed");
    expect(() =>
      service.panelTaskDetail(id, { namespace: { source: "codex", profileId: "default", userId: "other" } })
    ).toThrow("unavailable");
    expect(() =>
      service.panelTaskField(id, raw.id, "userText", {
        namespace: { source: "codex", profileId: "default", userId: "other" }
      })
    ).toThrow("unavailable");
    repos.runtime.updateRawTurn({ ...raw, redactedAt: new Date().toISOString() });
    expect(() => service.panelTaskField(id, raw.id, "userText", {})).toThrow("unavailable");
    expect(service.panelTaskDetail(id, {}).turns).toHaveLength(0);
  });
  it("lists tool descriptions and reads one large tool without mixing revisions", async () => {
    const { service, repos, raw, id } = await setup();
    const large = { name: "large", id: "tool-a", output: "数据😀".repeat(3000) };
    repos.runtime.updateRawTurn({ ...raw, toolCalls: [large, { name: "small", id: "tool-b", input: "small" }] });
    const detail = service.panelTaskDetail(id, {});
    const tools = detail.turns[0]!.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["large", "small"]);
    expect(JSON.stringify(detail).length).toBeLessThan(10000);
    let chunk = service.panelTaskField(id, raw.id, "toolCalls", { toolId: tools[0]!.id });
    let content = chunk.text;
    while (chunk.nextOffset !== undefined) {
      chunk = service.panelTaskField(id, raw.id, "toolCalls", {
        toolId: tools[0]!.id,
        offset: chunk.nextOffset,
        revision: chunk.revision
      });
      content += chunk.text;
    }
    expect(JSON.parse(content)).toEqual(large);
    repos.runtime.updateRawTurn({ ...raw, toolCalls: [{ ...large, output: "changed" }] });
    expect(() => service.panelTaskField(id, raw.id, "toolCalls", { toolId: tools[0]!.id })).toThrow("changed");
  });

  it("reads 1000 turns and reconstructs a 7 MB tool within bounded responses", async () => {
    const { service, repos, raw, id } = await setup();
    repos.db.transaction(() => {
      for (let i = 0; i < 999; i++)
        repos.runtime.insertRawTurn({
          ...raw,
          id: `large-turn-${String(i).padStart(4, "0")}`,
          turnId: `large-${i}`,
          createdAt: "2026-10-26T00:00:00.000Z",
          userText: "😀".repeat(1100)
        });
    })();
    const tool = { name: "seven-megabyte-result", output: "x".repeat(7_000_000) };
    repos.runtime.updateRawTurn({ ...raw, toolResults: [tool] });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.panelTaskDetail(id, { cursor });
      expect(page.turns.length).toBeLessThanOrEqual(20);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      ids.push(...page.turns.map((turn) => turn.rawTurnId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
    const listing = service.panelTaskField(id, raw.id, "toolResults", {});
    expect("tools" in listing).toBe(true);
    if (!("tools" in listing)) throw new Error("Missing tool descriptions");
    const toolId = listing.tools[0]!.id;
    let part = service.panelTaskField(id, raw.id, "toolResults", { toolId });
    const chunks = [part.text];
    while (part.nextOffset !== undefined) {
      part = service.panelTaskField(id, raw.id, "toolResults", {
        toolId,
        offset: part.nextOffset,
        revision: part.revision
      });
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(20_000);
      chunks.push(part.text);
    }
    expect(JSON.parse(chunks.join(""))).toEqual(tool);
  }, 20_000);
});
