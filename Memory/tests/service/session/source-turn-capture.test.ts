import { Repositories, RuntimeRepository } from "../../../src/storage/repositories.js";
import { memoryCaptureQaHash } from "../../../src/utils/memory-capture-claim.js";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSourceTurnRequest } from "@memmy/agent-source-core";
import { MemoryDb } from "../../../src/index.js";
import type { SourceTurnCompleteRequest } from "../../../src/types.js";
import { createMemoryServiceFixture, createBatchReflectionLlm, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService, createTestMemoryService } = createMemoryServiceFixture();
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanup(); });

function request(overrides: Partial<SourceTurnCompleteRequest> = {}): SourceTurnCompleteRequest {
  return {
    namespace: { source: "codex", profileId: "default", userId: "source-user" },
    source: "codex",
    channel: "hook",
    sourceTurn: {
      source: "codex", profileId: "default", conversationId: "native-conversation", turnId: "native-turn-1",
      startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z",
      sequence: 1, completionEvidence: "task_complete:10"
    },
    query: "Implement a transaction that preserves the native source turn identity.",
    answer: "The transaction now stores the full source turn and schedules capture.",
    toolCalls: [{ id: "call-a", name: "read_file", input: { path: "schema.ts" } }],
    toolResults: [{ id: "call-a", output: "CREATE TABLE source_turn_captures" }],
    ...overrides
  };
}

function counts(db: MemoryDb) {
  return Object.fromEntries(["sessions", "episodes", "raw_turns", "memories", "source_turn_captures", "evolution_jobs"].map((table) => [table,
    (db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
}

describe("native source turn submission", () => {
  it("accepts the shared parser builder without inventing a second namespace", () => {
    const { service } = createTestService();
    const input = request();
    const built = buildSourceTurnRequest({
      source: "codex", conversationId: input.sourceTurn.conversationId, turnId: input.sourceTurn.turnId,
      startedAt: input.sourceTurn.startedAt, completedAt: input.sourceTurn.completedAt,
      sequence: 1, completionEvidence: input.sourceTurn.completionEvidence,
      query: input.query, answer: input.answer, status: "succeeded", toolCalls: [], toolResults: []
    }, "agent_source_scan");
    expect(service.completeSourceTurn(built).status).toBe("stored");
  });

  it.each(["hook", "agent_source_scan"] as const)("commits one lifecycle when %s arrives first and reuses it after restart", (channel) => {
    const { db, service, root } = createTestService();
    const first = service.completeSourceTurn(request({ channel }));
    expect(first.status).toBe("stored");
    expect(first.result?.l1MemoryIds).toHaveLength(1);
    const result = first.result!;
    const raw = new Repositories(db.db).runtime.getRawTurn(result.rawTurnId)!;
    const memory = new Repositories(db.db).memories.get(result.l1MemoryId)!;
    expect(raw).toMatchObject({ sessionId: result.sessionId, episodeId: result.episodeId, turnId: "native-turn-1", createdAt: request().sourceTurn.startedAt });
    expect(memory).toMatchObject({ sessionId: result.sessionId });
    expect(new Repositories(db.db).runtime.getEpisode(result.episodeId)?.l1MemoryIds).toContain(result.l1MemoryId);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM recall_events").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_capture_claims").get()).toEqual({ count: 0 });
    const before = counts(db);
    db.close();
    const reopened = new MemoryDb({ path: join(root, "memory.sqlite") });
    try {
      const restarted = createTestMemoryService({ db: reopened });
      const second = restarted.completeSourceTurn(request({ channel: channel === "hook" ? "agent_source_scan" : "hook", sessionId: "late-hook-session" }));
      expect(second).toMatchObject({ status: "existing", result: { rawTurnId: result.rawTurnId, l1MemoryId: result.l1MemoryId, duplicate: true, jobs: [] } });
      expect(counts(reopened)).toEqual(before);
    } finally { reopened.close(); }
  });

  it("reuses a scoped Hook Session without a simulated recall and ignores old QA claims", () => {
    const { db, service } = createTestService();
    const input = request();
    const opened = service.openSession({ namespace: { ...input.namespace!, sessionKey: input.sourceTurn.conversationId }, meta: { conversationId: input.sourceTurn.conversationId } });
    new Repositories(db.db).captureClaims.claim({ userId: "source-user", source: "codex", qaHash: memoryCaptureQaHash(input.query, input.answer), primaryMemoryId: "deleted-old-memory", capturedBy: "agent_source_scan", createdAt: "2026-01-01" });
    const stored = service.completeSourceTurn(request({ channel: "agent_source_scan" }));
    expect(stored.result?.sessionId).toBe(opened.sessionId);
    expect(counts(db).sessions).toBe(1);
    expect(stored.result?.l1MemoryIds).toHaveLength(1);
  });

  it.each(["hook", "agent_source_scan"] as const)("reuses the existing prefixed Codex Hook Session when %s captures first", (channel) => {
    const { db, service } = createTestService();
    const input = request();
    const opened = service.openSession({
      namespace: { ...input.namespace!, sessionKey: `codex-memory-${input.sourceTurn.conversationId}` },
      l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "allow_legacy_rollover",
      workspaceUri: "file:///workspace/project-a", workspaceHostId: "a".repeat(64)
    });
    const runtime = new Repositories(db.db).runtime;
    const original = runtime.getSession(opened.sessionId)!;
    expect(original.conversationId).toBeUndefined();
    const first = service.completeSourceTurn(request({ channel,
      ...(channel === "hook" ? { sessionId: opened.sessionId } : {}) }));
    expect(first).toMatchObject({ status: "stored", result: { sessionId: opened.sessionId } });
    const second = service.completeSourceTurn(request({ channel: channel === "hook" ? "agent_source_scan" : "hook",
      sessionId: opened.sessionId }));
    expect(second).toMatchObject({ status: "existing", result: { sessionId: opened.sessionId, l1MemoryId: first.result!.l1MemoryId } });
    expect(counts(db).sessions).toBe(1);
    expect(runtime.getSession(opened.sessionId)).toMatchObject({
      userId: "source-user", hostSessionKey: original.hostSessionKey, conversationId: input.sourceTurn.conversationId,
      projectId: original.projectId, workspaceId: original.workspaceId, meta: original.meta
    });
    expect(runtime.getRawTurn(first.result!.rawTurnId)).toMatchObject({ userId: "source-user", conversationId: input.sourceTurn.conversationId });
    const memory = new Repositories(db.db).memories.get(first.result!.l1MemoryId)!;
    expect(memory).toMatchObject({ userId: "source-user", conversationId: input.sourceTurn.conversationId, appId: original.workspaceId });
    expect(memory.info.project_id).toBe(original.projectId);
    service.closeSession(opened.sessionId, { namespace: input.namespace });
    expect(runtime.getEpisode(first.result!.episodeId)?.status).toBe("closed");
    expect(runtime.getSession(opened.sessionId)?.status).toBe("closed");
  });

  it.each([
    { label: "another user with the same native conversation", namespace: { userId: "other-user" } },
    { label: "another project", namespace: { projectId: "project-b" } },
    { label: "another workspace", namespace: { workspaceId: "workspace-b" } },
    { label: "an unproven tenant", namespace: { tenantId: "tenant-b" } },
    { label: "another profile", namespace: { profileId: "profile-b" } }
  ])("does not adopt a prefixed Hook Session into $label", ({ namespace }) => {
    const { db, service } = createTestService();
    const input = request();
    const opened = service.openSession({ namespace: { ...input.namespace!, sessionKey: `codex-memory-${input.sourceTurn.conversationId}` } });
    const before = counts(db);
    const requestedNamespace = { ...input.namespace!, ...namespace };
    expect(() => service.completeSourceTurn(request({ sessionId: opened.sessionId,
      namespace: requestedNamespace,
      sourceTurn: { ...input.sourceTurn, profileId: requestedNamespace.profileId ?? input.sourceTurn.profileId }
    }))).toThrow("source_session_scope_conflict");
    expect(counts(db)).toEqual(before);
    expect(new Repositories(db.db).runtime.getSession(opened.sessionId)?.conversationId).toBeUndefined();
  });

  it("refuses a conflicting saved conversation even when the prefixed host key matches", () => {
    const { db, service } = createTestService();
    const input = request();
    const opened = service.openSession({ namespace: { ...input.namespace!, sessionKey: `codex-memory-${input.sourceTurn.conversationId}` },
      meta: { conversationId: "another-native-conversation" } });
    const before = counts(db);
    expect(() => service.completeSourceTurn(request({ sessionId: opened.sessionId }))).toThrow("source_session_scope_conflict");
    expect(counts(db)).toEqual(before);
    expect(new Repositories(db.db).runtime.getSession(opened.sessionId)?.conversationId).toBe("another-native-conversation");
  });

  it("keeps an ambiguous native and prefixed Session unresolved", () => {
    const { db, service } = createTestService();
    const input = request();
    for (const sessionKey of [input.sourceTurn.conversationId, `codex-memory-${input.sourceTurn.conversationId}`]) {
      service.openSession({ namespace: { ...input.namespace!, sessionKey } });
    }
    const before = counts(db);
    expect(service.completeSourceTurn(request({ channel: "agent_source_scan" }))).toMatchObject({ status: "pending", reason: "source_session_ambiguous" });
    expect(counts(db)).toEqual(before);
  });

  it("rolls back a newly bound Hook conversation when capture persistence fails", () => {
    const { db, service } = createTestService();
    const input = request();
    const opened = service.openSession({ namespace: { ...input.namespace!, sessionKey: `codex-memory-${input.sourceTurn.conversationId}` } });
    const before = counts(db);
    vi.spyOn(RuntimeRepository.prototype, "insertSourceTurnCapture").mockImplementation(() => { throw new Error("simulated persistence failure"); });
    expect(() => service.completeSourceTurn(request({ sessionId: opened.sessionId }))).toThrow("simulated persistence failure");
    expect(counts(db)).toEqual(before);
    expect(new Repositories(db.db).runtime.getSession(opened.sessionId)?.conversationId).toBeUndefined();
  });

  it("binds only the current observed RawTurn when completing a prefixed Hook Session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2099-01-01T09:58:00.000Z");
    const { db, service } = createTestService();
    const input = request();
    const opened = service.openSession({ namespace: { ...input.namespace!, sessionKey: `codex-memory-${input.sourceTurn.conversationId}` } });
    const runtime = new Repositories(db.db).runtime;
    const historical = service.completeTurn("historical-turn", { sessionId: opened.sessionId, query: input.query, answer: input.answer });
    const historicalRaw = runtime.getRawTurn(historical.rawTurnId)!;
    expect(historicalRaw.conversationId).toBeUndefined();
    vi.setSystemTime(input.sourceTurn.startedAt);
    await service.startTurn({ namespace: input.namespace, sessionId: opened.sessionId, turnId: input.sourceTurn.turnId, query: input.query });
    expect(runtime.getRawTurnBySessionTurn(opened.sessionId, input.sourceTurn.turnId)).toBeUndefined();
    const observed = await service.observeTool({ namespace: input.namespace, sessionId: opened.sessionId,
      turnId: input.sourceTurn.turnId, toolCallId: "call-a", toolName: "read_file", args: { path: "schema.ts" } });
    expect(runtime.getRawTurn(observed.rawTurnId!)?.conversationId).toBeUndefined();
    vi.setSystemTime(input.sourceTurn.completedAt);
    const completed = service.completeSourceTurn(request({ sessionId: opened.sessionId }));
    expect(completed).toMatchObject({ status: "stored", result: { sessionId: opened.sessionId, rawTurnId: observed.rawTurnId } });
    expect(runtime.getRawTurn(observed.rawTurnId!)).toMatchObject({
      conversationId: input.sourceTurn.conversationId, userText: input.query, assistantText: input.answer, status: "succeeded"
    });
    expect(runtime.getRawTurn(historical.rawTurnId)).toEqual(historicalRaw);
    expect(new Repositories(db.db).memories.get(completed.result!.l1MemoryId)?.conversationId).toBe(input.sourceTurn.conversationId);
  });

  it.each(["user", "conversation"] as const)("refuses an observed RawTurn with a conflicting %s", async (conflict) => {
    const { db, service } = createTestService();
    const input = request();
    const opened = service.openSession({ namespace: { ...input.namespace!, sessionKey: `codex-memory-${input.sourceTurn.conversationId}` } });
    const observed = await service.observeTool({ sessionId: opened.sessionId, turnId: input.sourceTurn.turnId,
      toolCallId: "call-a", toolName: "read_file", args: { path: "schema.ts" } });
    if (conflict === "user") db.db.prepare("UPDATE raw_turns SET user_id = 'other-user' WHERE id = ?").run(observed.rawTurnId);
    else db.db.prepare("UPDATE raw_turns SET conversation_id = 'other-conversation' WHERE id = ?").run(observed.rawTurnId);
    const runtime = new Repositories(db.db).runtime;
    const original = runtime.getRawTurn(observed.rawTurnId!)!;
    const before = counts(db);
    expect(() => service.completeSourceTurn(request({ sessionId: opened.sessionId }))).toThrow("source_raw_turn_scope_conflict");
    expect(counts(db)).toEqual(before);
    expect(runtime.getRawTurn(observed.rawTurnId!)).toEqual(original);
    expect(runtime.getSession(opened.sessionId)?.conversationId).toBeUndefined();
  });

  it("does not apply the Codex host-key alias to another source", () => {
    const { db, service } = createTestService();
    const input = request();
    const namespace = { ...input.namespace!, source: "cursor" };
    const opened = service.openSession({ namespace: { ...namespace, sessionKey: `codex-memory-${input.sourceTurn.conversationId}` } });
    expect(new Repositories(db.db).runtime.sourceConversationSessions({ userId: "source-user", source: "cursor", profileId: "default",
      conversationId: input.sourceTurn.conversationId })).toEqual([]);
    const before = counts(db);
    expect(() => service.completeSourceTurn(request({ namespace, source: "cursor", sessionId: opened.sessionId,
      sourceTurn: { ...input.sourceTurn, source: "cursor" } }))).toThrow("source_session_scope_conflict");
    expect(counts(db)).toEqual(before);
  });

  it("does not merge equal QA belonging to different turns or scopes", () => {
    const { service } = createTestService();
    const first = service.completeSourceTurn(request());
    const second = service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, turnId: "native-turn-2", sequence: 2, startedAt: "2099-01-01T10:02:00.000Z", completedAt: "2099-01-01T10:03:00.000Z" } }));
    const otherUser = service.completeSourceTurn(request({ namespace: { ...request().namespace!, userId: "other-user" } }));
    expect(new Set([first.result?.l1MemoryId, second.result?.l1MemoryId, otherUser.result?.l1MemoryId]).size).toBe(3);
  });

  it("reports conflicting content and keeps deleted capture identities", () => {
    const { db, service } = createTestService();
    const first = service.completeSourceTurn(request());
    const before = counts(db);
    expect(service.completeSourceTurn(request({ answer: "A conflicting result." }))).toMatchObject({ status: "conflict", reason: "source_turn_content_conflict" });
    db.db.prepare("UPDATE memories SET status = 'deleted', deleted_at = ? WHERE id = ?").run("2099-01-02", first.result!.l1MemoryId);
    expect(service.completeSourceTurn(request())).toMatchObject({ status: "rejected", reason: "capture_deleted" });
    expect(counts(db)).toEqual(before);
  });

  it("rolls back every lifecycle write when source registration fails", () => {
    const { db, service } = createTestService();
    const before = counts(db);
    vi.spyOn(RuntimeRepository.prototype, "insertSourceTurnCapture").mockImplementation(() => { throw new Error("simulated persistence failure"); });
    expect(() => service.completeSourceTurn(request())).toThrow("simulated persistence failure");
    expect(counts(db)).toEqual(before);
  });

  it("retains unresolved, out of order, and closed Episode turns for retry", () => {
    const { db, service } = createTestService();
    expect(service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, turnId: "" } }))).toMatchObject({ status: "pending", reason: "identity_unresolved" });
    const first = service.completeSourceTurn(request());
    const before = counts(db);
    expect(service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, turnId: "late-turn", sequence: 0, startedAt: "2099-01-01T09:00:00.000Z", completedAt: "2099-01-01T09:01:00.000Z" } }))).toMatchObject({ status: "pending", reason: "source_turn_out_of_order" });
    new Repositories(db.db).runtime.closeEpisode(first.result!.episodeId, { closeReason: "idle" }, "2099-01-01T10:01:30.000Z");
    expect(service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, turnId: "after-close", sequence: 2, startedAt: "2099-01-01T10:02:00.000Z", completedAt: "2099-01-01T10:03:00.000Z" } }))).toMatchObject({ status: "pending", reason: "source_episode_closed" });
    expect(counts(db)).toEqual(before);
  });

  it("rejects pre-activation turns while allowing a turn that completes after activation", () => {
    const { service } = createTestService();
    expect(service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, startedAt: "2000-01-01T10:00:00.000Z", completedAt: "2000-01-01T10:01:00.000Z" } }))).toMatchObject({ status: "rejected", reason: "legacy_before_activation" });
    expect(service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, startedAt: "2000-01-01T10:00:00.000Z" } })).status).toBe("stored");
  });

  it("fills a missing turn bounded by captured turns in the same open Episode", () => {
    const { db, service } = createTestService();
    const first = service.completeSourceTurn(request());
    const third = service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, turnId: "turn-3", sequence: 3,
      startedAt: "2099-01-01T10:04:00.000Z", completedAt: "2099-01-01T10:05:00.000Z" } }));
    expect(third.result?.episodeId).toBe(first.result?.episodeId);
    const second = service.completeSourceTurn(request({ channel: "agent_source_scan", sourceTurn: { ...request().sourceTurn, turnId: "turn-2", sequence: 2,
      startedAt: "2099-01-01T10:02:00.000Z", completedAt: "2099-01-01T10:03:00.000Z" } }));
    expect(second).toMatchObject({ status: "stored", result: { sessionId: first.result!.sessionId, episodeId: first.result!.episodeId } });
    const episode = new Repositories(db.db).runtime.getEpisode(first.result!.episodeId)!;
    expect(episode.l1MemoryIds).toEqual([first.result!.l1MemoryId, second.result!.l1MemoryId, third.result!.l1MemoryId]);
    expect(episode.rawTurnIds).toEqual([first.result!.rawTurnId, second.result!.rawTurnId, third.result!.rawTurnId]);
    expect(episode.updatedAt).toBe("2099-01-01T10:05:00.000Z");
    expect(new Repositories(db.db).runtime.getSession(first.result!.sessionId)?.lastSeenAt).toBe("2099-01-01T10:05:00.000Z");
  });

  it("does not treat a sequence reset in a new source artifact as old content", () => {
    const { service } = createTestService();
    service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, sequence: 100 } }));
    const next = service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, turnId: "new-artifact-turn", sequence: 1,
      startedAt: "2099-01-01T10:02:00.000Z", completedAt: "2099-01-01T10:03:00.000Z" } }));
    expect(next.status).toBe("stored");
  });

  it("uses a new scoped Hook Session after the previous source Session closes", () => {
    const { db, service } = createTestService();
    const first = service.completeSourceTurn(request());
    new Repositories(db.db).runtime.closeSession(first.result!.sessionId, "2099-01-01T10:01:30.000Z");
    const opened = service.openSession({ namespace: { ...request().namespace!, sessionKey: request().sourceTurn.conversationId } });
    const next = service.completeSourceTurn(request({ sessionId: opened.sessionId, sourceTurn: { ...request().sourceTurn, turnId: "new-session-turn", sequence: 2,
      startedAt: "2099-01-01T10:02:00.000Z", completedAt: "2099-01-01T10:03:00.000Z" } }));
    expect(next).toMatchObject({ status: "stored", result: { sessionId: opened.sessionId } });
    expect(next.result?.sessionId).not.toBe(first.result?.sessionId);
  });

  it("does not cross project, profile, or tenant scopes", () => {
    const { service } = createTestService();
    const baseline = request();
    const results = [
      service.completeSourceTurn(baseline),
      service.completeSourceTurn(request({ namespace: { ...baseline.namespace!, projectId: "project-b" } })),
      service.completeSourceTurn(request({ namespace: { ...baseline.namespace!, profileId: "profile-b" },
        sourceTurn: { ...baseline.sourceTurn, profileId: "profile-b" } })),
      service.completeSourceTurn(request({ namespace: { ...baseline.namespace!, tenantId: "tenant-b" } }))
    ];
    expect(results.map((result) => result.status)).toEqual(["stored", "stored", "stored", "stored"]);
    expect(new Set(results.map((result) => result.result?.sessionId)).size).toBe(4);
    expect(new Set(results.map((result) => result.result?.l1MemoryId)).size).toBe(4);
  });

  it("keeps the original pending or failed capture job on retry", () => {
    const { db, service } = createTestService();
    const first = service.completeSourceTurn(request());
    const before = counts(db);
    db.db.prepare("UPDATE evolution_jobs SET status = 'failed' WHERE target_memory_id = ?")
      .run(first.result!.l1MemoryId);
    expect(service.completeSourceTurn(request())).toMatchObject({ status: "existing", result: { jobs: [] } });
    expect(counts(db)).toEqual(before);
  });

  it("returns a policy rejection without resurrecting its original L1", () => {
    const { db, service } = createTestService();
    const first = service.completeSourceTurn(request());
    const before = counts(db);
    db.db.prepare(`UPDATE memories SET status = 'deleted', deleted_at = '2099-01-01',
      properties_json = json_set(properties_json, '$.internal_info.capture_decision.status', 'rejected') WHERE id = ?`)
      .run(first.result!.l1MemoryId);
    expect(service.completeSourceTurn(request())).toMatchObject({ status: "rejected", reason: "capture_policy" });
    expect(counts(db)).toEqual(before);
  });

  it("preserves capture identities in bundles and across deleting all memory data", () => {
    const first = createTestService();
    const stored = first.service.completeSourceTurn(request());
    const activation = new Repositories(first.db.db).runtime.getKv("source_turn_capture_activated_at");
    const bundle = first.service.exportBundle({ includeRawText: true });
    expect(bundle.tables.source_turn_captures).toHaveLength(1);
    expect(JSON.stringify(bundle.tables.source_turn_captures)).not.toContain(request().query);
    const restored = createTestService();
    const imported = restored.service.importBundle({ bundle });
    expect(imported.ok).toBe(true);
    expect(imported.conflicts).toEqual([]);
    expect(new Repositories(restored.db.db).runtime.getKv("source_turn_capture_activated_at")).toEqual(activation);
    expect(restored.service.completeSourceTurn(request())).toMatchObject({ status: "existing", result: { l1MemoryId: stored.result!.l1MemoryId } });
    new Repositories(first.db.db).clearAllMemoryData();
    expect(new Repositories(first.db.db).runtime.getKv("source_turn_capture_activated_at")).toEqual(activation);
    expect(first.service.completeSourceTurn(request())).toMatchObject({ status: "rejected", reason: "capture_deleted" });
    expect(first.service.completeSourceTurn(request({ sourceTurn: { ...request().sourceTurn, turnId: "after-clear",
      startedAt: "2099-01-01T10:02:00.000Z", completedAt: "2099-01-01T10:03:00.000Z" } })).status).toBe("stored");
  });

  it("does not widen either historical capture window when merging a bundle into existing data", () => {
    const target = createTestService();
    target.service.completeSourceTurn(request());
    const runtime = new Repositories(target.db.db).runtime;
    runtime.setKv("source_turn_capture_activated_at", "2090-01-01T00:00:00.000Z");
    const mergeBoundary = (value: string) => runtime.importBundleTables({ runtime_kv: [{
      key: "source_turn_capture_activated_at", value_json: JSON.stringify(value), updated_at: "2099-01-01T00:00:00.000Z"
    }] });
    expect(mergeBoundary("2080-01-01T00:00:00.000Z").conflicts).toEqual([]);
    expect(runtime.getKv("source_turn_capture_activated_at")?.value).toBe("2090-01-01T00:00:00.000Z");
    expect(mergeBoundary("2095-01-01T00:00:00.000Z").conflicts).toEqual([]);
    expect(runtime.getKv("source_turn_capture_activated_at")?.value).toBe("2095-01-01T00:00:00.000Z");
    expect(target.service.completeSourceTurn(request())).toMatchObject({ status: "existing" });
    expect(() => mergeBoundary("invalid-date")).toThrow("invalid source turn activation boundary in bundle");
    expect(runtime.getKv("source_turn_capture_activated_at")?.value).toBe("2095-01-01T00:00:00.000Z");
  });

  it("feeds a newly scanned L1 into the existing reflection and reward jobs after closure", async () => {
    const calls: Parameters<typeof createBatchReflectionLlm>[0] = [];
    const { db, service } = createTestService({ llm: createBatchReflectionLlm(calls) });
    const captured = service.completeSourceTurn(request({ channel: "agent_source_scan" }));
    await runWorkerRounds(service, 3);
    service.closeSession(captured.result!.sessionId);
    await runWorkerRounds(service, 3);
    const jobs = db.db.prepare("SELECT job_type, status, episode_id FROM evolution_jobs WHERE episode_id = ?")
      .all(captured.result!.episodeId) as Array<{ job_type: string; status: string; episode_id: string }>;
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_type: "trace_summary", status: "succeeded" }),
      expect.objectContaining({ job_type: "reflection", status: "succeeded" }),
      expect.objectContaining({ job_type: "reward" })
    ]));
    expect(calls.some((call) => call.options.operation === "capture.reflection.batch.v13")).toBe(true);
  });

  it("keeps the ordinary completeTurn Episode creation time at completion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2099-01-01T10:00:00.000Z");
    const { db, service } = createTestService();
    const opened = service.openSession({ namespace: request().namespace });
    await service.startTurn({ sessionId: opened.sessionId, turnId: "ordinary-turn", query: request().query });
    vi.setSystemTime("2099-01-01T10:05:00.000Z");
    const completed = service.completeTurn("ordinary-turn", { sessionId: opened.sessionId, query: request().query, answer: request().answer });
    expect(new Repositories(db.db).runtime.getEpisode(completed.episodeId)?.openedAt).toBe("2099-01-01T10:05:00.000Z");
  });

  it("does not reopen a closed Episode from an earlier cached source turn proposal", async () => {
    const { db, service } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const first = service.completeSourceTurn(request());
    await service.startTurn({ namespace: request().namespace, sessionId: first.result!.sessionId, turnId: "changed-source-turn",
      query: "Continue with the same migration." });
    runtime.closeEpisode(first.result!.episodeId, { closeReason: "idle" }, "2099-01-01T10:01:30.000Z");
    const completed = service.completeSourceTurn(request({ query: "New task: implement a weather dashboard.",
      sourceTurn: { ...request().sourceTurn, turnId: "changed-source-turn", startedAt: "2099-01-01T10:02:00.000Z", completedAt: "2099-01-01T10:03:00.000Z" } }));
    expect(completed.status).toBe("stored");
    expect(completed.result?.episodeId).not.toBe(first.result?.episodeId);
    expect(runtime.getEpisode(first.result!.episodeId)?.status).toBe("closed");
    expect(runtime.getEpisode(completed.result!.episodeId)?.openedAt).toBe("2099-01-01T10:02:00.000Z");
  });

  it("rejects a supplied Session from another account or native conversation", () => {
    const { service } = createTestService();
    const foreign = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "other-user", sessionKey: "other-conversation" } });
    expect(() => service.completeSourceTurn(request({ sessionId: foreign.sessionId }))).toThrow("source_session_scope_conflict");
  });
});
