import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { AgentRunner, AgentRunSpec, BACKFILL_CONTENT, MICROCOMPACT_KEEP_RECENT } from "../../../src/core/agent-runtime/runner.js";
import { InboundMessage } from "../../../src/core/runtime-messages/index.js";
import { LLMProvider, LLMResponse } from "../../../src/providers/base.js";
import { CONTEXT_SAFETY_BUFFER_TOKENS } from "../../../src/token-budget.js";

const MAX_TOOL_RESULT_CHARS = 16_000;

class CaptureProvider extends LLMProvider {
  requests: any[] = [];
  estimate = 0;

  constructor(private readonly responses: LLMResponse[] = [new LLMResponse({ content: "done" })]) {
    super();
  }

  getDefaultModel(): string {
    return "test-model";
  }

  estimatePromptTokens(): [number, string] {
    return [this.estimate, "test"];
  }

  async chatWithRetry(args: any): Promise<LLMResponse> {
    this.requests.push(args);
    return this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];
  }

  async chat(args: any): Promise<LLMResponse> {
    return this.chatWithRetry(args);
  }
}

function emptyTools(): any {
  return {
    getDefinitions: () => [],
  };
}

function runSpec(messages: Record<string, any>[], overrides: Partial<ConstructorParameters<typeof AgentRunSpec>[0]> = {}): AgentRunSpec {
  return new AgentRunSpec({
    initialMessages: messages,
    tools: emptyTools(),
    model: "test-model",
    maxIterations: 1,
    maxToolResultChars: MAX_TOOL_RESULT_CHARS,
    ...overrides,
  });
}

function stripMessage(message: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(message).filter(([key]) => ["role", "content", "tool_call_id", "name", "tool_calls"].includes(key)),
  );
}

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-runner-governance-"));
}

describe("AgentRunner governance", () => {
  it("uses the shared context safety margin when no context block limit is configured", () => {
    const provider = new CaptureProvider();
    provider.estimate = 3000;
    const runner = new AgentRunner(provider);
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: `old ${"context ".repeat(3000)}` },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "latest request" },
    ];

    const trimmed = runner.snipHistory(
      runSpec(messages, { contextWindowTokens: 10_000, maxTokens: 4000 }),
      messages,
    );

    expect(CONTEXT_SAFETY_BUFFER_TOKENS).toBe(4_096);
    expect(trimmed.length).toBeLessThan(messages.length);
    expect(trimmed.at(-1)?.content).toBe("latest request");
  });

  it("defaults to recoverable tool errors unless explicitly enabled", () => {
    expect(new AgentRunSpec({}).failOnToolError).toBe(false);
    expect(new AgentRunSpec({ failOnToolError: true }).failOnToolError).toBe(true);
  });

  it("uses raw messages when context governance fails without changing the model context", async () => {
    const provider = new CaptureProvider();
    const runner = new AgentRunner(provider);
    (runner as any).snipHistory = () => {
      throw new Error("boom");
    };
    const initialMessages = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ];

    const result = await runner.run(runSpec(initialMessages));

    expect(result.finalContent).toBe("done");
    expect(provider.requests[0].messages).toEqual(initialMessages);
  });

  it("backfills missing tool results with a synthetic error", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "exec", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", name: "exec", content: "ok" },
    ];

    const result = AgentRunner.backfillMissingToolResults(messages);
    const toolMessages = result.filter((message) => message.role === "tool");
    const backfilled = toolMessages.find((message) => message.tool_call_id === "call_b");

    expect(toolMessages).toHaveLength(2);
    expect(backfilled).toMatchObject({ content: BACKFILL_CONTENT, name: "read_file" });
  });

  it("does not copy complete message chains while backfilling", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_x", type: "function", function: { name: "exec", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_x", name: "exec", content: "done" },
      { role: "assistant", content: "all good" },
    ];

    expect(AgentRunner.backfillMissingToolResults(messages)).toBe(messages);
  });

  it("drops orphaned tool result messages", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "old user" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_ok", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_ok", name: "read_file", content: "ok" },
      { role: "tool", tool_call_id: "call_orphan", name: "exec", content: "stale" },
      { role: "assistant", content: "after tool" },
    ];

    expect(AgentRunner.dropOrphanToolResults(messages)).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "old user" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_ok", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_ok", name: "read_file", content: "ok" },
      { role: "assistant", content: "after tool" },
    ]);
  });

  it("drops orphaned tool results from a trimmed slice", () => {
    const provider = new CaptureProvider();
    provider.estimate = 500;
    const runner = new AgentRunner(provider);
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "old user" },
      {
        role: "assistant",
        content: "tool call",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "tool output".repeat(80) },
      { role: "assistant", content: "after tool" },
    ];

    const trimmed = runner.snipHistory(
      runSpec(messages, { contextWindowTokens: 2000, contextBlockLimit: 128 }),
      messages,
    );
    const nonSystem = trimmed.filter((message) => message.role !== "system");

    expect(nonSystem[0].role).toBe("user");
  });

  it("repairs orphans after snipping drops the matching assistant call", () => {
    const snipped = [
      { role: "system", content: "system" },
      { role: "tool", tool_call_id: "tc_old", name: "search", content: "old result" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new msg" },
    ];

    const cleaned = AgentRunner.dropOrphanToolResults(snipped);

    expect(cleaned.some((message) => message.role === "tool" && message.tool_call_id === "tc_old")).toBe(false);
  });

  it("minimal governance fallback still repairs orphan tool results", () => {
    const repaired = AgentRunner.backfillMissingToolResults(
      AgentRunner.dropOrphanToolResults([
        { role: "user", content: "hello" },
        { role: "tool", tool_call_id: "orphan_tc", name: "read", content: "stale" },
        { role: "assistant", content: "hi" },
      ]),
    );

    expect(repaired.some((message) => message.tool_call_id === "orphan_tc")).toBe(false);
  });

  it("repairs model context without rewriting returned messages", async () => {
    const provider = new CaptureProvider();
    const initialMessages = [
      { role: "system", content: "system" },
      { role: "user", content: "old user" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_missing", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "assistant", content: "old tail" },
      { role: "user", content: "new prompt" },
    ];

    const result = await new AgentRunner(provider).run(runSpec(initialMessages, { maxIterations: 3 }));

    expect(provider.requests[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "call_missing", content: BACKFILL_CONTENT }),
      ]),
    );
    expect(result.messages.map(stripMessage)).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "old user" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_missing", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "assistant", content: "old tail" },
      { role: "user", content: "new prompt" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("repairs model context without shifting the AgentLoop save boundary", async () => {
    const workspace = tmpWorkspace();
    const provider = new CaptureProvider([new LLMResponse({ content: "new answer" })]);
    const loop = new AgentLoop({ provider, workspace, model: "test-model" });
    loop.tools.getDefinitions = () => [];
    (loop.consolidator as any).maybeConsolidateByTokens = async () => false;

    const session = loop.sessions.getOrCreate("cli:test");
    session.messages = [
      { role: "user", content: "old user", timestamp: "2026-01-01T00:00:00" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_missing", type: "function", function: { name: "read_file", arguments: "{}" } }],
        timestamp: "2026-01-01T00:00:01",
      },
      { role: "assistant", content: "old tail", timestamp: "2026-01-01T00:00:02" },
    ];
    loop.sessions.save(session);

    const result = await loop.processMessage(new InboundMessage({ channel: "cli", senderId: "user", chatId: "test", content: "new prompt" }));
    const sessionAfter = loop.sessions.getOrCreate("cli:test");

    expect(result?.content).toBe("new answer");
    expect(provider.requests[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "call_missing", content: BACKFILL_CONTENT }),
      ]),
    );
    expect(sessionAfter.messages.map(stripMessage)).toEqual([
      { role: "user", content: "old user" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_missing", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "assistant", content: "old tail" },
      { role: "user", content: "new prompt" },
      { role: "assistant", content: "new answer" },
    ]);
  });

  it("drops orphan tool results before the model request only", async () => {
    const provider = new CaptureProvider();
    const result = await new AgentRunner(provider).run(
      runSpec([
        { role: "system", content: "system" },
        { role: "user", content: "old user" },
        { role: "tool", tool_call_id: "call_orphan", name: "exec", content: "stale" },
        { role: "assistant", content: "after orphan" },
        { role: "user", content: "new prompt" },
      ]),
    );

    expect(provider.requests[0].messages.some((message: any) => message.tool_call_id === "call_orphan")).toBe(false);
    expect(result.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_orphan" });
    expect(result.finalContent).toBe("done");
  });

  it("microcompacts stale long results from compactable tools", () => {
    const longContent = "x".repeat(600);
    const messages = [...Array(MICROCOMPACT_KEEP_RECENT + 5).keys()].map((idx) => ({
      role: "tool",
      tool_call_id: `c${idx}`,
      name: "exec",
      content: longContent,
    }));

    const result = AgentRunner.microcompact(messages);
    const compacted = result.filter((message) => String(message.content).includes("omitted from context"));
    const preserved = result.filter((message) => message.content === longContent);

    expect(compacted).toHaveLength(5);
    expect(preserved).toHaveLength(MICROCOMPACT_KEEP_RECENT);
  });

  it("does not microcompact short results or non-compactable tools", () => {
    const shortResults = [...Array(MICROCOMPACT_KEEP_RECENT + 5).keys()].map((idx) => ({
      role: "tool",
      tool_call_id: `short${idx}`,
      name: "exec",
      content: "short",
    }));
    const messageResults = [...Array(MICROCOMPACT_KEEP_RECENT + 5).keys()].map((idx) => ({
      role: "tool",
      tool_call_id: `message${idx}`,
      name: "message",
      content: "y".repeat(1000),
    }));

    expect(AgentRunner.microcompact(shortResults)).toBe(shortResults);
    expect(AgentRunner.microcompact(messageResults)).toBe(messageResults);
  });

  it("recovers the nearest user message when snipping would start at assistant or tool history", () => {
    const provider = new CaptureProvider();
    provider.estimate = 500;
    const runner = new AgentRunner(provider);
    const messages = [
      { role: "system", content: "system" },
      { role: "assistant", content: "previous reply" },
      { role: "user", content: ".memmy-agent sibling directory" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "exec", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc_1", content: "tool output 1".repeat(80) },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_2", type: "function", function: { name: "exec", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc_2", content: "tool output 2".repeat(80) },
    ];

    const trimmed = runner.snipHistory(
      runSpec(messages, { contextWindowTokens: 2000, contextBlockLimit: 128 }),
      messages,
    );
    const nonSystem = trimmed.filter((message) => message.role !== "system");

    expect(nonSystem[0].role).toBe("user");
  });

  it("returns a valid list when snipping history with no user message", () => {
    const provider = new CaptureProvider();
    provider.estimate = 500;
    const runner = new AgentRunner(provider);
    const messages = [
      { role: "system", content: "system" },
      { role: "assistant", content: "reply" },
      { role: "tool", tool_call_id: "tc_1", content: "result" },
      { role: "assistant", content: "reply 2" },
      { role: "tool", tool_call_id: "tc_2", content: "result 2" },
    ];

    const trimmed = runner.snipHistory(
      runSpec(messages, { contextWindowTokens: 2000, contextBlockLimit: 128 }),
      messages,
    );
    const fixed = LLMProvider.enforceRoleAlternation(trimmed);
    const nonSystem = fixed.filter((message) => message.role !== "system");

    expect(Array.isArray(trimmed)).toBe(true);
    expect(trimmed.some((message) => message.role === "system")).toBe(true);
    if (nonSystem.length) expect(["user", "tool"]).toContain(nonSystem[0].role);
  });
});
