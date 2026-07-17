import { describe, expect, it, vi } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

function makeTools(execute: (name: string, params: Record<string, any>) => Promise<any> | any): any {
  return {
    getDefinitions: vi.fn(() => []),
    get: vi.fn(() => null),
    execute: vi.fn(execute),
  };
}

describe("AgentRunner tool result safety", () => {
  it("fills empty tool output and truncates oversized results", async () => {
    const runner = new AgentRunner();
    const call = new ToolCallRequest({ id: "c1", name: "noop" });
    const spec = new AgentRunSpec({
      maxToolResultChars: 4,
      tools: { execute: async () => "abcdef", get: () => null } as any,
    });

    const [result] = await runner.executeTools(spec, [call]);

    expect(result.result).toContain("abcd");
    expect(result.result).toContain("truncated");
  });

  it("does not abort on workspace boundary violations", async () => {
    const responses = [
      new LLMResponse({
        content: "trying outside",
        toolCalls: [
          new ToolCallRequest({
            id: "call_1",
            name: "read_file",
            arguments: { path: "/tmp/outside.md" },
          }),
        ],
      }),
      new LLMResponse({ content: "ok, telling the user instead", toolCalls: [] }),
    ];
    const provider = { chatWithRetry: vi.fn(async () => responses.shift()!) };
    const tools = makeTools(async () => {
      throw new Error("Path /tmp/outside.md is outside allowed directory /workspace");
    });

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [],
      tools,
      model: "test-model",
      maxIterations: 3,
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(result.stopReason).not.toBe("toolError");
    expect(result.error).toBeNull();
    expect(result.finalContent).toBe("ok, telling the user instead");
    expect(result.toolEvents[0]).toMatchObject({ status: "error" });
    expect(result.toolEvents[0]?.detail).toContain("workspace_violation");
  });

  it("classifies SSRF guard messages separately from workspace boundaries", () => {
    expect(AgentRunner.isSsrfViolation("Error: Command blocked by safety guard (internal/private URL detected)")).toBe(true);
    expect(AgentRunner.isSsrfViolation(
      "URL validation failed: Blocked: host resolves to private/internal address 192.168.1.2",
    )).toBe(true);
    expect(AgentRunner.isSsrfViolation("Error: Command blocked by safety guard (path outside working dir)")).toBe(false);
    expect(AgentRunner.isSsrfViolation("Path /tmp/x is outside allowed directory /ws")).toBe(false);
    expect(AgentRunner.isSsrfViolation("Error: Command blocked by deny pattern filter")).toBe(false);
  });

  it("returns a non-retryable hint on SSRF violations and lets the model recover", async () => {
    const responses = [
      new LLMResponse({
        content: "curl-ing metadata",
        toolCalls: [
          new ToolCallRequest({
            id: "call_ssrf",
            name: "exec",
            arguments: { command: "curl http://169.254.169.254" },
          }),
        ],
      }),
      new LLMResponse({
        content: "I cannot access that private URL. Please share local files.",
        toolCalls: [],
      }),
    ];
    const provider = { chatWithRetry: vi.fn(async () => responses.shift()!) };
    const tools = makeTools(async () => "Error: Command blocked by safety guard (internal/private URL detected)");

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [],
      tools,
      model: "test-model",
      maxIterations: 3,
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.finalContent).toBe("I cannot access that private URL. Please share local files.");
    expect(result.toolEvents[0]?.detail).toMatch(/^ssrf_violation:/);
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toContain("non-bypassable security boundary");
    expect(toolMessages[0].content).toContain("Do not retry");
    expect(toolMessages[0].content).toContain("tools.ssrfWhitelist");
  });

  it("lets the model recover from shell guard path-outside rejections", async () => {
    const capturedSecondCall: Record<string, any>[][] = [];
    const provider = {
      chatWithRetry: vi.fn(async ({ messages }: { messages: Record<string, any>[] }) => {
        if (capturedSecondCall.length === 0) {
          capturedSecondCall.push(messages);
          return new LLMResponse({
            content: "trying noisy cleanup",
            toolCalls: [
              new ToolCallRequest({
                id: "call_blocked",
                name: "exec",
                arguments: { command: "rm scratch.txt 2>/dev/null" },
              }),
            ],
          });
        }
        capturedSecondCall.push(messages);
        return new LLMResponse({ content: "recovered final answer", toolCalls: [] });
      }),
    };
    const tools = makeTools(async () => "Error: Command blocked by safety guard (path outside working dir)");

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [],
      tools,
      model: "test-model",
      maxIterations: 3,
    }));

    expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(result.stopReason).not.toBe("toolError");
    expect(result.error).toBeNull();
    expect(result.finalContent).toBe("recovered final answer");
    expect(result.toolEvents[0]).toMatchObject({ status: "error" });
    expect(result.toolEvents[0]?.detail).toContain("workspace_violation");
    expect(capturedSecondCall[1].some((message) => message.role === "tool")).toBe(true);
  });

  it("throttles repeated workspace bypass attempts without aborting the turn", async () => {
    const responses: LLMResponse[] = [...Array(4).keys()].map((idx) =>
      new LLMResponse({
        content: `try ${idx}`,
        toolCalls: [
          new ToolCallRequest({
            id: `a${idx}`,
            name: "exec",
            arguments: { command: `cat /Users/x/Downloads/01.md  # try ${idx}` },
          }),
        ],
      }));
    responses.push(new LLMResponse({ content: "ok telling user", toolCalls: [] }));
    const provider = { chatWithRetry: vi.fn(async () => responses.shift()!) };
    const tools = makeTools(async () => "Error: Command blocked by safety guard (path outside working dir)");

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [],
      tools,
      model: "test-model",
      maxIterations: 10,
    }));

    expect(result.stopReason).not.toBe("toolError");
    expect(result.error).toBeNull();
    expect(result.finalContent).toBe("ok telling user");
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(5);
    const escalated = result.toolEvents.filter((event) =>
      event.status === "error" && String(event.detail).startsWith("workspace_violation_escalated:"));
    expect(escalated.length).toBeGreaterThanOrEqual(1);
  });
});
