import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";

describe("AnthropicProvider.mergeConsecutive", () => {
  it("keeps basic user/assistant alternation", () => {
    const result = AnthropicProvider.mergeConsecutive([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "bye" },
    ]);

    expect(result).toHaveLength(3);
    expect(result.map((msg) => msg.role)).toEqual(["user", "assistant", "user"]);
  });

  it("merges consecutive same-role messages and strips trailing assistants", () => {
    const result = AnthropicProvider.mergeConsecutive([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "reply" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("strips trailing assistant prefill messages", () => {
    const result = AnthropicProvider.mergeConsecutive([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("merges and strips multiple trailing assistants", () => {
    const result = AnthropicProvider.mergeConsecutive([
      { role: "user", content: "hello" },
      { role: "assistant", content: "a" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
    ]);

    expect(result).toHaveLength(3);
    expect(result.at(-1)?.role).toBe("user");
    expect(result.at(-1)?.content).toBe("ok");
  });

  it("handles empty message arrays", () => {
    expect(AnthropicProvider.mergeConsecutive([])).toEqual([]);
  });

  it("keeps a single user message", () => {
    expect(AnthropicProvider.mergeConsecutive([{ role: "user", content: "hi" }])).toHaveLength(1);
  });

  it("reroutes a lone assistant to user when stripping would empty the request", () => {
    const result = AnthropicProvider.mergeConsecutive([{ role: "assistant", content: "hi" }]);

    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("collapses all-assistant turns before rerouting", () => {
    const result = AnthropicProvider.mergeConsecutive([
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ]);

    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
  });

  it("does not reroute trailing assistant turns that contain tool_use blocks", () => {
    const result = AnthropicProvider.mergeConsecutive([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me search" },
          { type: "tool_use", id: "t1", name: "search", input: {} },
        ],
      },
    ]);

    expect(result).toEqual([]);
  });

  it("prepends a synthetic user turn before a bare leading assistant", () => {
    const result = AnthropicProvider.mergeConsecutive([
      { role: "assistant", content: "hi" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "reply" },
    ]);

    expect(result.map((msg) => msg.role)).toEqual(["user", "assistant", "user"]);
    expect(result[0].content).toBe("(conversation continued)");
    expect(result[1].content).toBe("hi");
    expect(result[2].content).toBe("ok");
  });

  it("leaves leading assistant tool_use turns alone", () => {
    const result = AnthropicProvider.mergeConsecutive([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "search", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ]);

    expect(result.map((msg) => msg.role)).toEqual(["assistant", "user"]);
  });
});
