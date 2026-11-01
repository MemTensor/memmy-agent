import { afterEach, expect, it } from "vitest";
import { deriveWorkspaceHostId, sha256Hex } from "../../src/contracts/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { ensurePanelCache } from "../../src/storage/panel-cache.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

it("keeps cached Agent/tag searches independent of historical UIDs while scoped reads verify workspace aliases", () => {
  const { db, service } = fixture.createTestService();
  const repos = new Repositories(db.db);
  const workspaceUri = "file:///tmp/panel-member-uid-compat" as const;
  const workspaceHostId = deriveWorkspaceHostId("panel-host");
  const open = (sessionKey: string, host = workspaceHostId) => service.openSession({
    namespace: { source: "codex", profileId: "default", userId: "current-account", sessionKey },
    workspaceUri, workspaceHostId: host, l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only"
  });
  const old = open("legacy");
  const legacyProject = `ws_${sha256Hex(`old-account\0local\0${workspaceHostId}\0${workspaceUri}`)}`;
  // Fixture restores the historical owner/project; production reads must leave them untouched.
  db.db.prepare("UPDATE sessions SET user_id='old-account',project_id=? WHERE id=?").run(legacyProject, old.sessionId);
  const current = open("current");
  const otherHost = open("other-host", deriveWorkspaceHostId("other-panel-host"));
  const unverified = open("unverified");
  db.db.prepare("UPDATE sessions SET project_id='unverified-project' WHERE id=?").run(unverified.sessionId);
  const insert = db.db.prepare(`INSERT INTO memories
    (id,user_id,session_id,timeline,memory_value,memory_layer,status,created_at,updated_at,info_json,properties_json,tags_json)
    VALUES(?,?,?,'now','needle','L1','activated','2026-10-31','2026-10-31',?,?,'["compat"]')`);
  for (const [id, owner, sessionId, projectId] of [
    ["legacy", "old-account", old.sessionId, legacyProject],
    ["current", "__memmy_device_memory__", current.sessionId, current.projectId],
    ["other-host", "other-account", otherHost.sessionId, otherHost.projectId],
    ["unverified", "old-account", unverified.sessionId, "unverified-project"]
  ]) insert.run(id, owner, sessionId, JSON.stringify({ source: "codex", project_id: projectId }),
    JSON.stringify({ internal_info: { memory_kind: "work_memory" } }));
  ensurePanelCache(db.db, ["memories"]);
  const before = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
  const sessionsBefore = db.db.prepare("SELECT * FROM sessions ORDER BY id").all();
  const filter = { panelSource: true, panelVisible: true, agentId: "codex", tags: ["compat"] };
  // Cached management reads span owners; scoped reads must fall back and retain the verified alias set.
  expect(repos.memories.panelMemberIds(filter, "needle").sort()).toEqual(["current", "legacy", "other-host", "unverified"]);
  for (const project of [current.projectId!, legacyProject]) {
    const scoped = { ...filter, workMemoryUserId: "new-account", workMemoryProjectId: project };
    expect(repos.memories.panelMemberIds(scoped, "needle").sort()).toEqual(["current", "legacy"]);
    expect(repos.memories.panelMemberIds({ ...scoped, ids: ["other-host", "unverified"] }, "needle")).toEqual([]);
    expect(repos.memories.panelMemberIds({ ...scoped, sessionId: old.sessionId }, "needle")).toEqual(["legacy"]);
  }
  expect(repos.memories.panelMemberIds({ ...filter, workMemoryProjectId: null }, "needle")).toEqual([]);
  expect(repos.memories.panelMemberIds({ ...filter, workMemoryProjectId: "unverified-project" }, "needle")).toEqual(["unverified"]);
  expect(repos.memories.panelMemberIds({ ...filter, excludedIds: ["legacy", "other-host", "unverified"] }, "needle")).toEqual(["current"]);
  expect(repos.memories.panelMemberIds({ ...filter, tags: ["missing"] }, "needle")).toEqual([]);
  expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
  expect(db.db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBefore);
});
