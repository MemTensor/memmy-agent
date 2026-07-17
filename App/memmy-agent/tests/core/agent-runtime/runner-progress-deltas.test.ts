import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProgressHook } from "../../../src/core/agent-runtime/progress-hook.js";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { createTurnCancellationBoundary } from "../../../src/core/agent-runtime/turn-cancellation-boundary.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { withProgressCapabilities } from "../../../src/utils/progress-events.js";

const MAX_TOOL_RESULT_CHARS = 100_000;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-runner-progress-"));
  roots.push(root);
  return root;
}

function toolRegistry(definitions: any[], execute: (name: string, params: any) => Promise<string> | string): any {
  return {
    getDefinitions: vi.fn(() => definitions),
    get: vi.fn(() => null),
    execute: vi.fn(execute),
  };
}

function fileEditProgress(events: any[]): any {
  return withProgressCapabilities(
    async (content: string, opts: any = {}) => {
      const fileEvents = opts.fileEditEvents;
      if (fileEvents) events.push(...fileEvents);
    },
    { fileEditEvents: true },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentRunner progress deltas", () => {
  it("streams only visible incremental content after stripping thinking blocks", async () => {
    const deltas: string[] = [];
    const hook = new AgentProgressHook(null, (delta) => {
      deltas.push(delta);
    });
    const ctx = new AgentHookContext();

    await hook.onStream(ctx, "<think>hidden</think>hel");
    await hook.onStream(ctx, "lo");

    expect(deltas.join("")).toBe("hello");
  });

  it("emits inline thinking from stream chunks as reasoning", async () => {
    const deltas: string[] = [];
    const progress = withProgressCapabilities(vi.fn(), { reasoning: true });
    const hook = new AgentProgressHook(progress, (delta) => {
      deltas.push(delta);
    });
    const ctx = new AgentHookContext();

    await hook.onStream(ctx, "<think>thinking</think>he");
    await hook.onStream(ctx, "llo");
    await hook.onStreamEnd(ctx, { resuming: false });

    expect(deltas.join("")).toBe("hello");
    expect(ctx.streamedReasoning).toBe(true);
    expect(progress.mock.calls).toEqual([
      ["thinking", { reasoning: true }],
      ["", { reasoningEnd: true }],
    ]);
  });

  it("can disable provider progress delta streaming", async () => {
    const provider = {
      supportsProgressDeltas: true,
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "done", toolCalls: [], usage: {} })),
      chatStreamWithRetry: vi.fn(),
    };
    const progress = withProgressCapabilities(vi.fn(), { reasoning: true });

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hi" },
        ],
        provider: provider as any,
        tools: toolRegistry([], async () => "ok"),
        model: "test-model",
        maxIterations: 1,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        progressCallback: progress,
        streamProgressDeltas: false,
      }),
    );

    expect(result.finalContent).toBe("done");
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(provider.chatStreamWithRetry).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it("streams provider progress deltas by default", async () => {
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onContentDelta }: any) => {
        await onContentDelta("he");
        await onContentDelta("llo");
        return new LLMResponse({ content: "hello", toolCalls: [], usage: {} });
      }),
      chatWithRetry: vi.fn(),
    };
    const progress = withProgressCapabilities(vi.fn(), { reasoning: true });

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hi" },
        ],
        provider: provider as any,
        tools: toolRegistry([], async () => "ok"),
        model: "test-model",
        maxIterations: 1,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        progressCallback: progress,
      }),
    );

    expect(result.finalContent).toBe("hello");
    expect(progress.mock.calls.map((call) => call[0])).toEqual(["he", "llo"]);
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("filters inline thinking in progress-only streaming and emits reasoning once", async () => {
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onContentDelta }: any) => {
        await onContentDelta("<think>thinking</think>");
        await onContentDelta("The answer.");
        return new LLMResponse({
          content: "<think>thinking</think>The answer.",
          toolCalls: [],
          usage: {},
        });
      }),
      chatWithRetry: vi.fn(),
    };
    const progress = withProgressCapabilities(vi.fn(), { reasoning: true });
    const hook = new AgentProgressHook(progress);

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "question" }],
        provider: provider as any,
        tools: toolRegistry([], async () => "ok"),
        model: "test-model",
        maxIterations: 1,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        progressCallback: progress,
        hook,
      }),
    );

    expect(result.finalContent).toBe("The answer.");
    expect(progress.mock.calls).toEqual([["thinking", { reasoning: true }], ["", { reasoningEnd: true }], ["The answer."]]);
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("streams live write_file activity from tool argument deltas", async () => {
    const workspace = tmpRoot();
    const progressEvents: any[] = [];
    let calls = 0;
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onToolCallDelta }: any) => {
        calls += 1;
        if (calls === 1) {
          expect(onToolCallDelta).toBeTruthy();
          await onToolCallDelta({
            index: 0,
            call_id: "call-write",
            name: "write_file",
            arguments_delta: '{"path":"big.txt","content":"',
          });
          await onToolCallDelta({ index: 0, arguments_delta: "line\\n".repeat(24) });
          return new LLMResponse({
            content: null,
            toolCalls: [
              new ToolCallRequest({
                id: "call-write",
                name: "write_file",
                arguments: { path: "big.txt", content: "line\n".repeat(24) },
              }),
            ],
            usage: {},
          });
        }
        return new LLMResponse({ content: "done", toolCalls: [], usage: {} });
      }),
      chatWithRetry: vi.fn(),
    };
    const tools = toolRegistry([{ type: "function", function: { name: "write_file" } }], async (name, params) => {
      expect(name).toBe("write_file");
      expect(progressEvents.some((event) => event.approximate && event.added === 24)).toBe(true);
      fs.writeFileSync(path.join(workspace, params.path), params.content, "utf8");
      return "ok";
    });

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "write a large file" }],
        provider: provider as any,
        tools,
        model: "test-model",
        maxIterations: 2,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        progressCallback: fileEditProgress(progressEvents),
        workspace,
      }),
    );

    expect(result.finalContent).toBe("done");
    expect(progressEvents.some((event) => event.approximate && event.added === 24)).toBe(true);
    expect(progressEvents.some((event) => !event.approximate && event.phase === "end" && event.added === 24)).toBe(true);
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("streams live edit_file activity from tool argument deltas", async () => {
    const workspace = tmpRoot();
    const target = path.join(workspace, "notes.txt");
    fs.writeFileSync(target, "old\nkeep\n", "utf8");
    const progressEvents: any[] = [];
    let calls = 0;
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onToolCallDelta }: any) => {
        calls += 1;
        if (calls === 1) {
          expect(onToolCallDelta).toBeTruthy();
          await onToolCallDelta({
            index: 0,
            call_id: "call-edit",
            name: "edit_file",
            arguments_delta: '{"path":"notes.txt","old_text":"old\\nkeep\\n","new_text":"',
          });
          await onToolCallDelta({ index: 0, arguments_delta: "new\\nkeep\\nextra\\n" });
          await onToolCallDelta({ index: 0, arguments_delta: '"}' });
          return new LLMResponse({
            content: null,
            toolCalls: [
              new ToolCallRequest({
                id: "call-edit",
                name: "edit_file",
                arguments: {
                  path: "notes.txt",
                  old_text: "old\nkeep\n",
                  new_text: "new\nkeep\nextra\n",
                },
              }),
            ],
            usage: {},
          });
        }
        return new LLMResponse({ content: "done", toolCalls: [], usage: {} });
      }),
      chatWithRetry: vi.fn(),
    };
    const tools = toolRegistry([{ type: "function", function: { name: "edit_file" } }], async (name, params) => {
      expect(name).toBe("edit_file");
      expect(progressEvents.some((event) => event.tool === "edit_file" && event.approximate && event.added === 3 && event.deleted === 2)).toBe(true);
      fs.writeFileSync(target, params.new_text, "utf8");
      return "ok";
    });

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "edit a file" }],
        provider: provider as any,
        tools,
        model: "test-model",
        maxIterations: 2,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        progressCallback: fileEditProgress(progressEvents),
        workspace,
      }),
    );

    expect(result.finalContent).toBe("done");
    expect(progressEvents.some((event) => event.tool === "edit_file" && event.approximate && event.added === 3 && event.deleted === 2)).toBe(true);
    expect(progressEvents.some((event) => event.tool === "edit_file" && !event.approximate && event.phase === "end" && event.added === 2 && event.deleted === 1)).toBe(true);
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("marks unfinished live write_file activity as failed", async () => {
    const workspace = tmpRoot();
    const progressEvents: any[] = [];
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onToolCallDelta }: any) => {
        expect(onToolCallDelta).toBeTruthy();
        await onToolCallDelta({
          index: 0,
          call_id: "call-write",
          name: "write_file",
          arguments_delta: '{"path":"aborted.txt","content":"partial\\n',
        });
        return new LLMResponse({
          content: "stopped",
          toolCalls: [],
          finishReason: "stop",
          usage: {},
        });
      }),
      chatWithRetry: vi.fn(),
    };

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "write a large file" }],
        provider: provider as any,
        tools: toolRegistry([{ type: "function", function: { name: "write_file" } }], async () => "ok"),
        model: "test-model",
        maxIterations: 1,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        progressCallback: fileEditProgress(progressEvents),
        workspace,
      }),
    );

    expect(result.finalContent).toBe("stopped");
    expect(progressEvents.at(-1)).toMatchObject({
      path: "aborted.txt",
      phase: "error",
      status: "error",
    });
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });

  it("stops accepting late live file edit deltas after the turn aborts", async () => {
    const workspace = tmpRoot();
    const controller = new AbortController();
    const boundary = createTurnCancellationBoundary({ turnId: "turn-abort", signal: controller.signal });
    const progressEvents: any[] = [];
    const provider = {
      supportsProgressDeltas: true,
      chatStreamWithRetry: vi.fn(async ({ onToolCallDelta }: any) => {
        expect(onToolCallDelta).toBeTruthy();
        await onToolCallDelta({
          index: 0,
          call_id: "call-write",
          name: "write_file",
          arguments_delta: '{"path":"cancelled.txt","content":"',
        });
        await onToolCallDelta({ index: 0, arguments_delta: "line\\n".repeat(24) });
        controller.abort();
        await onToolCallDelta({ index: 0, arguments_delta: "late\\n".repeat(24) });
        return new Promise<LLMResponse>(() => undefined);
      }),
      chatWithRetry: vi.fn(),
    };

    const result = await new AgentRunner(provider as any).run(
      new AgentRunSpec({
        messages: [{ role: "user", content: "write a large file" }],
        provider: provider as any,
        tools: toolRegistry([{ type: "function", function: { name: "write_file" } }], async () => "ok"),
        model: "test-model",
        maxIterations: 1,
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        progressCallback: fileEditProgress(progressEvents),
        workspace,
        abortSignal: controller.signal,
        boundary,
        turnId: "turn-abort",
      }),
    );

    expect(result.stopReason).toBe("cancelled");
    expect(progressEvents.some((event) => event.path === "cancelled.txt" && event.added === 24 && event.status === "editing")).toBe(true);
    expect(progressEvents.some((event) => event.path === "cancelled.txt" && event.added === 48)).toBe(false);
    expect(progressEvents.at(-1)).toMatchObject({
      call_id: "call-write",
      path: "cancelled.txt",
      phase: "error",
      status: "error",
      cancellation_terminal: true,
    });
    expect(boundary.isAborted()).toBe(true);
    expect(provider.chatWithRetry).not.toHaveBeenCalled();
  });
});
