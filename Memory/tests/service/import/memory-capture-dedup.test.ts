import { afterEach, describe, expect, it } from "vitest";
import type { MemoryService } from "../../../src/index.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { memoryCaptureQaHash } from "../../../src/utils/memory-capture-claim.js";
import type { RuntimeNamespace } from "../../../src/types.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { join } from "node:path";

const { cleanup, createTestService, createTestMemoryService } = createMemoryServiceFixture();

afterEach(cleanup);

const namespace = {
  source: "codex",
  profileId: "jiang",
  sessionKey: "native-capture-conversation",
  userId: "qa-dedup-user"
};

describe("MemoryService / import / QA capture dedup", () => {
  it.each([false, true])("uses the native conversation ID of a prefixed Hook session (legacy claim=%s)", (legacy) => {
    const { db, service } = createTestService();
    const ns = { ...namespace, sessionKey: "codex-memory-native-conversation" };
    const session = service.openSession({ namespace: ns, meta: { conversationId: "native-conversation" } });
    const query = "Read package.json and report the test command.";
    const answer = "The test command is npm test.";
    const first = service.completeTurn("native-turn", {
      adapterId: "memmy-codex-hook", requestId: "prefixed-hook-turn",
      sessionId: session.sessionId, namespace: ns, query, answer,
      toolCalls: [{ id: "read", name: "read_file", input: { path: "package.json" } }],
      toolResults: [{ id: "read", output: "npm test" }]
    });
    if (legacy) {
      db.db.prepare("UPDATE memories SET user_id='historical-account' WHERE id=?").run(first.l1MemoryId);
      db.db.prepare("UPDATE memory_capture_claims SET user_id='historical-account',qa_hash=? WHERE primary_memory_id=?")
        .run(memoryCaptureQaHash(query, answer), first.l1MemoryId);
    }
    const before = db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.l1MemoryId);
    const scanned = addScannedTurn(service, { namespace: { ...ns, sessionKey: "native-conversation", userId: "account-b" }, requestId: "scan-native", turnId: "native-turn", query, answer });
    expect(scanned).toMatchObject({ id: first.l1MemoryId, duplicate: true });
    expect(l1Count(db.db)).toBe(1);
    expect(db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.l1MemoryId)).toEqual(before);
  });

  it("retains a proven historical scan ID across QA revisions, account switches and restart", async () => {
    const { db, service, root } = createTestService();
    const ns = { ...namespace, projectId: "legacy-project" };
    const sessionId = service.openSession({ namespace: ns }).sessionId;
    const input = { namespace: ns, sessionId, requestId: "legacy-first", turnId: "legacy-turn", query: "Test command?", answer: "npm test" };
    const first = addScannedTurn(service, input);
    const key = "memory.add:agent-source:codex:turn:legacy-turn";
    db.db.prepare("UPDATE memories SET memory_key=?,user_id='historical-account' WHERE id=?").run(key, first.id);
    db.db.prepare("UPDATE memory_capture_claims SET qa_hash=?,user_id='historical-account' WHERE primary_memory_id=?")
      .run(memoryCaptureQaHash(input.query, input.answer), first.id);
    const oldClaim = db.db.prepare("SELECT * FROM memory_capture_claims WHERE user_id='historical-account'").get();
    const revised = { ...input, namespace: { ...ns, userId: "another-account" }, requestId: "legacy-revised", answer: "npm run test" };
    expect(addScannedTurn(service, revised).id).toBe(first.id);
    expect(addScannedTurn(service, { ...revised, requestId: "legacy-replay" })).toMatchObject({ id: first.id, duplicate: true });
    expect(db.db.prepare("SELECT memory_key,user_id,memory_value FROM memories WHERE id=?").get(first.id))
      .toMatchObject({ memory_key: key, user_id: "historical-account", memory_value: expect.stringContaining(revised.answer) });
    expect(db.db.prepare("SELECT * FROM memory_capture_claims WHERE user_id='historical-account'").get()).toEqual(oldClaim);
    expect(l1Count(db.db)).toBe(1);
    expect(db.db.prepare("SELECT DISTINCT primary_memory_id FROM memory_capture_claims").all()).toEqual([{ primary_memory_id: first.id }]);
    await service.stop(); db.close();
    const reopenedDb = new MemoryDb({ path: join(root, "memory.sqlite") });
    const restarted = createTestMemoryService({ db: reopenedDb, mode: "dev" });
    expect(addScannedTurn(restarted, { ...revised, requestId: "after-restart", answer: "npm run test:unit" }).id).toBe(first.id);
    expect(l1Count(reopenedDb.db)).toBe(1);
    expect(reopenedDb.db.prepare("SELECT DISTINCT primary_memory_id FROM memory_capture_claims").all()).toEqual([{ primary_memory_id: first.id }]);
  });

  it.each(["projectId", "workspaceId", "tenantId", "profileId"] as const)("retains %s boundaries when conversation information is missing", (field) => {
    const { db, service } = createTestService();
    const ns = { ...namespace, sessionKey: undefined, projectId: "project-a", workspaceId: "workspace-a", tenantId: "tenant-a" };
    const input = { namespace: ns, requestId: "missing-first", turnId: "same-turn", query: "Test command?", answer: "first answer" };
    const first = addScannedTurn(service, input);
    const before = db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.id);
    const other = addScannedTurn(service, { ...input, namespace: { ...ns, [field]: "different", userId: "other-account" }, requestId: "missing-other", answer: "other answer" });
    expect(other.id).not.toBe(first.id);
    expect(db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.id)).toEqual(before);
    const revised = addScannedTurn(service, { ...input, namespace: { ...ns, userId: "other-account" }, requestId: "missing-revised", answer: "updated answer" });
    expect(revised.id).toBe(first.id);
    expect(l1Count(db.db)).toBe(2);
    expect(db.db.prepare("SELECT COUNT(*) n FROM memories WHERE user_id IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT COUNT(*) n FROM memory_capture_claims").get()).toEqual({ n: 0 });
  });

  it.each(["project", "conversation", "missing-session"] as const)("does not adopt a historical key with %s mismatch or missing evidence", (difference) => {
    const { db, service } = createTestService();
    const ns = { ...namespace, projectId: "legacy-project" };
    const sessionId = difference === "missing-session" ? undefined : service.openSession({ namespace: ns }).sessionId;
    const input = { namespace: ns, sessionId, requestId: "legacy-first", turnId: "legacy-turn", query: "Test command?", answer: "old answer" };
    const first = addScannedTurn(service, input);
    if (difference === "missing-session") {
      // Model the old writer, which had neither a Session nor a persisted origin.
      db.db.prepare("UPDATE memories SET info_json=json_remove(info_json,'$.native_origin_v1'),properties_json=json_remove(properties_json,'$.info.native_origin_v1') WHERE id=?").run(first.id);
    }
    db.db.prepare("UPDATE memories SET memory_key=? WHERE id=?").run("memory.add:agent-source:codex:turn:legacy-turn", first.id);
    db.db.prepare("UPDATE memory_capture_claims SET qa_hash=? WHERE primary_memory_id=?").run(memoryCaptureQaHash(input.query, input.answer), first.id);
    const before = db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.id);
    const otherNamespace = { ...ns, ...(difference === "project" ? { projectId: "different" } : {}), ...(difference === "conversation" ? { sessionKey: "different" } : {}) };
    const otherSession = service.openSession({ namespace: otherNamespace }).sessionId;
    const other = addScannedTurn(service, { ...input, namespace: otherNamespace, sessionId: otherSession, requestId: "legacy-other", answer: "new answer" });
    expect(other.id).not.toBe(first.id);
    expect(db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.id)).toEqual(before);
  });

  it.each([false, true])("updates only the verified historical ID when another project shares its old key (changed QA=%s)", (changedQa) => {
    const { db, service } = createTestService();
    const ns = { ...namespace, projectId: "project-a" };
    const sessionId = service.openSession({ namespace: ns }).sessionId;
    const input = { namespace: ns, sessionId, requestId: "original", turnId: "shared-old-key", query: "Test command?", answer: "old answer" };
    const original = addScannedTurn(service, input);
    const otherNs = { ...namespace, projectId: "project-b", sessionKey: "other-conversation" };
    const otherSession = service.openSession({ namespace: otherNs }).sessionId;
    const other = addScannedTurn(service, { ...input, namespace: otherNs, sessionId: otherSession, requestId: "other", answer: "other answer" });
    const key = "memory.add:agent-source:codex:turn:shared-old-key";
    db.db.prepare("UPDATE memories SET memory_key=?,user_id=?,updated_at=? WHERE id=?").run(key, "old-a", "2026-01-01T00:00:00.000Z", original.id);
    db.db.prepare("UPDATE memories SET memory_key=?,user_id=?,updated_at=? WHERE id=?").run(key, "old-b", "2099-01-01T00:00:00.000Z", other.id);
    for (const [id, answer] of [[original.id, input.answer], [other.id, "other answer"]]) {
      db.db.prepare("UPDATE memory_capture_claims SET qa_hash=? WHERE primary_memory_id=?").run(memoryCaptureQaHash(input.query, answer!), id);
    }
    const otherBefore = db.db.prepare("SELECT * FROM memories WHERE id=?").get(other.id);
    const revised = addScannedTurn(service, { ...input, namespace: { ...ns, userId: "new-account" }, requestId: "revised", answer: changedQa ? "revised answer" : input.answer });
    expect(revised.id).toBe(original.id);
    expect(db.db.prepare("SELECT * FROM memories WHERE id=?").get(other.id)).toEqual(otherBefore);
    expect(db.db.prepare("SELECT user_id,memory_key FROM memories WHERE id=?").get(original.id)).toEqual({ user_id: "old-a", memory_key: key });
    expect(l1Count(db.db)).toBe(2);
  });

  it.each(["legacy", "scoped"])("preserves a deleted %s scan when a later QA revision arrives", (keyKind) => {
    const { db, service } = createTestService();
    const sessionId = service.openSession({ namespace }).sessionId;
    const input = { sessionId, requestId: "deleted-first", turnId: "deleted-turn", query: "Test command?", answer: "old answer" };
    const first = addScannedTurn(service, input);
    if (keyKind === "legacy") db.db.prepare("UPDATE memories SET memory_key=? WHERE id=?").run("memory.add:agent-source:codex:turn:deleted-turn", first.id);
    db.db.prepare("UPDATE memories SET status='deleted',deleted_at=? WHERE id=?").run("2026-10-01T00:00:00.000Z", first.id);
    const before = db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.id);
    expect(addScannedTurn(service, { ...input, requestId: "deleted-revision", answer: "new answer" }))
      .toMatchObject({ id: first.id, status: "deleted", duplicate: true });
    expect(db.db.prepare("SELECT * FROM memories WHERE id=?").get(first.id)).toEqual(before);
    expect(l1Count(db.db)).toBe(0);
  });

  it.each([false, true])("keeps a proven same-turn hook capture across accounts (legacy claim=%s)", (legacy) => {
    const { db, service } = createTestService();
    const session = service.openSession({
      adapterId: "memmy-codex-hook",
      requestId: "hook-first-open",
      namespace
    });
    const query = "检查项目配置并说明使用哪个包管理器。";
    const answer = "项目使用 pnpm workspace。";
    const completed = service.completeTurn("hook-first-turn", {
      adapterId: "memmy-codex-hook",
      requestId: "hook-first-complete",
      sessionId: session.sessionId,
      query,
      answer,
      toolCalls: [{ id: "read-1", name: "read_file", input: { path: "package.json" } }],
      toolResults: [{ id: "read-1", name: "read_file", output: "packageManager: pnpm" }]
    });
    const beforeCount = l1Count(db.db);
    if (legacy) db.db.prepare("UPDATE memory_capture_claims SET qa_hash = ?, user_id = 'old-account'")
      .run(memoryCaptureQaHash(query, answer));

    const scanned = addScannedTurn(service, {
      requestId: "scan-after-hook",
      turnId: "hook-first-turn",
      namespace: { ...namespace, userId: "another-account" },
      query,
      answer,
      intermediateAssistant: "我先读取 package.json。"
    });

    expect(scanned.duplicate).toBe(true);
    expect(scanned.id).toBe(completed.l1MemoryId);
    expect(l1Count(db.db)).toBe(beforeCount);
    expect(db.db.prepare(
      `SELECT captured_by FROM memory_capture_claims
       WHERE source = 'codex'`
    ).get()).toEqual({ captured_by: "turn_complete" });
  });

  it("keeps the scan capture and still records the hook raw turn and episode link", () => {
    const { db, service } = createTestService();
    const query = "汇总当前仓库的测试命令。";
    const answer = "运行 npm test 即可执行完整测试。";
    const scanned = addScannedTurn(service, {
      requestId: "scan-first",
      turnId: "scan-first-hook-turn",
      query,
      answer,
      intermediateAssistant: "我先检查 package.json scripts。"
    });
    const session = service.openSession({
      adapterId: "memmy-codex-hook",
      requestId: "scan-first-open",
      namespace
    });

    const completed = service.completeTurn("scan-first-hook-turn", {
      adapterId: "memmy-codex-hook",
      requestId: "scan-first-hook-complete",
      sessionId: session.sessionId,
      query,
      answer,
      toolCalls: [{ id: "read-2", name: "read_file", input: { path: "package.json" } }],
      toolResults: [{ id: "read-2", name: "read_file", output: "test: vitest run" }]
    });

    expect(l1Count(db.db)).toBe(1);
    expect(completed.l1MemoryIds).toEqual([scanned.id]);
    expect(completed.jobs.map((job) => job.jobType)).not.toContain("trace_summary");
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM raw_turns WHERE id = ?`
    ).get(completed.rawTurnId)).toEqual({ count: 1 });
    const episode = db.db.prepare(
      `SELECT l1_memory_ids_json, raw_turn_ids_json FROM episodes WHERE id = ?`
    ).get(completed.episodeId) as { l1_memory_ids_json: string; raw_turn_ids_json: string };
    expect(JSON.parse(episode.l1_memory_ids_json)).toContain(scanned.id);
    expect(JSON.parse(episode.raw_turn_ids_json)).toContain(completed.rawTurnId);
    expect(db.db.prepare(
      `SELECT captured_by FROM memory_capture_claims
       WHERE user_id IS ? AND source = 'codex'`
    ).get(null)).toEqual({ captured_by: "agent_source_scan" });
  });

  it("stores a second memory when the final assistant answer differs", () => {
    const { db, service } = createTestService();
    const query = "项目使用哪个包管理器？";
    const first = addScannedTurn(service, {
      requestId: "different-answer-1",
      turnId: "codex:different-answer-1",
      query,
      answer: "项目使用 pnpm。"
    });
    const second = addScannedTurn(service, {
      requestId: "different-answer-2",
      turnId: "codex:different-answer-2",
      query,
      answer: "项目使用 npm。"
    });

    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBeUndefined();
    expect(second.id).not.toBe(first.id);
    expect(l1Count(db.db)).toBe(2);
  });

  it.each(["project", "conversation", "turn", "missing-origin"] as const)("does not merge equal QA with a different %s", (difference) => {
    const { db, service } = createTestService();
    const firstNamespace = { ...namespace, projectId: "project-a" };
    const otherNamespace = { ...firstNamespace, userId: "account-b",
      ...(difference === "project" ? { projectId: "project-b" } : {}),
      ...(difference === "conversation" ? { sessionKey: "other-conversation" } : {}),
      ...(difference === "missing-origin" ? { sessionKey: undefined } : {}) };
    const scanned = addScannedTurn(service, { namespace: firstNamespace, requestId: "first", turnId: "native-turn", query: "Run tests", answer: "Tests passed" });
    const session = service.openSession({ namespace: otherNamespace });
    const completed = service.completeTurn(difference === "turn" ? "another-turn" : "native-turn", {
      sessionId: session.sessionId, query: "Run tests", answer: "Tests passed"
    });
    expect(completed.l1MemoryIds).not.toContain(scanned.id);
    expect(l1Count(db.db)).toBe(2);
  });

  it("does not merge scans with the same turn ID in different projects", () => {
    const { db, service } = createTestService();
    const input = { requestId: "scan-a", turnId: "turn-1", query: "Run tests", answer: "Tests passed" };
    const a = addScannedTurn(service, { ...input, namespace: { ...namespace, projectId: "a" } });
    const b = addScannedTurn(service, { ...input, requestId: "scan-b", namespace: { ...namespace, projectId: "b", userId: "b" } });
    expect(b.id).not.toBe(a.id);
    expect(l1Count(db.db)).toBe(2);
  });

  it("keeps revised scanner turns on the existing memory id without leaving dangling claims", () => {
    const { db, service } = createTestService();
    const first = addScannedTurn(service, {
      requestId: "revised-turn-1",
      turnId: "codex:stable-revised-turn",
      query: "测试命令是什么？",
      answer: "运行 npm test。"
    });
    const revised = addScannedTurn(service, {
      requestId: "revised-turn-2",
      turnId: "codex:stable-revised-turn",
      query: "测试命令是什么？",
      answer: "运行 npm run test。"
    });
    const replay = addScannedTurn(service, {
      requestId: "revised-turn-3",
      turnId: "codex:stable-revised-turn",
      query: "测试命令是什么？",
      answer: "运行 npm run test。"
    });

    expect(revised.id).toBe(first.id);
    expect(revised.duplicate).toBeUndefined();
    expect(replay.id).toBe(first.id);
    expect(replay.duplicate).toBe(true);
    expect(l1Count(db.db)).toBe(1);
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_capture_claims
       WHERE primary_memory_id = ?`
    ).get(first.id)).toEqual({ count: 2 });
  });
});

function addScannedTurn(
  service: MemoryService,
  input: {
    requestId: string;
    turnId: string;
    query: string;
    answer: string;
    intermediateAssistant?: string;
    namespace?: RuntimeNamespace;
    sessionId?: string;
  }
): ReturnType<MemoryService["addMemory"]> {
  return service.addMemory({
    namespace: input.namespace ?? namespace,
    sessionId: input.sessionId,
    adapterId: "agent-source:codex",
    requestId: input.requestId,
    layer: "L1",
    source: "codex",
    tags: ["agent-source", "codex"],
    turnId: input.turnId,
    content: [
      `## user\n\n${input.query}`,
      ...(input.intermediateAssistant ? [`## assistant\n\n${input.intermediateAssistant}`] : []),
      "## tool\n\nTool: read_file\n\nOutput:\n工具调用的数量和内容不参与 QA 判重。",
      `## assistant\n\n${input.answer}`
    ].join("\n\n")
  });
}

function l1Count(db: { prepare(sql: string): { get(): unknown } }): number {
  return (db.prepare(
    `SELECT COUNT(*) AS count FROM memories
     WHERE memory_layer = 'L1' AND deleted_at IS NULL`
  ).get() as { count: number }).count;
}
