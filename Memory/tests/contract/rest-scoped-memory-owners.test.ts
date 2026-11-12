import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSourceExecutor } from "../../src/agent-source/runtime.js";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../../src/server/http.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { createLocalOwnerFixture } from "../fixtures/panel-local-owners.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const scope = { userId: "a", source: "codex", profileId: "default" };

async function setup() {
  const f = await createLocalOwnerFixture(fixture);
  const clearAllData = vi.fn(async () => ({ ok: true as const, cleared: {}, clearedAt: "now", serverTime: "now" }));
  const executor = { clearAllData, dispose() {}, startAutomation() {} } as unknown as AgentSourceExecutor;
  const server = createMemoryHttpServer({ service: f.service, startAgentSourceAutomation: false,
    agentSourceExecutor: executor,
    workerStartupFallbackMs: 3600000, workerPostHealthDelayMs: 3600000, workerIdlePollMs: 3600000,
    auth: { localServiceToken: "local", cloudAccessTokens: { cloud: scope, "cloud-unbound": { source: "codex", profileId: "default" } },
      scopedApiKeys: { scoped: { namespace: scope, scopes: ["memory:read", "memory:write", "panel:read"] },
        "same-device-scope": { namespace: { ...scope, userId: "other-account" }, scopes: ["memory:read", "memory:write"] },
        "other-profile": { namespace: { ...scope, profileId: "foreign" }, scopes: ["memory:read", "memory:write"] },
        "other-workspace": { namespace: { ...scope, workspaceId: "foreign" }, scopes: ["memory:read", "memory:write"] },
        "other-tenant": { namespace: { ...scope, tenantId: "foreign" }, scopes: ["memory:read", "memory:write"] },
        "source-writer": { namespace: { ...scope, tenantId: "source-tenant", projectId: "source-project", workspaceId: "source-workspace" }, scopes: ["memory:read", "memory:write"] },
        "scoped-admin": { namespace: scope, scopes: ["admin:write"] },
        "scoped-unbound": { namespace: { source: "codex", profileId: "default" }, scopes: ["memory:read", "memory:write"] } } } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  const call = async (path: string, token: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { ...f, call, clearAllData, close: () => closeMemoryHttpServer(server),
    a: f.turns.find(turn => turn.owner === "a")!, b: f.turns.find(turn => turn.owner === "b")! };
}

describe("authenticated nonlocal stored owners", () => {
  it("allows a new device-owned writer round trip only with a proven matching namespace", async () => {
    const f = await setup();
    try {
      const opened = await f.call("sessions/open", "scoped", "POST", { adapterId: "device-scope", requestId: "open-device-scope", sessionId: "device-scope" });
      expect(opened.status).toBe(200);
      const completed = await f.call("turns/device-scope/complete", "scoped", "POST", { sessionId: opened.body.sessionId,
        query: "New device task question", answer: "New device task answer" });
      expect(completed.status).toBe(200);
      const id = completed.body.l1MemoryId as string;
      expect((await f.call(`memory/${id}`, "scoped")).status).toBe(200);
      expect((await f.call(`memory/${id}`, "same-device-scope")).status).toBe(200);
      const episode = await f.call(`memory/${completed.body.episodeId}`, "scoped");
      expect(episode.status).toBe(200);
      expect(episode.body.refs.rawTurns).toHaveLength(1);
      for (const token of ["other-profile", "other-workspace", "other-tenant"]) {
        expect((await f.call(`memory/${id}`, token)).status).toBe(404);
        expect((await f.call(`memory/${id}`, token, "DELETE", {})).status).toBe(403);
        expect((await f.call(`panel/tasks/${completed.body.episodeId}`, token, "DELETE", {})).status).toBe(403);
      }
      f.repos.userMemories.insert({ id: "user-device", userId: "a", sourceTurnId: completed.body.rawTurnId,
        sourceTurnRefs: [completed.body.rawTurnId], memoryTypes: ["User Preference"], content: "Scoped device preference",
        normalizedUserTextHash: "scoped-device", status: "active", createdAt: "now", updatedAt: "now" });
      expect((await f.call("memory/user-device", "scoped")).status).toBe(200);
      expect((await f.call("memory/user-device", "other-profile")).status).toBe(404);
      expect((await f.call("memory/user-device", "scoped", "DELETE", {})).status).toBe(200);
      expect((await f.call(`memory/${id}`, "scoped", "DELETE", {})).status).toBe(200);
      expect((await f.call(`panel/tasks/${completed.body.episodeId}`, "scoped", "DELETE", {})).status).toBe(200);
    } finally { await f.close(); }
  });

  it("does not treat a rebound device session as proof of the original episode or UserMemory namespace", async () => {
    const f = await setup();
    try {
      const opened = f.service.openSession({ namespace: scope });
      const turn = await f.service.completeTurn("device-rebind", { sessionId: opened.sessionId, query: "Preserve the original project rule", answer: "The original rule is recorded" });
      f.repos.userMemories.insert({ id: "user-rebind", userId: "a", sourceTurnId: turn.rawTurnId,
        sourceTurnRefs: [turn.rawTurnId], memoryTypes: ["User Preference"], content: "Original scope preference",
        normalizedUserTextHash: "scope-rebind", status: "active", createdAt: "now", updatedAt: "now" });
      // Session reconfiguration remains supported; it must not relabel existing memory authorization.
      expect((await f.call("sessions/open", "other-profile", "POST", { sessionId: opened.sessionId })).status).toBe(200);
      const before = f.repos.runtime.getEpisode(turn.episodeId!);
      expect((await f.call(`memory/${turn.episodeId}`, "other-profile")).status).toBe(404);
      expect((await f.call(`panel/tasks/${turn.episodeId}`, "other-profile", "DELETE", {})).status).toBe(403);
      expect((await f.call("memory/user-rebind", "other-profile")).status).toBe(404);
      expect((await f.call("memory/user-rebind", "other-profile", "DELETE", {})).status).toBe(403);
      expect(f.repos.runtime.getEpisode(turn.episodeId!)).toEqual(before);
      expect(f.repos.userMemories.get("user-rebind")?.status).toBe("active");
    } finally { await f.close(); }
  });

  it("fails closed when device raw references have no stored L1 namespace evidence", async () => {
    const f = await setup();
    try {
      const opened = f.service.openSession({ namespace: scope });
      const turn = await f.service.completeTurn("device-missing-proof", { sessionId: opened.sessionId, query: "Retain a scoped record", answer: "The scoped record is stored" });
      f.repos.userMemories.insert({ id: "user-missing-proof", userId: "a", sourceTurnId: turn.rawTurnId,
        sourceTurnRefs: [turn.rawTurnId], memoryTypes: ["User Preference"], content: "Unknown scope preference",
        normalizedUserTextHash: "scope-missing", status: "active", createdAt: "now", updatedAt: "now" });
      f.db.db.prepare("DELETE FROM memories WHERE id=?").run(turn.l1MemoryId);
      expect((await f.call(`memory/${turn.episodeId}`, "scoped")).status).toBe(404);
      expect((await f.call("memory/user-missing-proof", "scoped")).status).toBe(404);
      expect((await f.call(`panel/tasks/${turn.episodeId}`, "scoped", "DELETE", {})).status).toBe(403);
      expect(f.repos.runtime.getEpisode(turn.episodeId!)).toBeDefined();
    } finally { await f.close(); }
  });

  it("allows a tenant source-capture writer to read and delete its proven device episode", async () => {
    const f = await setup();
    try {
      const captured = await f.call("source-turns/complete", "source-writer", "POST", { source: "codex", channel: "hook",
        sourceTurn: { source: "codex", profileId: "default", conversationId: "tenant-source-conversation", turnId: "tenant-source-turn",
          startedAt: "2099-01-01T01:00:00.000Z", completedAt: "2099-01-01T01:01:00.000Z", sequence: 1, completionEvidence: "task_complete:1" },
        query: "Implement a transaction that preserves the native source turn identity.", answer: "The transaction now stores the full source turn and schedules capture.",
        toolCalls: [{ id: "call-source", name: "read_file", input: { path: "schema.ts" } }],
        toolResults: [{ id: "call-source", output: "CREATE TABLE source_turn_captures" }] });
      expect(captured.status).toBe(200);
      expect(captured.body.status).toBe("stored");
      const result = captured.body.result;
      expect((await f.call(`memory/${result.l1MemoryId}`, "source-writer")).status).toBe(200);
      expect((await f.call(`memory/${result.episodeId}`, "source-writer")).status).toBe(200);
      expect((await f.call(`panel/tasks/${result.episodeId}`, "source-writer", "DELETE", {})).status).toBe(200);
      expect(f.repos.runtime.getEpisode(result.episodeId)).toBeUndefined();
    } finally { await f.close(); }
  });

  it("filters same-device foreign namespace children and policy links while retaining local references", async () => {
    const f = await setup();
    try {
      const session = f.service.openSession({ namespace: scope });
      const turn = await f.service.completeTurn("device-derived", { sessionId: session.sessionId, query: "Record the owned workflow", answer: "The owned workflow is recorded" });
      const foreign = { ...scope, profileId: "foreign" };
      const policies = [scope, foreign].map((namespace, i) => f.service.addMemory({ layer: "L2", namespace, content: i ? "FOREIGN_DEVICE_POLICY_BODY" : "OWNED_DEVICE_POLICY_BODY" }));
      const world = f.service.addMemory({ layer: "L3", namespace: foreign, content: "FOREIGN_DEVICE_WORLD_BODY" });
      const skill = f.service.addMemory({ layer: "Skill", namespace: foreign, content: "FOREIGN_DEVICE_SKILL_BODY" });
      f.db.db.prepare("UPDATE episodes SET l2_policy_ids_json=?,l3_world_model_ids_json=?,skill_memory_ids_json=? WHERE id=?")
        .run(JSON.stringify(policies.map(row => row.id)), JSON.stringify([world.id]), JSON.stringify([skill.id]), turn.episodeId);
      f.repos.runtime.insertTracePolicyLink({ userId: "__memmy_device_memory__", l1MemoryId: turn.l1MemoryId!, l2MemoryId: policies[1]!.id });
      const scoped = await f.call(`memory/${turn.episodeId}`, "scoped");
      expect(scoped.status).toBe(200);
      expect(JSON.stringify(scoped.body)).toContain("OWNED_DEVICE_POLICY_BODY");
      for (const marker of ["FOREIGN_DEVICE_POLICY_BODY", "FOREIGN_DEVICE_WORLD_BODY", "FOREIGN_DEVICE_SKILL_BODY"])
        expect(JSON.stringify(scoped.body)).not.toContain(marker);
      expect(scoped.body.sourceMemoryIds).not.toContain(policies[1]!.id);
      expect((await f.call(`memory/${turn.l1MemoryId}`, "scoped")).body.refs.policyLinks).toEqual([]);
      const local = await f.call(`memory/${turn.episodeId}`, "local");
      expect(JSON.stringify(local.body)).toContain("FOREIGN_DEVICE_POLICY_BODY");
      expect((await f.call(`memory/${turn.l1MemoryId}`, "local")).body.refs.policyLinks).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("keeps device Skill trial episode and reward references within the authenticated namespace", async () => {
    const f = await setup();
    try {
      const turns = [];
      for (const [profileId, reward] of [["default", 0.5], ["foreign", 0.9]] as const) {
        const session = f.service.openSession({ namespace: { ...scope, profileId } });
        const turn = await f.service.completeTurn(`device-trial-${profileId}`, { sessionId: session.sessionId,
          query: "Record a project workflow", answer: "The project workflow is recorded" });
        f.db.db.prepare("UPDATE episodes SET r_task=? WHERE id=?").run(reward, turn.episodeId);
        turns.push(turn);
      }
      const skill = f.service.addMemory({ layer: "Skill", namespace: scope, content: "Owned device skill" });
      for (const [i, turn] of turns.entries()) f.repos.runtime.insertSkillTrial({ id: `device-trial-${i}`, userId: "__memmy_device_memory__",
        skillMemoryId: skill.id, episodeId: turn.episodeId, rawTurnId: turn.rawTurnId, l1MemoryId: turn.l1MemoryId,
        status: "pending", outcome: "unknown", createdAt: "now" });
      f.repos.runtime.insertSkillTrial({ id: "device-trial-unknown", userId: "__memmy_device_memory__", skillMemoryId: skill.id,
        status: "pending", outcome: "unknown", createdAt: "now" });
      const scoped = await f.call(`memory/${skill.id}`, "scoped");
      expect(scoped.status).toBe(200);
      expect(scoped.body.refs.skillTrials).toEqual([{ trialId: "device-trial-0", status: "pending", episodeId: turns[0]!.episodeId, reward: 0.5 }]);
      expect((await f.call(`memory/${skill.id}`, "local")).body.refs.skillTrials).toHaveLength(3);
    } finally { await f.close(); }
  });

  it("rejects nonlocal global clear before calling the executor, while local and validated viewer requests retain it", async () => {
    const f = await setup();
    try {
      for (const token of ["cloud", "scoped", "scoped-admin"]) {
        expect((await f.call("admin/data", token, "DELETE")).status).toBe(403);
        expect(f.clearAllData).not.toHaveBeenCalled();
      }
      expect((await f.call("admin/data", "local", "DELETE")).status).toBe(200);
      expect(f.clearAllData).toHaveBeenCalledTimes(1);
      expect((await f.call("admin/data", "local", "DELETE", undefined, { "x-memmy-viewer": "1" })).status).toBe(200);
      expect(f.clearAllData).toHaveBeenCalledTimes(2);
      expect(f.repos.userMemories.get("user-b")?.status).toBe("active");
    } finally { await f.close(); }
  });

  it.each(["cloud", "scoped"])("denies %s reads and deletes across every stored memory layer", async token => {
    const f = await setup();
    try {
      const ids = ["user-b", f.b.l1MemoryId!];
      for (const layer of ["L2", "Skill"] as const) {
        const memory = f.service.addMemory({ layer, content: `foreign ${layer} content`, namespace: scope });
        f.db.db.prepare("UPDATE memories SET user_id='b' WHERE id=?").run(memory.id);
        ids.push(memory.id);
      }
      const world = f.repos.l3WorldModels.upsertField({ userId: "b", targetField: "general_rules_and_safety_constraints", value: "Foreign world rule" })!;
      f.db.db.prepare("UPDATE memories SET user_id='b' WHERE id=?").run(world.id);
      ids.push(world.id);
      for (const id of ids) {
        const table = id === "user-b" ? "user_memories" : "memories";
        const before = f.db.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
        expect((await f.call(`memory/${id}`, token)).status, `read ${id}`).toBe(404);
        expect((await f.call(`memory/${id}`, token, "DELETE", {})).status, `delete ${id}`).toBe(403);
        expect(f.db.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)).toEqual(before);
      }
      expect((await f.call(`memory/${f.b.episodeId}`, token)).status).toBe(404);
      expect((await f.call(`panel/tasks/${f.b.episodeId}`, token, "DELETE", {})).status).toBe(403);
      expect(f.repos.runtime.getEpisode(f.b.episodeId!)).toBeDefined();
      expect(f.repos.memories.get(f.b.l1MemoryId!)?.status).not.toBe("deleted");
    } finally { await f.close(); }
  });

  it.each(["cloud-unbound", "scoped-unbound"])("does not fill %s owner scope from forged headers", async token => {
    const f = await setup();
    try {
      const headers = { "x-memmy-user-id": "b" };
      expect((await f.call("memory/user-b", token, "GET", undefined, headers)).status).toBe(404);
      expect((await f.call("panel/memory/user-b", token, "GET", undefined, headers)).status).toBe(404);
      expect((await f.call("memory/user-b", token, "DELETE", {}, headers)).status).toBe(403);
      expect(f.repos.userMemories.get("user-b")?.status).toBe("active");
    } finally { await f.close(); }
  });

  it.each(["cloud", "scoped"])("filters foreign linked raw turns and episode members for %s on a local service", async token => {
    const f = await setup();
    try {
      f.db.db.prepare("UPDATE raw_turns SET user_id='b' WHERE id=?").run(f.a.rawTurnId);
      const trace = await f.call(`memory/${f.a.l1MemoryId}`, token);
      expect(trace.status).toBe(200);
      expect(trace.body.refs.rawTurn).toBeUndefined();
      const episode = await f.call(`memory/${f.a.episodeId}`, token);
      expect(episode.status).toBe(200);
      expect(episode.body.refs.rawTurns).toEqual([]);
      expect(episode.body.sourceMemoryIds).not.toContain(f.a.l1MemoryId);
      const local = await f.call(`memory/${f.a.l1MemoryId}`, "local");
      expect(local.status).toBe(200);
      expect(local.body.refs.rawTurn).toBeDefined();
    } finally { await f.close(); }
  });

  it("keeps authenticated local and validated viewer deletion owner-independent", async () => {
    const f = await setup();
    try {
      expect((await f.call("memory/user-b", "local")).status).toBe(200);
      expect((await f.call("memory/user-b", "local", "DELETE", {})).status).toBe(200);
      expect((await f.call(`panel/tasks/${f.b.episodeId}`, "local", "DELETE", {}, { "x-memmy-viewer": "1" })).status).toBe(200);
    } finally { await f.close(); }
  });

  it("enforces explicit service owner scope and keeps local deletion receipts out of scoped idempotency", async () => {
    const f = await setup();
    try {
      expect(() => f.service.getMemory(f.b.episodeId!, { namespace: scope }, false)).toThrow("Memory is unavailable");
      expect(() => f.service.deleteMemory("user-b", { namespace: scope }, false)).toThrow("different owner");
      expect(() => f.service.deletePanelTask(f.b.episodeId!, { namespace: scope }, false)).toThrow("different owner");
      const body = { adapterId: "owner-regression", requestId: "local-delete-replay", namespace: scope };
      expect((await f.call("memory/user-b", "local", "DELETE", body)).status).toBe(200);
      const before = f.db.db.prepare("SELECT * FROM user_memories WHERE id='user-b'").get();
      expect((await f.call("memory/user-b", "cloud", "DELETE", body)).status).toBe(409);
      expect(f.db.db.prepare("SELECT * FROM user_memories WHERE id='user-b'").get()).toEqual(before);
    } finally { await f.close(); }
  });

  it.each(["cloud", "scoped"])("allows %s to delete owned tasks without deleting foreign linked memories", async token => {
    const f = await setup();
    try {
      f.db.db.prepare("UPDATE episodes SET l1_memory_ids_json=? WHERE id=?")
        .run(JSON.stringify([f.a.l1MemoryId, f.b.l1MemoryId]), f.a.episodeId);
      expect((await f.call(`memory/${f.a.l1MemoryId}`, token)).status).toBe(200);
      expect((await f.call(`panel/tasks/${f.a.episodeId}`, token, "DELETE", {})).status).toBe(200);
      expect(f.repos.runtime.getEpisode(f.a.episodeId!)).toBeUndefined();
      expect(f.repos.memories.get(f.b.l1MemoryId!)?.status).not.toBe("deleted");
      expect(f.repos.runtime.getEpisode(f.b.episodeId!)).toBeDefined();
    } finally { await f.close(); }
  });

  it.each([["cloud", "b"], ["scoped", "b"], ["cloud", null], ["scoped", null]] as const)(
    "denies %s task cascades over an attached foreign raw owner %s before mutating any rows", async (token, owner) => {
      const f = await setup();
      try {
        // This row is absent from the task's recorded raw-turn IDs; the FK still cascades it.
        f.db.db.prepare("UPDATE raw_turns SET episode_id=?,user_id=?,deleted_at=?,redacted_at=? WHERE id=?")
          .run(f.a.episodeId, owner, owner === null ? "now" : null, owner === null ? "now" : null, f.b.rawTurnId);
        const snapshot = () => [
          f.db.db.prepare("SELECT * FROM episodes WHERE id=?").get(f.a.episodeId),
          f.db.db.prepare("SELECT * FROM raw_turns WHERE id=?").get(f.b.rawTurnId),
          f.db.db.prepare("SELECT * FROM memories WHERE id=?").get(f.a.l1MemoryId)
        ];
        const before = snapshot();
        expect((await f.call(`panel/tasks/${f.a.episodeId}`, token, "DELETE", {})).status).toBe(403);
        expect(snapshot()).toEqual(before);
        expect(() => f.service.deletePanelTask(f.a.episodeId!, { namespace: scope }, false)).toThrow("different owner");
        expect(snapshot()).toEqual(before);
        expect((await f.call(`panel/tasks/${f.a.episodeId}`, "local", "DELETE", {})).status).toBe(200);
        expect(f.db.db.prepare("SELECT 1 FROM raw_turns WHERE id=?").get(f.b.rawTurnId)).toBeUndefined();
      } finally { await f.close(); }
    }
  );

  it.each(["cloud", "scoped"])("filters foreign policy links and Skill trials from %s references", async token => {
    const f = await setup();
    try {
      const policy = f.service.addMemory({ layer: "L2", content: "Owned policy", namespace: scope });
      const skill = f.service.addMemory({ layer: "Skill", content: "Owned skill", namespace: scope });
      f.db.db.prepare("UPDATE memories SET user_id='a' WHERE id IN (?,?)").run(policy.id, skill.id);
      f.repos.runtime.insertTracePolicyLink({ userId: "b", l1MemoryId: f.a.l1MemoryId!, l2MemoryId: policy.id });
      for (const userId of ["a", "b"]) f.repos.runtime.insertSkillTrial({ id: `trial-${userId}`, userId,
        skillMemoryId: skill.id, episodeId: f.b.episodeId, status: "pending", outcome: "unknown", createdAt: "2026-11-03" });
      expect((await f.call(`memory/${policy.id}`, token)).body.refs.policyLinks).toEqual([]);
      expect((await f.call(`memory/${skill.id}`, token)).body.refs.skillTrials).toEqual([{ trialId: "trial-a", status: "pending" }]);
      expect((await f.call(`memory/${policy.id}`, "local")).body.refs.policyLinks).toHaveLength(1);
      expect((await f.call(`memory/${skill.id}`, "local")).body.refs.skillTrials).toHaveLength(2);
    } finally { await f.close(); }
  });
});
