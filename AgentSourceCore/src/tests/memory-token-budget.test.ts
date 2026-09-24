import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_BYOK_DAILY_LIMIT_M,
  DEFAULT_MEMORY_BYOK_TOTAL_LIMIT_M,
  allowedMemoryBudgetJobTypes,
  evaluateMemoryTokenBudget,
  isBudgetedMemoryUsage,
  jobTypeBudgetRoles,
  jobTypeConsumesMemoryBudget,
  localCalendarDate,
  nextLocalMidnightMs,
  parseMemoryByokLimitM,
  startOfLocalDay
} from "../memory-token-budget.js";

describe("memory token budget rules", () => {
  it("counts pipeline operations and excludes retrieval plus agent chat", () => {
    expect(isBudgetedMemoryUsage({ kind: "memory_summary", operation: "episode_title.final" })).toBe(true);
    expect(isBudgetedMemoryUsage({ kind: "memory_summary", operation: "capture.summarize" })).toBe(true);
    expect(isBudgetedMemoryUsage({ kind: "memory_evolution", operation: "capture.reflection.batch.v13" })).toBe(true);
    expect(isBudgetedMemoryUsage({ kind: "memory_evolution", operation: "l3_world_model.project_contract" })).toBe(true);
    expect(isBudgetedMemoryUsage({ kind: "embedding", operation: "embedding.document" })).toBe(true);
    expect(isBudgetedMemoryUsage({ kind: "embedding", operation: "embedding.query" })).toBe(false);
    expect(isBudgetedMemoryUsage({ kind: "memory_summary", operation: "retrieval.retrieval.filter.v5" })).toBe(false);
    expect(isBudgetedMemoryUsage({ kind: "memory_summary", operation: "retrieval.retrieval.query.extract.v2" })).toBe(false);
    expect(isBudgetedMemoryUsage({ kind: "agent_chat", operation: "agent.turn" })).toBe(false);
  });

  it("pauses budgeted jobs and leaves idle close runnable", () => {
    expect(jobTypeConsumesMemoryBudget("trace_summary")).toBe(true);
    expect(jobTypeConsumesMemoryBudget("episode_title")).toBe(true);
    expect(jobTypeConsumesMemoryBudget("embedding")).toBe(true);
    expect(jobTypeConsumesMemoryBudget("new_future_job")).toBe(true);
    expect(jobTypeConsumesMemoryBudget("episode_idle_close")).toBe(false);
  });

  it("holds only jobs whose current model source is BYOK", () => {
    const byok = {
      memory_summary: { source: "byok" },
      memory_evolution: { source: "byok" },
      embedding: { source: "byok", mode: "custom" }
    };
    const account = {
      memory_summary: { source: "account" },
      memory_evolution: { source: "account" },
      embedding: { source: "account", mode: "cloud" }
    };
    const mixed = {
      memory_summary: { source: "byok" },
      memory_evolution: { source: "account" },
      embedding: { source: "byok", mode: "local" }
    };

    expect(jobTypeConsumesMemoryBudget("reflection", byok)).toBe(true);
    expect(jobTypeConsumesMemoryBudget("embedding", byok)).toBe(true);
    expect(jobTypeConsumesMemoryBudget("episode_idle_close", byok)).toBe(false);

    expect(jobTypeConsumesMemoryBudget("reflection", account)).toBe(false);
    expect(jobTypeConsumesMemoryBudget("trace_summary", account)).toBe(false);
    expect(jobTypeConsumesMemoryBudget("embedding", account)).toBe(false);

    expect(jobTypeConsumesMemoryBudget("episode_title", mixed)).toBe(true);
    expect(jobTypeConsumesMemoryBudget("span_big_turn", mixed)).toBe(true);
    expect(jobTypeConsumesMemoryBudget("work_memory_extract", mixed)).toBe(true);
    expect(jobTypeConsumesMemoryBudget("reflection", mixed)).toBe(true);
    expect(jobTypeConsumesMemoryBudget("reward", mixed)).toBe(true);
    expect(jobTypeConsumesMemoryBudget("embedding", mixed)).toBe(false);
    expect(jobTypeConsumesMemoryBudget("decision_repair", mixed)).toBe(false);
    expect(jobTypeConsumesMemoryBudget("l2_association", mixed)).toBe(false);
    expect(jobTypeBudgetRoles("span_big_turn")).toEqual(["memory_summary"]);
    expect(jobTypeBudgetRoles("work_memory_extract")).toEqual(["memory_summary"]);
    expect(jobTypeBudgetRoles("reflection")).toEqual(["memory_summary", "memory_evolution"]);
    expect(jobTypeBudgetRoles("reward")).toEqual(["memory_summary", "memory_evolution"]);
  });

  it("keeps cluster assignment runnable and pauses only BYOK cluster evolution", () => {
    const byok = {
      memory_summary: { source: "byok" },
      memory_evolution: { source: "byok" },
      embedding: { source: "byok", mode: "custom" }
    };
    const accountEvolution = {
      ...byok,
      memory_evolution: { source: "account" }
    };

    expect(jobTypeBudgetRoles("skill_cluster_assign")).toEqual([]);
    expect(jobTypeBudgetRoles("skill_batch_evolve")).toEqual(["memory_evolution"]);
    expect(allowedMemoryBudgetJobTypes(byok)).toContain("skill_cluster_assign");
    expect(allowedMemoryBudgetJobTypes(byok)).not.toContain("skill_batch_evolve");
    expect(allowedMemoryBudgetJobTypes(accountEvolution)).toContain("skill_cluster_assign");
    expect(allowedMemoryBudgetJobTypes(accountEvolution)).toContain("skill_batch_evolve");
  });

  it("treats 0 as unlimited and prefers the total trigger", () => {
    expect(parseMemoryByokLimitM(0)).toBe(0);
    expect(parseMemoryByokLimitM(-1)).toBeUndefined();
    expect(parseMemoryByokLimitM(1.5)).toBeUndefined();
    expect(parseMemoryByokLimitM(100_000)).toBeUndefined();

    expect(evaluateMemoryTokenBudget({
      dailyLimitM: DEFAULT_MEMORY_BYOK_DAILY_LIMIT_M,
      totalLimitM: DEFAULT_MEMORY_BYOK_TOTAL_LIMIT_M,
      dailyUsed: 9_999_999,
      lifetimeUsed: 23_000_000
    })).toMatchObject({ paused: false, trigger: null });

    expect(evaluateMemoryTokenBudget({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 10_000_000,
      lifetimeUsed: 23_000_000
    })).toMatchObject({ paused: true, trigger: "daily" });

    expect(evaluateMemoryTokenBudget({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 10_000_000,
      lifetimeUsed: 500_000_000
    })).toMatchObject({ paused: true, trigger: "total" });

    expect(evaluateMemoryTokenBudget({
      dailyLimitM: 0,
      totalLimitM: 500,
      dailyUsed: 80_000_000,
      lifetimeUsed: 80_000_000
    })).toMatchObject({ paused: false, trigger: null });

    expect(evaluateMemoryTokenBudget({
      dailyLimitM: 5,
      totalLimitM: 0,
      dailyUsed: 10_100_000,
      lifetimeUsed: 10_100_000
    })).toMatchObject({ paused: true, trigger: "daily" });
  });

  it("uses the machine-local calendar day", () => {
    const justBeforeMidnight = new Date(2026, 8, 18, 23, 59, 59, 0);
    const justAfterMidnight = new Date(2026, 8, 19, 0, 0, 0, 0);
    expect(localCalendarDate(justBeforeMidnight)).toBe("2026-09-18");
    expect(localCalendarDate(justAfterMidnight)).toBe("2026-09-19");
    expect(startOfLocalDay(justBeforeMidnight).getTime()).toBe(new Date(2026, 8, 18).getTime());
    expect(nextLocalMidnightMs(justBeforeMidnight)).toBe(justAfterMidnight.getTime());
  });
});
