import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type LlmClient
} from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import {
  accountRuntimeConfig,
  createCapturingEmbedder,
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

function createRelationClassifierLlm(
  calls: string[],
  optionCalls?: Array<{ operation: string; thinkingMode?: string }>,
  relation: "new_task" | "follow_up" | "end_topic" | Array<"new_task" | "follow_up" | "end_topic"> = "new_task"
): LlmClient {
  let relationIndex = 0;
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
      options: { operation: string; thinkingMode?: string }
    ): Promise<T> {
      if (options.operation === "retrieval.retrieval.query.extract.v2") {
        return { queryVecText: "", keywords: [] } as unknown as T;
      }
      calls.push(options.operation);
      optionCalls?.push({ operation: options.operation, thinkingMode: options.thinkingMode });
      if (options.operation === "relation.classify.v1") {
        const currentRelation = Array.isArray(relation)
          ? relation[Math.min(relationIndex++, relation.length - 1)] ?? "follow_up"
          : relation;
        return {
          relation: currentRelation,
          confidence: currentRelation === "end_topic" ? 0.98 : 0.7,
          reason: currentRelation === "end_topic"
            ? "user explicitly ends the current topic"
            : "database certificate rotation appears adjacent"
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
      if (options.operation === "retrieval.retrieval.query.extract.v2") {
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
  it("closes an explicitly ended topic without capturing the control turn as L1", async () => {
    const relationCalls: string[] = [];
    const { service } = createTestService({
      llm: createRelationClassifierLlm(relationCalls, undefined, "end_topic")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-end-topic"
      }
    });
    const first = service.completeTurn("turn-end-topic-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 443 and verify the certificate chain."
    });

    const prepared = await service.startTurn({
      turnId: "turn-end-topic-close",
      sessionId: session.sessionId,
      query: "结束会话"
    });

    expect(prepared).toMatchObject({ hits: [], sourceMemoryIds: [] });
    expect(prepared).not.toHaveProperty("episodeId");
    expect(prepared).not.toHaveProperty("closedEpisodeIds");
    expect(prepared.status).toContain("relation:end_topic:proposed");
    expect(relationCalls).toEqual([]);
    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "open"
    });

    const completed = service.completeTurn("turn-end-topic-close", {
      sessionId: session.sessionId,
      query: "结束会话",
      answer: "好的，本话题到这里结束。"
    });

    expect(completed.closedEpisodeIds).toEqual([first.episodeId]);
    expect(completed.l1MemoryId).toBe("");
    expect(completed.l1MemoryIds).toEqual([]);
    expect(completed.jobs.map((job) => job.jobType)).not.toContain("reflection");
    expect(completed.jobs.map((job) => job.jobType)).not.toContain("episode_idle_close");
    const detail = service.getMemory(first.episodeId);
    expect(detail).toMatchObject({
      kind: "episode",
      status: "closed"
    });
    if (detail.kind !== "episode") {
      throw new Error("expected episode detail");
    }
    expect(detail.metadata).toMatchObject({
      episode: {
        meta: {
          closeReason: "end_topic",
          topicState: "ended",
          endTopicTurnId: "turn-end-topic-close",
          relationDecision: { relation: "end_topic" }
        }
      }
    });
    expect(detail.timeline.rawTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawTurnId: completed.rawTurnId,
        userText: "结束会话",
        assistantText: "好的，本话题到这里结束。"
      })
    ]));
    expect(detail.timeline.items.map((item) => item.id)).toContain(first.l1MemoryId);
    expect(detail.timeline.items).toHaveLength(1);
  });

  it("recognizes only standalone explicit end-topic commands", async () => {
    const { service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-explicit-end-topic"
      }
    });
    const first = service.completeTurn("turn-explicit-end-topic-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });

    for (const query of ["结束话题", "如何结束进程？", "不要结束会话，继续说明证书续期", "不聊了吗？"]) {
      const prepared = await service.startTurn({
        sessionId: session.sessionId,
        query
      });
      expect(prepared.status).not.toContain("relation:end_topic:proposed");
    }

    const prepared = await service.startTurn({
      turnId: "turn-explicit-end-topic-close",
      sessionId: session.sessionId,
      query: "不聊了！"
    });
    expect(prepared.status).toContain("relation:end_topic:proposed");

    const completed = service.completeTurn("turn-explicit-end-topic-close", {
      sessionId: session.sessionId,
      query: "不聊了！",
      answer: "好的。"
    });
    expect(completed.closedEpisodeIds).toEqual([first.episodeId]);
    expect(completed.l1MemoryIds).toEqual([]);
  });

  it("commits an LLM end-topic proposal without capturing the control turn as L1", async () => {
    const relationCalls: string[] = [];
    const { service } = createTestService({
      llm: createRelationClassifierLlm(relationCalls, undefined, "end_topic")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-llm-end-topic"
      }
    });
    const first = service.completeTurn("turn-llm-end-topic-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });
    const started = await service.startTurn({
      turnId: "turn-llm-end-topic-close",
      sessionId: session.sessionId,
      query: "That covers everything for this topic"
    });
    expect(started.status).toContain("relation:end_topic:proposed");
    expect(relationCalls).toContain("relation.classify.v1");
    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "open"
    });

    const completed = service.completeTurn("turn-llm-end-topic-close", {
      sessionId: session.sessionId,
      query: "That covers everything for this topic",
      answer: "Understood."
    });
    expect(completed.closedEpisodeIds).toEqual([first.episodeId]);
    expect(completed.l1MemoryIds).toEqual([]);
    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "closed"
    });
  });

  it("keeps end-topic start and complete retries idempotent", async () => {
    const relationCalls: string[] = [];
    const { service } = createTestService({
      llm: createRelationClassifierLlm(relationCalls, undefined, "end_topic")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-end-topic-retry"
      }
    });
    service.completeTurn("turn-end-topic-retry-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });
    const request = {
      turnId: "turn-end-topic-retry-close",
      sessionId: session.sessionId,
      query: "结束会话"
    };

    const firstStart = await service.startTurn(request);
    const secondStart = await service.startTurn(request);

    expect(firstStart).not.toHaveProperty("episodeId");
    expect(secondStart).not.toHaveProperty("episodeId");
    expect(firstStart).not.toHaveProperty("closedEpisodeIds");
    expect(secondStart).not.toHaveProperty("closedEpisodeIds");
    expect(firstStart.status).toContain("relation:end_topic:proposed");
    expect(secondStart.status).toContain("relation:end_topic:proposed");
    expect(relationCalls).toEqual([]);

    const completeRequest = {
      sessionId: session.sessionId,
      query: "结束会话",
      answer: "好的，本话题结束。"
    };
    const firstComplete = service.completeTurn(request.turnId, completeRequest);
    const secondComplete = service.completeTurn(request.turnId, completeRequest);

    expect(secondComplete.closedEpisodeIds).toEqual(firstComplete.closedEpisodeIds);
    expect(secondComplete.jobs).toEqual([]);
    expect(secondComplete.scheduledEvolution).toBe(false);
    expect(secondComplete.duplicate).toBe(true);
  });

  it("does not reopen an episode after an explicit end-topic boundary", async () => {
    const { service } = createTestService({
      llm: createRelationClassifierLlm([], undefined, "follow_up")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-end-topic-boundary"
      }
    });
    const first = service.completeTurn("turn-end-topic-boundary-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });
    await service.startTurn({
      turnId: "turn-end-topic-boundary-close",
      sessionId: session.sessionId,
      query: "结束会话"
    });
    service.completeTurn("turn-end-topic-boundary-close", {
      sessionId: session.sessionId,
      query: "结束会话",
      answer: "好的，本话题结束。"
    });

    const nextStart = await service.startTurn({
      turnId: "turn-end-topic-boundary-next",
      sessionId: session.sessionId,
      query: "继续说明证书续期"
    });
    const next = service.completeTurn("turn-end-topic-boundary-next", {
      sessionId: session.sessionId,
      query: "继续说明证书续期",
      answer: "可以使用 certbot 自动续期。"
    });

    expect(nextStart).not.toHaveProperty("episodeId");
    expect(next.episodeId).not.toBe(first.episodeId);
    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "closed"
    });
    expect(service.getMemory(next.episodeId)).toMatchObject({
      kind: "episode",
      status: "open"
    });
  });

  it("binds a following turn after the explicit end-topic completion", async () => {
    const relationCalls: string[] = [];
    const { service } = createTestService({
      llm: createRelationClassifierLlm(relationCalls, undefined, "follow_up")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-pending-end-topic"
      }
    });
    const first = service.completeTurn("turn-pending-end-topic-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });
    await service.startTurn({
      turnId: "turn-pending-end-topic-close",
      sessionId: session.sessionId,
      query: "结束会话"
    });

    const nextStart = await service.startTurn({
      turnId: "turn-after-pending-end-topic",
      sessionId: session.sessionId,
      query: "继续说明证书续期"
    });

    expect(nextStart).not.toHaveProperty("episodeId");
    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "open"
    });
    expect(relationCalls).toEqual(["relation.classify.v1"]);

    service.completeTurn("turn-pending-end-topic-close", {
      sessionId: session.sessionId,
      query: "结束会话",
      answer: "好的，本话题结束。"
    });
    const next = service.completeTurn("turn-after-pending-end-topic", {
      sessionId: session.sessionId,
      query: "继续说明证书续期",
      answer: "可以使用 certbot 自动续期。"
    });

    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "closed"
    });
    expect(service.getMemory(next.episodeId)).toMatchObject({
      kind: "episode",
      status: "open"
    });
  });

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
    const jobsBeforeStart = (db.db.prepare(
      "SELECT COUNT(*) AS count FROM evolution_jobs"
    ).get() as { count: number }).count;

    const prepared = await service.startTurn({ turnId: "turn-relation-new-task",
      sessionId: session.sessionId,
      query: "new task: summarize the Q4 hiring plan"
    });
    expect(prepared).not.toHaveProperty("episodeId");
    expect(prepared).not.toHaveProperty("closedEpisodeIds");
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM episodes WHERE session_id = ?"
    ).get(session.sessionId)).toEqual({ count: 1 });
    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "open"
    });
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM evolution_jobs"
    ).get()).toEqual({ count: jobsBeforeStart });
    const completed = service.completeTurn("turn-relation-new-task", {
      sessionId: session.sessionId,
      query: "new task: summarize the Q4 hiring plan",
      answer: "The Q4 hiring plan has been summarized."
    });
    expect(completed.episodeId).not.toBe(first.episodeId);
    expect(completed.closedEpisodeIds).toEqual([first.episodeId]);
    expect(completed.jobs.map((job) => job.jobType)).toContain("reflection");

    const rows = db.db.prepare(
      `SELECT id, status, meta_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ id: string; status: string; meta_json: string }>;
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((row) => row.id === first.episodeId);
    const preparedRow = rows.find((row) => row.id === completed.episodeId);
    expect(firstRow).toMatchObject({ id: first.episodeId, status: "closed" });
    expect(JSON.parse(firstRow!.meta_json)).toMatchObject({
      closeReason: "topic_boundary",
      relation: "new_task"
    });
    expect(preparedRow).toMatchObject({ id: completed.episodeId, status: "open" });
    expect(JSON.parse(preparedRow!.meta_json)).toMatchObject({
      previousEpisodeId: first.episodeId,
      relation: "new_task"
    });

    db.close();
  });

  it("ignores an uncompleted new-task proposal when routing the next completed turn", async () => {
    const { db, service } = createTestService({
      llm: createRelationClassifierLlm([], undefined, "follow_up")
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-cancelled-route-proposal"
      }
    });
    const first = service.completeTurn("turn-cancelled-proposal-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });

    await service.startTurn({
      turnId: "turn-cancelled-proposal",
      sessionId: session.sessionId,
      query: "换个任务：总结招聘计划"
    });
    const nextStart = await service.startTurn({
      turnId: "turn-after-cancelled-proposal",
      sessionId: session.sessionId,
      query: "那证书自动续期呢"
    });

    expect(nextStart).not.toHaveProperty("episodeId");
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM episodes WHERE session_id = ?"
    ).get(session.sessionId)).toEqual({ count: 1 });
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM raw_turns WHERE session_id = ? AND turn_id = ?"
    ).get(session.sessionId, "turn-cancelled-proposal")).toEqual({ count: 0 });

    const completed = service.completeTurn("turn-after-cancelled-proposal", {
      sessionId: session.sessionId,
      query: "那证书自动续期呢",
      answer: "Use certbot renewal hooks."
    });
    expect(completed.episodeId).toBe(first.episodeId);
    expect(completed.closedEpisodeIds).toEqual([]);
    db.close();
  });

  it("reclassifies a stale route proposal and records the stale marker", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-stale-route-proposal"
      }
    });
    const first = service.completeTurn("turn-stale-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });
    await service.startTurn({
      turnId: "turn-stale-proposed",
      sessionId: session.sessionId,
      query: "new task: summarize the hiring plan"
    });
    const intervening = service.completeTurn("turn-stale-intervening", {
      sessionId: session.sessionId,
      query: "new task: audit database backups",
      answer: "The database backup audit is complete."
    });
    expect(intervening.episodeId).not.toBe(first.episodeId);

    const completed = service.completeTurn("turn-stale-proposed", {
      sessionId: session.sessionId,
      query: "new task: summarize the hiring plan",
      answer: "The hiring plan is summarized."
    });
    expect(completed.episodeId).not.toBe(intervening.episodeId);
    expect(completed.closedEpisodeIds).toEqual([intervening.episodeId]);
    const raw = db.db.prepare(
      "SELECT message_payload_json FROM raw_turns WHERE id = ?"
    ).get(completed.rawTurnId) as { message_payload_json: string };
    expect(JSON.parse(raw.message_payload_json)).toMatchObject({
      turn_start: {
        routeProposalStale: true,
        routeProposal: {
          baseEpisodeId: first.episodeId,
          action: "split"
        }
      }
    });
    db.close();
  });

  it("honors an explicit episode id over a conflicting start proposal", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-explicit-complete-episode"
      }
    });
    const first = service.completeTurn("turn-explicit-episode-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS",
      answer: "Use port 443."
    });
    await service.startTurn({
      turnId: "turn-explicit-episode",
      sessionId: session.sessionId,
      query: "new task: summarize the hiring plan"
    });

    const completed = service.completeTurn("turn-explicit-episode", {
      sessionId: session.sessionId,
      episodeId: first.episodeId,
      query: "new task: summarize the hiring plan",
      answer: "The hiring plan is summarized."
    });
    expect(completed.episodeId).toBe(first.episodeId);
    expect(completed.closedEpisodeIds).toEqual([]);
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM episodes WHERE session_id = ?"
    ).get(session.sessionId)).toEqual({ count: 1 });
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
    expect(prepared).not.toHaveProperty("episodeId");
    expect(prepared).not.toHaveProperty("closedEpisodeIds");

    const rows = db.db.prepare(
      `SELECT id, status, meta_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ id: string; status: string; meta_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.episodeId, status: "open" });
    expect(JSON.parse(rows[0]!.meta_json)).not.toHaveProperty("relation");

    const completed = service.completeTurn("turn-relation-follow-up-next", {
      sessionId: session.sessionId,
      query: "那证书自动续期呢",
      answer: "Use systemd timers or certbot renewal hooks and verify nginx reloads cleanly."
    });
    expect(completed.episodeId).toBe(first.episodeId);

    const afterComplete = db.db.prepare(
      `SELECT id, status, turn_count, raw_turn_ids_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ id: string; status: string; turn_count: number; raw_turn_ids_json: string }>;
    expect(afterComplete).toHaveLength(1);
    expect(afterComplete[0]).toMatchObject({
      id: first.episodeId,
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

  it("does not reserve a raw turn until completion commits the proposed episode", async () => {
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
    expect(prepared).not.toHaveProperty("episodeId");
    expect(relationCalls).toEqual(["relation.classify.v1"]);
    const reserved = db.db.prepare(
      `SELECT id, episode_id, status
       FROM raw_turns
       WHERE session_id = ? AND turn_id = ?`
    ).get(session.sessionId, "turn-bind-second") as { id: string; episode_id: string; status: string } | undefined;
    expect(reserved).toBeUndefined();

    const completed = service.completeTurn("turn-bind-second", {
      sessionId: session.sessionId,
      query: "青竹项目的部署端口是多少？林浩偏好什么回答风格？",
      answer: "部署端口是 49231；林浩偏好简洁中文回答。"
    });

    expect(completed.episodeId).toBe(first.episodeId);
    expect(completed.rawTurnId).toMatch(/^raw_/u);
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

    await service.startTurn({
      turnId: "turn-book-second",
      sessionId: session.sessionId,
      query: "有什么其他书和这本书比较相似的吗"
    });
    const second = service.completeTurn("turn-book-second", {
      sessionId: session.sessionId,
      query: "有什么其他书和这本书比较相似的吗",
      answer: "可以看《霍乱时期的爱情》和其他家族史诗类作品。"
    });
    expect(second.episodeId).toBe(first.episodeId);

    await service.startTurn({
      turnId: "turn-book-third",
      sessionId: session.sessionId,
      query: "有什么中国的书和这些书比较相似的吗"
    });
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

  it("uses the configured relation classifier during turn.start arbitration", async () => {
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

    expect(prepared).not.toHaveProperty("episodeId");
    expect(calls).toEqual(["relation.classify.v1", "relation.arbitration.v1"]);
    const beforeComplete = db.db.prepare(
      `SELECT meta_json
       FROM episodes
       WHERE session_id = ?`
    ).get(session.sessionId) as { meta_json: string };
    expect(JSON.parse(beforeComplete.meta_json)).not.toHaveProperty("relationDecision");

    const completed = service.completeTurn("turn-relation-llm-next", {
      sessionId: session.sessionId,
      query: "Database certificate rotation details please",
      answer: "Rotate the certificate and reload the database client."
    });
    expect(completed.episodeId).toBe(first.episodeId);
    const rows = db.db.prepare(
      `SELECT meta_json
       FROM episodes
       WHERE session_id = ?
       ORDER BY opened_at ASC`
    ).all(session.sessionId) as Array<{ meta_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({
      relationDecision: {
        relation: "follow_up",
        signals: expect.arrayContaining(["arbitration_override"])
      }
    });
    db.close();
  });

  it("runs memory retrieval while the relation classifier is still pending", async () => {
    let signalRelationStarted: (() => void) | undefined;
    let releaseRelation: (() => void) | undefined;
    const relationStarted = new Promise<void>((resolve) => {
      signalRelationStarted = resolve;
    });
    const relationRelease = new Promise<void>((resolve) => {
      releaseRelation = resolve;
    });
    let retrievalExtractStarted = false;
    const llm: LlmClient = {
      config: {
        ...DEFAULT_MEMMY_CONFIG.summary,
        provider: "host",
        endpoint: "http://127.0.0.1/parallel-turn-start",
        model: "parallel-turn-start"
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
        if (options.operation === "relation.classify.v1") {
          signalRelationStarted?.();
          await relationRelease;
          return {
            relation: "new_task",
            confidence: 0.95,
            reason: "the database task is unrelated to nginx"
          } as unknown as T;
        }
        if (options.operation === "retrieval.retrieval.query.extract.v2") {
          retrievalExtractStarted = true;
          return {
            queryVecText: "database certificate rotation",
            keywords: ["database", "certificate"]
          } as unknown as T;
        }
        return { ranked: [1], sufficient: true } as unknown as T;
      },
      status() {
        return {
          provider: "host",
          model: "parallel-turn-start",
          configured: true,
          remote: true
        };
      }
    };
    const config = {
      ...DEFAULT_MEMMY_CONFIG,
      algorithm: {
        ...DEFAULT_MEMMY_CONFIG.algorithm,
        retrieval: {
          ...DEFAULT_MEMMY_CONFIG.algorithm.retrieval,
          llmFilterEnabled: false
        }
      }
    };
    const { db, service } = createTestService({ llm, config });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-parallel-turn-start"
      }
    });
    const first = service.completeTurn("turn-parallel-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 443 and verify the certificate chain."
    });

    const startPromise = service.startTurn({
      turnId: "turn-parallel-next",
      sessionId: session.sessionId,
      query: "Database certificate rotation details please"
    });
    await relationStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retrievalStartedBeforeRelationCompleted = retrievalExtractStarted;
    releaseRelation?.();
    const started = await startPromise;

    expect(retrievalStartedBeforeRelationCompleted).toBe(true);
    const recall = db.db.prepare(
      "SELECT request_json FROM recall_events WHERE id = ?"
    ).get(started.searchEventId) as { request_json: string };
    expect(JSON.parse(recall.request_json)).toMatchObject({
      routeProposal: {
        action: "split",
        baseEpisodeId: first.episodeId,
        relationDecision: { relation: "new_task" }
      }
    });

    const completed = service.completeTurn("turn-parallel-next", {
      sessionId: session.sessionId,
      query: "Database certificate rotation details please",
      answer: "Rotate the database certificate and reload the client."
    });
    expect(completed.episodeId).not.toBe(first.episodeId);
  });

  it("uses the account summary model for relation classification", async () => {
    const root = createTestRoot("mindock-memory-account-relation-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const summaryCalls: string[] = [];
    const evolutionCalls: string[] = [];
    const summaryOptions: Array<{ operation: string; thinkingMode?: string }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config: accountRuntimeConfig(),
      llm: createRelationClassifierLlm(summaryCalls, summaryOptions),
      skillLlm: createRelationClassifierLlm(evolutionCalls),
      embedder: createCapturingEmbedder([])
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-account-relation-model"
      }
    });
    service.completeTurn("turn-account-relation-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 443 and verify the certificate chain."
    });

    await service.startTurn({
      turnId: "turn-account-relation-next",
      sessionId: session.sessionId,
      query: "Database certificate rotation details please"
    });

    expect(summaryCalls).toEqual(["relation.classify.v1", "relation.arbitration.v1"]);
    expect(evolutionCalls).toEqual([]);
    expect(summaryOptions).toEqual([
      { operation: "relation.classify.v1", thinkingMode: "disabled" },
      { operation: "relation.arbitration.v1", thinkingMode: "disabled" }
    ]);
    db.close();
  });

  it("records revision feedback immediately but defers reward backprop until episode close", async () => {
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
    expect(prepared).not.toHaveProperty("episodeId");
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM feedback WHERE user_id = 'user-relation-revision'"
    ).get()).toEqual({ count: 0 });
    const correction = service.completeTurn("turn-relation-revision-fix", {
      sessionId: session.sessionId,
      query: "wrong, use port 443 instead and verify TLS",
      answer: "Corrected: use port 443 and verify TLS."
    });
    expect(correction.episodeId).toBe(first.episodeId);
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM feedback WHERE user_id = 'user-relation-revision'"
    ).get()).toEqual({ count: 1 });

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

    const openMemory = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(first.l1MemoryId) as { properties_json: string };
    const openTrace = (JSON.parse(openMemory.properties_json) as {
      internal_info: {
        trace: {
          r_human?: number;
          source_feedback_ids?: string[];
        };
      };
    }).internal_info.trace;
    expect(openTrace.r_human).toBeUndefined();
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE episode_id = ? AND job_type = 'reward'`
    ).get(first.episodeId)).toEqual({ count: 0 });

    service.closeSession(session.sessionId);
    await runWorkerRounds(service, 2, 50);
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

  it("clears a stale final reward when a closed episode is reopened", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-reopen-stale-reward"
      }
    });
    const first = service.completeTurn("turn-reopen-stale-reward-first", {
      sessionId: session.sessionId,
      query: "Configure nginx TLS for the service",
      answer: "Use port 80 and skip certificate verification."
    });
    const repos = new Repositories(db.db);
    const rewardDetail = {
      phase: "final",
      rHuman: -0.25,
      traceIds: [first.l1MemoryId]
    };
    repos.runtime.updateEpisodeReward(first.episodeId, {
      rTask: -0.25,
      rewardDetail,
      metaPatch: { reward: rewardDetail }
    });
    repos.runtime.closeEpisode(first.episodeId, { closeReason: "idle_timeout" });

    await service.startTurn({
      turnId: "turn-reopen-stale-reward-fix",
      sessionId: session.sessionId,
      query: "wrong, use port 443 instead and verify TLS"
    });
    const correction = service.completeTurn("turn-reopen-stale-reward-fix", {
      sessionId: session.sessionId,
      query: "wrong, use port 443 instead and verify TLS",
      answer: "Corrected: use port 443 and verify TLS."
    });

    expect(correction.episodeId).toBe(first.episodeId);
    expect(repos.runtime.getEpisode(first.episodeId)).toMatchObject({
      status: "open",
      rTask: undefined,
      rewardDetail: {},
      meta: {
        rewardDirty: {
          reason: "episode_reopened"
        }
      }
    });
    expect(repos.runtime.getEpisode(first.episodeId)?.meta).not.toHaveProperty("reward");
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
    expect(prepared).not.toHaveProperty("episodeId");
    expect(prepared).not.toHaveProperty("closedEpisodeIds");
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM feedback WHERE user_id = 'user-implicit-turn-feedback'"
    ).get()).toEqual({ count: 0 });
    expect(service.getMemory(first.episodeId)).toMatchObject({
      kind: "episode",
      status: "open"
    });
    const correction = service.completeTurn("turn-implicit-feedback-correction", {
      sessionId: session.sessionId,
      query: "不对，应该用递归实现，这样性能不好。换个任务：实现二叉树层序遍历",
      answer: "已改为递归，并开始实现二叉树层序遍历。"
    });
    expect(correction.episodeId).not.toBe(first.episodeId);

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

    const rewardBeforeReflection = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'reward'
         AND json_extract(payload_json, '$.feedbackId') = ?`
    ).get(feedback.id) as { count: number };
    expect(rewardBeforeReflection.count).toBe(0);

    await service.runWorkerOnce(20);
    const queuedReward = db.db.prepare(
      `SELECT payload_json
       FROM evolution_jobs
       WHERE job_type = 'reward'
         AND json_extract(payload_json, '$.feedbackId') = ?`
    ).get(feedback.id) as { payload_json: string } | undefined;
    expect(JSON.parse(queuedReward!.payload_json)).toMatchObject({
      feedbackId: feedback.id,
      l1MemoryId: first.l1MemoryId,
      phase: "final",
      trigger: "implicit_fallback"
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
