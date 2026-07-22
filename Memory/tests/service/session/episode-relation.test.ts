import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type LlmClient
} from "../../../src/index.js";
import {
  createMemoryServiceFixture,
  runWorkerRounds
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

function createRelationClassifierLlm(calls: string[]): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/relation-classifier",
      model: "relation-classifier"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      _messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      if (options.operation === "retrieval.retrieval.query.extract.v1") {
        return { queryVecText: "", keywords: [] } as unknown as T;
      }
      calls.push(options.operation);
      if (options.operation === "relation.classify.v1") {
        return {
          relation: "new_task",
          confidence: 0.7,
          reason: "database certificate rotation appears adjacent"
        } as unknown as T;
      }
      return {
        relation: "follow_up",
        reason: "same certificate management task"
      } as unknown as T;
    },
    status() {
      return {
        provider: "host",
        model: "relation-classifier",
        configured: true,
        remote: true
      };
    }
  };
}

function createFollowUpRelationClassifierLlm(calls: string[]): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/follow-up-relation-classifier",
      model: "follow-up-relation-classifier"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      _messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      if (options.operation === "retrieval.retrieval.query.extract.v1") {
        return { queryVecText: "", keywords: [] } as unknown as T;
      }
      calls.push(options.operation);
      if (options.operation === "relation.classify.v1") {
        return {
          relation: "follow_up",
          confidence: 0.8,
          reason: "same user preference and project fact"
        } as unknown as T;
      }
      return {
        relation: "follow_up",
        reason: "same memory task"
      } as unknown as T;
    },
    status() {
      return {
        provider: "host",
        model: "follow-up-relation-classifier",
        configured: true,
        remote: true
      };
    }
  };
}

describe("MemoryService / session / episode relation", () => {
  it("splits a new-task turn into a fresh episode using the plugin relation heuristic", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-relation-split"
      }
    });
    const first = service.completeTurn("turn-relation-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 443, install the certificate, and verify with curl."
    });

    const prepared = await service.startTurn({ turnId: "turn-relation-new-task",
      sessionId: session.sessionId,
      query: "new task: summarize the Q4 hiring plan"
    });
    expect(prepared.episodeId).not.toBe(first.episodeId);
    expect(prepared.closedEpisodeIds).toEqual([first.episodeId]);

    const rows = db.db.prepare(
      `SELECT id, status, meta_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ id: string; status: string; meta_json: string }>;
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((row) => row.id === first.episodeId);
    const preparedRow = rows.find((row) => row.id === prepared.episodeId);
    expect(firstRow).toMatchObject({ id: first.episodeId, status: "closed" });
    expect(JSON.parse(firstRow!.meta_json)).toMatchObject({
      closeReason: "topic_boundary",
      relation: "new_task"
    });
    expect(preparedRow).toMatchObject({ id: prepared.episodeId, status: "open" });
    expect(JSON.parse(preparedRow!.meta_json)).toMatchObject({
      previousEpisodeId: first.episodeId,
      relation: "new_task"
    });

    db.close();
  });

  it("keeps follow-up turns in the same episode", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-relation-follow-up"
      }
    });
    const first = service.completeTurn("turn-relation-follow-up-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 443, install the certificate, and verify with curl."
    });

    const prepared = await service.startTurn({ turnId: "turn-relation-follow-up-next",
      sessionId: session.sessionId,
      query: "那证书自动续期呢"
    });
    expect(prepared.episodeId).toBe(first.episodeId);
    expect(prepared.closedEpisodeIds).toEqual([]);

    const rows = db.db.prepare(
      `SELECT id, status, meta_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ id: string; status: string; meta_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.episodeId, status: "open" });
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({
      relation: "follow_up"
    });

    const completed = service.completeTurn("turn-relation-follow-up-next", {
      sessionId: session.sessionId,
      query: "那证书自动续期呢",
      answer: "Use systemd timers or certbot renewal hooks and verify nginx reloads cleanly."
    });
    expect(completed.episodeId).toBe(prepared.episodeId);

    const afterComplete = db.db.prepare(
      `SELECT id, status, turn_count, raw_turn_ids_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ id: string; status: string; turn_count: number; raw_turn_ids_json: string }>;
    expect(afterComplete).toHaveLength(1);
    expect(afterComplete[0]).toMatchObject({
      id: prepared.episodeId,
      status: "open",
      turn_count: 2
    });
    expect(JSON.parse(afterComplete[0]!.raw_turn_ids_json)).toEqual(expect.arrayContaining([
      first.rawTurnId,
      completed.rawTurnId
    ]));

    const feedbackCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM feedback
       WHERE user_id = 'user-relation-follow-up'`
    ).get() as { count: number };
    expect(feedbackCount.count).toBe(0);

    db.close();
  });

  it("keeps direct turn-complete follow-ups in one episode when only tags differ", () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-direct-complete-follow-up"
      }
    });
    const first = service.completeTurn("turn-direct-follow-up-first", {
      sessionId: session.sessionId,
      query: "修复 TypeScript hook 的 turn lifecycle",
      answer: "问题是 start 和 complete 没有绑定同一个 turnId。"
    });
    const second = service.completeTurn("turn-direct-follow-up-second", {
      sessionId: session.sessionId,
      query: "修改起来麻烦吗？",
      answer: "不麻烦，需要补齐同一轮的状态关联。"
    });

    expect(second.episodeId).toBe(first.episodeId);
    const rows = db.db.prepare(
      `SELECT id, status, turn_count
       FROM episodes
       WHERE session_id = ?`
    ).all(session.sessionId) as Array<{ id: string; status: string; turn_count: number }>;
    expect(rows).toEqual([expect.objectContaining({
      id: first.episodeId,
      status: "open",
      turn_count: 2
    })]);
    db.close();
  });

  it("completes turns in the episode reserved by turn start", async () => {
    const root = createTestRoot("mindock-memory-turn-bind-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const relationCalls: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createFollowUpRelationClassifierLlm(relationCalls)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-turn-bind"
      }
    });
    const first = service.completeTurn("turn-bind-first", {
      sessionId: session.sessionId,
      query: "请记住：我叫林浩，喜欢简洁中文回答。我的项目代号是青竹，部署端口固定为 49231。",
      answer: "已记录：林浩偏好简洁中文回答；项目代号青竹；部署端口 49231。"
    });

    const prepared = await service.startTurn({
      turnId: "turn-bind-second",
      sessionId: session.sessionId,
      query: "青竹项目的部署端口是多少？林浩偏好什么回答风格？"
    });
    expect(prepared.episodeId).toBe(first.episodeId);
    expect(relationCalls).toContain("relation.classify.v1");
    const reserved = db.db.prepare(
      `SELECT id, episode_id, status
       FROM raw_turns
       WHERE session_id = ? AND turn_id = ?`
    ).get(session.sessionId, "turn-bind-second") as { id: string; episode_id: string; status: string };
    expect(reserved).toMatchObject({
      episode_id: prepared.episodeId,
      status: "started"
    });

    const completed = service.completeTurn("turn-bind-second", {
      sessionId: session.sessionId,
      query: "青竹项目的部署端口是多少？林浩偏好什么回答风格？",
      answer: "部署端口是 49231；林浩偏好简洁中文回答。"
    });

    expect(completed.episodeId).toBe(prepared.episodeId);
    expect(completed.rawTurnId).toBe(reserved.id);
    const episodes = db.db.prepare(
      `SELECT id, turn_count, raw_turn_ids_json
       FROM episodes
       WHERE session_id = ?`
    ).all(session.sessionId) as Array<{ id: string; turn_count: number; raw_turn_ids_json: string }>;
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: first.episodeId,
      turn_count: 2
    });
    expect(JSON.parse(episodes[0]!.raw_turn_ids_json)).toEqual(expect.arrayContaining([
      first.rawTurnId,
      completed.rawTurnId
    ]));

    db.close();
  });

  it("keeps referential topic follow-ups in one episode even when only generic trace tags exist", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "openclaw",
        profileId: "jiang",
        userId: "user-relation-book-follow-up"
      }
    });
    const first = service.completeTurn("turn-book-first", {
      sessionId: session.sessionId,
      query: "我上个月读的一本书是百年孤独",
      answer: "记住了：你上个月读的是《百年孤独》。"
    });

    const secondStart = await service.startTurn({
      turnId: "turn-book-second",
      sessionId: session.sessionId,
      query: "有什么其他书和这本书比较相似的吗"
    });
    expect(secondStart.episodeId).toBe(first.episodeId);
    expect(secondStart.closedEpisodeIds).toEqual([]);
    const second = service.completeTurn("turn-book-second", {
      sessionId: session.sessionId,
      query: "有什么其他书和这本书比较相似的吗",
      answer: "可以看《霍乱时期的爱情》和其他家族史诗类作品。"
    });
    expect(second.episodeId).toBe(first.episodeId);

    const thirdStart = await service.startTurn({
      turnId: "turn-book-third",
      sessionId: session.sessionId,
      query: "有什么中国的书和这些书比较相似的吗"
    });
    expect(thirdStart.episodeId).toBe(first.episodeId);
    expect(thirdStart.closedEpisodeIds).toEqual([]);
    const third = service.completeTurn("turn-book-third", {
      sessionId: session.sessionId,
      query: "有什么中国的书和这些书比较相似的吗",
      answer: "可以看《白鹿原》《活着》和《平凡的世界》。"
    });
    expect(third.episodeId).toBe(first.episodeId);

    const episodes = db.db.prepare(
      `SELECT id, status, turn_count, raw_turn_ids_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ id: string; status: string; turn_count: number; raw_turn_ids_json: string }>;
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: first.episodeId,
      status: "open",
      turn_count: 3
    });
    expect(JSON.parse(episodes[0]!.raw_turn_ids_json)).toEqual(expect.arrayContaining([
      first.rawTurnId,
      second.rawTurnId,
      third.rawTurnId
    ]));

    db.close();
  });

  it("uses the configured relation classifier model during turn.start arbitration", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: string[] = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createRelationClassifierLlm(calls)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-relation-llm"
      }
    });
    const first = service.completeTurn("turn-relation-llm-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 443 and verify the certificate chain."
    });

    const prepared = await service.startTurn({ turnId: "turn-relation-llm-next",
      sessionId: session.sessionId,
      query: "Database certificate rotation details please"
    });

    expect(prepared.episodeId).toBe(first.episodeId);
    expect(calls).toEqual(["relation.classify.v1", "relation.arbitration.v1"]);
    const rows = db.db.prepare(
      `SELECT meta_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ meta_json: string }>;
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]!.meta_json) as {
      relationDecision?: { signals?: string[] };
    };
    expect(meta.relationDecision?.signals).toContain("arbitration_override");
    db.close();
  });

  it("turns revision relation messages into structured feedback and reward backprop", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-relation-revision"
      }
    });
    const first = service.completeTurn("turn-relation-revision-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 80 and skip certificate verification."
    });

    const prepared = await service.startTurn({ turnId: "turn-relation-revision-fix",
      sessionId: session.sessionId,
      query: "wrong, use port 443 instead and verify TLS"
    });
    expect(prepared.episodeId).toBe(first.episodeId);

    const feedback = db.db.prepare(
      `SELECT id, l1_memory_id, raw_turn_id, polarity, raw_payload_json
       FROM feedback
       WHERE user_id = 'user-relation-revision'`
    ).get() as {
      id: string;
      l1_memory_id: string | null;
      raw_turn_id: string | null;
      polarity: string;
      raw_payload_json: string;
    };
    expect(feedback.l1_memory_id).toBe(first.l1MemoryId);
    expect(feedback.raw_turn_id).toBe(first.rawTurnId);
    expect(feedback.polarity).toBe("negative");
    expect(JSON.parse(feedback.raw_payload_json)).toMatchObject({
      source: "relation_classifier",
      relation: "revision"
    });

    const episodeFeedback = db.db.prepare(
      `SELECT feedback_ids_json, decision_repair_ids_json
       FROM episodes
       WHERE id = ?`
    ).get(first.episodeId) as {
      feedback_ids_json: string;
      decision_repair_ids_json: string;
    };
    expect(JSON.parse(episodeFeedback.feedback_ids_json)).toContain(feedback.id);

    const repair = db.db.prepare(
      `SELECT id, feedback_id, episode_id
       FROM decision_repairs
       WHERE feedback_id = ?`
    ).get(feedback.id) as { id: string; feedback_id: string; episode_id: string };
    expect(repair).toMatchObject({
      feedback_id: feedback.id,
      episode_id: first.episodeId
    });
    expect(JSON.parse(episodeFeedback.decision_repair_ids_json)).toContain(repair.id);

    const repairChange = db.db.prepare(
      `SELECT kind, op, change_type
       FROM memory_change_log
       WHERE entity_id = ?`
    ).get(repair.id) as { kind: string; op: string; change_type: string };
    expect(repairChange).toMatchObject({
      kind: "repair",
      op: "created",
      change_type: "decision_repair_created"
    });

    await service.runWorkerOnce(50);

    const memory = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(first.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(memory.properties_json) as {
      internal_info: {
        trace: {
          r_human?: number;
          source_feedback_ids?: string[];
        };
      };
    }).internal_info.trace;
    expect(trace.r_human).toBeCloseTo(-1);
    expect(trace.source_feedback_ids).toContain(feedback.id);

    db.close();
  });

  it("records plugin-style implicit turn feedback before opening the next episode", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-implicit-turn-feedback"
      }
    });
    const first = service.completeTurn("turn-implicit-feedback-first", {
      sessionId: session.sessionId,
      query: "Implement tree traversal",
      answer: "Use an iterative loop without recursion."
    });

    const prepared = await service.startTurn({ turnId: "turn-implicit-feedback-correction",
      sessionId: session.sessionId,
      query: "不对，应该用递归实现，这样性能不好。换个任务：实现二叉树层序遍历"
    });
    expect(prepared.episodeId).not.toBe(first.episodeId);

    const feedback = db.db.prepare(
      `SELECT id, channel, polarity, magnitude, l1_memory_id, raw_turn_id, raw_payload_json
       FROM feedback
       WHERE user_id = 'user-implicit-turn-feedback'`
    ).get() as {
      id: string;
      channel: string;
      polarity: string;
      magnitude: number;
      l1_memory_id: string | null;
      raw_turn_id: string | null;
      raw_payload_json: string;
    };
    expect(feedback).toMatchObject({
      channel: "implicit",
      polarity: "negative",
      magnitude: 0.9,
      l1_memory_id: first.l1MemoryId,
      raw_turn_id: first.rawTurnId
    });
    expect(JSON.parse(feedback.raw_payload_json)).toMatchObject({
      source: "turn_feedback_classifier",
      method: "rule",
      classifierPolarity: "negative"
    });

    const queuedReward = db.db.prepare(
      `SELECT payload_json
       FROM evolution_jobs
       WHERE job_type = 'reward'
         AND json_extract(payload_json, '$.feedbackId') = ?`
    ).get(feedback.id) as { payload_json: string } | undefined;
    expect(JSON.parse(queuedReward!.payload_json)).toMatchObject({
      feedbackId: feedback.id,
      l1MemoryId: first.l1MemoryId,
      trigger: "implicit_turn_feedback"
    });

    await runWorkerRounds(service, 2, 20);
    const memory = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(first.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(memory.properties_json) as {
      internal_info: {
        trace: {
          r_human?: number;
          source_feedback_ids?: string[];
        };
      };
    }).internal_info.trace;
    expect(trace.r_human).toBeLessThan(0);
    expect(trace.source_feedback_ids).toContain(feedback.id);

    db.close();
  });
});
