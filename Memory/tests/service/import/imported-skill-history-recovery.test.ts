import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { agentSkillInstallationsKey, currentImportedSkillVersion, importedSkillContentHash,
  type AgentSkillInstallations } from "../../../src/storage/imported-skill.js";
import { replayRound6ManualCollision, replayRound9UnverifiedArchive } from "../../fixtures/round6-manual-collision.js";
import type { MemoryRow } from "../../../src/types.js";
import { createFailingLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const namespace = { source: "hermes", profileId: "default", userId: "history-user" };
const body = "---\nname: source-skill\ndescription: Safe deploymentquartz.\n---\nVerify deploymentquartz before release.";
const time = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
function setup() {
  const { db, service } = fixture.createTestService({ llm: createFailingLlm() });
  const repos = new Repositories(db.db);
  const scan = (content = body, source = "hermes") => service.reconcileAgentSkills({
    namespace: { ...namespace, source }, sourceAgentId: source, complete: true,
    skills: [{ sourceSkillId: "source-directory", sourceSkillPath: `/synthetic/${source}/source-directory/SKILL.md`,
      title: "source-skill", content, contentHash: importedSkillContentHash(content), modifiedAt: time(1) }] });
  const file = scan().skills[0]!.memoryId!;
  const other = scan(body, "claude_code").skills[0]!.memoryId!;
  const row = (id: string) => repos.memories.getIncludingDeleted(id)!;
  const missing = () => service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [] });
  const collide = (title = "manual-title", turn = "source-directory") => replayRound6ManualCollision(service, repos,
    { namespace, source: "hermes", layer: "Skill", title, turnId: turn, content: `Ordinary ${title} note.` }, time(4));
  const stored = () => repos.runtime.getKv(agentSkillInstallationsKey("hermes"))?.value as AgentSkillInstallations;
  const search = () => service.search({ namespace, query: "deploymentquartz", layers: ["Skill"], limit: 10 });
  return { db, service, repos, row, scan, file, other, missing, collide, stored, search };
}

describe("chronological legacy imported Skill history", () => {
  it.each(["empty", "partial", "manual-title", "source-skill"])("recovers overwritten absence with %s inventory without mutating a cold read", async inventory => {
    const { db, service, repos, row, file, other, missing, collide, stored, search, scan } = setup();
    missing();
    const manual = collide(inventory === "source-skill" ? "source-skill" : "manual-title");
    const contamination = stored();
    repos.runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1,
      skills: [...(["manual-title", "source-skill"].includes(inventory) ? contamination.skills : []),
        ...(inventory !== "empty" ? [{ sourceSkillId: "other-file", normalizedName: "keep-other" }] : [])],
      registrations: [{ sourceSkillId: "plugin:known", normalizedName: "keep-plugin" }] });
    const last = db.db.prepare("SELECT change_type, before_json, after_json FROM memory_change_log WHERE memory_id = ? ORDER BY seq DESC LIMIT 1").get(file) as any;
    expect(last.change_type).toBe("read_only_skill_superseded");
    expect(JSON.parse(last.before_json).properties.internal_info.archive_reason).toBe("source_missing");
    expect(JSON.parse(last.after_json).properties.internal_info.superseded_by_skill_id).toBe(manual);
    const before = stored();
    expect(repos.memories.resolveLegacyImportedSkillVersion(row(file)).properties.internal_info.source_state).toBe("source_missing");
    const resolved = repos.memories.resolvedSkillInstallationsForAgent("hermes");
    expect(resolved.skills.some(entry => entry.sourceSkillId === "source-directory")).toBe(false);
    expect(resolved.registrations).toEqual(before.registrations);
    expect((await search()).hits.some(hit => hit.id === other)).toBe(true);
    expect(stored()).toEqual(before);
    service.deleteMemory(file, { namespace });
    expect(row(file).properties.internal_info.deleted_current).toBe(false);
    expect(stored().skills.some(entry => entry.sourceSkillId === "source-directory")).toBe(false);
    expect(scan(body + "\nNew release bytes.").skills[0]?.outcome).toBe("created");
  });

  it("uses the latest same-row source observation even when imported_at is unchanged", () => {
    const { repos, service, file, row, missing, scan, collide } = setup();
    const importedAt = row(file).properties.internal_info.imported_at;
    missing();
    scan();
    expect(row(file).properties.internal_info.imported_at).toBe(importedAt);
    collide();
    expect(repos.memories.resolveLegacyImportedSkillVersion(row(file)).properties.internal_info.source_state).not.toBe("source_missing");
    expect(repos.memories.resolvedSkillInstallationsForAgent("hermes").skills).toContainEqual({ sourceSkillId: "source-directory", normalizedName: "source-skill" });
    service.deleteMemory(file, { namespace });
    expect(row(file).properties.internal_info.deleted_current).toBe(true);
    expect(scan(body + "\nNew bytes.").skills[0]?.outcome).toBe("deleted_by_user");
  });

  it("walks past maintenance and soft-deletion snapshots without restoring body or user deletion", () => {
    const { repos, file, row, missing, collide } = setup();
    missing(); collide();
    const before = row(file);
    const maintained = repos.memories.updateMaintenance({ ...before, updatedAt: time(5) });
    repos.runtime.appendChange({ memoryId: file, userId: before.userId, changeType: "maintenance", source: "synthetic-maintenance",
      createdAt: time(5), before, after: maintained });
    const deleted = repos.memories.softDelete(file, time(6))!;
    repos.runtime.appendChange({ memoryId: file, userId: before.userId, changeType: "delete", source: "memory.delete",
      createdAt: time(6), before: maintained, after: deleted });
    repos.runtime.scrubImportedSkillCopies(file);
    const resolved = repos.memories.resolveLegacyImportedSkillVersion(row(file));
    expect(resolved.status).toBe("deleted");
    expect(resolved.deletedAt).toBe(time(6));
    expect(resolved.properties.internal_info.source_state).toBe("source_missing");
  });

  it("preserves user archive intent overwritten by the false supersession", () => {
    const { service, repos, file, row, collide } = setup();
    service.archiveMemory(file, { namespace });
    collide();
    const resolved = repos.memories.resolveLegacyImportedSkillVersion(row(file));
    expect(resolved.properties.internal_info.archive_reason).toBe("user");
    service.reconcileWorkerStartup(1);
    expect(row(file).properties.internal_info.archive_reason).toBe("user");
  });

  it("restores a genuine historical successor hidden by a later manual collision", () => {
    const { repos, file, row, scan, collide } = setup();
    const next = scan(body + "\nSecond revision.").skills[0]!.memoryId!;
    expect(row(file).properties.internal_info.superseded_by_skill_id).toBe(next);
    collide();
    const resolved = repos.memories.listImportedSkillsForSource("hermes").map(memory => repos.memories.resolveLegacyImportedSkillVersion(memory));
    expect(resolved.find(memory => memory.id === file)?.properties.internal_info.superseded_by_skill_id).toBe(next);
    expect(currentImportedSkillVersion(resolved)?.id).toBe(next);
  });

  it.each(["", "unknown-successor"])("retains an unproven historical marker %s", successor => {
    const { repos, file, row } = setup();
    const before = row(file);
    const modified = repos.memories.updateMaintenance({ ...before, status: "archived", properties: { ...before.properties,
      internal_info: { ...before.properties.internal_info, archive_reason: "superseded", superseded_by_skill_id: successor } } });
    expect(repos.memories.resolveLegacyImportedSkillVersion(modified)).toEqual(modified);
  });

  it.each(["pruned", "new-epoch"])("does not infer missing from partial inventory when evidence is %s", kind => {
    const { db, repos, file, row, missing, collide } = setup();
    missing(); collide();
    if (kind === "pruned") db.db.prepare("DELETE FROM memory_change_log WHERE memory_id = ?").run(file);
    else {
      const before = row(file);
      repos.memories.updateMaintenance({ ...before, properties: { ...before.properties,
        internal_info: { ...before.properties.internal_info, imported_at: time(7) } } });
    }
    repos.runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1,
      skills: [{ sourceSkillId: "other-file", normalizedName: "keep-other" }], registrations: [] });
    expect(repos.memories.resolveLegacyImportedSkillVersion(row(file)).properties.internal_info.source_state).not.toBe("source_missing");
    expect(repos.memories.resolvedSkillInstallationsForAgent("hermes").skills).toEqual(expect.arrayContaining([
      { sourceSkillId: "source-directory", normalizedName: "source-skill" }, { sourceSkillId: "other-file", normalizedName: "keep-other" }
    ]));
  });

  it.each([false, true])("recovers a pointerless R9 archive while later real reobservation=%s", reobserved => {
    const { repos, service, row, file, missing, collide, scan } = setup();
    missing();
    const manual = collide();
    replayRound9UnverifiedArchive(repos, file, manual, time(5));
    expect(row(file).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    expect(row(file).properties.internal_info.source_state).toBe("present");
    expect(repos.memories.listImportedSkillsWithLegacyCollisionHistory(100).some(memory => memory.id === file)).toBe(true);
    expect(repos.memories.resolveLegacyImportedSkillVersion(row(file)).properties.internal_info.source_state).toBe("source_missing");
    if (reobserved) scan();
    service.reconcileWorkerStartup(1);
    expect(row(file).properties.internal_info.source_state).toBe(reobserved ? "present" : "source_missing");
    expect(row(file).properties.internal_info.archive_reason).toBe("user");
    service.deleteMemory(file, { namespace });
    expect(row(file).properties.internal_info.deleted_current).toBe(reobserved);
    expect(scan(body + "\nNew post-upgrade content.").skills[0]?.outcome).toBe(reobserved ? "deleted_by_user" : "created");
  });

  it.each(["absent", "reobserved", "pruned-reobservation"] as const)("separates user intent from source facts across repeated old-writer collisions: %s", mode => {
    const { db, repos, service, row, file, missing, collide, scan } = setup();
    missing();
    const firstManual = collide("first-manual");
    replayRound9UnverifiedArchive(repos, file, firstManual, time(5));
    if (mode !== "absent") {
      scan();
      if (mode === "pruned-reobservation") {
        db.db.prepare("DELETE FROM memory_change_log WHERE memory_id = ? AND seq = (SELECT MAX(seq) FROM memory_change_log WHERE memory_id = ?)").run(file, file);
      }
    }
    collide("second-manual");
    const projected = repos.memories.resolveLegacyImportedSkillVersion(row(file));
    expect(projected.properties.internal_info.archive_reason).toBe("user");
    expect(projected.properties.internal_info.source_state).toBe(mode === "absent" ? "source_missing"
      : mode === "reobserved" ? "present" : "source_review_pending");
    service.reconcileWorkerStartup(1);
    expect(row(file).properties.internal_info.archive_reason).toBe("user");
    expect(row(file).properties.internal_info.source_state).toBe(mode === "absent" ? "source_missing" : "source_review_pending");
    service.deleteMemory(file, { namespace });
    expect(row(file).properties.internal_info.deleted_current).toBe(mode !== "absent");
    expect(scan(body + "\nNew bytes after repeated collision.").skills[0]?.outcome)
      .toBe(mode === "absent" ? "created" : "deleted_by_user");
  });

  it.each([false, true])("projects the proven source fact beneath inherited-path ambiguity, missing=%s", absent => {
    const { repos, service, row, file, missing } = setup();
    if (absent) missing();
    const manual = replayRound6ManualCollision(service, repos, { namespace, source: "hermes", layer: "Skill",
      title: "phantom-title", turnId: "source-directory", content: "Ordinary manual procedure." }, time(4), { inheritedPath: true });
    expect(row(manual).properties.internal_info.source_skill_path).toBe(row(file).properties.internal_info.source_skill_path);
    const projected = repos.memories.resolveLegacyImportedSkillVersion(row(manual));
    expect(projected.properties.internal_info.read_only).toBe(true);
    expect(projected.properties.internal_info.source_kind).toBe("skill");
    expect(projected.properties.internal_info.source_review_required).toBe(true);
    expect(projected.properties.internal_info.source_state).toBe(absent ? "source_missing" : "source_review_pending");
    const inventory = repos.memories.resolvedSkillInstallationsForAgent("hermes");
    expect(inventory.skills).toEqual(absent ? [] : [{ sourceSkillId: "source-directory", normalizedName: "source-skill" }]);
  });

  it("does not recover a stale manual absence across a newer source epoch", () => {
    const { repos, file, row, missing, collide } = setup();
    missing();
    const manualId = collide();
    const manual = row(manualId);
    repos.memories.updateMaintenance({ ...manual, updatedAt: time(2), properties: { ...manual.properties,
      internal_info: { ...manual.properties.internal_info, archive_reason: "source_missing" } } });
    const source = row(file);
    const newer = repos.memories.updateMaintenance({ ...source, properties: { ...source.properties,
      internal_info: { ...source.properties.internal_info, imported_at: time(7) } } });
    expect(repos.memories.resolveLegacyImportedSkillVersion(newer).properties.internal_info.source_state).not.toBe("source_missing");
  });

  it("bounds normalized legacy disconnect checks to the partial evidence index", () => {
    const { db } = setup();
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM memories AS source_connection_evidence
      WHERE source_connection_evidence.memory_layer = 'Skill'
        AND json_extract(source_connection_evidence.properties_json, '$.internal_info.read_only') = 1
        AND memmy_imported_skill_agent_id(json_extract(source_connection_evidence.properties_json, '$.internal_info.source_agent_id')) = ?
        AND (json_extract(source_connection_evidence.properties_json, '$.internal_info.archive_reason') = 'disconnected'
          OR json_extract(source_connection_evidence.properties_json, '$.internal_info.source_state') = 'disconnected')`).all("hermes") as Array<{ detail: string }>;
    expect(plan.map(step => step.detail)).toEqual(expect.arrayContaining([expect.stringContaining("idx_memories_legacy_skill_disconnect")]));
  });

  it("creates the memory-id history index when reopening an existing schema version", () => {
    const root = fixture.createTestRoot("history-index-");
    const first = new MemoryDb({ path: `${root}/memory.sqlite` });
    first.db.exec("DROP INDEX IF EXISTS idx_memory_change_log_memory_seq");
    first.close();
    const reopened = new MemoryDb({ path: `${root}/memory.sqlite` });
    try {
      const plan = reopened.db.prepare("EXPLAIN QUERY PLAN SELECT before_json, after_json FROM memory_change_log WHERE memory_id = ? ORDER BY seq DESC").all("synthetic") as Array<{ detail: string }>;
      expect(plan.some(step => step.detail.includes("idx_memory_change_log_memory_seq"))).toBe(true);
    } finally { reopened.close(); }
  });

  it.each([false, true])("repairs deleted_current on pre-upgrade soft-deleted collision victims according to source presence (absent=%s)", async absent => {
    const { db, service, repos, row, file, missing, collide, scan, search, other } = setup();
    if (absent) missing();
    const manual = collide("manual-before-delete");
    // Simulate a soft-delete written by Round 6 / Round 9 while superseded_by_skill_id pointed to the manual collision
    const polluted = row(file);
    const softDeleted = repos.memories.softDelete(file, time(5))!;
    const legacyDeleted: MemoryRow = {
      ...softDeleted,
      memoryValue: "",
      properties: {
        ...softDeleted.properties,
        status: "deleted",
        internal_info: {
          ...softDeleted.properties.internal_info,
          deleted_current: false,
          superseded_by_skill_id: manual
        }
      }
    };
    repos.memories.rewriteDeletedRow(legacyDeleted);
    repos.runtime.appendChange({
      memoryId: file,
      userId: polluted.userId,
      changeType: "delete",
      source: "panel.delete",
      createdAt: time(5),
      before: polluted,
      after: legacyDeleted
    });
    repos.runtime.scrubImportedSkillCopies(file);

    service.reconcileWorkerStartup(1);
    expect(row(file).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    expect(row(file).properties.internal_info.deleted_current).toBe(!absent);

    const nextScan = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "hermes",
      complete: true,
      skills: [{
        sourceSkillId: "source-directory",
        sourceSkillPath: "/synthetic/hermes/source-directory/SKILL.md",
        title: "source-skill",
        content: body + "\nVersion 2 after upgrade.",
        contentHash: importedSkillContentHash(body + "\nVersion 2 after upgrade."),
        modifiedAt: time(6)
      }]
    });
    expect(nextScan.skills[0]?.outcome).toBe(absent ? "created" : "deleted_by_user");
    const listedIds = service.listSkills({ namespace: { ...namespace, source: "cursor" } }).skills.map(skill => skill.id);
    if (absent) {
      expect(listedIds).toContain(nextScan.skills[0]!.memoryId!);
    } else {
      expect(listedIds).not.toContain(file);
    }
    const hermesRecall = await search();
    expect(hermesRecall.hits.map(hit => hit.id)).toEqual([]);
    const foreignRecall = await service.search({
      namespace: { ...namespace, source: "cursor" },
      query: "deploymentquartz",
      layers: ["Skill"],
      limit: 10
    });
    expect(foreignRecall.hits.map(hit => hit.id)).toContain(absent ? nextScan.skills[0]!.memoryId! : other);
    void db;
  });

  it("repairs every live and deleted collision victim in one startup pass under pruned history and small batch sizes", () => {
    const { db, service } = fixture.createTestService({ llm: createFailingLlm() });
    const repos = new Repositories(db.db);
    const skills = Array.from({ length: 6 }, (_, index) => {
      const id = `skill-${index + 1}`;
      const content = `---\nname: ${id}\ndescription: Desc ${id}.\n---\nBody ${id}.`;
      return {
        sourceSkillId: id,
        sourceSkillPath: `/synthetic/hermes/${id}/SKILL.md`,
        title: id,
        content,
        contentHash: importedSkillContentHash(content),
        modifiedAt: `2026-01-01T00:0${index}:00.000Z`
      };
    });
    const importedIds = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "hermes",
      complete: true,
      skills
    }).skills.map(entry => entry.memoryId!);

    const manualIds = importedIds.map((_, index) =>
      replayRound6ManualCollision(
        service,
        repos,
        {
          namespace,
          source: "hermes",
          layer: "Skill",
          title: `manual-${index + 1}`,
          turnId: `skill-${index + 1}`,
          content: `Manual note ${index + 1}`
        },
        `2026-01-02T00:0${index}:00.000Z`,
        { inheritedPath: true }
      )
    );

    // Pre-upgrade soft-delete on even indices (0, 2, 4) so repairing them drops them out of the WHERE set
    for (const evenIndex of [0, 2, 4]) {
      const targetId = importedIds[evenIndex]!;
      const soft = repos.memories.softDelete(targetId, time(5))!;
      repos.memories.rewriteDeletedRow({
        ...soft,
        memoryValue: "",
        properties: {
          ...soft.properties,
          status: "deleted",
          internal_info: {
            ...soft.properties.internal_info,
            deleted_current: false,
            superseded_by_skill_id: manualIds[evenIndex]
          }
        }
      });
    }
    db.db.prepare("DELETE FROM memory_change_log").run();

    // Batch size 2 forces 3 keyset pages; previously OFFSET pagination skipped odd-indexed live victims!
    service.reconcileWorkerStartup(2);

    for (const [index, id] of importedIds.entries()) {
      const repaired = repos.memories.getIncludingDeleted(id)!;
      expect(repaired.properties.internal_info.superseded_by_skill_id).toBeUndefined();
      if (index % 2 === 0) {
        expect(repaired.status).toBe("deleted");
        expect(repaired.properties.internal_info.deleted_current).toBe(true);
      } else {
        expect(repaired.status).toBe("archived");
        expect(repaired.properties.internal_info.archive_reason).toBe("source_review_pending");
      }
    }
  });
});
