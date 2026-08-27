import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { LLMProvider } from "../../src/providers/base.js";

describe("Anthropic tool result history", () => {
  it("converts image_url blocks inside tool_result list content", () => {
    const block = AnthropicProvider.toolResultBlock({
      role: "tool",
      tool_call_id: "call_1",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
          meta: { path: "/tmp/x.png" },
        },
        { type: "text", text: "(Image file: /tmp/x.png)" },
      ],
    });

    expect(block).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AAAA",
          },
        },
        { type: "text", text: "(Image file: /tmp/x.png)" },
      ],
    });
  });

  it("preserves string tool_result content", () => {
    const block = AnthropicProvider.toolResultBlock({
      role: "tool",
      tool_call_id: "call_2",
      content: "plain tool output",
    });

    expect(block).toEqual({
      type: "tool_result",
      tool_use_id: "call_2",
      content: "plain tool output",
    });
  });

  it("preserves assistant tool calls followed by tool results", () => {
    const result = LLMProvider.enforceRoleAlternation([
      { role: "user", content: "read it" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc_1", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc_1", content: "file text" },
      { role: "user", content: "summarize" },
    ]);

    expect(result.map((msg) => msg.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(result[2]).toMatchObject({ role: "tool", tool_call_id: "tc_1", content: "file text" });
  });
});
