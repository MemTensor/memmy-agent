import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("User Memory", () => {
  it("[BC-06] keeps a one-turn alternative request temporary and a durable prohibition persistent", async () => {
    const { db, service } = createTestService({
      llm: captureDecisionRouterLlm((payload) => {
        if (payload.includes("以后不要再推荐飞盘")) {
          return {
            create_l1: true,
            l1_summary: "用户以后不希望 Agent 推荐飞盘。",
            l1_evidence: [{ quote: "以后不要再推荐飞盘", source_role: "user", kind: "user_preference" }],
            create_user_memory: true,
            user_memory_types: ["User Preference"],
            user_memory_evidence: [{ quote: "以后不要再推荐飞盘", type: "User Preference" }],
            reason: "stable work preference that also constrains future Agent work"
          };
        }
        if (payload.includes("我喜欢玩飞盘")) {
          return {
            create_l1: false,
            l1_summary: "",
            create_user_memory: true,
            user_memory_types: ["User Preference"],
            user_memory_evidence: [{ quote: "我喜欢玩飞盘", type: "User Preference" }],
            reason: "durable preference"
          };
        }
        return {
          create_l1: false,
          l1_summary: "",
          create_user_memory: false,
          user_memory_types: [],
          user_memory_evidence: [],
          reason: "temporary current-request constraint"
        };
      })
    });
    const session = open(service, "bc-06-user");
    const turns = [
      service.completeTurn("bc-06-preference", {
        sessionId: session.sessionId,
        query: "我喜欢玩飞盘",
        answer: "记住了。"
      }),
      service.completeTurn("bc-06-temporary", {
        sessionId: session.sessionId,
        query: "换一个",
        answer: "可以，改为桌游。"
      }),
      service.completeTurn("bc-06-directive", {
        sessionId: session.sessionId,
        query: "以后不要再推荐飞盘",
        answer: "好的。"
      })
    ];

    await service.runWorkerOnce(50, { priorityCohortOnly: true });

    const userMemories = db.db.prepare(
      `SELECT content, memory_types_json, source_turn_refs_json
       FROM user_memories
       WHERE status = 'active'
       ORDER BY created_at`
    ).all() as Array<{
      content: string;
      memory_types_json: string;
      source_turn_refs_json: string;
    }>;
    expect(userMemories.map((memory) => ({
      content: memory.content,
      types: JSON.parse(memory.memory_types_json)
    }))).toEqual([
      { content: "我喜欢玩飞盘", types: ["User Preference"] },
      { content: "以后不要再推荐飞盘", types: ["User Preference"] }
    ]);
    expect(userMemories.every((memory) => JSON.parse(memory.source_turn_refs_json).length === 1)).toBe(true);
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM user_memories WHERE content = '换一个'`
    ).get()).toEqual({ count: 0 });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(turns[0]!.l1MemoryId))
      .toEqual({ status: "deleted" });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(turns[1]!.l1MemoryId))
      .toEqual({ status: "deleted" });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(turns[2]!.l1MemoryId))
      .toEqual({ status: "activated" });
    db.close();
  });

  it("routes one-off task commands to L1 without creating User Memory", async () => {
    const requests = ["帮我开发一个网页", "帮我把代码提交到 GitHub"];
    const { db, service } = createTestService({
      llm: captureDecisionRouterLlm((payload) => {
        const request = requests.find((item) => payload.includes(item));
        if (!request) throw new Error(`unexpected payload: ${payload}`);
        return {
          create_l1: true,
          l1_summary: request,
          policy_eligible: true,
          l1_evidence: [{ quote: request, source_role: "user", kind: "task_request" }],
          create_user_memory: false,
          user_memory_types: [],
          user_memory_evidence: [],
          reason: "one-off Agent task instruction"
        };
      })
    });
    const session = open(service, "one-off-task-user");
    const turns = requests.map((query, index) => service.completeTurn(`one-off-task-${index}`, {
      sessionId: session.sessionId,
      query,
      answer: "好的。"
    }));

    await service.runWorkerOnce(50, { priorityCohortOnly: true });

    expect(rowCount(db, "user_memories")).toBe(0);
    for (const turn of turns) {
      expect(db.db.prepare(
        `SELECT status, json_extract(properties_json, '$.internal_info.policy_eligible') AS policy_eligible
         FROM memories WHERE id = ?`
      ).get(turn.l1MemoryId)).toEqual({ status: "activated", policy_eligible: 0 });
    }
    db.close();
  });

  it("stores a stable merge convention in both User Memory and L1", async () => {
    const query = "merge 代码不要用 squash";
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: true,
        l1_summary: query,
        policy_eligible: true,
        l1_evidence: [{ quote: query, source_role: "user", kind: "user_preference" }],
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{ quote: query, type: "User Preference" }],
        reason: "stable work preference that constrains Agent execution"
      })
    });
    const session = open(service, "merge-convention-user");
    const completed = service.completeTurn("merge-convention", {
      sessionId: session.sessionId,
      query,
      answer: "好的。"
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(db.db.prepare(`SELECT content, memory_types_json FROM user_memories`).get())
      .toEqual({ content: query, memory_types_json: '["User Preference"]' });
    expect(db.db.prepare(
      `SELECT status, json_extract(properties_json, '$.internal_info.policy_eligible') AS policy_eligible
       FROM memories WHERE id = ?`
    ).get(completed.l1MemoryId)).toEqual({ status: "activated", policy_eligible: 1 });
    db.close();
  });

  it("uses the summary model to reject a recall-only turn from both memory branches", async () => {
    const calls: string[] = [];
    const { db, service } = createTestService({
      llm: captureDecisionLlm(calls, {
        create_l1: false,
        l1_summary: "",
        create_user_memory: false,
        user_memory_types: [],
        reason: "question answered only from recalled memory"
      })
    });
    const session = open(service, "model-recall-only-user");
    const completed = service.completeTurn("turn-model-recall-only", {
      sessionId: session.sessionId,
      query: "我喜欢吃什么水果？从历史记忆里找",
      answer: "历史记录显示你喜欢苹果。",
      toolCalls: [{ name: "memmy_memory_search", input: { query: "水果偏好" }, output: ["喜欢苹果"] }],
      sourceMemoryIds: ["trace-old-preference"]
    });

    expect(completed.userMemoryIds).toEqual([]);
    expect(completed.l1MemoryIds).toHaveLength(1);
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "resolving" });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(calls).toEqual(["capture.summarize"]);
    expect(rowCount(db, "user_memories")).toBe(0);
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "deleted" });
    expect(db.db.prepare(`SELECT * FROM memory_processing_state WHERE memory_id = ?`).get(completed.l1MemoryIds[0]))
      .toBeUndefined();
    db.close();
  });

  it("does not turn a preference question or the assistant's guess into User Memory", async () => {
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: false,
        l1_summary: "",
        create_user_memory: false,
        user_memory_types: [],
        reason: "question is not an explicit user claim"
      })
    });
    const session = open(service, "preference-question-user");
    const completed = service.completeTurn("turn-preference-question", {
      sessionId: session.sessionId,
      query: "财经类新闻呢？我喜欢看吗",
      answer: "你喜欢看政治相关新闻，也对财经类新闻感兴趣。",
      sourceMemoryIds: ["user_memory_politics"]
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(rowCount(db, "user_memories")).toBe(0);
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "deleted" });
    db.close();
  });

  it("lets the summary model create User Memory without L1 for a pure preference", async () => {
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: false,
        l1_summary: "",
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{ quote: "我最喜欢的水果是苹果", type: "User Preference" }],
        reason: "explicit durable preference without task outcome"
      })
    });
    const session = open(service, "model-preference-user");
    const completed = service.completeTurn("turn-model-preference", {
      sessionId: session.sessionId,
      query: "我最喜欢的水果是苹果",
      answer: "好的。"
    });

    expect(completed.userMemoryIds).toEqual([]);
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(db.db.prepare(`SELECT content, memory_types_json, status FROM user_memories`).get())
      .toEqual({
        content: "我最喜欢的水果是苹果",
        memory_types_json: '["User Preference"]',
        status: "active"
      });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "deleted" });
    db.close();
  });

  it("lets the summary model independently create both branches for task-linked feedback", async () => {
    const summary = "用户要求后续代码保持简洁，避免不必要的兜底；本轮实现已精简并通过测试。";
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: true,
        l1_summary: summary,
        policy_eligible: true,
        l1_evidence: [{ quote: "已精简实现并通过测试", source_role: "assistant", kind: "task_outcome" }],
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{
          quote: "我更喜欢简洁的代码",
          type: "User Preference"
        }, {
          quote: "以后不要写不必要的兜底代码",
          type: "User Preference"
        }],
        reason: "task outcome plus reusable user feedback"
      })
    });
    const session = open(service, "model-both-user");
    const completed = service.completeTurn("turn-model-both", {
      sessionId: session.sessionId,
      query: "我更喜欢简洁的代码，以后不要写不必要的兜底代码",
      answer: "已精简实现并通过测试。"
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(db.db.prepare(`SELECT content FROM user_memories WHERE status = 'active'`).get())
      .toEqual({ content: "我更喜欢简洁的代码，以后不要写不必要的兜底代码" });
    expect(db.db.prepare(
      `SELECT status, json_extract(info_json, '$.summary') AS summary,
              json_extract(properties_json, '$.internal_info.policy_eligible') AS policy_eligible
       FROM memories WHERE id = ?`
    ).get(completed.l1MemoryIds[0])).toEqual({ status: "activated", summary, policy_eligible: 0 });
    db.close();
  });

  it("does not let the summary model reject a verified durable tool observation", async () => {
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: false,
        l1_summary: "",
        create_user_memory: false,
        user_memory_types: [],
        reason: "incorrect model rejection"
      })
    });
    const session = open(service, "model-hardware-guard-user");
    const completed = service.completeTurn("turn-model-hardware-guard", {
      sessionId: session.sessionId,
      query: "我的电脑内存多大？",
      answer: "工具读取结果是 16 GB。",
      toolCalls: [{ name: "system_info", input: { field: "memory" } }],
      toolResults: [{ totalMemory: "16 GB" }]
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(db.db.prepare(
      `SELECT status, memory_key, json_extract(info_json, '$.evidence_status') AS evidence_status
       FROM memories WHERE id = ?`
    ).get(completed.l1MemoryIds[0])).toEqual({
      status: "activated",
      memory_key: "trace:environment:device:local:default:device.total_memory",
      evidence_status: "verified"
    });
    expect(rowCount(db, "user_memories")).toBe(0);
    db.close();
  });

  it("does not let assistant completion wording override the summary model's L1 rejection", async () => {
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: false,
        l1_summary: "",
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{ quote: "我更喜欢简洁的代码", type: "User Preference" }],
        reason: "incomplete model classification"
      })
    });
    const session = open(service, "model-feedback-guard-user");
    const completed = service.completeTurn("turn-model-feedback-guard", {
      sessionId: session.sessionId,
      query: "你刚才写了很多兜底代码，我更喜欢简洁的代码，以后不要写不必要的兜底代码",
      answer: "已精简实现并通过测试。"
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(JSON.parse((db.db.prepare(`SELECT memory_types_json FROM user_memories`).get() as {
      memory_types_json: string;
    }).memory_types_json)).toEqual(["User Preference"]);
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "deleted" });
    const recall = await service.search({
      sessionId: session.sessionId,
      query: "简洁代码 不必要兜底代码",
      layers: ["L1"],
      limit: 5,
      includeInjectedContext: true
    });
    expect(recall.hits.flatMap((hit) => hit.memberMemoryIds ?? [hit.id]))
      .not.toContain(completed.l1MemoryIds[0]);
    db.close();
  });

  it("does not let User Memory classification veto an independently accepted L1", async () => {
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: true,
        l1_summary: "不要推荐飞盘",
        l1_evidence: [{
          quote: "以后不要再推荐飞盘",
          source_role: "user",
          kind: "user_directive"
        }],
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{ quote: "以后不要再推荐飞盘", type: "User Preference" }],
        reason: "durable directive is independently useful in both branches"
      })
    });
    const session = open(service, "model-directive-guard-user");
    const completed = service.completeTurn("turn-model-directive-guard", {
      sessionId: session.sessionId,
      query: "以后不要再推荐飞盘",
      answer: "好的。"
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(db.db.prepare(`SELECT memory_types_json FROM user_memories`).get())
      .toEqual({ memory_types_json: '["User Preference"]' });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "activated" });
    const accepted = db.db.prepare(`SELECT properties_json FROM memories WHERE id = ?`)
      .get(completed.l1MemoryIds[0]) as { properties_json: string };
    expect(JSON.parse(accepted.properties_json)).toMatchObject({
      internal_info: {
        capture_decision: {
          status: "accepted",
          create_l1: true,
          create_user_memory: true,
          l1_evidence: [{
            quote: "以后不要再推荐飞盘",
            source_role: "user",
            kind: "user_directive"
          }]
        }
      }
    });
    db.close();
  });

  it("keeps a compound user statement whole while independently creating both branches", async () => {
    const content = "我在大学的时候最喜欢吃苹果，我现在爱看的书是《百年孤独》";
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: true,
        l1_summary: content,
        l1_evidence: [{
          quote: content,
          source_role: "user",
          kind: "user_preference"
        }],
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{ quote: content, type: "User Preference" }],
        reason: "durable compound statement is independently useful in both branches"
      })
    });
    const session = open(service, "model-compound-guard-user");
    const completed = service.completeTurn("turn-model-compound-guard", {
      sessionId: session.sessionId,
      query: content,
      answer: "好的。"
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(db.db.prepare(`SELECT content FROM user_memories`).all()).toEqual([{ content }]);
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "activated" });
    db.close();
  });

  it("does not let a regex-looking preference force User Memory or suppress L1", async () => {
    const content = "我喜欢用 PostgreSQL 处理这个项目的数据";
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: true,
        l1_summary: "项目决定使用 PostgreSQL 处理数据。",
        l1_evidence: [{ quote: content, source_role: "user", kind: "decision" }],
        create_user_memory: false,
        user_memory_types: [],
        user_memory_evidence: [],
        reason: "project decision, not a personal preference"
      })
    });
    const session = open(service, "model-independent-branches-user");
    const completed = service.completeTurn("turn-model-independent-branches", {
      sessionId: session.sessionId,
      query: content,
      answer: "已记录项目技术选择。"
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(rowCount(db, "user_memories")).toBe(0);
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "activated" });
    db.close();
  });

  it("does not let question-like wording override grounded model decisions", async () => {
    const content = "I prefer songs which fit my film projects.";
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: true,
        l1_summary: content,
        policy_eligible: true,
        l1_evidence: [{ quote: content, source_role: "user", kind: "user_preference" }],
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{ quote: content, type: "User Preference" }],
        reason: "stable work preference stated declaratively"
      })
    });
    const session = open(service, "question-like-wording-user");
    const completed = service.completeTurn("question-like-wording", {
      sessionId: session.sessionId,
      query: content,
      answer: "Understood."
    });

    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(db.db.prepare(`SELECT content FROM user_memories`).get()).toEqual({ content });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryId))
      .toEqual({ status: "activated" });
    db.close();
  });

  it("[BC-01] does not persist an agent guess about the user as User Memory or L1", () => {
    const { db, service } = createTestService();
    const session = open(service, "guess-user");

    const completed = service.completeTurn("turn-guess", {
      sessionId: session.sessionId,
      query: "我喜欢吃什么？",
      answer: "你喜欢川菜。"
    });

    expect(completed.userMemoryIds).toEqual([]);
    expect(completed.l1MemoryIds).toEqual([]);
    expect(rowCount(db, "user_memories")).toBe(0);
    expect(rowCount(db, "raw_turns")).toBe(1);
    db.close();
  });

  it("[BC-03 recall] does not create L1 from an extended user-preference lookup backed only by recalled memory", () => {
    const { db, service } = createTestService();
    const session = open(service, "history-preference-question-user");

    const completed = service.completeTurn("turn-history-preference-question", {
      sessionId: session.sessionId,
      query: "我喜欢吃什么水果？从workbuddy的历史记忆里找",
      answer: "从历史记忆来看，你喜欢吃苹果。",
      toolCalls: [{ id: "memory-search-1", name: "memmy_memory_search", input: { query: "水果偏好" } }],
      toolResults: [{ toolCallId: "memory-search-1", memories: ["用户喜欢吃苹果"] }],
      sourceMemoryIds: ["trace-existing-apple-preference"]
    });

    expect(completed.userMemoryIds).toEqual([]);
    expect(completed.l1MemoryIds).toEqual([]);
    expect(rowCount(db, "raw_turns")).toBe(1);
    db.close();
  });

  it("keeps an unverified question answer provisional and out of ordinary recall", async () => {
    const { db, service } = createTestService();
    const session = open(service, "unverified-answer-user");

    const completed = service.completeTurn("turn-unverified-answer", {
      sessionId: session.sessionId,
      query: "火星上最大的城市是什么？",
      answer: "最大的城市是火星城。"
    });

    expect(completed.userMemoryIds).toEqual([]);
    expect(completed.l1MemoryIds).toHaveLength(1);
    expect(db.db.prepare(
      `SELECT json_extract(properties_json, '$.internal_info.evidence_status') AS evidence_status
       FROM memories WHERE id = ?`
    ).get(completed.l1MemoryIds[0])).toEqual({ evidence_status: "provisional" });
    await service.runWorkerOnce(20);
    const recall = await service.search({
      sessionId: session.sessionId,
      query: "火星最大的城市",
      layers: ["L1"],
      limit: 5
    });
    expect(recall.hits).toEqual([]);
    expect(rowCount(db, "raw_turns")).toBe(1);
    db.close();
  });

  it("[BC-03 repeat] coalesces exact repeats while preserving first creation and latest expression times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { db, service } = createTestService();
    const session = open(service, "repeat-user");

    for (let index = 0; index < 5; index += 1) {
      vi.setSystemTime(new Date(`2026-01-0${index + 1}T00:00:00.000Z`));
      const completed = service.completeTurn(`turn-apple-${index}`, {
        sessionId: session.sessionId,
        query: "我最喜欢的水果是苹果",
        answer: "好的。"
      });
      expect(completed.userMemoryIds).toHaveLength(1);
      expect(completed.l1MemoryIds).toEqual([]);
    }

    const rows = db.db.prepare(
      `SELECT source_turn_refs_json, created_at, updated_at, status
       FROM user_memories`
    ).all() as Array<{
      source_turn_refs_json: string;
      created_at: string;
      updated_at: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.source_turn_refs_json)).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-05T00:00:00.000Z",
      status: "active"
    });
    db.close();
  });

  it("does not recapture model-rejected L1 turns when a preference repeats in one session", async () => {
    const { db, service } = createTestService({
      llm: captureDecisionLlm([], {
        create_l1: false,
        l1_summary: "",
        create_user_memory: true,
        user_memory_types: ["User Preference"],
        user_memory_evidence: [{ quote: "我最喜欢的水果是苹果", type: "User Preference" }],
        reason: "durable preference without task evidence"
      })
    });
    const session = open(service, "model-repeat-user");

    for (let index = 0; index < 5; index += 1) {
      service.completeTurn(`turn-model-apple-${index}`, {
        sessionId: session.sessionId,
        query: "我最喜欢的水果是苹果",
        answer: "好的。"
      });
      await service.runWorkerOnce(20, { priorityCohortOnly: true });
    }

    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM memories`).get()).toEqual({ count: 5 });
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE status = 'deleted'`).get()).toEqual({ count: 5 });
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM memory_processing_state`).get()).toEqual({ count: 0 });
    expect(db.db.prepare(`SELECT COUNT(*) AS count FROM user_memories`).get()).toEqual({ count: 1 });
    expect(db.db.prepare(`SELECT json_array_length(source_turn_refs_json) AS count FROM user_memories`).get())
      .toEqual({ count: 5 });
    db.close();
  });

  it("uses this turn's recalled User Memory candidates to confirm a semantic repeat", async () => {
    let existingMemoryId = "";
    let sawCandidate = false;
    const { db, service } = createTestService({
      llm: captureDecisionRouterLlm((payload) => {
        const second = payload.includes("苹果是我最喜欢的水果");
        if (second) {
          sawCandidate = payload.includes(existingMemoryId) && payload.includes("我最喜欢的水果是苹果");
        }
        const quote = second ? "苹果是我最喜欢的水果" : "我最喜欢的水果是苹果";
        return {
          create_l1: false,
          l1_summary: "",
          policy_eligible: false,
          create_user_memory: true,
          user_memory_types: ["User Preference"],
          user_memory_evidence: [{ quote, type: "User Preference" }],
          user_memory_action: second ? "confirm_existing" : "create",
          matched_user_memory_id: second ? existingMemoryId : "",
          reason: second ? "same preference without information gain" : "new preference"
        };
      })
    });
    const session = open(service, "semantic-repeat-user");
    service.completeTurn("semantic-repeat-first", {
      sessionId: session.sessionId,
      query: "我最喜欢的水果是苹果",
      answer: "好的。"
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });
    existingMemoryId = (db.db.prepare(`SELECT id FROM user_memories`).get() as { id: string }).id;

    const started = await service.startTurn({
      sessionId: session.sessionId,
      turnId: "semantic-repeat-second",
      query: "苹果是我最喜欢的水果"
    });
    expect(started.sourceMemoryIds).not.toContain(existingMemoryId);
    service.completeTurn(started.turnId, {
      sessionId: session.sessionId,
      query: "苹果是我最喜欢的水果",
      answer: "好的。"
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(sawCandidate).toBe(true);
    expect(db.db.prepare(
      `SELECT id, content, json_array_length(source_turn_refs_json) AS source_count
       FROM user_memories`
    ).all()).toEqual([{
      id: existingMemoryId,
      content: "我最喜欢的水果是苹果",
      source_count: 2
    }]);
    db.close();
  });

  it("[BC-02 correction] uses the summary model to archive an explicitly corrected recalled User Memory", async () => {
    let appleMemoryId = "";
    let sawCorrectionCandidate = false;
    const original = "我在大学的时候最喜欢吃苹果，我现在爱看的书是《百年孤独》";
    const correction = "前面说错了，我在大学的时候最喜欢吃的是西瓜";
    const revised = "我在大学的时候最喜欢吃西瓜，我现在爱看的书是《百年孤独》";
    const { db, service } = createTestService({
      llm: captureDecisionRouterLlm((payload) => {
        const isCorrection = payload.includes(correction);
        if (isCorrection) {
          sawCorrectionCandidate = payload.includes(appleMemoryId) && payload.includes(original);
        }
        const quote = isCorrection ? correction : original;
        return {
          create_l1: isCorrection,
          l1_summary: isCorrection ? "用户纠正大学时最喜欢吃的水果为西瓜" : "",
          l1_evidence: isCorrection
            ? [{ quote: "前面说错了", source_role: "user", kind: "correction" }]
            : [],
          create_user_memory: true,
          user_memory_types: ["User Preference"],
          user_memory_evidence: [{ quote, type: "User Preference" }],
          user_memory_action: isCorrection ? "correct_existing" : "create",
          matched_user_memory_id: isCorrection ? appleMemoryId : "",
          corrected_user_memory_content: isCorrection ? revised : "",
          reason: isCorrection ? "explicit correction of one fact in the recalled preference" : "new preference"
        };
      })
    });
    const session = open(service, "automatic-correction-user");
    service.completeTurn("automatic-correction-apple", {
      sessionId: session.sessionId,
      query: original,
      answer: "好的。"
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });
    appleMemoryId = (db.db.prepare(`SELECT id FROM user_memories`).get() as { id: string }).id;

    const started = await service.startTurn({
      sessionId: session.sessionId,
      turnId: "automatic-correction-watermelon",
      query: correction
    });
    expect(started.sourceMemoryIds).not.toContain(appleMemoryId);
    service.completeTurn(started.turnId, {
      sessionId: session.sessionId,
      query: correction,
      answer: "已修正。"
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(sawCorrectionCandidate).toBe(true);
    const rows = db.db.prepare(
      `SELECT id, content, status, archive_reason, replaced_by_memory_id, replaces_memory_id
       FROM user_memories ORDER BY created_at, id`
    ).all() as Array<Record<string, string | null>>;
    const replacement = rows.find((row) => row.id !== appleMemoryId)!;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: appleMemoryId,
        status: "archived",
        archive_reason: "user_correction",
        replaced_by_memory_id: replacement.id
      }),
      expect.objectContaining({
        id: replacement.id,
        content: revised,
        status: "active",
        replaces_memory_id: appleMemoryId
      })
    ]));
    const evidence = service.recallEvidence(started.turnId);
    expect(evidence.diagnostics).toMatchObject({
      candidateMemoryIds: expect.arrayContaining([appleMemoryId]),
      injectedMemoryIds: expect.not.arrayContaining([appleMemoryId]),
      capture: {
        status: "completed",
        user_memory: {
          written: true,
          action: "corrected",
          memory_id: replacement.id,
          target_memory_id: appleMemoryId
        }
      }
    });
    expect((evidence.diagnostics.capture?.l1 as Array<Record<string, unknown>>)[0])
      .toMatchObject({ written: true, policy_eligible: true });
    db.close();
  });

  it("lists User Memory in its own panel layer with user isolation and search", () => {
    const { db, service } = createTestService();
    const session = open(service, "panel-user");
    service.completeTurn("turn-panel-user-memory", {
      sessionId: session.sessionId,
      query: "我最喜欢的水果是苹果",
      answer: "好的。"
    });

    const panel = service.panelItems({
      namespace: { source: "codex", profileId: "default", userId: "panel-user" },
      layer: "UserMemory",
      q: "苹果"
    });
    expect(panel).toMatchObject({ total: 1, page: 1 });
    expect(panel.items[0]).toMatchObject({
      kind: "user_memory",
      memoryLayer: "UserMemory",
      status: "activated",
      summary: "我最喜欢的水果是苹果",
      tags: ["User Preference"]
    });
    expect(service.panelItems({
      namespace: { source: "codex", profileId: "default", userId: "another-user" },
      layer: "UserMemory"
    }).items).toEqual([]);
    expect(service.panelOverviewSummary({
      namespace: { source: "codex", profileId: "default", userId: "panel-user" }
    }).counts.userMemories).toBe(1);
    expect(service.panelOverviewSummary({
      namespace: { source: "codex", profileId: "default", userId: "another-user" }
    }).counts.userMemories).toBe(0);
    db.close();
  });

  it("includes User Memory in search log candidates and statistics", async () => {
    const { db, service } = createTestService();
    const session = open(service, "user-memory-log-user");
    const completed = service.completeTurn("turn-user-memory-log", {
      sessionId: session.sessionId,
      query: "我比较喜欢定期清理服务器，让服务器保持简洁干净",
      answer: "好的。"
    });
    const userMemoryId = completed.userMemoryIds[0]!;

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "定期清理服务器",
      layers: ["L1"],
      limit: 5
    });

    expect(recall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: userMemoryId, memoryLayer: "UserMemory" })
    ]));
    const latestSearchLog = service.apiLogs({ tools: ["memory_search"], limit: 1 }).logs[0]!;
    const output = JSON.parse(latestSearchLog.outputJson) as {
      candidates: Array<{ refId: string; tier: string }>;
      filtered: Array<{ refId: string; tier: string }>;
      stats: {
        raw: number;
        ranked: number;
        finalReturned: number;
        llmFilter: { kept: number; dropped: number };
      };
    };
    expect(output.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: userMemoryId, tier: "UserMemory" })
    ]));
    expect(output.filtered).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: userMemoryId, tier: "UserMemory" })
    ]));
    expect(output.stats).toMatchObject({
      raw: 1,
      ranked: 1,
      finalReturned: 1,
      llmFilter: { kept: 1, dropped: 0 }
    });
    db.close();
  });

  it("limits the User Memory recall lane to the requested TopK", async () => {
    const { db, service } = createTestService();
    const session = open(service, "user-memory-top-k-user");
    for (let index = 0; index < 12; index += 1) {
      service.completeTurn(`turn-user-memory-top-k-${index}`, {
        sessionId: session.sessionId,
        query: `我喜欢共同关键词主题${index}`,
        answer: "好的。"
      });
    }

    await service.search({
      sessionId: session.sessionId,
      query: "共同关键词",
      layers: ["L1"],
      limit: 10
    });

    const latestSearchLog = service.apiLogs({ tools: ["memory_search"], limit: 1 }).logs[0]!;
    const output = JSON.parse(latestSearchLog.outputJson) as {
      candidates: Array<{ tier: string }>;
    };
    expect(output.candidates.filter((candidate) => candidate.tier === "UserMemory")).toHaveLength(10);
    db.close();
  });

  it("excludes User Memory from automatic injection for the current session's latest 8 turns", async () => {
    const { db, service } = createTestService();
    const session = open(service, "recent-user-memory-user");
    const completed = service.completeTurn("turn-recent-user-memory", {
      sessionId: session.sessionId,
      query: "我最喜欢的水果是苹果",
      answer: "好的。"
    });
    const userMemoryId = completed.userMemoryIds[0]!;

    const immediate = await service.search({
      sessionId: session.sessionId,
      query: "我最喜欢的水果",
      layers: ["L1"],
      retrievalMode: "turn_start",
      limit: 5
    });
    expect(immediate.hits.map((hit) => hit.id)).not.toContain(userMemoryId);

    const explicit = await service.search({
      sessionId: session.sessionId,
      query: "我最喜欢的水果",
      layers: ["L1"],
      limit: 5
    });
    expect(explicit.hits.map((hit) => hit.id)).toContain(userMemoryId);

    const otherSession = service.openSession({
      sessionId: "session-recent-user-memory-other",
      namespace: { source: "codex", profileId: "default", userId: "recent-user-memory-user" }
    });
    const crossSession = await service.search({
      sessionId: otherSession.sessionId,
      query: "我最喜欢的水果",
      layers: ["L1"],
      retrievalMode: "turn_start",
      limit: 5
    });
    expect(crossSession.hits.map((hit) => hit.id)).toContain(userMemoryId);

    for (let index = 0; index < 8; index += 1) {
      service.completeTurn(`turn-after-user-memory-${index}`, {
        sessionId: session.sessionId,
        query: "好的",
        answer: "好的。"
      });
    }
    const afterEightNewerTurns = await service.search({
      sessionId: session.sessionId,
      query: "我最喜欢的水果",
      layers: ["L1"],
      retrievalMode: "turn_start",
      limit: 5
    });
    expect(afterEightNewerTurns.hits.map((hit) => hit.id)).toContain(userMemoryId);
    db.close();
  });

  it("[BC-02 correction] archives only the targeted User Memory on explicit correction", () => {
    const { db, service } = createTestService();
    const session = open(service, "correction-user");
    const apple = service.completeTurn("turn-apple", {
      sessionId: session.sessionId,
      query: "我最喜欢的水果是苹果",
      answer: "好的。"
    });
    const appleId = apple.userMemoryIds[0]!;

    const corrected = service.completeTurn("turn-watermelon-correction", {
      sessionId: session.sessionId,
      query: "前面说错了，我最喜欢的水果是西瓜",
      answer: "已修正。",
      userMemoryCorrection: {
        targetMemoryId: appleId,
        revisedContent: "我最喜欢的水果是西瓜"
      }
    });

    expect(corrected.userMemoryIds).toHaveLength(1);
    expect(corrected.l1MemoryIds).toEqual([]);
    const rows = db.db.prepare(
      `SELECT id, content, status, archive_reason, replaced_by_memory_id, replaces_memory_id
       FROM user_memories ORDER BY created_at, id`
    ).all() as Array<Record<string, string | null>>;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: appleId,
        status: "archived",
        archive_reason: "user_correction",
        replaced_by_memory_id: corrected.userMemoryIds[0]
      }),
      expect.objectContaining({
        id: corrected.userMemoryIds[0],
        content: "我最喜欢的水果是西瓜",
        status: "active",
        replaces_memory_id: appleId
      })
    ]));
    db.close();
  });

  it("[BC-02 current change] keeps both active memories when the user describes a new current state", async () => {
    let appleMemoryId = "";
    let sawHistoricalCandidate = false;
    const { db, service } = createTestService({
      llm: captureDecisionRouterLlm((payload) => {
        const current = payload.includes("我现在最喜欢的水果是西瓜");
        if (current) {
          sawHistoricalCandidate = payload.includes(appleMemoryId) && payload.includes("我最喜欢的水果是苹果");
        }
        const quote = current ? "我现在最喜欢的水果是西瓜" : "我最喜欢的水果是苹果";
        return {
          create_l1: false,
          l1_summary: "",
          policy_eligible: false,
          create_user_memory: true,
          user_memory_types: ["User Preference"],
          user_memory_evidence: [{ quote, type: "User Preference" }],
          user_memory_action: "create",
          matched_user_memory_id: "",
          reason: current ? "new current state that preserves history" : "new preference"
        };
      })
    });
    const session = open(service, "time-change-user");
    service.completeTurn("turn-old-favorite", {
      sessionId: session.sessionId,
      query: "我最喜欢的水果是苹果",
      answer: "好的。"
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });
    appleMemoryId = (db.db.prepare(`SELECT id FROM user_memories`).get() as { id: string }).id;
    const started = await service.startTurn({
      sessionId: session.sessionId,
      turnId: "turn-current-favorite",
      query: "我现在最喜欢的水果是西瓜"
    });
    expect(started.sourceMemoryIds).not.toContain(appleMemoryId);
    service.completeTurn(started.turnId, {
      sessionId: session.sessionId,
      query: "我现在最喜欢的水果是西瓜",
      answer: "好的。"
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });

    expect(sawHistoricalCandidate).toBe(true);
    expect(db.db.prepare(
      `SELECT content FROM user_memories WHERE status = 'active' ORDER BY created_at, id`
    ).all()).toEqual(expect.arrayContaining([
      { content: "我最喜欢的水果是苹果" },
      { content: "我现在最喜欢的水果是西瓜" }
    ]));
    const recall = await service.search({
      sessionId: session.sessionId,
      query: "我最喜欢的水果是什么？",
      layers: ["L1"],
      limit: 5,
      includeInjectedContext: true
    });
    const userHits = recall.hits.filter((hit) => hit.memoryLayer === "UserMemory");
    expect(userHits.map((hit) => hit.snippet)).toEqual(expect.arrayContaining([
      "我最喜欢的水果是苹果",
      "我现在最喜欢的水果是西瓜"
    ]));
    expect(recall.injectedContext.markdown).toContain("## User Memories");
    expect(recall.injectedContext.markdown).not.toContain("## L1 Trace Memories");
    expect(recall.injectedContext.markdown).toContain(
      "Historical user statement:\n   我现在最喜欢的水果是西瓜"
    );
    expect(recall.injectedContext.markdown).toContain("created at:");
    expect(recall.injectedContext.markdown).toContain("updated at:");
    expect(recall.injectedContext.markdown).not.toContain("timestamp:");
    expect(recall.injectedContext.markdown).not.toContain("source turn:");
    expect(recall.injectedContext.markdown).not.toContain("raw_");
    db.close();
  });

  it("[BC-28] stores a compound user statement as one record and no L1", async () => {
    const { db, service } = createTestService();
    const session = open(service, "compound-user");
    const content = "我在大学的时候最喜欢吃苹果，我现在爱看的书是《百年孤独》";
    const completed = service.completeTurn("turn-compound", {
      sessionId: session.sessionId,
      query: content,
      answer: "好的。"
    });
    await service.runWorkerOnce(20);

    expect(completed.userMemoryIds).toHaveLength(1);
    expect(completed.l1MemoryIds).toEqual([]);
    expect(db.db.prepare(`SELECT content FROM user_memories`).all()).toEqual([{ content }]);
    for (const query of ["大学时喜欢吃的水果", "现在爱看的书"]) {
      const recall = await service.search({
        sessionId: session.sessionId,
        query,
        layers: ["L1"],
        limit: 3
      });
      expect(recall.hits).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: completed.userMemoryIds[0], memoryLayer: "UserMemory" })
      ]));
    }
    db.close();
  });

  it("[BC-25] independently creates User Memory and L1, then merges them by source turn", async () => {
    const { db, service } = createTestService();
    const session = open(service, "same-turn-user");
    const completed = service.completeTurn("turn-code-feedback", {
      sessionId: session.sessionId,
      query: "你刚才写了很多兜底代码，我更喜欢简洁的代码，以后不要写不必要的兜底代码",
      answer: "已精简实现并通过测试。"
    });
    await service.runWorkerOnce(50);

    expect(completed.userMemoryIds).toHaveLength(1);
    expect(completed.l1MemoryIds).toHaveLength(1);
    const userMemoryId = completed.userMemoryIds[0]!;
    const l1MemoryId = completed.l1MemoryIds[0]!;
    const userMemory = db.db.prepare(
      `SELECT source_turn_id FROM user_memories WHERE id = ?`
    ).get(userMemoryId) as { source_turn_id: string };
    const l1 = db.db.prepare(
      `SELECT json_extract(properties_json, '$.internal_info.source_raw_turn_id') AS source_turn_id
       FROM memories WHERE id = ?`
    ).get(l1MemoryId) as { source_turn_id: string };
    expect(userMemory.source_turn_id).toBe(l1.source_turn_id);

    const recall = await service.search({
      sessionId: session.sessionId,
      turnId: "agent-turn-code-feedback",
      query: "简洁代码 不必要兜底代码",
      layers: ["L1"],
      limit: 5,
      includeInjectedContext: true
    });
    const sameTurnHit = recall.hits.find((hit) => hit.sourceTurnId === userMemory.source_turn_id);
    expect(sameTurnHit?.memberMemoryIds).toEqual(expect.arrayContaining([
      userMemoryId,
      l1MemoryId
    ]));
    expect(sameTurnHit?.retrievalRoutes).toEqual(["user_memory", "l1"]);
    const sameTurnSections = recall.injectedContext.sections.filter((section) =>
      section.memoryIds.includes(userMemoryId) ||
      section.memoryIds.includes(l1MemoryId)
    );
    expect(sameTurnSections).toHaveLength(2);
    expect(sameTurnSections.find((section) => section.memoryLayer === "UserMemory")?.memoryIds)
      .toEqual([userMemoryId]);
    expect(sameTurnSections.find((section) => section.memoryLayer === "L1")?.memoryIds)
      .toEqual([l1MemoryId]);
    expect(recall.injectedContext.markdown).toContain("## User Memories");
    expect(recall.injectedContext.markdown).toContain("## L1 Trace Memories");
    expect(recall.injectedContext.markdown).toContain(`1. ${userMemoryId}`);
    expect(recall.injectedContext.markdown).toContain(`1. ${l1MemoryId}`);
    expect(recall.injectedContext.markdown).not.toContain(`id: ${userMemoryId}`);
    expect(recall.injectedContext.markdown).not.toContain(`id: ${l1MemoryId}`);
    expect(recall.injectedContext.markdown).toContain("Historical user statement:");
    expect(recall.injectedContext.markdown).not.toContain("source turn:");

    const event = db.db.prepare(
      `SELECT query_id, user_memory_candidate_ids_json, l1_candidate_ids_json,
              merged_source_turn_ids_json, member_memory_ids_by_source_turn_id_json
       FROM recall_events WHERE id = ?`
    ).get(recall.searchEventId) as Record<string, string>;
    expect(event.query_id).toBeTruthy();
    expect(JSON.parse(event.user_memory_candidate_ids_json!)).toContain(userMemoryId);
    expect(JSON.parse(event.l1_candidate_ids_json!)).toContain(l1MemoryId);
    expect(JSON.parse(event.merged_source_turn_ids_json!)).toContain(userMemory.source_turn_id);
    expect(JSON.parse(event.member_memory_ids_by_source_turn_id_json!)[userMemory.source_turn_id])
      .toEqual(expect.arrayContaining([userMemoryId, l1MemoryId]));
    const evidence = service.recallEvidence("agent-turn-code-feedback", {
      namespace: {
        source: "codex",
        userId: "same-turn-user",
        profileId: "default"
      }
    });
    expect(evidence.hits).toHaveLength(1);
    expect(evidence.hits[0]?.members?.map((member) => member.id)).toEqual(
      expect.arrayContaining([userMemoryId, l1MemoryId])
    );
    service.deleteMemory(userMemoryId, {
      namespace: { source: "codex", userId: "same-turn-user", profileId: "default" }
    });
    const evidenceAfterUserMemoryDelete = service.recallEvidence("agent-turn-code-feedback", {
      namespace: { source: "codex", userId: "same-turn-user", profileId: "default" }
    });
    expect(evidenceAfterUserMemoryDelete.hits[0]?.members?.map((member) => member.id)).toEqual([l1MemoryId]);

    service.deleteMemory(l1MemoryId, {
      namespace: { source: "codex", userId: "same-turn-user", profileId: "default" }
    });
    expect(service.recallEvidence("agent-turn-code-feedback", {
      namespace: { source: "codex", userId: "same-turn-user", profileId: "default" }
    }).hits).toEqual([]);
    db.close();
  });

  it("[BC-04][BC-05] keeps device observations in L1 and current weather out of long-lived memory", async () => {
    const { db, service } = createTestService();
    const session = open(service, "dynamic-fact-user");
    const hardware = service.completeTurn("turn-hardware", {
      sessionId: session.sessionId,
      query: "我的电脑内存多大？",
      answer: "工具读取结果是 16 GB。",
      toolCalls: [{ name: "system_info", input: { field: "memory" } }],
      toolResults: [{ totalMemory: "16 GB" }]
    });
    const weather = service.completeTurn("turn-weather", {
      sessionId: session.sessionId,
      query: "上海今天天气怎么样？",
      answer: "当前是晴天。",
      toolCalls: [{ name: "weather", input: { city: "上海" } }],
      toolResults: [{ condition: "晴" }]
    });

    expect(hardware.userMemoryIds).toEqual([]);
    expect(hardware.l1MemoryIds).toHaveLength(1);
    const hardwareRow = db.db.prepare(
      `SELECT memory_key, json_extract(info_json, '$.scope_key') AS scope_key,
              json_extract(info_json, '$.evidence_status') AS evidence_status,
              json_extract(info_json, '$.policy_eligible') AS policy_eligible
       FROM memories WHERE id = ?`
    ).get(hardware.l1MemoryIds[0]) as Record<string, unknown>;
    expect(hardwareRow).toMatchObject({
      memory_key: "trace:environment:device:local:default:device.total_memory",
      scope_key: "device:local:default",
      evidence_status: "verified",
      policy_eligible: 0
    });
    expect(weather.userMemoryIds).toEqual([]);
    expect(weather.l1MemoryIds).toEqual([]);
    expect(rowCount(db, "raw_turns")).toBe(2);
    const recall = await service.search({
      sessionId: session.sessionId,
      query: "上海当前天气怎么样？",
      layers: ["L1"],
      limit: 5
    });
    expect(recall.hits).toEqual([]);
    expect(recall.status).toContain("dynamic_current:refresh_required");
    db.close();
  });

  it("[BC-04 update] updates a device observation in place when the same scoped fact changes", () => {
    const { db, service } = createTestService();
    const session = open(service, "hardware-update-user");
    const first = service.completeTurn("turn-hardware-16", {
      sessionId: session.sessionId,
      query: "我的电脑内存多大？",
      answer: "工具读取结果是 16 GB。",
      toolCalls: [{ name: "system_info", input: { field: "memory" } }],
      toolResults: [{ totalMemory: "16 GB" }]
    });
    const second = service.completeTurn("turn-hardware-32", {
      sessionId: session.sessionId,
      query: "我的电脑内存多大？",
      answer: "工具读取结果是 32 GB。",
      toolCalls: [{ name: "system_info", input: { field: "memory" } }],
      toolResults: [{ totalMemory: "32 GB" }]
    });

    expect(second.l1MemoryIds).toEqual(first.l1MemoryIds);
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM memories
       WHERE memory_key = 'trace:environment:device:local:default:device.total_memory'`
    ).get()).toEqual({ count: 1 });
    expect((db.db.prepare(`SELECT memory_value FROM memories WHERE id = ?`).get(first.l1MemoryIds[0]) as {
      memory_value: string;
    }).memory_value).toContain("32 GB");
    db.close();
  });

  it("[BC-27 management] deletes only the selected branch of a same-turn pair", async () => {
    const { db, service } = createTestService();
    const session = open(service, "delete-user");
    const completed = service.completeTurn("turn-delete-pair", {
      sessionId: session.sessionId,
      query: "你刚才的实现兜底太多，我以后更喜欢简洁代码，不要再写不必要的兜底代码",
      answer: "已按要求修改。"
    });
    await service.runWorkerOnce(50);

    service.deleteMemory(completed.userMemoryIds[0]!, {
      namespace: { source: "codex", profileId: "default", userId: "delete-user" }
    });
    expect(db.db.prepare(`SELECT status FROM user_memories WHERE id = ?`).get(completed.userMemoryIds[0]))
      .toEqual({ status: "deleted" });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(completed.l1MemoryIds[0]))
      .toEqual({ status: "activated" });

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "简洁代码 不必要兜底",
      layers: ["L1"],
      limit: 5
    });
    expect(recall.hits.flatMap((hit) => hit.memberMemoryIds ?? [hit.id]))
      .not.toContain(completed.userMemoryIds[0]);
    expect(recall.hits.flatMap((hit) => hit.memberMemoryIds ?? [hit.id]))
      .toContain(completed.l1MemoryIds[0]);
    db.close();
  });
});

function open(service: ReturnType<typeof createTestService>["service"], userId: string) {
  return service.openSession({
    namespace: { source: "codex", profileId: "default", userId }
  });
}

function rowCount(db: ReturnType<typeof createTestService>["db"], table: string): number {
  return (db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

type LegacyCaptureDecision = {
  create_l1: boolean;
  l1_summary: string;
  policy_eligible?: boolean;
  create_user_memory: boolean;
  user_memory_types: string[];
  user_memory_evidence?: unknown[];
  user_memory_action?: "none" | "create" | "confirm_existing" | "correct_existing";
  matched_user_memory_id?: string;
  corrected_user_memory_content?: string;
  l1_evidence?: unknown[];
  reason: string;
};

function captureDecisionLlm(calls: string[], decision: LegacyCaptureDecision): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/summary-model",
      model: "summary-model"
    },
    isConfigured: () => true,
    complete: async () => "unused",
    async completeJson<T extends Record<string, unknown>>(
      _messages: LlmMessage[],
      options: LlmCompletionOptions
    ): Promise<T> {
      calls.push(options.operation);
      if (options.operation === "capture.summarize") return compactCaptureDecision(decision) as T;
      return { summary: decision.l1_summary } as unknown as T;
    },
    status: () => ({
      provider: "host",
      model: "summary-model",
      configured: true,
      remote: true
    })
  };
}

function captureDecisionRouterLlm(
  decide: (payload: string) => LegacyCaptureDecision
): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/summary-model-router",
      model: "summary-model-router"
    },
    isConfigured: () => true,
    complete: async () => "unused",
    async completeJson<T extends Record<string, unknown>>(
      messages: LlmMessage[],
      options: LlmCompletionOptions
    ): Promise<T> {
      if (options.operation !== "capture.summarize") return { summary: "" } as unknown as T;
      return compactCaptureDecision(
        decide(messages.find((message) => message.role === "user")?.content ?? "")
      ) as T;
    },
    status: () => ({
      provider: "host",
      model: "summary-model-router",
      configured: true,
      remote: true
    })
  };
}

function compactCaptureDecision(decision: LegacyCaptureDecision): Record<string, unknown> {
  const l1Evidence = (decision.l1_evidence ?? []).map((item) => {
    const evidence = item as Record<string, unknown>;
    return {
      quote: evidence.quote,
      role: evidence.source_role,
      kind: evidence.kind
    };
  });
  const action = decision.user_memory_action === "confirm_existing"
    ? "confirm"
    : decision.user_memory_action === "correct_existing"
      ? "correct"
      : "create";
  return {
    l1: decision.create_l1 ? {
      summary: decision.l1_summary,
      evidence: l1Evidence
    } : null,
    user: decision.create_user_memory ? {
      action,
      evidence: decision.user_memory_evidence ?? [],
      target: decision.matched_user_memory_id ?? "",
      replacement: decision.corrected_user_memory_content ?? ""
    } : null
  };
}
