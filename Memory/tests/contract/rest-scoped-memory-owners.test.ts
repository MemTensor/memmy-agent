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
