import { describe, expect, it } from "vitest";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { OpenAICompatProvider } from "../../../src/providers/openai-compat-provider.js";

const geminiExtra = { google: { thought_signature: "sig-abc-123" } };

function sdkResponseWithExtraContent(): Record<string, any> {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              index: 0,
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
              extra_content: geminiExtra,
            },
          ],
          reasoning_content: null,
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe("Gemini thought signatures", () => {
  it("preserves provider thinking blocks on run results", () => {
    const response = new LLMResponse({ content: "answer", thinkingBlocks: [{ type: "thinking", signature: "sig" }] });
    const result = new AgentRunResult({ response });

    expect(result.response.thinkingBlocks).toEqual([{ type: "thinking", signature: "sig" }]);
  });

  it("serializes extra_content on tool calls", () => {
    const call = new ToolCallRequest({
      id: "abc123xyz",
      name: "read_file",
      arguments: { path: "todo.md" },
      extraContent: geminiExtra,
    });

    const payload = call.toOpenAIToolCall();

    expect(payload.extra_content).toEqual(geminiExtra);
    expect(payload.function.arguments).toBe('{"path":"todo.md"}');
  });

  it("serializes provider-specific tool call fields", () => {
    const call = new ToolCallRequest({
      id: "abc123xyz",
      name: "read_file",
      arguments: { path: "todo.md" },
      providerSpecificFields: { custom_key: "custom_val" },
      functionProviderSpecificFields: { inner: "value" },
    });

    const payload = call.toOpenAIToolCall();

    expect(payload.provider_specific_fields).toEqual({ custom_key: "custom_val" });
    expect(payload.function.provider_specific_fields).toEqual({ inner: "value" });
  });

  it("omits absent extra and provider-specific fields", () => {
    const payload = new ToolCallRequest({ id: "x", name: "fn", arguments: {} }).toOpenAIToolCall();

    expect(payload).not.toHaveProperty("extra_content");
    expect(payload).not.toHaveProperty("provider_specific_fields");
    expect(payload.function).not.toHaveProperty("provider_specific_fields");
  });

  it("preserves extra_content when parsing SDK-style tool calls", () => {
    const result = new OpenAICompatProvider().parseResponse(sdkResponseWithExtraContent());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(result.toolCalls[0].extraContent).toEqual(geminiExtra);
    expect(result.toolCalls[0].toOpenAIToolCall().extra_content).toEqual(geminiExtra);
  });

  it("preserves extra_content when parsing object tool calls", () => {
    const result = new OpenAICompatProvider().parseResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                extra_content: geminiExtra,
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].extraContent).toEqual(geminiExtra);
    expect(result.toolCalls[0].toOpenAIToolCall().extra_content).toEqual(geminiExtra);
  });

  it("preserves extra_content when parsing streaming SDK-style chunks", () => {
    const result = OpenAICompatProvider.parseChunks([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            delta: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                  extra_content: geminiExtra,
                },
              ],
            },
          },
        ],
        usage: null,
      },
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].extraContent).toEqual(geminiExtra);
    expect(result.toolCalls[0].toOpenAIToolCall().extra_content).toEqual(geminiExtra);
  });

  it("preserves extra_content when parsing streaming object chunks", () => {
    const result = OpenAICompatProvider.parseChunks([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            delta: {
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                  extra_content: geminiExtra,
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].extraContent).toEqual(geminiExtra);
    expect(result.toolCalls[0].toOpenAIToolCall().extra_content).toEqual(geminiExtra);
  });

  it("keeps stale Gemini extra_content inside sanitized tool calls", () => {
    const sanitized = new OpenAICompatProvider().sanitizeMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "fn", arguments: "{}" },
            extra_content: geminiExtra,
          },
        ],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
      { role: "user", content: "thanks" },
    ]);

    expect(sanitized[1].tool_calls[0].extra_content).toEqual(geminiExtra);
  });
});
