import { LEGACY_TEST_CONFIG } from "../fixtures/memory-service-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceTurnRequest } from "@memmy/agent-source-core";
import { join } from "node:path";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, createMemoryHttpServer } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService, createTestMemoryService, createTestRoot } = createMemoryServiceFixture();
afterEach(cleanup);

describe("source turn HTTP contract", () => {
  it("accepts the real shared builder and principal namespace for both channels", async () => {
    const { service, db } = createTestService({ config: { ...LEGACY_TEST_CONFIG, userId: "configured-owner" } });
    const server = createMemoryHttpServer({ service, startAgentSourceAutomation: false,
      auth: { mode: "dev", scopedApiKeys: { "scope-test-token": {
        namespace: { source: "codex", profileId: "default", userId: "http-user" }, scopes: ["memory:read", "memory:write"]
      } } } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const payload = buildSourceTurnRequest({ source: "codex", conversationId: "http-conversation", turnId: "http-turn",
      startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1,
      completionEvidence: "final_answer:http-turn", query: "Implement the source-turn endpoint transaction.",
      answer: "The source-turn endpoint transaction is implemented.", status: "succeeded", toolCalls: [], toolResults: []
    }, "hook");
    const submit = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v1/source-turns/complete`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer scope-test-token" }, body: JSON.stringify(body)
    });
    try {
      const responses = await Promise.all([submit(payload), submit({ ...payload, channel: "agent_source_scan" })]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const bodies = await Promise.all((await Promise.all(responses.map((response) => response.json())))) as Array<{ status: string; result: { sessionId: string; rawTurnId: string; l1MemoryId: string } }>;
      expect(bodies.map((body) => body.status).sort()).toEqual(["existing", "stored"]);
      expect(bodies[0]!.result.rawTurnId).toBe(bodies[1]!.result.rawTurnId);
      expect(bodies[0]!.result.l1MemoryId).toBe(bodies[1]!.result.l1MemoryId);
      expect(new Repositories(db.db).runtime.getSession(bodies[0]!.result.sessionId)).toMatchObject({ userId: "http-user", source: "codex", profileId: "default" });
      const forbidden = await submit({ ...payload, sourceTurn: { ...payload.sourceTurn, profileId: "foreign-profile" } });
      expect(forbidden.status).toBe(403);
      const foreignUser = await submit({ ...payload, namespace: { source: "codex", profileId: "default", userId: "foreign-user" } });
      expect(foreignUser.status).toBe(403);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("freezes scanned Sessions through the request the desktop backend sends", async () => {
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.l3FieldCognition.enabled = true;
    const db = new MemoryDb({ path: join(createTestRoot(), "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config,
      l3FieldEnvironment: () => ({ machineId: "6".repeat(64), homeDir: "/nonexistent-home", tempRoots: [] }),
      l3MachineProbe: () => new Promise(() => undefined)
    });
    const server = createMemoryHttpServer({ service, startAgentSourceAutomation: false, auth: { mode: "local", allowAnonymous: true } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    try {
      const turn = await post("/api/v1/source-turns/complete", buildSourceTurnRequest({ source: "codex", conversationId: "scanned-conversation",
        turnId: "scanned-turn", startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1,
        completionEvidence: "final_answer:scanned-turn", query: "Rename the export helper.", answer: "Renamed.", status: "succeeded",
        toolCalls: [], toolResults: [] }, "agent_source_scan"));
      expect(turn.status).toBe(200);
      const { result } = await turn.json() as { result: { sessionId: string } };
      const frozen = await post("/api/v1/l3/scan-sessions/freeze", {
        requestId: crypto.randomUUID(), adapterId: "agent-source:codex", source: "codex", sessionIds: [result.sessionId]
      });
      expect(frozen.status).toBe(200);
      // The worker's startup pass may have handed the session over first; either way it is frozen once.
      expect(await frozen.json()).toMatchObject({ batches: expect.any(Number) });
      expect(db.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(result.sessionId)).toEqual({ n: 1 });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it.each(["hook", "agent_source_scan", "concurrent"] as const)("reuses the installed Hook owner after account switch when %s arrives first", async (channel) => {
    const { service, db } = createTestService({ config: { ...LEGACY_TEST_CONFIG, userId: "configured-owner" } });
    const opened = service.openSession({
      source: "codex", namespace: { source: "codex", profileId: "default", userId: "installed-owner", sessionKey: "codex-memory-local-conversation" },
      l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "allow_legacy_rollover",
      workspaceUri: "file:///fixture-project", workspaceHostId: "a".repeat(64)
    });
    const server = createMemoryHttpServer({ service, startAgentSourceAutomation: false, auth: { mode: "local", allowAnonymous: true } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const payload = buildSourceTurnRequest({ source: "codex", conversationId: "local-conversation", turnId: "local-turn",
      startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1,
      completionEvidence: "final_answer:local-turn", query: "Fix the source capture user and Session identity.",
      answer: "The source capture reuses the existing user and Session identity.", status: "succeeded", toolCalls: [], toolResults: []
    }, channel === "concurrent" ? "hook" : channel);
    const submit = async (source: "hook" | "agent_source_scan") => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/source-turns/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, channel: source,
          ...(source === "hook" ? { sessionId: opened.sessionId, namespace: { userId: "installed-owner" } } : {}) })
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ status: string; result: { sessionId: string; l1MemoryId: string } }>;
    };
    try {
      const [first, second] = channel === "concurrent"
        ? await Promise.all([submit("hook"), submit("agent_source_scan")])
        : [await submit(channel), await submit(channel === "hook" ? "agent_source_scan" : "hook")];
      expect([first.status, second.status].sort()).toEqual(["existing", "stored"]);
      expect(first.result.sessionId).toBe(opened.sessionId);
      expect(second.result.l1MemoryId).toBe(first.result.l1MemoryId);
      const repos = new Repositories(db.db);
      expect(repos.memories.get(first.result.l1MemoryId)).toMatchObject({ userId: "installed-owner", sessionId: opened.sessionId,
        info: { project_id: repos.runtime.getSession(opened.sessionId)!.projectId } });
      for (const table of ["sessions", "episodes", "raw_turns", "source_turn_captures"]) {
        expect(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
      }
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ n: 1 });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'trace_summary'").get()).toEqual({ n: 1 });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

});
