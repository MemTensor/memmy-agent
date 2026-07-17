import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME } from "../../../src/core/agent-runtime/tool-result-budget.js";
import { truncateOutput } from "../../../src/core/agent-runtime/tools/exec-session.js";
import { maybePersistToolResult } from "../../../src/utils/helpers.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-runner-persist-"));
  roots.push(root);
  return root;
}

async function runSingleToolResult({
  name,
  content,
  toolResultMaxCharsByName = SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME,
}: {
  name: string;
  content: string;
  toolResultMaxCharsByName?: Readonly<Record<string, number>>;
}): Promise<{ workspace: string; toolMessage: Record<string, any> }> {
  const workspace = tempRoot();
  let calls = 0;
  let capturedMessages: Record<string, any>[] = [];
  const provider = {
    async chatWithRetry({ messages }: { messages: Record<string, any>[] }) {
      calls += 1;
      if (calls === 1) {
        return new LLMResponse({
          content: "working",
          toolCalls: [new ToolCallRequest({ id: "call_result", name, arguments: {} })],
        });
      }
      capturedMessages = messages;
      return new LLMResponse({ content: "done" });
    },
  };
  const tools = {
    getDefinitions: () => [],
    execute: async () => content,
  };

  await new AgentRunner(provider as any).run(new AgentRunSpec({
    messages: [{ role: "user", content: "run tool" }],
    tools,
    model: "test-model",
    maxIterations: 2,
    workspace,
    sessionKey: "test:runner",
    maxToolResultChars: 16_000,
    toolResultMaxCharsByName,
  }));

  const toolMessage = capturedMessages.find((message) => message.role === "tool");
  if (!toolMessage) throw new Error("expected tool message in second model call");
  return { workspace, toolMessage };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentRunner tool result persistence", () => {
  it.each([
    ["exec", 50_000, false],
    ["exec", 50_001, true],
    ["read_file", 128_000, false],
    ["read_file", 128_001, true],
    ["list_dir", 16_001, true],
  ])("applies the %s boundary at %i chars", async (name, size, shouldPersist) => {
    const content = "x".repeat(size);
    const { workspace, toolMessage } = await runSingleToolResult({ name, content });
    const resultFile = path.join(workspace, ".memmy", "tool-results", "test_runner", "call_result.txt");

    if (shouldPersist) {
      expect(toolMessage.content).toContain("[tool output persisted]");
      expect(toolMessage.content).toContain(`Original size: ${size} chars`);
      expect(fs.readFileSync(resultFile, "utf8")).toBe(content);
    } else {
      expect(toolMessage.content).toBe(content);
      expect(fs.existsSync(resultFile)).toBe(false);
    }
  });

  it("keeps the global fallback for direct runners without per-tool overrides", async () => {
    const { workspace, toolMessage } = await runSingleToolResult({
      name: "exec",
      content: "x".repeat(16_001),
      toolResultMaxCharsByName: {},
    });

    expect(toolMessage.content).toContain("[tool output persisted]");
    expect(fs.existsSync(path.join(workspace, ".memmy", "tool-results", "test_runner", "call_result.txt"))).toBe(true);
  });

  it("persists exec output when the tool truncation marker pushes it over 50,000 chars", async () => {
    const [content] = truncateOutput("x".repeat(50_001), 50_000);
    expect(content.length).toBeGreaterThan(50_000);

    const { workspace, toolMessage } = await runSingleToolResult({ name: "exec", content });

    expect(toolMessage.content).toContain("[tool output persisted]");
    expect(fs.readFileSync(path.join(workspace, ".memmy", "tool-results", "test_runner", "call_result.txt"), "utf8")).toBe(content);
  });

  it("uses per-tool budgets for historical request snapshots without rewriting source messages", async () => {
    const workspace = tempRoot();
    const execContent = "e".repeat(50_000);
    const readContent = "r".repeat(128_001);
    const messages = [
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "exec_history", type: "function", function: { name: "exec", arguments: "{}" } },
          { id: "read_history", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "exec_history", name: "exec", content: execContent },
      { role: "tool", tool_call_id: "read_history", name: "read_file", content: readContent },
    ];
    let capturedMessages: Record<string, any>[] = [];
    const provider = {
      async chatWithRetry({ messages: modelMessages }: { messages: Record<string, any>[] }) {
        capturedMessages = modelMessages;
        return new LLMResponse({ content: "done" });
      },
    };

    await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages,
      model: "test-model",
      maxIterations: 1,
      workspace,
      sessionKey: "history:runner",
      maxToolResultChars: 16_000,
      toolResultMaxCharsByName: SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME,
    }));

    const execMessage = capturedMessages.find((message) => message.tool_call_id === "exec_history");
    const readMessage = capturedMessages.find((message) => message.tool_call_id === "read_history");
    expect(execMessage?.content).toBe(execContent);
    expect(readMessage?.content).toContain("[tool output persisted]");
    expect(messages[2].content).toBe(execContent);
    expect(messages[3].content).toBe(readContent);
    expect(fs.readFileSync(path.join(workspace, ".memmy", "tool-results", "history_runner", "read_history.txt"), "utf8")).toBe(readContent);
  });

  it("persists large tool results for follow-up model calls", async () => {
    const workspace = tempRoot();
    const capturedSecondCall: Record<string, any>[][] = [];
    let calls = 0;
    const provider = {
      async chatWithRetry({ messages }: { messages: Record<string, any>[] }) {
        calls += 1;
        if (calls === 1) {
          return new LLMResponse({
            content: "working",
            toolCalls: [new ToolCallRequest({ id: "call_big", name: "list_dir", arguments: { path: "." } })],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          });
        }
        capturedSecondCall.push(messages);
        return new LLMResponse({ content: "done", usage: {} });
      },
    };
    const tools = {
      getDefinitions: () => [],
      execute: async () => "x".repeat(20_000),
    };

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "do task" }],
        tools,
        model: "test-model",
        maxIterations: 2,
        workspace,
        sessionKey: "test:runner",
        maxToolResultChars: 2048,
      }),
    );

    expect(result.finalContent).toBe("done");
    const toolMessage = capturedSecondCall[0].find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[tool output persisted]");
    expect(toolMessage?.content).toContain("tool-results");
    expect(fs.existsSync(path.join(workspace, ".memmy", "tool-results", "test_runner", "call_big.txt"))).toBe(true);
  });

  it("prunes stale tool result buckets when persisting a new result", () => {
    const workspace = tempRoot();
    const root = path.join(workspace, ".memmy", "tool-results");
    const oldBucket = path.join(root, "old_session");
    const recentBucket = path.join(root, "recent_session");
    fs.mkdirSync(oldBucket, { recursive: true });
    fs.mkdirSync(recentBucket, { recursive: true });
    fs.writeFileSync(path.join(oldBucket, "old.txt"), "old", "utf8");
    fs.writeFileSync(path.join(recentBucket, "recent.txt"), "recent", "utf8");
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldBucket, stale, stale);
    fs.utimesSync(path.join(oldBucket, "old.txt"), stale, stale);

    const persisted = maybePersistToolResult(workspace, "current:session", "call_big", "x".repeat(5000), { maxChars: 64 });

    expect(persisted).toContain("[tool output persisted]");
    expect(fs.existsSync(oldBucket)).toBe(false);
    expect(fs.existsSync(recentBucket)).toBe(true);
    expect(fs.existsSync(path.join(root, "current_session", "call_big.txt"))).toBe(true);
  });

  it("leaves no temp files after persisting tool results", () => {
    const workspace = tempRoot();
    const root = path.join(workspace, ".memmy", "tool-results");

    maybePersistToolResult(workspace, "current:session", "call_big", "x".repeat(5000), { maxChars: 64 });

    const bucket = path.join(root, "current_session");
    expect(fs.existsSync(path.join(bucket, "call_big.txt"))).toBe(true);
    expect(fs.readdirSync(bucket).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("uses the per-tool fallback when tool result persistence fails", async () => {
    const workspaceFile = path.join(tempRoot(), "workspace-file");
    fs.writeFileSync(workspaceFile, "not a directory", "utf8");
    const content = "x".repeat(128_001);
    const capturedSecondCall: Record<string, any>[][] = [];
    let calls = 0;
    const provider = {
      async chatWithRetry({ messages }: { messages: Record<string, any>[] }) {
        calls += 1;
        if (calls === 1) {
          return new LLMResponse({
            content: "working",
            toolCalls: [new ToolCallRequest({ id: "call_1", name: "read_file", arguments: { path: "large.txt" } })],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          });
        }
        capturedSecondCall.push(messages);
        return new LLMResponse({ content: "done", usage: {} });
      },
    };
    const tools = {
      getDefinitions: () => [],
      execute: async () => content,
    };

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "do task" }],
        tools,
        model: "test-model",
        maxIterations: 2,
        maxToolResultChars: 16_000,
        toolResultMaxCharsByName: SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME,
        workspace: workspaceFile,
      }),
    );

    expect(result.finalContent).toBe("done");
    const toolMessage = capturedSecondCall[0].find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe(`${content.slice(0, 128_000)}\n... (truncated)`);
  });

  it("returns the final assistant message in persisted messages", async () => {
    const provider = { chatWithRetry: async () => new LLMResponse({ content: "persist me" }) };
    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({ messages: [{ role: "user", content: "hi" }] }));

    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "persist me" });
  });
});
