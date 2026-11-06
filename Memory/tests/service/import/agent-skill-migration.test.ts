import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configWithMemoryGates, createFailingLlm, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { IMPORTED_SKILL_STATE_VERSION } from "../../../src/storage/imported-skill.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

const namespace = { source: "claude_code", profileId: "default", userId: "skill-migration-user" };

type Service = ReturnType<typeof createTestService>["service"];
type Db = ReturnType<typeof createTestService>["db"];

/** Replays generic lifecycle migration without adding a Codex sidecar precondition. */
function legacyImport(service: Service, sourceSkillId: string, content: string): string {
  return withLegacyImportedSkillWriter(service, () => service.addMemory({
    namespace,
    requestId: `legacy:${sourceSkillId}:${content}`,
    adapterId: "agent-source:hermes",
    layer: "Skill",
    title: sourceSkillId,
    content,
    source: "hermes",
    sourceAgentId: "hermes",
    sourceSkillId,
    sourceSkillPath: `/home/me/.hermes/skills/${sourceSkillId}/SKILL.md`,
    sourceContentHash: createHash("sha256").update(content).digest("hex")
  }).id);
}

function row(db: Db, id: string): { status: string; memory_value: string; reason: string | null; version: number | null; updated_at: string } {
  return db.db.prepare(
    `SELECT status, memory_value, updated_at,
       json_extract(properties_json, '$.internal_info.archive_reason') AS reason,
       json_extract(properties_json, '$.internal_info.import_state_version') AS version
     FROM memories WHERE id = ?`
  ).get(id) as { status: string; memory_value: string; reason: string | null; version: number | null; updated_at: string };
}

describe("imported skill migration at startup", () => {
  it("brings old records to the current state once and keeps unchanged ones untouched", () => {
    const { db, service } = createTestService();
    const older = legacyImport(service, "openai-docs", "Version A.");
    const newer = legacyImport(service, "openai-docs", "Version B.");
    // The old importer could leave two versions of one file active.
    db.db.prepare(`UPDATE memories SET status = 'activated', properties_json = json_set(properties_json, '$.status', 'activated') WHERE id = ?`).run(older);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.imported_at', '2026-01-01T00:00:00.000Z') WHERE id = ?`).run(older);
    const manual = legacyImport(service, "memmy-resume", "---\nname: memmy-resume\ndisable-model-invocation: true\n---\nResume.\n");
    const archivedByUser = legacyImport(service, "old-archive", "Archived body.");
    db.db.prepare(`UPDATE memories SET status = 'archived', properties_json = json_set(properties_json, '$.status', 'archived') WHERE id = ?`).run(archivedByUser);
    const deleted = legacyImport(service, "deleted", "DELETED-BODY-91c2 text.");
    db.db.prepare(`UPDATE memories SET status = 'deleted', deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = ?`).run(deleted);
    db.db.prepare(`INSERT INTO api_logs (tool_name, input_json, output_json, called_at) VALUES ('memory_search', '{}', ?, '2026-02-01T00:00:00.000Z')`)
      .run(JSON.stringify({ candidates: [{ refId: deleted, content: "DELETED-BODY-91c2 text.", snippet: "DELETED-BODY-91c2" }] }));
    const newerUpdatedAt = row(db, newer).updated_at;

    service.reconcileWorkerStartup();

    expect(row(db, newer)).toMatchObject({ status: "activated", reason: null, version: IMPORTED_SKILL_STATE_VERSION, updated_at: newerUpdatedAt });
    expect(row(db, older)).toMatchObject({ status: "archived", reason: "superseded", version: IMPORTED_SKILL_STATE_VERSION });
    expect(row(db, manual)).toMatchObject({ status: "archived", reason: "invocation_policy", memory_value: "" });
    expect(row(db, archivedByUser)).toMatchObject({ status: "archived", reason: "user", memory_value: "Archived body." });
    expect(row(db, deleted)).toMatchObject({ status: "deleted", memory_value: "", version: IMPORTED_SKILL_STATE_VERSION });
    expect(db.db.prepare(`SELECT COUNT(*) AS n FROM api_logs WHERE output_json LIKE '%DELETED-BODY-91c2%'`).get()).toEqual({ n: 0 });

    const before = db.db.prepare(`SELECT id, updated_at, version, properties_json FROM memories ORDER BY id`).all();
    service.reconcileWorkerStartup();
    expect(db.db.prepare(`SELECT id, updated_at, version, properties_json FROM memories ORDER BY id`).all()).toEqual(before);
  });

  it("does not rewrite a migrated skill on the next scan when its file is unchanged", () => {
    const { db, service } = createTestService();
    const content = "Unchanged body.";
    const id = legacyImport(service, "stable", content);
    service.reconcileWorkerStartup();
    const jobs = () => (db.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?`).get(id) as { n: number }).n;
    const jobsBefore = jobs();

    const result = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "hermes",
      complete: true,
      skills: [{
        sourceSkillId: "stable",
        sourceSkillPath: "/home/me/.hermes/skills/stable/SKILL.md",
        title: "stable",
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        modifiedAt: "2026-10-01T00:00:00.000Z"
      }]
    });

    expect(result.skills[0]).toMatchObject({ outcome: "unchanged", memoryId: id });
    expect(jobs()).toBe(jobsBefore);
  });

  it("migrates existing restrictions and deleted bodies while memory capture is disabled", async () => {
    let config: ReturnType<typeof configWithMemoryGates> = LEGACY_TEST_CONFIG;
    const { db, service } = createTestService({ config, configLoader: () => ({ config }), llm: createFailingLlm() });
    const manual = legacyImport(service, "manual-only", "---\nname: manual-only\ndisable-model-invocation: true\n---\nResume sqlite maintenance with private instructions.");
    const deleted = legacyImport(service, "old-deletion", "DELETED-DISABLED-CAPTURE body.");
    const ordinary = legacyImport(service, "ordinary", "Ordinary sqlite migration instructions.");
    db.db.prepare(`UPDATE memories SET status = 'deleted', deleted_at = '2026-03-01T00:00:00.000Z' WHERE id = ?`).run(deleted);
    db.db.prepare(`INSERT INTO api_logs (tool_name, input_json, output_json, called_at)
      VALUES ('memory_search', '{}', ?, '2026-03-01T00:00:00.000Z')`).run(JSON.stringify({
      candidates: [{ refId: deleted, content: "DELETED-DISABLED-CAPTURE body." }]
    }));
    config = configWithMemoryGates({ enableMemoryAdd: false, enableQueryRewrite: false });
    service.reloadConfig({ restartFailedProcessing: false });
    expect(() => service.addMemory({ content: "New capture is disabled" })).toThrow("memory add is disabled");

    service.reconcileWorkerStartup(1);

    expect.soft(row(db, manual)).toMatchObject({ status: "archived", reason: "invocation_policy", memory_value: "", version: IMPORTED_SKILL_STATE_VERSION });
    expect.soft(row(db, deleted)).toMatchObject({ status: "deleted", memory_value: "", version: IMPORTED_SKILL_STATE_VERSION });
    expect.soft(db.db.prepare(`SELECT COUNT(*) AS n FROM api_logs WHERE output_json LIKE '%DELETED-DISABLED-CAPTURE%'`).get()).toEqual({ n: 0 });
    expect(row(db, ordinary)).toMatchObject({ status: "activated", version: IMPORTED_SKILL_STATE_VERSION });
    expect(db.db.prepare(`SELECT json_extract(properties_json, '$.internal_info.retrieval_representation_version') AS version
      FROM memories WHERE id = ?`).get(ordinary)).toEqual({ version: null });
    const session = service.openSession({ namespace });
    const recalled = await service.search({ sessionId: session.sessionId, query: "resume sqlite maintenance private instructions", layers: ["Skill"] });
    expect(recalled.hits.map(hit => hit.id)).not.toContain(manual);
  });
});
