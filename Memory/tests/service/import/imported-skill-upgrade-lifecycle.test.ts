import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryAddRequest, MemoryRow } from "../../../src/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/index.js";
import { embeddingTextForMemory, updateMemoryVectorField } from "../../../src/service/embedding/embedding-pipeline.js";
import type { AgentSkillReconcileSkill } from "../../../src/service/import/agent-skill-library.js";
import { IMPORTED_SKILL_RETRIEVAL_VERSION, IMPORTED_SKILL_STATE_VERSION, agentSkillConnectionKey, currentImportedSkillVersion, normalizeSkillName } from "../../../src/storage/imported-skill.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });
const namespace = { source: "codex", profileId: "default", userId: "skill-upgrade-lifecycle-user" };
type Service = ReturnType<typeof fixture.createTestService>["service"];
type Db = ReturnType<typeof fixture.createTestService>["db"];

function skill(name = "debugging", version = "v1", overrides: Partial<AgentSkillReconcileSkill> = {}): AgentSkillReconcileSkill {
  const content = `---\nname: ${name}\ndescription: Diagnose failing sqlite migrations.\n---\nDiagnose a failing sqlite migration. ${version}`;
  return { title: name, sourceSkillId: name, sourceSkillPath: `/synthetic/${name}/SKILL.md`, content,
    description: "Diagnose failing sqlite migrations.", contentHash: createHash("sha256").update(content).digest("hex"),
    modifiedAt: "2026-06-01T00:00:00.000Z", ...overrides };
}

function createService() {
  return fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder([]) });
}

function reconcile(service: Service, skills: AgentSkillReconcileSkill[], options: {
  sourceAgentId?: string; complete?: boolean; disconnected?: boolean; connectionState?: "connected" | "disconnected";
} = {}) {
  return service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills, ...options });
}

function legacy(service: Service, source: AgentSkillReconcileSkill, sourceAgentId = "codex") {
  return withLegacyImportedSkillWriter(service, () => service.addMemory({ namespace, adapterId: `agent-source:${sourceAgentId}`,
    layer: "Skill", title: source.title, content: source.content, source: sourceAgentId, sourceAgentId,
    sourceSkillId: source.sourceSkillId, sourceSkillPath: source.sourceSkillPath, sourceContentHash: source.contentHash }).id);
}

function memory(db: Db, id: string) {
  const row = new Repositories(db.db).memories.getIncludingDeleted(id);
  expect(row).toBeDefined();
  return row!;
}

function names(db: Db, sourceAgentId = "codex") {
  return [...new Repositories(db.db).listInstalledSkillNamesForAgent(sourceAgentId)].sort();
}

function expectNoSkillIndex(db: Db, id: string) {
  expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_vector_entries WHERE memory_id = ?").get(id)).toEqual({ n: 0 });
  expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?").get(id)).toEqual({ n: 0 });
}

function expectIdentityOnly(db: Db, id: string) {
  expect(memory(db, id).memoryValue).toBe("");
  expectNoSkillIndex(db, id);
}

async function hitIds(service: Service) {
  const session = service.openSession({ namespace });
  return (await service.search({ sessionId: session.sessionId, query: "debug a failing sqlite migration", layers: ["Skill"], limit: 10 }))
    .hits.map(hit => hit.id);
}

describe("imported Skill upgrade lifecycle", () => {
  it.each([
    { kind: "active", migrateFirst: false }, { kind: "active", migrateFirst: true },
    { kind: "user archive", migrateFirst: false }, { kind: "user archive", migrateFirst: true },
    { kind: "manual-only", migrateFirst: false }, { kind: "manual-only", migrateFirst: true }
  ])("preserves a legacy $kind installation when deleted before its first scan, migration=$migrateFirst", async ({ kind, migrateFirst }) => {
    const original = createService();
    let { db, service } = original;
    const source = skill();
    if (kind === "manual-only") {
      source.content = source.content.replace("description:", "disable-model-invocation: true\ndescription:");
      source.contentHash = createHash("sha256").update(source.content).digest("hex");
      source.disableModelInvocation = true;
    }
    const own = legacy(service, source);
    if (kind === "user archive") db.db.prepare(`UPDATE memories SET status = 'archived',
      properties_json = json_set(properties_json, '$.status', 'archived') WHERE id = ?`).run(own);
    if (migrateFirst) service.reconcileWorkerStartup();
    const other = reconcile(service, [skill()], { sourceAgentId: "hermes" }).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    expect(await hitIds(service)).not.toContain(other);

    service.deleteMemory(own, { namespace });
    expect.soft(names(db)).toEqual(["debugging"]);
    expect.soft(await hitIds(service)).not.toContain(other);
    await service.stop(); db.close();
    db = new MemoryDb({ path: join(original.root, "memory.sqlite") });
    service = fixture.createTestMemoryService({ db, mode: "dev", llm: createFailingLlm(), embedder: createCapturingEmbedder([]) });
    service.reconcileWorkerStartup();
    expect.soft(names(db)).toEqual(["debugging"]);
    expect.soft(await hitIds(service)).not.toContain(other);
    reconcile(service, [], { complete: false });
    expect.soft(names(db)).toEqual(["debugging"]);
    expect.soft(await hitIds(service)).not.toContain(other);
    reconcile(service, []);
    expect(names(db)).toEqual([]);
    expect(await hitIds(service)).toContain(other);
    expect(reconcile(service, [source]).skills[0]?.outcome).toBe("deleted_by_user");
    expect(await hitIds(service)).not.toContain(other);
    expectIdentityOnly(db, own);
  });

  it("keeps a deleted current source name ahead of a known superseded legacy name", () => {
    const { db, service } = createService();
    const old = legacy(service, skill("old-name", "v1", { sourceSkillId: "stable-directory" }));
    const current = legacy(service, skill("current-name", "v2", { sourceSkillId: "stable-directory" }));
    expect(memory(db, old).properties.internal_info.superseded_by_skill_id).toBe(current);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.imported_at', ?) WHERE id = ?`)
      .run("2026-01-01T00:00:00.000Z", old);
    new Repositories(db.db).memories.softDelete(current);
    expect(names(db)).toEqual(["current-name"]);
    service.reconcileWorkerStartup();
    reconcile(service, [], { complete: false });
    expect(names(db)).toEqual(["current-name"]);
  });

  it("keeps the rolled-back live version ahead of a newer-created deleted historical version", () => {
    const { db, service } = createService();
    const a = skill("rollback-name", "a", { sourceSkillId: "stable-directory" });
    const b = skill("discarded-name", "b", { sourceSkillId: "stable-directory" });
    reconcile(service, [a]);
    const newer = reconcile(service, [b]).skills[0]!.memoryId!;
    reconcile(service, [a]);
    service.deleteMemory(newer, { namespace });
    db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'agent-skill-installations:%'").run();
    expect(names(db)).toEqual(["rollback-name"]);
  });

  it("keeps legacy import recency ahead of a later embedding maintenance timestamp", () => {
    // Recency is source-independent; no Codex sidecar observation is part of this fixture.
    const { db, service } = createService();
    const older = legacy(service, skill("old-name", "a", { sourceSkillId: "stable-directory" }), "hermes");
    const current = legacy(service, skill("current-name", "b", { sourceSkillId: "stable-directory" }), "hermes");
    const restoreActive = db.db.prepare(`UPDATE memories SET status = 'activated', updated_at = ?,
      properties_json = json_set(json_remove(properties_json, '$.internal_info.superseded_by_skill_id'),
        '$.status', 'activated', '$.internal_info.imported_at', ?, '$.internal_info.skill.status', 'active') WHERE id = ?`);
    restoreActive.run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", older);
    restoreActive.run("2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", current);
    const repos = new Repositories(db.db);
    repos.memories.updateMaintenance(updateMemoryVectorField(memory(db, older), "vec", [1, 0, 0], {
      provider: "local", model: "capturing-test-embedding", updatedAt: "2026-03-01T00:00:00.000Z"
    }));

    expect(names(db, "hermes")).toEqual(["current-name"]);
    service.reconcileWorkerStartup();
    expect(memory(db, older).status).toBe("archived");
    expect(memory(db, current).status).toBe("activated");
  });

  it.each(["already deleted", "deleted before migration", "wrong true marker", "missing historical pointer"])(
    "allows new content after a legacy historical version was %s", shape => {
      const { db, service } = createService();
      const a = skill("evolving", "a"); const b = skill("evolving", "b");
      const older = legacy(service, a); const current = legacy(service, b);
      db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.imported_at', '2026-01-01T00:00:00.000Z') WHERE id = ?`).run(older);
      if (shape === "deleted before migration") service.deleteMemory(older, { namespace });
      else new Repositories(db.db).memories.softDelete(older);
      if (shape === "wrong true marker") db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
        '$.internal_info.deleted_current', json('true'), '$.internal_info.import_state_version', 1) WHERE id = ?`).run(older);
      if (shape === "missing historical pointer") db.db.prepare(`UPDATE memories SET properties_json = json_remove(properties_json,
        '$.internal_info.superseded_by_skill_id') WHERE id = ?`).run(older);
      service.reconcileWorkerStartup();
      const third = reconcile(service, [skill("evolving", "c")]).skills[0]!;
      expect(third.outcome).toBe("created");
      expect(memory(db, older).properties.internal_info.deleted_current).toBe(false);
      expect(memory(db, current).status).toBe("archived");
      expect(reconcile(service, [a]).skills[0]?.outcome).toBe("deleted_by_user");
      expect(memory(db, third.memoryId!).status).toBe("archived");
      expect(memory(db, older)).toMatchObject({ status: "deleted", memoryValue: "" });
    });

  it("preserves a current-version deletion across future content versions", () => {
    const { service } = createService();
    const id = legacy(service, skill());
    service.deleteMemory(id, { namespace }); service.reconcileWorkerStartup();
    expect(reconcile(service, [skill("debugging", "v2")]).skills[0]?.outcome).toBe("deleted_by_user");
  });

  it.each(["current first", "historical first"])("restores the current version after bulk archive, %s", order => {
    const { db, service } = createService();
    const a = reconcile(service, [skill("versions", "a")]).skills[0]!.memoryId!;
    const b = reconcile(service, [skill("versions", "b")]).skills[0]!.memoryId!;
    service.archiveMemory(a, { namespace }); service.archiveMemory(b, { namespace });
    if (order === "historical first") expect(service.reactivateSkill(a, { namespace }).status).toBe("archived");
    expect(service.reactivateSkill(b, { namespace }).status).toBe("activated");
    expect(service.reactivateSkill(a, { namespace }).status).toBe("archived");
    expect(memory(db, b).status).toBe("activated");
    expect(memory(db, a).properties.internal_info.superseded_by_skill_id).toBe(b);
  });

  it("restores a path-only legacy skill without treating another directory as its version", () => {
    const { db, service } = createService();
    const addPathOnly = (title: string, sourceSkillPath: string) => service.addMemory({ namespace,
      adapterId: "agent-source:hermes", layer: "Skill", title, content: `Debug sqlite migrations with ${title}.`,
      source: "hermes", sourceAgentId: "hermes", sourceSkillPath }).id;
    const a = addPathOnly("first-directory", "/synthetic/first/SKILL.md");
    const b = addPathOnly("second-directory", "/synthetic/second/SKILL.md");
    service.reconcileWorkerStartup(); service.archiveMemory(a, { namespace });
    const beforeB = db.db.prepare("SELECT * FROM memories WHERE id = ?").get(b);

    expect(service.reactivateSkill(a, { namespace }).status).toBe("activated");
    expect(db.db.prepare("SELECT * FROM memories WHERE id = ?").get(b)).toEqual(beforeB);
  });

  it.each(["disconnect missing", "disconnect observed", "manual-only", "no implicit", "policy unknown"])(
    "keeps user archive while removing content and indexes for %s", async kind => {
      const { db, service } = createService(); const source = skill();
      const id = reconcile(service, [source]).skills[0]!.memoryId!;
      await runWorkerRounds(service, 2, 50);
      expect(new Repositories(db.db).memories.hasVector(id, "vec")).toBe(true);
      service.archiveMemory(id, { namespace });
      if (kind === "disconnect missing") reconcile(service, [], { complete: false, disconnected: true });
      if (kind === "disconnect observed") reconcile(service, [source], { disconnected: true });
      if (kind === "manual-only") reconcile(service, [{ ...source, disableModelInvocation: true }]);
      if (kind === "no implicit") reconcile(service, [{ ...source, allowImplicitInvocation: false }]);
      if (kind === "policy unknown") reconcile(service, [{ ...source, policyError: "EACCES" }], { complete: false });
      expect(memory(db, id).properties.internal_info.archive_reason).toBe("user");
      expectIdentityOnly(db, id);
    });

  it.each(["disconnect", "manual-only"])("removes historical copies when the source becomes %s", async kind => {
    const { db, service } = createService();
    const a = reconcile(service, [skill("history", "a")]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    const bSource = skill("history", "b"); const b = reconcile(service, [bSource]).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    if (kind === "disconnect") reconcile(service, [], { complete: false, disconnected: true });
    else reconcile(service, [{ ...bSource, disableModelInvocation: true }]);
    expectIdentityOnly(db, a); expectIdentityOnly(db, b);
    expect(memory(db, a).properties.internal_info.superseded_by_skill_id).toBe(b);
  });

  it("persists an empty-source disconnect, preserves it through ordinary scans and clear, and accepts explicit reconnect", () => {
    const { service } = createService();
    expect(service.agentSkillConnectionState("codex")).toBeUndefined();
    reconcile(service, [], { complete: false, disconnected: true });
    expect(service.agentSkillConnectionState("codex")).toBe("disconnected");
    expect(reconcile(service, [skill()], { disconnected: false }).skills[0]?.outcome).toBe("created");
    expect(service.agentSkillsDisconnected("codex")).toBe(true);
    service.clearAllData();
    expect(service.agentSkillConnectionState("codex")).toBe("disconnected");
    reconcile(service, [], { complete: false, connectionState: "connected" });
    expect(service.agentSkillConnectionState("codex")).toBe("connected");
    expect(service.agentSkillsDisconnected("codex")).toBe(false);
  });

  it.each(["Claude-Code", " Claude \t-  Code "])("normalizes old source %s for reconciliation and version archiving", sourceAgentId => {
    const { db, service } = createService();
    const a = legacy(service, skill(), sourceAgentId);
    reconcile(service, [], { sourceAgentId: "claude_code", complete: false, disconnected: true });
    expectIdentityOnly(db, a);
    reconcile(service, [skill("debugging", "v2")], { sourceAgentId: "claude_code", connectionState: "connected" });
    const rows = new Repositories(db.db).memories.listImportedSkillsForSource("claude_code");
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.status === "activated")).toHaveLength(1);
  });

  it.each([false, true])("keeps a source-missing deletion content-specific, user archive=%s", archived => {
    const { db, service } = createService(); const original = skill();
    const id = reconcile(service, [original]).skills[0]!.memoryId!;
    if (archived) service.archiveMemory(id, { namespace });
    reconcile(service, []); service.deleteMemory(id, { namespace }); service.reconcileWorkerStartup(1);
    expect(memory(db, id).properties.internal_info.deleted_current).toBe(false);
    const next = reconcile(service, [skill("debugging", "new content")]).skills[0]!;
    expect(next.outcome).toBe("created");
    expect(reconcile(service, [original]).skills[0]?.outcome).toBe("deleted_by_user");
    expect(memory(db, next.memoryId!).status).toBe("archived");
    expect(memory(db, id)).toMatchObject({ status: "deleted", memoryValue: "" });
  });

  it("repairs a source-missing user archive tombstone with the old true marker", () => {
    const { db, service } = createService();
    const id = reconcile(service, [skill()]).skills[0]!.memoryId!;
    service.archiveMemory(id, { namespace }); reconcile(service, []);
    new Repositories(db.db).memories.softDelete(id);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.import_state_version', 1, '$.internal_info.deleted_current', json('true')) WHERE id = ?`).run(id);
    service.reconcileWorkerStartup(1);
    expect(memory(db, id).properties.internal_info.deleted_current).toBe(false);
    expect(reconcile(service, [skill("debugging", "new content")]).skills[0]?.outcome).toBe("created");
  });

  it.each([false, true])("allows future content before startup repairs a missing-source true tombstone, user archive=%s", archived => {
    const { db, service } = createService(); const original = skill();
    const id = reconcile(service, [original]).skills[0]!.memoryId!;
    if (archived) service.archiveMemory(id, { namespace });
    reconcile(service, []);
    new Repositories(db.db).memories.softDelete(id);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.import_state_version', 1, '$.internal_info.deleted_current', json('true')) WHERE id = ?`).run(id);

    expect(reconcile(service, [skill("debugging", "new content")]).skills[0]?.outcome).toBe("created");
    expect(reconcile(service, [original]).skills[0]?.outcome).toBe("deleted_by_user");
    expect(memory(db, id).status).toBe("deleted");
  });

  it.each(["plugin", "disconnected", "manual-only", "user-disconnected", "user-manual"])(
    "repairs state version one while preserving modern %s state", kind => {
      const { db, service } = createService(); const source = skill();
      let id: string;
      if (kind === "plugin") {
        service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [],
          registrations: [{ sourceSkillId: "plugin:debugging", sourceSkillPath: "/synthetic/plugin/SKILL.md", name: "debugging" }], registrationsComplete: true });
        id = new Repositories(db.db).memories.listImportedSkillsForSource("codex")[0]!.id;
      } else {
        id = reconcile(service, [source]).skills[0]!.memoryId!;
        if (kind.startsWith("user")) service.archiveMemory(id, { namespace });
        if (kind.includes("disconnected")) reconcile(service, [], { complete: false, disconnected: true });
        else reconcile(service, [{ ...source, disableModelInvocation: true }]);
      }
      db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.import_state_version', 1) WHERE id = ?`).run(id);
      const before = memory(db, id);
      service.reconcileWorkerStartup(1);
      const after = memory(db, id);
      expect(after.properties.internal_info).toMatchObject({ archive_reason: before.properties.internal_info.archive_reason,
        source_kind: before.properties.internal_info.source_kind, import_state_version: IMPORTED_SKILL_STATE_VERSION });
      expectIdentityOnly(db, id);
    });

  it("restores the fixed imported eta through migration and unchanged metadata refresh", () => {
    const { db, service } = createService(); const source = skill();
    const id = reconcile(service, [source]).skills[0]!.memoryId!;
    const lowerEta = db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.eta', 0.25, '$.internal_info.skill.eta', 0.25, '$.internal_info.skill.trials_attempted', 7) WHERE id = ?`);
    lowerEta.run(id);
    expect(reconcile(service, [source]).skills[0]?.outcome).toBe("unchanged");
    expect(memory(db, id).properties.internal_info.eta).toBe(0.5);
    lowerEta.run(id);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.import_state_version', 1) WHERE id = ?`).run(id);
    service.reconcileWorkerStartup();
    expect(memory(db, id).properties.internal_info).toMatchObject({ eta: 0.5, skill: { eta: 0.5, trials_attempted: 7 } });
  });

  it.each(["  Debug__  Migrations  ", "___Debug\t__Migrations--"])("selects newest eligible legacy same-name records using TS normalization for %s", title => {
    const { db, service } = createService();
    const older = legacy(service, skill(title), "claude_code");
    db.db.prepare("UPDATE memories SET timeline = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(older);
    const latest = legacy(service, skill("debug-migrations", "v2"), "hermes");
    db.db.prepare("UPDATE memories SET timeline = '2026-03-01T00:00:00.000Z' WHERE id = ?").run(latest);
    const name = normalizeSkillName(title);
    expect(new Repositories(db.db).memories.latestImportedSkillsByName([name]).get(name)).toBe(latest);
  });

  it.each([1, 2])("drains migration and retrieval upgrade in batches of %i and is idempotent", limit => {
    const { db, service } = createService();
    for (let i = 0; i < 5; i++) legacy(service, skill(`batch-${i}`));
    service.reconcileWorkerStartup(limit);
    const rows = new Repositories(db.db).memories.listImportedSkillsForSource("codex");
    expect(rows.every(row => row.properties.internal_info.import_state_version === IMPORTED_SKILL_STATE_VERSION)).toBe(true);
    expect(rows.every(row => row.properties.internal_info.retrieval_representation_version === IMPORTED_SKILL_RETRIEVAL_VERSION)).toBe(true);
    const before = db.db.prepare("SELECT id, version, updated_at, properties_json FROM memories ORDER BY id").all();
    service.reconcileWorkerStartup(limit);
    expect(db.db.prepare("SELECT id, version, updated_at, properties_json FROM memories ORDER BY id").all()).toEqual(before);
  });

  it("drains display rollback without replacing already valid full-body vectors", async () => {
    const seen: string[] = [];
    const { db, service } = fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(seen) });
    // This tests representation rollback, independently of Codex policy discovery.
    const ids = [0, 1, 2].map(index => legacy(service, skill(`rollback-${index}`), "hermes"));
    await runWorkerRounds(service, 2, 50);
    service.reconcileWorkerStartup(); await runWorkerRounds(service, 2, 50);
    seen.length = 0;
    expect(service.restoreImportedSkillRetrievalText(1)).toEqual({ restored: 3 });
    const restoredTexts = ids.map(id => embeddingTextForMemory(memory(db, id)));
    await runWorkerRounds(service, 2, 50);
    expect(seen).toEqual([]);
    expect(ids.map(id => embeddingTextForMemory(memory(db, id)))).toEqual(restoredTexts);
    for (const id of ids) expect(new Repositories(db.db).memories.hasVector(id, "vec")).toBe(true);
    expect(service.restoreImportedSkillRetrievalText(1)).toEqual({ restored: 0 });
  });

  it("scrubs legacy memory_add logs and retrieval rollback blurbs on deletion", () => {
    const { db, service } = createService(); const marker = "DELETED-ROLLBACK-BLURB-84a9";
    const source = skill("scrub", marker); const id = legacy(service, source);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.skill.procedure_json.retrievalBlurb', ?) WHERE id = ?`).run(marker, id);
    db.db.prepare(`INSERT INTO api_logs(tool_name, input_json, output_json, called_at) VALUES('memory_add', ?, ?, ?)`)
      .run(JSON.stringify({ content: source.content }), JSON.stringify({ details: [{ traceId: id, content: source.content }] }), "2026-06-01T00:00:00Z");
    service.reconcileWorkerStartup(); service.deleteMemory(id, { namespace });
    for (const table of ["memories", "memory_change_log", "audit_logs", "api_logs"]) {
      const columns = (db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
        .filter(column => /TEXT/i.test(column.type)).map(column => column.name);
      expect(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${columns.map(column => `COALESCE(${column}, '') LIKE ?`).join(" OR ")}`)
        .get(...columns.map(() => `%${marker}%`))).toEqual({ n: 0 });
    }
  });

  it("rolls back body stripping and soft deletion if the final scrub fails", () => {
    const { db, service } = createService(); const source = skill();
    const id = reconcile(service, [source]).skills[0]!.memoryId!;
    const before = db.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    db.db.exec(`CREATE TRIGGER fail_skill_scrub BEFORE UPDATE ON memory_change_log
      WHEN OLD.memory_id = '${id}' BEGIN SELECT RAISE(ABORT, 'scrub failed'); END`);
    expect(() => service.deleteMemory(id, { namespace })).toThrow("scrub failed");
    expect(db.db.prepare("SELECT * FROM memories WHERE id = ?").get(id)).toEqual(before);
  });

  it.each([false, true])("keeps a live legacy rollback ahead of a later unmarked tombstone, startup=%s", migrateFirst => {
    const { db, service } = createService();
    const aSource = skill("rollback-current", "a", { sourceSkillId: "legacy-directory" });
    const bSource = skill("deleted-history", "b", { sourceSkillId: "legacy-directory" });
    const a = legacy(service, aSource); const b = legacy(service, bSource);
    db.db.prepare(`UPDATE memories SET status = 'activated', properties_json = json_set(
      json_remove(properties_json, '$.internal_info.superseded_by_skill_id'), '$.status', 'activated',
      '$.internal_info.imported_at', '2026-01-01T00:00:00.000Z', '$.internal_info.skill.status', 'active') WHERE id = ?`).run(a);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.imported_at', '2026-02-01T00:00:00.000Z') WHERE id = ?`).run(b);
    new Repositories(db.db).memories.softDelete(b, "2026-03-01T00:00:00.000Z");
    expect(memory(db, b).properties.internal_info.deleted_current).toBeUndefined();

    if (migrateFirst) {
      service.reconcileWorkerStartup();
      expect(memory(db, a)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "policy_unknown" } } });
      expect(memory(db, b).properties.internal_info.deleted_current).toBe(false);
    }
    expect(names(db)).toEqual(["rollback-current"]);
    expect(["updated", "unchanged"]).toContain(reconcile(service, [aSource]).skills[0]?.outcome);
    expect(memory(db, a).status).toBe("activated");
    expect(reconcile(service, [skill("future-version", "c", { sourceSkillId: "legacy-directory" })]).skills[0]?.outcome).toBe("created");
    expect(reconcile(service, [bSource]).skills[0]?.outcome).toBe("deleted_by_user");
  });

  it("preserves a known name on a complete damaged-metadata scan while releasing missing siblings", () => {
    const { db, service } = createService();
    const source = skill("my-custom-skill", "a", { sourceSkillId: "custom-directory" });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true,
      skills: [source, skill("missing-sibling")], registrationsComplete: true,
      registrations: [{ sourceSkillId: "plugin:missing", sourceSkillPath: "/synthetic/plugin/SKILL.md", name: "missing-plugin" }] });

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true,
      skills: [{ ...source, title: "custom-directory", frontmatterError: "unclosed frontmatter" }],
      registrations: [], registrationsComplete: true });

    expect(names(db)).toEqual(["my-custom-skill"]);
    const current = new Repositories(db.db).memories.listImportedSkillsForSource("codex")
      .find(row => row.properties.internal_info.source_skill_id === "custom-directory")!;
    expectIdentityOnly(db, current.id);
    expect(new Repositories(db.db).memories.listImportedSkillsForSource("codex")
      .find(row => row.properties.internal_info.source_skill_id === "missing-sibling")?.properties.internal_info.archive_reason).toBe("source_missing");
  });

  it.each([false, true])("preserves confirmed source absence through disconnect and content deletion, user archive=%s", archived => {
    const { db, service } = createService(); const source = skill();
    const id = reconcile(service, [source]).skills[0]!.memoryId!;
    if (archived) service.archiveMemory(id, { namespace });
    reconcile(service, []);
    reconcile(service, [], { complete: false, connectionState: "disconnected" });
    expect(memory(db, id).properties.internal_info.source_state).toBe("source_missing");
    expectIdentityOnly(db, id);
    service.deleteMemory(id, { namespace });
    expect(memory(db, id).properties.internal_info.deleted_current).toBe(false);
    reconcile(service, [], { complete: false, connectionState: "connected" });
    expect(reconcile(service, [skill("debugging", "future content")]).skills[0]?.outcome).toBe("created");
    expect(reconcile(service, [source]).skills[0]?.outcome).toBe("deleted_by_user");
  });

  it.each([false, true])("keeps an unarchived stripped skill pending until a successful source scan, complete=%s", complete => {
    const { db, service } = createService(); const source = skill();
    const id = reconcile(service, [source]).skills[0]!.memoryId!;
    service.archiveMemory(id, { namespace });
    reconcile(service, [], { complete: false, connectionState: "disconnected" });
    reconcile(service, [], { complete: false, connectionState: "connected" });

    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(service.agentSkillsDisconnected("codex")).toBe(false);
    expect(memory(db, id).properties.internal_info.archive_reason).toBe("scan_pending");
    expect(memory(db, id).properties.internal_info.source_state).toBeUndefined();
    expectIdentityOnly(db, id);
    reconcile(service, [{ ...source, policyError: "EACCES" }], { complete });
    expect(memory(db, id).status).toBe("archived");
    expectIdentityOnly(db, id);
    reconcile(service, [source], { complete });
    expect(memory(db, id)).toMatchObject({ status: "activated", memoryValue: source.content });
    expect(memory(db, id).properties.internal_info.source_state).toBeUndefined();
  });

  it("keeps legacy disconnected content pending even if an old record retained its body", () => {
    const { db, service } = createService(); const source = skill();
    const id = reconcile(service, [source], { connectionState: "connected" }).skills[0]!.memoryId!;
    service.archiveMemory(id, { namespace });
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.source_state', 'disconnected') WHERE id = ?`).run(id);

    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(memory(db, id).properties.internal_info.archive_reason).toBe("scan_pending");
    expectIdentityOnly(db, id);
    reconcile(service, [source]);
    expect(memory(db, id)).toMatchObject({ status: "activated", memoryValue: source.content });
  });

  it("keeps confirmed absence when restoring a user archive after a pure reconnect", () => {
    const { db, service } = createService(); const source = skill();
    const id = reconcile(service, [source]).skills[0]!.memoryId!;
    service.archiveMemory(id, { namespace }); reconcile(service, []);
    reconcile(service, [], { complete: false, connectionState: "disconnected" });
    reconcile(service, [], { complete: false, connectionState: "connected" });

    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(memory(db, id).properties.internal_info.archive_reason).toBe("source_missing");
    expect(memory(db, id).properties.internal_info.source_state).toBeUndefined();
    expectIdentityOnly(db, id);
    reconcile(service, [source]);
    expect(memory(db, id)).toMatchObject({ status: "activated", memoryValue: source.content });
  });

  it("clears stale connection state when a complete reconnected scan confirms the file is missing", () => {
    const { db, service } = createService();
    const id = reconcile(service, [skill()]).skills[0]!.memoryId!;
    reconcile(service, [], { complete: false, connectionState: "disconnected" });
    reconcile(service, [], { complete: false, connectionState: "connected" });
    reconcile(service, []);

    expect(memory(db, id).properties.internal_info.archive_reason).toBe("source_missing");
    expect(memory(db, id).properties.internal_info.source_state).toBeUndefined();
    expectIdentityOnly(db, id);
  });

  it("clears stale source state on an otherwise unchanged healthy scan", () => {
    const { db, service } = createService(); const source = skill();
    const id = reconcile(service, [source], { connectionState: "connected" }).skills[0]!.memoryId!;
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.source_state', 'disconnected') WHERE id = ?`).run(id);

    reconcile(service, [source]);
    expect(memory(db, id)).toMatchObject({ status: "activated", memoryValue: source.content });
    expect(memory(db, id).properties.internal_info.source_state).toBeUndefined();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?").get(id)).toEqual({ n: 1 });
  });

  it.each([
    { modern: false, migrateFirst: false }, { modern: false, migrateFirst: true },
    { modern: true, migrateFirst: false }, { modern: true, migrateFirst: true }
  ])("keeps an archived rollback current ahead of an unmarked tombstone, modern=$modern startup=$migrateFirst", ({ modern, migrateFirst }) => {
    const { db, service } = createService();
    const aSource = skill("real-live-name", "a", { sourceSkillId: "archived-rollback" });
    const bSource = skill("discarded-old-name", "b", { sourceSkillId: "archived-rollback" });
    const a = legacy(service, aSource); const b = legacy(service, bSource);
    db.db.prepare(`UPDATE memories SET status = 'archived', properties_json = json_set(
      json_remove(properties_json, '$.internal_info.superseded_by_skill_id'), '$.status', 'archived',
      '$.internal_info.imported_at', '2026-01-01T00:00:00.000Z', '$.internal_info.skill.status', 'active') WHERE id = ?`).run(a);
    if (modern) db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.import_state_version', 1, '$.internal_info.archive_reason', 'user',
      '$.internal_info.source_state', 'present') WHERE id = ?`).run(a);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.imported_at', '2026-06-01T00:00:00.000Z') WHERE id = ?`).run(b);
    new Repositories(db.db).memories.softDelete(b, "2026-07-01T00:00:00.000Z");

    expect(names(db)).toEqual(["real-live-name"]);
    if (migrateFirst) {
      service.reconcileWorkerStartup();
      expect(memory(db, b).properties.internal_info.deleted_current).toBe(false);
    }
    expect(service.reactivateSkill(a, { namespace }).status).toBe("archived");
    expect(memory(db, a).properties.internal_info.archive_reason).toBe("policy_unknown");
    reconcile(service, [aSource]);
    expect(service.reactivateSkill(a, { namespace }).status).toBe("activated");
    service.archiveMemory(a, { namespace });
    const next = reconcile(service, [skill("future-content", "c", { sourceSkillId: "archived-rollback" })]).skills[0]!;
    expect(next.outcome).toBe("created");
    expect(memory(db, next.memoryId!)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
    expect(reconcile(service, [bSource]).skills[0]?.outcome).toBe("deleted_by_user");
  });

  it.each([
    { label: "empty", content: "" },
    { label: "ASCII whitespace", content: " \n \t" },
    { label: "Unicode whitespace", content: "\u00a0\u2003\n\u3000" }
  ])("preserves a genuine $label source through archive, migration, supersession and restart", async ({ content }) => {
    const original = createService(); let { db, service } = original;
    const source = skill("blank-source", "blank", { content,
      contentHash: createHash("sha256").update(content).digest("hex"), description: undefined });
    const id = reconcile(service, [source], { connectionState: "connected" }).skills[0]!.memoryId!;
    expect(memory(db, id).memoryValue).toBe(content);
    expectNoSkillIndex(db, id);
    service.archiveMemory(id, { namespace });
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.import_state_version', 1) WHERE id = ?`).run(id);
    service.reconcileWorkerStartup();
    expect(memory(db, id).memoryValue).toBe(content);
    expectNoSkillIndex(db, id);
    expect(service.reactivateSkill(id, { namespace }).status).toBe("activated");
    expect(memory(db, id).memoryValue).toBe(content);
    expectNoSkillIndex(db, id);
    reconcile(service, [skill("blank-source", "nonempty version")]);
    expect(memory(db, id).memoryValue).toBe(content);
    expectNoSkillIndex(db, id);
    reconcile(service, [source]); service.archiveMemory(id, { namespace });
    new Repositories(db.db).memories.updateMaintenance(updateMemoryVectorField(memory(db, id), "vec", [1, 0, 0], {
      provider: "local", model: "capturing-test-embedding", updatedAt: "2026-07-01T00:00:00.000Z"
    }));
    await service.stop(); db.close();
    db = new MemoryDb({ path: join(original.root, "memory.sqlite") });
    service = fixture.createTestMemoryService({ db, mode: "dev", llm: createFailingLlm(), embedder: createCapturingEmbedder([]) });
    service.reconcileWorkerStartup();
    expect(service.reactivateSkill(id, { namespace }).status).toBe("activated");
    expect(memory(db, id).memoryValue).toBe(content);
    expectNoSkillIndex(db, id);

    service.archiveMemory(id, { namespace });
    reconcile(service, [], { complete: false, connectionState: "disconnected" });
    reconcile(service, [], { complete: false, connectionState: "connected" });
    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(memory(db, id).properties.internal_info.archive_reason).toBe("scan_pending");
    expectIdentityOnly(db, id);
    reconcile(service, [source]);
    expect(memory(db, id)).toMatchObject({ status: "activated", memoryValue: content });
    expectNoSkillIndex(db, id);
  });

  it.each(["missing", "opaque", "nonempty-source"])("keeps a blank body with an untrusted %s hash pending without source-state clues", hashKind => {
    const { db, service } = createService();
    const id = reconcile(service, [skill()], { connectionState: "connected" }).skills[0]!.memoryId!;
    service.archiveMemory(id, { namespace });
    db.db.prepare(`UPDATE memories SET memory_value = '', properties_json = json_remove(properties_json,
      '$.internal_info.source_state') WHERE id = ?`).run(id);
    if (hashKind === "missing") db.db.prepare(`UPDATE memories SET properties_json = json_remove(properties_json,
      '$.internal_info.source_content_hash') WHERE id = ?`).run(id);
    if (hashKind === "opaque") db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.source_content_hash', 'unverified-hash') WHERE id = ?`).run(id);

    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(memory(db, id).properties.internal_info.archive_reason).toBe("scan_pending");
    expectIdentityOnly(db, id);
  });

  it.each(["policy_unknown", "invocation_policy"])("keeps a hash-matching blank source restricted by %s", sourceState => {
    const { db, service } = createService();
    const source = skill("restricted-empty", "empty", { content: "",
      contentHash: createHash("sha256").update("").digest("hex"), description: undefined });
    const id = reconcile(service, [source], { connectionState: "connected" }).skills[0]!.memoryId!;
    service.archiveMemory(id, { namespace });
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.source_state', ?) WHERE id = ?`).run(sourceState, id);

    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(memory(db, id).properties.internal_info.archive_reason).toBe(sourceState);
    expectIdentityOnly(db, id);
  });

  it.each([
    { label: "manual-only", content: "---\nname: legacy-restricted\ndisable-model-invocation: true\n---\nPrivate instructions.", reason: "invocation_policy" },
    { label: "unclosed frontmatter", content: "---\nname: legacy-restricted\ndisable-model-invocation: true\n", reason: "policy_unknown" }
  ])("keeps legacy $label restricted when user restoration precedes startup", ({ content, reason }) => {
    const { db, service } = createService();
    const source = skill("legacy-restricted", "legacy", { content,
      contentHash: createHash("sha256").update(content).digest("hex") });
    const id = legacy(service, source);
    service.archiveMemory(id, { namespace });

    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(memory(db, id).properties.internal_info.archive_reason).toBe(reason);
    expectIdentityOnly(db, id);
    service.reconcileWorkerStartup();
    expect(memory(db, id).properties.internal_info.archive_reason).toBe(reason);
  });

  it("chooses deterministically across live active, live user archive and explicit current deletion permutations", () => {
    const { db, service } = createService();
    const active = legacy(service, skill("active-version", "a", { sourceSkillId: "mixed-state" }));
    const archived = legacy(service, skill("user-version", "b", { sourceSkillId: "mixed-state" }));
    const deleted = legacy(service, skill("deleted-version", "c", { sourceSkillId: "mixed-state" }));
    db.db.prepare(`UPDATE memories SET properties_json = json_remove(properties_json,
      '$.internal_info.superseded_by_skill_id') WHERE id IN (?, ?, ?)`).run(active, archived, deleted);
    const setState = db.db.prepare(`UPDATE memories SET status = ?, updated_at = ?, properties_json = json_set(properties_json,
      '$.status', ?, '$.internal_info.imported_at', ?) WHERE id = ?`);
    setState.run("activated", "2026-01-01T00:00:00.000Z", "activated", "2026-01-01T00:00:00.000Z", active);
    setState.run("archived", "2026-03-01T00:00:00.000Z", "archived", "2026-03-01T00:00:00.000Z", archived);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.archive_reason', 'user') WHERE id = ?`).run(archived);
    new Repositories(db.db).memories.softDelete(deleted, "2026-02-02T00:00:00.000Z");
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
      '$.internal_info.imported_at', '2026-02-01T00:00:00.000Z', '$.internal_info.deleted_current', json('true')) WHERE id = ?`).run(deleted);
    const orders = [[active, archived, deleted], [active, deleted, archived], [archived, active, deleted],
      [archived, deleted, active], [deleted, active, archived], [deleted, archived, active]];
    const selected = orders.map(ids => currentImportedSkillVersion(ids.map(id => memory(db, id)))?.id);
    expect(selected).toEqual(Array(6).fill(deleted));
  });
});


// Captured from the real pre-fix writers. Preserve dual-active status, A's
// stale successor, and the actual t3 > t2 import order when replaying upgrades.
const rollbackFixtures = JSON.parse(readFileSync(new URL("../../fixtures/imported-skill-legacy-rollbacks.json", import.meta.url), "utf8")) as {
  userIntent: { source: AgentSkillReconcileSkill; id: string; row: MemoryRow };
  userArchiveNewVersion: { source: AgentSkillReconcileSkill; sourceB: AgentSkillReconcileSkill; id: string; bId: string; rows: MemoryRow[] };
  scannerRollback: { source: AgentSkillReconcileSkill; id: string; bId: string; rows: MemoryRow[] };
  variants: Array<{ shape: string; sourceA: AgentSkillReconcileSkill; sourceB: AgentSkillReconcileSkill;
    aId: string; bId: string; rows: MemoryRow[]; connection?: "disconnected" }>;
};

function loadLegacyRollback(shape = "plain") {
  const context = createService();
  const captured = structuredClone(rollbackFixtures.variants.find(variant => variant.shape === shape)!);
  const repos = new Repositories(context.db.db);
  for (const row of captured.rows) repos.memories.insert(row);
  if (captured.connection) repos.runtime.setKv(agentSkillConnectionKey("codex"), captured.connection, captured.rows[0]!.updatedAt);
  const [a, b] = captured.rows;
  expect(a!.status).toBe("activated");
  expect(b!.status).toBe("activated");
  expect(a!.properties.internal_info.superseded_by_skill_id).toBe(b!.id);
  expect(String(a!.properties.internal_info.imported_at) > String(b!.properties.internal_info.imported_at)).toBe(true);
  if (shape.startsWith("mixed")) expect(a!.properties.internal_info).toMatchObject({ archive_reason: "superseded", import_state_version: 1 });
  else expect(a!.properties.internal_info.import_state_version).toBeUndefined();
  return { ...context, ...captured, repos };
}

function directSkill(service: Service, source: AgentSkillReconcileSkill, overrides: Partial<MemoryAddRequest> = {}) {
  return service.addMemory({ namespace, adapterId: "agent-source:codex", layer: "Skill", title: source.title,
    content: source.content, source: "codex", sourceAgentId: "codex", sourceSkillId: source.sourceSkillId,
    sourceSkillPath: source.sourceSkillPath, sourceContentHash: source.contentHash, ...overrides });
}

describe("real legacy rollback writers and direct imported Skill entry", () => {
  it("preserves a genuine old Library rollback's explicit historical relationship", () => {
    const { db, service } = createService();
    const old = structuredClone(rollbackFixtures.scannerRollback);
    const repos = new Repositories(db.db);
    for (const row of old.rows) repos.memories.insert(row);
    expect(memory(db, old.bId).properties.internal_info).toMatchObject({ archive_reason: "superseded", import_state_version: 1,
      superseded_by_skill_id: old.id, skill: { status: "archived" } });
    expect(String(old.rows[1]!.properties.internal_info.imported_at) > String(old.rows[0]!.properties.internal_info.imported_at)).toBe(true);
    expect(currentImportedSkillVersion(old.rows)?.id).toBe(old.id);
    service.reconcileWorkerStartup();
    expect(memory(db, old.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "policy_unknown" } } });
    expect(memory(db, old.bId).properties.internal_info).toMatchObject({ archive_reason: "superseded", superseded_by_skill_id: old.id });
    reconcile(service, [old.source]);
    expect(memory(db, old.id).status).toBe("activated");
    expect(memory(db, old.bId).properties.internal_info).toMatchObject({ archive_reason: "superseded", superseded_by_skill_id: old.id });
  });

  it("inherits user archive intent when an old direct write created a newer active version", () => {
    const { db, service } = createService();
    const old = structuredClone(rollbackFixtures.userArchiveNewVersion);
    const repos = new Repositories(db.db);
    for (const row of old.rows) repos.memories.insert(row);
    expect(memory(db, old.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user", import_state_version: 1 } } });
    expect(memory(db, old.bId)).toMatchObject({ status: "activated" });
    expect(memory(db, old.id).properties.internal_info.superseded_by_skill_id).toBeUndefined();

    service.reconcileWorkerStartup(1);
    expect(memory(db, old.bId)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
    expect(memory(db, old.id).properties.internal_info).toMatchObject({ archive_reason: "superseded", superseded_by_skill_id: old.bId });
    reconcile(service, [old.sourceB]);
    expect(memory(db, old.bId).properties.internal_info.archive_reason).toBe("user");
    const nextSource = skill("future-user-archived", "c", { sourceSkillId: old.source.sourceSkillId });
    const next = directSkill(service, nextSource);
    expect(memory(db, next.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
    // The changed directory needs its own sidecar observation; source identity
    // still carries the user's archive across this observation.
    reconcile(service, [nextSource]);
    expect(memory(db, next.id).properties.internal_info.archive_reason).toBe("user");
    expect(service.reactivateSkill(next.id, { namespace }).status).toBe("activated");
    expect(service.reactivateSkill(old.id, { namespace }).status).toBe("archived");
  });

  it("repairs actual old direct writes that retained user archive intent while activating", () => {
    const { db, service } = createService();
    const old = structuredClone(rollbackFixtures.userIntent);
    expect(old.row).toMatchObject({ status: "activated", properties: { internal_info: { archive_reason: "user", import_state_version: 1 } } });
    new Repositories(db.db).memories.insert(old.row);
    service.reconcileWorkerStartup();
    expect(memory(db, old.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
    reconcile(service, [old.source]);
    expect(memory(db, old.id).properties.internal_info.archive_reason).toBe("user");
    expect(service.reactivateSkill(old.id, { namespace }).status).toBe("activated");
  });

  it.each(["plain", "mixed"].flatMap(shape => ["old archive", "before startup", "after startup"].map(phase => ({ shape, phase }))))(
    "keeps current user archive after $shape rollback, $phase", ({ shape, phase }) => {
      const { db, service, repos, aId, bId, sourceA } = loadLegacyRollback(shape);
      if (phase === "after startup") service.reconcileWorkerStartup();
      if (phase === "old archive") repos.memories.archive(aId);
      else service.archiveMemory(aId, { namespace });
      service.reconcileWorkerStartup();
      expect(memory(db, aId).properties.internal_info.archive_reason).toBe("user");
      expect(memory(db, aId).properties.internal_info.superseded_by_skill_id).toBeUndefined();
      expect(memory(db, bId).properties.internal_info).toMatchObject({ archive_reason: "superseded", superseded_by_skill_id: aId });
      expect(reconcile(service, [sourceA]).skills[0]?.memoryId).toBe(aId);
      expect(memory(db, aId).status).toBe("archived");
      expect(service.reactivateSkill(aId, { namespace }).status).toBe("activated");
    }
  );

  it.each(["plain", "mixed"].flatMap(shape => ["old delete", "before startup", "after startup"].map(phase => ({ shape, phase }))))(
    "retains current-source deletion after $shape rollback, $phase", ({ shape, phase }) => {
      const { db, service, repos, aId, sourceA } = loadLegacyRollback(shape);
      if (phase === "after startup") service.reconcileWorkerStartup();
      if (phase === "old delete") repos.memories.softDelete(aId);
      else service.deleteMemory(aId, { namespace });
      service.reconcileWorkerStartup();
      expect(memory(db, aId).properties.internal_info.deleted_current).toBe(true);
      expect(memory(db, aId).properties.internal_info.superseded_by_skill_id).toBeUndefined();
      expect(memory(db, aId).properties.internal_info.import_state_version).toBe(IMPORTED_SKILL_STATE_VERSION);
      expect(names(db)).toEqual([sourceA.title]);
      expect(reconcile(service, [skill("future-name", "c", { sourceSkillId: sourceA.sourceSkillId })]).skills[0]?.outcome).toBe("deleted_by_user");
      expect(names(db)).toEqual(["future-name"]);
      expectIdentityOnly(db, aId);
    }
  );

  it.each([{ shape: "manual", reason: "invocation_policy" }, { shape: "frontmatter", reason: "policy_unknown" },
    { shape: "disconnected", reason: "disconnected" },
    { shape: "mixed-manual", reason: "invocation_policy" }, { shape: "mixed-frontmatter", reason: "policy_unknown" }])("migrates restricted $shape rollback without a successor cycle", ({ shape, reason }) => {
    const { db, service, aId, bId } = loadLegacyRollback(shape);
    service.reconcileWorkerStartup();
    const a = memory(db, aId); const b = memory(db, bId);
    expect(a.properties.internal_info.archive_reason).toBe(reason);
    expect(a.properties.internal_info.superseded_by_skill_id).toBeUndefined();
    expect(b.properties.internal_info).toMatchObject({ archive_reason: "superseded", superseded_by_skill_id: aId });
    expect(currentImportedSkillVersion([a, b])?.id).toBe(aId);
    expectIdentityOnly(db, aId);
    service.reconcileWorkerStartup();
    expect(currentImportedSkillVersion([memory(db, aId), memory(db, bId)])?.id).toBe(aId);
  });

  it("uses actual direct A B A B A writes to maintain one current version and preserve response metadata", () => {
    const { db, service } = createService();
    // This direct-write contract covers version ordering and response metadata.
    const direct = (source: AgentSkillReconcileSkill, overrides: Partial<MemoryAddRequest> = {}) =>
      directSkill(service, source, { source: "hermes", sourceAgentId: "hermes", adapterId: "agent-source:hermes", ...overrides });
    const a = skill("direct-a", "a", { sourceSkillId: "direct-cycle" });
    const b = skill("direct-b", "b", { sourceSkillId: "direct-cycle" });
    const session = service.openSession({ namespace });
    const first = direct(a, { sessionId: session.sessionId, tags: ["user-one"] });
    const second = direct(b);
    for (const source of [a, b, a]) direct(source, { tags: ["user-two"] });
    expect(memory(db, first.id)).toMatchObject({ status: "activated", sessionId: session.sessionId,
      properties: { internal_info: { read_only: true } } });
    expect(memory(db, first.id).tags).toEqual(expect.arrayContaining(["agent-source", "hermes", "user-two"]));
    expect(memory(db, first.id).tags).not.toContain("manual");
    expect(memory(db, first.id).tags).not.toContain("user-one");
    expect(memory(db, first.id).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    expect(memory(db, second.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "superseded", superseded_by_skill_id: first.id } } });
    expect(direct(a).id).toBe(first.id);
    service.archiveMemory(first.id, { namespace });
    expect(direct(a).status).toBe("archived");
    const third = direct(skill("direct-c", "c", { sourceSkillId: "direct-cycle" }));
    expect(memory(db, third.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
    service.reconcileWorkerStartup();
    expect(service.reactivateSkill(third.id, { namespace }).status).toBe("activated");
  });

  it("blocks direct new content after current deletion and records reappearing tombstone installation", () => {
    const { db, service } = createService();
    const a = skill("direct-deleted", "a");
    const current = directSkill(service, a);
    service.deleteMemory(current.id, { namespace });
    reconcile(service, []);
    expect(names(db)).toEqual([]);
    expect(directSkill(service, a)).toMatchObject({ id: current.id, status: "deleted" });
    expect(names(db)).toEqual(["direct-deleted"]);
    const blocked = directSkill(service, skill("direct-deleted", "c"));
    expect(blocked).toMatchObject({ id: current.id, status: "deleted" });
    expect(new Repositories(db.db).memories.listImportedSkillsForSource("codex")).toHaveLength(1);
  });

  it("preserves the current user archive when direct import encounters a deleted historical hash", () => {
    const { db, service } = createService();
    const a = skill("deleted-history", "a", { sourceSkillId: "direct-archive-intent" });
    const b = skill("user-current", "b", { sourceSkillId: "direct-archive-intent" });
    const older = directSkill(service, a); const current = directSkill(service, b);
    service.deleteMemory(older.id, { namespace });
    service.archiveMemory(current.id, { namespace });
    expect(directSkill(service, a)).toMatchObject({ id: older.id, status: "deleted" });
    expect(memory(db, current.id).properties.internal_info.archive_reason).toBe("user");
    const next = directSkill(service, skill("future-current", "c", { sourceSkillId: "direct-archive-intent" }));
    expect(memory(db, next.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
  });

  it("keeps direct source-missing deletion content-specific", () => {
    const { db, service } = createService();
    // Deletion scope is independent of Codex's external invocation policy.
    const direct = (source: AgentSkillReconcileSkill) => directSkill(service, source,
      { source: "hermes", sourceAgentId: "hermes", adapterId: "agent-source:hermes" });
    const a = skill("direct-missing", "a");
    const old = direct(a);
    service.archiveMemory(old.id, { namespace });
    reconcile(service, [], { sourceAgentId: "hermes" });
    service.deleteMemory(old.id, { namespace });
    const next = direct(skill("direct-missing", "b"));
    expect(next.status).toBe("activated");
    expect(next.id).not.toBe(old.id);
    expect(direct(a)).toMatchObject({ id: old.id, status: "deleted" });
    expect(memory(db, next.id).status).toBe("archived");
  });

  it.each(["manual", "frontmatter", "disconnected", "known codex policy"])("keeps direct %s content identity-only", shape => {
    const { db, service } = createService();
    let source = skill("direct-restricted", "a");
    if (shape === "manual") source = skill("direct-restricted", "a", { content: "---\ndisable-model-invocation: true\n---\nPrivate manual procedure" });
    if (shape === "frontmatter") source = skill("direct-restricted", "a", { content: "---\nname: broken\nPrivate malformed procedure" });
    source.contentHash = createHash("sha256").update(source.content).digest("hex");
    if (shape === "disconnected") reconcile(service, [], { complete: false, connectionState: "disconnected" });
    if (shape === "known codex policy") reconcile(service, [{ ...source, allowImplicitInvocation: false }]);
    const added = directSkill(service, source, { adapterId: "manual-api" });
    expect(added.status).toBe("archived");
    expectIdentityOnly(db, added.id);
    const logs = db.db.prepare("SELECT input_json, output_json FROM api_logs WHERE tool_name = 'memory_add'").all() as Array<{
      input_json: string; output_json: string;
    }>;
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.input_json).content).toBe("");
    expect(JSON.parse(logs[0]!.output_json).details[0].content).toBe("");
  });

  it.each(["path", "turn", "anonymous", "adapter"])("preserves direct %s deduplication and archive", shape => {
    const { db, service } = createService();
    const source = skill("direct-key", "a");
    const overrides: Partial<MemoryAddRequest> = { sourceSkillId: undefined,
      ...(shape === "path" ? {} : { sourceSkillPath: undefined }),
      ...(shape === "turn" ? { turnId: "synthetic-turn-identity" } : {}),
      ...(shape === "adapter" ? { adapterId: "synthetic-adapter", requestId: "same-request" } : {}) };
    const first = directSkill(service, source, overrides);
    const key = memory(db, first.id).memoryKey;
    service.archiveMemory(first.id, { namespace });
    expect(directSkill(service, source, overrides)).toMatchObject({ id: first.id, status: "archived" });
    expect(memory(db, first.id).memoryKey).toBe(key);
    expect(new Repositories(db.db).memories.listImportedSkillsForSource("codex")).toHaveLength(1);
  });
});
