import { Repositories, RuntimeRepository } from "../../../src/storage/repositories.js";
import { memoryCaptureQaHash } from "../../../src/utils/memory-capture-claim.js";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSourceTurnRequest, legacyImportTurnId, readOpencodeSourceTurn } from "@memmy/agent-source-core";
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

  it("reuses one OpenCode capture after the live session agent changes", async () => {
    const { db, service } = createTestService();
    const messages = () => [
      { id: "u", data: { role: "user", agent: "build", time: { created: 4_070_944_800_000 } } },
      {
        id: "a",
        data: {
          role: "assistant",
          parentID: "u",
          finish: "stop",
          time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
        }
      }
    ];
    const parts = (id: string) => [{
      id: `p${id}`,
      data: { type: "text", text: id === "u" ? "Implement a transaction that preserves the native source turn identity." : "The transaction now stores the full source turn and schedules capture." }
    }];
    const hook = await readOpencodeSourceTurn({
      sessions: () => [{ id: "same-session", parentId: null, directory: null, agent: "build" }],
      messages,
      parts
    }, { conversationId: "same-session", turnId: "u" });
    const scan = await readOpencodeSourceTurn({
      sessions: () => [{ id: "same-session", parentId: null, directory: null, agent: "plan" }],
      messages,
      parts
    }, { conversationId: "same-session", turnId: "u" });
    expect(hook.turn?.profileId).toBe("build");
    expect(scan.turn?.profileId).toBe("build");
    const first = service.completeSourceTurn({
      ...buildSourceTurnRequest(hook.turn!, "hook"),
      namespace: { source: "opencode", profileId: hook.turn!.profileId!, userId: "source-user" }
    });
    const second = service.completeSourceTurn({
      ...buildSourceTurnRequest(scan.turn!, "agent_source_scan"),
      namespace: { source: "opencode", profileId: scan.turn!.profileId!, userId: "source-user" }
    });
    expect(first.status).toBe("stored");
    expect(second.status).toBe("existing");
    expect(second.result?.sessionId).toBe(first.result?.sessionId);
    expect(second.result?.l1MemoryId).toBe(first.result?.l1MemoryId);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 1 });
  });

  it("reuses one OpenCode capture when only the assistant carries the agent", async () => {
    const { db, service } = createTestService();
    const messages = () => [
      { id: "u", data: { role: "user", time: { created: 4_070_944_800_000 } } },
      {
        id: "a",
        data: {
          role: "assistant",
          agent: "build",
          parentID: "u",
          finish: "stop",
          time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
        }
      }
    ];
    const parts = (id: string) => [{
      id: `p${id}`,
      data: { type: "text", text: id === "u" ? "Implement a transaction that preserves the native source turn identity." : "The transaction now stores the full source turn and schedules capture." }
    }];
    const hook = await readOpencodeSourceTurn({
      sessions: () => [{ id: "same-session", parentId: null, directory: null, agent: "build" }],
      messages,
      parts
    }, { conversationId: "same-session", turnId: "u" });
    const scan = await readOpencodeSourceTurn({
      sessions: () => [{ id: "same-session", parentId: null, directory: null, agent: "plan" }],
      messages,
      parts
    }, { conversationId: "same-session", turnId: "u" });
    expect(hook.turn?.profileId).toBe("build");
    expect(scan.turn?.profileId).toBe("build");
    const first = service.completeSourceTurn({
      ...buildSourceTurnRequest(hook.turn!, "hook"),
      namespace: { source: "opencode", profileId: hook.turn!.profileId!, userId: "source-user" }
    });
    const second = service.completeSourceTurn({
      ...buildSourceTurnRequest(scan.turn!, "agent_source_scan"),
      namespace: { source: "opencode", profileId: scan.turn!.profileId!, userId: "source-user" }
    });
    expect(first.status).toBe("stored");
    expect(second.status).toBe("existing");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 1 });
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

  it("stores pre-activation history for an initial or full scan and still rejects hooks and incremental scans", () => {
    const { service } = createTestService();
    const historicalTurn = {
      ...request().sourceTurn,
      turnId: "historical-turn",
      startedAt: "2000-01-01T10:00:00.000Z",
      completedAt: "2000-01-01T10:01:00.000Z"
    };
    const stored = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: historicalTurn
    }));
    expect(stored).toMatchObject({ status: "stored", result: { scheduledEvolution: true } });
    expect(stored.result?.l1MemoryIds).toHaveLength(1);
    expect(service.completeSourceTurn(request({
      channel: "hook",
      captureLegacyHistory: true,
      sourceTurn: { ...historicalTurn, turnId: "hook-historical" }
    }))).toMatchObject({ status: "rejected", reason: "legacy_before_activation" });
    expect(service.completeSourceTurn(request({
      channel: "agent_source_scan",
      sourceTurn: { ...historicalTurn, turnId: "incremental-historical" }
    }))).toMatchObject({ status: "rejected", reason: "legacy_before_activation" });
  });

  it("backfills history ahead of a newer capture without reopening that episode", () => {
    const { db, service } = createTestService();
    const newer = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        turnId: "newer-turn",
        startedAt: "2000-01-02T10:00:00.000Z",
        completedAt: "2000-01-02T10:01:00.000Z"
      }
    }));
    expect(newer.status).toBe("stored");
    const newerEpisode = new Repositories(db.db).runtime.getEpisode(newer.result!.episodeId)!;
    const older = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        turnId: "older-turn",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    const retry = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        turnId: "older-turn",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    expect(older).toMatchObject({ status: "stored", result: { scheduledEvolution: true } });
    expect(older.result?.sessionId).not.toBe(newer.result?.sessionId);
    expect(older.result?.episodeId).not.toBe(newer.result?.episodeId);
    expect(retry).toMatchObject({ status: "existing", result: { l1MemoryId: older.result?.l1MemoryId, duplicate: true } });
    const preserved = new Repositories(db.db).runtime.getEpisode(newer.result!.episodeId)!;
    expect(preserved).toMatchObject({ status: "open", l1MemoryIds: newerEpisode.l1MemoryIds, rawTurnIds: newerEpisode.rawTurnIds });
    expect(new Repositories(db.db).runtime.getSession(newer.result!.sessionId)?.status).toBe("open");
    expect(new Repositories(db.db).runtime.getSession(older.result!.sessionId)?.status).toBe("closed");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 2 });
  });

  it("backfills history beside a closed session and a closed episode without reopening them", () => {
    const { db, service } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const closedSession = service.openSession({
      namespace: { ...request().namespace!, sessionKey: "closed-session" },
      meta: { conversationId: "closed-session" }
    });
    runtime.closeSession(closedSession.sessionId, "2099-01-01T00:00:00.000Z");
    const historicalSession = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId: "closed-session",
        turnId: "historical-before-closed-session",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    const historicalSessionRetry = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId: "closed-session",
        turnId: "historical-before-closed-session",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    expect(historicalSession).toMatchObject({ status: "stored" });
    expect(historicalSession.result?.sessionId).not.toBe(closedSession.sessionId);
    expect(historicalSessionRetry).toMatchObject({ status: "existing", result: { duplicate: true } });
    expect(runtime.getSession(closedSession.sessionId)?.status).toBe("closed");
    expect(runtime.getSession(historicalSession.result!.sessionId)?.status).toBe("closed");

    const openSession = service.openSession({
      namespace: { ...request().namespace!, sessionKey: "closed-episode" },
      meta: { conversationId: "closed-episode" }
    });
    const legacy = service.completeTurn("legacy-writer-turn", {
      sessionId: openSession.sessionId,
      query: "Implement the source capture transaction",
      answer: "Implemented and verified the source capture transaction"
    });
    runtime.closeEpisode(legacy.episodeId, { closeReason: "evaluated" }, "2099-01-01T00:00:00.000Z");
    const beforeEpisode = runtime.getEpisode(legacy.episodeId)!;
    const historicalEpisode = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId: "closed-episode",
        turnId: "historical-before-closed-episode",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    const historicalEpisodeRetry = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId: "closed-episode",
        turnId: "historical-before-closed-episode",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    expect(historicalEpisode).toMatchObject({ status: "stored" });
    expect(historicalEpisode.result?.episodeId).not.toBe(legacy.episodeId);
    expect(historicalEpisodeRetry).toMatchObject({ status: "existing", result: { duplicate: true } });
    expect(runtime.getEpisode(legacy.episodeId)).toMatchObject({
      status: "closed",
      l1MemoryIds: beforeEpisode.l1MemoryIds,
      rawTurnIds: beforeEpisode.rawTurnIds
    });
    expect(runtime.getSession(openSession.sessionId)?.status).toBe("open");
  });

  it("keeps an explicit closed episode unchanged and rejects an episode from another namespace", () => {
    const { db, service } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const opened = service.openSession({
      namespace: { ...request().namespace!, sessionKey: "explicit-episode" },
      meta: { conversationId: "explicit-episode" }
    });
    const legacy = service.completeTurn("legacy-writer", {
      sessionId: opened.sessionId,
      query: "Implement the source capture transaction",
      answer: "Implemented and verified the source capture transaction"
    });
    runtime.closeEpisode(legacy.episodeId, { closeReason: "evaluated" }, "2099-01-01T00:00:00.000Z");
    const before = runtime.getEpisode(legacy.episodeId)!;
    const historical = service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sessionId: opened.sessionId,
      episodeId: legacy.episodeId,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId: "explicit-episode",
        turnId: "historical-explicit-episode",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    expect(historical).toMatchObject({ status: "stored" });
    expect(historical.result?.sessionId).not.toBe(opened.sessionId);
    expect(historical.result?.episodeId).not.toBe(legacy.episodeId);
    expect(runtime.getEpisode(legacy.episodeId)).toEqual(before);
    const raw = runtime.getRawTurn(historical.result!.rawTurnId)!;
    expect(raw.sessionId).toBe(runtime.getEpisode(historical.result!.episodeId)?.sessionId);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM raw_turns r JOIN episodes e ON e.id = r.episode_id WHERE r.session_id <> e.session_id").get()).toEqual({ count: 0 });

    const foreignSession = service.openSession({
      namespace: { userId: "review-b", source: "cursor", profileId: "default", sessionKey: "foreign-conversation" },
      meta: { conversationId: "foreign-conversation" }
    });
    const foreign = service.completeTurn("foreign-turn", {
      sessionId: foreignSession.sessionId,
      query: "Implement a separate transaction for the other workspace.",
      answer: "The separate transaction is ready and verified."
    });
    const foreignBefore = runtime.getEpisode(foreign.episodeId)!;
    expect(service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId: "review-conversation",
        turnId: "newer-review-turn",
        startedAt: "2000-01-02T10:00:00.000Z",
        completedAt: "2000-01-02T10:01:00.000Z"
      }
    })).status).toBe("stored");
    expect(() => service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      episodeId: foreign.episodeId,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId: "review-conversation",
        turnId: "cross-namespace-history",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }))).toThrow("source_episode_scope_conflict");
    expect(runtime.getEpisode(foreign.episodeId)).toEqual(foreignBefore);
  });

  it("does not recreate a source turn already completed by the old writer", () => {
    const { db, service } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const content = {
      query: "Implement capture identity transactions.",
      answer: "Implemented and verified the capture identity transaction."
    };
    const historicalTurn = {
      ...request().sourceTurn,
      conversationId: "legacy-writer-conversation",
      turnId: "same-native-turn",
      startedAt: "2000-01-01T10:00:00.000Z",
      completedAt: "2000-01-01T10:01:00.000Z"
    };
    const opened = service.openSession({
      namespace: { ...request().namespace!, sessionKey: historicalTurn.conversationId },
      meta: { conversationId: historicalTurn.conversationId }
    });
    const old = service.completeTurn("same-native-turn", { sessionId: opened.sessionId, ...content });
    runtime.closeEpisode(old.episodeId, { closeReason: "evaluated" }, "2099-01-01T00:00:00.000Z");
    const scan = () => service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: historicalTurn,
      ...content
    }));
    const activeMemories = () => (db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get() as { count: number }).count;
    const rawCount = () => (db.db.prepare("SELECT COUNT(*) AS count FROM raw_turns WHERE turn_id = ?").get("same-native-turn") as { count: number }).count;
    const before = activeMemories();
    expect(scan()).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
    expect(scan()).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
    expect(rawCount()).toBe(1);
    expect(activeMemories()).toBe(before);

    const closed = service.openSession({
      namespace: { ...request().namespace!, sessionKey: "legacy-closed-session" },
      meta: { conversationId: "legacy-closed-session" }
    });
    service.completeTurn("same-native-turn", { sessionId: closed.sessionId, ...content });
    service.closeSession(closed.sessionId);
    const closedBefore = activeMemories();
    const closedRawBefore = (db.db.prepare("SELECT COUNT(*) AS count FROM raw_turns WHERE turn_id = ?").get("same-native-turn") as { count: number }).count;
    expect(service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: { ...historicalTurn, conversationId: "legacy-closed-session" },
      ...content
    }))).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
    expect(activeMemories()).toBe(closedBefore);
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM raw_turns WHERE turn_id = ?").get("same-native-turn") as { count: number }).count).toBe(closedRawBefore);

    const deleted = service.openSession({
      namespace: { ...request().namespace!, sessionKey: "legacy-deleted" },
      meta: { conversationId: "legacy-deleted" }
    });
    const deletedTurn = service.completeTurn("same-native-turn", { sessionId: deleted.sessionId, ...content });
    runtime.closeEpisode(deletedTurn.episodeId, { closeReason: "evaluated" }, "2099-01-01T00:00:00.000Z");
    service.deleteMemory(deletedTurn.l1MemoryId, { namespace: request().namespace });
    const deletedBefore = activeMemories();
    expect(service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      sourceTurn: { ...historicalTurn, conversationId: "legacy-deleted" },
      ...content
    }))).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
    expect(activeMemories()).toBe(deletedBefore);
  });

  it("reuses an old agent-source import and keeps it deleted", () => {
    const { db, service } = createTestService();
    const conversationId = request().sourceTurn.conversationId;
    const firstUserMessageId = "legacy-user-message";
    const importedTurnId = legacyImportTurnId("codex", conversationId, firstUserMessageId);
    const content = {
      query: "Implement capture identity transactions.",
      answer: "Implemented and verified the capture identity transaction."
    };
    const imported = service.addMemory({
      namespace: request().namespace,
      adapterId: "agent-source:codex",
      turnId: importedTurnId,
      source: "codex",
      content: `## user\n\n${content.query}\n\n## assistant\n\n${content.answer}`,
      layer: "L1",
      title: content.query,
      tags: ["agent-source", "codex"]
    });
    const historical = () => service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      legacyImportTurnId: importedTurnId,
      ...content,
      sourceTurn: {
        ...request().sourceTurn,
        turnId: "native-after-import",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    expect(historical()).toMatchObject({ status: "existing", legacyImportMemoryId: imported.id });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get() as { count: number }).count).toBe(1);
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM raw_turns").get() as { count: number }).count).toBe(0);
    service.deleteMemory(imported.id, { namespace: request().namespace });
    expect(historical()).toMatchObject({ status: "rejected", reason: "capture_deleted" });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get() as { count: number }).count).toBe(0);
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM raw_turns").get() as { count: number }).count).toBe(0);
  });

  it("does not reuse an old import from the same project and a different workspace", () => {
    const { db, service } = createTestService();
    const conversationId = "workspace-scope";
    const importedTurnId = legacyImportTurnId("codex", conversationId, "legacy-user-message");
    const content = {
      query: "Implement capture identity transactions.",
      answer: "Implemented and verified the capture identity transaction."
    };
    const opened = service.openSession({
      namespace: { ...request().namespace!, sessionKey: conversationId, projectId: "project-p", workspaceId: "workspace-a" },
      meta: { conversationId }
    });
    const imported = service.addMemory({
      sessionId: opened.sessionId,
      namespace: { ...request().namespace!, projectId: "project-p", workspaceId: "workspace-a" },
      adapterId: "agent-source:codex",
      turnId: importedTurnId,
      source: "codex",
      content: `## user\n\n${content.query}\n\n## assistant\n\n${content.answer}`,
      layer: "L1",
      title: content.query,
      tags: ["agent-source", "codex"]
    });
    const scan = (workspaceId: string) => service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      legacyImportTurnId: importedTurnId,
      namespace: { ...request().namespace!, projectId: "project-p", workspaceId },
      ...content,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId,
        turnId: `native-${workspaceId}`,
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }));
    const otherWorkspace = scan("workspace-b");
    expect(otherWorkspace.status).toBe("stored");
    expect(otherWorkspace.legacyImportMemoryId).toBeUndefined();
    service.deleteMemory(imported.id, { namespace: { ...request().namespace!, projectId: "project-p", workspaceId: "workspace-a" } });
    const afterDelete = scan("workspace-c");
    expect(afterDelete.status).toBe("stored");
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL AND id != ?").get(imported.id) as { count: number }).count).toBe(2);
  });

  it.each(["projectId", "workspaceId"] as const)(
    "does not recreate an unkeyed %s turn, including after it was deleted",
    (dimension) => {
      const { db, service } = createTestService();
      const content = {
        query: "Implement capture identity transactions.",
        answer: "Implemented and verified the capture identity transaction."
      };
      const scan = (conversationId: string, scopeValue: string) => service.completeSourceTurn(request({
        channel: "agent_source_scan",
        captureLegacyHistory: true,
        namespace: {
          ...request().namespace!,
          sessionKey: conversationId,
          [dimension]: scopeValue
        },
        ...content,
        sourceTurn: {
          ...request().sourceTurn,
          conversationId,
          turnId: "same-native-turn",
          startedAt: "2000-01-01T10:00:00.000Z",
          completedAt: "2000-01-01T10:01:00.000Z"
        }
      }));
      const prepare = (conversationId: string, deleted: boolean) => {
        const namespace = {
          ...request().namespace!,
          sessionKey: conversationId,
          [dimension]: "original-scope"
        };
        const opened = service.openSession({ namespace, meta: { conversationId } });
        const old = service.completeTurn("same-native-turn", { sessionId: opened.sessionId, ...content });
        service.closeSession(opened.sessionId);
        if (deleted) service.deleteMemory(old.l1MemoryId, { namespace });
        const stored = db.db.prepare("SELECT project_id, workspace_id, meta_json FROM sessions WHERE id = ?")
          .get(opened.sessionId) as { project_id: string | null; workspace_id: string | null; meta_json: string };
        expect(stored[dimension === "projectId" ? "project_id" : "workspace_id"]).toBe("original-scope");
        expect(JSON.parse(stored.meta_json).source_namespace_key).toBeUndefined();
        return old.l1MemoryId;
      };
      const activeMemories = () => (db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get() as { count: number }).count;
      const rawCount = () => (db.db.prepare("SELECT COUNT(*) AS count FROM raw_turns WHERE turn_id = ?").get("same-native-turn") as { count: number }).count;

      prepare(`unkeyed-${dimension}`, false);
      const keptBefore = activeMemories();
      expect(scan(`unkeyed-${dimension}`, "original-scope")).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
      expect(rawCount()).toBe(1);
      expect(activeMemories()).toBe(keptBefore);

      prepare(`unkeyed-${dimension}-deleted`, true);
      const deletedBefore = activeMemories();
      const rawBeforeDeleteScan = rawCount();
      expect(scan(`unkeyed-${dimension}-deleted`, "original-scope")).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
      expect(rawCount()).toBe(rawBeforeDeleteScan);
      expect(activeMemories()).toBe(deletedBefore);

      prepare(`unkeyed-${dimension}-other`, false);
      const other = scan(`unkeyed-${dimension}-other`, "other-scope");
      expect(other.status).toBe("stored");
      expect(other.result?.l1MemoryId).toBeTruthy();
    }
  );

  it("still treats an unkeyed project session as completed for a default-scope scan", () => {
    const { service } = createTestService();
    const conversationId = "unkeyed-project-to-default";
    const content = {
      query: "Implement capture identity transactions.",
      answer: "Implemented and verified the capture identity transaction."
    };
    const opened = service.openSession({
      namespace: { ...request().namespace!, sessionKey: conversationId, projectId: "project-a" },
      meta: { conversationId }
    });
    service.completeTurn("same-native-turn", { sessionId: opened.sessionId, ...content });
    service.closeSession(opened.sessionId);
    expect(service.completeSourceTurn(request({
      channel: "agent_source_scan",
      captureLegacyHistory: true,
      namespace: { ...request().namespace!, sessionKey: conversationId },
      ...content,
      sourceTurn: {
        ...request().sourceTurn,
        conversationId,
        turnId: "same-native-turn",
        startedAt: "2000-01-01T10:00:00.000Z",
        completedAt: "2000-01-01T10:01:00.000Z"
      }
    }))).toMatchObject({ status: "pending", reason: "legacy_source_turn_already_completed" });
  });

  it.each(["projectId", "workspaceId", "tenantId"] as const)(
    "backfills the same historical turn into a different %s scope",
    (dimension) => {
      const { db, service } = createTestService();
      const conversationId = `scoped-conversation-${dimension}`;
      const base = { ...request().namespace!, sessionKey: conversationId };
      const content = {
        query: "Implement capture identity transactions.",
        answer: "Implemented and verified the capture identity transaction."
      };
      const capture = (scopeValue: string, turnId: string, day: "01" | "02") => service.completeSourceTurn(request({
        channel: "agent_source_scan",
        captureLegacyHistory: true,
        namespace: { ...base, [dimension]: scopeValue },
        ...content,
        sourceTurn: {
          ...request().sourceTurn,
          conversationId,
          turnId,
          startedAt: `2000-01-${day}T10:00:00.000Z`,
          completedAt: `2000-01-${day}T10:01:00.000Z`
        }
      }));
      const first = capture("scope-a", "same-native-turn", "01");
      const newer = capture("scope-b", "newer-turn", "02");
      const historical = capture("scope-b", "same-native-turn", "01");
      const retry = capture("scope-b", "same-native-turn", "01");
      expect(first.status).toBe("stored");
      expect(newer.status).toBe("stored");
      expect(historical).toMatchObject({ status: "stored" });
      expect(historical.result?.sessionId).not.toBe(first.result?.sessionId);
      expect(retry).toMatchObject({ status: "existing", result: { l1MemoryId: historical.result?.l1MemoryId, duplicate: true } });
      const captures = db.db.prepare("SELECT namespace_key, turn_id FROM source_turn_captures WHERE turn_id = ?").all("same-native-turn") as Array<{ namespace_key: string }>;
      expect(new Set(captures.map((row) => row.namespace_key)).size).toBe(2);
    }
  );

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
