import { afterEach, describe, expect, it } from "vitest";
import { insertActiveSkillMemoryForTest } from "../../fixtures/evolution-fixture.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / read model / skill list", () => {
  it("paginates skill list across namespaces", () => {
    const { db, service } = createTestService();
    const namespaceA = {
      source: "codex",
      profileId: "jiang",
      userId: "skill-page-user",
      workspaceId: "workspace-skill-page-a"
    };
    const namespaceB = {
      source: "codex",
      profileId: "jiang",
      userId: "skill-page-user",
      workspaceId: "workspace-skill-page-b"
    };
    const sessionA = service.openSession({ namespace: namespaceA });
    const sessionB = service.openSession({ namespace: namespaceB });
    for (const [id, tags] of [
      ["skill_page_a_1", ["skill", "neutral_reward", "sqlite"]],
      ["skill_page_a_2", ["skill", "neutral_reward", "pytest"]],
      ["skill_page_a_3", ["skill", "neutral_reward", "sqlite"]]
    ] as const) {
      insertActiveSkillMemoryForTest(db, {
        id,
        userId: namespaceA.userId,
        sessionId: sessionA.sessionId,
        agentId: namespaceA.source,
        appId: namespaceA.workspaceId,
        profileId: namespaceA.profileId,
        tags: [...tags]
      });
    }
    insertActiveSkillMemoryForTest(db, {
      id: "skill_page_b_1",
      userId: namespaceB.userId,
      sessionId: sessionB.sessionId,
      agentId: namespaceB.source,
      appId: namespaceB.workspaceId,
      profileId: namespaceB.profileId
    });
    const infoOnlyTagRow = db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = 'skill_page_a_3'`
    ).get() as { properties_json: string };
    const infoOnlyTagProperties = JSON.parse(infoOnlyTagRow.properties_json) as {
      tags?: string[];
      info?: Record<string, unknown>;
    };
    infoOnlyTagProperties.tags = [];
    infoOnlyTagProperties.info = {
      ...(infoOnlyTagProperties.info ?? {}),
      tags: ["skill", "neutral_reward", "sqlite"]
    };
    db.db.prepare(
      `UPDATE memories
       SET tags_json = '[]',
           properties_json = ?
       WHERE id = 'skill_page_a_3'`
    ).run(JSON.stringify(infoOnlyTagProperties));

    const firstPage = service.listSkills({ namespace: namespaceA, limit: 2 });
    expect(firstPage.skills).toHaveLength(2);
    expect(firstPage.nextCursor).toBe("2");
    const secondPage = service.listSkills({ namespace: namespaceA, limit: 2, cursor: Number(firstPage.nextCursor) });
    expect(secondPage.skills).toHaveLength(2);
    expect(secondPage.nextCursor).toBeUndefined();
    const pagedIds = [...firstPage.skills, ...secondPage.skills].map((skill) => skill.id).sort();
    expect(pagedIds).toEqual(["skill_page_a_1", "skill_page_a_2", "skill_page_a_3", "skill_page_b_1"].sort());
    const sqliteSkills = service.listSkills({ namespace: namespaceA, tags: ["sqlite"], limit: 10 });
    expect(sqliteSkills.skills.map((skill) => skill.id).sort()).toEqual(["skill_page_a_1", "skill_page_a_3"]);
    expect(sqliteSkills.skills.find((skill) => skill.id === "skill_page_a_3")?.tags).toContain("sqlite");
    const pytestSkills = service.listSkills({ namespace: namespaceA, tags: ["pytest"], limit: 10 });
    expect(pytestSkills.skills.map((skill) => skill.id)).toEqual(["skill_page_a_2"]);

    db.close();
  });
});
