import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { RequestContext } from "../../../src/core/agent-runtime/tools/context.js";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";

class ProbeTool extends Tool {
  seen: RequestContext | null = null;

  get name(): string {
    return "probe";
  }

  get description(): string {
    return "Probe context injection.";
  }

  get parameters() {
    return { type: "object", properties: {} };
  }

  setContext(ctx: RequestContext): void {
    this.seen = ctx;
  }

  execute(): string {
    return "ok";
  }
}

describe("AgentLoop tool context", () => {
  it("sets request context on context-aware tools", () => {
    const loop = new AgentLoop({ provider: { generation: {}, getDefaultModel: () => "m" }, workspace: "/tmp/memmy-loop-context" });
    const probe = new ProbeTool();
    loop.tools.register(probe);

    loop.setToolContext("telegram", "chat-1", "m1", { x: 1 }, "telegram:chat-1");

    expect(probe.seen).toMatchObject({
      channel: "telegram",
      chatId: "chat-1",
      messageId: "m1",
      sessionKey: "telegram:chat-1",
      metadata: { x: 1 },
    });
  });
});
