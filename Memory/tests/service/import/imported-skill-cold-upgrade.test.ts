import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { agentSkillConnectionKey, agentSkillInstallationsKey, importedSkillContentHash } from "../../../src/storage/imported-skill.js";
import type { MemoryAddRequest } from "../../../src/types.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const namespace = { source: "hermes", profileId: "default", userId: "cold-upgrade-user" };
const fileText = "---\nname: deploy-helper\ndescription: Deploy quartz safely.\n---\nVerify deploymentquartz before release.";
const fileRequest = (overrides: Partial<MemoryAddRequest> = {}): MemoryAddRequest => ({
  namespace, source: "hermes", layer: "Skill", title: "deploy-helper", content: fileText,
  sourceAgentId: "hermes", sourceSkillId: "deploy-helper", sourceSkillPath: "/synthetic/hermes/deploy-helper/SKILL.md", ...overrides
});
function setup(withPrevious = false) {
  const { db, service } = fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder([]) });
  const repos = new Repositories(db.db);
  const ids = withLegacyImportedSkillWriter(service, () => {
    const previous = withPrevious ? service.addMemory(fileRequest({ content: fileText + "\nOld revision." })).id : undefined;
    const file = service.addMemory(fileRequest()).id;
    const other = service.addMemory(fileRequest({ sourceAgentId: "claude_code", source: "claude_code",
      namespace: { ...namespace, source: "claude_code" }, sourceSkillPath: "/synthetic/claude/deploy-helper/SKILL.md" })).id;
    const manual = service.addMemory({ namespace, source: "hermes", layer: "Skill", title: "tool-note",
      turnId: "deploy-helper", content: "An ordinary manually saved note." }).id;
    return { file, other, manual, previous };
  });
  const row = (id: string) => repos.memories.getIncludingDeleted(id)!;
  const inventory = () => repos.runtime.getKv(agentSkillInstallationsKey("hermes"))?.value as
    { version: number; skills: Array<{ sourceSkillId: string; normalizedName: string }>; registrations: Array<{ sourceSkillId: string; normalizedName: string }> } | undefined;
  expect(row(ids.file).properties.internal_info.superseded_by_skill_id).toBe(ids.manual);
  expect(inventory()).toBeUndefined();
  const scan = (body = fileText, complete = false) => service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete,
    skills: [{ sourceSkillId: "deploy-helper", sourceSkillPath: "/synthetic/hermes/deploy-helper/SKILL.md", title: "deploy-helper",
      content: body, contentHash: importedSkillContentHash(body), modifiedAt: "2026-11-01T00:00:00.000Z" }] });
  const search = () => service.search({ namespace, query: "deploymentquartz", layers: ["Skill"], limit: 10 });
  return { db, service, repos, row, inventory, scan, search, ...ids };
}

describe("pure old-writer collision before startup or any directory scan", () => {
  it("suppresses a native name during cold search without persisting invented inventory", async () => {
    const { search, other, inventory } = setup();
    const recalled = await search();
    expect(recalled.hits.map(hit => hit.id)).not.toContain(other);
    expect(inventory()).toBeUndefined();
  });

  it("keeps current-source deletion and installed identity across startup and newer content", () => {
    const { service, row, file, inventory, scan } = setup();
    service.deleteMemory(file, { namespace });
    expect(row(file).properties.internal_info.deleted_current).toBe(true);
    expect(inventory()?.skills).toContainEqual({ sourceSkillId: "deploy-helper", normalizedName: "deploy-helper" });
    expect(row(file).memoryValue).toBe("");
    for (let round = 0; round < 2; round++) service.reconcileWorkerStartup(1);
    expect(scan(fileText + "\nA newer release procedure.").skills[0]?.outcome).toBe("deleted_by_user");
    expect(row(file).properties.internal_info.deleted_current).toBe(true);
  });

  it("retains a cold user archive after startup and a later source update", () => {
    const { service, row, file, scan } = setup();
    service.archiveMemory(file, { namespace });
    expect(row(file).properties.internal_info.archive_reason).toBe("user");
    service.reconcileWorkerStartup(1);
    scan();
    expect(row(file)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
    const updated = scan(fileText + "\nNew content.").skills[0]!.memoryId!;
    expect(row(updated)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
  });

  it("restores an explicit user archive only after the repaired source is observed", () => {
    const { service, repos, row, file, scan } = setup();
    const archived = row(file);
    repos.memories.updateMaintenance({ ...archived, properties: { ...archived.properties,
      internal_info: { ...archived.properties.internal_info, archive_reason: "user", source_state: "present" } } });
    expect(service.reactivateSkill(file, { namespace }).status).toBe("archived");
    expect(row(file).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    expect(scan().skills[0]?.memoryId).toBe(file);
    service.archiveMemory(file, { namespace });
    expect(service.reactivateSkill(file, { namespace }).status).toBe("activated");
    expect(row(file).status).toBe("activated");
  });

  it("preserves the colliding file identity when a sibling direct import is the first new write", async () => {
    const { service, file, row, inventory, search, other } = setup();
    service.addMemory(fileRequest({ title: "other-skill", sourceSkillId: "other-skill",
      sourceSkillPath: "/synthetic/hermes/other-skill/SKILL.md", content: "Other skill body." }));
    expect(inventory()?.skills).toEqual(expect.arrayContaining([
      { sourceSkillId: "deploy-helper", normalizedName: "deploy-helper" },
      { sourceSkillId: "other-skill", normalizedName: "other-skill" }
    ]));
    expect(row(file).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    service.reconcileWorkerStartup(1);
    expect((await search()).hits.map(hit => hit.id)).not.toContain(other);
  });

  it("backfills a prior incomplete v1 inventory when repairing the old collision", async () => {
    const { repos, service, inventory, search, other } = setup();
    repos.runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1,
      skills: [{ sourceSkillId: "other-skill", normalizedName: "other-skill" }],
      registrations: [{ sourceSkillId: "plugin:pack/tool", normalizedName: "plugin-tool" }] });
    service.reconcileWorkerStartup(1);
    expect(inventory()?.skills).toEqual(expect.arrayContaining([
      { sourceSkillId: "deploy-helper", normalizedName: "deploy-helper" },
      { sourceSkillId: "other-skill", normalizedName: "other-skill" }
    ]));
    expect(inventory()?.registrations).toEqual([{ sourceSkillId: "plugin:pack/tool", normalizedName: "plugin-tool" }]);
    expect((await search()).hits.map(hit => hit.id)).not.toContain(other);
    const before = inventory();
    service.reconcileWorkerStartup(1);
    expect(inventory()).toEqual(before);
  });

  it("does not restore a genuinely missing installation or make its deletion source-wide", () => {
    const { service, repos, row, file, scan, inventory } = setup();
    const missing = row(file);
    repos.memories.updateMaintenance({ ...missing, properties: { ...missing.properties,
      internal_info: { ...missing.properties.internal_info, source_state: "source_missing" } } });
    repos.runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1, skills: [], registrations: [] });
    service.deleteMemory(file, { namespace });
    service.reconcileWorkerStartup(1);
    expect(row(file).properties.internal_info.deleted_current).toBe(false);
    expect(inventory()?.skills).toEqual([]);
    expect(scan(fileText + "\nA newly installed version.").skills[0]?.outcome).toBe("created");
  });

  it.each([false, true])("recovers overwritten absence only until a later source observation, reobserved=%s", async reobserved => {
    const { service, repos, row, file, manual, scan, search, other, inventory } = setup();
    scan(fileText, true);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [] });
    if (reobserved) withLegacyImportedSkillWriter(service, () => service.addMemory(fileRequest()));
    withLegacyImportedSkillWriter(service, () => service.addMemory({ namespace, source: "hermes", layer: "Skill", title: "tool-note",
      turnId: "deploy-helper", content: "An ordinary manually saved note." }));
    // Reproduce the intermediate writer that erased both missing fields while
    // recording the same invalid successor. Its earlier audit snapshot survives.
    const before = row(file);
    repos.memories.updateMaintenance({ ...before, status: "archived", properties: { ...before.properties,
      status: "archived", internal_info: { ...before.properties.internal_info, archive_reason: "superseded",
        source_state: undefined, superseded_by_skill_id: manual } } });
    const stored = inventory();
    expect((await search()).hits.some(hit => hit.id === other)).toBe(!reobserved);
    expect(inventory()).toEqual(stored);
    service.deleteMemory(file, { namespace });
    expect(row(file).properties.internal_info.deleted_current).toBe(reobserved);
    service.reconcileWorkerStartup(1);
    expect(scan(fileText + "\nNew source bytes.").skills[0]?.outcome).toBe(reobserved ? "deleted_by_user" : "created");
  });

  it("releases the recovered installation only after a complete absence observation", async () => {
    const { service, file, inventory, search, other } = setup();
    service.deleteMemory(file, { namespace });
    service.reconcileWorkerStartup(1);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: false, skills: [] });
    expect(inventory()?.skills).toContainEqual({ sourceSkillId: "deploy-helper", normalizedName: "deploy-helper" });
    expect((await search()).hits.map(hit => hit.id)).not.toContain(other);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [] });
    expect(inventory()?.skills).toEqual([]);
    expect((await search()).hits.map(hit => hit.id)).toContain(other);
  });
  it("uses collision evidence during a cold read even when an earlier write stored a partial inventory", async () => {
    const { repos, search, inventory, other } = setup();
    const stored = { version: 1, skills: [{ sourceSkillId: "other-skill", normalizedName: "other-skill" }], registrations: [] };
    repos.runtime.setKv(agentSkillInstallationsKey("hermes"), stored);
    expect((await search()).hits.map(hit => hit.id)).not.toContain(other);
    expect(inventory()).toEqual(stored);
  });

  it("still treats a genuine older file version as content-only after the manual collision is repaired", () => {
    const { service, previous, row, scan } = setup(true);
    service.deleteMemory(previous!, { namespace });
    expect(row(previous!).properties.internal_info.deleted_current).toBe(false);
    service.reconcileWorkerStartup(1);
    expect(scan(fileText + "\nA third revision.").skills[0]?.outcome).toBe("created");
    expect(scan(fileText + "\nOld revision.").skills[0]?.outcome).toBe("deleted_by_user");
  });

  it("rolls back source repair together with a failed cold archive intent write", () => {
    const { db, service, file } = setup();
    const snapshot = () => ({
      memories: db.db.prepare("SELECT id, status, version, properties_json, updated_at FROM memories ORDER BY id").all(),
      kv: db.db.prepare("SELECT * FROM runtime_kv ORDER BY key").all()
    });
    const before = snapshot();
    db.db.exec(`CREATE TRIGGER fail_cold_user_archive BEFORE UPDATE ON memories
      WHEN NEW.id = '${file}' AND json_extract(NEW.properties_json, '$.internal_info.archive_reason') = 'user'
      BEGIN SELECT RAISE(ABORT, 'intent_write_blocked'); END`);
    expect(() => service.archiveMemory(file, { namespace })).toThrow("intent_write_blocked");
    expect(snapshot()).toEqual(before);
  });

  it.each([false, true])("uses legacy row-level disconnect evidence until explicitReconnect=%s", async explicitReconnect => {
    const { service, repos, row, manual } = setup();
    const old = row(manual);
    repos.memories.updateMaintenance({ ...old, properties: { ...old.properties,
      internal_info: { ...old.properties.internal_info, source_state: "disconnected" } } });
    // The old writer could publish a later file while another old row still
    // carried the source's disconnect. No new connection KV existed yet.
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory(fileRequest({
      content: fileText + "\nA later old-writer observation." }))).id;
    expect(row(id).status).toBe("activated");
    expect(repos.runtime.getKv(agentSkillConnectionKey("hermes"))).toBeUndefined();
    if (explicitReconnect) repos.runtime.setKv(agentSkillConnectionKey("hermes"), "connected");
    const result = await service.search({ namespace: { ...namespace, source: "cursor" },
      query: "deploymentquartz", layers: ["Skill"], limit: 10 });
    expect(result.hits.some(hit => hit.id === id)).toBe(explicitReconnect);
  });

});
