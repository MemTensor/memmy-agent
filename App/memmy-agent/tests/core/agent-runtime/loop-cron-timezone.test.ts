import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";

describe("AgentLoop timezone propagation", () => {
  it("passes configured timezone into context and tool runtime", () => {
    const loop = new AgentLoop({
      provider: { generation: {}, getDefaultModel: () => "m" },
      workspace: "/tmp/memmy-loop-timezone",
      timezone: "Asia/Shanghai",
    });

    expect(loop.context.timezone).toBe("Asia/Shanghai");
    expect(loop.tools.get("cron")?.name).toBe("cron");
  });
});
