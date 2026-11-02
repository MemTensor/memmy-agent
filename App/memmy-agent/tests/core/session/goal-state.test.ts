import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOAL_STATE_KEY,
  emptyAgentGoalState,
  goalStateWsBlob,
  nextGoalUpdatedAt,
  parseGoalRoute,
  parseGoalState,
  runnerWallLlmTimeoutS,
  sustainedGoalActive,
  type GoalState,
} from "../../../src/core/session/goal-state.js";
import { SessionManager } from "../../../src/core/session/manager.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-goal-state-"));
}

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    goalId: "2baa5f17-09b3-4d68-9f90-8f0d91f6346f",
    objective: "Ship the fix.",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GoalState session metadata helpers", () => {
  it("validates persisted Computer Use authorization without upgrading legacy routes", () => {
    const route = { channel: 'websocket', chatId: 'chat', source: { kind: 'gui', channel: 'websocket' },
      computerUseMessageId: 'accepted-user-request' };
    expect(parseGoalRoute(route)).toEqual(route);
    for (const computerUseMessageId of ['', ' ', 7, 'x'.repeat(513)])
      expect(parseGoalRoute({ ...route, computerUseMessageId })).toBeNull();
    expect(parseGoalRoute({ ...route, source: { kind: 'gui', channel: 'cron' } })).toBeNull();
    expect(parseGoalRoute({ ...route, source: undefined })).toBeNull();
  });
  it("accepts only the final strict contract", () => {
    expect(parseGoalState(goal())).toEqual(goal());
    expect(parseGoalState(JSON.stringify(goal()))).toBeNull();
    expect(parseGoalState({ status: "active", objective: "legacy" })).toBeNull();
    expect(parseGoalState({ ...goal(), extra: true })).toBeNull();
    expect(parseGoalState(goal({ tokenBudget: 0 }))).toBeNull();
  });

  it("projects the exact public websocket shape", () => {
    expect(goalStateWsBlob(null)).toEqual(emptyAgentGoalState());
    expect(goalStateWsBlob({ [GOAL_STATE_KEY]: goal({ tokenBudget: 500, tokensUsed: 120 }) })).toEqual({
      goal_id: "2baa5f17-09b3-4d68-9f90-8f0d91f6346f",
      status: "active",
      objective: "Ship the fix.",
      token_budget: 500,
      tokens_used: 120,
      time_used_seconds: 0,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reports activity only for a valid active Goal", () => {
    expect(sustainedGoalActive({ [GOAL_STATE_KEY]: goal() })).toBe(true);
    expect(sustainedGoalActive({ [GOAL_STATE_KEY]: goal({ status: "paused" }) })).toBe(false);
    expect(sustainedGoalActive({ [GOAL_STATE_KEY]: { status: "active", objective: "legacy" } })).toBe(false);
  });

  it("keeps updatedAt strictly monotonic", () => {
    expect(nextGoalUpdatedAt("2026-08-01T00:00:00.000Z", new Date("2026-07-01T00:00:00.000Z")))
      .toBe("2026-08-01T00:00:00.001Z");
  });

  it("disables the runner wall timeout only for a valid active Goal", () => {
    const manager = new SessionManager(tempDir());
    expect(runnerWallLlmTimeoutS(manager, "cli:test", {
      metadata: { [GOAL_STATE_KEY]: goal() },
    })).toBe(0);
    expect(runnerWallLlmTimeoutS(manager, "cli:test", {
      metadata: { [GOAL_STATE_KEY]: goal({ status: "completed" }) },
    })).toBeNull();
  });

  it("reads legacy and source-aware Goal routes without accepting extra fields", () => {
    expect(parseGoalRoute({ channel: "telegram", chatId: "room" })).toEqual({
      channel: "telegram",
      chatId: "room",
    });
    expect(parseGoalRoute({
      channel: "websocket",
      chatId: "ext_session",
      source: { kind: "tui", channel: "websocket" },
    })).toEqual({
      channel: "websocket",
      chatId: "ext_session",
      source: { kind: "tui", channel: "websocket" },
    });
    expect(parseGoalRoute({
      channel: "websocket",
      chatId: "ext_session",
      source: { kind: "gui", channel: "spoofed", extra: true },
    })).toBeNull();
    expect(parseGoalRoute({ channel: "telegram", chatId: "room", extra: true })).toBeNull();
  });
});
