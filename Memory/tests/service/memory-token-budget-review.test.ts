import { afterEach, describe, expect, it } from "vitest";
import { localCalendarDate } from "@memmy/agent-source-core";
import { DEFAULT_MEMMY_CONFIG } from "../../src/config/index.js";
import { MEMORY_BYOK_BUDGET_KV_KEY } from "../../src/service/memory-token-budget-ledger.js";
import type { LlmClient } from "../../src/model/types.js";
import { Repositories } from "../../src/storage/repositories.js";
import { accountRuntimeConfig, byokRuntimeConfig, createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("memory token budget review regressions", () => {
  it("queues decision repair instead of calling BYOK LLM while paused, then resumes once", async () => {
    const calls: string[] = [];
    const pausedConfig = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 1, totalLimitM: 500 }
    });
    const resumedConfig = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 0, totalLimitM: 0 }
    });
    const { db, service } = createTestService({
      config: pausedConfig,
      configLoader: () => ({ config: resumedConfig }),
      skillLlm: createDecisionRepairLlm(calls)
    });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-budget-repair"
      }
    });

    const first = await service.feedback({
      sessionId: session.sessionId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, next time inspect the sqlite migration before retrying",
      rawPayload: { contextHash: "ctx-budget-repair" }
    });
    const repeat = await service.feedback({
      sessionId: session.sessionId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, next time inspect the sqlite migration before retrying",
      rawPayload: { contextHash: "ctx-budget-repair" }
    });

    expect(first.repair?.repairId).toMatch(/^repair_/);
    expect(repeat.repair?.skipped).toBe(true);
    expect(calls.filter((operation) => operation === "decision.repair.v1")).toEqual([]);
    const queued = repos.runtime.listJobs(undefined, 50).filter((job) => job.jobType === "decision_repair");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      status: "queued",
      dedupeKey: `decision_repair:${first.repair!.repairId}`
    });

    service.reloadConfig();
    const run = await service.runWorkerOnce(10);
    expect(run.jobs.map((job) => job.jobType)).toContain("decision_repair");
    expect(calls.filter((operation) => operation === "decision.repair.v1")).toHaveLength(1);
    const repair = repos.runtime.getDecisionRepair(first.repair!.repairId!);
    expect(repair?.preference).toContain("Inspect migration output");
    expect(repair?.source).toMatchObject({ synthesis: "llm" });

    await service.runWorkerOnce(10);
    expect(calls.filter((operation) => operation === "decision.repair.v1")).toHaveLength(1);
    db.close();
  });

  it.each([true, false])("defers revision repair creation and resumes once (session: %s)", async (hasSession) => {
    const calls: string[] = [];
    const { db, service } = createTestService({
      config: byokRuntimeConfig({
        tokenBudget: { dailyLimitM: 1, totalLimitM: 500 }
      }),
      configLoader: () => ({ config: byokRuntimeConfig({
        tokenBudget: { dailyLimitM: 0, totalLimitM: 0 }
      }) }),
      skillLlm: createDecisionRepairLlm(calls)
    });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const namespace = {
      source: "codex",
      profileId: "budget-revision-profile",
      projectId: "project-budget-revision",
      userId: "user-budget-revision"
    };
    const session = hasSession ? service.openSession({ namespace }) : undefined;
    const request = {
      ...(session ? { sessionId: session.sessionId } : { namespace }),
      adapterId: "codex",
      requestId: "budget-revision-feedback",
      channel: "explicit" as const,
      polarity: "negative" as const,
      rationale: "wrong, inspect the sqlite migration before retrying",
      rawPayload: {
        source: "relation_classifier",
        relation: "revision",
        contextHash: "ctx-budget-revision"
      }
    };
    const feedback = await service.feedback(request);
    const duplicate = await service.feedback(request);
    expect(duplicate.duplicate).toBe(true);
    expect(feedback.repair).toBeUndefined();
    const repairs = () => repos.runtime.listDecisionRepairs({
      userId: "user-budget-revision",
      contextHash: "ctx-budget-revision"
    });
    expect(repairs()).toHaveLength(0);
    const queued = repos.runtime.listJobs(undefined, 50).filter((job) => job.jobType === "decision_repair");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      status: "queued",
      dedupeKey: `decision_repair:${feedback.feedbackId}`,
      payload: {
        feedbackId: feedback.feedbackId,
        contextHash: "ctx-budget-revision",
        namespace
      }
    });
    await service.runWorkerOnce(10);
    expect(calls).toEqual([]);
    expect(repairs()).toHaveLength(0);

    service.reloadConfig();
    await service.runWorkerOnce(10);
    expect(calls.filter((operation) => operation === "decision.repair.v1")).toHaveLength(1);
    expect(repairs()).toHaveLength(1);
    expect(repairs()[0]).toMatchObject({
      feedbackId: feedback.feedbackId,
      userId: namespace.userId,
      projectId: namespace.projectId,
      preference: expect.stringContaining("Inspect migration output"),
      source: { synthesis: "llm" }
    });
    expect(repos.runtime.listChanges(undefined, 50)
      .filter((change) => change.changeType === "decision_repair_created")
      .map((change) => change.namespaceId)).toEqual([
      "user-budget-revision:project-budget-revision:codex:budget-revision-profile"
    ]);
    await service.runWorkerOnce(10);
    expect(calls.filter((operation) => operation === "decision.repair.v1")).toHaveLength(1);
    expect(repairs()).toHaveLength(1);
    db.close();
  });

  it("keeps failure-burst repairs and queues the LLM upgrade while paused", async () => {
    const calls: string[] = [];
    const pausedConfig = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 1, totalLimitM: 500 }
    });
    const { db, service } = createTestService({
      config: pausedConfig,
      configLoader: () => ({
        config: byokRuntimeConfig({
          tokenBudget: { dailyLimitM: 0, totalLimitM: 0 }
        })
      }),
      skillLlm: createDecisionRepairLlm(calls)
    });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-budget-burst"
      }
    });
    await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-budget-burst",
      turnId: "tool-1",
      toolName: "shell",
      error: "missing sqlite migration"
    });
    await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-budget-burst",
      turnId: "tool-2",
      toolName: "shell",
      error: "missing sqlite migration"
    });
    const third = await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-budget-burst",
      turnId: "tool-3",
      toolName: "shell",
      error: "missing sqlite migration"
    });

    expect(third.repair?.repairId).toMatch(/^repair_/);
    expect(calls.filter((operation) => operation === "decision.repair.v1")).toEqual([]);
    const queued = repos.runtime.listJobs(undefined, 50).filter((job) => job.jobType === "decision_repair");
    expect(queued).toHaveLength(1);

    service.reloadConfig();
    await service.runWorkerOnce(20);
    expect(calls.filter((operation) => operation === "decision.repair.v1")).toHaveLength(1);
    expect(repos.runtime.getDecisionRepair(third.repair!.repairId!)).toMatchObject({
      preference: expect.stringContaining("Inspect migration output")
    });
    db.close();
  });

  it("retries App usage reconcile after startup miss and then pauses BYOK jobs", async () => {
    let remote: { dailyUsed: number; lifetimeUsed: number } | null = null;
    const config = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 10, totalLimitM: 500 }
    });
    const { db, service } = createTestService({
      config,
      configLoader: () => ({ config }),
      fetchAppMemoryBudget: async () => remote
    });
    const repos = new Repositories(db.db);

    await service.runWorkerOnce(10);
    expect(service.memoryTokenBudgetSnapshot()).toMatchObject({
      lifetimeUsed: 0,
      paused: false
    });

    const at = new Date().toISOString();
    repos.runtime.enqueueJob({
      id: "job-after-reconcile",
      jobType: "reflection",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });

    remote = { dailyUsed: 20_000_000, lifetimeUsed: 600_000_000 };
    service.reloadConfig();
    const run = await service.runWorkerOnce(10);
    expect(service.memoryTokenBudgetSnapshot()).toMatchObject({
      dailyUsed: 20_000_000,
      lifetimeUsed: 600_000_000,
      paused: true,
      trigger: "total"
    });
    expect(run.jobs.map((job) => job.jobId)).not.toContain("job-after-reconcile");
    expect(repos.runtime.getJob("job-after-reconcile")).toMatchObject({
      status: "queued",
      attempts: 0
    });
    db.close();
  });

  it("holds span_big_turn when summary is BYOK and still runs it when only evolution is BYOK", async () => {
    const summaryCalls: string[] = [];
    const pausedSummary = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 1, totalLimitM: 500 },
      evolution: accountRuntimeConfig().evolution
    });
    const { db, service } = createTestService({
      config: pausedSummary,
      configLoader: () => ({
        config: {
          ...pausedSummary,
          tokenBudget: { dailyLimitM: 0, totalLimitM: 0 }
        }
      }),
      llm: createTrackingLlm(summaryCalls, {
        "span.big_turn.v1": {
          reason: "two phases",
          spans: [
            { start: 0, end: 3, spanGoal: "diagnose", summary: "found the conflict" },
            { start: 4, end: 10, spanGoal: "repair", summary: "fixed and verified" }
          ]
        }
      })
    });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const session = service.openSession({
      namespace: { source: "codex", profileId: "jiang", userId: "user-span-budget" }
    });
    const toolCalls = Array.from({ length: 11 }, (_, index) => ({
      id: `call-${index}`,
      name: index < 4 ? "read_file" : "apply_patch",
      input: { index }
    }));
    const completed = service.completeTurn("turn-span-budget", {
      sessionId: session.sessionId,
      query: "修复项目构建失败并完成测试验证",
      answer: "已经定位依赖冲突并完成修复。",
      toolCalls,
      toolResults: toolCalls.map((call, index) => ({
        toolCallId: call.id,
        name: call.name,
        output: { ok: true, index }
      }))
    });
    const at = new Date().toISOString();
    repos.runtime.enqueueJob({
      id: "job-span-budget",
      jobType: "span_big_turn",
      status: "queued",
      userId: "user-span-budget",
      targetMemoryId: completed.l1MemoryId,
      payload: { rawTurnId: completed.rawTurnId },
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });

    await service.runWorkerOnce(20);
    expect(summaryCalls.filter((operation) => operation === "span.big_turn.v1")).toEqual([]);
    expect(repos.runtime.getJob("job-span-budget")).toMatchObject({ status: "queued", attempts: 0 });

    service.reloadConfig();
    await service.runWorkerOnce(20);
    expect(summaryCalls.filter((operation) => operation === "span.big_turn.v1")).toHaveLength(1);
    db.close();

    const evolutionOnlyCalls: string[] = [];
    const pausedEvolution = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 1, totalLimitM: 500 },
      summary: accountRuntimeConfig().summary
    });
    const reverse = createTestService({
      config: pausedEvolution,
      llm: createTrackingLlm(evolutionOnlyCalls, {
        "span.big_turn.v1": {
          reason: "two phases",
          spans: [
            { start: 0, end: 3, spanGoal: "diagnose", summary: "found the conflict" },
            { start: 4, end: 10, spanGoal: "repair", summary: "fixed and verified" }
          ]
        }
      })
    });
    const reverseRepos = new Repositories(reverse.db.db);
    reverseRepos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const reverseSession = reverse.service.openSession({
      namespace: { source: "codex", profileId: "jiang", userId: "user-span-platform-summary" }
    });
    const reverseCompleted = reverse.service.completeTurn("turn-span-platform-summary", {
      sessionId: reverseSession.sessionId,
      query: "修复项目构建失败并完成测试验证",
      answer: "已经定位依赖冲突并完成修复。",
      toolCalls,
      toolResults: toolCalls.map((call, index) => ({
        toolCallId: call.id,
        name: call.name,
        output: { ok: true, index }
      }))
    });
    reverseRepos.runtime.enqueueJob({
      id: "job-span-platform-summary",
      jobType: "span_big_turn",
      status: "queued",
      userId: "user-span-platform-summary",
      targetMemoryId: reverseCompleted.l1MemoryId,
      payload: { rawTurnId: reverseCompleted.rawTurnId },
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });
    await reverse.service.runWorkerOnce(20);
    expect(evolutionOnlyCalls.filter((operation) => operation === "span.big_turn.v1")).toHaveLength(1);
    reverse.db.close();
  });

  it("queues positive feedback refinement while paused and resumes once", async () => {
    const calls: string[] = [];
    const pausedConfig = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 1, totalLimitM: 500 }
    });
    const { db, service } = createTestService({
      config: pausedConfig,
      configLoader: () => ({
        config: byokRuntimeConfig({
          tokenBudget: { dailyLimitM: 0, totalLimitM: 0 }
        })
      }),
      llm: createTrackingLlm([]),
      skillLlm: createTrackingLlm(calls, {
        "feedback.refine.v1": {
          title: "Keep the issuer name out of the filename",
          trigger: "SEC 13F parse",
          procedure: "Read the issuer field from the filing body.",
          verification: "Issuer name matches the CUSIP record.",
          caveats: ["Do not use the filename"],
          confidence: 0.9
        }
      })
    });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const session = service.openSession({
      namespace: { source: "codex", profileId: "jiang", userId: "user-feedback-refine" }
    });
    const completed = service.completeTurn("turn-feedback-refine", {
      sessionId: session.sessionId,
      query: "Parse a SEC 13F filing and extract issuer CUSIP holdings.",
      answer: "I parsed the filename as the issuer name."
    });
    const first = await service.feedback({
      sessionId: session.sessionId,
      episodeId: completed.episodeId,
      l1MemoryId: completed.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "Verifier feedback: success. Next time keep the issuer name out of the filename.",
      rawPayload: { source: "verifier", score: 1 }
    });
    const repeat = await service.feedback({
      sessionId: session.sessionId,
      episodeId: completed.episodeId,
      l1MemoryId: completed.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "Verifier feedback: success. Next time keep the issuer name out of the filename.",
      rawPayload: { source: "verifier", score: 1 }
    });

    expect(first.feedbackId).toMatch(/^feedback_/);
    expect(repeat.feedbackId).toBeTruthy();
    expect(calls.filter((operation) => operation === "feedback.refine.v1")).toEqual([]);
    const queued = repos.runtime.listJobs(undefined, 50).filter((job) => job.jobType === "feedback_experience");
    expect(queued).toHaveLength(1);

    service.reloadConfig();
    await service.runWorkerOnce(20);
    expect(calls.filter((operation) => operation === "feedback.refine.v1")).toHaveLength(1);
    await service.runWorkerOnce(20);
    expect(calls.filter((operation) => operation === "feedback.refine.v1")).toHaveLength(1);
    db.close();
  });

  it("still writes rule-based feedback experience when LLM is off and the budget is paused", async () => {
    const calls: string[] = [];
    const pausedNoLlm = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 1, totalLimitM: 500 },
      algorithm: {
        ...DEFAULT_MEMMY_CONFIG.algorithm,
        feedback: {
          ...DEFAULT_MEMMY_CONFIG.algorithm.feedback,
          useLlm: false
        }
      }
    });
    const { db, service } = createTestService({
      config: pausedNoLlm,
      llm: createTrackingLlm(calls),
      skillLlm: createTrackingLlm(calls)
    });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    const session = service.openSession({
      namespace: { source: "codex", profileId: "jiang", userId: "user-feedback-rule" }
    });
    const completed = service.completeTurn("turn-feedback-rule", {
      sessionId: session.sessionId,
      query: "Parse a SEC 13F filing and extract issuer CUSIP holdings.",
      answer: "I parsed the filename as the issuer name."
    });
    const first = await service.feedback({
      sessionId: session.sessionId,
      episodeId: completed.episodeId,
      l1MemoryId: completed.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "Verifier feedback: success. Next time keep the issuer name out of the filename.",
      rawPayload: { source: "verifier", score: 1 }
    });

    expect(first.feedbackId).toMatch(/^feedback_/);
    expect(calls).toEqual([]);
    expect(repos.runtime.listJobs(undefined, 50).filter((job) => job.jobType === "feedback_experience")).toEqual([]);
    const row = db.db.prepare(
      `SELECT id
       FROM memories
       WHERE user_id = 'user-feedback-rule'
         AND memory_layer = 'L2'
       LIMIT 1`
    ).get() as { id: string } | undefined;
    expect(row?.id).toBeTruthy();
    db.close();
  });

  it("wakes the scheduler when a slow first App fetch fails", async () => {
    let resolveFetch!: (value: { dailyUsed: number; lifetimeUsed: number } | null) => void;
    const hung = new Promise<{ dailyUsed: number; lifetimeUsed: number } | null>((resolve) => {
      resolveFetch = resolve;
    });
    let settled = 0;
    const { db, service } = createTestService({
      config: byokRuntimeConfig({
        tokenBudget: { dailyLimitM: 10, totalLimitM: 500 }
      }),
      fetchAppMemoryBudget: () => hung
    });
    service.setAppBudgetReconcileListener(() => {
      settled += 1;
    });
    expect(service.nextWorkerRunAt()).toBeUndefined();

    resolveFetch(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(1);
    expect(service.nextWorkerRunAt()).toBeGreaterThan(Date.now() - 50);
    expect(service.nextWorkerRunAt()).toBeLessThan(Date.now() + 1_500);
    db.close();
  });

  it("wakes to retry App reconcile after backoff without reloadConfig", async () => {
    let remote: { dailyUsed: number; lifetimeUsed: number } | null = null;
    const config = byokRuntimeConfig({
      tokenBudget: { dailyLimitM: 10, totalLimitM: 500 }
    });
    const { db, service } = createTestService({
      config,
      fetchAppMemoryBudget: async () => remote
    });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 10_000_000,
      lifetimeUsed: 10_000_000,
      dailyDate: localCalendarDate()
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const wakeAt = service.nextWorkerRunAt();
    expect(wakeAt).toBeGreaterThan(Date.now() - 50);
    expect(wakeAt).toBeLessThan(Date.now() + 1_500);

    remote = { dailyUsed: 20_000_000, lifetimeUsed: 600_000_000 };
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await service.runWorkerOnce(10);
    expect(service.memoryTokenBudgetSnapshot()).toMatchObject({
      dailyUsed: 20_000_000,
      lifetimeUsed: 600_000_000,
      paused: true,
      trigger: "total"
    });
    db.close();
  });
});

function createTrackingLlm(
  calls: string[],
  responses: Record<string, Record<string, unknown>> = {}
): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/budget-track",
      model: "budget-track"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      _messages: unknown,
      options: { operation: string }
    ): Promise<T> {
      calls.push(options.operation);
      return (responses[options.operation] ?? {}) as T;
    },
    status() {
      return {
        provider: "host",
        model: "budget-track",
        configured: true,
        remote: true
      };
    }
  };
}

function createDecisionRepairLlm(calls: string[]): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/decision-repair",
      model: "decision-repair"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      _messages: unknown,
      options: { operation: string }
    ): Promise<T> {
      calls.push(options.operation);
      if (options.operation === "decision.repair.v1") {
        return {
          preference: "Inspect migration output before retrying the sqlite query.",
          anti_pattern: "Avoid blind query retries after a migration failure.",
          severity: "warn",
          confidence: 0.88
        } as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "decision-repair",
        configured: true,
        remote: true
      };
    }
  };
}
