import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { MemoryDb, SCHEMA_VERSION } from "../../src/index.js";
import { DEFAULT_MEMMY_CONFIG, loadMemmyConfig } from "../../src/config/index.js";
import { isL3FieldCognitionActive } from "../../src/service/l3-field/flag.js";
import type { ResolvedProject } from "../../src/service/l3-field/types.js";
import { Repositories } from "../../src/storage/repositories.js";

const NEW_TABLES = ["l3_units", "l3_items", "l3_unit_batches", "l3_user_projects"];
const USER = "l3-field-user";
const MACHINE = "a".repeat(64);
const PROJECT: ResolvedProject = {
  identity: "github.com/example/repo",
  checkoutRoot: "/work/repo",
  source: "git",
  displayName: "repo"
};

const opened: MemoryDb[] = [];
const folders: string[] = [];

function openRepos(): { db: MemoryDb; repos: Repositories } {
  const db = new MemoryDb({ path: ":memory:" });
  opened.push(db);
  return { db, repos: new Repositories(db.db) };
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tableNames(db: MemoryDb): string[] {
  return (db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all() as string[]);
}

describe("L3 field cognition storage", () => {
  it("creates the new tables without changing the schema version, keeping the old L3 tables", () => {
    const { db } = openRepos();
    expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
    const names = tableNames(db);
    for (const table of NEW_TABLES) expect(names).toContain(table);
    expect(names).toContain("l3_world_model_scopes");
  });

  it("reopens an existing database without touching old L3 rows", () => {
    const folder = mkdtempSync(join(tmpdir(), "l3-field-reopen-"));
    folders.push(folder);
    const path = join(folder, "memory.sqlite");
    const first = new MemoryDb({ path });
    first.db.exec(`DROP TABLE l3_user_projects; DROP TABLE l3_items; DROP TABLE l3_unit_batches; DROP TABLE l3_units;`);
    first.db.prepare(
      `INSERT INTO l3_world_model_scopes (scope_key, user_id, project_id, memory_id, next_scope_seq, updated_at)
       VALUES ('legacy-scope', ?, NULL, NULL, 3, '2026-10-01T00:00:00.000Z')`
    ).run(USER);
    first.close();

    const reopened = new MemoryDb({ path });
    opened.push(reopened);
    expect(reopened.schemaVersion().version).toBe(SCHEMA_VERSION);
    for (const table of NEW_TABLES) expect(tableNames(reopened)).toContain(table);
    expect(reopened.db.prepare(`SELECT next_scope_seq FROM l3_world_model_scopes WHERE scope_key = 'legacy-scope'`).get())
      .toEqual({ next_scope_seq: 3 });
  });

  it("keys machine and project units by user, machine and identity", () => {
    const { repos } = openRepos();
    const machine = repos.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    expect(repos.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE }).unitKey).toBe(machine.unitKey);
    expect(repos.l3Field.ensureMachineUnit({ userId: "other-user", machineId: MACHINE }).unitKey).not.toBe(machine.unitKey);
    const project = repos.l3Field.ensureProjectUnit({ userId: USER, machineId: MACHINE, project: PROJECT });
    expect(project.kind).toBe("project");
    expect(project.projectIdentity).toBe(PROJECT.identity);
    expect(project.unitKey).not.toBe(machine.unitKey);
    expect(repos.l3Field.ensureProjectUnit({ userId: USER, machineId: MACHINE, project: PROJECT }).unitKey)
      .toBe(project.unitKey);
  });

  it("refreshes a unit snapshot only when it changed, and bumps project snapshots when the machine unit changes", () => {
    const { repos } = openRepos();
    const machine = repos.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    const project = repos.l3Field.ensureProjectUnit({ userId: USER, machineId: MACHINE, project: PROJECT });
    repos.l3Field.insertItem({
      unitKey: project.unitKey,
      kind: "project_constraint",
      content: "报告以 GitHub 上的 main 为准",
      evidence: { fragmentIds: ["f1"], l1MemoryIds: ["l1"] },
      evidenceAt: "2026-10-20T00:00:00.000Z"
    });
    const first = repos.l3Field.refreshSnapshot(project.unitKey);
    expect(first.memoryLayer).toBe("L3");
    expect(first.properties.internal_info.schema_version).toBe(3);
    expect(first.memoryValue).toContain("报告以 GitHub 上的 main 为准");
    const again = repos.l3Field.refreshSnapshot(project.unitKey);
    expect(again.id).toBe(first.id);
    expect(again.version).toBe(first.version);
    repos.l3Field.refreshSnapshot(machine.unitKey);
    const machineVersion = repos.memories.get(repos.l3Field.getUnit(machine.unitKey)!.snapshotMemoryId!)!.version;
    // A machine that did not change leaves the project snapshots alone.
    repos.l3Field.refreshSnapshot(machine.unitKey);
    expect(repos.memories.get(repos.l3Field.getUnit(machine.unitKey)!.snapshotMemoryId!)!.version).toBe(machineVersion);
    expect(repos.memories.get(first.id)!.version).toBe(again.version + 1);

    repos.l3Field.insertItem({
      unitKey: machine.unitKey,
      kind: "env_fact",
      content: "这台电脑的 zsh 会展开 = 开头的参数",
      evidence: { fragmentIds: ["f2"], l1MemoryIds: ["l2"] },
      evidenceAt: "2026-10-21T00:00:00.000Z"
    });
    repos.l3Field.refreshSnapshot(machine.unitKey);
    expect(repos.memories.get(first.id)!.version).toBe(again.version + 2);
  });

  it("replaces items by marking the old one inactive and pointing at its successor", () => {
    const { repos } = openRepos();
    const machine = repos.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    const old = repos.l3Field.insertItem({
      unitKey: machine.unitKey, kind: "env_fact", content: "旧事实",
      evidence: { fragmentIds: [], l1MemoryIds: ["l1"] }, evidenceAt: "2026-10-01T00:00:00.000Z"
    });
    const next = repos.l3Field.insertItem({
      unitKey: machine.unitKey, kind: "env_fact", content: "新事实",
      evidence: { fragmentIds: [], l1MemoryIds: ["l2"] }, evidenceAt: "2026-10-02T00:00:00.000Z"
    });
    repos.l3Field.inactivateItem(old.id, { replacedBy: next.id, at: "2026-10-02T00:00:00.000Z" });
    expect(repos.l3Field.activeItems(machine.unitKey).map((item) => item.id)).toEqual([next.id]);
    expect(repos.l3Field.getItem(old.id)).toMatchObject({ status: "inactive", replacedBy: next.id });
  });

  it("purges only items that have been inactive longer than the cutoff", () => {
    const { repos } = openRepos();
    const machine = repos.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    const add = (content: string) => repos.l3Field.insertItem({
      unitKey: machine.unitKey, kind: "env_fact", content,
      evidence: { fragmentIds: [], l1MemoryIds: [] }, evidenceAt: "2026-01-01T00:00:00.000Z"
    });
    const keep = add("仍然有效");
    const oldInactive = add("失效 16 天");
    const recentInactive = add("失效 14 天");
    repos.l3Field.inactivateItem(oldInactive.id, { at: "2026-10-08T00:00:00.000Z" });
    repos.l3Field.inactivateItem(recentInactive.id, { at: "2026-10-10T00:00:00.000Z" });
    expect(repos.l3Field.purgeInactive("2026-10-09T00:00:00.000Z")).toBe(1);
    expect(repos.l3Field.getItem(oldInactive.id)).toBeUndefined();
    expect(repos.l3Field.getItem(recentInactive.id)?.status).toBe("inactive");
    expect(repos.l3Field.getItem(keep.id)?.status).toBe("active");
  });

  it("marks a deleted unit and inactivates its items", () => {
    const { repos } = openRepos();
    const project = repos.l3Field.ensureProjectUnit({ userId: USER, machineId: MACHINE, project: PROJECT });
    repos.l3Field.insertItem({
      unitKey: project.unitKey, kind: "project_constraint", content: "规矩",
      evidence: { fragmentIds: [], l1MemoryIds: [] }, evidenceAt: "2026-10-01T00:00:00.000Z"
    });
    repos.l3Field.markUnitDeleted(project.unitKey, "2026-10-05T00:00:00.000Z");
    expect(repos.l3Field.getUnit(project.unitKey)?.deletedAt).toBe("2026-10-05T00:00:00.000Z");
    expect(repos.l3Field.activeItems(project.unitKey)).toEqual([]);
  });

  it("replaces the whole user project list", () => {
    const { repos } = openRepos();
    repos.l3Field.replaceUserProjects(USER, [{ rootPath: "/a", name: "A" }, { rootPath: "/b", name: "B" }]);
    repos.l3Field.replaceUserProjects(USER, [{ rootPath: "/b", name: "B2" }]);
    expect(repos.l3Field.listUserProjects(USER)).toEqual([{ rootPath: "/b", name: "B2" }]);
    repos.l3Field.replaceUserProjects(USER, []);
    expect(repos.l3Field.listUserProjects(USER)).toEqual([]);
  });

  it("round-trips the new tables through export and import into an empty database", () => {
    const source = openRepos().repos;
    const project = source.l3Field.ensureProjectUnit({ userId: USER, machineId: MACHINE, project: PROJECT });
    source.l3Field.insertItem({
      unitKey: project.unitKey, kind: "project_constraint", content: "规矩",
      evidence: { fragmentIds: [], l1MemoryIds: [] }, evidenceAt: "2026-10-01T00:00:00.000Z"
    });
    source.l3Field.replaceUserProjects(USER, [{ rootPath: "/work/repo", name: "repo" }]);
    const tables = source.runtime.exportBundleTables(true);

    const target = openRepos().repos;
    target.runtime.importBundleTables(tables);
    expect(target.l3Field.getUnit(project.unitKey)?.projectIdentity).toBe(PROJECT.identity);
    expect(target.l3Field.activeItems(project.unitKey).map((item) => item.content)).toEqual(["规矩"]);
    expect(target.l3Field.listUserProjects(USER)).toEqual([{ rootPath: "/work/repo", name: "repo" }]);
  });

  it("keeps a unit that already exists whole when importing, and fails only when asked to on conflict", () => {
    const source = openRepos().repos;
    const sourceMachine = source.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    source.l3Field.insertItem({ unitKey: sourceMachine.unitKey, kind: "env_fact", content: "旧备份里的事实",
      evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: "2026-10-01T00:00:00.000Z" });
    source.l3Field.refreshSnapshot(sourceMachine.unitKey);
    source.l3Field.replaceUserProjects(USER, [{ rootPath: "/work/repo", name: "repo" }]);
    const tables = source.runtime.exportBundleTables(true);

    const target = openRepos().repos;
    const machine = target.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    target.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机现在的事实",
      evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: "2026-10-02T00:00:00.000Z" });
    const snapshot = target.l3Field.refreshSnapshot(machine.unitKey);
    expect(() => target.runtime.importBundleTables(tables, { conflictStrategy: "error" })).toThrow(/l3 unit already exists/);

    const imported = target.runtime.importBundleTables(tables);
    expect(imported.conflicts).toContainEqual(expect.objectContaining({ table: "l3_units", action: "skipped" }));
    expect(target.l3Field.activeItems(machine.unitKey).map((item) => item.content)).toEqual(["本机现在的事实"]);
    expect(target.l3Field.getUnit(machine.unitKey)!.snapshotMemoryId).toBe(snapshot.id);
    const snapshots = target.db.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE json_extract(properties_json, '$.internal_info.l3_field.unit_key') = ?`
    ).get(machine.unitKey) as { n: number };
    expect(snapshots.n).toBe(1);
    expect(target.l3Field.listUserProjects(USER)).toEqual([{ rootPath: "/work/repo", name: "repo" }]);
  });

  it("drops unfinished unit batches and jobs from a redacted export", () => {
    const { repos, db } = openRepos();
    const machine = repos.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    const insertBatch = (id: string, status: string) => db.db.prepare(
      `INSERT INTO l3_unit_batches (id, machine_unit_key, scope_seq, user_id, session_id, trigger,
         start_trace_seq, end_trace_seq, l1_memory_ids_json, raw_turn_ids_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 's', 'session_close', 1, 1, '[]', '[]', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
    ).run(id, machine.unitKey, id === "done" ? 1 : 2, USER, status);
    insertBatch("done", "applied");
    insertBatch("pending", "queued");
    const redacted = repos.runtime.exportBundleTables(false);
    expect((redacted.l3_unit_batches ?? []).map((row) => row.id)).toEqual(["done"]);
  });

  it("empties the new tables when all memory data is cleared", () => {
    const { repos, db } = openRepos();
    repos.l3Field.ensureMachineUnit({ userId: USER, machineId: MACHINE });
    repos.l3Field.replaceUserProjects(USER, [{ rootPath: "/a", name: "A" }]);
    repos.clearAllMemoryData();
    for (const table of NEW_TABLES) {
      expect(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});

describe("L3 field cognition flag", () => {
  it("is on by default with a 15-day retention, on local sqlite storage only", () => {
    expect(DEFAULT_MEMMY_CONFIG.algorithm.l3FieldCognition).toEqual({ enabled: true, inactiveRetentionDays: 15 });
    expect(isL3FieldCognitionActive(DEFAULT_MEMMY_CONFIG, { backendId: "sqlite-local" }, "local")).toBe(true);
    expect(isL3FieldCognitionActive(DEFAULT_MEMMY_CONFIG, { backendId: "sqlite-local" }, "cloud")).toBe(false);
  });

  it("is active only when enabled on local sqlite storage", () => {
    const enabled = {
      ...DEFAULT_MEMMY_CONFIG,
      algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm, l3FieldCognition: { enabled: true, inactiveRetentionDays: 15 } }
    };
    expect(isL3FieldCognitionActive(enabled, { backendId: "sqlite-local" }, "local")).toBe(true);
    expect(isL3FieldCognitionActive(enabled, { backendId: "sqlite-local" }, "cloud")).toBe(false);
    expect(isL3FieldCognitionActive(enabled, { backendId: "openmem-cloud-rest" }, "local")).toBe(false);
  });

  it("reads the switch from memmyMemory.algorithm in the config file", () => {
    const folder = mkdtempSync(join(tmpdir(), "l3-field-config-"));
    folders.push(folder);
    const file = join(folder, "config.yaml");
    writeFileSync(file, YAML.stringify({ memmyMemory: { algorithm: { l3FieldCognition: { enabled: true } } } }));
    expect(loadMemmyConfig(file).config.algorithm.l3FieldCognition).toEqual({ enabled: true, inactiveRetentionDays: 15 });
  });
});
