import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / governance / provenance and supersession", () => {
  it("carries the agent lifecycle protocol provenance into captured L1 memory", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "main",
      userId: "lifecycle-provenance-user",
      workspacePath: "/work/lifecycle-provenance"
    };
    const opened = service.openSession({
      namespace,
      source: "codex",
      sessionId: "lifecycle-provenance-session",
      workspacePath: namespace.workspacePath,
      protocolVersion: "memmy.agent.v1",
      adapterId: "memmy-codex-hook",
      requestId: "codex-open:lifecycle"
    });
    const started = await service.startTurn({
      namespace,
      protocolVersion: "memmy.agent.v1",
      adapterId: "memmy-codex-hook",
      requestId: "codex-start:lifecycle",
      sessionId: opened.sessionId,
      turnId: "lifecycle-turn",
      query: "Capture the adapter provenance",
      provenance: {
        repository: "/work/memmy-agent",
        branch: "feature/protocol",
        commit: "abc123def456",
        sourceMemoryIds: [],
        sourceAgent: "codex",
        capturedAt: "2026-08-04T10:00:00.000Z"
      }
    });
    const completed = service.completeTurn(started.turnId, {
      namespace,
      protocolVersion: "memmy.agent.v1",
      adapterId: "memmy-codex-hook",
      requestId: "codex-complete:lifecycle",
      sessionId: opened.sessionId,
      query: "Capture the adapter provenance",
      answer: "The lifecycle provenance is now captured.",
      sourceMemoryIds: started.sourceMemoryIds,
      provenance: {
        repository: "/work/memmy-agent",
        branch: "feature/protocol",
        commit: "abc123def456",
        sourceMemoryIds: started.sourceMemoryIds,
        sourceAgent: "codex",
        capturedAt: "2026-08-04T10:01:00.000Z"
      }
    });

    const detail = service.getMemory(completed.l1MemoryId, { namespace }) as {
      provenance?: Record<string, unknown>;
    };
    expect(detail.provenance).toMatchObject({
      sourceAgent: "codex",
      adapterId: "memmy-codex-hook",
      requestId: "codex-complete:lifecycle",
      workspacePath: "/work/lifecycle-provenance",
      sessionId: opened.sessionId,
      turnId: "lifecycle-turn",
      repository: "/work/memmy-agent",
      branch: "feature/protocol",
      commit: "abc123def456",
      sourceMemoryIds: started.sourceMemoryIds
    });
    const rawTurn = db.db.prepare(
      "SELECT message_payload_json FROM raw_turns WHERE id = ?"
    ).get(completed.rawTurnId) as { message_payload_json: string };
    expect(JSON.parse(rawTurn.message_payload_json)).toMatchObject({
      turn_start: { protocolVersion: "memmy.agent.v1" },
      turn_complete: { protocolVersion: "memmy.agent.v1" }
    });
    db.close();
  });

  it("records provenance and supersedes an older memory without deleting its history", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "main",
      userId: "governance-user",
      workspacePath: "/work/governance-project"
    };
    const old = service.addMemory({
      namespace,
      source: "codex",
      layer: "L2",
      title: "Old migration policy",
      content: "Use the old migration procedure for the legacy database.",
      adapterId: "codex-memory-hook",
      requestId: "add-old",
      provenance: {
        repository: "memmy-agent",
        branch: "main",
        commit: "abc123"
      }
    });
    const replacement = service.addMemory({
      namespace: { ...namespace, source: "pi", profileId: "pi-main" },
      source: "pi",
      layer: "L2",
      title: "Current migration policy",
      content: "Use the current migration procedure and verify the SQLite backup.",
      tags: ["architecture"],
      adapterId: "pi-memory-extension",
      requestId: "add-new",
      supersedesMemoryId: old.id,
      supersessionReason: "The old procedure predates the SQLite migration.",
      sourceMemoryIds: [old.id],
      provenance: {
        repository: "memmy-agent",
        branch: "feature/governance",
        commit: "def456"
      }
    });

    const oldDetail = service.getMemory(old.id, { namespace }) as Extract<ReturnType<typeof service.getMemory>, { id: string }> & { supersession?: unknown; provenance?: unknown };
    const newDetail = service.getMemory(replacement.id, { namespace }) as Extract<ReturnType<typeof service.getMemory>, { id: string }> & { supersession?: unknown; provenance?: unknown; relations?: Array<Record<string, unknown>> };
    expect(oldDetail.status).toBe("archived");
    expect(oldDetail.supersession).toMatchObject({
      supersededByMemoryId: replacement.id,
      reason: "The old procedure predates the SQLite migration."
    });
    expect(newDetail.supersession).toMatchObject({
      supersedesMemoryIds: [old.id],
      reason: "The old procedure predates the SQLite migration."
    });
    expect(newDetail.provenance).toMatchObject({
      sourceAgent: "pi",
      adapterId: "pi-memory-extension",
      requestId: "add-new",
      repository: "memmy-agent",
      branch: "feature/governance",
      commit: "def456",
      sourceMemoryIds: [old.id]
    });
    expect(newDetail.relations).toEqual([
      expect.objectContaining({
        sourceMemoryId: replacement.id,
        targetMemoryId: old.id,
        relation: "supersedes"
      })
    ]);

    const contextPack = service.projectContextPack({ namespace });
    expect(contextPack.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: replacement.id }),
      expect.objectContaining({ id: old.id, external: true })
    ]));
    expect(contextPack.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: old.id, targetId: replacement.id, relation: "source" }),
      expect.objectContaining({ sourceId: replacement.id, targetId: old.id, relation: "supersedes" })
    ]));

    const relations = db.db.prepare(
      `SELECT source_memory_id, target_memory_id, relation, reason
       FROM memory_relations
       WHERE source_memory_id = ?`
    ).all(replacement.id) as Array<Record<string, string>>;
    expect(relations).toEqual([expect.objectContaining({
      source_memory_id: replacement.id,
      target_memory_id: old.id,
      relation: "supersedes"
    })]);

    const recall = await service.search({
      namespace,
      query: "old migration procedure legacy database",
      layers: ["L2"],
      limit: 10
    });
    expect(recall.hits.map((hit) => hit.id)).not.toContain(old.id);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'supersede'").get()).toMatchObject({ count: 1 });
    db.close();
  });
});
