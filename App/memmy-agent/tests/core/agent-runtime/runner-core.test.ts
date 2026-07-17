import { describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { renderTemplate } from "../../../src/utils/prompt-templates.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../../../src/utils/runtime.js";

class FakeProvider extends LLMProvider {
  calls: any[] = [];
  constructor(private readonly responses: LLMResponse[]) {
    super();
  }
  getDefaultModel(): string {
    return "test-model";
  }
  async chatWithRetry(args: any): Promise<LLMResponse> {
    this.calls.push(args);
    return this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
  }
  async chat(args: any): Promise<LLMResponse> {
    return this.chatWithRetry(args);
  }
}

class StaticTool extends Tool {
  constructor(
    private readonly toolName: string,
    private readonly result: any,
    private readonly opts: { readOnly?: boolean; exclusive?: boolean; onRun?: () => Promise<void> | void } = {},
  ) {
    super();
  }
  get name(): string {
    return this.toolName;
  }
  get description(): string {
    return this.toolName;
  }
  get parameters() {
    return { type: "object", properties: {} };
  }
  override get readOnly(): boolean {
    return Boolean(this.opts.readOnly);
  }
  override get exclusive(): boolean {
    return Boolean(this.opts.exclusive);
  }
  async execute(): Promise<any> {
    await this.opts.onRun?.();
    return this.result;
  }
}

describe("AgentRunner expanded behavior", () => {
  it("preserves reasoning fields, executes tools, calls hooks, and accumulates usage", async () => {
    const provider = new FakeProvider([
      new LLMResponse({
        content: "working",
        toolCalls: [new ToolCallRequest({ id: "call_1", name: "list_dir", arguments: {} })],
        reasoningContent: "hidden reasoning",
        thinkingBlocks: [{ type: "thinking", thinking: "step" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
        finishReason: "tool_calls",
      }),
      new LLMResponse({
        content: "done",
        usage: { prompt_tokens: 2, completion_tokens: 4, cached_tokens: 1 },
        finishReason: "stop",
      }),
    ]);
    const tools = new ToolRegistry();
    tools.register(new StaticTool("list_dir", "tool result"));
    const events: any[] = [];
    class RecordingHook extends AgentHook {
      override async beforeIteration(ctx: AgentHookContext): Promise<void> {
        events.push(["before", ctx.iteration]);
      }
      override async beforeExecuteTools(ctx: AgentHookContext): Promise<void> {
        events.push(["tools", ctx.iteration, ctx.toolCalls?.map((call) => call.name)]);
      }
      override async afterIteration(ctx: AgentHookContext): Promise<void> {
        events.push(["after", ctx.iteration, ctx.finalContent, ctx.toolResults, ctx.stopReason]);
      }
      override finalizeContent(ctx: AgentHookContext, content: string | null): string | null {
        return content?.toUpperCase() ?? content;
      }
    }

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "do task" }],
        tools,
        model: "test-model",
        maxIterations: 3,
        hook: new RecordingHook(),
      }),
    );

    expect(result.finalContent).toBe("DONE");
    expect(result.toolsUsed).toEqual(["list_dir"]);
    expect(result.toolEvents).toEqual([{ name: "list_dir", status: "ok", detail: "tool result" }]);
    expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 7, cached_tokens: 1 });
    expect(result.messages.find((message) => message.tool_calls?.length)).toMatchObject({
      role: "assistant",
      finish_reason: "tool_calls",
    });
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "DONE", finish_reason: "stop" });
    expect(provider.calls[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "hidden reasoning",
          thinking_blocks: [{ type: "thinking", thinking: "step" }],
        }),
        expect.objectContaining({ role: "tool", content: "tool result" }),
      ]),
    );
    expect(provider.calls[1].messages.every((message: any) => !("finish_reason" in message))).toBe(true);
    expect(events).toEqual([
      ["before", 0],
      ["tools", 0, ["list_dir"]],
      ["after", 0, null, ["tool result"], null],
      ["before", 1],
      ["after", 1, "DONE", [], "completed"],
    ]);
  });

  it("returns a max-iterations final assistant message when tools never finish", async () => {
    const provider = new FakeProvider([
      new LLMResponse({
        content: "still working",
        toolCalls: [new ToolCallRequest({ id: "call_1", name: "noop", arguments: {} })],
      }),
    ]);
    const tools = new ToolRegistry();
    tools.register(new StaticTool("noop", ""));

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({ messages: [], tools, maxIterations: 2, model: "test-model" }),
    );

    expect(result.stopReason).toBe("maxIterations");
    expect(result.finalContent).toBe(renderTemplate("agent/max-iterations-message.md", { strip: true, maxIterations: 2 }));
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: result.finalContent });
    expect(result.messages.at(-1)).not.toHaveProperty("finish_reason");
  });

  it("preserves custom max-iterations final messages", async () => {
    const provider = new FakeProvider([
      new LLMResponse({
        content: "still working",
        toolCalls: [new ToolCallRequest({ id: "call_1", name: "noop", arguments: {} })],
      }),
    ]);
    const tools = new ToolRegistry();
    tools.register(new StaticTool("noop", ""));

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        messages: [],
        tools,
        maxIterations: 2,
        maxIterationsMessage: "Custom stop after {maxIterations} loops.",
        model: "test-model",
      }),
    );

    expect(result.stopReason).toBe("maxIterations");
    expect(result.finalContent).toBe("Custom stop after 2 loops.");
  });

  it("marks empty tool output and truncates oversized tool results", async () => {
    const provider = new FakeProvider([
      new LLMResponse({
        content: "working",
        toolCalls: [
          new ToolCallRequest({ id: "empty", name: "empty_tool", arguments: {} }),
          new ToolCallRequest({ id: "large", name: "large_tool", arguments: {} }),
        ],
      }),
      new LLMResponse({ content: "done" }),
    ]);
    const tools = new ToolRegistry();
    tools.register(new StaticTool("empty_tool", ""));
    tools.register(new StaticTool("large_tool", "x".repeat(100)));

    await new AgentRunner(provider).run(
      new AgentRunSpec({ messages: [], tools, maxIterations: 2, maxToolResultChars: 10, model: "test-model" }),
    );

    const secondMessages = provider.calls[1].messages;
    expect(secondMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", content: "(empty_tool completed with no output)" })]));
    expect(secondMessages.find((msg: any) => msg.tool_call_id === "large")?.content).toContain("truncated");
  });

  it("preserves structured image tool results for the next model call", async () => {
    const imageResult = [
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc" },
        meta: { path: "/tmp/photo.png" },
      },
      { type: "text", text: "(Image file: /tmp/photo.png)" },
    ];
    const provider = new FakeProvider([
      new LLMResponse({
        content: "working",
        toolCalls: [new ToolCallRequest({ id: "tc_img", name: "read_file", arguments: { path: "/tmp/photo.png" } })],
      }),
      new LLMResponse({ content: "done" }),
    ]);
    const tools = new ToolRegistry();
    tools.register(new StaticTool("read_file", imageResult));

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "describe image" }],
        tools,
        model: "test-model",
        maxIterations: 2,
      }),
    );

    expect(result.finalContent).toBe("done");
    const toolMessage = provider.calls[1].messages.find((msg: any) => msg.role === "tool" && msg.tool_call_id === "tc_img");
    expect(Array.isArray(toolMessage.content)).toBe(true);
    expect(toolMessage.content[0]).toMatchObject({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
    });
    expect(JSON.stringify(toolMessage.content)).not.toContain("[object Object]");
  });

  it("batches concurrent read-only tools before exclusive or write tools", async () => {
    const events: string[] = [];
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const tools = new ToolRegistry();
    tools.register(new StaticTool("read_a", "a", { readOnly: true, onRun: async () => { events.push("start:read_a"); await sleep(20); events.push("end:read_a"); } }));
    tools.register(new StaticTool("read_b", "b", { readOnly: true, onRun: async () => { events.push("start:read_b"); await sleep(20); events.push("end:read_b"); } }));
    tools.register(new StaticTool("write_a", "w", { onRun: () => { events.push("start:write_a"); events.push("end:write_a"); } }));

    await new AgentRunner().executeTools(
      new AgentRunSpec({ tools, concurrentTools: true, messages: [] }),
      [
        new ToolCallRequest({ id: "a", name: "read_a", arguments: {} }),
        new ToolCallRequest({ id: "b", name: "read_b", arguments: {} }),
        new ToolCallRequest({ id: "w", name: "write_a", arguments: {} }),
      ],
    );

    expect(events.slice(0, 2).sort()).toEqual(["start:read_a", "start:read_b"]);
    expect(events.indexOf("end:read_a")).toBeLessThan(events.indexOf("start:write_a"));
    expect(events.indexOf("end:read_b")).toBeLessThan(events.indexOf("start:write_a"));
  });

  it("uses provider from the run spec when no constructor provider is set", async () => {
    const provider = new FakeProvider([new LLMResponse({ content: "ok" })]);

    const result = await new AgentRunner().run(new AgentRunSpec({ provider, messages: [{ role: "user", content: "hi" }] }));

    expect(result.content).toBe("ok");
    expect(provider.calls).toHaveLength(1);
  });

  it("times out a hung non-streaming LLM request", async () => {
    const provider = new FakeProvider([]);
    provider.chatWithRetry = vi.fn(async () => new Promise<LLMResponse>(() => {})) as any;
    const started = Date.now();

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "hello" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 1,
        llmTimeoutS: 0.02,
      }),
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.stopReason).toBe("error");
    expect(result.finalContent?.toLowerCase()).toContain("timed out");
  });

  it("does not apply the outer wall timeout to streaming requests", async () => {
    const provider = new FakeProvider([]);
    const streamed: string[] = [];
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    provider.chatWithRetry = vi.fn();
    (provider as any).chatStreamWithRetry = vi.fn(async (args: any) => {
      await sleep(20);
      await args.onContentDelta("still ");
      await sleep(20);
      await args.onContentDelta("alive");
      return new LLMResponse({ content: "still alive", toolCalls: [] });
    });
    class StreamingHook extends AgentHook {
      override wantsStreaming(): boolean {
        return true;
      }
      override async onStream(ctx: AgentHookContext, delta: string): Promise<void> {
        streamed.push(delta);
      }
    }

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "think for a while" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 1,
        hook: new StreamingHook(),
        llmTimeoutS: 0.001,
      }),
    );

    expect(result.stopReason).toBe("completed");
    expect(result.finalContent).toBe("still alive");
    expect(streamed).toEqual(["still ", "alive"]);
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("retries empty final responses with a finalization prompt and accumulates usage", async () => {
    const provider = new FakeProvider([]);
    const calls: any[] = [];
    provider.chatWithRetry = vi.fn(async (args: any) => {
      calls.push(args);
      if (calls.length <= 2) {
        return new LLMResponse({
          content: null,
          toolCalls: [],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        });
      }
      return new LLMResponse({
        content: "final answer",
        toolCalls: [],
        usage: { prompt_tokens: 3, completion_tokens: 7 },
      });
    }) as any;

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "do task" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 3,
      }),
    );

    expect(result.finalContent).toBe("final answer");
    expect(calls).toHaveLength(3);
    expect(calls[0].tools).not.toBeNull();
    expect(calls[1].tools).not.toBeNull();
    expect(calls[2].tools).toBeNull();
    expect(result.usage).toMatchObject({ prompt_tokens: 13, completion_tokens: 9 });
  });

  it("closes streaming segments before empty-response retry and finalization retry", async () => {
    const streamEnds: boolean[] = [];
    const provider = {
      chatStreamWithRetry: vi.fn(async () => new LLMResponse({ content: "", toolCalls: [], usage: {} })),
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "final answer", toolCalls: [], usage: {} })),
      getDefaultModel: () => "test-model",
    };
    class StreamingHook extends AgentHook {
      override wantsStreaming(): boolean {
        return true;
      }
      override async onStreamEnd(context: AgentHookContext, opts: { resuming?: boolean } = {}): Promise<void> {
        streamEnds.push(Boolean(opts.resuming));
      }
    }

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "do task" }],
        provider: provider as any,
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 3,
        hook: new StreamingHook(),
      }),
    );

    expect(result.finalContent).toBe("final answer");
    expect(provider.chatStreamWithRetry).toHaveBeenCalledTimes(2);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(streamEnds).toEqual([false, false, false]);
  });

  it("uses the specific empty-final-response message after finalization also returns empty", async () => {
    const provider = new FakeProvider([]);
    provider.chatWithRetry = vi.fn(async () => new LLMResponse({ content: null, toolCalls: [], usage: {} })) as any;

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "do task" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 3,
      }),
    );

    expect(result.finalContent).toBe(EMPTY_FINAL_RESPONSE_MESSAGE);
    expect(result.stopReason).toBe("emptyFinalResponse");
  });

  it("recovers from an empty intermediate response without breaking the tool chain", async () => {
    const provider = new FakeProvider([]);
    let callCount = 0;
    provider.chatWithRetry = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new LLMResponse({
          content: null,
          toolCalls: [new ToolCallRequest({ id: "tc1", name: "read_file", arguments: { path: "a.txt" } })],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }
      if (callCount === 2) {
        return new LLMResponse({ content: null, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      }
      if (callCount === 3) {
        return new LLMResponse({
          content: null,
          toolCalls: [new ToolCallRequest({ id: "tc2", name: "read_file", arguments: { path: "b.txt" } })],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }
      return new LLMResponse({
        content: "Here are the results.",
        toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    }) as any;
    const tools = new ToolRegistry();
    tools.register(new StaticTool("read_file", "file content"));

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "read both files" }],
        tools,
        model: "test-model",
        maxIterations: 10,
      }),
    );

    expect(result.finalContent).toBe("Here are the results.");
    expect(result.stopReason).toBe("completed");
    expect(callCount).toBe(4);
    expect(result.toolsUsed).toContain("read_file");
  });

  it("binds provider retry heartbeats to retryWaitCallback rather than progressCallback", async () => {
    const provider = new FakeProvider([new LLMResponse({ content: "done", toolCalls: [], usage: {} })]);
    const progressCallback = vi.fn();
    const retryWaitCallback = vi.fn();

    await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "hi" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 1,
        progressCallback,
        retryWaitCallback,
      }),
    );

    expect(provider.calls[0].onRetryWait).toBe(retryWaitCallback);
    expect(provider.calls[0].onRetryWait).not.toBe(progressCallback);
  });

  it("passes temperature through to the provider", async () => {
    const provider = new FakeProvider([new LLMResponse({ content: "done", toolCalls: [], usage: {} })]);

    await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "hi" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 1,
        temperature: 0.7,
      }),
    );

    expect(provider.calls[0].temperature).toBe(0.7);
  });

  it("passes maxTokens through to the provider", async () => {
    const provider = new FakeProvider([new LLMResponse({ content: "done", toolCalls: [], usage: {} })]);

    await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "hi" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 1,
        maxTokens: 8192,
      }),
    );

    expect(provider.calls[0].maxTokens).toBe(8192);
  });

  it("passes reasoningEffort through to the provider", async () => {
    const provider = new FakeProvider([new LLMResponse({ content: "done", toolCalls: [], usage: {} })]);

    await new AgentRunner(provider).run(
      new AgentRunSpec({
        initialMessages: [{ role: "user", content: "hi" }],
        tools: { getDefinitions: () => [] } as any,
        model: "test-model",
        maxIterations: 1,
        reasoningEffort: "high",
      }),
    );

    expect(provider.calls[0].reasoningEffort).toBe("high");
  });
});
