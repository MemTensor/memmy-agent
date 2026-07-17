import { describe, expect, it, vi } from "vitest";
import { AgentRunner, AgentRunSpec, MAX_INJECTION_CYCLES } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse } from "../../../src/providers/base.js";

const MAX_TOOL_RESULT_CHARS = 100_000;

function noTools(): any {
  return {
    getDefinitions: vi.fn(() => []),
  };
}

function finalTextProvider(content = "all done"): any {
  return {
    chatWithRetry: vi.fn(async () => new LLMResponse({ content, toolCalls: [], usage: {} })),
  };
}

async function runGoalCase(provider: any, extra: Partial<AgentRunSpec> & Record<string, any> = {}) {
  return new AgentRunner(provider).run(new AgentRunSpec({
    messages: [{ role: "user", content: "do task" }],
    provider,
    tools: noTools(),
    model: "test-model",
    maxIterations: 2,
    maxToolResultChars: MAX_TOOL_RESULT_CHARS,
    ...extra,
  }));
}

describe("AgentRunner goal continuation", () => {
  it("keeps run spec iteration limits explicit for continued goals", () => {
    const spec = new AgentRunSpec({ messages: [], maxIterations: 3, maxTokens: 123 });

    expect(spec.maxIterations).toBe(3);
    expect(spec.maxTokens).toBe(123);
  });

  it("exits normally without a goal predicate", async () => {
    const provider = finalTextProvider("all done");

    const result = await runGoalCase(provider);

    expect(result.stopReason).toBe("completed");
    expect(result.finalContent).toBe("all done");
  });

  it("exits normally when the goal predicate is inactive", async () => {
    const provider = finalTextProvider("all done");

    const result = await runGoalCase(provider, { goalActivePredicate: () => false });

    expect(result.stopReason).toBe("completed");
    expect(result.finalContent).toBe("all done");
  });

  it("forces continuation when the sustained goal is still active", async () => {
    const provider = finalTextProvider("still working");

    const result = await runGoalCase(provider, {
      maxIterations: 3,
      goalActivePredicate: () => true,
    });

    expect(result.stopReason).toBe("maxIterations");
    const userMessages = result.messages.filter((message) => message.role === "user");
    expect(userMessages.some((message) => String(message.content).includes("active sustained goal"))).toBe(true);
  });

  it("respects maxIterations even when the goal stays active", async () => {
    const provider = finalTextProvider("still working");

    const result = await runGoalCase(provider, {
      maxIterations: 1,
      goalActivePredicate: () => true,
    });

    expect(result.stopReason).toBe("maxIterations");
  });

  it("does not count synthetic goal continuation against the injection cycle cap", async () => {
    const provider = finalTextProvider("still working");
    const maxIterations = MAX_INJECTION_CYCLES + 3;

    const result = await runGoalCase(provider, {
      maxIterations,
      goalActivePredicate: () => true,
    });

    expect(result.stopReason).toBe("maxIterations");
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(maxIterations);
  });

  it("does not force continuation after an LLM error", async () => {
    const provider = {
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: null, toolCalls: [], finishReason: "error", usage: {} })),
    };

    const result = await runGoalCase(provider, { goalActivePredicate: () => true });

    expect(result.stopReason).toBe("error");
  });

  it("uses a custom goal continuation message when configured", async () => {
    const provider = finalTextProvider("still working");
    const customMessage = "CUSTOM_CONTINUE_PLEASE";

    const result = await runGoalCase(provider, {
      maxIterations: 2,
      goalActivePredicate: () => true,
      goalContinueMessage: customMessage,
    });

    const userMessages = result.messages.filter((message) => message.role === "user");
    expect(userMessages.some((message) => String(message.content).includes(customMessage))).toBe(true);
  });
});
