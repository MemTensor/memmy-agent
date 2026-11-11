import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories, MemoryRepository } from "../../../src/storage/repositories.js";
import { SqliteVecStore } from "../../../src/storage/sqlite-vec-store.js";
import { attachMemoryVector, memoryVectorEntries } from "../../../src/storage/memory-vector-state.js";
import { panelListItemFromMemory } from "../../../src/service/read-model/panel.js";
import type { MemoryLayer, MemoryRow } from "../../../src/types.js";
import { createBatchReflectionLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(() => {
  vi.restoreAllMocks();
  return cleanup();
});

function memory(id: string, layer: MemoryLayer = "L1"): MemoryRow {
  const at = "2026-10-27T01:00:00.000Z";
  return {
    id,
    timeline: at,
    userId: "display-user",
    agentId: "codex",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `${layer}:${id}`,
    memoryValue: `## system\n${"metadata\n".repeat(1000)}\n## user\nReal user request\n## assistant\nFull answer`,
    tags: ["test"],
    info: { summary: "摘要排队中", tags: ["old-info-tag"] },
    properties: {
      tags: ["old-property-tag"],
      internal_info: {
        memory_layer: layer,
        memory_kind: layer === "L1" ? "trace" : layer === "L2" ? "policy" : layer === "L3" ? "world_model" : "skill",
        trace: {
          userText: "Real user request",
          agentText: "x".repeat(200_000),
          tool_calls: [{ output: "y".repeat(100_000) }]
        }
      }
    },
    memoryLayer: layer,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

describe("panel display reads", () => {
  it("reads an unassigned session timeline without hydrating vectors", async () => {
    const { service } = createTestService({llm:createBatchReflectionLlm([])});
    const session=service.openSession({namespace:{userId:"pending-display",source:"codex",profileId:"default"}});
    const turn=await service.completeTurn("pending-display-turn",{sessionId:session.sessionId,query:"Pending task display",answer:"Stored before assignment"});
    expect(turn.episodeId).toBeUndefined();
    const vectors=vi.spyOn(SqliteVecStore.prototype,"getMany").mockImplementation(()=>{throw new Error("timeline hydrated vectors");});
    const timeline=service.timeline({sessionId:session.sessionId,layers:["L1"]});
    expect(timeline.items.map(item=>item.id)).toContain(turn.l1MemoryId);
    expect(timeline.rawTurns?.map(raw=>raw.rawTurnId)).toContain(turn.rawTurnId);
    expect(vectors).not.toHaveBeenCalled();
  });

  it("keeps old display fallbacks for every layer while excluding unrelated JSON and vectors", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const samples = [
      memory("trace_legacy"),
      memory("policy_legacy", "L2"),
      memory("world_legacy", "L3"),
      memory("skill_legacy", "Skill")
    ];
    samples.push({
      ...memory("observed_legacy"),
      memoryValue: "# Activity\n\n## Memory summary\nUseful old activity summary\n\n## Evidence\ntext",
      info: { title: "Activity", summary: "# Activity" },
      properties: {
        internal_info: {
          memory_layer: "L1",
          memory_kind: "observed_activity",
          observation_memory: { schema_version: 1, status: "ready" }
        }
      }
    });
    samples.push({
      ...memory("span_legacy"),
      properties: { internal_info: { memory_layer: "L1", memory_kind: "span", span: { span_goal: "Preserve goal" } } }
    });
    for (const sample of samples)
      repos.memories.insert(attachMemoryVector(sample, { vectorField: "vec_summary", vector: [1, 0, 0] }));
    const originals = repos.memories.getMany(samples.map((item) => item.id));
    const vectorRead = vi.spyOn(SqliteVecStore.prototype, "getMany").mockImplementation(() => {
      throw new Error("display loaded vectors");
    });
    const projected = repos.memories.getManyForPanel(samples.map((item) => item.id));
    for (let i = 0; i < projected.length; i++) {
      expect(panelListItemFromMemory(repos.memories.toListItem(projected[i]!), projected[i]!)).toEqual(
        panelListItemFromMemory(repos.memories.toListItem(originals[i]!), originals[i]!)
      );
      expect(memoryVectorEntries(projected[i]!)).toEqual([]);
    }
    expect(JSON.stringify(projected)).not.toContain("x".repeat(1000));
    expect(vectorRead).not.toHaveBeenCalled();
    vectorRead.mockRestore();
    expect(memoryVectorEntries(repos.memories.get(samples[0]!.id)!)[0]?.vector).toEqual([1, 0, 0]);
    expect(
      repos.memories.searchVectorIds([1, 0, 0], "vec_summary", { memoryLayer: "L1" }, 10).map((hit) => hit.id)
    ).toContain("trace_legacy");
  });

  it("reads lists, evidence, detail, episode timeline and logs without a vector query", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const session = service.openSession({
      namespace: { source: "codex", userId: "display-user", profileId: "default" }
    });
    const turn = await service.completeTurn("display-turn", {
      sessionId: session.sessionId,
      query: "Need evidence text",
      answer: "Complete answer"
    });
    if (!turn.episodeId) throw new Error("Fixture turn must be assigned to a task");
    const trace = repos.memories.get(turn.l1MemoryId)!;
    repos.memories.update(attachMemoryVector(trace, { vectorField: "vec_summary", vector: [1, 0] }));
    repos.memories.insert({
      ...memory("policy_display", "L2"),
      properties: { internal_info: { memory_layer: "L2", memory_kind: "policy", source_memory_ids: [trace.id] } }
    });
    const vectors = vi.spyOn(SqliteVecStore.prototype, "getMany").mockImplementation(() => {
      throw new Error("display loaded vectors");
    });
    const sql = vi.spyOn(db.db, "prepare");
    expect(service.panelItems({ layer: "L1" }).items[0]?.sourceText).toBe("Need evidence text");
    expect(service.panelItems({ layer: "L2" }).items[0]?.sourceText).toBe("Need evidence text");
    expect(service.getMemory(trace.id).item.body).toContain("Complete answer");
    expect(service.getMemory(turn.episodeId).item.sourceMemoryIds).toContain(trace.id);
    expect(service.panelTasks({}).tasks[0]?.memoryIds).toContain(trace.id);
    service.apiLogs({ tools: ["memory_add"] });
    expect(vectors).not.toHaveBeenCalled();
    expect(sql.mock.calls.map(([statement]) => statement).join("\n")).not.toMatch(
      /FROM\s+(?:memory_vector|vec_memories)/i
    );
  });

  it("preserves full-text search beyond 200 rows and batches processing and historical references", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    db.db.transaction(() => {
      for (let i = 0; i < 205; i++)
        repos.memories.insert({
          ...memory(`trace_${String(i).padStart(4, "0")}`),
          memoryValue: i === 0 ? "only-full-body-needle" : "normal",
          properties: { internal_info: { memory_layer: "L1" } }
        });
    })();
    const processing = vi.spyOn(repos.processing.constructor.prototype, "get");
    const full = vi.spyOn(MemoryRepository.prototype, "get");
    const list = service.panelItems({ layer: "L1", q: "only-full-body-needle" });
    expect(list.items.map((item) => item.id)).toEqual(["trace_0000"]);
    expect(processing).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
    expect(repos.memories.existingIds(["missing", "trace_0000", "trace_0000"])).toEqual(new Set(["trace_0000"]));
    db.db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ?").run("trace_0000");
    expect(repos.memories.existingIds(["trace_0000"])).toEqual(new Set());
  });

  it("excludes legacy inline vectors before parsing details and keeps complete body and provenance", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const row = memory("trace_inline");
    repos.memories.insert(row);
    db.db
      .prepare(
        "UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.trace.vec_summary', json(?)) WHERE id = ?"
      )
      .run(JSON.stringify([1, 2, 3]), row.id);
    const displayed = repos.memories.getForDisplay(row.id)!;
    expect(displayed.memoryValue).toBe(row.memoryValue);
    expect(displayed.properties.internal_info.trace).toMatchObject({ userText: "Real user request" });
    expect(displayed.properties.internal_info.trace).not.toHaveProperty("vec_summary");
    expect(
      db.db
        .prepare(
          "SELECT json_extract(properties_json, '$.internal_info.trace.vec_summary') AS vector FROM memories WHERE id = ?"
        )
        .get(row.id)
    ).toEqual({ vector: "[1,2,3]" });
  });
});
