import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / read model / panel Agent filter", () => {
  it("keeps derived Agent sources under the Agent that the panel displays", () => {
    const { db, service } = createTestService();
    const onboarding = service.addMemory({
      adapterId: "agent-source:memmy-onboarding",
      requestId: "first-report:panel-agent-filter",
      content: "## user\n\nMemmy 初见报告\n\n## assistant\n\n报告正文",
      layer: "L1",
      source: "memmy-onboarding",
      turnId: "first-report:panel-agent-filter"
    });
    const chat = service.addMemory({
      adapterId: "memmy-agent",
      requestId: "chat:panel-agent-filter",
      content: "## user\n\n记录一条对话\n\n## assistant\n\n好的",
      layer: "L1",
      source: "memmy-agent",
      turnId: "turn:panel-agent-filter"
    });
    const custom = service.addMemory({
      adapterId: "agent-source:manual_kimi",
      requestId: "custom:panel-agent-filter",
      content: "## user\n\ncustom Agent turn\n\n## assistant\n\nok",
      layer: "L1",
      source: "manual_kimi",
      turnId: "turn:panel-agent-filter-custom"
    });

    const displayedSources = service.panelItems({ layer: "L1" }).items
      .map((item) => [item.id, item.metadata?.source]);
    expect(displayedSources).toEqual(expect.arrayContaining([
      [onboarding.id, "memmy"],
      [chat.id, "memmy"],
      [custom.id, "manual_kimi"]
    ]));

    const memmy = service.panelItems({ layer: "L1", sourceAgent: "memmy-agent" });
    expect(memmy.total).toBe(2);
    expect(memmy.items.map((item) => item.id).sort()).toEqual([chat.id, onboarding.id].sort());

    const otherAgents = service.panelItems({
      layer: "L1",
      excludedSourceAgents: ["memmy-agent", "codex", "claude_code"]
    });
    expect(otherAgents.items.map((item) => item.id)).toEqual([custom.id]);

    expect(service.panelItems({ layer: "L1", sourceAgent: "manual_kimi" }).items.map((item) => item.id))
      .toEqual([custom.id]);
    db.close();
  });

  it("matches user memories and tasks recorded under a related Agent source", () => {
    const { db, service } = createTestService();
    const namespace = { source: "memmy", profileId: "default", userId: "local-user" };
    const session = service.openSession({ namespace });
    const completed = service.completeTurn("turn-panel-agent-filter-user-memory", {
      sessionId: session.sessionId,
      query: "我喜欢简洁代码，不要写不必要的兜底逻辑",
      answer: "好的，我会记住。"
    });
    expect(completed.userMemoryIds).toHaveLength(1);

    expect(service.panelItems({
      layer: "UserMemory",
      userId: "local-user",
      sourceAgent: "memmy-agent"
    }).items.map((item) => item.id)).toEqual(completed.userMemoryIds);

    expect(service.panelTasks({ namespace, sourceAgent: "memmy-agent" }).tasks.map((task) => task.id))
      .toEqual([completed.episodeId]);
    db.close();
  });
});
