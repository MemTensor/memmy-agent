import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../../src/contracts/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import {
  insertActivePolicyMemory,
  insertActiveSkillMemoryForTest,
  insertTracePolicyLinkForTest,
  insertWorldModelMemoryForTest,
  makeTraceEligibleForL2
} from "../../fixtures/evolution-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / lifecycle / governance", () => {
  it("restores missing Policy evidence links when the declared L1 source is still valid", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "restorable-policy-user"
    };
    const session = service.openSession({ namespace, workspaceId: "restorable-policy-workspace" });
    const trace = service.completeTurn("turn-restorable-policy", {
      sessionId: session.sessionId,
      episodeId: "episode-restorable-policy",
      query: "修复 pytest 失败并验证结果",
      answer: "已修复失败并验证测试通过。"
    });
    makeTraceEligibleForL2(db, trace.l1MemoryId);
    insertActivePolicyMemory(db, {
      id: "policy_restorable",
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      appId: "restorable-policy-workspace",
      profileId: namespace.profileId,
      sourceTraceId: trace.l1MemoryId,
      sourceEpisodeId: trace.episodeId
    });

    const first = service.reconcileWorkerStartup();
    const second = service.reconcileWorkerStartup();

    expect(first.reconciledOrphanPolicies).toBe(1);
    expect(first.policyEvidencePreflight).toEqual({
      orphanPolicyIds: [],
      affectedWorldModelIds: [],
      affectedSkillIds: [],
      restorablePolicyIds: ["policy_restorable"]
    });
    expect(second.reconciledOrphanPolicies).toBe(0);
    expect(second.policyEvidencePreflight).toEqual({
      orphanPolicyIds: [],
      affectedWorldModelIds: [],
      affectedSkillIds: [],
      restorablePolicyIds: []
    });
    expect(memoryState(db, "policy_restorable")).toBe("activated");
    expect(db.db.prepare(
      `SELECT l1_memory_id, l2_memory_id
       FROM trace_policy_links
       WHERE l1_memory_id = ? AND l2_memory_id = ?`
    ).get(trace.l1MemoryId, "policy_restorable")).toEqual({
      l1_memory_id: trace.l1MemoryId,
      l2_memory_id: "policy_restorable"
    });
    db.close();
  });

  it("[BC-22] reports orphaned active policies and derived memories before an idempotent startup migration", () => {
    const { db, service } = createTestService();
    const policyInput = {
      userId: "orphan-policy-user",
      sessionId: "orphan-policy-session",
      agentId: "codex",
      appId: "orphan-policy-workspace",
      profileId: "jiang"
    };
    insertActivePolicyMemory(db, {
      ...policyInput,
      id: "policy_orphaned",
      sourceTraceId: "missing_l1_evidence",
      sourceEpisodeId: "missing_episode"
    });
    insertWorldModelMemoryForTest(db, {
      ...policyInput,
      id: "world_orphaned",
      memoryKey: "world:orphaned",
      domainKey: "orphaned|policy",
      domainTags: ["orphaned"],
      policyIds: ["policy_orphaned"]
    });
    insertActiveSkillMemoryForTest(db, {
      ...policyInput,
      id: "skill_orphaned",
      sourcePolicyIds: ["policy_orphaned"]
    });

    const first = service.reconcileWorkerStartup();
    const second = service.reconcileWorkerStartup();

    expect(first.reconciledOrphanPolicies).toBe(1);
    expect(first.policyEvidencePreflight).toEqual({
      orphanPolicyIds: ["policy_orphaned"],
      affectedWorldModelIds: ["world_orphaned"],
      affectedSkillIds: ["skill_orphaned"],
      restorablePolicyIds: []
    });
    expect(second.reconciledOrphanPolicies).toBe(0);
    expect(second.policyEvidencePreflight).toEqual({
      orphanPolicyIds: [],
      affectedWorldModelIds: [],
      affectedSkillIds: [],
      restorablePolicyIds: []
    });
    expect(memoryState(db, "policy_orphaned")).toBe("archived");
    expect(memoryProperties(db, "policy_orphaned").internal_info?.policy?.status)
      .toBe("quarantined");
    expect(memoryState(db, "world_orphaned")).toBe("activated");
    expect(memoryState(db, "skill_orphaned")).toBe("archived");
    expect(memoryProperties(db, "skill_orphaned").internal_info?.skill?.status)
      .toBe("suspended");
    db.close();
  });

  it("[BC-11][BC-26] recomputes Policy, World Model, and Skill dependencies after deleting L1 evidence", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "dependency-user",
      projectId: "dependency-project"
    };
    const session = service.openSession({ namespace, workspaceId: "dependency-workspace" });
    const p1Trace = service.completeTurn("turn-dependency-p1", {
      sessionId: session.sessionId,
      episodeId: "episode-dependency-p1",
      query: "修复迁移失败并运行测试验证结果",
      answer: "已定位迁移错误，修复后测试通过。"
    });
    const p2Trace = service.completeTurn("turn-dependency-p2", {
      sessionId: session.sessionId,
      episodeId: "episode-dependency-p2",
      query: "检查数据库回滚流程并验证结果",
      answer: "已验证回滚流程可用。"
    });
    const policyInput = {
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      appId: "dependency-workspace",
      profileId: namespace.profileId
    };
    insertActivePolicyMemory(db, {
      ...policyInput,
      id: "policy_dependency_p1",
      sourceTraceId: p1Trace.l1MemoryId,
      sourceEpisodeId: p1Trace.episodeId
    });
    insertActivePolicyMemory(db, {
      ...policyInput,
      id: "policy_dependency_p2",
      sourceTraceId: p2Trace.l1MemoryId,
      sourceEpisodeId: p2Trace.episodeId
    });
    insertTracePolicyLinkForTest(db, {
      userId: namespace.userId,
      l1MemoryId: p1Trace.l1MemoryId,
      l2MemoryId: "policy_dependency_p1"
    });
    insertWorldModelMemoryForTest(db, {
      ...policyInput,
      id: "world_dependency_p1",
      memoryKey: "world:dependency-p1",
      domainKey: "dependency|p1",
      domainTags: ["dependency"],
      policyIds: ["policy_dependency_p1"]
    });
    insertActiveSkillMemoryForTest(db, {
      ...policyInput,
      id: "skill_dependency_p1",
      sourcePolicyIds: ["policy_dependency_p1"],
      evidenceAnchorIds: [p1Trace.l1MemoryId]
    });
    insertActiveSkillMemoryForTest(db, {
      ...policyInput,
      id: "skill_dependency_shared",
      sourcePolicyIds: ["policy_dependency_p1", "policy_dependency_p2"],
      evidenceAnchorIds: [p1Trace.l1MemoryId, p2Trace.l1MemoryId]
    });
    setSkillSteps(db, "skill_dependency_p1", [{
      id: "step-p1-only",
      title: "P1 only",
      body: "Only P1 supports this step.",
      supportingPolicyIds: ["policy_dependency_p1"]
    }]);
    setSkillSteps(db, "skill_dependency_shared", [{
      id: "step-p1",
      title: "P1 optional",
      body: "Only P1 supports this optional step.",
      supportingPolicyIds: ["policy_dependency_p1"]
    }, {
      id: "step-p2",
      title: "P2 remains",
      body: "P2 keeps this step valid.",
      supportingPolicyIds: ["policy_dependency_p2"]
    }]);

    service.deleteMemory(p1Trace.l1MemoryId, { namespace });

    expect(memoryState(db, "policy_dependency_p1")).toBe("archived");
    expect(memoryProperties(db, "policy_dependency_p1").internal_info?.policy?.status)
      .toBe("quarantined");
    expect(memoryState(db, "world_dependency_p1")).toBe("activated");
    expect(memoryState(db, "skill_dependency_p1")).toBe("archived");
    expect(memoryProperties(db, "skill_dependency_p1").internal_info?.skill?.status)
      .toBe("suspended");
    expect(memoryState(db, "skill_dependency_shared")).toBe("activated");
    const shared = memoryProperties(db, "skill_dependency_shared");
    expect(shared.internal_info?.skill?.source_policy_ids).toEqual(["policy_dependency_p2"]);
    expect(shared.internal_info?.skill?.procedure_json?.steps).toEqual([
      expect.objectContaining({
        id: "step-p2",
        supportingPolicyIds: ["policy_dependency_p2"]
      })
    ]);
    db.close();
  });

  it("exports redacted bundles, imports them, and records governance audit changes", async () => {
    const first = createTestService();
    const session = first.service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "gov-user",
        projectId: "project-alpha"
      },
      workspaceId: "workspace-alpha"
    });
    const complete = first.service.completeTurn("turn-governance", {
      sessionId: session.sessionId,
      query: "secret raw user text should not be exported by default",
      answer: "secret raw assistant text should stay in raw turn only"
    });
    first.service.closeSession(session.sessionId);
    await first.service.runWorkerOnce(20);
    await first.service.runWorkerOnce(20);

    const redactedBundle = first.service.exportBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "gov-user",
        projectId: "project-alpha"
      }
    });
    const exportedRawTurns = redactedBundle.tables.raw_turns as Array<{
      id: string;
      user_text: string | null;
      assistant_text: string | null;
      tool_calls_json: string;
    }>;
    const exportedRawTurn = exportedRawTurns.find((row) => row.id === complete.rawTurnId);
    expect(exportedRawTurn?.user_text).toBeNull();
    expect(exportedRawTurn?.assistant_text).toBeNull();
    expect(exportedRawTurn?.tool_calls_json).toBe("[]");
    const exportedMemory = (redactedBundle.tables.memories as Array<Record<string, unknown>>)
      .find((row) => row.id === complete.l1MemoryId);
    expect(exportedMemory).toBeTruthy();
    const exportedVector = (redactedBundle.tables.memory_vectors as Array<Record<string, unknown>>)
      .find((row) => row.memory_id === complete.l1MemoryId && row.vector_field === "vec_summary");
    expect(exportedVector).toBeTruthy();
    exportedVector!.embedding_model = "foreign-embedding-model";
    for (const row of redactedBundle.tables.sessions as Array<Record<string, unknown>>) {
      delete row.last_seen_at;
    }
    for (const row of redactedBundle.tables.episodes as Array<Record<string, unknown>>) {
      delete row.turn_count;
    }

    const rawBundle = first.service.exportBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "gov-user",
        projectId: "project-alpha"
      },
      includeRawText: true
    });
    const rawExportedTurn = (rawBundle.tables.raw_turns as Array<{
      id: string;
      user_text: string | null;
    }>).find((row) => row.id === complete.rawTurnId);
    expect(rawExportedTurn?.user_text).toContain("secret raw user text");

    const second = createTestService();
    const imported = second.service.importBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "import-user"
      },
      bundle: redactedBundle
    });
    expect(imported.ok).toBe(true);
    expect(imported.inserted.memories).toBeGreaterThanOrEqual(1);
    expect(imported.migrationMap.memories?.[complete.l1MemoryId]).toBe(complete.l1MemoryId);
    expect(imported.conflicts).toHaveLength(0);
    expect(imported.reembedMemoryIds).toContain(complete.l1MemoryId);
    const importedMemory = second.service.getMemory(complete.l1MemoryId);
    expect(importedMemory.id).toBe(complete.l1MemoryId);

    const duplicateImport = second.service.importBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "import-user"
      },
      bundle: redactedBundle
    });
    expect(duplicateImport.skipped.memories).toBeGreaterThanOrEqual(1);
    expect(duplicateImport.migrationMap.memories?.[complete.l1MemoryId]).toBe(complete.l1MemoryId);
    expect(duplicateImport.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "memories",
        primaryKey: "id",
        sourceId: complete.l1MemoryId,
        targetId: complete.l1MemoryId,
        action: "skipped"
      })
    ]));

    const redact = first.service.redactRawTurn(complete.rawTurnId, {
      reason: "test raw redaction"
    });
    expect(redact.changeSeq).toBeGreaterThan(0);
    const rawTurnAfterRedact = first.db.db.prepare(
      `SELECT user_text, assistant_text, redacted_at
       FROM raw_turns
       WHERE id = ?`
    ).get(complete.rawTurnId) as {
      user_text: string | null;
      assistant_text: string | null;
      redacted_at: string | null;
    };
    expect(rawTurnAfterRedact.user_text).toBeNull();
    expect(rawTurnAfterRedact.assistant_text).toBeNull();
    expect(rawTurnAfterRedact.redacted_at).toBeTruthy();

    const archive = first.service.archiveMemory(complete.l1MemoryId, {
      reason: "test archive"
    });
    expect(archive.status).toBe("archived");
    const deleteResult = first.service.deleteMemory(complete.l1MemoryId, {
      reason: "test delete"
    });
    expect(deleteResult.status).toBe("deleted");
    const deletedRow = first.db.db.prepare(
      `SELECT status, deleted_at, properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as {
      status: string;
      deleted_at: string | null;
      properties_json: string;
    };
    expect(deletedRow.status).toBe("deleted");
    expect(deletedRow.deleted_at).toBeTruthy();
    expect((JSON.parse(deletedRow.properties_json) as { status?: string }).status).toBe("deleted");

    const changes = first.service.panelChanges({ userId: "gov-user" });
    expect(changes.changes.some((change) => change.kind === "raw_turn" && change.op === "updated")).toBe(true);
    expect(changes.changes.some((change) => change.kind === "trace" && change.op === "archived")).toBe(true);
    expect(changes.changes.some((change) => change.kind === "trace" && change.op === "deleted")).toBe(true);
    const audit = first.service.auditLogs({ userId: "gov-user" });
    expect(audit.items.map((item) => item.action)).toEqual(expect.arrayContaining([
      "export",
      "raw_redact",
      "archive",
      "delete"
    ]));

    first.db.close();
    second.db.close();
  });
});

function setSkillSteps(
  db: ReturnType<typeof createTestService>["db"],
  skillId: string,
  steps: Array<Record<string, unknown>>
): void {
  const row = db.db.prepare(`SELECT properties_json FROM memories WHERE id = ?`).get(skillId) as {
    properties_json: string;
  };
  const properties = JSON.parse(row.properties_json) as {
    internal_info?: Record<string, any>;
  };
  const internal = properties.internal_info!;
  internal.procedure_json = { ...(internal.procedure_json ?? {}), steps };
  internal.skill = {
    ...(internal.skill ?? {}),
    procedure_json: { ...(internal.skill?.procedure_json ?? {}), steps }
  };
  db.db.prepare(`UPDATE memories SET properties_json = ? WHERE id = ?`)
    .run(JSON.stringify(properties), skillId);
}

function memoryState(db: ReturnType<typeof createTestService>["db"], id: string): string {
  return (db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(id) as { status: string }).status;
}

function memoryProperties(
  db: ReturnType<typeof createTestService>["db"],
  id: string
): {
  internal_info?: {
    policy?: {
      status?: string;
    };
    skill?: {
      status?: string;
      source_policy_ids?: string[];
      procedure_json?: { steps?: Array<Record<string, unknown>> };
    };
  };
} {
  const row = db.db.prepare(`SELECT properties_json FROM memories WHERE id = ?`).get(id) as {
    properties_json: string;
  };
  return JSON.parse(row.properties_json);
}

describe("L3 project environment scan triggers", () => {
  it("queues on project Session creation and only on successful compaction with an L1 head", () => {
    const { db, root, service } = createTestService();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, "package.json"), '{"name":"trigger-test"}');
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "project-trigger-session",
      userId: "project-trigger-user"
    };
    const request = {
      l3WorldModelProtocolVersion: 2 as const,
      l3WorldModelTransition: "resume_only" as const,
      workspaceUri: pathToFileURL(projectRoot).href,
      workspaceHostId: "e".repeat(64),
      namespace
    };
    const opened = service.openSession(request);
    const jobCount = () => (db.db.prepare(
      `SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type = 'project_environment_profile'`
    ).get() as { count: number }).count;

    expect(jobCount()).toBe(1);
    expect(service.openSession(request)).toMatchObject({ sessionId: opened.sessionId, resumed: true });
    expect(jobCount()).toBe(1);
    expect(() => service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "2bd45fcb-af1c-4e62-ae16-f214bb465c20",
      adapterId: "codex-memory",
      source: "codex",
      namespace: { ...namespace, projectId: opened.projectId! },
      trigger: "token_compaction",
      throughL1MemoryId: "missing-l1"
    })).toThrow("through L1 memory was not registered");
    expect(jobCount()).toBe(1);

    const completed = service.completeTurn("project-trigger-turn", {
      sessionId: opened.sessionId,
      query: "Change one file",
      answer: "Changed one file"
    });
    expect(jobCount()).toBe(1);
    const envelope = {
      requestId: "89e0763c-a864-40f4-b6fd-98fb4af1f722",
      adapterId: "codex-memory",
      source: "codex",
      namespace: { ...namespace, projectId: opened.projectId! },
      throughL1MemoryId: completed.l1MemoryId
    };
    service.l3WorldModelBoundary(opened.sessionId, {
      ...envelope,
      trigger: "token_compaction_attempt"
    });
    expect(jobCount()).toBe(1);
    service.l3WorldModelBoundary(opened.sessionId, {
      ...envelope,
      requestId: "49bf4829-c9bd-4bb2-acfa-4b265fc66dba",
      trigger: "token_compaction"
    });
    expect(jobCount()).toBe(2);
    service.l3WorldModelBoundary(opened.sessionId, {
      ...envelope,
      requestId: "2c36608a-afac-47bf-a258-926b27258e57",
      trigger: "token_compaction"
    });
    expect(jobCount()).toBe(2);
  });

  it("does not queue for non-project, legacy, non-local, or cloud Sessions", () => {
    const local = createTestService();
    local.service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "no-project-session",
        userId: "scan-boundary-user"
      }
    });
    local.service.openSession({
      workspacePath: local.root,
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "legacy-session",
        userId: "scan-boundary-user"
      }
    });
    local.service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "ssh://example.test/project",
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "remote-project-session",
        userId: "scan-boundary-user"
      }
    });
    expect(local.db.db.prepare(
      `SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type = 'project_environment_profile'`
    ).get()).toEqual({ count: 0 });

    const cloud = createTestService({ mode: "cloud" });
    const cloudProjectRoot = join(cloud.root, "project");
    mkdirSync(cloudProjectRoot);
    cloud.service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: pathToFileURL(cloudProjectRoot).href,
      workspaceHostId: "a".repeat(64),
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "cloud-project-session",
        userId: "cloud-scan-boundary-user"
      }
    });
    expect(cloud.db.db.prepare(
      `SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type = 'project_environment_profile'`
    ).get()).toEqual({ count: 0 });
  });
});


describe("L3 World Model scope deletion", () => {
  it("detaches the unique scope and makes already queued field work no-change", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "l3-delete-session",
      userId: "l3-delete-user"
    };
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      namespace
    });
    const completed = service.completeTurn("l3-delete-turn", {
      sessionId: opened.sessionId,
      query: "Never destroy source data without confirmation.",
      answer: "The source data was preserved.",
      toolCalls: [{ name: "delete", input: { path: "source.csv" } }],
      toolResults: [{ name: "delete", output: "confirmation required", exitCode: 1 }]
    });
    service.l3WorldModelBoundary(opened.sessionId, {
      requestId: "b14640a4-3f57-4fb4-9007-ad2f6bd22bc4",
      adapterId: "codex-memory",
      source: "codex",
      namespace,
      trigger: "token_compaction",
      throughL1MemoryId: completed.l1MemoryId
    });
    const repos = new Repositories(db.db);
    const existing = repos.l3WorldModels.upsertField({
      userId: namespace.userId,
      targetField: "general_rules_and_safety_constraints",
      value: "Never destroy source data without confirmation."
    })!;

    service.deleteMemory(existing.id, { namespace });

    expect(repos.l3WorldModels.getScope(namespace.userId, null)?.memoryId).toBeUndefined();
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(existing.id))
      .toEqual({ status: "deleted" });
    expect(db.db.prepare(
      `SELECT status, no_change FROM l3_world_model_batch_targets`
    ).get()).toEqual({ status: "applied", no_change: 1 });
    expect(db.db.prepare(
      `SELECT status, leased_until FROM evolution_jobs WHERE job_type = 'l3_world_model_update'`
    ).get()).toEqual({ status: "succeeded", leased_until: null });
    expect(db.db.prepare(
      `SELECT terminal_outcome FROM l3_world_model_evidence_batches`
    ).get()).toEqual({ terminal_outcome: "applied" });

    const recreated = repos.l3WorldModels.upsertField({
      userId: namespace.userId,
      targetField: "general_rules_and_safety_constraints",
      value: "Keep deletions recoverable."
    });
    expect(recreated?.id).not.toBe(existing.id);
    expect(recreated?.status).toBe("activated");

    db.close();
  });

  it("resets project profile state and prevents an old profile job from recreating the deleted L3", async () => {
    const { db, service } = createTestService();
    const userId = "l3-project-delete-user";
    const workspaceUri = "file:///workspace/project-delete";
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri,
      workspaceHostId: "d".repeat(64),
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "l3-project-delete-session",
        userId
      }
    });
    const namespace = {
      source: "codex",
      profileId: "default",
      sessionKey: "l3-project-delete-session",
      userId,
      projectId: opened.projectId!
    };
    const repos = new Repositories(db.db);
    const existing = repos.l3WorldModels.upsertField({
      userId,
      projectId: opened.projectId,
      targetField: "project_contract",
      value: "Run project tests before commit."
    })!;

    service.deleteMemory(existing.id, { namespace });

    expect(repos.l3WorldModels.getScope(userId, opened.projectId)).toMatchObject({
      workspaceUri,
      memoryId: undefined
    });
    expect(db.db.prepare(
      `SELECT status, current_scan_id, applied_scan_id, fingerprint, last_error
       FROM l3_world_model_project_environment_state`
    ).get()).toEqual({
      status: "uninitialized",
      current_scan_id: null,
      applied_scan_id: null,
      fingerprint: null,
      last_error: null
    });
    expect(service.panelItems({ layer: "L3" }).items.some((item) => item.id === existing.id)).toBe(false);

    await service.runWorkerOnce(10);
    expect(db.db.prepare(
      `SELECT status FROM evolution_jobs WHERE job_type = 'project_environment_profile'`
    ).get()).toEqual({ status: "succeeded" });
    expect(repos.l3WorldModels.getScope(userId, opened.projectId)?.memoryId).toBeUndefined();

    db.close();
  });
});
