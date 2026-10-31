import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { PanelLogReader } from "../../../src/storage/panel-log-read.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
describe("panel logs", () => {
  it("filters a skill before pagination beyond the global window, including qualified old IDs", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const reader = new PanelLogReader(db.db);
    const skill = service.addMemory({content:"target",source:"codex"});
    repos.memories.insert({...repos.memories.get(skill.id)!,id:"skill-target",memoryKey:"skill-target",memoryLayer:"Skill"});
    for (let i = 0; i < 650; i++)
      repos.runtime.insertApiLog({
        toolName: "skill_evolve",
        sourceAgent: "codex",
        inputJson: "{}",
        outputJson: JSON.stringify({ skill_id: i < 45 ? "scope::skill-target" : "other", summary: `event-${i}` }),
        success: true,
        durationMs: 1,
        calledAt: "2026-10-27T00:00:00Z"
      });
    let result = reader.list({ skillId: "skill-target" });
    const ids = result.logs.map((log) => log.id);
    expect(result.total).toBe(45);
    expect(result.logs).toHaveLength(20);
    while (result.nextCursor) {
      result = reader.list({ skillId: "skill-target", cursor: result.nextCursor });
      ids.push(...result.logs.map((log) => log.id));
    }
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
  });
  it("searches full payloads, returns small cards, preserves full detail and Agent family filters", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const reader = new PanelLogReader(db.db);
    const full = JSON.stringify({ content: "x".repeat(100000) + "deep-match" });
    const log = repos.runtime.insertApiLog({
      toolName: "memory_add",
      sourceAgent: "memmy-onboarding",
      inputJson: full,
      outputJson: "{}",
      success: true,
      durationMs: 1,
      calledAt: "2026-10-27T00:00:00Z"
    });
    const result = reader.list({ q: "deep-match", sourceAgent: "memmy-agent" });
    expect(result.logs.map((item) => item.id)).toEqual([log.id]);
    expect(result.logs[0]!.inputJson.length).toBeLessThan(1000);
    expect(reader.detail(log.id).inputJson).toBe(full);
    expect(reader.list({ excludedSourceAgents: ["memmy-agent"] }).total).toBe(0);
  });
  it("preserves the unique search candidate count across candidates and filtered arrays", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const reader = new PanelLogReader(db.db);
    for (const id of ["same","second","third"]) { const item=service.addMemory({content:id,source:"codex"}); repos.memories.insert({...repos.memories.get(item.id)!,id,memoryKey:id}); }
    const duplicate = { refKind: "memory", refId: "same" };
    const output = {
      candidates: [duplicate, duplicate, { refKind: "memory", refId: "second" }],
      filtered: [duplicate, { refKind: "memory", refId: "third" }]
    };
    repos.runtime.insertApiLog({
      toolName: "memory_search",
      sourceAgent: "codex",
      inputJson: "{}",
      outputJson: JSON.stringify(output),
      success: true,
      durationMs: 1,
      calledAt: "2026-10-27T00:00:00Z"
    });
    expect(JSON.parse(reader.list({tools:["memory_search"]}).logs[0]!.outputJson).stats).toEqual({ ranked: 3, finalReturned: 2 });
  });
  it("does not resurrect deleted or redacted trace content through log detail", async () => {
    const {db, service} = createTestService(); const reader = new PanelLogReader(db.db);
    const session = service.openSession({namespace:{userId:"owner",source:"codex",profileId:"default"}});
    const turn = await service.completeTurn("log-turn", {sessionId:session.sessionId,query:"private question",answer:"private answer"});
    if (!turn.episodeId) throw new Error("Fixture turn must be assigned to a task");
    const log = reader.list({tools:["memory_add"]}).logs[0]!;
    expect(reader.detail(log.id).outputJson).toContain("private answer");
    service.redactRawTurn(turn.rawTurnId);
    expect(reader.list({tools:["memory_add"]}).logs).toEqual([]);
    expect(() => reader.detail(log.id)).toThrow("unavailable");
    expect(service.panelTaskDetail(turn.episodeId, {}).turns).toEqual([]);
  });

});
