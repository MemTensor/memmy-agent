import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";

describe("AgentLoop goal wall timeout", () => {
  it("tracks active task containers for goal-level cancellation bookkeeping", () => {
    const loop = new AgentLoop({ provider: { generation: {}, getDefaultModel: () => "m" }, workspace: "/tmp/memmy-loop-goal" });

    expect(loop.activeTasks).toBeInstanceOf(Map);
    expect(loop.cancelActiveTasks("missing")).resolves.toBe(0);
  });
});
