import { createHash } from "node:crypto";
import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAgentSkillInventory } from "@memmy/agent-source-core";
import { MemoryDb } from "../../../src/index.js";
import { MemoryRepository, Repositories } from "../../../src/storage/repositories.js";
import type { AgentSkillReconcileSkill } from "../../../src/service/import/agent-skill-library.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });
const userId = "installed-skill-review-user";
const namespace = { source: "codex", profileId: "default", userId };
const query = "debug a failing sqlite migration";
type Service = ReturnType<typeof fixture.createTestService>["service"];

function constantEmbedder() {
  return { ...createCapturingEmbedder([]),
    async embed(texts: string[]) { return texts.map(() => [1, 0, 0]); },
    async embedOne() { return [1, 0, 0]; }
  };
}
function skill(name: string, sourceSkillId = name): AgentSkillReconcileSkill {
  const content = `Diagnose a failing sqlite migration with ${name}.`;
  return { title: name, sourceSkillId, sourceSkillPath: `/synthetic/${sourceSkillId}/SKILL.md`, content,
    contentHash: createHash("sha256").update(content).digest("hex"), modifiedAt: "2026-06-01T00:00:00.000Z" };
}
function reconcile(service: Service, sourceAgentId: string, skills: AgentSkillReconcileSkill[], complete = true) {
  return service.reconcileAgentSkills({ namespace: { ...namespace, source: sourceAgentId }, sourceAgentId, skills, complete });
}
async function hits(service: Service): Promise<string[]> {
  const session = service.openSession({ namespace });
  return (await service.search({ sessionId: session.sessionId, query, layers: ["Skill"], limit: 10 })).hits.map(hit => hit.id);
}
async function scan(service: Service, root: string, complete?: boolean) {
  const inventory = await readAgentSkillInventory(root);
  return reconcile(service, "codex", inventory.items.map(item => ({ ...item, title: item.name ?? item.sourceSkillId })), complete ?? inventory.complete);
}

describe("installed Skill identity independent of memory deletion", () => {
  it("keeps excluding an installed source after deletion and only releases its name after a complete missing scan", async () => {
    const { service, db, root } = fixture.createTestService({ embedder: constantEmbedder() });
    const skillsRoot = join(root, "skills");
    const directory = join(skillsRoot, "debugging");
    const path = join(directory, "SKILL.md");
    await mkdir(directory, { recursive: true });
    const writeSource = async () => {
      await writeFile(path, "---\nname: debugging\ndescription: Diagnose failing sqlite migrations.\n---\nDebug a failing sqlite migration.");
      await utimes(path, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    };
    await writeSource();
    const own = (await scan(service, skillsRoot)).skills[0]!.memoryId!;
    const other = reconcile(service, "hermes", [skill("debugging")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    expect(await hits(service)).not.toContain(other);

    service.deleteMemory(own, { namespace });
    expect(await hits(service)).not.toContain(other);
    // An upgraded database can already have a tombstone but no source inventory.
    db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'agent-skill-installations:%'").run();
    expect((await scan(service, skillsRoot)).skills[0]?.outcome).toBe("deleted_by_user");
    expect(await hits(service)).not.toContain(other);

    await unlink(path);
    await scan(service, skillsRoot, false);
    expect(await hits(service)).not.toContain(other);
    await scan(service, skillsRoot);
    expect(await hits(service)).toContain(other);

    await writeSource();
    expect((await scan(service, skillsRoot)).skills[0]?.outcome).toBe("deleted_by_user");
    expect(await hits(service)).not.toContain(other);
    const rows = new Repositories(db.db).memories.listImportedSkillsForSource("codex");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: own, status: "deleted", memoryValue: "" });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?").get(own)).toEqual({ n: 0 });
    expect(new Repositories(db.db).memories.hasVector(own, "vec")).toBe(false);
  });

  it("tracks a new installed name without restoring a deleted source record", async () => {
    const { service, db } = fixture.createTestService({ embedder: constantEmbedder() });
    const own = reconcile(service, "codex", [skill("old-name", "stable-directory")]).skills[0]!.memoryId!;
    const [oldCopy, newCopy] = reconcile(service, "hermes", [skill("old-name"), skill("new-name")]).skills;
    await runWorkerRounds(service, 2, 50);
    service.deleteMemory(own, { namespace });
    expect(reconcile(service, "codex", [skill("new-name", "stable-directory")]).skills[0]?.outcome).toBe("deleted_by_user");
    const recalled = await hits(service);
    expect(recalled).toContain(oldCopy!.memoryId);
    expect(recalled).not.toContain(newCopy!.memoryId);
    expect(new Repositories(db.db).memories.getIncludingDeleted(own)).toMatchObject({ status: "deleted", memoryValue: "" });
  });

  it("persists installed names across reopening the database", async () => {
    const { service, db, root } = fixture.createTestService({ embedder: constantEmbedder() });
    const own = reconcile(service, "codex", [skill("debugging")]).skills[0]!.memoryId!;
    const other = reconcile(service, "hermes", [skill("debugging")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    service.deleteMemory(own, { namespace });
    reconcile(service, "codex", [skill("debugging")]);
    await service.stop();
    db.close();
    const reopened = fixture.createTestMemoryService({ db: new MemoryDb({ path: join(root, "memory.sqlite") }), embedder: constantEmbedder(), mode: "dev" });
    expect(await hits(reopened)).not.toContain(other);
  });

  it("seeds a first partial scan from legacy installed records", async () => {
    const { service, db } = fixture.createTestService({ embedder: constantEmbedder() });
    reconcile(service, "codex", [skill("first"), skill("second")]);
    const other = reconcile(service, "hermes", [skill("second")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'agent-skill-installations:%'").run();
    reconcile(service, "codex", [skill("first")], false);
    expect(await hits(service)).not.toContain(other);
    reconcile(service, "codex", [skill("first")]);
    expect(await hits(service)).toContain(other);
  });

  it.each([
    { label: "partial scan", disconnected: false, nameField: "name" },
    { label: "disconnect with title fallback", disconnected: true, nameField: "title" },
    { label: "partial scan with empty normalized name", disconnected: false, nameField: "empty" }
  ])("seeds unmigrated legacy installations before a $label", async ({ disconnected, nameField }) => {
    const { service, db } = fixture.createTestService({ embedder: constantEmbedder() });
    const sourceSkill = skill("  Debug__Migrations  ", "legacy-directory");
    const legacy = service.addMemory({
      namespace, adapterId: "agent-source:codex", layer: "Skill", title: sourceSkill.title,
      content: sourceSkill.content, source: "codex", sourceAgentId: "codex",
      sourceSkillId: sourceSkill.sourceSkillId, sourceContentHash: sourceSkill.contentHash
    });
    if (nameField === "title") {
      db.db.prepare("UPDATE memories SET properties_json = json_remove(properties_json, '$.internal_info.name') WHERE id = ?").run(legacy.id);
    }
    if (nameField === "empty") {
      db.db.prepare("UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.normalized_name', '') WHERE id = ?").run(legacy.id);
    }
    const other = reconcile(service, "hermes", [skill("debug-migrations")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    expect(new Repositories(db.db).memories.get(legacy.id)?.properties.internal_info).not.toHaveProperty("import_state_version");

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", skills: [], complete: false, disconnected });
    expect(await hits(service)).not.toContain(other);
    service.reconcileWorkerStartup();
    expect(await hits(service)).not.toContain(other);
    reconcile(service, "codex", []);
    expect(await hits(service)).toContain(other);
  });

  it.each([
    { label: "user archive", supersededBy: null, recallOther: false },
    { label: "superseded archive", supersededBy: "current-version", recallOther: true },
    { label: "superseded archive with an empty marker", supersededBy: "", recallOther: true }
  ])("preserves the installation meaning of an unmigrated $label", async ({ supersededBy, recallOther }) => {
    const { service, db } = fixture.createTestService({ embedder: constantEmbedder() });
    const sourceSkill = skill("debugging");
    const legacy = service.addMemory({
      namespace, adapterId: "agent-source:codex", layer: "Skill", title: sourceSkill.title,
      content: sourceSkill.content, source: "codex", sourceAgentId: "codex",
      sourceSkillId: sourceSkill.sourceSkillId, sourceContentHash: sourceSkill.contentHash
    });
    db.db.prepare(`UPDATE memories SET status = 'archived', properties_json = json_set(properties_json,
      '$.status', 'archived', '$.internal_info.superseded_by_skill_id', ?) WHERE id = ?`).run(supersededBy, legacy.id);
    const other = reconcile(service, "hermes", [skill("debugging")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    expect(new Repositories(db.db).memories.get(legacy.id)?.properties.internal_info).not.toHaveProperty("import_state_version");

    reconcile(service, "codex", [], false);
    expect((await hits(service)).includes(other)).toBe(recallOther);
    service.reconcileWorkerStartup();
    expect((await hits(service)).includes(other)).toBe(recallOther);
    reconcile(service, "codex", []);
    expect(await hits(service)).toContain(other);
  });

  it.each([
    { label: "two active versions", names: ["old-name", "current-name"], archivedOld: false, reverse: false },
    { label: "reversed unordered reads", names: ["old-name", "current-name"], archivedOld: false, reverse: true },
    { label: "a more recent user archive", names: ["old-name", "current-name"], archivedOld: true, reverse: false },
    { label: "a reused name", names: ["current-name", "old-name", "current-name"], archivedOld: false, reverse: true }
  ])("selects the current legacy name with $label before and after seeding", async ({ names, archivedOld, reverse }) => {
    const { service, db } = fixture.createTestService({ embedder: constantEmbedder() });
    for (const [index, title] of names.entries()) {
      const content = `Diagnose a failing sqlite migration with ${title}, version ${index}.`;
      const version = service.addMemory({
        namespace, adapterId: "agent-source:codex", layer: "Skill", title, content,
        source: "codex", sourceAgentId: "codex", sourceSkillId: "stable-directory",
        sourceContentHash: createHash("sha256").update(content).digest("hex")
      });
      const status = archivedOld && index === 0 ? "archived" : "activated";
      const importedAt = archivedOld && index === 0 ? "2026-12-01T00:00:00.000Z" : `2026-01-0${index + 1}T00:00:00.000Z`;
      // Old databases can contain several active versions without lifecycle metadata.
      db.db.prepare(`UPDATE memories SET status = ?, properties_json = json_set(
        json_remove(properties_json, '$.internal_info.superseded_by_skill_id'),
        '$.status', ?, '$.internal_info.imported_at', ?) WHERE id = ?`).run(status, status, importedAt, version.id);
    }
    // Importing a later version archives earlier active versions. Restore the old database shape.
    if (!archivedOld) {
      db.db.prepare(`UPDATE memories SET status = 'activated', properties_json = json_set(
        json_remove(properties_json, '$.internal_info.superseded_by_skill_id'), '$.status', 'activated')
        WHERE json_extract(properties_json, '$.internal_info.source_agent_id') = 'codex'`).run();
    }
    const [oldCopy, currentCopy] = reconcile(service, "hermes", [skill("old-name"), skill("current-name")]).skills;
    await runWorkerRounds(service, 2, 50);
    if (reverse) db.db.pragma("reverse_unordered_selects = ON");

    expect(await hits(service)).toEqual([oldCopy!.memoryId]);
    reconcile(service, "codex", [], false);
    expect(await hits(service)).toEqual([oldCopy!.memoryId]);
    service.reconcileWorkerStartup();
    expect(await hits(service)).toEqual([oldCopy!.memoryId]);
    reconcile(service, "codex", []);
    expect(await hits(service)).toEqual(expect.arrayContaining([oldCopy!.memoryId, currentCopy!.memoryId]));
  });

  it.each([
    { label: "disconnect", complete: false, disconnected: true, observed: false, sourceState: "disconnected" },
    { label: "complete missing scan", complete: true, disconnected: false, observed: false, sourceState: "source_missing" },
    { label: "observed skill", complete: false, disconnected: false, observed: true, sourceState: "present" }
  ])("keeps legacy user archives through a $label before startup migration", async ({ complete, disconnected, observed, sourceState }) => {
    const { service, db } = fixture.createTestService({ embedder: constantEmbedder() });
    const sourceSkill = skill("debugging");
    const legacy = service.addMemory({
      namespace, adapterId: "agent-source:codex", layer: "Skill", title: sourceSkill.title,
      content: sourceSkill.content, source: "codex", sourceAgentId: "codex",
      sourceSkillId: sourceSkill.sourceSkillId, sourceContentHash: sourceSkill.contentHash
    });
    db.db.prepare(`UPDATE memories SET status = 'archived', properties_json = json_set(properties_json,
      '$.status', 'archived') WHERE id = ?`).run(legacy.id);
    const repos = new Repositories(db.db);
    expect(repos.memories.get(legacy.id)?.properties.internal_info).not.toHaveProperty("import_state_version");

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete, disconnected, skills: observed ? [sourceSkill] : [] });
    expect(repos.memories.get(legacy.id)).toMatchObject({ status: "archived", memoryValue: sourceSkill.content });
    service.reconcileWorkerStartup();
    expect(repos.memories.get(legacy.id)?.properties.internal_info).toMatchObject({ archive_reason: "user", source_state: sourceState });
    reconcile(service, "codex", [sourceSkill]);
    expect(repos.memories.get(legacy.id)).toMatchObject({ status: "archived", memoryValue: sourceSkill.content,
      properties: { internal_info: { archive_reason: "user", source_state: "present" } } });
    await runWorkerRounds(service, 2, 50);
    const session = service.openSession({ namespace: { ...namespace, source: "hermes" } });
    const recalled = await service.search({ sessionId: session.sessionId, query, layers: ["Skill"], limit: 10 });
    expect(recalled.hits.map(hit => hit.id)).not.toContain(legacy.id);
    expect(repos.memories.hasVector(legacy.id, "vec")).toBe(false);
  });

  it("retains plugin names during partial scans and disconnect, then releases removed plugins", async () => {
    const { service } = fixture.createTestService({ embedder: constantEmbedder() });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [],
      registrations: [{ sourceSkillId: "plugin:tools/debugging", sourceSkillPath: "/synthetic/plugin/SKILL.md", name: "debugging" }], registrationsComplete: true });
    const other = reconcile(service, "hermes", [skill("debugging")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, skills: [], disconnected: true });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [], registrations: [], registrationsComplete: false });
    expect(await hits(service)).not.toContain(other);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [], registrations: [], registrationsComplete: true });
    expect(await hits(service)).toContain(other);
  });

  it("records source installation even when writing its imported memory fails", async () => {
    const { service } = fixture.createTestService({ embedder: constantEmbedder() });
    const other = reconcile(service, "hermes", [skill("debugging")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    vi.spyOn(MemoryRepository.prototype, "insert").mockImplementationOnce(() => { throw new Error("synthetic write failure"); });
    expect(reconcile(service, "codex", [skill("debugging")]).skills[0]?.outcome).toBe("failed");
    vi.restoreAllMocks();
    expect(await hits(service)).not.toContain(other);
  });

  it("rolls installation state back with a failed reconciliation transaction", async () => {
    const { service } = fixture.createTestService({ embedder: constantEmbedder() });
    reconcile(service, "codex", [skill("alpha")]);
    const [alpha, beta] = reconcile(service, "hermes", [skill("alpha"), skill("beta")]).skills;
    await runWorkerRounds(service, 2, 50);
    const insert = MemoryRepository.prototype.insert;
    vi.spyOn(MemoryRepository.prototype, "insert").mockImplementation(function (this: MemoryRepository, memory) {
      if (memory.properties.internal_info.source_kind === "plugin") throw new Error("synthetic registration failure");
      return insert.call(this, memory);
    });
    expect(() => service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("beta")],
      registrations: [{ sourceSkillId: "plugin:tools/review", sourceSkillPath: "/synthetic/plugin/SKILL.md", name: "review" }], registrationsComplete: true }))
      .toThrow("synthetic registration failure");
    vi.restoreAllMocks();
    const recalled = await hits(service);
    expect(recalled).not.toContain(alpha!.memoryId);
    expect(recalled).toContain(beta!.memoryId);
  });

});
