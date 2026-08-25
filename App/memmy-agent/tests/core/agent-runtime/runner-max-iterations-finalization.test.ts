import { describe, expect, it, vi } from "vitest";
import { AgentRunSpec, AgentRunner } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

function tools(): any {
  return {
    getDefinitions: vi.fn(() => [{ type: "function", function: { name: "noop" } }]),
    execute: vi.fn(async () => "tool result"),
  };
}

describe("AgentRunner max-iterations finalization", () => {
  it("uses one request-only, tool-free final call and keeps the prompt out of canonical messages", async () => {
    const calls: any[] = [];
    const provider = {
      generation: { maxTokens: 256 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async (args: any) => {
        calls.push(args);
        if (calls.length === 1) {
          return new LLMResponse({
            content: "working",
            toolCalls: [new ToolCallRequest({ id: "call-1", name: "noop", arguments: {} })],
            usage: { inputTokens: 10, outputTokens: 2 },
          });
        }
        return new LLMResponse({
          content: "Honest final answer",
          toolCalls: [new ToolCallRequest({ id: "ignored", name: "noop", arguments: {} })],
          usage: { inputTokens: 20, outputTokens: 4 },
        });
      }),
    };
    const onMaxFinalizationStarting = vi.fn(() => {
      expect(calls).toHaveLength(1);
    });
    const beforeFollowupModelRequest = vi.fn(async (context: any) => {
      expect(onMaxFinalizationStarting).toHaveBeenCalledOnce();
      expect(context).toMatchObject({
        requestKind: "max_iterations_finalization",
        iteration: 1,
        toolsForRequest: null,
      });
      expect(context.reservedPromptTokens).toBeGreaterThan(0);
      return null;
    });
    const registry = tools();

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Do the task" }],
      provider: provider as any,
      tools: registry,
      model: "test-model",
      maxIterations: 1,
      maxIterationsFinalPrompt: "Summarize truthfully now.",
      onMaxFinalizationStarting,
      currentTurnMessageStartIndex: 0,
      beforeFollowupModelRequest,
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1].tools).toBeNull();
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "user", content: "Summarize truthfully now." });
    expect(result.stopReason).toBe("maxIterations");
    expect(result.finalContent).toBe("Honest final answer");
    expect(result.toolCalls).toHaveLength(1);
    expect(registry.execute).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
    expect(result.messages.some((message) => String(message.content).includes("Summarize truthfully now."))).toBe(false);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "Honest final answer" });
    expect(onMaxFinalizationStarting).toHaveBeenCalledTimes(1);
    expect(beforeFollowupModelRequest).toHaveBeenCalledTimes(1);
  });

  it("does not perform the terminal injection drain when finalization is enabled", async () => {
    const injectionCallback = vi.fn(async () => [{ role: "user", content: "must remain pending" }]);
    const provider = {
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "Final from available context" })),
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Do the task" }],
      provider: provider as any,
      tools: tools(),
      model: "test-model",
      maxIterations: 0,
      maxIterationsFinalPrompt: "Finalize.",
      injectionCallback,
    }));

    expect(injectionCallback).not.toHaveBeenCalled();
    expect(result.hadInjections).toBe(false);
    expect(result.messages.some((message) => String(message.content).includes("must remain pending"))).toBe(false);
    const requestMessages = (provider.chatWithRetry as any).mock.calls[0][0].messages;
    expect(requestMessages).toHaveLength(1);
    expect(requestMessages[0]).toMatchObject({ role: "user" });
    expect(requestMessages[0].content).toContain("Do the task");
    expect(requestMessages[0].content).toContain("Finalize.");
  });

  it("falls back without retrying when the final request fails", async () => {
    const provider = {
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Do the task" }],
      provider: provider as any,
      tools: tools(),
      model: "test-model",
      maxIterations: 0,
      maxIterationsMessage: "Reached {maxIterations}; work may be incomplete.",
      maxIterationsFinalPrompt: "Finalize.",
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("maxIterations");
    expect(result.finalContent).toBe("Reached 0; work may be incomplete.");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: result.finalContent });
  });

  it("uses the honest fallback for an empty final response", async () => {
    const provider = {
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "" })),
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Do the task" }],
      provider: provider as any,
      tools: tools(),
      maxIterations: 0,
      maxIterationsMessage: "Work stopped at the limit and may be incomplete.",
      maxIterationsFinalPrompt: "Finalize.",
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("maxIterations");
    expect(result.finalContent).toBe("Work stopped at the limit and may be incomplete.");
  });

  it("gives cancellation priority over the max fallback", async () => {
    const provider = {
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async () => new LLMResponse({
        content: null,
        finishReason: "error",
        errorKind: "aborted",
      })),
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Do the task" }],
      provider: provider as any,
      tools: tools(),
      maxIterations: 0,
      maxIterationsMessage: "must not be emitted",
      maxIterationsFinalPrompt: "Finalize.",
    }));

    expect(result.stopReason).toBe("cancelled");
    expect(result.finalContent).toBe("Error: task cancelled");
    expect(result.messages.some((message) => message.content === "must not be emitted")).toBe(false);
  });

  it("preserves the legacy max behavior when no final prompt is configured", async () => {
    const injectionCallback = vi.fn(async () => [{ role: "user", content: "legacy terminal injection" }]);
    const beforeFollowupModelRequest = vi.fn(async () => null);
    const provider = {
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(),
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Do the task" }],
      provider: provider as any,
      tools: tools(),
      maxIterations: 0,
      injectionCallback,
      currentTurnMessageStartIndex: 0,
      beforeFollowupModelRequest,
    }));

    expect(injectionCallback).toHaveBeenCalledTimes(1);
    expect(beforeFollowupModelRequest).not.toHaveBeenCalled();
    expect(result.hadInjections).toBe(true);
    expect(result.messages.some((message) => String(message.content).includes("legacy terminal injection"))).toBe(true);
  });
});
