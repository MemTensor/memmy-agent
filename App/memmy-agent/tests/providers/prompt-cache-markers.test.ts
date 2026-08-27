import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";

describe("prompt cache markers", () => {
  function openaiTools(...names: string[]): Record<string, any>[] {
    return names.map((name) => ({
      type: "function",
      function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
    }));
  }

  it("marks builtin boundary and tail tools for OpenAI-compatible prompt caching", () => {
    const messages = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ];
    const tools = openaiTools("read_file", "write_file", "mcp_fs_ls", "mcp_git_status");

    const [markedMessages, marked] = OpenAICompatProvider.applyCacheControl(messages, tools);

    expect(markedMessages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(markedMessages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(marked!.filter((tool) => tool.cache_control).map((tool) => tool.function.name)).toEqual(["write_file", "mcp_git_status"]);
  });

  it("marks only the OpenAI-compatible tail tool when no MCP tools exist", () => {
    const [, marked] = OpenAICompatProvider.applyCacheControl(
      [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      openaiTools("read_file", "write_file"),
    );

    expect(marked!.filter((tool) => tool.cache_control).map((tool) => tool.function.name)).toEqual([
      "write_file",
    ]);
  });

  it("marks builtin boundary and tail tools for Anthropic prompt caching", () => {
    const tools = ["read_file", "write_file", "mcp_fs_ls", "mcp_git_status"].map((name) => ({ name, input_schema: {} }));

    const [, , marked] = AnthropicProvider.applyCacheControl("system", [], tools);

    expect(marked!.filter((tool) => tool.cache_control).map((tool) => tool.name)).toEqual(["write_file", "mcp_git_status"]);
  });
});
