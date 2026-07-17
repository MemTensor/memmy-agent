import { describe, expect, it } from "vitest";
import { LLMProvider, SYNTHETIC_USER_CONTENT } from "../../src/providers/base.js";

const enforce = (messages: Record<string, any>[]) => LLMProvider.enforceRoleAlternation(messages);

describe("LLMProvider.enforceRoleAlternation", () => {
  it("returns empty messages unchanged", () => {
    expect(enforce([])).toEqual([]);
  });

  it("keeps an already alternating conversation", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Bye" },
    ];

    const result = enforce(messages);

    expect(result).toHaveLength(4);
    expect(result.at(-1)?.role).toBe("user");
  });

  it("removes a trailing assistant message", () => {
    const result = enforce([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("removes multiple trailing assistant messages", () => {
    const result = enforce([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "A" },
      { role: "assistant", content: "B" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("merges consecutive user messages", () => {
    const result = enforce([
      { role: "user", content: "Hello" },
      { role: "user", content: "How are you?" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Hello");
    expect(result[0].content).toContain("How are you?");
  });

  it("merges consecutive assistant messages", () => {
    const result = enforce([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "assistant", content: "How can I help?" },
      { role: "user", content: "Thanks" },
    ]);

    expect(result).toHaveLength(3);
    expect(result[1].content).toContain("Hello!");
    expect(result[1].content).toContain("How can I help?");
  });

  it("does not merge system messages", () => {
    const result = enforce([
      { role: "system", content: "System A" },
      { role: "system", content: "System B" },
      { role: "user", content: "Hi" },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("System A");
    expect(result[1].content).toBe("System B");
  });

  it("does not merge tool messages", () => {
    const result = enforce([
      { role: "user", content: "Hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", content: "result1", tool_call_id: "1" },
      { role: "tool", content: "result2", tool_call_id: "2" },
      { role: "user", content: "Next" },
    ]);

    const toolMessages = result.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
  });

  it("keeps the later assistant message when it carries tool calls", () => {
    const result = enforce([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Previous reply" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", content: "result1", tool_call_id: "1" },
      { role: "user", content: "Next" },
    ]);

    expect(result[1].role).toBe("assistant");
    expect(result[1].tool_calls).toEqual([{ id: "1" }]);
    expect(result[1].content).toBeNull();
    expect(result[2].role).toBe("tool");
  });

  it("does not overwrite an existing assistant tool-call message", () => {
    const result = enforce([
      { role: "user", content: "Hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "assistant", content: "Later plain assistant" },
      { role: "tool", content: "result1", tool_call_id: "1" },
      { role: "user", content: "Next" },
    ]);

    expect(result[1].role).toBe("assistant");
    expect(result[1].tool_calls).toEqual([{ id: "1" }]);
    expect(result[1].content).toBeNull();
    expect(result[2].role).toBe("tool");
  });

  it("uses the latest content when same-role content is not all strings", () => {
    const result = enforce([
      { role: "user", content: [{ type: "text", text: "A" }] },
      { role: "user", content: "B" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("B");
  });

  it("does not mutate original messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ];
    const originalFirst = { ...messages[0] };

    enforce(messages);

    expect(messages[0]).toEqual(originalFirst);
    expect(messages).toHaveLength(2);
  });

  it("recovers a trailing assistant as user when only system remains", () => {
    const result = enforce([
      { role: "system", content: "You are helpful." },
      { role: "assistant", content: "Subagent completed successfully." },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toContain("Subagent completed successfully.");
  });

  it("does not recover a trailing assistant when a user message remains", () => {
    const result = enforce([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]);

    expect(result).toHaveLength(2);
    expect(result.at(-1)?.role).toBe("user");
  });

  it("does not recover a trailing assistant when a tool result remains", () => {
    const result = enforce([
      { role: "system", content: "You are helpful." },
      { role: "tool", content: "result", tool_call_id: "1" },
      { role: "assistant", content: "Done." },
    ]);

    expect(result).toHaveLength(2);
    expect(result.at(-1)?.role).toBe("tool");
  });

  it("drops conversations containing only assistant messages", () => {
    const result = enforce([
      { role: "assistant", content: "A" },
      { role: "assistant", content: "B" },
    ]);

    expect(result).toEqual([]);
  });

  it("handles a realistic conversation with merged users and removed trailing assistant", () => {
    const result = enforce([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "And 3+3?" },
      { role: "user", content: "(please be quick)" },
      { role: "assistant", content: "6" },
    ]);

    expect(result).toHaveLength(4);
    expect(result[2].role).toBe("assistant");
    expect(result[3].role).toBe("user");
    expect(result[3].content).toContain("And 3+3?");
    expect(result[3].content).toContain("(please be quick)");
  });

  it("inserts a synthetic user before a leading assistant after system", () => {
    const result = enforce([
      { role: "system", content: "sys" },
      { role: "assistant", content: "previous reply" },
      { role: "tool", tool_call_id: "tc_1", content: "result" },
      { role: "assistant", content: "after tool" },
    ]);

    const nonSystem = result.filter((message) => message.role !== "system");
    expect(nonSystem[0].role).toBe("user");
    expect(nonSystem[0].content).toBe(SYNTHETIC_USER_CONTENT);
    expect(nonSystem[1].role).toBe("assistant");
  });

  it("does not patch a leading assistant with tool calls", () => {
    const result = enforce([
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "ls", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc_1", content: "result" },
    ]);

    const nonSystem = result.filter((message) => message.role !== "system");
    expect(nonSystem[0].role).toBe("assistant");
    expect(nonSystem[0].tool_calls).toBeDefined();
  });

  it("does not patch a normal system to user sequence", () => {
    const result = enforce([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    expect(result[1].role).toBe("user");
    expect(result[1].content).toBe("hello");
  });
});
