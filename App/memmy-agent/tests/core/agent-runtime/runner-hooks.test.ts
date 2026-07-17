import { describe, expect, it } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

class FinalHook extends AgentHook {
  override finalizeContent(ctx: AgentHookContext, content: string | null): string | null {
    return `${content}!`;
  }
}

describe("AgentRunner hooks", () => {
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
