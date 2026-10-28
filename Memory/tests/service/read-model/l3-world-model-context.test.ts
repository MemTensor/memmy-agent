import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("Session L3 World Model context read model", () => {
  it.each(["project_contract", "domain_knowledge"] as const)("refreshes context after an equal-length tail edit to long %s", (targetField) => {
    const { db, service } = createTestService();
    const namespace = { source: "codex", profileId: "default", sessionKey: "long-context", userId: "account-a" };
    const session = service.openSession({ namespace, workspaceUri: "file:///tmp/long-context", workspaceHostId: "b".repeat(64), l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only" });
    const scopedNamespace = { ...namespace, projectId: session.projectId! };
    const repos = new Repositories(db.db);
    const prefix = "规则x".repeat(10_000);
    const write = (suffix: string, sources = ["historical-l1"]) => repos.l3WorldModels.upsertField({
      userId: namespace.userId, projectId: session.projectId!, targetField, value: prefix + suffix, eligibleL1MemoryIds: sources
    });
    write("A");
    const before = service.l3WorldModelContext(session.sessionId, envelope(scopedNamespace));
    write("B");
    const after = service.l3WorldModelContext(session.sessionId, envelope({ ...scopedNamespace, userId: "account-b" }));
    expect(after.memoryId).toBe(before.memoryId);
    expect(after.memoryVersion).not.toBe(before.memoryVersion);
    expect(after.renderedContext).toContain(prefix + "B");
    expect(after.renderedContext).not.toContain(prefix + "A");
    expect(service.l3WorldModelContext(session.sessionId, envelope(scopedNamespace)).memoryVersion).toBe(after.memoryVersion);
    write("B", ["new-l1"]);
    const withNewSource = service.l3WorldModelContext(session.sessionId, envelope(scopedNamespace));
    expect(withNewSource.renderedContext).toBe(after.renderedContext);
    expect(withNewSource.memoryVersion).not.toBe(after.memoryVersion);
    expect(withNewSource.sourceMemoryIds).toEqual(expect.arrayContaining(["historical-l1", "new-l1"]));
  });

  it("loads one exact no-project record without truncating it", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "context-general-session",
      userId: "context-general-user"
    };
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      namespace
    });
    const repos = new Repositories(db.db);
    const content = `Preserve user data.\n${"x".repeat(12_000)}`;
    const memory = repos.l3WorldModels.upsertField({
      userId: namespace.userId,
      targetField: "general_rules_and_safety_constraints",
      value: content,
      eligibleL1MemoryIds: []
    });

    expect(service.l3WorldModelContext(opened.sessionId, envelope(namespace))).toMatchObject({
      schemaVersion: 2,
      projectId: null,
      memoryId: memory?.id,
      memoryVersion: expect.any(Number),
      renderedContext: `## 通用规则与安全约束\n${content}`,
      generalRulesAndSafetyConstraints: content,
      projectEnvironmentProfile: null,
      projectContract: null,
      domainKnowledge: null
    });

    db.close();
  });

  it("keeps an explicitly archived project L3 archived in the panel and out of session context", () => {
    const { db, service } = createTestService();
    const namespace = { source: "codex", profileId: "default", sessionKey: "archive-context", userId: "archive-user" };
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/archive-context",
      workspaceHostId: "a".repeat(64),
      namespace
    });
    const repos = new Repositories(db.db);
    const memory = repos.l3WorldModels.upsertField({
      userId: namespace.userId,
      projectId: opened.projectId,
      targetField: "project_contract",
      value: "Archived content must stay out of the session context."
    })!;
    expect(service.l3WorldModelContext(opened.sessionId, envelope({ ...namespace, projectId: opened.projectId! })).renderedContext)
      .toContain("Archived content");

    service.archiveMemory(memory.id, { namespace });

    expect(repos.l3WorldModels.getMemory(null, opened.projectId)?.status).toBe("archived");
    expect(service.l3WorldModelContext(opened.sessionId, envelope({ ...namespace, projectId: opened.projectId! })))
      .toMatchObject({ renderedContext: "", projectContract: null, memoryId: null });
    expect(service.panelItems({ layer: "L3", status: "activated" }).items).toEqual([]);
    expect(service.panelItems({ layer: "L3", status: "archived" }).items).toContainEqual(
      expect.objectContaining({ id: memory.id, status: "archived" })
    );
    db.close();
  });

  it("projects out a stale environment profile while preserving contract and knowledge", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "context-project-session",
      userId: "context-project-user"
    };
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/context-project",
      workspaceHostId: "b".repeat(64),
      namespace
    });
    const projectId = opened.projectId!;
    const scopedNamespace = { ...namespace, projectId };
    const repos = new Repositories(db.db);
    repos.l3WorldModels.upsertField({
      userId: namespace.userId,
      projectId,
      targetField: "project_environment_profile",
      value: "语言：TypeScript",
      projectEnvironmentAppliedScanId: "scan-1"
    });
    repos.l3WorldModels.upsertField({
      userId: namespace.userId,
      projectId,
      targetField: "project_contract",
      value: "提交前运行测试。"
    });
    const memory = repos.l3WorldModels.upsertField({
      userId: namespace.userId,
      projectId,
      targetField: "domain_knowledge",
      value: "Node 22 -> 可使用原生 TypeScript strip types。"
    })!;
    db.db.prepare(
      `UPDATE l3_world_model_project_environment_state
       SET project_kind = 'code', status = 'clean', applied_scan_id = 'scan-1', updated_at = ?
       WHERE user_id IS ? AND project_id = ?`
    ).run("2026-01-01T00:00:00.000Z", null, projectId);

    const context = service.l3WorldModelContext(opened.sessionId, envelope(scopedNamespace));
    expect(context).toMatchObject({
      projectEnvironmentProfile: "语言：TypeScript",
      projectContract: "提交前运行测试。",
      domainKnowledge: "Node 22 -> 可使用原生 TypeScript strip types。"
    });
    expect(JSON.stringify(context)).not.toContain("file:///tmp/context-project");
    const before = repos.memories.get(memory.id)!;
    db.db.prepare(
      `UPDATE l3_world_model_project_environment_state
       SET applied_scan_id = 'scan-2' WHERE user_id IS ? AND project_id = ?`
    ).run(null, projectId);
    const projected = service.l3WorldModelContext(opened.sessionId, envelope(scopedNamespace));
    expect(projected.memoryVersion).not.toBe(context.memoryVersion);
    expect(service.l3WorldModelContext(opened.sessionId, envelope(scopedNamespace)).memoryVersion).toBe(projected.memoryVersion);
    expect(projected.projectEnvironmentProfile).toBeNull();
    expect(projected.projectContract).toBe("提交前运行测试。");
    expect(projected.domainKnowledge).toBe("Node 22 -> 可使用原生 TypeScript strip types。");
    expect(projected.renderedContext).not.toContain("语言：TypeScript");
    expect(repos.memories.get(memory.id)).toMatchObject({
      version: before.version,
      memoryValue: before.memoryValue
    });

    const other = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/context-other-project",
      workspaceHostId: "b".repeat(64),
      namespace: { ...namespace, sessionKey: "context-other-project-session" }
    });
    expect(service.l3WorldModelContext(other.sessionId, envelope({
      ...namespace,
      sessionKey: "context-other-project-session",
      projectId: other.projectId!
    })).memoryId).toBeNull();

    db.close();
  });
});

function envelope(namespace: {
  source: string;
  profileId: string;
  sessionKey: string;
  userId: string;
  projectId?: string;
}) {
  return {
    requestId: "9353298b-4d3d-46f0-9178-27c27e81543e",
    adapterId: "codex-memory",
    source: namespace.source,
    namespace
  };
}
