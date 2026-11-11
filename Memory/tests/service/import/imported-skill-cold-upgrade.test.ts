import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { SqliteVecStore } from "../../../src/storage/sqlite-vec-store.js";
import { agentSkillConnectionKey, agentSkillInstallationsKey, importedSkillContentHash } from "../../../src/storage/imported-skill.js";
import type { MemoryAddRequest, MemoryRow } from "../../../src/types.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { replayRound6ManualCollision, replayRound9UnverifiedArchive } from "../../fixtures/round6-manual-collision.js";
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

  it.each([false, true])("excludes cold Round-9 archive/restore laundered missing skills from recall, count, listSkills and embedding while allowing reobserved=%s", async reobserved => {
    const embedded: string[] = [];
    const { db, service } = fixture.createTestService({
      llm: { ...createFailingLlm(), isConfigured: () => false },
      embedder: createCapturingEmbedder(embedded)
    });
    const repos = new Repositories(db.db);
    const hermesScan = (skills: Array<{ sourceSkillId: string; sourceSkillPath: string; title: string; content: string; contentHash: string; modifiedAt: string }>) =>
      service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills });
    const id = hermesScan([{
      sourceSkillId: "deploy-helper",
      sourceSkillPath: "/synthetic/hermes/deploy-helper/SKILL.md",
      title: "deploy-helper",
      content: fileText,
      contentHash: importedSkillContentHash(fileText),
      modifiedAt: "2026-11-01T00:00:00.000Z"
    }]).skills[0]!.memoryId!;
    const foreignId = service.reconcileAgentSkills({
      namespace: { ...namespace, source: "claude_code" },
      sourceAgentId: "claude_code",
      complete: true,
      skills: [{
        sourceSkillId: "deploy-helper",
        sourceSkillPath: "/synthetic/claude/deploy-helper/SKILL.md",
        title: "deploy-helper",
        content: fileText,
        contentHash: importedSkillContentHash(fileText),
        modifiedAt: "2026-10-31T00:00:00.000Z"
      }]
    }).skills[0]!.memoryId!;

    // Complete scan observes hermes file missing, then Round 6 collides, then Round 9 archive->restore launders cold row to activated!
    hermesScan([]);
    const beforeCollision = repos.memories.getIncludingDeleted(id)!;
    expect(beforeCollision.properties.internal_info.archive_reason).toBe("source_missing");
    const manualId = replayRound6ManualCollision(
      service,
      repos,
      {
        namespace,
        source: "hermes",
        layer: "Skill",
        title: "tool-note",
        turnId: "deploy-helper",
        content: "Manual note."
      },
      "2026-11-01T12:00:00.000Z"
    );
    expect(repos.memories.getIncludingDeleted(id)!.properties.internal_info.superseded_by_skill_id).toBe(manualId);

    replayRound9UnverifiedArchive(repos, id, manualId, "2026-11-02T00:00:00.000Z");
    const archivedByR9 = repos.memories.getIncludingDeleted(id)!;
    const launderedInternal = { ...archivedByR9.properties.internal_info };
    delete launderedInternal.archive_reason;
    const laundered = repos.memories.update({
      ...archivedByR9,
      status: "activated",
      updatedAt: "2026-11-02T01:00:00.000Z",
      properties: { ...archivedByR9.properties, status: "activated", internal_info: launderedInternal }
    });
    repos.runtime.appendChange({
      memoryId: id,
      userId: archivedByR9.userId,
      kind: "skill",
      op: "activated",
      changeType: "restore",
      source: "panel.restore",
      createdAt: "2026-11-02T01:00:00.000Z",
      before: archivedByR9,
      after: laundered
    });

    if (reobserved) {
      hermesScan([{
        sourceSkillId: "deploy-helper",
        sourceSkillPath: "/synthetic/hermes/deploy-helper/SKILL.md",
        title: "deploy-helper",
        content: fileText,
        contentHash: importedSkillContentHash(fileText),
        modifiedAt: "2026-11-03T00:00:00.000Z"
      }]);
    }
    embedded.length = 0;

    // Cold read before reconcileWorkerStartup:
    expect(repos.isImportedSkillEligibleForRecall(repos.memories.getIncludingDeleted(id)!, "cursor")).toBe(reobserved);
    expect(repos.isImportedSkillEligibleForEmbedding(repos.memories.getIncludingDeleted(id)!)).toBe(reobserved);
    const listedIds = service.listSkills({ namespace: { ...namespace, source: "cursor" } }).skills.map(skill => skill.id);
    expect(listedIds.includes(id)).toBe(reobserved);
    expect(listedIds).toContain(foreignId);

    const recalled = await service.search({
      namespace: { ...namespace, source: "cursor" },
      query: "deploymentquartz",
      layers: ["Skill"],
      limit: 10
    });
    expect(recalled.hits.map(hit => hit.id)).toEqual([reobserved ? id : foreignId]);
  });

  it("redacts restricted and pending cold imported skills in getMemory, getSkill and panelItems while preserving eligible and user-archived reads", async () => {
    const { db, service } = fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder([]) });
    const repos = new Repositories(db.db);
    const secretMarker = "COLD-RESTRICTED-SECRET-BODY";
    const eligibleMarker = "COLD-ELIGIBLE-PUBLIC-BODY";

    const addCold = (source: string, name: string, body: string, extraInternal: Record<string, unknown> = {}) => {
      const created = service.addMemory({
        namespace: { ...namespace, source },
        source,
        layer: "Skill",
        title: name,
        content: body,
        sourceAgentId: source,
        sourceSkillId: name,
        sourceSkillPath: `/synthetic/${source}/${name}/SKILL.md`,
        sourceContentHash: importedSkillContentHash(body),
        deferProcessing: true
      });
      const raw = repos.memories.getIncludingDeleted(created.id)!;
      const legacyInternal: MemoryRow["properties"]["internal_info"] = {
        ...raw.properties.internal_info,
        has_supporting_files: true,
        ...extraInternal
      };
      delete legacyInternal.import_state_version;
      delete legacyInternal.archive_reason;
      delete legacyInternal.source_state;
      delete legacyInternal.invocation;
      repos.memories.updateMaintenance({
        ...raw,
        status: "activated",
        memoryValue: body,
        info: { ...raw.info, summary: `Summary ${body.includes(secretMarker) ? secretMarker : eligibleMarker}` },
        properties: { ...raw.properties, status: "activated", internal_info: legacyInternal }
      });
      return created.id;
    };

    const archivedId = service.reconcileAgentSkills({
      namespace: { ...namespace, source: "openclaw" },
      sourceAgentId: "openclaw",
      complete: true,
      skills: [{
        sourceSkillId: "archived-helper",
        sourceSkillPath: "/synthetic/openclaw/archived-helper/SKILL.md",
        title: "archived-helper",
        content: `---\nname: archived-helper\ndescription: archived desc\n---\nArchived body.`,
        contentHash: importedSkillContentHash(`---\nname: archived-helper\ndescription: archived desc\n---\nArchived body.`),
        modifiedAt: "2026-11-01T00:00:00.000Z",
        hasSupportingFiles: true
      }]
    }).skills[0]!.memoryId!;
    service.archiveMemory(archivedId, { namespace: { ...namespace, source: "openclaw" } });

    const coldDisabledId = addCold(
      "opencode",
      "cold-disabled",
      `---\nname: cold-disabled\ndescription: disabled desc\ndisable-model-invocation: true\n---\n${secretMarker}`
    );
    const coldBrokenId = addCold(
      "hermes",
      "cold-broken",
      `---\nname: [unterminated\n---\n${secretMarker}`
    );
    const coldCodexUnobservedId = addCold(
      "codex",
      "cold-codex",
      `---\nname: cold-codex\ndescription: codex desc\n---\n${secretMarker}`
    );
    const coldPendingId = addCold(
      "cursor",
      "cold-pending",
      `---\nname: cold-pending\ndescription: pending desc\n---\n${secretMarker}`,
      { source_review_required: true }
    );
    const coldEligibleId = addCold(
      "hermes",
      "cold-eligible",
      `---\nname: cold-eligible\ndescription: eligible desc\n---\n${eligibleMarker}`
    );

    for (const restrictedId of [coldDisabledId, coldBrokenId, coldCodexUnobservedId, coldPendingId]) {
      const memDetail = service.getMemory(restrictedId, { namespace: { ...namespace, source: "claude_code" } });
      expect(JSON.stringify(memDetail)).not.toContain(secretMarker);
      expect(memDetail.body).not.toContain("source dir:");
      const skillDetail = service.getSkill(restrictedId, { namespace: { ...namespace, source: "claude_code" } });
      expect(JSON.stringify(skillDetail)).not.toContain(secretMarker);
      // Cold SQLite row remains unmutated by pure read projections
      expect(repos.memories.getIncludingDeleted(restrictedId)!.memoryValue).toContain(secretMarker);
    }

    const vectorRead = vi.spyOn(SqliteVecStore.prototype, "getMany").mockImplementation(() => {
      throw new Error("Cold Skill display must not hydrate vectors");
    });
    try {
      const panel = service.panelItems({ namespace, layer: "Skill", page: 1, limit: 50 });
      expect(JSON.stringify(panel)).not.toContain(secretMarker);
      expect(panel.items.find(item => item.id === coldEligibleId)?.summary).toContain(eligibleMarker);
      expect(panel.items.find(item => item.id === archivedId)?.status).toBe("archived");
      const filtered = service.panelItems({ namespace, layer: "Skill", q: secretMarker, limit: 50 });
      expect(JSON.stringify(filtered)).not.toContain(secretMarker);
      const fixed = await service.browsePanel({ op: "create", filter: { section: "items", layer: "Skill" } }, { namespace });
      expect(JSON.stringify(fixed)).not.toContain(secretMarker);
      if (!("viewId" in fixed)) throw new Error("Expected a fixed Skill view");
      expect(JSON.stringify(await service.browsePanel({ op: "page", viewId: fixed.viewId, page: 1 }, { namespace })))
        .not.toContain(secretMarker);
      expect(vectorRead).not.toHaveBeenCalled();
    } finally { vectorRead.mockRestore(); }

    // Positive controls: eligible skill includes body + supporting source dir; user-archived skill keeps archived status without source dir
    const eligibleDetail = service.getMemory(coldEligibleId, { namespace: { ...namespace, source: "claude_code" } });
    expect(eligibleDetail.body).toContain(eligibleMarker);
    expect(eligibleDetail.body).toContain("source dir: /synthetic/hermes/cold-eligible");

    const archivedDetail = service.getMemory(archivedId, { namespace: { ...namespace, source: "openclaw" } });
    expect(archivedDetail.status).toBe("archived");
    expect(archivedDetail.body).not.toContain("source dir:");

    // Complete scan marking a restricted cold row source_missing also scrubs SQLite and logs
    service.reconcileAgentSkills({
      namespace: { ...namespace, source: "opencode" },
      sourceAgentId: "opencode",
      complete: true,
      skills: []
    });
    expect(repos.memories.getIncludingDeleted(coldDisabledId)!.memoryValue).toBe("");
    expect(JSON.stringify(service.getMemory(coldDisabledId, { namespace: { ...namespace, source: "claude_code" } }))).not.toContain(secretMarker);
  });

});
