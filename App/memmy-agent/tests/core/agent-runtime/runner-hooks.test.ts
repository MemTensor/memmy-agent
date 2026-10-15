import { describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

class FinalHook extends AgentHook {
  override finalizeContent(ctx: AgentHookContext, content: string | null): string | null {
    return `${content}!`;
  }
}

describe("AgentRunner hooks", () => {
  it("adds beforeIteration messages only to the current model request", async () => {
    const requests: any[][] = [];
    const provider = {
      chatWithRetry: async ({ messages }: any) => {
        requests.push(messages);
        return new LLMResponse({ content: "done" });
      },
    };
    class InjectionHook extends AgentHook {
      override async beforeIteration() {
        return [{ role: "user" as const, content: "request-only memory" }];
      }
    }
    const initial = [{ role: "user", content: "question" }];

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: initial,
      hook: new InjectionHook(),
      maxIterations: 1,
    }));

    expect(requests[0]?.at(-1)?.content).toContain("request-only memory");
    expect(initial).toEqual([{ role: "user", content: "question" }]);
    expect(result.messages.some((message) => String(message.content).includes("request-only memory"))).toBe(false);
    expect(result.hadInjections).toBe(false);
  });

  it("continues before executing rejected tool calls", async () => {
    const requests: any[][] = [];
    let call = 0;
    const provider = {
      chatWithRetry: async ({ messages }: any) => {
        requests.push(messages);
        call += 1;
        if (call === 1) {
          return new LLMResponse({
            content: "draft",
            toolCalls: [new ToolCallRequest({ id: "call_1", name: "dangerous", arguments: {} })],
          });
        }
        return new LLMResponse({ content: "verified" });
      },
    };
    const execute = vi.fn(async () => "should not run");
    const tools = {
      getDefinitions: () => [],
      get: () => null,
      execute,
    };
    class VerificationHook extends AgentHook {
      rewrites = 0;
      override async rewriteLlmContent(context: AgentHookContext, content: string | null) {
        this.rewrites += 1;
        return this.rewrites === 1
          ? { content: "revise this answer", continue: true as const }
          : content;
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "question" }],
      tools,
      hook: new VerificationHook(),
      maxIterations: 2,
    }));

    expect(result.finalContent).toBe("verified");
    expect(execute).not.toHaveBeenCalled();
    expect(requests[1]?.at(-1)?.content).toContain("revise this answer");
    expect(result.messages.some((message) => String(message.content).includes("revise this answer"))).toBe(false);
  });

  it("does not run an unverified finalization request after continuation exhausts iterations", async () => {
    const provider = {
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "unverified draft" })),
    };
    class RejectingHook extends AgentHook {
      override async rewriteLlmContent() {
        return { content: "try again", continue: true as const };
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "question" }],
      hook: new RejectingHook(),
      maxIterations: 1,
      maxIterationsFinalPrompt: "Summarize completed work.",
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("maxIterations");
    expect(result.messages.some((message) => message.content === "unverified draft")).toBe(false);
  });

  it("continues from beforeFinalize with request-only feedback", async () => {
    const requests: any[][] = [];
    const checkpoints: string[] = [];
    let calls = 0;
    let afterRuns = 0;
    const provider = {
      chatWithRetry: async ({ messages }: any) => {
        requests.push(structuredClone(messages));
        calls += 1;
        return new LLMResponse({ content: calls === 1 ? "unverified draft" : "verified answer" });
      },
    };
    class StopHook extends AgentHook {
      override requiresBufferedLlmContent(): boolean {
        return true;
      }
      override async beforeFinalize(_context: AgentHookContext, candidate: string) {
        return candidate === "unverified draft"
          ? [{ role: "user" as const, content: "verify the page count before answering" }]
          : [];
      }
      override async afterRun(): Promise<void> {
        afterRuns += 1;
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "question" }],
      hook: new StopHook(),
      maxIterations: 2,
      checkpointCallback: ({ phase }) => {
        checkpoints.push(phase);
      },
    }));

    expect(result.finalContent).toBe("verified answer");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.at(-1)?.content).toContain("verify the page count before answering");
    expect(result.messages.some((message) => String(message.content).includes("unverified draft"))).toBe(false);
    expect(result.messages.some((message) => String(message.content).includes("verify the page count"))).toBe(false);
    expect(checkpoints).toEqual(["finalResponse"]);
    expect(afterRuns).toBe(1);
  });

  it("does not submit a candidate rejected by beforeFinalize when iterations are exhausted", async () => {
    const provider = {
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "unverified draft" })),
    };
    class StopHook extends AgentHook {
      override async beforeFinalize() {
        return [{ role: "user" as const, content: "verification failed" }];
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "question" }],
      hook: new StopHook(),
      maxIterations: 1,
      maxIterationsFinalPrompt: "Summarize completed work.",
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("maxIterations");
    expect(result.messages.some((message) => message.content === "unverified draft")).toBe(false);
  });

  it("checks a max-iteration finalization candidate before submitting it", async () => {
    let calls = 0;
    const candidates: string[] = [];
    const provider = {
      chatWithRetry: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new LLMResponse({
            content: "working",
            toolCalls: [new ToolCallRequest({ id: "call_1", name: "read_file", arguments: {} })],
          });
        }
        return new LLMResponse({ content: "unverified summary" });
      }),
    };
    const tools = {
      getDefinitions: () => [],
      get: () => null,
      execute: async () => "tool result",
    };
    class StopHook extends AgentHook {
      override async beforeFinalize(_context: AgentHookContext, candidate: string) {
        candidates.push(candidate);
        return [{ role: "user" as const, content: "verification failed" }];
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "question" }],
      tools,
      hook: new StopHook(),
      maxIterations: 1,
      maxIterationsMessage: "iteration limit reached",
      maxIterationsFinalPrompt: "Summarize completed work.",
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(candidates).toEqual(["unverified summary"]);
    expect(result.finalContent).toBe("iteration limit reached");
    expect(result.messages.some((message) => message.content === "unverified summary")).toBe(false);
  });

  it("lets hooks finalize assistant content", async () => {
    const provider = { chatWithRetry: async () => new LLMResponse({ content: "done" }) };
    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({ messages: [], hook: new FinalHook() }));

    expect(result.finalContent).toBe("done!");
  });

  it("calls lifecycle hooks in order with tool context", async () => {
    let calls = 0;
    const events: any[] = [];
    const provider = {
      chatWithRetry: async () => {
        calls += 1;
        if (calls === 1) {
          return new LLMResponse({
            content: "thinking",
            toolCalls: [new ToolCallRequest({ id: "call_1", name: "list_dir", arguments: { path: "." } })],
          });
        }
        return new LLMResponse({ content: "done", toolCalls: [], usage: {} });
      },
    };
    const tools = {
      getDefinitions: () => [],
      get: () => null,
      execute: async () => "tool result",
    };
    class RecordingHook extends AgentHook {
      override async beforeIteration(context: AgentHookContext): Promise<void> {
        events.push(["beforeIteration", context.iteration]);
      }
      override async beforeExecuteTools(context: AgentHookContext): Promise<void> {
        events.push(["beforeExecuteTools", context.iteration, context.toolCalls?.map((call) => call.name)]);
      }
      override async afterIteration(context: AgentHookContext): Promise<void> {
        events.push([
          "afterIteration",
          context.iteration,
          context.finalContent,
          [...(context.toolResults ?? [])],
          [...(context.toolEvents ?? [])],
          context.stopReason,
        ]);
      }
      override finalizeContent(context: AgentHookContext, content: string | null): string | null {
        events.push(["finalizeContent", context.iteration, content]);
        return content?.toUpperCase() ?? content;
      }
      override async beforeFinalize(context: AgentHookContext, candidate: string) {
        events.push(["beforeFinalize", context.iteration, candidate]);
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [],
      tools,
      model: "test-model",
      maxIterations: 3,
      hook: new RecordingHook(),
    }));

    expect(result.finalContent).toBe("DONE");
    expect(events).toEqual([
      ["beforeIteration", 0],
      ["beforeExecuteTools", 0, ["list_dir"]],
      ["afterIteration", 0, null, ["tool result"], [{ name: "list_dir", status: "ok", detail: "tool result" }], null],
      ["beforeIteration", 1],
      ["finalizeContent", 1, "done"],
      ["beforeFinalize", 1, "DONE"],
      ["afterIteration", 1, "DONE", [], [], "completed"],
    ]);
  });

  it("streams content deltas and end signal through hooks", async () => {
    const streamed: string[] = [];
    const endings: boolean[] = [];
    const provider = {
      chatStreamWithRetry: async ({ onContentDelta }: any) => {
        await onContentDelta("he");
        await onContentDelta("llo");
        return new LLMResponse({ content: "hello", toolCalls: [], usage: {} });
      },
      chatWithRetry: async () => {
        throw new Error("chatWithRetry should not be called");
      },
    };
    class StreamingHook extends AgentHook {
      override wantsStreaming(): boolean {
        return true;
      }
      override async onStream(context: AgentHookContext, delta: string): Promise<void> {
        streamed.push(delta);
      }
      override async onStreamEnd(context: AgentHookContext, { resuming = false }: { resuming?: boolean } = {}): Promise<void> {
        endings.push(resuming);
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [],
      tools: { getDefinitions: () => [] },
      model: "test-model",
      maxIterations: 1,
      hook: new StreamingHook(),
    }));

    expect(result.finalContent).toBe("hello");
    expect(streamed).toEqual(["he", "llo"]);
    expect(endings).toEqual([false]);
  });

  it("passes cached token usage to hook context", async () => {
    const capturedUsage: Record<string, any>[] = [];
    class UsageHook extends AgentHook {
      override async afterIteration(context: AgentHookContext): Promise<void> {
        capturedUsage.push({ ...(context.usage ?? {}) });
      }
    }
    const provider = {
      chatWithRetry: async () =>
        new LLMResponse({
          content: "done",
          toolCalls: [],
          usage: { prompt_tokens: 200, completion_tokens: 20, cached_tokens: 150 },
        }),
    };

    await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [],
      tools: { getDefinitions: () => [] },
      model: "test-model",
      maxIterations: 1,
      hook: new UsageHook(),
    }));

    expect(capturedUsage).toHaveLength(1);
    expect(capturedUsage[0].cached_tokens).toBe(150);
  });
});
