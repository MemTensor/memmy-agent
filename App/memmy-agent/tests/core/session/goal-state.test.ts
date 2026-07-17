import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOAL_STATE_KEY,
  goalStateRuntimeLines,
  goalStateWsBlob,
  parseGoalState,
  runnerWallLlmTimeoutS,
  sustainedGoalActive,
} from "../../../src/core/session/goal-state.js";
import { SessionManager } from "../../../src/core/session/manager.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-goal-state-"));
}

describe("goalState session metadata helpers", () => {
  it("returns no runtime lines when metadata is missing or completed", () => {
    expect(goalStateRuntimeLines(null)).toEqual([]);
    expect(goalStateRuntimeLines({})).toEqual([]);
    expect(goalStateRuntimeLines({ [GOAL_STATE_KEY]: { status: "completed", objective: "was doing X" } })).toEqual([]);
  });

  it("includes active objective and summary", () => {
    const lines = goalStateRuntimeLines({
      [GOAL_STATE_KEY]: { status: "active", objective: "Ship the fix.", uiSummary: "fix" },
    });
    expect(lines).toContain("Goal (active):");
    expect(lines).toContain("Ship the fix.");
    expect(lines.some((line) => line.includes("Summary: fix"))).toBe(true);
  });

  it("returns no runtime lines when completed", () => {
    expect(goalStateRuntimeLines({ [GOAL_STATE_KEY]: { status: "completed", objective: "was doing X" } })).toEqual([]);
  });

  it("parses JSON string goal state", () => {
    expect(parseGoalState('{"status":"active","objective":"x"}')).toEqual({ status: "active", objective: "x" });
  });

  it("builds inactive websocket blobs when goal state is missing or completed", () => {
    expect(goalStateWsBlob(null)).toEqual({ active: false });
    expect(goalStateWsBlob({})).toEqual({ active: false });
    expect(goalStateWsBlob({ [GOAL_STATE_KEY]: { status: "completed", objective: "x" } })).toEqual({ active: false });
  });

  it("builds active websocket blobs with summary and objective", () => {
    expect(goalStateWsBlob({ [GOAL_STATE_KEY]: { status: "active", objective: "Build feature.", uiSummary: "feat" } })).toEqual({
      active: true,
      ui_summary: "feat",
      objective: "Build feature.",
    });
  });

  it("builds inactive and active websocket blobs", () => {
    expect(goalStateWsBlob(null)).toEqual({ active: false });
    expect(goalStateWsBlob({})).toEqual({ active: false });
    expect(goalStateWsBlob({ [GOAL_STATE_KEY]: { status: "completed", objective: "x" } })).toEqual({ active: false });
    expect(
      goalStateWsBlob({ [GOAL_STATE_KEY]: { status: "active", objective: "Build feature.", uiSummary: "feat" } }),
    ).toEqual({ active: true, ui_summary: "feat", objective: "Build feature." });
  });

  it("reports sustained goal activity", () => {
    expect(sustainedGoalActive(null)).toBe(false);
    expect(sustainedGoalActive({})).toBe(false);
    expect(sustainedGoalActive({ [GOAL_STATE_KEY]: { status: "completed", objective: "x" } })).toBe(false);
    expect(sustainedGoalActive({ [GOAL_STATE_KEY]: { status: "active", objective: "Run long task." } })).toBe(true);
  });

  it("reports sustained goal inactive for missing or completed metadata", () => {
    expect(sustainedGoalActive(null)).toBe(false);
    expect(sustainedGoalActive({})).toBe(false);
    expect(sustainedGoalActive({ [GOAL_STATE_KEY]: { status: "completed", objective: "x" } })).toBe(false);
  });

  it("reports sustained goal active for active metadata", () => {
    expect(sustainedGoalActive({ [GOAL_STATE_KEY]: { status: "active", objective: "Run long task." } })).toBe(true);
  });

  it("uses active goal metadata to disable runner wall LLM timeout", () => {
    const manager = new SessionManager(tempDir());
    expect(
      runnerWallLlmTimeoutS(manager, "cli:test", {
        metadata: { [GOAL_STATE_KEY]: { status: "active", objective: "x" } },
      }),
    ).toBe(0);
    expect(runnerWallLlmTimeoutS(manager, "cli:test", { metadata: {} })).toBeNull();
  });

  it("reads session metadata when runner timeout metadata is missing", () => {
    const manager = new SessionManager(tempDir());
    const session = manager.getOrCreate("c:d");
    session.metadata = { [GOAL_STATE_KEY]: { status: "active", objective: "z" } };
    expect(runnerWallLlmTimeoutS(manager, "c:d")).toBe(0);
    session.metadata = {};
    expect(runnerWallLlmTimeoutS(manager, "c:d")).toBeNull();
  });
});
