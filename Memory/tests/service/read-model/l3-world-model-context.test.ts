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
      memoryVersion: memory?.version,
      renderedContext: `## 通用规则与安全约束\n${content}`,
      generalRulesAndSafetyConstraints: content,
      projectEnvironmentProfile: null,
      projectContract: null,
      domainKnowledge: null
    });

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
       WHERE user_id = ? AND project_id = ?`
    ).run("2026-01-01T00:00:00.000Z", namespace.userId, projectId);

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
       SET applied_scan_id = 'scan-2' WHERE user_id = ? AND project_id = ?`
    ).run(namespace.userId, projectId);
    const projected = service.l3WorldModelContext(opened.sessionId, envelope(scopedNamespace));
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
