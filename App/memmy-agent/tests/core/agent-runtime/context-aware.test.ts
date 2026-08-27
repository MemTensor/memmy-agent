import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { isContextAware, RequestContext } from "../../../src/core/agent-runtime/tools/context.js";

describe("ContextBuilder runtime awareness", () => {
  it("adds channel, sender, and supplemental metadata to runtime context", () => {
    const runtime = ContextBuilder.buildRuntimeContext("telegram", "chat-1", "UTC", {
      senderId: "alice",
      supplementalLines: ["Goal: test"],
    });

    expect(runtime).toContain(ContextBuilder.RUNTIME_CONTEXT_TAG);
    expect(runtime).toContain("Channel: telegram");
    expect(runtime).toContain("Sender ID: alice");
    expect(runtime).toContain("Goal: test");
  });

  it("recognizes structurally context-aware tools", () => {
    const tool = {
      lastCtx: null as RequestContext | null,
      setContext(ctx: RequestContext) {
        this.lastCtx = ctx;
      },
    };
    const ctx = new RequestContext({ channel: "test", chatId: "123", sessionKey: "test:123" });

    expect(isContextAware(tool)).toBe(true);
    tool.setContext(ctx);
    expect(tool.lastCtx?.channel).toBe("test");
  });
});
