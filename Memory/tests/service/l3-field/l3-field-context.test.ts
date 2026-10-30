import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

const MACHINE_ID = "c".repeat(64);

function setup(enabled = true, l3MachineProbe: () => Promise<never> | Promise<unknown> = () => new Promise(() => undefined)) {
  const root = fixture.createTestRoot("l3-field-context-");
  const home = join(root, "home");
  const project = join(home, "code", "demo");
  mkdirSync(project, { recursive: true });
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.l3FieldCognition.enabled = enabled;
  const service = fixture.createTestMemoryService({
    db,
    mode: "dev",
    config,
    l3FieldEnvironment: () => ({ machineId: MACHINE_ID, homeDir: home, tempRoots: [] }),
    l3MachineProbe: l3MachineProbe as never
  });
  const repos = new Repositories(db.db);
  return { db, service, repos, home, project };
}

function open(service: ReturnType<typeof setup>["service"], sessionKey: string, workspace?: string) {
  const namespace = { source: "codex", profileId: "default", sessionKey, userId: "u1" };
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    ...(workspace ? { workspaceUri: pathToFileURL(workspace).href, workspaceHostId: "b".repeat(64) } : {}),
    namespace
  });
  const request = {
    requestId: "9353298b-4d3d-46f0-9178-27c27e81543e",
    adapterId: "codex-memory",
    source: "codex",
    namespace: opened.projectId ? { ...namespace, projectId: opened.projectId } : namespace
  };
  return { opened, request, namespace: request.namespace };
}

function evidence() {
  return { fragmentIds: ["f1"], l1MemoryIds: ["memory_l1"] };
}

describe("new L3 session context", () => {
  it("reads without writing while memory writes are off, showing only what already exists", () => {
    const { db, service, repos, home, project } = setup();
    const { opened, request } = open(service, "read-only", project);
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "pnpm -> 未安装", evidence: evidence(), evidenceAt: new Date().toISOString() });
    repos.db.prepare(`DELETE FROM l3_units WHERE kind = 'project'`).run();
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.enableMemoryAdd = false;
    const readOnly = fixture.createTestMemoryService({
      db, mode: "dev", config,
      l3FieldEnvironment: () => ({ machineId: MACHINE_ID, homeDir: home, tempRoots: [] }),
      l3MachineProbe: () => new Promise(() => undefined)
    });
    const counts = () => repos.db.prepare(
      `SELECT (SELECT COUNT(*) FROM l3_units) AS units, (SELECT COUNT(*) FROM memories) AS memories,
              (SELECT COUNT(*) FROM evolution_jobs) AS jobs`
    ).get();
    const before = counts();
    const context = readOnly.l3WorldModelContext(opened.sessionId, request);
    expect(context.renderedContext).toContain("pnpm -> 未安装");
    expect(counts()).toEqual(before);
  });

  it("does not store a machine probe that finishes after the service stopped", async () => {
    let finish!: (probe: unknown) => void;
    const { service, repos } = setup(true, () => new Promise((resolve) => { finish = resolve; }));
    open(service, "stopping");
    await service.stop();
    finish({ os: "darwin", osVersion: "15", arch: "arm64", shell: "/bin/zsh", tools: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const machine = repos.l3Field.getUnit(repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID }).unitKey)!;
    expect(machine.profileFingerprint ?? null).toBeNull();
  });

  it("is empty for a session without a folder until the machine knows something", () => {
    const { service, repos } = setup();
    const { opened, request } = open(service, "machine-only");
    expect(service.l3WorldModelContext(opened.sessionId, request)).toMatchObject({ renderedContext: "", memoryId: null });

    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(machine.unitKey);
    const context = service.l3WorldModelContext(opened.sessionId, request);
    expect(context.renderedContext).toBe("当前项目：无\n\n## 本机环境事实\n- 本机用 pnpm 9");
    expect(context.memoryId).toBe(repos.l3Field.getUnit(machine.unitKey)!.snapshotMemoryId);
    expect(context.projectContract).toBeNull();
    expect(context.domainKnowledge).toBe("- 本机用 pnpm 9");
  });

  it("names the project and its source, and shows machine and project knowledge together", () => {
    const { service, repos, project } = setup();
    const { opened, request } = open(service, "with-project", project);
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    service.l3WorldModelContext(opened.sessionId, request);
    const unit = repos.db.prepare(`SELECT unit_key FROM l3_units WHERE kind = 'project'`).get() as { unit_key: string };
    repos.l3Field.insertItem({ unitKey: unit.unit_key, kind: "project_constraint", content: "改完跑 npm test", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(unit.unit_key);

    const context = service.l3WorldModelContext(opened.sessionId, request);
    expect(context.renderedContext).toBe(
      "当前项目：demo（文件夹）\n\n## 本机环境事实\n- 本机用 pnpm 9\n\n## 项目约束\n- 改完跑 npm test"
    );
    expect(context.projectId).toBe(opened.projectId);
    expect(context.memoryId).toBe(repos.l3Field.getUnit(unit.unit_key)!.snapshotMemoryId);
    expect(context.sourceMemoryIds).toEqual(["memory_l1"]);
  });

  it("shows a snapshot on the world model page and keeps it out of full-text search", () => {
    const { service, repos, db } = setup();
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    const snapshot = repos.l3Field.refreshSnapshot(machine.unitKey);
    const { request } = open(service, "panel");
    const detail = service.getMemory(snapshot.id, request);
    expect(JSON.stringify(detail)).toContain("\"domainKnowledge\":\"- 本机用 pnpm 9\"");
    const fts = db.db.prepare(`SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?`).get(snapshot.id) as { n: number };
    expect(fts.n).toBe(0);
  });

  it("deleting a snapshot resets its unit, and the next session starts it afresh", () => {
    const { service, repos } = setup();
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    const item = repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    const snapshot = repos.l3Field.refreshSnapshot(machine.unitKey);
    const { opened, request } = open(service, "delete");

    service.deleteMemory(snapshot.id, { namespace: request.namespace, reason: "user" });
    expect(repos.l3Field.getItem(item.id)!.status).toBe("inactive");
    expect(repos.l3Field.getUnit(machine.unitKey)!.snapshotMemoryId).toBeUndefined();
    expect(service.l3WorldModelContext(opened.sessionId, request).renderedContext).toBe("");

    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 bun", evidence: evidence(), evidenceAt: "2026-10-03T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(machine.unitKey);
    const context = service.l3WorldModelContext(opened.sessionId, request);
    expect(context.renderedContext).toContain("本机用 bun");
    expect(context.memoryId).not.toBe(snapshot.id);
  });

  it("does not inject a unit whose snapshot the user archived, and keeps it archived when it is rewritten", () => {
    const { service, repos } = setup();
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    const snapshot = repos.l3Field.refreshSnapshot(machine.unitKey);
    const { opened, request } = open(service, "archive");
    service.archiveMemory(snapshot.id, { namespace: request.namespace, reason: "user" });
    expect(service.l3WorldModelContext(opened.sessionId, request).renderedContext).toBe("");
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 bun", evidence: evidence(), evidenceAt: "2026-10-02T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(machine.unitKey);
    expect(repos.memories.get(snapshot.id)!.status).toBe("archived");
    expect(service.l3WorldModelContext(opened.sessionId, request).renderedContext).toBe("");
  });

  it("moves a project's context version when the machine snapshot is archived, so clients drop the cached machine part", () => {
    const { service, repos, project } = setup();
    const { opened, request } = open(service, "archive-machine", project);
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    service.l3WorldModelContext(opened.sessionId, request);
    const unit = repos.db.prepare(`SELECT unit_key FROM l3_units WHERE kind = 'project'`).get() as { unit_key: string };
    repos.l3Field.insertItem({ unitKey: unit.unit_key, kind: "project_constraint", content: "改完跑 npm test", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    const machineSnapshot = repos.l3Field.refreshSnapshot(machine.unitKey);
    repos.l3Field.refreshSnapshot(unit.unit_key);
    const before = service.l3WorldModelContext(opened.sessionId, request);
    expect(before.renderedContext).toContain("本机用 pnpm 9");

    service.archiveMemory(machineSnapshot.id, { namespace: request.namespace, reason: "user" });
    const after = service.l3WorldModelContext(opened.sessionId, request);
    expect(after.renderedContext).not.toContain("本机用 pnpm 9");
    expect(after.renderedContext).toContain("改完跑 npm test");
    expect(after.memoryVersion).not.toBe(before.memoryVersion);
  });

  it("deletes a snapshot and resets its unit together, or neither", () => {
    const { service, repos } = setup();
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    const item = repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    const snapshot = repos.l3Field.refreshSnapshot(machine.unitKey);
    const { request } = open(service, "atomic-delete");
    const internal = (service as unknown as { repos: Repositories }).repos;
    const reset = vi.spyOn(internal.l3Field, "markUnitDeleted").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => service.deleteMemory(snapshot.id, { namespace: request.namespace, reason: "user" })).toThrow("disk full");
    reset.mockRestore();
    expect(repos.memories.get(snapshot.id)!.deletedAt).toBeFalsy();
    expect(repos.l3Field.getItem(item.id)!.status).toBe("active");
  });

  it("drops a machine probe that was running when the user deleted the machine snapshot", async () => {
    let finishProbe: (probe: unknown) => void = () => undefined;
    const probe = () => new Promise((resolve) => { finishProbe = resolve; });
    const { service, repos } = setup(true, probe);
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    const snapshot = repos.l3Field.refreshSnapshot(machine.unitKey);
    const { request } = open(service, "probe-race");
    service.deleteMemory(snapshot.id, { namespace: request.namespace, reason: "user" });
    finishProbe({ os: { name: "macOS", version: "26.0" }, arch: "arm64", shell: "zsh", tools: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(repos.l3Field.getUnit(machine.unitKey)!.profileText).toBeFalsy();
    expect(repos.l3Field.getUnit(machine.unitKey)!.snapshotMemoryId).toBeUndefined();
  });

  it("moves the project version when the machine is reset, and keeps refreshing a project rebuilt after a reset", () => {
    const { service, repos, project } = setup();
    const { opened, request } = open(service, "versions", project);
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    service.l3WorldModelContext(opened.sessionId, request);
    const unitKey = (repos.db.prepare(`SELECT unit_key FROM l3_units WHERE kind = 'project'`).get() as { unit_key: string }).unit_key;
    repos.l3Field.insertItem({ unitKey, kind: "project_constraint", content: "改完跑测试", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(machine.unitKey);
    const before = service.l3WorldModelContext(opened.sessionId, request);

    repos.l3Field.markUnitDeleted(machine.unitKey);
    const afterMachineReset = service.l3WorldModelContext(opened.sessionId, request);
    expect(afterMachineReset.memoryVersion).not.toBe(before.memoryVersion);
    expect(afterMachineReset.renderedContext).not.toContain("pnpm");

    repos.l3Field.markUnitDeleted(unitKey);
    repos.l3Field.insertItem({ unitKey, kind: "project_constraint", content: "新规则", evidence: evidence(), evidenceAt: "2026-10-02T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(unitKey);
    const rebuilt = service.l3WorldModelContext(opened.sessionId, request);
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 bun", evidence: evidence(), evidenceAt: "2026-10-03T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(machine.unitKey);
    const afterMachineChange = service.l3WorldModelContext(opened.sessionId, request);
    expect(afterMachineChange.memoryVersion).not.toBe(rebuilt.memoryVersion);
    expect(afterMachineChange.renderedContext).toContain("本机用 bun");
  });

  it("on startup drops items inactive for over 15 days and never queues embeddings for snapshots", () => {
    const { service, repos, db } = setup();
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    const old = repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "旧", evidence: evidence(), evidenceAt: "2026-01-01T00:00:00.000Z" });
    const recent = repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "新", evidence: evidence(), evidenceAt: "2026-01-01T00:00:00.000Z" });
    repos.l3Field.inactivateItem(old.id, { at: new Date(Date.now() - 16 * 86_400_000).toISOString() });
    repos.l3Field.inactivateItem(recent.id, { at: new Date(Date.now() - 14 * 86_400_000).toISOString() });
    const snapshot = repos.l3Field.refreshSnapshot(machine.unitKey);

    service.reconcileWorkerStartup();
    expect(repos.l3Field.getItem(old.id)).toBeUndefined();
    expect(repos.l3Field.getItem(recent.id)).toBeDefined();
    const jobs = db.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?`
    ).get(snapshot.id) as { n: number };
    expect(jobs.n).toBe(0);
  });

  it("keeps the old L3 when the switch is off", () => {
    const { service, repos } = setup(false);
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    repos.l3Field.insertItem({ unitKey: machine.unitKey, kind: "env_fact", content: "本机用 pnpm 9", evidence: evidence(), evidenceAt: "2026-10-01T00:00:00.000Z" });
    repos.l3Field.refreshSnapshot(machine.unitKey);
    const { opened, request } = open(service, "flag-off");
    expect(service.l3WorldModelContext(opened.sessionId, request).renderedContext).not.toContain("pnpm");
  });
});
