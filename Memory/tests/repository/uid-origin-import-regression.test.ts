import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../src/storage/repositories.js";
import { createCapturingEmbedder, createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { MemoryDb } from "../../src/storage/db.js";
import { join } from "node:path";
import { canonicalProjectId } from "../../src/storage/device-scope.js";
import { SqliteVecStore } from "../../src/storage/sqlite-vec-store.js";
import { embeddingTextForMemory } from "../../src/service/embedding/embedding-pipeline.js";

const fixture = createMemoryServiceFixture();
afterEach(() => { vi.restoreAllMocks(); fixture.cleanup(); });
const at = "2026-10-01T00:00:00.000Z";
const turnInput = {
  query: "Inspect package.json and report the test command.", answer: "Use npm test.",
  toolCalls: [{ id: "read", name: "read_file", input: { path: "package.json" } }],
  toolResults: [{ id: "read", output: "npm test" }]
};

function deletedBackup() {
  const target = fixture.createTestService(), source = fixture.createTestService();
  const tr = new Repositories(target.db.db), sr = new Repositories(source.db.db);
  const memory = tr.l3WorldModels.upsertField({ userId: null, projectId: "project-p",
    targetField: "project_contract", value: "Keep target rule", at })!;
  target.db.db.prepare("UPDATE memories SET user_id='old' WHERE id=?").run(memory.id);
  target.db.db.prepare("UPDATE l3_world_model_scopes SET user_id='old' WHERE memory_id=?").run(memory.id);
  target.db.db.exec("DELETE FROM memory_l3_overrides");
  sr.runtime.importBundleTables(tr.runtime.exportBundleTables(true));
  sr.l3WorldModels.deleteScopeMemory(memory.id, "2026-10-02T00:00:00.000Z");
  return { target, source, tr, sr, memory, bundle: sr.runtime.exportBundleTables(true) };
}

describe("UID decoupling origin and import boundaries", () => {
  it.each(["project", "workspace", "both"])("keeps independent evidence after empty %s is filled", boundary => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const common = { source: "codex", profileId: "default", userId: "account-a" };
    const first = { ...common, sessionKey: "a",
      ...(boundary === "project" ? { workspaceId: "workspace-b" } : {}),
      ...(boundary === "workspace" ? { projectId: "project-b" } : {}) };
    const second = { ...common, sessionKey: "b", projectId: "project-b", workspaceId: "workspace-b" };
    const a = service.openSession({ namespace: first, meta: { conversationId: "native-chat" } });
    const b = service.openSession({ namespace: second, meta: { conversationId: "native-chat" } });
    const capture = (sessionId: string, namespace: typeof first) => service.completeTurn("native-turn", {
      sessionId, namespace, query: "Inspect package.json and report the test command.", answer: "Use npm test.",
      toolCalls: [{ id: "read", name: "read_file", input: { path: "package.json" } }],
      toolResults: [{ id: "read", output: "npm test" }]
    });
    const ta = capture(a.sessionId, first), tb = capture(b.sessionId, second);
    expect(ta.l1MemoryId).not.toBe(tb.l1MemoryId);
    for (const [key, turn, session] of [["a", ta, a], ["b", tb, b]] as const) {
      repos.runtime.upsertCandidatePoolTrace({ id: key, userId: null, sessionId: session.sessionId,
        sourceMemoryId: turn.l1MemoryId!, candidateKey: "policy", candidateValue: "same evidence", score: 1,
        evidence: {}, createdAt: at, updatedAt: at });
    }
    service.openSession({ sessionId: a.sessionId, namespace: second });
    repos.memories.softDelete(ta.l1MemoryId!);
    expect(repos.memories.nativeDuplicates(repos.memories.get(tb.l1MemoryId!)!).ids).toEqual([tb.l1MemoryId]);
    expect(repos.runtime.listPendingCandidatePool({}).map(row => row.sourceMemoryId)).toContain(tb.l1MemoryId);
    repos.runtime.markCandidatePoolPromoted({ candidateKey: "policy", sourceMemoryIds: [tb.l1MemoryId!], policyId: "p", at });
    expect(db.db.prepare("SELECT id,status FROM l2_candidate_pool ORDER BY id").all()).toEqual([
      { id: "a", status: "pending" }, { id: "b", status: "promoted" }
    ]);
  });

  it.each(["historical", null])("preserves skipped L3 and permits unrelated imports (owner=%s)", owner => {
    const target = fixture.createTestService(), source = fixture.createTestService();
    const tr = new Repositories(target.db.db), sr = new Repositories(source.db.db);
    const memory = tr.l3WorldModels.upsertField({ userId: owner, projectId: "project-p",
      targetField: "project_contract", value: "Keep target rule", at })!;
    target.db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(owner, memory.id);
    target.db.db.prepare("UPDATE l3_world_model_scopes SET user_id=? WHERE memory_id=?").run(owner, memory.id);
    target.db.db.exec("DELETE FROM memory_l3_overrides");
    const before = target.db.db.prepare("SELECT * FROM memories WHERE id=?").get(memory.id);
    sr.runtime.importBundleTables(tr.runtime.exportBundleTables(true));
    sr.l3WorldModels.deleteScopeMemory(memory.id, "2026-10-02T00:00:00.000Z");
    sr.l3WorldModels.upsertField({ userId: null, projectId: "unrelated", targetField: "project_contract", value: "New rule", at });
    const bundle = sr.runtime.exportBundleTables(true);
    tr.runtime.importBundleTables(bundle, { conflictStrategy: "skip" });
    expect(target.db.db.prepare("SELECT * FROM memories WHERE id=?").get(memory.id)).toEqual(before);
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
    expect(tr.l3WorldModels.fields(null, "unrelated").projectContract).toBe("New rule");
    tr.runtime.importBundleTables(bundle, { conflictStrategy: "skip" });
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
  });

  it("keeps a turn's scope captured before an asynchronous start and later session move", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const a = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "a" }, meta: { conversationId: "chat" } });
    const start = service.startTurn({ sessionId: a.sessionId, turnId: "turn", query: turnInput.query });
    service.openSession({ sessionId: a.sessionId, namespace: { source: "codex", profileId: "default", projectId: "later", workspaceId: "later-w" } });
    await start;
    const completed = service.completeTurn("turn", { sessionId: a.sessionId, ...turnInput });
    const memory = repos.memories.get(completed.l1MemoryId!)!;
    expect(memory.info.native_origin_v1).toMatchObject({ projectId: null, workspaceId: null });
    expect(memory.info.project_id).toBeNull();
    expect(memory.appId).toBeUndefined();
    expect(db.db.prepare("SELECT key FROM runtime_kv WHERE key LIKE 'native_turn_origin:%'").all()).toEqual([]);
  });

  it("keeps true copies together after a session moves, preserving group deletion and promotion", () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const ns = { source: "codex", projectId: "p", workspaceId: "w", profileId: "default" };
    const memories = ["a", "b"].map(key => {
      const session = service.openSession({ namespace: { ...ns, sessionKey: key, userId: key }, meta: { conversationId: "chat" } });
      const turn = service.completeTurn("turn", { sessionId: session.sessionId, namespace: ns, ...turnInput });
      repos.runtime.upsertCandidatePoolTrace({ id: key, userId: key, sessionId: session.sessionId,
        sourceMemoryId: turn.l1MemoryId!, candidateKey: "policy", candidateValue: "evidence", score: 1, evidence: {}, createdAt: at, updatedAt: at });
      return repos.memories.get(turn.l1MemoryId!)!;
    });
    service.openSession({ sessionId: memories[0]!.sessionId, namespace: { source: "codex", profileId: "default", projectId: "different" } });
    for (const memory of memories) expect(new Set(repos.memories.nativeDuplicates(memory).ids)).toEqual(new Set(memories.map(row => row.id)));
    repos.runtime.markCandidatePoolPromoted({ candidateKey: "policy", sourceMemoryIds: [memories[1]!.id], policyId: "policy", at });
    expect(db.db.prepare("SELECT DISTINCT status FROM l2_candidate_pool").all()).toEqual([{ status: "promoted" }]);
    repos.memories.softDelete(memories[0]!.id);
    expect(repos.memories.nativeDuplicates(memories[1]!).deleted).toBe(true);
  });

  it("rejects a reused turn with an explicitly different scope without changing its stored evidence", () => {
    const { db, service } = fixture.createTestService();
    const session = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "a" }, meta: { conversationId: "chat" } });
    const turn = service.completeTurn("turn", { sessionId: session.sessionId, ...turnInput });
    const before = db.db.prepare("SELECT * FROM raw_turns WHERE id=?").get(turn.rawTurnId);
    const namespace = { source: "codex", profileId: "default", projectId: "later" };
    service.openSession({ sessionId: session.sessionId, namespace });
    expect(() => service.completeTurn("turn", { sessionId: session.sessionId, namespace, ...turnInput })).toThrow("turn origin conflicts");
    expect(db.db.prepare("SELECT * FROM raw_turns WHERE id=?").get(turn.rawTurnId)).toEqual(before);
  });

  it("retains the session tenant when completion omits its namespace", () => {
    const { db, service } = fixture.createTestService();
    const session = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "a", tenantId: "tenant-a" }, meta: { conversationId: "chat" } });
    const turn = service.completeTurn("turn", { sessionId: session.sessionId, ...turnInput });
    expect(new Repositories(db.db).memories.get(turn.l1MemoryId!)!.info.native_origin_v1).toMatchObject({ tenantId: "tenant-a" });
  });

  it.each(["absent", "unverified", "verified"])("keeps host keys separate from native conversations during %s Session imports", mode => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const namespace = { source: "codex", profileId: "default", sessionKey: "codex-memory-unverified-host" };
    const session = mode === "absent" ? undefined : service.openSession({ namespace,
      ...(mode === "verified" ? { meta: { conversationId: "native-conversation" } } : {}) });
    const result = service.addMemory({ namespace, sessionId: session?.sessionId, adapterId: "agent-source:codex", requestId: "scan",
      layer: "L1", source: "codex", tags: ["agent-source", "codex"], turnId: "native-turn",
      content: `## user\n\n${turnInput.query}\n\n## assistant\n\n${turnInput.answer}` });
    const memory = repos.memories.get(result.id)!;
    expect(memory.conversationId).toBe(mode === "verified" ? "native-conversation" : undefined);
    expect(memory.info.native_origin_v1).toMatchObject({
      conversationId: mode === "verified" ? "native-conversation" : null, hostSessionKey: namespace.sessionKey
    });
  });

  it("retains a verified source conversation when consuming a pending turn origin", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const namespace = { source: "codex", profileId: "default" };
    const session = service.openSession({ namespace: { ...namespace, sessionKey: "codex-memory-native-conversation" } });
    await service.startTurn({ sessionId: session.sessionId, turnId: "native-turn", namespace, query: turnInput.query });
    expect(repos.runtime.getRawTurnBySessionTurn(session.sessionId, "native-turn")).toBeUndefined();
    const result = service.completeSourceTurn({ sessionId: session.sessionId, namespace, source: "codex", channel: "hook",
      sourceTurn: { source: "codex", profileId: "default", conversationId: "native-conversation", turnId: "native-turn",
        startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1, completionEvidence: "task_complete:10" },
      ...turnInput });
    expect(result.status).toBe("stored");
    if (result.status !== "stored" || !result.result) throw new Error("source capture was not stored");
    const memory = repos.memories.get(result.result.l1MemoryId!)!;
    const raw = repos.runtime.getRawTurn(result.result.rawTurnId!)!;
    expect(memory.conversationId).toBe("native-conversation");
    expect(raw.messagePayload?.native_origin_v1).toMatchObject({ conversationId: "native-conversation", projectId: null });
    expect(memory.info.native_origin_v1).toMatchObject({ conversationId: "native-conversation", projectId: null });
  });

  it("keeps claims on the captured source through delayed completion and replay", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const common = { profileId: "default", projectId: "project-p", workspaceId: "workspace-w" };
    const session = service.openSession({ namespace: { ...common, source: "codex", sessionKey: "host-codex" }, meta: { conversationId: "shared-chat" } });
    const start = service.startTurn({ sessionId: session.sessionId, turnId: "shared-turn", query: turnInput.query });
    service.openSession({ sessionId: session.sessionId, namespace: { ...common, source: "claude" } });
    await start;
    const completed = service.completeTurn("shared-turn", { sessionId: session.sessionId, ...turnInput });
    const memory = repos.memories.get(completed.l1MemoryId!)!;
    expect(memory.agentId).toBe("codex");
    expect(db.db.prepare("SELECT source FROM memory_capture_claims WHERE primary_memory_id=?").get(memory.id)).toEqual({ source: "codex" });
    expect(service.completeTurn("shared-turn", { sessionId: session.sessionId, ...turnInput }).l1MemoryId).toBe(memory.id);
    const scan = service.addMemory({ namespace: { ...common, source: "claude", sessionKey: "shared-chat" },
      adapterId: "agent-source:claude", requestId: "independent-scan", layer: "L1", source: "claude", tags: ["agent-source", "claude"],
      turnId: "shared-turn", content: `## user\n\n${turnInput.query}\n\n## assistant\n\n${turnInput.answer}` });
    expect(scan.id).not.toBe(memory.id);
    expect(repos.memories.get(scan.id)!.agentId).toBe("claude");
  });

  it.each(["original", "moved"])("checks completed historical turns against %s immutable scope", scope => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const common = { source: "codex", profileId: "default" };
    const original = { ...common, projectId: "project-a", workspaceId: "workspace-a" };
    const moved = { ...common, projectId: "project-b", workspaceId: "workspace-b" };
    const session = service.openSession({ namespace: { ...original, sessionKey: "host-a" }, meta: { conversationId: "shared-chat" } });
    const first = service.completeTurn("shared-turn", { sessionId: session.sessionId, ...turnInput });
    service.openSession({ sessionId: session.sessionId, namespace: moved });
    repos.runtime.closeSession(session.sessionId, "2099-01-01T00:00:00.000Z");
    const scan = service.completeSourceTurn({ namespace: scope === "original" ? original : moved, source: "codex", channel: "agent_source_scan",
      captureLegacyHistory: true, sourceTurn: { source: "codex", profileId: "default", conversationId: "shared-chat", turnId: "shared-turn",
        startedAt: "2000-01-01T10:00:00.000Z", completedAt: "2000-01-01T10:01:00.000Z", completionEvidence: "task_complete:10" }, ...turnInput });
    expect(scan.status).toBe(scope === "original" ? "pending" : "stored");
    expect(repos.memories.get(first.l1MemoryId!)!.info.project_id).toBe("project-a");
    if (scope === "moved") expect(scan.result?.l1MemoryId).not.toBe(first.l1MemoryId);
  });

  it("does not rebuild an immutable completed turn when another capture already exists", () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const namespace = { source: "codex", profileId: "default", projectId: "project-a", workspaceId: "workspace-a" };
    const old = service.openSession({ namespace: { ...namespace, sessionKey: "host-old" }, meta: { conversationId: "shared-chat" } });
    service.completeTurn("shared-turn", { sessionId: old.sessionId, ...turnInput });
    service.openSession({ sessionId: old.sessionId, namespace: { ...namespace, projectId: "project-b", workspaceId: "workspace-b" } });
    repos.runtime.closeSession(old.sessionId, "2099-01-01T00:00:00.000Z");
    const scan = (turnId: string, minute: string) => service.completeSourceTurn({ namespace, source: "codex", channel: "agent_source_scan",
      captureLegacyHistory: true, sourceTurn: { source: "codex", profileId: "default", conversationId: "shared-chat", turnId,
        startedAt: `2000-01-01T10:${minute}:00.000Z`, completedAt: `2000-01-01T10:${minute}:30.000Z`, completionEvidence: "task_complete:10" }, ...turnInput });
    expect(scan("earlier-turn", "00").status).toBe("stored");
    const before = db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns WHERE turn_id='shared-turn'").get();
    expect(scan("shared-turn", "02")).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns WHERE turn_id='shared-turn'").get()).toEqual(before);
  });

  it("uses the retained Session scope when deciding whether imported L3 evidence can resume", () => {
    const target = fixture.createTestService(), source = fixture.createTestService();
    const tr = new Repositories(target.db.db), sr = new Repositories(source.db.db);
    const opened = target.service.openSession({ namespace: { source: "codex", profileId: "default", projectId: "project-p", sessionKey: "host" } });
    target.db.db.prepare("UPDATE sessions SET meta_json=? WHERE id=?").run(JSON.stringify({ l3_world_model_protocol_version: 2 }), opened.sessionId);
    tr.l3WorldModels.upsertField({ userId: null, projectId: "project-p", targetField: "project_contract", value: "Keep target rule", at });
    sr.runtime.importBundleTables(tr.runtime.exportBundleTables(true));
    source.db.db.prepare("UPDATE sessions SET project_id='project-q' WHERE id=?").run(opened.sessionId);
    const captured = source.service.completeTurn("other-project-turn", { sessionId: opened.sessionId, ...turnInput });
    const incoming = sr.runtime.exportBundleTables(true);
    tr.runtime.importBundleTables(incoming, { conflictStrategy: "skip" });
    expect(tr.runtime.getSession(opened.sessionId)!.projectId).toBe("project-p");
    expect(tr.memories.get(captured.l1MemoryId!)!.info.project_id).toBe("project-q");
    expect(tr.l3WorldModels.inputTraceByL1MemoryId(opened.sessionId, captured.l1MemoryId!)).toBeUndefined();
    tr.l3WorldModels.freezeBatches({ sessionId: opened.sessionId, trigger: "session_close" });
    expect(target.db.db.prepare("SELECT project_id FROM l3_world_model_evidence_batches").all()).toEqual([]);
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
  });

  it.each(["batch", "scope"])("does not import jobs authorized by a skipped %s identity", dependency => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const session = service.openSession({ namespace: { source: "codex", profileId: "default", projectId: "project-p", sessionKey: "host" } });
    db.db.prepare("UPDATE sessions SET meta_json=? WHERE id=?").run(JSON.stringify({ l3_world_model_protocol_version: 2 }), session.sessionId);
    repos.l3WorldModels.upsertField({ userId: null, projectId: "project-p", targetField: "project_contract", value: "Keep target rule", at });
    service.completeTurn("target-turn", { sessionId: session.sessionId, ...turnInput });
    repos.l3WorldModels.freezeBatches({ sessionId: session.sessionId, trigger: "session_close" });
    const before = repos.runtime.exportBundleTables(true);
    const batch = before.l3_world_model_evidence_batches!.find(row => row.project_id === "project-p")!;
    expect(batch).toBeDefined();
    const scope = before.l3_world_model_scopes!.find(row => row.scope_key === batch.scope_key)!;
    const incoming = {
      l3_world_model_evidence_batches: dependency === "batch" ? [{ ...batch, project_id: "project-q" }] : [],
      l3_world_model_scopes: dependency === "scope" ? [{ ...scope, project_id: "project-q", memory_id: null }] : [],
      evolution_jobs: [{ id: "injected-job", job_type: "l3_world_model_update", status: "queued", attempts: 0,
        scope_key: dependency === "scope" ? `${String(scope.scope_key)}:project_contract` : null,
        payload_json: JSON.stringify(dependency === "batch" ? { batchId: batch.id } : {}), created_at: at, updated_at: at }]
    };
    repos.runtime.importBundleTables(incoming, { conflictStrategy: "skip" });
    expect(db.db.prepare("SELECT id FROM evolution_jobs WHERE id='injected-job'").get()).toBeUndefined();
    expect(repos.runtime.exportBundleTables(true).l3_world_model_evidence_batches).toEqual(before.l3_world_model_evidence_batches);
    expect(repos.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
  });

  it("uses the native-turn index to bound legacy provenance lookups", () => {
    const { db } = fixture.createTestService();
    const plan = db.db.prepare("EXPLAIN QUERY PLAN SELECT source FROM source_turn_captures WHERE turn_id=?").all("native-turn") as { detail: string }[];
    expect(plan.some(row => row.detail.includes("idx_source_turn_captures_turn"))).toBe(true);
  });

  it.each([null, "tenant-a"])("preserves tenant provenance through session reuse (tenant=%s)", tenant => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const memoryIds = [tenant, "tenant-b"].map((tenantId, i) => {
      const namespace = { source: "codex", profileId: "default", sessionKey: `host-${i}`, tenantId: tenantId ?? undefined, projectId: "p", workspaceId: "w" };
      const session = service.openSession({ namespace, meta: { conversationId: "chat" } });
      return service.completeTurn("turn", { sessionId: session.sessionId, namespace, ...turnInput }).l1MemoryId!;
    });
    repos.memories.softDelete(memoryIds[0]!);
    expect(repos.memories.nativeDuplicates(repos.memories.get(memoryIds[1]!)!)).toEqual({ ids: [memoryIds[1]], deleted: false });
  });

  it("keeps legacy records with absent or contradictory capture evidence separate", () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const ids = ["a", "b"].map(key => {
      const session = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: key }, meta: { conversationId: "chat" } });
      return service.completeTurn("turn", { sessionId: session.sessionId, ...turnInput }).l1MemoryId!;
    });
    db.db.exec("UPDATE memories SET info_json=json_remove(info_json,'$.native_origin_v1'),properties_json=json_remove(properties_json,'$.info.native_origin_v1'); UPDATE raw_turns SET message_payload_json=json_remove(message_payload_json,'$.native_origin_v1')");
    repos.memories.softDelete(ids[0]!);
    expect(repos.memories.nativeDuplicates(repos.memories.get(ids[1]!)!)).toEqual({ ids: [ids[1]], deleted: false });
  });

  it.each([true, false])("keeps origins across restart and bundle restore (raw=%s)", async includeRawText => {
    const { db, service, root } = fixture.createTestService();
    const session = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "a" }, meta: { conversationId: "chat" } });
    const turn = service.completeTurn("turn", { sessionId: session.sessionId, ...turnInput });
    service.openSession({ sessionId: session.sessionId, namespace: { source: "codex", profileId: "default", projectId: "later" } });
    const bundle = service.exportBundle({ includeRawText });
    await service.stop(); db.close();
    const reopened = new MemoryDb({ path: join(root, "memory.sqlite") });
    try {
      expect(new Repositories(reopened.db).memories.get(turn.l1MemoryId!)!.info.native_origin_v1).toMatchObject({ projectId: null });
      const restored = fixture.createTestService();
      restored.service.importBundle({ bundle });
      expect(new Repositories(restored.db.db).memories.get(turn.l1MemoryId!)!.info.native_origin_v1).toMatchObject({ projectId: null });
    } finally { reopened.close(); }
  });

  it.each(["skip", "replace", "error"] as const)("applies the requested conflict strategy: %s", conflictStrategy => {
    const { tr, bundle } = deletedBackup();
    if (conflictStrategy === "error") expect(() => tr.runtime.importBundleTables(bundle, { conflictStrategy })).toThrow("import conflict");
    else tr.runtime.importBundleTables(bundle, { conflictStrategy });
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe(conflictStrategy === "replace" ? null : "Keep target rule");
  });

  it.each(["partial", "different-id", "same-batch-alias", "alias-chain", "changed-input-project"])("protects target scope for %s deletion backups", mode => {
    const { tr, bundle, memory } = deletedBackup();
    if (mode === "partial") delete bundle.memories;
    if (mode === "different-id") for (const row of bundle.memories!) row.id = "different-deleted-id";
    if (mode === "same-batch-alias" || mode === "alias-chain") {
      bundle.memory_project_aliases = [{ legacy_id: "old-p", project_id: "project-p", workspace_uri: "", created_at: at }];
      if (mode === "alias-chain") {
        bundle.memory_project_aliases[0]!.project_id = "middle-p";
        bundle.memory_project_aliases.push({ legacy_id: "middle-p", project_id: "project-p", workspace_uri: "", created_at: at });
      }
      for (const row of bundle.memory_l3_overrides!) row.project_key = "old-p";
    }
    if (mode === "changed-input-project") {
      const row = bundle.memories!.find(row => row.id === memory.id)!;
      row.info_json = JSON.stringify({ project_id: "misleading-input-project" });
    }
    tr.runtime.importBundleTables(bundle, { conflictStrategy: "skip" });
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
    expect(tr.db.prepare("SELECT * FROM memory_l3_overrides").all()).toEqual([]);
  });

  it("rolls back new aliases and data together when a late insert fails", () => {
    const { target, tr } = deletedBackup();
    const bundle = { memory_project_aliases: [{ legacy_id: "new-alias", project_id: "new-project", workspace_uri: "", created_at: at }],
      audit_logs: [{ id: "bad-audit" }] };
    expect(() => tr.runtime.importBundleTables(bundle)).toThrow();
    expect(target.db.db.prepare("SELECT * FROM memory_project_aliases WHERE legacy_id='new-alias'").all()).toEqual([]);
    expect(canonicalProjectId(target.db.db, "new-alias")).toBe("new-alias");
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
  });

  it("rejects contradictory duplicate rows before writing any part of a bundle", () => {
    const { tr, bundle, memory } = deletedBackup();
    bundle.memories!.push({ ...bundle.memories![0], id: memory.id, memory_value: "contradictory" });
    expect(() => tr.runtime.importBundleTables(bundle)).toThrow("contradictory duplicate identity");
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
  });

  it("rolls back the service-level import when vector persistence fails after table writes", () => {
    const { target, source, sr, tr } = deletedBackup();
    sr.l3WorldModels.upsertField({ userId: null, projectId: "new-project", targetField: "project_contract", value: "New rule", at });
    const bundle = source.service.exportBundle({ includeRawText: true });
    bundle.tables.memory_project_aliases!.push({ legacy_id: "new-alias", project_id: "new-project", workspace_uri: "", created_at: at });
    vi.spyOn(SqliteVecStore.prototype, "importRows").mockImplementationOnce(() => { throw new Error("vector write failed"); });
    expect(() => target.service.importBundle({ bundle })).toThrow("vector write failed");
    expect(tr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
    expect(tr.l3WorldModels.fields(null, "new-project").projectContract).toBeNull();
    expect(canonicalProjectId(target.db.db, "new-alias")).toBe("new-alias");
  });

  it("keeps skipped L3 vectors unchanged after imported retry work is drained", async () => {
    const texts: string[] = [];
    const embedder = {
      config: { ...createCapturingEmbedder([]).config, model: "review-fixture" },
      embed: async (input: string[]) => { texts.push(...input); return input.map(() => [0, 1, 0]); },
      embedOne: async (input: string) => { texts.push(input); return [0, 1, 0]; },
      isConfigured: () => true,
      isRemote: () => false,
      status: () => ({ provider: "local", model: "review-fixture", configured: true, remote: false })
    };
    const target = fixture.createTestService({ embedder }), source = fixture.createTestService();
    const tr = new Repositories(target.db.db), sr = new Repositories(source.db.db);
    const memory = tr.l3WorldModels.upsertField({ userId: null, projectId: "project-p", targetField: "project_contract", value: "Keep target rule", at })!;
    tr.vectors.upsert(memory.id, { vectorField: "vec", vector: [1, 0, 0], embeddingModel: "review-fixture", embeddingProvider: "local" }, at);
    const before = tr.vectors.exportRows();
    sr.runtime.importBundleTables(tr.runtime.exportBundleTables(true));
    const retry = sr.runtime.enqueueEmbeddingRetry({ targetKind: "world_model", targetId: memory.id, vectorField: "vec",
      sourceText: embeddingTextForMemory(sr.memories.get(memory.id)!), embedRole: "query", now: 1 });
    const result = target.service.importBundle({ bundle: source.service.exportBundle({ includeRawText: true }), conflictStrategy: "skip" });
    await target.service.runWorkerOnce(10);
    expect(tr.runtime.getEmbeddingRetry(retry.id)).toBeUndefined();
    expect(result.skipped.embedding_retry_queue).toBe(1);
    expect(tr.vectors.exportRows()).toEqual(before);
    expect(texts).toEqual([]);
  });

  it("preserves skip results across reopen and a second export/import while allowing empty-store deletion restore", async () => {
    const { target, tr, bundle } = deletedBackup();
    tr.runtime.importBundleTables(bundle);
    await target.service.stop(); target.db.close();
    const reopened = new MemoryDb({ path: join(target.root, "memory.sqlite") });
    try {
      const rr = new Repositories(reopened.db);
      expect(rr.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
      const restored = fixture.createTestService(), restoredRepos = new Repositories(restored.db.db);
      restoredRepos.runtime.importBundleTables(rr.runtime.exportBundleTables(true));
      expect(restoredRepos.l3WorldModels.fields(null, "project-p").projectContract).toBe("Keep target rule");
      const empty = fixture.createTestService(), emptyRepos = new Repositories(empty.db.db);
      emptyRepos.runtime.importBundleTables(bundle);
      expect(emptyRepos.l3WorldModels.fields(null, "project-p").projectContract).toBeNull();
      expect(empty.db.db.prepare("SELECT COUNT(*) AS n FROM memory_l3_overrides WHERE deleted=1").get()).toEqual({ n: 4 });
    } finally { reopened.close(); }
  });
});
