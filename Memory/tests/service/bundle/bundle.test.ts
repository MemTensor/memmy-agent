import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / bundle", () => {
  it("exports bundles across namespaces", async () => {
    const { db, service } = createTestService();
    const namespaceA = {
      source: "codex",
      profileId: "default",
      userId: "shared-export-user",
      workspaceId: "workspace-export-a"
    };
    const namespaceB = {
      source: "codex",
      profileId: "default",
      userId: "shared-export-user",
      workspaceId: "workspace-export-b"
    };
    const sessionA = service.openSession({ namespace: namespaceA });
    const sessionB = service.openSession({ namespace: namespaceB });
    const completeA = service.completeTurn("turn-export-a", {
      sessionId: sessionA.sessionId,
      query: "scoped export memory alpha",
      answer: "stored only in export namespace alpha",
      artifacts: [{
        kind: "file",
        uri: "file:///tmp/export-alpha.txt"
      }]
    });
    const completeB = service.completeTurn("turn-export-b", {
      sessionId: sessionB.sessionId,
      query: "scoped export memory beta",
      answer: "stored only in export namespace beta"
    });
    await service.runWorkerOnce(20);
    const recallA = await service.search({
      namespace: namespaceA,
      query: "scoped export memory alpha",
      layers: ["L1"],
      limit: 5
    });
    const recallB = await service.search({
      namespace: namespaceB,
      query: "scoped export memory beta",
      layers: ["L1"],
      limit: 5
    });

    const bundleA = service.exportBundle({ namespace: namespaceA });
    const memoryIds = (bundleA.tables.memories as Array<Record<string, unknown>>).map((row) => row.id);
    expect(memoryIds).toContain(completeA.l1MemoryId);
    expect(memoryIds).toContain(completeB.l1MemoryId);
    const sessionIds = (bundleA.tables.sessions as Array<Record<string, unknown>>).map((row) => row.id);
    expect(sessionIds.sort()).toEqual([sessionA.sessionId, sessionB.sessionId].sort());
    const rawTurnIds = (bundleA.tables.raw_turns as Array<Record<string, unknown>>).map((row) => row.id);
    expect(rawTurnIds).toContain(completeA.rawTurnId);
    expect(rawTurnIds).toContain(completeB.rawTurnId);
    const recallIds = (bundleA.tables.recall_events as Array<Record<string, unknown>>).map((row) => row.id);
    expect(recallIds).toContain(recallA.searchEventId);
    expect(recallIds).toContain(recallB.searchEventId);
    const artifactRawTurnIds = (bundleA.tables.artifacts as Array<Record<string, unknown>>)
      .map((row) => row.raw_turn_id);
    expect(artifactRawTurnIds).toEqual([completeA.rawTurnId]);
    const jobSessionIds = new Set((bundleA.tables.evolution_jobs as Array<Record<string, unknown>>)
      .map((row) => row.session_id));
    expect(jobSessionIds).toEqual(new Set([sessionA.sessionId, sessionB.sessionId]));
    const changeNamespaces = new Set((bundleA.tables.memory_change_log as Array<Record<string, unknown>>)
      .map((row) => row.namespace_id));
    expect([...changeNamespaces].some((namespace) => String(namespace).includes("workspace-export-a"))).toBe(true);
    expect([...changeNamespaces].some((namespace) => String(namespace).includes("workspace-export-b"))).toBe(true);

    db.close();
  });
});
