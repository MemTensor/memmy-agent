import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type LlmClient
} from "../../../src/index.js";
import {
  createBatchReflectionLlm,
  createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

function createEmptyRewardSummaryLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: { operation: string };
}>): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/empty-reward-summary",
      model: "empty-reward-summary"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      calls.push({ messages, options });
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "empty-reward-summary",
        configured: true,
        remote: true
      };
    }
  };
}

function createCapturingRewardSummaryLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: {
    operation: string;
    thinkingMode?: "inherit" | "enabled" | "disabled";
    maxTokens?: number;
  };
}>): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/reward-summary-capturing",
      model: "reward-summary-capturing"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: {
        operation: string;
        thinkingMode?: "inherit" | "enabled" | "disabled";
        maxTokens?: number;
      }
    ): Promise<T> {
      calls.push({ messages, options });
      if (options.operation === "reward.reward.r_human.v7") {
        return {
          goal_achievement: 1,
          process_quality: 0.5,
          user_satisfaction: 0,
          label: "partial",
          reason: "weighted rubric accepted the goal but process was partial"
        } as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "reward-summary-capturing",
        configured: true,
        remote: true
      };
    }
  };
}

describe("MemoryService / evolution / reward", () => {
  it("queues neutral episode reward after session close without L2 evolution", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-implicit-reward"
      }
    });

    const complete = service.completeTurn("turn-implicit-reward", {
      sessionId: session.sessionId,
      query: "finish the migration scaffold with durable sqlite state and a worker queue",
      answer: "implemented the service scaffold, sqlite schema, raw turn capture, and asynchronous worker queue"
    });
    expect(complete.jobs.map((job) => job.jobType)).toEqual(["trace_summary", "episode_idle_close"]);

    const rewardBeforeClose = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'reward'
         AND episode_id = ?`
    ).get(complete.episodeId) as { count: number };
    expect(rewardBeforeClose.count).toBe(0);

    service.closeSession(session.sessionId);

    const queuedReflection = db.db.prepare(
      `SELECT target_memory_id, payload_json
       FROM evolution_jobs
       WHERE job_type = 'reflection'
         AND episode_id = ?`
    ).get(complete.episodeId) as { target_memory_id: string | null; payload_json: string } | undefined;
    expect(queuedReflection?.target_memory_id).toBe(complete.l1MemoryId);
    expect(JSON.parse(queuedReflection!.payload_json)).toMatchObject({
      trigger: "session_closed",
      targetKind: "episode"
    });
    const queuedRewardBeforeReflection = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'reward'
         AND episode_id = ?`
    ).get(complete.episodeId) as { count: number };
    expect(queuedRewardBeforeReflection.count).toBe(0);
    const queuedEvolutionBeforeReward = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type IN ('l2_association', 'l2_induction')
         AND episode_id = ?`
    ).get(complete.episodeId) as { count: number };
    expect(queuedEvolutionBeforeReward.count).toBe(0);
    const l1TargetedDownstream = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type IN ('l3_abstraction', 'skill_crystallization')
         AND target_memory_id = ?`
    ).get(complete.l1MemoryId) as { count: number };
    expect(l1TargetedDownstream.count).toBe(0);

    const queuedOrder = service.panelJobs({
      userId: "user-implicit-reward",
      status: "queued"
    }).items.map((job) => job.jobType);
    expect(queuedOrder.slice(0, 2)).toEqual(["trace_summary", "episode_idle_close"]);

    const run = await service.runWorkerOnce(20);
    expect(run.changeSeq).toBeGreaterThan(0);
    expect(run.syncCursor.startsWith("cur_")).toBe(true);
    expect(run.jobs.map((job) => job.jobType)).toContain("reflection");
    expect(run.jobs.map((job) => job.jobType)).not.toContain("reward");

    const queuedL2EvolutionAfterReward = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type IN ('l2_association', 'l2_induction')
         AND episode_id = ?`
    ).get(complete.episodeId) as { count: number };
    expect(queuedL2EvolutionAfterReward.count).toBe(0);
    const queuedReward = db.db.prepare(
      `SELECT target_memory_id, payload_json
       FROM evolution_jobs
       WHERE job_type = 'reward'
         AND episode_id = ?`
    ).get(complete.episodeId) as { target_memory_id: string | null; payload_json: string } | undefined;
    expect(queuedReward?.target_memory_id).toBeNull();
    const rewardPayload = JSON.parse(queuedReward!.payload_json) as Record<string, unknown>;
    expect(rewardPayload).toMatchObject({
      l1MemoryId: complete.l1MemoryId,
      trigger: "implicit_fallback",
      targetKind: "episode"
    });
    expect(typeof rewardPayload.runAfter).toBe("string");
    db.close();
  });

  it("waits until episode close and scores every trace exactly once", async () => {
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const { db, service } = createTestService({
      llm: createBatchReflectionLlm(calls),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: true
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-reward-before-reflection"
      }
    });
    const firstQuery = `我喜欢吃的水果是西瓜，${"这是需要保留的较长用户补充说明。".repeat(12)}`;
    const first = service.completeTurn("turn-reward-before-reflection-1", {
      sessionId: session.sessionId,
      episodeId: "episode-reward-before-reflection",
      query: firstQuery,
      answer: "记住了，你喜欢吃的水果是西瓜。"
    });
    const second = service.completeTurn("turn-reward-before-reflection-2", {
      sessionId: session.sessionId,
      episodeId: first.episodeId,
      query: "水果中和西瓜比较相似有哪些，推荐一个",
      answer: "我推荐哈密瓜。"
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: second.episodeId,
      l1MemoryId: second.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "我不是只让你推荐一个吗"
    });
    await service.runWorkerOnce(20);
    const openEpisode = db.db.prepare(
      `SELECT r_task
       FROM episodes
       WHERE id = ?`
    ).get(first.episodeId) as { r_task: number | null };
    expect(openEpisode.r_task).toBeNull();
    expect(calls.filter((call) => call.options.operation === "reward.reward.r_human.v7")).toEqual([]);
    expect(calls.filter((call) => call.options.operation === "capture.summarize")).toHaveLength(2);

    const third = service.completeTurn("turn-reward-before-reflection-3", {
      sessionId: session.sessionId,
      episodeId: first.episodeId,
      query: "哈密瓜和西瓜谁的营养价值更高",
      answer: "综合营养密度上哈密瓜通常更高一点。"
    });

    service.closeSession(session.sessionId);
    const queuedReflection = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'reflection'
         AND episode_id = ?`
    ).get(first.episodeId) as { count: number };
    expect(queuedReflection.count).toBe(1);

    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    const reflectedItems = service.panelItems({
      userId: "user-reward-before-reflection",
      layer: "L1"
    }).items.filter((item) => [first.l1MemoryId, second.l1MemoryId, third.l1MemoryId].includes(item.id));
    expect(reflectedItems).toHaveLength(3);
    expect(reflectedItems.every((item) => item.metrics?.reflectionDone)).toBe(true);
    expect(calls.some((call) => call.options.operation === "capture.reflection.batch.v13")).toBe(true);
    const rewardCalls = calls.filter((call) => call.options.operation === "reward.reward.r_human.v7");
    expect(rewardCalls).toHaveLength(1);
    const rewardInput = JSON.parse(
      rewardCalls[0]!.messages.find((message) => message.role === "user")!.content
    ) as {
      turnSummaries: string[];
      finalExchange: { user: string; assistant: string };
      feedbackHistory: Array<{ polarity: string }>;
    };
    expect(rewardInput.turnSummaries).toHaveLength(3);
    expect(rewardInput.finalExchange).toEqual({
      user: "哈密瓜和西瓜谁的营养价值更高",
      assistant: "综合营养密度上哈密瓜通常更高一点。"
    });
    expect(rewardInput.feedbackHistory).toEqual([
      expect.objectContaining({ polarity: "negative" })
    ]);
    const rewarded = db.db.prepare(
      `SELECT r_task, reward_detail_json
       FROM episodes
       WHERE id = ?`
    ).get(first.episodeId) as { r_task: number | null; reward_detail_json: string };
    expect(typeof rewarded.r_task).toBe("number");
    expect(JSON.parse(rewarded.reward_detail_json)).toMatchObject({
      phase: "final",
      traceCount: 3,
      traceIds: [first.l1MemoryId, second.l1MemoryId, third.l1MemoryId]
    });
    db.close();
  });

  it("keeps negative rewarded traces out of L2 positive evolution", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-negative-l2"
      }
    });
    const complete = service.completeTurn("turn-negative-l2", {
      sessionId: session.sessionId,
      query: "fix the sqlite migration by reading the error first",
      answer: "I retried the same command without reading the error."
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "This repeated the same failing command."
    });
    service.closeSession(session.sessionId);

    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);

    const memory = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(memory.properties_json) as {
      internal_info: { trace: { value?: number; priority?: number; r_human?: number } };
    }).internal_info.trace;
    expect(trace.value).toBeLessThan(0);
    expect(trace.priority).toBe(0);
    expect(trace.r_human).toBeLessThan(0);

    const l2Jobs = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE episode_id = ?
         AND job_type IN ('l2_association', 'l2_induction')`
    ).get(complete.episodeId) as { count: number };
    expect(l2Jobs.count).toBe(0);
    db.close();
  });

  it("does not schedule implicit reward for a chitchat-only episode", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-trivial-reward"
      }
    });

    const complete = service.completeTurn("turn-trivial-reward", {
      sessionId: session.sessionId,
      query: "hi",
      answer: "ok"
    });
    expect(complete.l1MemoryId).toBe("");
    expect(complete.l1MemoryIds).toEqual([]);
    service.closeSession(session.sessionId);
    await service.runWorkerOnce(20);

    const episode = db.db.prepare(
      `SELECT meta_json
       FROM episodes
       WHERE id = ?`
    ).get(complete.episodeId) as { meta_json: string };
    const meta = JSON.parse(episode.meta_json) as {
      closeReason?: string;
      abandonReason?: string;
      reward?: {
        skipped?: boolean;
        rHuman?: number;
        reason?: string;
        trigger?: string;
      };
    };
    expect(meta.closeReason).toBeUndefined();
    expect(meta.reward).toBeUndefined();
    const queuedReward = db.db.prepare(
      `SELECT payload_json
       FROM evolution_jobs
       WHERE episode_id = ?
         AND job_type = 'reward'
         AND status = 'queued'`
    ).get(complete.episodeId) as { payload_json: string } | undefined;
    expect(queuedReward).toBeUndefined();

    const rewardUpdates = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_change_log
       WHERE memory_id = ?
         AND change_type = 'reward_update'`
    ).get(complete.l1MemoryId) as { count: number };
    expect(rewardUpdates.count).toBe(0);
    db.close();
  });

  it("falls back to explicit feedback when the reward LLM returns an empty object", async () => {
    const root = createTestRoot("mindock-memory-empty-reward-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const rewardCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createEmptyRewardSummaryLlm(rewardCalls),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            synthReflection: false,
            embedAfterCapture: false,
            alphaScoring: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-empty-reward"
      }
    });
    const complete = service.completeTurn("turn-empty-reward", {
      sessionId: session.sessionId,
      episodeId: "episode-empty-reward",
      query: "verify the focused workflow",
      answer: "The focused workflow passed."
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted"
    });

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);

    expect(rewardCalls.some((call) => call.options.operation === "reward.reward.r_human.v7")).toBe(true);
    const memory = db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(memory.properties_json) as {
      internal_info: { trace: { value: number; r_human?: number; reward_reason?: string } };
    }).internal_info.trace;
    expect(trace.r_human).toBe(1);
    expect(trace.value).toBe(1);
    expect(trace.reward_reason).toContain("heuristic explicit");
    const episode = db.db.prepare(
      `SELECT r_task, reward_detail_json FROM episodes WHERE id = ?`
    ).get(complete.episodeId) as { r_task: number; reward_detail_json: string };
    const rewardDetail = JSON.parse(episode.reward_detail_json) as {
      source?: string;
      rHuman?: number;
    };
    expect(episode.r_task).toBe(1);
    expect(rewardDetail).toMatchObject({ source: "explicit", rHuman: 1 });
    db.close();
  });

  it("scores R_human with the summary LLM, thinking disabled, and stores episode reward meta", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const rewardCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: {
        operation: string;
        thinkingMode?: "inherit" | "enabled" | "disabled";
        maxTokens?: number;
      };
    }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createCapturingRewardSummaryLlm(rewardCalls),
      skillLlm: createBatchReflectionLlm([], "reflected reward summary"),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            synthReflection: false,
            embedAfterCapture: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-reward-llm"
      }
    });
    service.completeTurn("turn-reward-llm-1", {
      sessionId: session.sessionId,
      episodeId: "episode-reward-llm",
      query: "verify reward scoring prompt",
      answer: "prepared the requested scoring workflow",
      toolCalls: [{
        name: "web.search",
        input: { q: "reward prompt" },
        output: "ok",
        success: true
      }]
    });
    const complete = service.completeTurn("turn-reward-llm-2", {
      sessionId: session.sessionId,
      episodeId: "episode-reward-llm",
      query: "now summarize the final reward result",
      answer: "summarized the final reward result"
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted, but process was only partial"
    });
    service.closeSession(session.sessionId);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);

    const rewardCall = rewardCalls.find((call) => call.options.operation === "reward.reward.r_human.v7");
    expect(rewardCall).toBeTruthy();
    expect(rewardCall!.options.thinkingMode).toBe("disabled");
    expect(rewardCall!.options.maxTokens).toBe(700);
    expect(rewardCall!.messages[0]!.content).toContain("REWARD_INPUT JSON");
    expect(rewardCall!.messages[0]!.content).toContain("turnSummaries");
    expect(rewardCall!.messages[0]!.content).not.toContain("TASK_SUMMARY");
    expect(rewardCall!.messages[0]!.content).not.toContain("USER_ASKS_AND_AGENT_REPLIES");
    const rewardInput = JSON.parse(rewardCall!.messages[1]!.content) as {
      mission: string;
      turnSummaries: string[];
      finalExchange: { user: string; assistant: string };
      execution: {
        totalToolCalls: number;
        successCount: number;
        errorCount: number;
        lastResult: string;
        completedByTool: string;
        lastTool?: string;
      };
      feedback?: Record<string, unknown>;
      host?: Record<string, unknown>;
    };
    expect(rewardInput).toEqual({
      mission: "verify reward scoring prompt",
      turnSummaries: [
        "verify reward scoring prompt",
        "now summarize the final reward result"
      ],
      finalExchange: {
        user: "now summarize the final reward result",
        assistant: "summarized the final reward result"
      },
      execution: {
        totalToolCalls: 1,
        successCount: 1,
        errorCount: 0,
        lastResult: "success",
        completedByTool: "yes",
        lastTool: "web.search"
      },
      feedback: {
        channel: "explicit",
        polarity: "positive",
        magnitude: 1,
        rationale: "accepted, but process was only partial"
      },
      feedbackHistory: [{
        channel: "explicit",
        polarity: "positive",
        magnitude: 1,
        rationale: "accepted, but process was only partial"
      }],
      host: {
        agent: "codex"
      }
    });
    expect(rewardCall!.messages[1]!.content).not.toContain("\"q\":\"reward prompt\"");
    expect(rewardCall!.messages[1]!.content).not.toContain("\"output\":\"ok\"");
    expect(rewardCall!.messages[1]!.content).not.toContain("reward-summary-capturing");
    expect(rewardCall!.messages[1]!.content).not.toContain(complete.l1MemoryId);
    expect(rewardCall!.messages[1]!.content).not.toContain("feedbackId");
    expect(rewardCall!.messages[1]!.content).not.toContain("repairId");
    expect(rewardCall!.messages[1]!.content).not.toContain("targetKind");
    expect(rewardCall!.messages[1]!.content).not.toContain("runAfter");
    expect(rewardCall!.messages[1]!.content).not.toContain("downstreamScheduled");
    expect(rewardCall!.messages[1]!.content).not.toContain("trigger");

    const memory = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const trace = (JSON.parse(memory.properties_json) as {
      internal_info: {
        trace: {
          r_human?: number;
          reward_reason?: string;
        };
      };
    }).internal_info.trace;
    expect(trace.r_human).toBeCloseTo(0.6);
    expect(trace.reward_reason).toContain("weighted rubric");

    const episode = db.db.prepare(
      `SELECT meta_json, r_task, reward_detail_json
       FROM episodes
       WHERE id = ?`
    ).get(complete.episodeId) as {
      meta_json: string;
      r_task: number | null;
      reward_detail_json: string;
    };
    const meta = JSON.parse(episode.meta_json) as {
      reward?: {
        source?: string;
        rHuman?: number;
        axes?: {
          goalAchievement?: number;
          processQuality?: number;
          userSatisfaction?: number;
        };
      };
    };
    expect(meta.reward?.source).toBe("llm");
    expect(meta.reward?.rHuman).toBeCloseTo(0.6);
    expect(meta.reward?.axes?.processQuality).toBeCloseTo(0.5);
    const rewardDetail = JSON.parse(episode.reward_detail_json) as {
      source?: string;
      rHuman?: number;
      axes?: {
        processQuality?: number;
      };
    };
    expect(episode.r_task).toBeCloseTo(0.6);
    expect(rewardDetail.source).toBe("llm");
    expect(rewardDetail.rHuman).toBeCloseTo(0.6);
    expect(rewardDetail.axes?.processQuality).toBeCloseTo(0.5);

    db.close();
  });

  it("attributes episode-level feedback to the latest L1 trace for reward backpropagation", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-feedback-attribution"
      }
    });
    const complete = service.completeTurn("turn-feedback-attribution", {
      sessionId: session.sessionId,
      episodeId: "episode-feedback-attribution",
      query: "Configure nginx TLS for the service and verify the port.",
      answer: "I configured the listener on port 80 and skipped the TLS verification step."
    });

    const feedback = await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, use port 443 instead and verify TLS"
    });

    expect(feedback.jobs.map((job) => job.jobType)).not.toContain("reward");
    const feedbackRow = db.db.prepare(
      `SELECT l1_memory_id, raw_turn_id, episode_id, session_id
       FROM feedback
       WHERE id = ?`
    ).get(feedback.feedbackId) as {
      l1_memory_id: string | null;
      raw_turn_id: string | null;
      episode_id: string | null;
      session_id: string | null;
    };
    expect(feedbackRow.l1_memory_id).toBe(complete.l1MemoryId);
    expect(feedbackRow.raw_turn_id).toBe(complete.rawTurnId);
    expect(feedbackRow.episode_id).toBe(complete.episodeId);
    expect(feedbackRow.session_id).toBe(session.sessionId);
    const episodeIndexes = db.db.prepare(
      `SELECT feedback_ids_json, decision_repair_ids_json
       FROM episodes
       WHERE id = ?`
    ).get(complete.episodeId) as {
      feedback_ids_json: string;
      decision_repair_ids_json: string;
    };
    expect(JSON.parse(episodeIndexes.feedback_ids_json)).toContain(feedback.feedbackId);
    expect(JSON.parse(episodeIndexes.decision_repair_ids_json)).toContain(feedback.repair?.repairId);

    const beforeClose = JSON.parse((db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string }).properties_json) as {
      internal_info: { trace: { r_human?: number } };
    };
    expect(beforeClose.internal_info.trace.r_human).toBeUndefined();

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(50);
    const rewardJobRow = db.db.prepare(
      `SELECT episode_id, target_memory_id, payload_json
       FROM evolution_jobs
       WHERE job_type = 'reward'
         AND episode_id = ?`
    ).get(complete.episodeId) as {
      episode_id: string | null;
      target_memory_id: string | null;
      payload_json: string;
    };
    expect(rewardJobRow.episode_id).toBe(complete.episodeId);
    expect(rewardJobRow.target_memory_id).toBeNull();
    expect(JSON.parse(rewardJobRow.payload_json)).toMatchObject({
      phase: "final",
      l1MemoryId: complete.l1MemoryId,
      feedbackId: feedback.feedbackId
    });
    await service.runWorkerOnce(50);

    const memory = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const properties = JSON.parse(memory.properties_json) as {
      internal_info: {
        source_feedback_ids?: string[];
        trace: {
          r_human?: number;
          source_feedback_ids?: string[];
        };
      };
    };
    expect(properties.internal_info.trace.r_human).toBeCloseTo(-1);
    expect(properties.internal_info.source_feedback_ids).toContain(feedback.feedbackId);
    expect(properties.internal_info.trace.source_feedback_ids).toContain(feedback.feedbackId);

    db.close();
  });
});
