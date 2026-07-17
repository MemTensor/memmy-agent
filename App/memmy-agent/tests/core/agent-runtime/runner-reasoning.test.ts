import { describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentProgressHook } from "../../../src/core/agent-runtime/progress-hook.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { withProgressCapabilities } from "../../../src/utils/progress-events.js";

const MAX_TOOL_RESULT_CHARS = 100_000;

class RecordingHook extends AgentHook {
  emitted: string[] = [];
  endCalls = 0;

  override async emitReasoning(reasoningContent?: string | null): Promise<void> {
    if (reasoningContent) this.emitted.push(reasoningContent);
  }

  override async emitReasoningEnd(): Promise<void> {
    this.endCalls += 1;
  }
}

class StreamRecordingHook extends RecordingHook {
  override wantsStreaming(): boolean {
    return true;
  }

  override async onStream(ctx: AgentHookContext, delta: string): Promise<void> {}
}

function noTools(extra: Record<string, any> = {}): any {
  const tools = {
    getDefinitions: vi.fn(() => []),
    execute: vi.fn(async () => "tool result"),
    ...extra,
  };
  return tools;
}

describe("AgentRunner reasoning progress", () => {
  it("emits reasoning and closes reasoning segments", async () => {
    const events: any[] = [];
    const hook = new AgentProgressHook(
      withProgressCapabilities(
        (content, opts) => {
          events.push([content, opts]);
        },
        { reasoning: true },
      ),
    );

    await hook.emitReasoning("thinking");
    await hook.emitReasoningEnd();

    expect(events).toEqual([
      ["thinking", { reasoning: true }],
      ["", { reasoningEnd: true }],
    ]);
  });

  it("preserves reasoning fields in assistant history after tool calls", async () => {
    const capturedSecondCall: Record<string, any>[] = [];
    let calls = 0;
    const provider = {
      chatWithRetry: vi.fn(async ({ messages }: any) => {
        calls += 1;
        if (calls === 1) {
          return new LLMResponse({
            content: "thinking",
            toolCalls: [new ToolCallRequest({ id: "call_1", name: "list_dir", arguments: { path: "." } })],
            reasoningContent: "hidden reasoning",
            thinkingBlocks: [{ type: "thinking", thinking: "step" }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          });
        }
        capturedSecondCall.push(...messages);
        return new LLMResponse({ content: "done", toolCalls: [], usage: {} });
      }),
    };
    const tools = noTools();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "do task" },
        ],
        provider: provider as any,
        tools,
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
      }),
    );

    expect(result.finalContent).toBe("done");
    const assistantMessages = capturedSecondCall.filter((message) => message.role === "assistant" && message.tool_calls);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].reasoning_content).toBe("hidden reasoning");
    expect(assistantMessages[0].thinking_blocks).toEqual([{ type: "thinking", thinking: "step" }]);
  });

  it("emits Anthropic thinking blocks as reasoning", async () => {
    const provider = {
      chatWithRetry: vi.fn(
        async () =>
          new LLMResponse({
            content: "The answer is 42.",
            thinkingBlocks: [
              {
                type: "thinking",
                thinking: "Let me analyze this step by step.",
                signature: "sig1",
              },
              { type: "thinking", thinking: "After careful consideration.", signature: "sig2" },
            ],
            toolCalls: [],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
      ),
    };
    const hook = new RecordingHook();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "question" }],
        provider: provider as any,
        tools: noTools(),
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        hook,
      }),
    );

    expect(result.finalContent).toBe("The answer is 42.");
    expect(hook.emitted).toHaveLength(1);
    expect(hook.emitted[0]).toContain("Let me analyze this");
    expect(hook.emitted[0]).toContain("After careful consideration");
  });

  it("emits inline think content as reasoning and strips it from the answer", async () => {
    const provider = {
      chatWithRetry: vi.fn(
        async () =>
          new LLMResponse({
            content: "<think>Let me think about this...\nThe answer is 42.</think>The answer is 42.",
            toolCalls: [],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
      ),
    };
    const hook = new RecordingHook();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "what is the answer?" }],
        provider: provider as any,
        tools: noTools(),
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        hook,
      }),
    );

    expect(result.finalContent).toBe("The answer is 42.");
    expect(hook.emitted).toEqual(["Let me think about this...\nThe answer is 42."]);
  });

  it("prefers reasoning_content over inline think while still scrubbing the answer", async () => {
    const provider = {
      chatWithRetry: vi.fn(
        async () =>
          new LLMResponse({
            content: "<think>inline thinking</think>The answer.",
            reasoningContent: "dedicated reasoning field",
            toolCalls: [],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
      ),
    };
    const hook = new RecordingHook();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "question" }],
        provider: provider as any,
        tools: noTools(),
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        hook,
      }),
    );

    expect(result.finalContent).toBe("The answer.");
    expect(hook.emitted).toEqual(["dedicated reasoning field"]);
  });

  it("emits final reasoning content even when the answer was streamed", async () => {
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onContentDelta }: any) => {
        await onContentDelta?.("The ");
        await onContentDelta?.("answer.");
        return new LLMResponse({
          content: "The answer.",
          reasoningContent: "step-by-step deduction",
          toolCalls: [],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        });
      }),
    };
    const progressCalls: string[] = [];
    const hook = new RecordingHook();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "question" }],
        provider: provider as any,
        tools: noTools(),
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        hook,
        streamProgressDeltas: true,
        progressCallback: (content: string) => {
          progressCalls.push(content);
        },
      }),
    );

    expect(result.finalContent).toBe("The answer.");
    expect(progressCalls.join("")).toBe("The answer.");
    expect(hook.emitted).toEqual(["step-by-step deduction"]);
  });

  it("does not double emit inline think content that was already streamed", async () => {
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onContentDelta }: any) => {
        await onContentDelta?.("<think>working...</think>");
        await onContentDelta?.("The answer.");
        return new LLMResponse({
          content: "<think>working...</think>The answer.",
          toolCalls: [],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        });
      }),
    };
    const hook = new RecordingHook();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "question" }],
        provider: provider as any,
        tools: noTools(),
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        hook,
        streamProgressDeltas: true,
        progressCallback: vi.fn(),
      }),
    );

    expect(result.finalContent).toBe("The answer.");
    expect(hook.emitted).toEqual(["working..."]);
    expect(hook.endCalls).toBeGreaterThanOrEqual(1);
  });

  it("closes the reasoning stream after a one-shot reasoning response", async () => {
    const provider = {
      chatWithRetry: vi.fn(
        async () =>
          new LLMResponse({
            content: "answer",
            reasoningContent: "hidden thought",
            toolCalls: [],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
      ),
    };
    const hook = new RecordingHook();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "q" }],
        provider: provider as any,
        tools: noTools(),
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        hook,
      }),
    );

    expect(result.finalContent).toBe("answer");
    expect(hook.emitted).toEqual(["hidden thought"]);
    expect(hook.endCalls).toBe(1);
  });

  it("streams native thinking deltas without post-hoc duplication", async () => {
    const provider = {
      chatStreamWithRetry: vi.fn(async ({ onContentDelta, onThinkingDelta }: any) => {
        await onThinkingDelta?.("part1");
        await onThinkingDelta?.("part2");
        await onContentDelta?.("done");
        return new LLMResponse({
          content: "done",
          toolCalls: [],
          thinkingBlocks: [{ type: "thinking", thinking: "part1part2" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        });
      }),
    };
    const hook = new StreamRecordingHook();

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "q" }],
        provider: provider as any,
        tools: noTools(),
        model: "test-model",
        maxIterations: 3,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        hook,
      }),
    );

    expect(result.finalContent).toBe("done");
    expect(hook.emitted).toEqual(["part1", "part2"]);
  });
});
