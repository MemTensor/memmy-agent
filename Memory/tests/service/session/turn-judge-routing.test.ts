import { assignedEpisodeId } from "../../fixtures/memory-service-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { heuristicHumanScore } from "../../../src/algorithm/plugin-algorithms.js";
import { representativeEpisodeFeedback } from "../../../src/service/evolution/turn-judge.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import {
  captureJob,
  createTurnJudgeLlm,
  l1For,
  memoryProperties,
  openSession,
  rawTurnPayload,
  turnJudgeConfig,
  type JudgeAnswer
} from "./turn-judge-llm.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(() => { vi.useRealTimers(); cleanup(); });

type Db = ReturnType<typeof createTestService>["db"];

function judged(relation: string | null, feedback: string | null, l1: Record<string, unknown> | null = null): JudgeAnswer {
  return { relation, feedback, reason: `${relation}/${feedback}`, l1, user: null };
}

function captureL3Evidence(llm: ReturnType<typeof createTurnJudgeLlm>["llm"]) {
  const inputs: Array<{ raw_turns: Array<{ raw_turn_id: string; feedback: Array<{ polarity: string }> }> }> = [];
  const complete = llm.complete;
  llm.complete = async (messages, options) => {
    if (options.operation.startsWith("l3_world_model.")) {
      inputs.push(JSON.parse(messages.at(-1)!.content));
      return JSON.stringify({ op: "noop", value: "" });
    }
    return complete(messages, options);
  };
  return inputs;
}

function episodeOf(db: Db, rawTurnId: string): string {
  return (db.db.prepare("SELECT episode_id FROM raw_turns WHERE id = ?").get(rawTurnId) as { episode_id: string }).episode_id;
}

function episodeRow(db: Db, episodeId: string): { status: string; meta: Record<string, any>; rawTurnIds: string[]; l1MemoryIds: string[]; feedbackIds: string[] } {
  const row = db.db.prepare(
    "SELECT status, meta_json, raw_turn_ids_json, l1_memory_ids_json, feedback_ids_json FROM episodes WHERE id = ?"
  ).get(episodeId) as { status: string; meta_json: string; raw_turn_ids_json: string; l1_memory_ids_json: string; feedback_ids_json: string };
  return {
    status: row.status,
    meta: JSON.parse(row.meta_json),
    rawTurnIds: JSON.parse(row.raw_turn_ids_json),
    l1MemoryIds: JSON.parse(row.l1_memory_ids_json),
    feedbackIds: JSON.parse(row.feedback_ids_json)
  };
}

function feedbackRows(db: Db, sessionId: string): Array<Record<string, any>> {
  return (db.db.prepare(
    "SELECT * FROM feedback WHERE session_id = ? ORDER BY created_at, rowid"
  ).all(sessionId) as Array<Record<string, any>>).map((row) => ({ ...row, raw_payload: JSON.parse(row.raw_payload_json) }));
}

function jobsOf(db: Db, jobType: string, episodeId?: string): Array<Record<string, any>> {
  return db.db.prepare(
    `SELECT * FROM evolution_jobs WHERE job_type = ? ${episodeId ? "AND episode_id = ?" : ""} ORDER BY created_at`
  ).all(...(episodeId ? [jobType, episodeId] : [jobType])) as Array<Record<string, any>>;
}

async function settle(service: ReturnType<typeof createTestService>["service"], rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await service.runWorkerOnce(30);
}

describe("turn.judge.v1 routing (switch on)", () => {
  it("does not call a model at the start of a turn and reports the relation as pending", async () => {
    const { llm, judgeCalls, otherCalls } = createTurnJudgeLlm();
    const { service } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-start");
    (await service.completeTurn("t1", { sessionId: session.sessionId, query: "写部署脚本", answer: "好的。" }));
    await settle(service);
    const judgedBeforeStart = judgeCalls.length;
    const started = await service.startTurn({ turnId: "t2", sessionId: session.sessionId, query: "接下来加回滚" });

    expect(started.status).toContain("relation:pending:proposed");
    expect(otherCalls.some((call) => call.options.operation.startsWith("relation."))).toBe(false);
    expect(judgeCalls).toHaveLength(judgedBeforeStart);
  });

  it("keeps a follow_up in the task and writes a neutral reaction pointing at the previous turn", async () => {
    const { llm } = createTurnJudgeLlm({ "第二轮": [judged("follow_up", "neutral", l1For("第二轮：加回滚"))] });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-follow-up");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "第一轮：写部署脚本", answer: "脚本如下。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "第二轮：加回滚", answer: "已加。" }));
    await settle(service);

    expect(episodeOf(db, second.rawTurnId)).toBe(assignedEpisodeId(service, first));
    const [feedback] = feedbackRows(db, session.sessionId);
    expect(feedback).toMatchObject({
      episode_id: assignedEpisodeId(service, first),
      raw_turn_id: first.rawTurnId,
      l1_memory_id: first.l1MemoryId,
      channel: "explicit",
      polarity: "neutral",
      magnitude: 0,
      rationale: "第二轮：加回滚"
    });
    expect(feedback!.raw_payload).toMatchObject({ source: "turn_judge", promptVersion: "turn.judge.v1", sourceRawTurnId: second.rawTurnId });
    expect(jobsOf(db, "decision_repair")).toHaveLength(0);
    expect(service.getMemory(assignedEpisodeId(service, first)).refs).toMatchObject({ feedbackCounts: { positive: 0, negative: 0, neutral: 1 } });
    expect(service.serviceMetrics().feedback).toMatchObject({ recent: 1, positive: 0, negative: 0, neutral: 1 });
    const relation = rawTurnPayload(db, second.rawTurnId).turn_start.routeProposal.relationDecision;
    expect(relation).toEqual({ relation: "follow_up", reason: "follow_up/neutral", signals: ["llm", "turn.judge.v1"] });
  });

  it.each(["positive", "negative"])("closes new_task and freezes its %s feedback in L3 evidence", async (polarity) => {
    const { llm } = createTurnJudgeLlm({ "第二轮": [judged("new_task", polarity, l1For("第二轮：换个事，写求职信"))] });
    const l3Evidence = captureL3Evidence(llm);
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      namespace: { source: "codex", profileId: "default", userId: "route-new-task", sessionKey: "route-new-task-session" }
    });
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "第一轮：订高铁", answer: "订了 8 点的。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "第二轮：换个事，写求职信", answer: "初稿如下。" }));
    expect(second.episodeId).toBeUndefined();
    await settle(service);

    const moved = episodeOf(db, second.rawTurnId);
    expect(moved).not.toBe(assignedEpisodeId(service, first));
    const oldTask = episodeRow(db, assignedEpisodeId(service, first));
    const newTask = episodeRow(db, moved);
    expect(oldTask).toMatchObject({ status: "closed", rawTurnIds: [first.rawTurnId], l1MemoryIds: [first.l1MemoryId] });
    expect(oldTask.meta).toMatchObject({ closeReason: "topic_boundary", relation: "new_task" });
    expect(newTask).toMatchObject({ status: "open", rawTurnIds: [second.rawTurnId], l1MemoryIds: [second.l1MemoryId] });
    expect(newTask.meta).toMatchObject({ relation: "new_task", previousEpisodeId: assignedEpisodeId(service, first) });
    const l1 = memoryProperties(db, second.l1MemoryId);
    expect(l1.info.episode_id).toBe(moved);
    expect(l1.internal_info.trace.episode_id).toBe(moved);
    expect(l1.internal_info.trace.key.startsWith(`${session.sessionId}:`)).toBe(true);

    const l3Inputs = db.db.prepare("SELECT raw_turn_id, episode_id FROM l3_world_model_input_traces WHERE session_id = ? ORDER BY trace_seq")
      .all(session.sessionId) as Array<{ raw_turn_id: string; episode_id: string }>;
    expect(l3Inputs).toEqual([
      { raw_turn_id: first.rawTurnId, episode_id: assignedEpisodeId(service, first) },
      { raw_turn_id: second.rawTurnId, episode_id: moved }
    ]);
    // L3 freezes through the old task's last trace only, not the moved turn.
    const batches = db.db.prepare("SELECT trigger, raw_turn_ids_json FROM l3_world_model_evidence_batches WHERE session_id = ?")
      .all(session.sessionId) as Array<{ trigger: string; raw_turn_ids_json: string }>;
    expect(batches.map((batch) => [batch.trigger, JSON.parse(batch.raw_turn_ids_json)])).toEqual([["new_task", [first.rawTurnId]]]);
    const unfinished = db.db.prepare(
      "SELECT episode_id FROM evolution_jobs WHERE target_memory_id = ? AND status IN ('queued', 'leased', 'failed')"
    ).all(second.l1MemoryId) as Array<{ episode_id: string }>;
    expect(unfinished.every((job) => job.episode_id === moved)).toBe(true);
    const idleClose = db.db.prepare("SELECT episode_id, payload_json FROM evolution_jobs WHERE dedupe_key = ?")
      .get(`episode_idle_close:${second.rawTurnId}`) as { episode_id: string; payload_json: string } | undefined;
    if (idleClose && JSON.parse(idleClose.payload_json).triggerEpisodeId !== undefined) {
      expect(JSON.parse(idleClose.payload_json).triggerEpisodeId === moved || idleClose.episode_id === moved).toBe(true);
    }

    const [feedback] = feedbackRows(db, session.sessionId);
    expect(feedback).toMatchObject({ episode_id: assignedEpisodeId(service, first), raw_turn_id: first.rawTurnId, polarity, magnitude: 1 });
    expect(oldTask.feedbackIds).toEqual([feedback!.id]);
    const evidence = db.db.prepare("SELECT feedback_ids_json FROM l3_world_model_evidence_batches WHERE session_id = ?")
      .all(session.sessionId) as Array<{ feedback_ids_json: string }>;
    expect(evidence.flatMap(row => JSON.parse(row.feedback_ids_json))).toEqual([feedback!.id]);
    expect(l3Evidence.flatMap(input => input.raw_turns).find(turn => turn.raw_turn_id === first.rawTurnId)?.feedback)
      .toEqual([expect.objectContaining({ polarity })]);
    await settle(service);
    const after = db.db.prepare("SELECT feedback_ids_json FROM l3_world_model_evidence_batches WHERE session_id = ?")
      .all(session.sessionId) as Array<{ feedback_ids_json: string }>;
    expect(after.flatMap(row => JSON.parse(row.feedback_ids_json)).filter(id => id === feedback!.id)).toHaveLength(1);
    expect(jobsOf(db, "decision_repair", assignedEpisodeId(service, first))).toHaveLength(polarity === "negative" ? 1 : 0);
    // The old task's closing work runs once its turns are settled.
    expect(jobsOf(db, "reward", assignedEpisodeId(service, first)).length + jobsOf(db, "reflection", assignedEpisodeId(service, first)).length).toBeGreaterThan(0);
  });

  it.each(["positive", "negative"])("preserves %s feedback with backlog and a reopened historical Episode", async polarity => {
    const { llm } = createTurnJudgeLlm({
      "B task": [judged("new_task", polarity, l1For("B task"))],
      "C task": [judged("follow_up", "positive", l1For("C task"))]
    });
    const l3Evidence = captureL3Evidence(llm);
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = service.openSession({ l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
      namespace: { source: "codex", profileId: "default", userId: "reopen-backlog", sessionKey: "reopen-backlog" } });
    const historical = await service.completeTurn("historical", { sessionId: session.sessionId, query: "Historical task", answer: "Historical output" });
    await settle(service);
    const repos = new Repositories(db.db);
    repos.runtime.closeEpisode(assignedEpisodeId(service, historical), { closeReason: "idle_timeout" });
    const first = await service.completeTurn("a", { sessionId: session.sessionId, query: "A task", answer: "A done" });
    await settle(service);
    // Selection reopens a historical task during B's routing. C was already
    // captured provisionally in A and must subsequently follow B.
    const completeJson = llm.completeJson;
    llm.completeJson = async (messages, options) => {
      if (options.operation === "episode.select.v1") return { episodeId: assignedEpisodeId(service, historical), title: "A reopened", summary: "Historical task" } as any;
      return completeJson(messages, options);
    };
    const second = await service.completeTurn("b", { sessionId: session.sessionId, query: "B task", answer: "B done" });
    const third = await service.completeTurn("c", { sessionId: session.sessionId, query: "C task", answer: "C done" });
    await settle(service, 10);
    expect(repos.runtime.getEpisode(assignedEpisodeId(service, historical))?.meta.reopenReason).toBe("episode_selection");
    const feedback = feedbackRows(db, session.sessionId).find(row => row.raw_turn_id === first.rawTurnId)!;
    expect(feedback.polarity).toBe(polarity);
    const batches = db.db.prepare("SELECT feedback_ids_json FROM l3_world_model_evidence_batches WHERE session_id=?").all(session.sessionId) as Array<{ feedback_ids_json: string }>;
    expect(batches.flatMap(row => JSON.parse(row.feedback_ids_json)).filter(id => id === feedback.id)).toHaveLength(1);
    expect(l3Evidence.flatMap(input => input.raw_turns).find(turn => turn.raw_turn_id === first.rawTurnId)?.feedback)
      .toEqual([expect.objectContaining({ polarity })]);
    expect(episodeOf(db, second.rawTurnId)).toBe(assignedEpisodeId(service, historical));
    expect(episodeOf(db, third.rawTurnId)).toBe(assignedEpisodeId(service, historical));
    expect(rawTurnPayload(db, second.rawTurnId).turn_judge.status).toBe("judged");
    expect(rawTurnPayload(db, third.rawTurnId).turn_judge.status).toBe("judged");
  });

  it("judges turns of one session in order and files a later turn by the earlier turn's result", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm({
      "第二轮": [judged("new_task", "neutral", l1For("第二轮：开新任务"))],
      "第三轮": [judged("follow_up", "positive", l1For("第三轮：接着新任务"))]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-backlog");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "第一轮：旧任务", answer: "好。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "第二轮：开新任务", answer: "好。" }));
    const third = (await service.completeTurn("t3", { sessionId: session.sessionId, query: "第三轮：接着新任务", answer: "好。" }));
    expect(third.episodeId).toBeUndefined();
    await settle(service);

    expect(judgeCalls.map((call) => call.user.slice(0, 3))).toEqual(["第一轮", "第二轮", "第三轮"]);
    const newTask = episodeOf(db, second.rawTurnId);
    expect(episodeOf(db, third.rawTurnId)).toBe(newTask);
    expect(episodeRow(db, assignedEpisodeId(service, first)).rawTurnIds).toEqual([first.rawTurnId]);
    expect(episodeRow(db, newTask).rawTurnIds).toEqual([second.rawTurnId, third.rawTurnId]);
    const thirdInput = judgeCalls[2]!.messages.at(-1)!.content;
    expect(thirdInput).toContain("<first_user_message>第二轮：开新任务</first_user_message>");
    const positive = feedbackRows(db, session.sessionId).find((row) => row.polarity === "positive");
    expect(positive).toMatchObject({ episode_id: newTask, raw_turn_id: second.rawTurnId });
  });

  it("closes the task on end_topic and files the next turn in a new task", async () => {
    const { llm } = createTurnJudgeLlm({ "今天就到这": [judged("end_topic", "positive", null)] });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-end-topic");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "写周报", answer: "好。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "今天就到这吧，谢谢", answer: "不客气。" }));
    await settle(service);

    expect(episodeOf(db, second.rawTurnId)).toBe(assignedEpisodeId(service, first));
    expect(episodeRow(db, assignedEpisodeId(service, first))).toMatchObject({ status: "closed" });
    expect(episodeRow(db, assignedEpisodeId(service, first)).meta).toMatchObject({ closeReason: "end_topic", endTopicTurnId: "t2" });
    const third = (await service.completeTurn("t3", { sessionId: session.sessionId, query: "新的问题", answer: "好。" }));
    await settle(service);
    expect(assignedEpisodeId(service, third)).not.toBe(assignedEpisodeId(service, first));
  });

  it("sends an explicit end command through the model instead of the old rule", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm({ "结束会话": [judged("end_topic", "neutral", null)] });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-end-command");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "写周报", answer: "好。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "结束会话", answer: "好的。" }));
    expect(second.closedEpisodeIds).toEqual([]);
    await settle(service);

    expect(judgeCalls.some((call) => call.user === "结束会话")).toBe(true);
    expect(episodeRow(db, assignedEpisodeId(service, first)).meta).toMatchObject({ closeReason: "end_topic", endTopicTurnId: "t2" });
  });

  it("starts a new task by rule when the previous turn's task is closed", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-after-closed");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "第一轮：写脚本", answer: "好。" }));
    await settle(service);
    db.db.prepare(`UPDATE episodes SET status = 'closed', meta_json = json_set(meta_json, '$.closeReason', 'idle_timeout') WHERE id = ?`)
      .run(assignedEpisodeId(service, first));
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "第二轮：接着做", answer: "好。" }));
    expect(second.episodeId).toBeUndefined();
    await settle(service);
    expect(assignedEpisodeId(service, second)).not.toBe(assignedEpisodeId(service, first));

    expect(judgeCalls.find((call) => call.user.startsWith("第二轮"))!.messages.at(-1)!.content)
      .toContain("<first_user_message></first_user_message>");
    expect(episodeOf(db, second.rawTurnId)).toBe(assignedEpisodeId(service, second));
    expect(episodeRow(db, assignedEpisodeId(service, first)).status).toBe("closed");
    expect(episodeRow(db, assignedEpisodeId(service, second)).meta).toMatchObject({ relation: "new_task", previousEpisodeId: assignedEpisodeId(service, first) });
    expect(rawTurnPayload(db, second.rawTurnId).turn_judge.route).toMatchObject({ action: "selected_before_capture" });
    expect(feedbackRows(db, session.sessionId)).toHaveLength(0);
  });

  it("moves a turn out of the task its previous turn ended", async () => {
    const { llm } = createTurnJudgeLlm({ "今天就到这": [judged("end_topic", "positive", null)] });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-after-end-topic");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "写周报", answer: "好。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "今天就到这吧，谢谢", answer: "不客气。" }));
    const third = (await service.completeTurn("t3", { sessionId: session.sessionId, query: "新的问题：订机票", answer: "好。" }));
    expect(third.episodeId).toBeUndefined();
    await settle(service);

    expect(episodeRow(db, assignedEpisodeId(service, first))).toMatchObject({ status: "closed", rawTurnIds: [first.rawTurnId, second.rawTurnId] });
    const moved = episodeOf(db, third.rawTurnId);
    expect(moved).not.toBe(assignedEpisodeId(service, first));
    expect(episodeRow(db, moved)).toMatchObject({ status: "open", rawTurnIds: [third.rawTurnId], l1MemoryIds: [third.l1MemoryId] });
    expect(rawTurnPayload(db, third.rawTurnId).turn_judge.route).toMatchObject({
      action: "selected_before_capture",
      episodeId: moved
    });
    // Only the end_topic turn's reaction is recorded; the turn after it has no previous result.
    expect(feedbackRows(db, session.sessionId).map((row) => row.raw_payload.sourceRawTurnId)).toEqual([second.rawTurnId]);
  });

  it("files a turn without L1 by its relation too", async () => {
    const { llm } = createTurnJudgeLlm({ "好的，现在": [judged("new_task", "positive", null)] });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-no-l1");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "规划京都三日游", answer: "行程如下。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "好的，现在聊点别的", answer: "好。" }));
    await settle(service);

    const rejected = memoryProperties(db, second.l1MemoryId);
    expect(rejected.internal_info.capture_decision.status).toBe("rejected");
    expect(episodeOf(db, second.rawTurnId)).not.toBe(assignedEpisodeId(service, first));
    expect(rejected.info.episode_id).toBe(episodeOf(db, second.rawTurnId));
    expect(rejected.internal_info.trace.episode_id).toBe(episodeOf(db, second.rawTurnId));
    expect(episodeRow(db, assignedEpisodeId(service, first)).status).toBe("closed");
    expect(feedbackRows(db, session.sessionId)[0]).toMatchObject({ episode_id: assignedEpisodeId(service, first), polarity: "positive", magnitude: 1 });
  });

  it("records a reaction once per judged turn and without L1 when the previous turn has none", async () => {
    const { llm } = createTurnJudgeLlm({
      "好的": [judged(null, null, null)],
      "下一步": [judged("follow_up", "positive", l1For("下一步：跑测试"))]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-feedback-no-l1");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "好的", answer: "收到。" }));
    await settle(service);
    (await service.completeTurn("t2", { sessionId: session.sessionId, query: "下一步：跑测试", answer: "测试通过。" }));
    await settle(service);

    const rows = feedbackRows(db, session.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ raw_turn_id: first.rawTurnId, l1_memory_id: null, polarity: "positive" });
  });

  it("does not move a turn that arrived after later turns were judged", async () => {
    const { llm } = createTurnJudgeLlm({ "迟到": [judged("new_task", "neutral", l1For("迟到的一轮"))] });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-late");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "第一轮", answer: "好。" }));
    db.db.prepare("UPDATE raw_turns SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", first.rawTurnId);
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "第二轮", answer: "好。" }));
    db.db.prepare("UPDATE raw_turns SET created_at = ? WHERE id = ?").run("2020-01-03T00:00:00.000Z", second.rawTurnId);
    await settle(service);
    // A turn that happened between the two, delivered after both were judged.
    const late = (await service.completeTurn("t-late", { sessionId: session.sessionId, query: "迟到的一轮", answer: "好。" }));
    db.db.prepare("UPDATE raw_turns SET created_at = ? WHERE id = ?").run("2020-01-02T00:00:00.000Z", late.rawTurnId);
    await settle(service);

    expect(episodeOf(db, late.rawTurnId)).toBe(assignedEpisodeId(service, first));
    expect(episodeRow(db, assignedEpisodeId(service, first)).status).toBe("open");
    expect(rawTurnPayload(db, late.rawTurnId).turn_judge.route).toMatchObject({ action: "kept", reason: "later_turn_already_judged" });
    expect(feedbackRows(db, session.sessionId).find((row) => row.raw_payload.sourceRawTurnId === late.rawTurnId))
      .toMatchObject({ raw_turn_id: first.rawTurnId, polarity: "neutral" });
  });

  it("does not send host-generated turns to the model", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-noise");
    (await service.completeTurn("t1", { sessionId: session.sessionId, query: "写周报", answer: "好。" }));
    await settle(service);
    const noise = (await service.completeTurn("t2", {
      sessionId: session.sessionId,
      query: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>",
      answer: "后台任务完成了。"
    }));
    await settle(service);

    expect(captureJob(db, noise.l1MemoryId)).toMatchObject({ turnJudge: true, turnJudgeNoise: "task_notification" });
    expect(judgeCalls.map((call) => call.user)).toEqual(["写周报"]);
    expect(rawTurnPayload(db, noise.rawTurnId).turn_judge).toMatchObject({ status: "skipped", noise_kind: "task_notification" });
    expect(feedbackRows(db, session.sessionId)).toHaveLength(0);
  });

  it("keeps later turns durable while judgment failed, then retries with the same input", async () => {
    const invalid = { relation: "revision", feedback: "neutral", reason: "old label", l1: null, user: null };
    const { llm, judgeCalls } = createTurnJudgeLlm({
      "第二轮": [invalid, invalid, invalid, judged("follow_up", "negative", l1For("第二轮：不对，重做"))]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "route-failed");
    (await service.completeTurn("t1", { sessionId: session.sessionId, query: "第一轮：写脚本", answer: "好。" }));
    await settle(service);
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "第二轮：不对，重做", answer: "好。" }));
    const third = (await service.completeTurn("t3", { sessionId: session.sessionId, query: "第三轮：再加日志", answer: "好。" }));
    await settle(service, 8);

    expect(memoryProperties(db, second.l1MemoryId).internal_info.capture_decision).toMatchObject({ status: "failed", prompt_version: "turn.judge.v1" });
    expect(rawTurnPayload(db, second.rawTurnId).turn_judge.status).toBe("failed");
    expect(memoryProperties(db, third.l1MemoryId).internal_info.capture_decision.status).toBe("pending");
    expect(rawTurnPayload(db, third.rawTurnId).episode_assignment.status).toBe("pending");
    expect(feedbackRows(db, session.sessionId).filter((row) => row.raw_payload.sourceRawTurnId === second.rawTurnId)).toHaveLength(0);

    const retried = service.retryMemoryProcessing(second.l1MemoryId);
    expect(retried.accepted).toBe(true);
    const rebuilt = jobsOf(db, "trace_summary").filter((job) => job.target_memory_id === second.l1MemoryId).at(-1)!;
    expect(JSON.parse(rebuilt.payload_json)).toMatchObject({ turnJudge: true, promptVersion: "turn.judge.v1", decideCapture: true });
    await settle(service);

    const secondCalls = judgeCalls.filter((call) => call.user.startsWith("第二轮"));
    expect(secondCalls).toHaveLength(4);
    expect(secondCalls[3]!.messages).toEqual(secondCalls[0]!.messages);
    expect(memoryProperties(db, second.l1MemoryId).internal_info.capture_decision.status).toBe("accepted");
    expect(memoryProperties(db, third.l1MemoryId).internal_info.capture_decision.status).toBe("accepted");
    expect(feedbackRows(db, session.sessionId).some((row) => row.polarity === "negative")).toBe(true);
  });

  it("keeps the old routing while the switch is off", async () => {
    const { llm, judgeCalls } = createTurnJudgeLlm();
    const { service, db } = createTestService({ llm, config: turnJudgeConfig(false) });
    const session = openSession(service, "route-off");
    const first = (await service.completeTurn("t1", { sessionId: session.sessionId, query: "写周报", answer: "好。" }));
    const second = (await service.completeTurn("t2", { sessionId: session.sessionId, query: "结束会话", answer: "好的。" }));
    await settle(service);

    expect(judgeCalls).toHaveLength(0);
    expect(second.closedEpisodeIds).toEqual([]);
    expect(episodeRow(db, assignedEpisodeId(service, first)).status).toBe("closed");
    expect(rawTurnPayload(db, second.rawTurnId).turn_judge).toBeUndefined();
  });
});

describe("representative feedback for the reward fallback", () => {
  const explicit = (polarity: "positive" | "negative" | "neutral") => ({
    channel: "explicit" as const,
    polarity,
    magnitude: polarity === "neutral" ? 0 : 1
  });

  it.each([
    [["negative", "neutral"], -1],
    [["positive", "neutral"], 1],
    [["positive", "neutral", "negative", "neutral", "neutral"], -1],
    [["neutral", "neutral"], 0]
  ] as const)("%j scores %d", (sequence, expected) => {
    const picked = representativeEpisodeFeedback(sequence.map(explicit));
    expect(heuristicHumanScore(picked ? [picked] : []).rHuman).toBe(expected);
  });

  it("still prefers the latest explicit reaction over a later implicit one", () => {
    const picked = representativeEpisodeFeedback([
      explicit("negative"),
      { channel: "implicit" as const, polarity: "positive" as const, magnitude: 0.8 }
    ]);
    expect(picked?.polarity).toBe("negative");
  });
  it.each([false, true])("serializes equal-time turns through leases and recovery (legacy job payload=%s)", async legacyPayload => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T10:00:00Z"));
    const { llm, judgeCalls } = createTurnJudgeLlm({
      B: [judged("new_task", "negative", l1For("B task"))],
      C: [judged("new_task", "positive", l1For("C task"))]
    });
    const { service, db } = createTestService({ llm, config: turnJudgeConfig() });
    const session = openSession(service, "equal-time");
    const first = await service.completeTurn("a", { sessionId: session.sessionId, query: "A task", answer: "A done" });
    await settle(service);
    const second = await service.completeTurn("b", { sessionId: session.sessionId, query: "B task", answer: "B done" });
    const third = await service.completeTurn("c", { sessionId: session.sessionId, query: "C task", answer: "C done" });
    const repo = new Repositories(db.db);
    expect(repo.runtime.getRawTurn(second.rawTurnId)?.createdAt).toBe(repo.runtime.getRawTurn(third.rawTurnId)?.createdAt);
    if (legacyPayload) {
      db.db.prepare("UPDATE evolution_jobs SET payload_json=json_remove(payload_json, '$.rawTurnId') WHERE job_type='trace_summary'").run();
    }
    // Even a second worker explicitly requesting C cannot overtake leased B.
    const jobs = repo.runtime.leaseQueuedJobs(10, 60, undefined, false, ["trace_summary"]);
    expect(jobs.map(job => job.targetMemoryId)).toEqual([second.l1MemoryId]);
    expect(repo.runtime.leaseQueuedJobs(10, 60, [third.l1MemoryId], false, ["trace_summary"])).toEqual([]);
    repo.runtime.failJob(jobs[0]!.id, "transient model failure");
    expect(repo.runtime.leaseQueuedJobs(10, 60, [third.l1MemoryId], false, ["trace_summary"])).toEqual([]);
    repo.runtime.requeueFailedJobs();
    await settle(service, 8);
    expect(judgeCalls.map(call => call.user)).toEqual(["A task", "B task", "C task"]);
    expect(new Set([first, second, third].map(turn => episodeOf(db, turn.rawTurnId))).size).toBe(3);
    expect(feedbackRows(db, session.sessionId).map(row => row.raw_turn_id)).toEqual([first.rawTurnId, second.rawTurnId]);
  });

});
