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

function createEmptyRewardLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: { operation: string };
}>): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/empty-reward",
      model: "empty-reward"
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
        model: "empty-reward",
        configured: true,
        remote: true
      };
    }
  };
}

function createCapturingRewardLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: {
    operation: string;
    thinkingMode?: "inherit" | "enabled" | "disabled";
    maxTokens?: number;
  };
}>): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/reward-capturing",
      model: "reward-capturing"
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
      if (options.operation === "reward.reward.r_human.v6") {
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
        model: "reward-capturing",
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
    expect(complete.jobs.map((job) => job.jobType)).toEqual(["embedding", "episode_idle_close"]);

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
    expect(queuedOrder.slice(0, 3)).toEqual(["episode_idle_close", "embedding", "reflection"]);

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

  it("still reflects unscored L1 memories when an episode already has reward", async () => {
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
    const first = service.completeTurn("turn-reward-before-reflection-1", {
      sessionId: session.sessionId,
      episodeId: "episode-reward-before-reflection",
      query: "我喜欢吃的水果是西瓜",
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
    const rewarded = db.db.prepare(
      `SELECT r_task
       FROM episodes
       WHERE id = ?`
    ).get(first.episodeId) as { r_task: number | null };
    expect(typeof rewarded.r_task).toBe("number");

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
    const reflectedItems = service.panelItems({
      userId: "user-reward-before-reflection",
      layer: "L1"
    }).items.filter((item) => [first.l1MemoryId, second.l1MemoryId, third.l1MemoryId].includes(item.id));
    expect(reflectedItems).toHaveLength(3);
    expect(reflectedItems.every((item) => item.metrics?.reflectionDone)).toBe(true);
    expect(calls.some((call) => call.options.operation === "capture.reflection.batch.v13")).toBe(true);
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

  it("skips trivial implicit reward episodes with the plugin reward gate", async () => {
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
    expect(JSON.parse(queuedReward!.payload_json)).toMatchObject({
      trigger: "implicit_fallback",
      targetKind: "episode"
    });

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
      skillLlm: createEmptyRewardLlm(rewardCalls),
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

    await service.runWorkerOnce(50);

    expect(rewardCalls.some((call) => call.options.operation === "reward.reward.r_human.v6")).toBe(true);
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

  it("scores R_human with the evolution LLM, thinking disabled, and stores episode reward meta", async () => {
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
      skillLlm: createCapturingRewardLlm(rewardCalls),
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
    await service.runWorkerOnce(50);

    const rewardCall = rewardCalls.find((call) => call.options.operation === "reward.reward.r_human.v6");
    expect(rewardCall).toBeTruthy();
    expect(rewardCall!.options.thinkingMode).toBe("disabled");
    expect(rewardCall!.options.maxTokens).toBe(700);
    expect(rewardCall!.messages[0]!.content).toContain("strict grader");
    expect(rewardCall!.messages[0]!.content).toContain("MISSION ANCHOR RULE");
    expect(rewardCall!.messages[0]!.content).toContain("EXECUTION RULE");
    expect(rewardCall!.messages[0]!.content).toContain("HOST_AGENT_CONTEXT");
    expect(rewardCall!.messages[1]!.content).toContain("HOST_AGENT_CONTEXT");
    expect(rewardCall!.messages[1]!.content).toContain("TASK_SUMMARY");
    expect(rewardCall!.messages[1]!.content).toContain("scorerModel: reward-capturing");
    expect(rewardCall!.messages[1]!.content).toContain("EPISODE_MISSION");
    expect(rewardCall!.messages[1]!.content).toContain("EXECUTION_OUTCOME");
    expect(rewardCall!.messages[1]!.content).toContain("USER_ASKS_AND_AGENT_REPLIES (2, in order)");
    expect(rewardCall!.messages[1]!.content).toContain("verify reward scoring prompt");
    expect(rewardCall!.messages[1]!.content).toContain("now summarize the final reward result");
    const stepsBlock = rewardCall!.messages[1]!.content.match(
      /AGENT_STEPS \(\d+\):\n([\s\S]*?)\n\nMOST_RECENT_USER_ASK/
    )?.[1];
    expect(stepsBlock).toContain("web.search");
    expect(stepsBlock).not.toContain("prepared the requested scoring workflow");
    expect(rewardCall!.messages[1]!.content).toContain("MOST_RECENT_USER_ASK");
    expect(rewardCall!.messages[1]!.content).toContain("MOST_RECENT_AGENT_REPLY");
    expect(rewardCall!.messages[1]!.content).toContain("FEEDBACK");

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

    const rewardJob = feedback.jobs.find((job) => job.jobType === "reward");
    expect(rewardJob?.targetMemoryId).toBeUndefined();
    const rewardJobRow = db.db.prepare(
      `SELECT episode_id, target_memory_id, payload_json
       FROM evolution_jobs
       WHERE id = ?`
    ).get(rewardJob!.jobId) as {
      episode_id: string | null;
      target_memory_id: string | null;
      payload_json: string;
    };
    expect(rewardJobRow.episode_id).toBe(complete.episodeId);
    expect(rewardJobRow.target_memory_id).toBeNull();
    expect(JSON.parse(rewardJobRow.payload_json)).toMatchObject({
      l1MemoryId: complete.l1MemoryId,
      feedbackId: feedback.feedbackId
    });
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
