import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { MemoryDb } from "../../src/index.js";
import { Repositories, l3WorldModelMemoryKey, l3WorldModelScopeKey } from "../../src/storage/repositories.js";
import { SessionL3WorldModelContextResponseSchema, deriveWorkspaceHostId, sha256Hex } from "../../src/contracts/index.js";
import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";
import { resolveWorkspaceIdentity } from "../../src/service/namespace/workspace-identity.js";
import { buildUserMemory } from "../../src/service/user-memory/user-memory.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService, createTestMemoryService } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = (userId: string, sessionKey = "shared") => ({ source: "codex", profileId: "default", userId, sessionKey });
const v2 = (userId: string, sessionKey = "shared") => ({
  l3WorldModelProtocolVersion: 2 as const, l3WorldModelTransition: "resume_only" as const,
  namespace: namespace(userId, sessionKey)
});

function legacyWorld(repos: Repositories, owner: string, value: string, projectId?: string) {
  const memory = repos.l3WorldModels.upsertField({ userId: owner, projectId,
    targetField: projectId ? "project_contract" : "general_rules_and_safety_constraints", value })!;
  // Fixture represents a database produced by the old release, not a new write.
  repos.db.prepare("UPDATE memories SET user_id = ?, memory_key = ? WHERE id = ?")
    .run(owner, l3WorldModelMemoryKey(owner, projectId), memory.id);
  repos.db.prepare("UPDATE l3_world_model_scopes SET user_id = ?, scope_key = ? WHERE memory_id = ?")
    .run(owner, l3WorldModelScopeKey(owner, projectId), memory.id);
  repos.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
  return memory.id;
}

function historicalRows(repos: Repositories) {
  return ["memories", "user_memories", "l3_world_model_scopes"].map(table =>
    repos.db.prepare(`SELECT * FROM ${table} WHERE user_id IN ('account-a', 'account-b') ORDER BY rowid`).all());
}

describe("device memory / UID decoupling", () => {
  it("shares old user memories and L3 across accounts without rewriting, merging, or filling old rows, including restart", async () => {
    const { root, db, service } = createTestService();
    const repos = new Repositories(db.db);
    const a = legacyWorld(repos, "account-a", "Keep historical rule A");
    const b = legacyWorld(repos, "account-b", "Keep historical rule B");
    for (const owner of ["account-a", "account-b"]) {
      const memory = repos.userMemories.insert(buildUserMemory({ id: `old-${owner}`, sourceTurnId: `raw-${owner}`,
        userId: owner, memoryTypes: ["User Preference"], content: "shared historical preference", createdAt: "2026-01-01T00:00:00.000Z" }));
      repos.db.prepare("UPDATE user_memories SET user_id = ? WHERE id = ?").run(owner, memory.id);
    }
    const before = historicalRows(repos);
    const opened = service.openSession(v2("account-c"));
    const context = service.l3WorldModelContext(opened.sessionId, { requestId: crypto.randomUUID(), adapterId: "test", namespace: namespace("account-d") });
    expect(context.renderedContext).toContain("Keep historical rule A");
    expect(context.renderedContext).toContain("Keep historical rule B");
    expect(repos.l3WorldModels.sharedMemories(null).map(memory => memory.id).sort()).toEqual([a, b].sort());
    expect(SessionL3WorldModelContextResponseSchema.safeParse(context).success).toBe(true);
    expect(service.panelItems({ layer: "UserMemory" }).items).toHaveLength(2);
    expect(repos.userMemories.listActive("account-z")).toHaveLength(2);
    expect(repos.userMemories.searchPatternIds("account-z", ["historical"], 10)).toHaveLength(2);
    expect(repos.userMemories.searchFtsIds("account-z", "historical", 10)).toHaveLength(2);
    const fresh = repos.l3WorldModels.upsertField({ userId: "account-z", targetField: "general_rules_and_safety_constraints", value: "New device rule" })!;
    expect(fresh.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(repos.l3WorldModels.fields("account-z").generalRulesAndSafetyConstraints).toBe("New device rule");
    expect(historicalRows(repos)).toEqual(before);
    await service.stop();
    db.close();
    const reopenedDb = new MemoryDb({ path: join(root, "memory.sqlite") });
    const reopened = createTestMemoryService({ db: reopenedDb });
    const reloaded = reopened.l3WorldModelContext(opened.sessionId, { requestId: crypto.randomUUID(), adapterId: "test", namespace: namespace("account-b") });
    expect(reloaded.renderedContext).toContain("New device rule");
    expect(reloaded.renderedContext).not.toContain("Keep historical rule A");
    expect(historicalRows(new Repositories(reopenedDb.db))).toEqual(before);
  });

  it("shares sessions, new capture, deletion, and workspace identity across account switches", async () => {
    const { db, service } = createTestService();
    const first = service.openSession(v2("account-a"));
    expect(service.openSession(v2("account-b")).sessionId).toBe(first.sessionId);
    await service.completeTurn("shared-turn", { sessionId: first.sessionId,
      namespace: namespace("account-b"), query: "Record the project rule: always test before commit.", answer: "The project rule was recorded." });
    const added = service.addMemory({ content: "Shared memory content", layer: "L1", namespace: namespace("account-b") });
    expect(service.getMemory(added.id).id).toBe(added.id);
    expect(db.db.prepare("SELECT DISTINCT user_id FROM memories").all()).toEqual([{ user_id: DEVICE_MEMORY_OWNER }]);
    expect(db.db.prepare("SELECT DISTINCT user_id FROM raw_turns").all()).toEqual([{ user_id: DEVICE_MEMORY_OWNER }]);
    expect(() => service.deleteMemory(added.id, { namespace: namespace("account-c") })).not.toThrow();
    const input = { workspaceUri: "file:///tmp/shared-project" as const, workspaceHostId: deriveWorkspaceHostId("host") };
    expect(resolveWorkspaceIdentity("account-a", input)).toEqual(resolveWorkspaceIdentity("account-b", input));
    expect(resolveWorkspaceIdentity("account-a", input)).not.toEqual(resolveWorkspaceIdentity("account-a", { ...input, workspaceHostId: deriveWorkspaceHostId("other") }));
  });

  it("reads an exported legacy project scope without its old Session and resolves the same alias group in both directions", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const workspaceUri = "file:///tmp/exported-project" as const;
    const workspaceHostId = deriveWorkspaceHostId("exported-host");
    const oldProject = `ws_${sha256Hex(`account-a\0local\0${workspaceHostId}\0${workspaceUri}`)}`;
    legacyWorld(repos, "account-a", "Exported contract remains separate", oldProject);
    db.db.prepare("UPDATE l3_world_model_scopes SET workspace_uri = ? WHERE project_id = ?").run(workspaceUri, oldProject);
    const before = historicalRows(repos);
    const opened = service.openSession({ ...v2("account-b", "export-session"), workspaceUri, workspaceHostId });
    const context = service.l3WorldModelContext(opened.sessionId, { requestId: crypto.randomUUID(), adapterId: "test",
      namespace: { ...namespace("account-c", "export-session"), projectId: opened.projectId! } });
    expect(context.projectContract).toBe("Exported contract remains separate");
    expect(repos.l3WorldModels.sharedProjectIds(oldProject).sort()).toEqual(repos.l3WorldModels.sharedProjectIds(opened.projectId!).sort());
    expect(historicalRows(repos)).toEqual(before);
  });

  it("reads legacy UID-derived project records through workspace evidence and excludes another host and archived records", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const workspaceUri = "file:///tmp/same-project" as const;
    const workspaceHostId = deriveWorkspaceHostId("host");
    const old = service.openSession({ ...v2("account-a", "legacy-project-session"), workspaceUri, workspaceHostId });
    // Restore a verifiable historical UID-derived project identity.
    const legacyProject = `ws_${sha256Hex(`account-a\0local\0${workspaceHostId}\0${workspaceUri}`)}`;
    db.db.prepare("UPDATE sessions SET user_id = 'account-a', project_id = ? WHERE id = ?").run(legacyProject, old.sessionId);
    legacyWorld(repos, "account-a", "Legacy project contract", legacyProject);
    const unrelated = service.openSession({ ...v2("account-b", "other-host"), workspaceUri, workspaceHostId: deriveWorkspaceHostId("other-host") });
    legacyWorld(repos, "account-b", "Other host secret", unrelated.projectId!);
    const fresh = service.openSession({ ...v2("account-c", "fresh-project-session"), workspaceUri, workspaceHostId });
    const before = historicalRows(repos);
    const context = service.l3WorldModelContext(fresh.sessionId, { requestId: crypto.randomUUID(), adapterId: "test", namespace: { ...namespace("account-d", "fresh-project-session"), projectId: fresh.projectId! } });
    expect(context.projectContract).toBe("Legacy project contract");
    expect(context.renderedContext).not.toContain("Other host secret");
    expect(historicalRows(repos)).toEqual(before);
    db.db.prepare("UPDATE memories SET status = 'archived' WHERE user_id = 'account-a'").run();
    expect(service.l3WorldModelContext(fresh.sessionId, { requestId: crypto.randomUUID(), adapterId: "test", namespace: { ...namespace("account-d", "fresh-project-session"), projectId: fresh.projectId! } }).renderedContext).toBe("");
  });
});
