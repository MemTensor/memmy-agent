import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentLoop, UNIFIED_SESSION_KEY } from "../../../src/core/agent-runtime/loop.js";
import {
  AgentRunner,
  AgentRunSpec,
  MAX_EMPTY_RETRIES,
  MAX_INJECTION_CYCLES,
  MAX_INJECTIONS_PER_TURN,
  MICROCOMPACT_KEEP_RECENT,
} from "../../../src/core/agent-runtime/runner.js";
import { AsyncQueue, MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-runner-inject-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function inbound(content: string, extra: Partial<ConstructorParameters<typeof InboundMessage>[0]> = {}): InboundMessage {
  return new InboundMessage({ channel: "cli", senderId: "u", chatId: "c", content, ...extra });
}

function makeTools(execute: (name: string, args: any) => Promise<any> | any = async () => "file content"): any {
  const getDefinitions = vi.fn(() => []);
  return { getDefinitions, execute: vi.fn(execute) };
}

function makeProvider(handler: (args: any) => Promise<LLMResponse> | LLMResponse): any {
  return {
    getDefaultModel: () => "test-model",
    chatWithRetry: vi.fn(handler),
  };
}

function drainArray(items: any[]): ({ limit }?: { limit?: number }) => any[] {
  return ({ limit = MAX_INJECTIONS_PER_TURN } = {}) => items.splice(0, limit);
}

async function waitUntil(predicate: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

describe("AgentRunner injection drain", () => {
  it("keeps injection and microcompact guard constants bounded", () => {
    expect(MAX_INJECTION_CYCLES).toBeGreaterThan(0);
    expect(MAX_INJECTIONS_PER_TURN).toBeGreaterThan(0);
    expect(MAX_EMPTY_RETRIES).toBeGreaterThan(0);
    expect(MICROCOMPACT_KEEP_RECENT).toBeGreaterThan(0);
  });

  it("returns empty injections when no callback is configured", async () => {
    const result = await new AgentRunner(makeProvider(() => new LLMResponse({ content: "done" }))).drainInjections(new AgentRunSpec({ injectionCallback: null }));
    expect(result).toEqual([]);
  });

  it("extracts content from inbound messages", async () => {
    const spec = new AgentRunSpec({ injectionCallback: async () => [inbound("hello"), inbound("world")] });
    await expect(new AgentRunner().drainInjections(spec)).resolves.toEqual([{ role: "user", content: "hello" }, { role: "user", content: "world" }]);
  });

  it("passes the injection limit to limit-aware callbacks", async () => {
    const seen: number[] = [];
    const spec = new AgentRunSpec({
      injectionCallback: async ({ limit = 0 } = {}) => {
        seen.push(limit);
        return [...Array(limit + 3).keys()].map((index) => inbound(`msg${index}`)).slice(0, limit);
      },
    });

    const result = await new AgentRunner().drainInjections(spec);

    expect(seen).toEqual([MAX_INJECTIONS_PER_TURN]);
    expect(result.map((msg) => msg.content)).toEqual(["msg0", "msg1", "msg2"]);
  });

  it("skips empty injected content", async () => {
    const spec = new AgentRunSpec({ injectionCallback: async () => [inbound(""), inbound("   "), inbound("valid")] });
    await expect(new AgentRunner().drainInjections(spec)).resolves.toEqual([{ role: "user", content: "valid" }]);
  });

  it("handles injection callback exceptions", async () => {
    const spec = new AgentRunSpec({ injectionCallback: async () => { throw new Error("boom"); } });
    await expect(new AgentRunner().drainInjections(spec)).resolves.toEqual([]);
  });
});

describe("AgentRunner injection checkpoints", () => {
  it("injects follow-up messages after tool execution", async () => {
    let calls = 0;
    const captured: any[][] = [];
    const provider = makeProvider(async ({ messages }) => {
      calls += 1;
      captured.push(messages.map((msg: any) => ({ ...msg })));
      if (calls === 1) return new LLMResponse({ content: "using tool", toolCalls: [new ToolCallRequest({ id: "c1", name: "read_file", arguments: { path: "x" } })] });
      return new LLMResponse({ content: "final answer" });
    });
    const pending = [inbound("follow-up question")];

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }],
      provider,
      tools: makeTools(),
      model: "test-model",
      maxIterations: 5,
      injectionCallback: drainArray(pending),
    }));

    expect(result.hadInjections).toBe(true);
    expect(result.finalContent).toBe("final answer");
    expect(captured.at(-1)?.some((msg) => msg.role === "user" && msg.content === "follow-up question")).toBe(true);
  });

  it("marks stream_end as resuming when final-response injections continue the turn", async () => {
    let calls = 0;
    const streamEnds: boolean[] = [];
    const provider = {
      getDefaultModel: () => "test-model",
      chatStreamWithRetry: vi.fn(async () => new LLMResponse({ content: ++calls === 1 ? "first answer" : "second answer" })),
    };
    class TrackingHook extends AgentHook {
      override wantsStreaming(): boolean {
        return true;
      }
      override async onStreamEnd(context: AgentHookContext, opts: { resuming?: boolean } = {}): Promise<void> {
        streamEnds.push(Boolean(opts.resuming));
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }],
      provider: provider as any,
      tools: makeTools(),
      model: "test-model",
      maxIterations: 5,
      hook: new TrackingHook(),
      injectionCallback: drainArray([inbound("quick follow-up")]),
    }));

    expect(result.hadInjections).toBe(true);
    expect(result.finalContent).toBe("second answer");
    expect(streamEnds[0]).toBe(true);
    expect(streamEnds.at(-1)).toBe(false);
  });

  it("preserves the first final response in history before a follow-up", async () => {
    let calls = 0;
    const captured: any[][] = [];
    const provider = makeProvider(async ({ messages }) => {
      calls += 1;
      captured.push(messages.map((msg: any) => ({ ...msg })));
      return new LLMResponse({ content: calls === 1 ? "first answer" : "second answer" });
    });

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }],
      provider,
      tools: makeTools(),
      maxIterations: 5,
      injectionCallback: drainArray([inbound("follow-up question")]),
    }));

    expect(result.finalContent).toBe("second answer");
    expect(captured.at(-1)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up question" },
    ]);
    expect(result.messages.filter((msg) => msg.role === "assistant").map((msg) => msg.content)).toEqual(["first answer", "second answer"]);
  });

  it("preserves image media on loop-level injected follow-ups", async () => {
    const root = tmpRoot();
    const imagePath = path.join(root, "followup.png");
    fs.writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=", "base64"));
    let calls = 0;
    const captured: any[][] = [];
    const provider = makeProvider(async ({ messages }) => {
      calls += 1;
      captured.push(messages.map((msg: any) => ({ ...msg })));
      return new LLMResponse({ content: calls === 1 ? "first answer" : "second answer" });
    });
    const loop = new AgentLoop({ bus: new MessageBus(), provider, workspace: root, model: "test-model" });
    loop.tools.getDefinitions = vi.fn(() => []);
    const pending = new AsyncQueue<InboundMessage>();
    pending.put(inbound("", { media: [imagePath] }));

    const [finalContent, , , , hadInjections] = await loop.runAgentLoop([{ role: "user", content: "hello" }], { channel: "cli", chatId: "c", pendingQueue: pending });

    expect(finalContent).toBe("second answer");
    expect(hadInjections).toBe(true);
    const injected = captured.at(-1)?.find((msg) => msg.role === "user" && Array.isArray(msg.content) && msg.content.some((block: any) => block.type === "image_url"));
    expect(injected).toBeTruthy();
  });

  it("merges multiple injected user messages without losing media", async () => {
    let calls = 0;
    const captured: any[][] = [];
    const provider = makeProvider(async ({ messages }) => {
      calls += 1;
      captured.push(messages.map((msg: any) => ({ ...msg })));
      return new LLMResponse({ content: calls === 1 ? "first answer" : "second answer" });
    });

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }],
      provider,
      tools: makeTools(),
      maxIterations: 5,
      injectionCallback: async () => calls === 1
        ? [
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }, { type: "text", text: "look at this" }] },
            { role: "user", content: "and answer briefly" },
          ]
        : [],
    }));

    expect(result.finalContent).toBe("second answer");
    const injected = captured.at(-1)!.filter((msg) => msg.role === "user").at(-1)!;
    expect(injected.content.some((block: any) => block.type === "image_url")).toBe(true);
    expect(injected.content.some((block: any) => block.type === "text" && block.text === "and answer briefly")).toBe(true);
  });

  it("caps injection cycles", async () => {
    let calls = 0;
    let drains = 0;
    const provider = makeProvider(async () => new LLMResponse({ content: `answer-${++calls}` }));

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "start" }],
      provider,
      tools: makeTools(),
      maxIterations: 20,
      injectionCallback: async () => ++drains <= MAX_INJECTION_CYCLES ? [inbound(`msg-${drains}`)] : [],
    }));

    expect(result.hadInjections).toBe(true);
    expect(calls).toBe(MAX_INJECTION_CYCLES + 1);
  });

  it("leaves hadInjections false when no follow-ups arrive", async () => {
    const provider = makeProvider(async () => new LLMResponse({ content: "done" }));
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hi" }],
      provider,
      tools: makeTools(),
      maxIterations: 1,
    }));
    expect(result.hadInjections).toBe(false);
  });
});

describe("AgentLoop pending queues", () => {
  it("cleans up pending queues after dispatch", async () => {
    const root = tmpRoot();
    const provider = makeProvider(async () => new LLMResponse({ content: "done" }));
    const loop = new AgentLoop({ bus: new MessageBus(), provider, workspace: root, model: "test-model" });
    loop.tools.getDefinitions = vi.fn(() => []);
    const msg = inbound("hello");

    await loop.dispatchMessage(msg);

    expect(loop.pendingQueues.has(msg.sessionKey)).toBe(false);
  });

  it("routes unified-session follow-ups to an active pending queue", async () => {
    const root = tmpRoot();
    const bus = new MessageBus();
    const loop = new AgentLoop({ bus, provider: makeProvider(async () => new LLMResponse({ content: "done" })), workspace: root, model: "test-model" });
    loop.unifiedSession = true;
    loop.dispatchMessage = vi.fn(async () => undefined) as any;
    const pending = new AsyncQueue<InboundMessage>();
    loop.pendingQueues.set(UNIFIED_SESSION_KEY, pending);

    const runTask = loop.run();
    await bus.publishInbound(new InboundMessage({ channel: "discord", senderId: "u", chatId: "c", content: "follow-up" }));
    await waitUntil(() => pending.size > 0);
    loop.stop();
    await runTask;

    expect(loop.dispatchMessage).not.toHaveBeenCalled();
    const queued = pending.getNowait()!;
    expect(queued.content).toBe("follow-up");
    expect(queued.sessionKey).toBe(UNIFIED_SESSION_KEY);
  });

  it("preserves pending queue overflow for later injection cycles", async () => {
    const root = tmpRoot();
    let calls = 0;
    const captured: any[][] = [];
    const provider = makeProvider(async ({ messages }) => {
      calls += 1;
      captured.push(messages.map((msg: any) => ({ ...msg })));
      return new LLMResponse({ content: `answer-${calls}` });
    });
    const loop = new AgentLoop({ bus: new MessageBus(), provider, workspace: root, model: "test-model" });
    loop.tools.getDefinitions = vi.fn(() => []);
    const pending = new AsyncQueue<InboundMessage>();
    const total = MAX_INJECTIONS_PER_TURN + 2;
    for (let i = 0; i < total; i += 1) pending.put(inbound(`follow-up-${i}`));

    const [finalContent, , , , hadInjections] = await loop.runAgentLoop([{ role: "user", content: "hello" }], { channel: "cli", chatId: "c", pendingQueue: pending });

    expect(finalContent).toBe("answer-3");
    expect(hadInjections).toBe(true);
    expect(calls).toBe(3);
    expect(pending.size).toBe(0);
    const flattened = captured.at(-1)!.filter((msg) => msg.role === "user" && typeof msg.content === "string").map((msg) => msg.content).join("\n");
    for (let i = 0; i < total; i += 1) expect(flattened).toContain(`follow-up-${i}`);
  });

  it("falls back to dispatch when an active pending queue rejects a put", async () => {
    const root = tmpRoot();
    const bus = new MessageBus();
    const loop = new AgentLoop({ bus, provider: makeProvider(async () => new LLMResponse({ content: "done" })), workspace: root, model: "test-model" });
    loop.dispatchMessage = vi.fn(async () => undefined) as any;
    loop.pendingQueues.set("cli:c", { put: () => { throw new Error("full"); } } as any);

    const runTask = loop.run();
    await bus.publishInbound(inbound("follow-up"));
    await waitUntil(() => (loop.dispatchMessage as any).mock.calls.length > 0);
    loop.stop();
    await runTask;

    expect(loop.dispatchMessage).toHaveBeenCalledOnce();
  });

  it("re-publishes leftover pending queue messages after dispatch cleanup", async () => {
    const root = tmpRoot();
    const bus = new MessageBus();
    const loop = new AgentLoop({ bus, provider: makeProvider(async () => new LLMResponse({ content: "done" })), workspace: root, model: "test-model" });
    (loop as any).processMessageInternal = vi.fn(async () => {
      const queue = loop.pendingQueues.get("cli:c")!;
      queue.put(inbound("leftover-1"));
      queue.put(inbound("leftover-2"));
      return null;
    });

    await loop.dispatchMessage(inbound("hello"));

    expect(bus.inbound.size).toBe(2);
    expect((await bus.consumeInbound()).content).toBe("leftover-1");
    expect((await bus.consumeInbound()).content).toBe("leftover-2");
  });
});

describe("AgentRunner injection error paths", () => {
  it("drains injections on fatal tool errors", async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      calls += 1;
      if (calls === 1) return new LLMResponse({ content: "", toolCalls: [new ToolCallRequest({ id: "c1", name: "exec", arguments: { cmd: "bad" } })] });
      return new LLMResponse({ content: "reply to follow-up" });
    });

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }],
      provider,
      tools: makeTools(async () => { throw new Error("tool exploded"); }),
      maxIterations: 5,
      failOnToolError: true,
      injectionCallback: drainArray([inbound("follow-up after error")]),
    }));

    expect(result.hadInjections).toBe(true);
    expect(result.finalContent).toBe("reply to follow-up");
    expect(result.messages.some((msg) => msg.role === "user" && msg.content === "follow-up after error")).toBe(true);
  });

  it("drains injections on LLM error responses", async () => {
    let calls = 0;
    const provider = makeProvider(async () => ++calls === 1
      ? new LLMResponse({ content: null, finishReason: "error" })
      : new LLMResponse({ content: "recovered answer" }));

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "previous response" }, { role: "user", content: "trigger error" }],
      provider,
      tools: makeTools(),
      maxIterations: 5,
      injectionCallback: drainArray([inbound("follow-up after LLM error")]),
    }));

    expect(result.hadInjections).toBe(true);
    expect(result.finalContent).toBe("recovered answer");
    expect(result.messages.some((msg) => msg.role === "user" && String(msg.content).includes("follow-up after LLM error"))).toBe(true);
  });

  it("drains injections on empty final responses", async () => {
    let calls = 0;
    const provider = makeProvider(async () => ++calls <= MAX_EMPTY_RETRIES + 1
      ? new LLMResponse({ content: "" })
      : new LLMResponse({ content: "answer after empty" }));

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "previous response" }, { role: "user", content: "trigger empty" }],
      provider,
      tools: makeTools(),
      maxIterations: 10,
      injectionCallback: drainArray([inbound("follow-up after empty")]),
    }));

    expect(result.hadInjections).toBe(true);
    expect(result.finalContent).toBe("answer after empty");
    expect(result.messages.some((msg) => msg.role === "user" && String(msg.content).includes("follow-up after empty"))).toBe(true);
  });

  it("drains injections when maxIterations is reached", async () => {
    let calls = 0;
    const queue = [inbound("follow-up after max iters")];
    const provider = makeProvider(async () => new LLMResponse({
      content: "",
      toolCalls: [new ToolCallRequest({ id: `c${++calls}`, name: "read_file", arguments: { path: "x" } })],
    }));

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }],
      provider,
      tools: makeTools(),
      maxIterations: 2,
      injectionCallback: drainArray(queue),
    }));

    expect(result.stopReason).toBe("maxIterations");
    expect(result.hadInjections).toBe(true);
    expect(queue).toHaveLength(0);
    expect(result.messages.some((msg) => msg.role === "user" && msg.content === "follow-up after max iters")).toBe(true);
  });

  it("sets hadInjections for late follow-ups drained after the last iteration", async () => {
    let calls = 0;
    const queue: InboundMessage[] = [];
    const provider = makeProvider(async () => new LLMResponse({
      content: "",
      toolCalls: [new ToolCallRequest({ id: `c${++calls}`, name: "read_file", arguments: { path: "x" } })],
    }));
    class InjectOnLastAfterIterationHook extends AgentHook {
      calls = 0;
      override async afterIteration(): Promise<void> {
        this.calls += 1;
        if (this.calls === 2) queue.push(inbound("late follow-up after max iters"));
      }
    }

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }],
      provider,
      tools: makeTools(),
      maxIterations: 2,
      hook: new InjectOnLastAfterIterationHook(),
      injectionCallback: drainArray(queue),
    }));

    expect(result.stopReason).toBe("maxIterations");
    expect(result.hadInjections).toBe(true);
    expect(result.messages.some((msg) => msg.role === "user" && msg.content === "late follow-up after max iters")).toBe(true);
  });

  it("caps injection cycles on the LLM error path", async () => {
    let calls = 0;
    let drains = 0;
    const provider = makeProvider(async () => {
      calls += 1;
      return new LLMResponse({ content: null, finishReason: "error" });
    });

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "previous" }, { role: "user", content: "trigger error" }],
      provider,
      tools: makeTools(),
      maxIterations: 20,
      injectionCallback: async () => ++drains <= MAX_INJECTION_CYCLES ? [inbound(`msg-${drains}`)] : [],
    }));

    expect(result.hadInjections).toBe(true);
    expect(calls).toBe(MAX_INJECTION_CYCLES + 1);
  });
});
