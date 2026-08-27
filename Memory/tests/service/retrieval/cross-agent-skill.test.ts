import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

describe("cross-Agent read-only Skill retrieval", () => {
  it("[BC-23] excludes the current Agent source and recalls another Agent source with provenance", async () => {
    const { db, service } = createTestService();
    const userId = "cross-agent-skill-user";
    const session = service.openSession({
      namespace: { source: "agent-a", profileId: "default", userId }
    });
    const own = service.addMemory({
      namespace: { source: "agent-a", profileId: "default", userId },
      requestId: "scan-own-skill",
      layer: "Skill",
      title: "sqlite migration checklist",
      content: "Inspect the sqlite schema, apply the migration, then run the focused migration test.",
      source: "agent-a",
      sourceAgentId: "agent-a",
      sourceSkillId: "skill-x",
      sourceSkillVersion: "1"
    });
    const other = service.addMemory({
      namespace: { source: "agent-a", profileId: "default", userId },
      requestId: "scan-other-skill",
      layer: "Skill",
      title: "sqlite migration verification",
      content: "Inspect the sqlite schema, apply the migration, then verify the migration with focused tests.",
      source: "agent-b",
      sourceAgentId: "agent-b",
      sourceSkillId: "skill-y",
      sourceSkillVersion: "7"
    });
    await runWorkerRounds(service, 2, 50);

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "sqlite schema migration focused test",
      layers: ["Skill"],
      limit: 5,
      includeInjectedContext: true
    });

    expect(recall.hits.map((hit) => hit.id)).not.toContain(own.id);
    expect(recall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: other.id,
        sourceAgentId: "agent-b",
        sourceSkillId: "skill-y",
        sourceSkillVersion: "7",
        readOnly: true
      })
    ]));
    expect(recall.injectedContext.markdown).toContain("source agent: agent-b");
    expect(recall.injectedContext.markdown).toContain("source skill: skill-y");
    expect(recall.injectedContext.markdown).toContain("source version: 7");
    db.close();
  });

  it("[BC-24][BC-27 external] versions changed scanned Skills and does not restore a locally deleted version", () => {
    const { db, service } = createTestService();
    const namespace = { source: "agent-a", profileId: "default", userId: "skill-version-user" };
    const base = {
      namespace,
      layer: "Skill" as const,
      title: "external review skill",
      source: "agent-b",
      sourceAgentId: "agent-b",
      sourceSkillId: "review-skill"
    };
    const v1 = service.addMemory({
      ...base,
      requestId: "skill-v1",
      sourceSkillVersion: "1",
      content: "Review the changed file and run its focused test."
    });
    const v2 = service.addMemory({
      ...base,
      requestId: "skill-v2",
      sourceSkillVersion: "2",
      content: "Review the changed file, run typecheck, then run its focused test."
    });

    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(v1.id))
      .toEqual({ status: "archived" });
    expect(db.db.prepare(
      `SELECT json_extract(properties_json, '$.internal_info.superseded_by_skill_id') AS target
       FROM memories WHERE id = ?`
    ).get(v1.id)).toEqual({ target: v2.id });

    service.deleteMemory(v2.id, { namespace });
    const replay = service.addMemory({
      ...base,
      requestId: "skill-v2-replay",
      sourceSkillVersion: "2",
      content: "Review the changed file, run typecheck, then run its focused test."
    });
    expect(replay).toMatchObject({ id: v2.id, status: "deleted" });
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM memories
       WHERE json_extract(properties_json, '$.internal_info.source_skill_id') = 'review-skill'`
    ).get()).toEqual({ count: 2 });
    db.close();
  });
});
