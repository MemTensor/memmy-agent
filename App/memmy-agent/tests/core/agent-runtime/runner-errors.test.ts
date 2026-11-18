import { describe, expect, it } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

class QueueProvider extends LLMProvider {
  calls: any[] = [];
  constructor(private readonly responses: LLMResponse[]) {
    super();
  }
  getDefaultModel(): string {
    return "test";
  }
  async chatWithRetry(args: any): Promise<LLMResponse> {
    this.calls.push(args);
    return this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
  }
  async chat(args: any): Promise<LLMResponse> {
    return this.chatWithRetry(args);
  }
}

describe("AgentRunner errors", () => {
  it.each(["credit_insufficient", "credit_balance_reserved"])("retains the completed call and tools when the next call is denied: %s", async (code) => {
    const provider = new QueueProvider([
      new LLMResponse({content:"completed paid call",toolCalls:[new ToolCallRequest({id:"done-tool",name:"read_file",arguments:{path:"a"}})]}),
      new LLMResponse({content:`Error calling LLM: ${code}`,finishReason:"error",errorCode:code,
        errorCategory:code === "credit_insufficient" ? "quota_exhausted" : null,errorShouldRetry:false}),
    ]);
    let toolRuns=0;
    const tools={getDefinitions:()=>[],execute:async()=>{toolRuns++;return "saved tool result";}};
    const result=await new AgentRunner(provider).run(new AgentRunSpec({messages:[{role:"user",content:"task"}],tools,maxIterations:4}));
    expect(result.stopReason).toBe("error");
    expect(toolRuns).toBe(1); expect(provider.calls).toHaveLength(2);
    expect(result.messages).toContainEqual(expect.objectContaining({role:"tool",tool_call_id:"done-tool",content:"saved tool result"}));
    const continued = new QueueProvider([new LLMResponse({content:"finished",finishReason:"stop"})]);
    await new AgentRunner(continued).run(new AgentRunSpec({messages:[...result.messages,{role:"user",content:"continue"}],tools}));
    expect(toolRuns).toBe(1);
    expect(continued.calls[0].messages).toContainEqual(expect.objectContaining({role:"tool",tool_call_id:"done-tool",content:"saved tool result"}));
  });
  it("preserves already generated text in continuation context after insufficient credits", async () => {
    const error = new LLMResponse({ content: "积分不足", finishReason: "error", errorCategory: "quota_exhausted" });
    error.partialContent = "generated before exhaustion";
    const result = await new AgentRunner(new QueueProvider([error])).run(new AgentRunSpec({ messages: [{ role: "user", content: "hi" }] }));
    expect(result.stopReason).toBe("error");
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: "generated before exhaustion" }));
  });

  it("throws when no provider is available", async () => {
    await expect(new AgentRunner().run(new AgentRunSpec({ messages: [{ role: "user", content: "hi" }] }))).rejects.toThrow(
      "provider is required",
    );
  });

  it("persists a placeholder for model errors while returning the user-facing error", async () => {
    const provider = new QueueProvider([new LLMResponse({ content: "", finishReason: "error" })]);

    const result = await new AgentRunner(provider).run(new AgentRunSpec({ messages: [{ role: "user", content: "hi" }] }));

    expect(result.stopReason).toBe("error");
    expect(result.finalContent).toContain("Sorry, I encountered an error");
    expect(result.messages.at(-1)?.content).toContain("Assistant reply unavailable");
    expect(result.messages.at(-1)).not.toHaveProperty("finish_reason");
  });

  it("continues after length-truncated responses before finalizing", async () => {
    const provider = new QueueProvider([
      new LLMResponse({ content: "part one", finishReason: "length" }),
      new LLMResponse({ content: "part two", finishReason: "stop" }),
    ]);

    const result = await new AgentRunner(provider).run(new AgentRunSpec({ messages: [{ role: "user", content: "hi" }], maxIterations: 3 }));

    expect(result.finalContent).toBe("part two");
    expect(result.messages.find((message) => message.content === "part one")).toMatchObject({
      role: "assistant",
      finish_reason: "length",
    });
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "part two", finish_reason: "stop" });
    expect(provider.calls[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.stringContaining("Output limit reached") })]));
    expect(provider.calls[1].messages.every((message: any) => !("finish_reason" in message))).toBe(true);
  });

  it("preserves tool result messages when a fatal tool error stops the run", async () => {
    const provider = new QueueProvider([
      new LLMResponse({
        content: null,
        toolCalls: [
          new ToolCallRequest({ id: "tc1", name: "read_file", arguments: { path: "a" } }),
          new ToolCallRequest({ id: "tc2", name: "exec", arguments: { cmd: "bad" } }),
        ],
      }),
    ]);
    let callIdx = 0;
    const tools = {
      getDefinitions: () => [],
      async execute() {
        callIdx += 1;
        if (callIdx === 2) throw new RuntimeError("boom");
        return "file content";
      },
    };

    const result = await new AgentRunner(provider).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "do stuff" }],
        tools,
        model: "test-model",
        maxIterations: 1,
        failOnToolError: true,
      }),
    );

    expect(result.stopReason).toBe("toolError");
    expect(result.finalContent).toBe("Error: RuntimeError: boom");
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]).toMatchObject({ tool_call_id: "tc1", content: "file content" });
    expect(toolMessages[1]).toMatchObject({ tool_call_id: "tc2", content: "Error: RuntimeError: boom" });
    const assistantToolCallIndex = result.messages.findIndex(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );
    expect(result.messages.findIndex((message) => message.tool_call_id === "tc1")).toBeGreaterThan(assistantToolCallIndex);
    expect(result.messages.findIndex((message) => message.tool_call_id === "tc2")).toBeGreaterThan(assistantToolCallIndex);
  });
});

class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
