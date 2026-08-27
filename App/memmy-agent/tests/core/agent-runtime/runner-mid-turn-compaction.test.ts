import { describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunSpec, AgentRunner } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

function toolCall(id: string): ToolCallRequest {
  return new ToolCallRequest({ id, name: "lookup", arguments: { id } });
}

function tools(events: string[]): any {
  return {
    getDefinitions: vi.fn(() => [{ type: "function", function: { name: "lookup" } }]),
    get: vi.fn(() => null),
    execute: vi.fn(async (_name: string, args: Record<string, any>) => {
      events.push(`tool-${args.id}`);
      return `result-${args.id}`;
    }),
  };
}

describe("AgentRunner mid-turn compaction projection", () => {
  it("checks after the completed tool iteration and only changes provider requests", async () => {
    const events: string[] = [];
    const requests: Record<string, any>[] = [];
    const provider = {
      generation: { maxTokens: 100 },
      estimatePromptTokens: vi.fn(() => [500, "test"]),
      chatWithRetry: vi.fn(async (args: Record<string, any>) => {
        requests.push(args);
        events.push(`model-${requests.length}`);
        if (requests.length === 1) {
          return new LLMResponse({ content: "working", toolCalls: [toolCall("one")] });
        }
        return new LLMResponse({ content: "done" });
      }),
    };
    class RecordingHook extends AgentHook {
      override async afterIteration(context: AgentHookContext): Promise<void> {
        events.push(`after-${context.iteration}`);
      }
    }
    const initialMessages = [
      { role: "system", content: "original system" },
      { role: "user", content: "old user" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current user" },
    ];
    const callback = vi.fn(async (context: any) => {
      events.push("compact");
      expect(context.requestKind).toBe("iteration");
      expect(context.currentTurnMessages.map((message: any) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
      expect(context.currentTurnMessages.at(-1)).toMatchObject({
        role: "tool",
        tool_call_id: "one",
        content: "result-one",
      });
      expect(context.estimatePromptTokens(context.modelMessages)).toBe(500);
      return {
        messages: [
          { role: "system", content: "compressed summary" },
          ...context.currentTurnMessages,
        ],
      };
    });

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: initialMessages,
      provider: provider as any,
      tools: tools(events),
      maxIterations: 3,
      maxTokens: 100,
      contextWindowTokens: 10_000,
      currentTurnMessageStartIndex: 3,
      beforeFollowupModelRequest: callback,
      checkpointCallback: (checkpoint) => {
        if (checkpoint.phase === "toolsCompleted") events.push("checkpoint-tools-completed");
      },
      hook: new RecordingHook(),
    }));

    expect(events).toEqual([
      "model-1",
      "tool-one",
      "checkpoint-tools-completed",
      "after-0",
      "compact",
      "model-2",
      "after-1",
    ]);
    expect(callback).toHaveBeenCalledOnce();
    expect(requests[1].messages.some((message: any) => message.content === "old user")).toBe(false);
    expect(requests[1].messages.some((message: any) => message.content === "compressed summary")).toBe(true);
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "current user" }),
      expect.objectContaining({ role: "tool", tool_call_id: "one", content: "result-one" }),
    ]));
    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "old user" }),
      expect.objectContaining({ role: "assistant", content: "old answer" }),
      expect.objectContaining({ role: "tool", tool_call_id: "one", content: "result-one" }),
    ]));
  });

  it("keeps an existing projection and appends later transcript deltas once", async () => {
    const requests: Record<string, any>[] = [];
    const provider = {
      generation: { maxTokens: 100 },
      chatWithRetry: vi.fn(async (args: Record<string, any>) => {
        requests.push(args);
        if (requests.length === 1) return new LLMResponse({ content: "one", toolCalls: [toolCall("one")] });
        if (requests.length === 2) return new LLMResponse({ content: "two", toolCalls: [toolCall("two")] });
        return new LLMResponse({ content: "done" });
      }),
    };
    let callbackCount = 0;
    const beforeFollowupModelRequest = vi.fn(async (context: any) => {
      callbackCount += 1;
      if (callbackCount > 1) return null;
      return {
        messages: [
          { role: "system", content: "summary" },
          ...context.currentTurnMessages,
        ],
      };
    });

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current" },
      ],
      provider: provider as any,
      tools: tools([]),
      maxIterations: 4,
      currentTurnMessageStartIndex: 3,
      beforeFollowupModelRequest,
    }));

    expect(beforeFollowupModelRequest).toHaveBeenCalledTimes(2);
    const thirdRequest = requests[2].messages;
    expect(thirdRequest.some((message: any) => message.content === "old")).toBe(false);
    expect(thirdRequest.filter((message: any) => message.tool_call_id === "two")).toHaveLength(1);
    expect(thirdRequest.filter((message: any) => message.content === "result-two")).toHaveLength(1);
    expect(result.messages.filter((message) => message.tool_call_id === "two")).toHaveLength(1);
  });

  it("does not check compaction for a single-sample completed turn", async () => {
    const callback = vi.fn(async () => null);
    const provider = {
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "done" })),
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "current" }],
      provider: provider as any,
      maxIterations: 2,
      currentTurnMessageStartIndex: 0,
      beforeFollowupModelRequest: callback,
    }));

    expect(result.finalContent).toBe("done");
    expect(callback).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after compaction and skips the next provider request", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const provider = {
      chatWithRetry: vi.fn(async () => {
        requestCount += 1;
        return new LLMResponse({ content: "working", toolCalls: [toolCall("one")] });
      }),
    };
    const callback = vi.fn(async () => {
      controller.abort();
      return null;
    });

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "current" }],
      provider: provider as any,
      tools: tools([]),
      maxIterations: 3,
      abortSignal: controller.signal,
      currentTurnMessageStartIndex: 0,
      beforeFollowupModelRequest: callback,
    }));

    expect(callback).toHaveBeenCalledOnce();
    expect(requestCount).toBe(1);
    expect(result.stopReason).toBe("cancelled");
  });
});
