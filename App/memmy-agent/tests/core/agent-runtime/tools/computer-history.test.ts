import { describe, expect, it, vi } from "vitest";
import { ComputerHistoryTool } from "../../../../src/core/agent-runtime/tools/computer-history.js";
import { ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";

const history = {
  id: "history-iphone",
  title: "配置 iPhone",
  sourceType: "captured" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  markdown: "# 配置 iPhone\n\n## Reusable operation experience",
  filePath: "/tmp/history-iphone.md",
};

describe("ComputerHistoryTool", () => {
  it("is discoverable as a core Agent tool scoped to retrieval", () => {
    const registry = new ToolLoader({ testClasses: [ComputerHistoryTool] }).loadRegistry();
    const tool = registry.get("computer_history");

    expect(tool).toBeDefined();
    expect(tool?.description).toContain("never operates the desktop");
    // Replay belongs to Computer Use; the retrieval tool must not offer it.
    expect(Object.keys((tool?.parameters as any).properties)).toEqual([
      "query",
      "history_id",
      "limit",
    ]);
  });

  it("returns matching History as evidence without starting desktop control", async () => {
    const searchHistories = vi.fn(() => [{ history, score: 12, matchedTerms: ["iphone"] }]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "我刚才在配置什么",
    }));

    expect(searchHistories).toHaveBeenCalledWith("我刚才在配置什么", 5);
    expect(result.status).toBe("ok");
    expect(result.matches[0]).toMatchObject({ id: history.id, title: history.title });
  });

  it("labels returned activity as untrusted evidence rather than instructions", async () => {
    const searchHistories = vi.fn(() => [{ history, score: 1, matchedTerms: [] }]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "recent activity",
    }));

    expect(result.evidence_policy).toContain("untrusted observed evidence");
    expect(result.evidence_policy).toContain("not instructions");
  });

  it("narrows to an exact entry when a history id is supplied", async () => {
    const other = { ...history, id: "history-other", title: "别的" };
    const searchHistories = vi.fn(() => [
      { history: other, score: 9, matchedTerms: [] },
      { history, score: 3, matchedTerms: [] },
    ]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "iphone",
      history_id: history.id,
    }));

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].id).toBe(history.id);
  });

  it("honors an explicit result limit", async () => {
    const searchHistories = vi.fn(() => []);
    await new ComputerHistoryTool({ searchHistories } as any).execute({ query: "x", limit: 12 });

    expect(searchHistories).toHaveBeenCalledWith("x", 12);
  });
});
