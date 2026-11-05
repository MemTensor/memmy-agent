import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { createMemoryServiceFixture, setRawTurnActivityAt, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

function setup(enabled = true) {
  const root = fixture.createTestRoot("ended-task-l3-");
  const home = join(root, "home");
  const project = join(home, "code", "demo");
  mkdirSync(project, { recursive: true });
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.l3FieldCognition.enabled = enabled;
  // Without a model here, a task is ended by the user's explicit command rather than turn.judge.v1.
  config.algorithm.session.turnJudge = false;
  // What a later reloadConfig() reads, to turn the switch without a restart.
  const reload = { config };
  const service = fixture.createTestMemoryService({
    db, mode: "dev", config, configLoader: () => ({ config: reload.config }),
    l3FieldEnvironment: () => ({ machineId: "7".repeat(64), homeDir: home, tempRoots: [] }),
    l3MachineProbe: () => new Promise(() => undefined)
  });
  const open = (key: string) => service.openSession({
    l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
    workspaceUri: pathToFileURL(project).href, workspaceHostId: "c".repeat(64),
    namespace: { source: "codex", profileId: "default", sessionKey: key, userId: "u1" }
  }).sessionId;
  const batches = (sessionId: string) => db.db.prepare(
    `SELECT trigger FROM l3_unit_batches WHERE session_id = ? ORDER BY scope_seq`
  ).all(sessionId).map((row) => (row as { trigger: string }).trigger);
  const legacyBatches = (sessionId: string) => (db.db.prepare(
    `SELECT COUNT(*) AS n FROM l3_world_model_evidence_batches WHERE session_id = ?`
  ).get(sessionId) as { n: number }).n;
  const flush = (sessionId: string) => db.db.prepare(
    `SELECT status, json_extract(payload_json, '$.runAfter') AS run_after FROM evolution_jobs
     WHERE job_type = 'work_memory_idle_flush' AND session_id = ?`
  ).get(sessionId) as { status: string; run_after: string } | undefined;
  /** Turn the new L3 on or off as a config reload does, without restarting the service. */
  const switchTo = (on: boolean) => {
    reload.config = structuredClone(config);
    reload.config.algorithm.l3FieldCognition.enabled = on;
    service.reloadConfig({ restartFailedProcessing: false });
  };
  return { db, service, open, batches, legacyBatches, flush, switchTo };
}

/** A conversation that goes quiet for over two hours, then a turn somewhere else runs the idle sweep. */
async function goIdle(env: ReturnType<typeof setup>) {
  const quiet = env.open("quiet");
  const turn = await env.service.completeTurn("quiet-turn", {
    sessionId: quiet, query: "以后改完都跑 npm test", answer: "好", status: "succeeded"
  });
  await env.service.runWorkerOnce(20);
  setRawTurnActivityAt(env.db, turn.rawTurnId, new Date(Date.now() - 2 * 60 * 60 * 1000 - 5_000).toISOString());
  const other = env.open("other");
  await env.service.startTurn({ turnId: "other-turn", sessionId: other, query: "Start a separate task" });
  await env.service.completeTurn("other-turn", { sessionId: other, query: "Start a separate task", answer: "Started." });
  await env.service.runWorkerOnce(20);
  return quiet;
}

describe("a task that ends without a session close still reaches the new L3", () => {
  it("hands a conversation that went idle to L3 when the idle sweep closes its task", async () => {
    const env = setup();
    const quiet = await goIdle(env);
    expect(env.batches(quiet)).toEqual(["episode_idle_close"]);
  });

  it("hands a task to L3 when the user ends the topic", async () => {
    const env = setup();
    const session = env.open("ended");
    await env.service.completeTurn("work-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(env.service);
    await env.service.completeTurn("end-turn", { sessionId: session, query: "结束会话", answer: "好的。" });
    await settleCaptureAssignments(env.service);
    expect(env.batches(session)).toEqual(["new_task"]);
  });

  it("does not cut into the task in progress when a closed task is finalized again later", async () => {
    const env = setup();
    const session = env.open("ongoing");
    const ended = await env.service.completeTurn("old-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(env.service);
    await env.service.completeTurn("end-turn", { sessionId: session, query: "结束会话", answer: "好的。" });
    await settleCaptureAssignments(env.service);
    await env.service.completeTurn("new-turn", { sessionId: session, query: "Start the next task", answer: "Started." });
    await settleCaptureAssignments(env.service);
    const handlers = (env.service as unknown as { workerHandlers: { finalizeClosedEpisode: (e: unknown, at: string, t: string) => unknown } })
      .workerHandlers;
    const closed = (env.service as unknown as { repos: { runtime: { getEpisode(id: string): unknown } } }).repos.runtime.getEpisode(ended.episodeId!);
    handlers.finalizeClosedEpisode(closed, new Date().toISOString(), "episode_rewarded");
    expect(env.batches(session)).toEqual(["new_task"]);
  });

  it("hands a conversation that just stops, with no close and no later turn, to L3 once it has been quiet", async () => {
    const env = setup();
    const session = env.open("stopped");
    await env.service.completeTurn("stopped-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(env.service);
    expect(env.flush(session)).toMatchObject({ status: "queued" });
    expect(env.batches(session)).toEqual([]);
    // Two hours later with nothing else happening anywhere, the session's own flush comes due.
    const quietSince = new Date(Date.now() - 2 * 60 * 60 * 1000 - 5_000).toISOString();
    env.db.db.prepare(`UPDATE l3_world_model_input_traces SET created_at = ? WHERE session_id = ?`).run(quietSince, session);
    env.db.db.prepare(`UPDATE evolution_jobs SET payload_json = json_set(payload_json, '$.runAfter', ?)
      WHERE job_type = 'work_memory_idle_flush'`).run(quietSince);
    await env.service.runWorkerOnce(50);
    expect(env.batches(session)).toEqual(["session_idle"]);
  });

  it("keeps the flush queued when it comes due before the session has been quiet long enough", async () => {
    const env = setup();
    const session = env.open("early");
    await env.service.completeTurn("early-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(env.service);
    // Due now, but the last turn is recent (as when a turn lands after the flush was leased): it re-arms itself.
    env.db.db.prepare(`UPDATE evolution_jobs SET payload_json = json_set(payload_json, '$.runAfter', ?)
      WHERE job_type = 'work_memory_idle_flush'`).run(new Date(Date.now() - 1_000).toISOString());
    await env.service.runWorkerOnce(50);
    const flush = env.flush(session)!;
    expect(flush.status).toBe("queued");
    expect(Date.parse(flush.run_after)).toBeGreaterThan(Date.now());
    expect(env.batches(session)).toEqual([]);
  });

  it("hands over turns whose flush ran while the switch was off once it is turned on without a restart", async () => {
    const env = setup();
    const session = env.open("toggled");
    await env.service.completeTurn("toggled-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(env.service);
    const quietSince = new Date(Date.now() - 2 * 60 * 60 * 1000 - 5_000).toISOString();
    env.db.db.prepare(`UPDATE l3_world_model_input_traces SET created_at = ? WHERE session_id = ?`).run(quietSince, session);
    env.db.db.prepare(`UPDATE evolution_jobs SET payload_json = json_set(payload_json, '$.runAfter', ?)
      WHERE job_type = 'work_memory_idle_flush'`).run(quietSince);
    env.switchTo(false);
    await env.service.runWorkerOnce(50);
    expect(env.flush(session)!.status).toBe("succeeded");
    expect(env.batches(session)).toEqual([]);
    env.switchTo(true);
    expect(env.flush(session)!.status).toBe("queued");
    await env.service.runWorkerOnce(50);
    expect(env.batches(session)).toEqual(["session_idle"]);
  });

  it("re-freezes imported turns whose unfinished batch an import had to drop for a machine kept here", async () => {
    const source = setup();
    const session = source.open("exported");
    await source.service.completeTurn("exported-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(source.service);
    source.service.closeSession(session);
    expect(source.batches(session)).toEqual(["session_close"]);
    const bundle = source.service.exportBundle({ includeRawText: true });

    const target = setup();
    target.open("local");
    await target.service.completeTurn("local-turn", { sessionId: target.open("local"), query: "看看", answer: "好" });
    await settleCaptureAssignments(target.service);
    expect(target.service.importBundle({ bundle }).ok).toBe(true);
    // The exported batch was dropped with the machine unit kept here; the closed session's turns are
    // frozen afresh into this database's own queue.
    expect(target.batches(session)).toEqual(["session_close"]);
    const job = target.db.db.prepare(
      `SELECT j.status FROM evolution_jobs j JOIN l3_unit_batches b ON b.id = json_extract(j.payload_json, '$.batchId')
       WHERE b.session_id = ?`
    ).get(session) as { status: string };
    expect(job.status).toBe("queued");
    // Importing the same bundle again finds those turns already frozen here and leaves them alone.
    expect(target.service.importBundle({ bundle }).ok).toBe(true);
    expect(target.batches(session)).toEqual(["session_close"]);
  });

  it("re-freezes the turns a replace import adds after what this database already froze", async () => {
    const source = setup();
    const session = source.open("growing");
    await source.service.completeTurn("first-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(source.service);
    const target = setup();
    await target.service.completeTurn("local-turn", { sessionId: target.open("local"), query: "看看", answer: "好" });
    await settleCaptureAssignments(target.service);
    expect(target.service.importBundle({ bundle: source.service.exportBundle({ includeRawText: true }) }).ok).toBe(true);
    const frozen = (sessionId: string) => target.db.db.prepare(
      `SELECT start_trace_seq AS s, end_trace_seq AS e FROM l3_unit_batches WHERE session_id = ? ORDER BY scope_seq`
    ).all(sessionId) as Array<{ s: number; e: number }>;
    // The imported session goes quiet here and its idle flush freezes turn 1.
    (target.service as unknown as { repos: { l3WorldModels: { freezeBatches(input: { sessionId: string; trigger: "session_idle" }): unknown } } })
      .repos.l3WorldModels.freezeBatches({ sessionId: session, trigger: "session_idle" });
    expect(frozen(session)).toEqual([{ s: 1, e: 1 }]);
    // The source goes on: a second turn, then a close freezes [1,2] there; that bundle replaces this one.
    await source.service.completeTurn("second-turn", { sessionId: session, query: "提交信息用中文", answer: "好" });
    await settleCaptureAssignments(source.service);
    source.service.closeSession(session);
    expect(target.service.importBundle({
      bundle: source.service.exportBundle({ includeRawText: true }), conflictStrategy: "replace"
    }).ok).toBe(true);
    expect(frozen(session).at(-1)!.e).toBe(2);
  });

  it("re-freezes a turn a replace import put at a position this database froze with a different turn", async () => {
    const source = setup();
    const session = source.open("forked");
    await source.service.completeTurn("shared-turn", { sessionId: session, query: "以后改完都跑 npm test", answer: "好" });
    await settleCaptureAssignments(source.service);
    const target = setup();
    await target.service.completeTurn("local-turn", { sessionId: target.open("local"), query: "看看", answer: "好" });
    await settleCaptureAssignments(target.service);
    expect(target.service.importBundle({ bundle: source.service.exportBundle({ includeRawText: true }) }).ok).toBe(true);
    // Both databases go on in the same session with a different second turn; this one freezes [1,2] here.
    await target.service.completeTurn("target-turn", { sessionId: session, query: "提交信息用英文", answer: "好" });
    await settleCaptureAssignments(target.service);
    (target.service as unknown as { repos: { l3WorldModels: { freezeBatches(input: { sessionId: string; trigger: "session_idle" }): unknown } } })
      .repos.l3WorldModels.freezeBatches({ sessionId: session, trigger: "session_idle" });
    await source.service.completeTurn("source-turn", { sessionId: session, query: "提交信息用中文", answer: "好" });
    await settleCaptureAssignments(source.service);
    source.service.closeSession(session);
    expect(target.service.importBundle({
      bundle: source.service.exportBundle({ includeRawText: true }), conflictStrategy: "replace"
    }).ok).toBe(true);
    // Trace 2 is now the source's turn: some batch here must have frozen that turn, not just its position.
    const trace = target.db.db.prepare(
      `SELECT l1_memory_id AS id FROM l3_world_model_input_traces WHERE session_id = ? AND trace_seq = 2`
    ).get(session) as { id: string };
    const owners = target.db.db.prepare(
      `SELECT COUNT(*) AS n FROM l3_unit_batches b, json_each(b.l1_memory_ids_json) j
       WHERE b.session_id = ? AND b.start_trace_seq <= 2 AND b.end_trace_seq >= 2 AND j.value = ?`
    ).get(session, trace.id) as { n: number };
    expect(owners.n).toBe(1);
  });

  it("changes nothing with the switch off", async () => {
    const env = setup(false);
    const quiet = await goIdle(env);
    expect(env.batches(quiet)).toEqual([]);
    expect(env.legacyBatches(quiet)).toBe(0);
  });
});
