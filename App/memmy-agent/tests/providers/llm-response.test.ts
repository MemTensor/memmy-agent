import { describe, expect, it } from "vitest";
import { LLMResponse, ToolCallRequest } from "../../src/providers/base.js";

function response(finishReason: string, withToolCall = true): LLMResponse {
  return new LLMResponse({
    content: null,
    toolCalls: withToolCall ? [new ToolCallRequest({ id: "call_1", name: "list_dir", arguments: { path: "." } })] : [],
    finishReason,
  });
}

describe("LLMResponse", () => {
  it("never executes tools when no tool calls are present", () => {
    for (const reason of ["tool_calls", "stop", "length", "error", "refusal", "content_filter"]) {
      expect(response(reason, false).shouldExecuteTools).toBe(false);
    }
  });

  it("executes tools for the canonical tool_calls finish reason", () => {
    const resp = response("tool_calls");

    expect(resp.hasToolCalls).toBe(true);
    expect(resp.shouldExecuteTools).toBe(true);
  });

  it("executes tools when providers emit tool calls with stop", () => {
    expect(response("stop").shouldExecuteTools).toBe(true);
  });

  it("executes tools for legacy function_call finish reason", () => {
    expect(response("function_call").shouldExecuteTools).toBe(true);
  });

  it("blocks anomalous finish reasons even when tool calls are present", () => {
    for (const reason of ["refusal", "content_filter", "error", "length", ""]) {
      expect(response(reason).shouldExecuteTools).toBe(false);
    }
  });

  it("serializes tool calls in OpenAI-compatible shape", () => {
    const call = new ToolCallRequest({
      id: "call_1",
      name: "read_file",
      arguments: { path: "README.md" },
      extraContent: { cache_control: { type: "ephemeral" } },
      providerSpecificFields: { index: 0 },
      functionProviderSpecificFields: { strict: true },
    });

    expect(call.toOpenAIToolCall()).toEqual({
      id: "call_1",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "README.md" }),
        provider_specific_fields: { strict: true },
      },
      extra_content: { cache_control: { type: "ephemeral" } },
      provider_specific_fields: { index: 0 },
    });
  });
});
