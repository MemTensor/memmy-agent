import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, SCHEMA_VERSION } from "../../../src/index.js";
import { insertActiveSkillMemoryForTest } from "../../fixtures/evolution-fixture.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { createTurnJudgeLlm, turnJudgeConfig } from "./turn-judge-llm.js";
const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.useRealTimers(); await fixture.cleanup(); });

async function drain(service: ReturnType<typeof fixture.createTestService>["service"], limit = 8) {
  for (let i = 0; i < limit; i++) {
    const result = await service.runWorkerOnce(30);
    if (!result.leased) {
      const row = service["repos"].db.prepare("SELECT MIN(available_at) AS at FROM evolution_jobs WHERE status='failed' AND failure_count < max_attempts AND blocked_reason IS NULL").get() as { at: string | null };
      if (!row.at) break;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Math.max(Date.now(), Date.parse(row.at)));
    }
  }
}


describe("raw-first independent L1 and Episode processing", () => {
  it.each([true, false])("preserves the original capture model contract after exhausted retries and restart (%s)", async enabled => {
    const { llm, judgeCalls } = createTurnJudgeLlm(); const complete = llm.completeJson;
    let fail = true;
    const captureInputs: string[] = [];
    llm.completeJson = async (messages, options) => {
      if (options.operation === "capture.summarize") {
        captureInputs.push(JSON.stringify(messages));
        if (fail) throw new Error("quota exhausted");
      }
      return complete(messages, options);
    };
    const config = turnJudgeConfig(enabled);
    const { service, db } = fixture.createTestService({ llm, config });
    const { sessionId } = service.openSession({});
    const saved = await service.completeTurn("retry-contract", { sessionId, query: "Persist the original capture contract", answer: "Verified outcome" });
    await drain(service);
    expect(db.db.prepare("SELECT status FROM evolution_jobs WHERE job_type='trace_summary'").get()).toEqual({ status: "dead_letter" });
    fail = false;
    const restored = fixture.createTestMemoryService({ db: new MemoryDb({ path: db.path }), llm, config });
    restored.reconcileWorkerStartup(); await drain(restored);
    expect(captureInputs.at(-1)).toBe(captureInputs[0]);
    expect(judgeCalls).toHaveLength(enabled ? 1 : 0);
    expect(db.db.prepare("SELECT state FROM memory_processing_state WHERE memory_id=?").get(saved.l1MemoryId)).toEqual({ state: "ready" });
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
  });
  it.each([true, false].flatMap(enabled => (["negative", "positive"] as const).map(polarity => ({ enabled, polarity }))))(
    "defers feedback evolution until attribution and preserves it across recovery ($enabled, $polarity)", async ({ enabled, polarity }) => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    let failSelection = true;
    llm.completeJson = async (messages, options) => {
      if (failSelection && options.operation === "episode.select.v1") throw new Error("selection unavailable");
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig(enabled) });
    const repos = new Repositories(db.db);
    const firstSession = service.openSession({}).sessionId;
    const secondSession = service.openSession({}).sessionId;
    const first = await service.completeTurn("feedback-pending", { sessionId: firstSession, query: "Fix the parser", answer: "Parser fixed" });
    const second = await service.completeTurn("unrelated-pending", { sessionId: secondSession, query: "Build the UI", answer: "UI built" });
    await drain(service);
    expect(repos.memories.get(first.l1MemoryId)?.status).toBe("activated");
    expect(repos.runtime.getRawTurn(first.rawTurnId)?.episodeId).toBeUndefined();
    const unrelatedBefore = repos.memories.get(second.l1MemoryId)?.properties;
    const response = await service.feedback({
      sessionId: firstSession, l1MemoryId: first.l1MemoryId,
      channel: "explicit", polarity, rationale: polarity === "negative" ? "The parser still fails validation."
        : "Success: you must validate the parser output against the schema before publishing."
    });
    expect(response.jobs.map(job => job.jobType)).not.toContain("reward");
    await drain(service);
    expect(db.db.prepare("SELECT count(*) AS n FROM memories WHERE memory_layer='L2'").get()).toEqual({ n: 0 });
    expect(repos.memories.get(second.l1MemoryId)?.properties).toEqual(unrelatedBefore);
    expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE job_type='reward'").get()).toEqual({ n: 0 });
    service.closeSession(firstSession);
    failSelection = false;
    const restored = fixture.createTestMemoryService({ db: new MemoryDb({ path: db.path }), llm, config: turnJudgeConfig(enabled) });
    restored.reconcileWorkerStartup();
    await drain(restored);
    const episodeId = repos.runtime.getRawTurn(first.rawTurnId)?.episodeId;
    expect(episodeId).toBeTruthy();
    expect(episodeId).not.toBe(repos.runtime.getRawTurn(second.rawTurnId)?.episodeId);
    const feedback = repos.runtime.listFeedback({ sessionId: firstSession });
    expect(feedback.filter(item => item.channel === "explicit")).toHaveLength(1);
    expect(feedback.find(item => item.channel === "explicit")?.episodeId).toBe(episodeId);
    expect(repos.runtime.getEpisode(episodeId)?.feedbackIds).toContain(response.feedbackId);
    expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE job_type='reward' AND episode_id=?").get(episodeId)).toEqual({ n: 1 });
    expect(repos.runtime.getSession(firstSession)?.status).toBe("closed");
    if (polarity === "positive") {
      expect(db.db.prepare("SELECT status,attempts,episode_id FROM evolution_jobs WHERE job_type='feedback_experience'").get())
        .toEqual({ status: "succeeded", attempts: 1, episode_id: episodeId });
      const policies = repos.memories.list({ memoryLayer: "L2" }, 10);
      expect(policies).toHaveLength(1);
      expect(JSON.stringify(policies[0]!.properties)).toContain(episodeId);
      restored.reconcileWorkerStartup(); await drain(restored);
      expect(repos.memories.list({ memoryLayer: "L2" }, 10)).toHaveLength(1);
    }
  });

  it("does not score pending turns through previously queued reward or reflection jobs", async () => {
    const { llm } = createTurnJudgeLlm(); const complete = llm.completeJson;
    llm.completeJson = async (messages, options) => {
      if (options.operation === "episode.select.v1") throw new Error("offline");
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const repos = new Repositories(db.db);
    const saved = [];
    for (const name of ["first", "unrelated"]) {
      const { sessionId } = service.openSession({});
      saved.push(await service.completeTurn(name, { sessionId, query: `${name} task`, answer: `${name} result` }));
    }
    await drain(service);
    const before = saved.map(turn => repos.memories.get(turn.l1MemoryId)?.properties);
    const at = new Date().toISOString();
    for (const jobType of ["reward", "reflection"] as const) repos.runtime.enqueueJob({
      id: `old-${jobType}`, jobType, status: "queued", userId: "local-user",
      sessionId: saved[0]!.sessionId, targetMemoryId: saved[0]!.l1MemoryId,
      payload: { l1MemoryId: saved[0]!.l1MemoryId, polarity: "negative", magnitude: 1 },
      attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at
    });
    await drain(service);
    expect(saved.map(turn => repos.memories.get(turn.l1MemoryId)?.properties)).toEqual(before);
    for (const type of ["reward", "reflection"]) expect(repos.runtime.getJob(`old-${type}`)?.status).toBe("succeeded");
  });

  it.each(["deleted_at", "redacted_at"])("does not evolve deferred feedback after its raw turn is %s", async field => {
    const { llm } = createTurnJudgeLlm(); const complete = llm.completeJson;
    llm.completeJson = async (messages, options) => {
      if (options.operation === "episode.select.v1") throw new Error("offline");
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const saved = await service.completeTurn("removed", { sessionId, query: "Temporary input", answer: "Temporary answer" });
    await drain(service);
    await service.feedback({ sessionId, l1MemoryId: saved.l1MemoryId, channel: "explicit", polarity: "positive",
      rationale: "Success: you must validate the schema before publishing." });
    expect(db.db.prepare("SELECT status,attempts FROM evolution_jobs WHERE job_type='feedback_experience'").get())
      .toEqual({ status: "queued", attempts: 0 });
    db.db.prepare(`UPDATE raw_turns SET ${field}=?,user_text=NULL,assistant_text=NULL WHERE id=?`).run(new Date().toISOString(), saved.rawTurnId);
    await drain(service);
    expect(db.db.prepare("SELECT count(*) AS n FROM memories WHERE memory_layer='L2'").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT status FROM evolution_jobs WHERE job_type='feedback_experience'").get()).toEqual({ status: "succeeded" });
  });

  it.each([true, false])("persists before either model; survives failure, close and restart (turnJudge=%s)", async enabled => {
    const { llm } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    let calls = 0;
    llm.completeJson = async () => { calls++; throw new Error("network unavailable / quota exhausted"); };
    const config = turnJudgeConfig(enabled);
    const { service, db } = fixture.createTestService({ llm, config });
    const { sessionId } = service.openSession({});
    const request = { sessionId, query: "Keep original request", answer: "Keep original answer" };
    const result = await service.completeTurn("original", request);
    expect(calls).toBe(0);
    expect(result.episodeId).toBeUndefined();
    expect(result.assignmentStatus).toBe("pending");
    expect(db.db.prepare("SELECT user_text,assistant_text,episode_id FROM raw_turns WHERE id=?").get(result.rawTurnId))
      .toEqual({ user_text: request.query, assistant_text: request.answer, episode_id: null });
    expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE job_type='capture_replay'").get()).toEqual({ n: 0 });
    const failed = await service.runWorkerOnce(30);
    expect(failed.failed).toBe(2);
    service.closeSession(sessionId);
    llm.completeJson = complete;
    const reopened = new MemoryDb({ path: db.path });
    const restored = fixture.createTestMemoryService({ db: reopened, llm, config });
    restored.reconcileWorkerStartup();
    await drain(restored);
    const repos = new Repositories(reopened.db);
    expect(repos.runtime.getRawTurn(result.rawTurnId)?.episodeId, JSON.stringify(repos.runtime.listJobs())).toBeTruthy();
    expect(repos.runtime.getSession(sessionId)?.status).toBe("closed");
    expect(repos.runtime.listEpisodesForSession(sessionId).every(e => e.status === "closed" && e.rawTurnIds.length > 0)).toBe(true);
    expect((await restored.completeTurn("original", request)).duplicate).toBe(true);
    expect(reopened.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
  });

  it.each([true, false])("keeps successful L1 while assignment fails; only retries assignment (%s)", async enabled => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const complete = llm.completeJson;
    let fail = true;
    llm.completeJson = async (messages, options) => {
      if (options.operation === "episode.select.v1" && fail) throw new Error("model quota exhausted");
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig(enabled) });
    const { sessionId } = service.openSession({});
    const result = await service.completeTurn("one", { sessionId, query: "Preserve completed task", answer: "Implemented and verified" });
    await service.runWorkerOnce(30);
    const repos = new Repositories(db.db);
    const before = repos.memories.get(result.l1MemoryId)!;
    expect(before.status).toBe("activated");
    expect(repos.runtime.getRawTurn(result.rawTurnId)?.episodeId).toBeUndefined();
    expect(before.info.episode_id).toBeUndefined();
    const judged = judgeCalls.length;
    fail = false; expect(service.retryMemoryProcessing(result.l1MemoryId).accepted).toBe(true); await drain(service);
    expect(repos.runtime.getRawTurn(result.rawTurnId)?.episodeId, JSON.stringify(repos.runtime.listJobs())).toBeTruthy();
    expect(repos.memories.get(result.l1MemoryId)?.info.episode_id).toBe(repos.runtime.getRawTurn(result.rawTurnId)?.episodeId);
    expect(judgeCalls.length).toBe(judged);
    expect(repos.runtime.l1MemoryIdsForRawTurn(result.rawTurnId)).toEqual([result.l1MemoryId]);
  });

  it("starts both model calls independently while Episode selection is blocked", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm(); const complete = llm.completeJson;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    llm.completeJson = async (messages, options) => {
      if (options.operation === "episode.select.v1") { entered(); await blocked; }
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig(), concurrency: new WorkerConcurrencyController({ localModelConcurrency: 2 }, {}) });
    const { sessionId } = service.openSession({});
    const result = await service.completeTurn("parallel", { sessionId, query: "Capture concurrently", answer: "Verified result" });
    const running = service.runWorkerOnce(30);
    await started;
    try {
      await expect.poll(() => new Repositories(db.db).memories.get(result.l1MemoryId)?.status).toBe("activated");
      expect(judgeCalls.length).toBe(1);
      expect(db.db.prepare("SELECT user_text,episode_id FROM raw_turns WHERE id=?").get(result.rawTurnId))
        .toEqual({ user_text: "Capture concurrently", episode_id: null });
    } finally { release(); await running; }
    await drain(service);
    expect(new Repositories(db.db).runtime.getRawTurn(result.rawTurnId)?.episodeId).toBeTruthy();
  });

  it("persists the Episode decision while judgment is still blocked", async () => {
    const { llm } = createTurnJudgeLlm(); const complete = llm.completeJson;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    llm.completeJson = async (messages, options) => {
      if (options.operation === "capture.summarize") await barrier;
      return complete(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const saved = await service.completeTurn("judge-blocked", { sessionId, query: "Independent selection", answer: "Persist this answer" });
    const repos = new Repositories(db.db);
    const running = service.runWorkerOnce(30);
    try {
      await expect.poll(() => repos.runtime.getRawTurn(saved.rawTurnId)?.messagePayload?.episode_assignment)
        .toMatchObject({ status: "selected" });
      expect(repos.runtime.getRawTurn(saved.rawTurnId)?.assistantText).toBe("Persist this answer");
      expect(repos.runtime.getRawTurn(saved.rawTurnId)?.episodeId).toBeUndefined();
      expect(repos.runtime.listEpisodesForSession(sessionId)).toHaveLength(0);
    } finally { release(); await running; }
    await drain(service);
    expect(repos.runtime.getRawTurn(saved.rawTurnId)?.episodeId).toBeTruthy();
  });

  it.each(["hook", "agent_source_scan"] as const)("saves a %s capture before model failure", async channel => {
    const { llm } = createTurnJudgeLlm(); llm.completeJson = async () => { throw new Error("offline"); };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const request = { source: "codex", channel, sourceTurn: { source: "codex", profileId: "default", conversationId: "native", turnId: "native-turn",
      startedAt: "2099-01-01T00:00:00Z", completedAt: "2099-01-01T00:01:00Z", completionEvidence: "task_complete" }, query: "Source input", answer: "Source output" };
    const captured = await service.completeSourceTurn(request);
    expect(captured.result?.rawTurnId).toBeTruthy();
    await service.runWorkerOnce(30);
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT count(*) AS n FROM source_turn_captures").get()).toEqual({ n: 1 });
    expect((await service.completeSourceTurn(request)).status).toBe("existing");
  });

  it.each(["observe", "compact", "subagentStart", "subagentComplete"])("saves %s without waiting for a model", async kind => {
    const { llm } = createTurnJudgeLlm(); llm.completeJson = async () => { throw new Error("offline"); };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    if (kind === "observe") await service.observeTool({ sessionId, turnId: "observed", toolName: "read", toolCallId: "call", args: { path: "file" }, result: "Original tool output" });
    if (kind === "compact") await service.compactSession(sessionId, { summary: "Original compaction", createL1: true });
    if (kind === "subagentStart") await service.subagentStart({ sessionId, subagentId: "child", task: "Original task" });
    if (kind === "subagentComplete") await service.subagentComplete({ sessionId, subagentId: "child", summary: "Original result", status: "succeeded" });
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE job_type='episode_assignment'").get()).toEqual({ n: 1 });
    await service.runWorkerOnce(30);
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
  });

  it("keeps the production default enabled", () => expect(DEFAULT_MEMMY_CONFIG.algorithm.session.turnJudge).toBe(true));
  it("executes the joint judgment with the unmodified production default", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const { service, db } = fixture.createTestService({ llm, config: DEFAULT_MEMMY_CONFIG });
    const { sessionId } = service.openSession({});
    const saved = await service.completeTurn("default-on", { sessionId, query: "Verify default judgment", answer: "Default verified" });
    await drain(service);
    expect(judgeCalls).toHaveLength(1);
    const raw = new Repositories(db.db).runtime.getRawTurn(saved.rawTurnId)!;
    expect(raw.messagePayload?.episode_assignment).toMatchObject({ turnJudge: true, status: "assigned" });
    expect(db.db.prepare("SELECT state FROM memory_processing_state WHERE memory_id=?").get(saved.l1MemoryId)).toEqual({ state: "ready" });
  });
  it("converts legacy request data once after Session close, preserving its accepted timestamp", async () => {
    const { llm } = createTurnJudgeLlm(); const config = turnJudgeConfig();
    const { service, db } = fixture.createTestService({ llm, config });
    const { sessionId } = service.openSession({});
    const acceptedAt = "2026-01-01T00:00:00.000Z";
    db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,session_id,payload_json,attempts,max_attempts,created_at,updated_at)
      VALUES('legacy','capture_replay','dead_letter','local-user',?,?,3,3,?,?)`).run(sessionId,
      JSON.stringify({ command: { operation: "completeTurn", args: ["old", { sessionId, query: "Old input", answer: "Old answer" }] } }), acceptedAt, acceptedAt);
    service.closeSession(sessionId);
    const restored = fixture.createTestMemoryService({ db: new MemoryDb({ path: db.path }), llm, config });
    expect(db.db.prepare("SELECT user_text,created_at FROM raw_turns WHERE turn_id='old'").get()).toEqual({ user_text: "Old input", created_at: acceptedAt });
    expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE job_type='capture_replay'").get()).toEqual({ n: 0 });
    await drain(restored);
    expect(db.db.prepare("SELECT episode_id FROM raw_turns WHERE turn_id='old'").get()).toMatchObject({ episode_id: expect.any(String) });
    expect(new Repositories(db.db).runtime.getSession(sessionId)?.status).toBe("closed");
  });

  it.each([false, true])("export/import cannot restore excluded raw text (includeRawText=%s)", async includeRawText => {
    const { llm } = createTurnJudgeLlm(); const config = turnJudgeConfig();
    const { service, db } = fixture.createTestService({ llm, config });
    const { sessionId } = service.openSession({});
    const result = await service.completeTurn("exported", { sessionId, query: "Original private input", answer: "Original private answer" });
    const tables = new Repositories(db.db).runtime.exportBundleTables(includeRawText);
    const imported = fixture.createTestService({ llm, config });
    new Repositories(imported.db.db).runtime.importBundleTables(tables);
    await drain(imported.service);
    expect(imported.db.db.prepare("SELECT user_text,assistant_text FROM raw_turns WHERE id=?").get(result.rawTurnId))
      .toEqual({ user_text: includeRawText ? "Original private input" : null, assistant_text: includeRawText ? "Original private answer" : null });
    for (const row of tables.evolution_jobs ?? []) expect(String(row.payload_json)).not.toContain("Original private");
  });

  it("restarts interrupted processing without reaccepting or changing original time", async () => {
    const { llm } = createTurnJudgeLlm(); const config = turnJudgeConfig();
    const { service, db } = fixture.createTestService({ llm, config });
    const { sessionId } = service.openSession({});
    const result = await service.completeTurn("interrupted", { sessionId, query: "Saved before crash", answer: "Original reply" });
    const before = db.db.prepare("SELECT id,created_at,user_text,assistant_text FROM raw_turns").get();
    const repos = new Repositories(db.db);
    const leases = repos.runtime.leaseQueuedJobs(30, 60);
    expect(leases.some(j => j.jobType === "episode_assignment")).toBe(true);
    db.db.prepare("UPDATE evolution_jobs SET leased_until=? WHERE status='leased'").run(new Date(Date.now() - 1).toISOString());
    const restored = fixture.createTestMemoryService({ db: new MemoryDb({ path: db.path }), llm, config });
    restored.reconcileWorkerStartup(); await drain(restored);
    expect(db.db.prepare("SELECT id,created_at,user_text,assistant_text FROM raw_turns").get()).toEqual(before);
    expect(repos.runtime.getRawTurn(result.rawTurnId)?.episodeId).toBeTruthy();
  });

  it("assigns a raw turn even when the model rejects L1", async () => {
    const { llm } = createTurnJudgeLlm({ "No L1": [{ relation: null, feedback: null, reason: "No reusable information", l1: null, user: null }] });
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const result = await service.completeTurn("rejected", { sessionId, query: "No L1 please", answer: "Okay" });
    await drain(service);
    const repos = new Repositories(db.db);
    expect(repos.runtime.getRawTurn(result.rawTurnId)?.episodeId).toBeTruthy();
    expect(repos.memories.getIncludingDeleted(result.l1MemoryId)?.status).toBe("deleted");
    expect(repos.runtime.listEpisodesForSession(sessionId)).toHaveLength(1);
  });

  it("upgrades a v9 database without changing raw IDs, row order or foreign keys", async () => {
    const { llm } = createTurnJudgeLlm();
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    llm.isConfigured = () => false;
    const { sessionId } = service.openSession({});
    const old = await service.completeTurn("old-schema", { sessionId, query: "Existing original", answer: "Existing answer" });
    db.db.prepare("UPDATE raw_turns SET rowid=77 WHERE id=?").run(old.rawTurnId);
    db.db.pragma("foreign_keys=OFF");
    for (const table of ["raw_turns", "skill_trials"]) {
      const sql = (db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
      db.db.exec(sql.replace(table, `${table}_v9`).replace(/episode_id TEXT(?! NOT NULL)/, "episode_id TEXT NOT NULL"));
      db.db.exec(`INSERT INTO ${table}_v9(rowid, ${ (db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name).join(",") }) SELECT rowid, * FROM ${table}`);
      db.db.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_v9 RENAME TO ${table}`);
    }
    db.db.exec("DELETE FROM schema_migrations; INSERT INTO schema_migrations(id,version,applied_at,checksum) VALUES('009_token_usage_outbox',9,'2026-01-01','old')");
    const upgraded = new MemoryDb({ path: db.path });
    expect(upgraded.schemaVersion().version).toBe(SCHEMA_VERSION);
    expect(upgraded.db.prepare("SELECT rowid,id,user_text FROM raw_turns").get()).toEqual({ rowid: 77, id: old.rawTurnId, user_text: "Existing original" });
    expect(upgraded.db.pragma("foreign_key_check")).toEqual([]);
    for (const table of ["raw_turns", "skill_trials"]) expect((upgraded.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>).find(c => c.name === "episode_id")?.notnull).toBe(0);
    llm.isConfigured = () => true;
    const restored = fixture.createTestMemoryService({ db: upgraded, llm, config: turnJudgeConfig() });
    const current = await restored.completeTurn("new-schema", { sessionId, query: "New original", answer: "New answer" });
    expect(new Repositories(upgraded.db).runtime.getRawTurn(current.rawTurnId)?.episodeId).toBeUndefined();
    await drain(restored);
    expect(new Repositories(upgraded.db).runtime.getRawTurn(current.rawTurnId)?.episodeId).toBeTruthy();
  });

  it("keeps a successful Episode decision when turnJudge fails, then retries only judgment", async () => {
    const { llm } = createTurnJudgeLlm();
    const original = llm.completeJson; let fail = true; let selections = 0;
    llm.completeJson = async (messages, options) => {
      if (options.operation === "episode.select.v1") selections++;
      if (fail && options.operation === "capture.summarize") throw new Error("quota exhausted");
      return original(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const saved = await service.completeTurn("judge-failure", { sessionId, query: "Original task", answer: "Original result" });
    await drain(service);
    expect(db.db.prepare("SELECT user_text FROM raw_turns WHERE id=?").get(saved.rawTurnId)).toEqual({ user_text: "Original task" });
    expect(selections).toBe(1);
    expect(new Repositories(db.db).runtime.getRawTurn(saved.rawTurnId)?.messagePayload?.turn_judge).toMatchObject({ status: "failed" });
    fail = false; service.retryMemoryProcessing(saved.l1MemoryId); await drain(service);
    expect(selections).toBe(1);
    expect(new Repositories(db.db).runtime.getRawTurn(saved.rawTurnId)?.episodeId).toBeTruthy();
  });

  it("does not resurrect a deleted turn when its in-flight Episode call returns", async () => {
    const { llm } = createTurnJudgeLlm(); const original = llm.completeJson;
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
    llm.completeJson = async (messages, options) => {
      if (options.operation === "episode.select.v1") { started(); await barrier; }
      return original(messages, options);
    };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const saved = await service.completeTurn("deleted", { sessionId, query: "Delete this", answer: "Private answer" });
    const running = service.runWorkerOnce(30); await waiting;
    db.db.prepare("UPDATE raw_turns SET deleted_at=?,user_text=NULL,assistant_text=NULL WHERE id=?").run(new Date().toISOString(), saved.rawTurnId);
    release(); await running; await drain(service);
    expect(new Repositories(db.db).runtime.getRawTurn(saved.rawTurnId)?.episodeId).toBeUndefined();
    expect(new Repositories(db.db).runtime.listEpisodesForSession(sessionId)).toHaveLength(0);
  });

  it("finishes observed input and the completed turn under one raw ID", async () => {
    const { llm } = createTurnJudgeLlm(); const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const { sessionId } = service.openSession({});
    const observed = await service.observeTool({ sessionId, turnId: "same-turn", toolName: "shell", result: "Tool evidence" });
    await drain(service);
    const completed = await service.completeTurn("same-turn", { sessionId, query: "Original question", answer: "Original answer" });
    expect(completed.rawTurnId).toBe(observed.rawTurnId);
    await drain(service);
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
    expect(new Repositories(db.db).runtime.getRawTurn(completed.rawTurnId)?.episodeId).toBeTruthy();
  });

  it("recovers a Skill observation without requiring an Episode and without duplicate trials", async () => {
    const { llm } = createTurnJudgeLlm(); const original = llm.completeJson;
    llm.completeJson = async () => { throw new Error("network unavailable"); };
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() });
    const namespace = { userId: "skill-failure", source: "codex", profileId: "default" };
    const { sessionId } = service.openSession({ namespace });
    insertActiveSkillMemoryForTest(db, { id: "skill_failure", userId: namespace.userId, sessionId, agentId: namespace.source, profileId: namespace.profileId });
    const request = { sessionId, namespace, adapterId: "test", requestId: "same-skill-use" };
    const first = await service.useSkill("skill_failure", request);
    await drain(service);
    expect(db.db.prepare("SELECT episode_id FROM skill_trials").get()).toEqual({ episode_id: null });
    llm.completeJson = original; service.reconcileWorkerStartup(); await drain(service);
    expect((await service.useSkill("skill_failure", request)).trialId).toBe(first.trialId);
    const row = db.db.prepare("SELECT episode_id,raw_turn_id FROM skill_trials").get() as { episode_id: string; raw_turn_id: string };
    expect(row.episode_id).toBeTruthy();
    expect(new Repositories(db.db).runtime.getEpisode(row.episode_id)?.skillMemoryIds).toContain("skill_failure");
    expect(db.db.prepare("SELECT count(*) AS n FROM skill_trials").get()).toEqual({ n: 1 });
  });

  it("retains pending tool failures and applies their repair once after assignment", async () => {
    const { llm } = createTurnJudgeLlm(); const original = llm.completeJson;
    llm.completeJson = async () => { throw new Error("network unavailable"); };
    const config = turnJudgeConfig(); config.algorithm.feedback = { ...config.algorithm.feedback, failureThreshold: 2, valueDelta: 0, cooldownMs: 0 };
    const { service, db } = fixture.createTestService({ llm, config }); const { sessionId } = service.openSession({});
    for (const turnId of ["failure-1", "failure-2"]) await service.observeTool({ sessionId, turnId, toolName: "shell", error: "Original tool failure" });
    await drain(service); expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 2 });
    llm.completeJson = original; service.reconcileWorkerStartup(); await drain(service);
    expect(db.db.prepare("SELECT count(*) AS n FROM decision_repairs").get()).toEqual({ n: 1 });
    service.reconcileWorkerStartup(); await drain(service);
    expect(db.db.prepare("SELECT count(*) AS n FROM decision_repairs").get()).toEqual({ n: 1 });
  });

  it("does not reopen a historical closed task when a delayed turn is assigned", async () => {
    const { llm } = createTurnJudgeLlm({ "B task": [{ relation: "new_task", feedback: "neutral", reason: "new task", l1: null, user: null }] });
    const { service, db } = fixture.createTestService({ llm, config: turnJudgeConfig() }); const { sessionId } = service.openSession({});
    const first = await service.completeTurn("a", { sessionId, query: "A task", answer: "A result" });
    db.db.prepare("UPDATE raw_turns SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(first.rawTurnId); await drain(service);
    const second = await service.completeTurn("b", { sessionId, query: "B task", answer: "B result" });
    db.db.prepare("UPDATE raw_turns SET created_at='2020-01-03T00:00:00Z' WHERE id=?").run(second.rawTurnId); await drain(service);
    const repos = new Repositories(db.db); const oldId = repos.runtime.getRawTurn(first.rawTurnId)!.episodeId!;
    expect(repos.runtime.getEpisode(oldId)?.status).toBe("closed");
    const delayed = await service.completeTurn("late", { sessionId, query: "A continuation", answer: "Historical result" });
    db.db.prepare("UPDATE raw_turns SET created_at='2020-01-02T00:00:00Z' WHERE id=?").run(delayed.rawTurnId); await drain(service);
    expect(repos.runtime.getRawTurn(delayed.rawTurnId)?.episodeId).toBe(oldId);
    expect(repos.runtime.getEpisode(oldId)?.status).toBe("closed");
    expect(repos.runtime.listEpisodesForSession(sessionId)).toHaveLength(2);
  });

});
