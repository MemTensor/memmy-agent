import { assignedEpisodeId } from "../../fixtures/memory-service-fixture.js";
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

  it("uses displayed producer precedence for browse and legacy panels without changing ownership filters", async () => {
    const {db, service} = createTestService();
    const explicit = service.addMemory({content: "producer needle explicit", layer: "L1", source: "codex"});
    const legacy = service.addMemory({content: "producer needle legacy", layer: "L1", source: "cursor"});
    const custom = service.addMemory({content: "producer needle custom", layer: "L1", source: "manual_kimi"});
    db.db.prepare("UPDATE memories SET agent_id='memmy' WHERE id IN (?, ?, ?)").run(explicit.id, legacy.id, custom.id);
    db.db.prepare("UPDATE memories SET info_json=json_set(info_json,'$.source','turn.complete'), properties_json=json_set(properties_json,'$.internal_info.source','worker'), session_id='codex-legacy' WHERE id=?").run(legacy.id);
    const expected = [explicit.id, legacy.id].sort();
    const displayed = service.panelItems({layer:"L1"}).items;
    expect(displayed.filter(item => item.metadata?.source === "codex").map(item=>item.id).sort()).toEqual(expected);
    for (const q of [undefined, "producer needle"]) {
      const result = service.panelItems({layer:"L1", sourceAgent:"codex", q});
      expect(result.total).toBe(2);
      expect(result.items.map(item=>item.id).sort()).toEqual(expected);
      const browse = await service.browsePanel({op:"create", filter:{layer:"L1", sourceAgent:"codex", q}}, {});
      expect("items" in browse && browse.items?.map(item=>item.id).sort()).toEqual(expected);
    }
    const other = await service.browsePanel({op:"create", filter:{layer:"L1", excludedSourceAgents:["memmy-agent","codex","cursor","claude_code"]}}, {});
    expect("items" in other && other.items?.map(item=>item.id)).toEqual([custom.id]);
    // The panel correction must not turn an ownership filter into producer filtering.
    const repos = new (await import("../../../src/storage/repositories.js")).Repositories(db.db);
    expect(repos.memories.count({agentId:"codex"})).toBe(0);
    db.close();
  });

  it("matches producer aliases and legacy fallbacks with the same precedence as display", async () => {
    const {db, service} = createTestService();
    const cases = [
      {info:"claude", internal:"cursor", session:"codex-host", agent:"memmy", filter:"claude_code", display:"claude-code"},
      {info:"turn.complete", internal:"open-code-old", agent:"memmy", filter:"opencode", display:"opencode"},
      {session:"cursor-session", agent:"memmy", filter:"cursor", display:"cursor"},
      {conversation:"codex-conversation", agent:"memmy", filter:"codex", display:"codex"},
      {agent:"claude-code", filter:"claude_code", display:"claude-code"},
      {app:"hermes", filter:"hermes", display:"hermes"},
      {info:"manual_kimi", agent:"memmy", filter:"manual_kimi", display:"manual_kimi"},
      {info:"worker", filter:"memmy-agent", display:"memmy"},
      {filter:"unknown", display:"unknown"}
    ];
    for(const [i, sample] of cases.entries()) {
      const item=service.addMemory({content:`alias sample ${i}`, source:"fixture",layer:"L1"});
      db.db.prepare("UPDATE memories SET agent_id=?, app_id=?, session_id=?, conversation_id=?, info_json=json_set(info_json,'$.source',?), properties_json=json_set(properties_json,'$.internal_info.source',?) WHERE id=?")
        .run(sample.agent??null,sample.app??null,sample.session??null,sample.conversation??null,sample.info??null,sample.internal??null,item.id);
      expect(service.panelItems({layer:"L1"}).items.find(row=>row.id===item.id)?.metadata?.source).toBe(sample.display);
      expect(service.panelItems({layer:"L1",sourceAgent:sample.filter}).items.map(row=>row.id)).toContain(item.id);
      const browse=await service.browsePanel({op:"create",filter:{layer:"L1",sourceAgent:sample.filter}},{});
      expect("items" in browse && browse.items?.map(row=>row.id)).toContain(item.id);
    }
    db.close();
  });

  it("ignores malformed non-string source metadata just as the display does", () => {
    const {db,service}=createTestService();
    const item=service.addMemory({content:"legacy malformed producer",source:"fixture",layer:"L1"});
    db.db.prepare("UPDATE memories SET agent_id='memmy', session_id='codex-legacy', info_json=json_set(info_json,'$.source',json(?)), properties_json=json_set(properties_json,'$.internal_info.source',json(?)) WHERE id=?")
      .run(JSON.stringify({unexpected:"object"}),JSON.stringify(["cursor"]),item.id);
    expect(service.panelItems({layer:"L1"}).items[0]?.metadata?.source).toBe("codex");
    expect(service.panelItems({layer:"L1",sourceAgent:"codex"}).items.map(row=>row.id)).toEqual([item.id]);
    expect(service.panelOverviewSummary().sourceDistribution).toEqual([{source:"codex",count:1,percentage:100}]);
    db.close();
  });

  it("matches user memories and tasks recorded under a related Agent source", async () => {
    const { db, service } = createTestService();
    const namespace = { source: "memmy", profileId: "default", userId: "local-user" };
    const session = service.openSession({ namespace });
    const completed = (await service.completeTurn("turn-panel-agent-filter-user-memory", {
      sessionId: session.sessionId,
      query: "我喜欢简洁代码，不要写不必要的兜底逻辑",
      answer: "好的，我会记住。"
    }));
    expect(completed.userMemoryIds).toHaveLength(1);

    expect(service.panelItems({
      layer: "UserMemory",
      userId: "local-user",
      sourceAgent: "memmy-agent"
    }).items.map((item) => item.id)).toEqual(completed.userMemoryIds);

    expect(service.panelTasks({ namespace, sourceAgent: "memmy-agent" }).tasks.map((task) => task.id))
      .toEqual([assignedEpisodeId(service, completed)]);
    db.close();
  });
});
