import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / namespace / project isolation", () => {
  it("shares a project across agents while isolating projects A, B, and blank C", async () => {
    const { db, service } = createTestService();
    const projectA = {
      source: "codex",
      profileId: "codex-main",
      userId: "local-user",
      workspacePath: "/work/project-a"
    };
    const projectAFromPi = {
      source: "pi",
      profileId: "pi-main",
      userId: "local-user",
      workspacePath: "/work/project-a/"
    };
    const projectB = {
      source: "claude-code",
      profileId: "claude-main",
      userId: "local-user",
      workspacePath: "/work/project-b"
    };
    const blankProjectC = {
      source: "codex",
      profileId: "codex-main",
      userId: "local-user"
    };

    const added = service.addMemory({
      namespace: projectA,
      source: "codex",
      layer: "L2",
      title: "Project A boundary marker",
      content: "zircon canary sevenfox only belongs to project A"
    });

    const sameProject = await service.search({
      namespace: projectAFromPi,
      query: "zircon canary sevenfox",
      includeInjectedContext: true
    });
    expect(sameProject.hits.map((hit) => hit.id)).toContain(added.id);
    expect(sameProject.injectedContext.markdown).toContain("zircon canary sevenfox");

    for (const namespace of [projectB, blankProjectC]) {
      const result = await service.search({
        namespace,
        query: "zircon canary sevenfox",
        includeInjectedContext: true
      });
      expect(result.hits).toEqual([]);
      expect(result.candidateMemoryIds).toEqual([]);
      expect(result.injectedContext.markdown).not.toContain("zircon canary sevenfox");
      expect(() => service.getMemory(added.id, { namespace })).toThrow(/memory not found/);
    }

    expect(service.getMemory(added.id, { namespace: projectAFromPi }).id).toBe(added.id);
    db.close();
  });

  it("derives the same stable project id from normalized workspace paths", () => {
    const { db, service } = createTestService();
    const first = service.openSession({
      namespace: { source: "codex", profileId: "default", userId: "local-user" },
      workspacePath: "C:\\Work\\Memmy\\"
    });
    const second = service.openSession({
      namespace: { source: "pi", profileId: "main", userId: "local-user" },
      workspacePath: "c:/Work/Memmy"
    });

    expect(first.projectId).toMatch(/^workspace_[a-f0-9]{24}$/);
    expect(second.projectId).toBe(first.projectId);
    expect(second.workspaceId).toBe(first.workspaceId);
    db.close();
  });

  it("isolates tenants that use the same project id and persists tenant provenance", async () => {
    const { db, service } = createTestService();
    const tenantA = {
      source: "codex",
      profileId: "default",
      userId: "shared-user",
      tenantId: "tenant-a",
      projectId: "shared-project"
    };
    const tenantB = { ...tenantA, tenantId: "tenant-b" };
    const added = service.addMemory({
      namespace: tenantA,
      source: "codex",
      layer: "L2",
      title: "Tenant A marker",
      content: "tenant alpha heliotrope marker"
    });

    expect((await service.search({ namespace: tenantA, query: "heliotrope marker" })).hits)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: added.id })]));
    expect((await service.search({ namespace: tenantB, query: "heliotrope marker" })).hits).toEqual([]);
    expect(() => service.getMemory(added.id, { namespace: tenantB })).toThrow(/memory not found/);
    const detail = service.getMemory(added.id, { namespace: tenantA });
    expect("provenance" in detail ? detail.provenance : undefined).toMatchObject({
      tenantId: "tenant-a",
      projectId: "shared-project"
    });

    const opened = service.openSession({ namespace: tenantA });
    const session = db.db.prepare("SELECT meta_json FROM sessions WHERE id = ?")
      .get(opened.sessionId) as { meta_json: string };
    expect(JSON.parse(session.meta_json)).toMatchObject({ tenant_id: "tenant-a" });
    db.close();
  });

  it("treats a blank namespace as unscoped for known session, episode, and raw-turn ids", () => {
    const { db, service } = createTestService();
    const scoped = {
      source: "codex",
      profileId: "default",
      userId: "local-user",
      tenantId: "tenant-a",
      projectId: "private-project"
    };
    const blank = {
      source: "codex",
      profileId: "default",
      userId: "local-user",
      tenantId: "tenant-a"
    };
    const opened = service.openSession({ namespace: scoped });
    const completed = service.completeTurn("known-id-turn", {
      sessionId: opened.sessionId,
      query: "known id isolation",
      answer: "keep this scoped"
    });

    expect(() => service.closeSession(opened.sessionId, { namespace: blank })).toThrow(/session not found/);
    expect(() => service.deletePanelTask(completed.episodeId, { namespace: blank })).toThrow(/episode not found/);
    expect(() => service.redactRawTurn(completed.rawTurnId, { namespace: blank })).toThrow(/raw turn not found/);
    expect(service.closeSession(opened.sessionId, { namespace: scoped }).status).toBe("closed");
    db.close();
  });
});
