import { describe, expect, it } from "vitest";
import { MyTool } from "../../../../src/core/agent-runtime/tools/self.js";

describe("self tool runtime sync", () => {
  it("calls runtime sync hook when maxIterations changes", async () => {
    let synced = 0;
    const runtime = { maxIterations: 3, runtimeVars: {}, syncSubagentRuntimeLimits: () => { synced += 1; } };
    const tool = new MyTool({ runtime, modifyAllowed: true });

    expect(await tool.execute({ action: "set", key: "maxIterations", value: 4 })).toContain("Set maxIterations");
    expect(synced).toBe(1);
  });
});
