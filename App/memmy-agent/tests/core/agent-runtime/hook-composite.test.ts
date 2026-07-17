import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext, CompositeHook, SystemPromptBuildContext, type AgentToolRegistrationContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

const roots: string[] = [];

const ctx = () => new AgentHookContext({ iteration: 0, messages: [] });

function tmpWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-hook-"));
  roots.push(root);
  return root;
}

function makeLoop(hooks: AgentHook[] = [], provider: any = null): AgentLoop {
  const defaultProvider = {
    getDefaultModel: () => "test-model",
    generation: { maxTokens: 4096 },
  };
  return new AgentLoop({ provider: provider ?? defaultProvider, workspace: tmpWorkspace(), hooks });
}

class StaticTool extends Tool {
  constructor(private readonly toolName: string, private readonly result: string) {
    super();
  }
  get name(): string {
    return this.toolName;
  }
  get description(): string {
    return this.toolName;
  }
  get parameters(): Record<string, any> {
    return { type: "object", properties: {} };
  }
  async execute(): Promise<string> {
    return this.result;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CompositeHook", () => {
  it("base hook emitReasoning is a no-op", async () => {
    await expect(new AgentHook().emitReasoning("should not raise")).resolves.toBeUndefined();
  });

  it("fans out beforeIteration calls in order", async () => {
    const calls: string[] = [];
    class H extends AgentHook {
      override async beforeIteration(context: AgentHookContext): Promise<void> {
        calls.push(`A:${context.iteration}`);
      }
    }
    class H2 extends AgentHook {
      override async beforeIteration(context: AgentHookContext): Promise<void> {
        calls.push(`B:${context.iteration}`);
      }
    }

    await new CompositeHook([new H(), new H2()]).beforeIteration(ctx());

    expect(calls).toEqual(["A:0", "B:0"]);
  });

  it("fans out all async methods to every hook", async () => {
    const events: string[] = [];
    class RecordingHook extends AgentHook {
      override async beforeIteration(): Promise<void> {
        events.push("beforeIteration");
      }
      override async emitReasoning(reasoningContent: string | null = null): Promise<void> {
        events.push(`emitReasoning:${reasoningContent}`);
      }
      override async onStream(context: AgentHookContext, delta: string): Promise<void> {
        events.push(`onStream:${delta}`);
      }
      override async onStreamEnd(context: AgentHookContext, opts: { resuming?: boolean } = {}): Promise<void> {
        events.push(`onStreamEnd:${Boolean(opts.resuming)}`);
      }
      override async beforeExecuteTools(): Promise<void> {
        events.push("beforeExecuteTools");
      }
      override async afterIteration(): Promise<void> {
        events.push("afterIteration");
      }
      override async sessionStart(): Promise<void> {
        events.push("sessionStart");
      }
      override async sessionEnd(): Promise<void> {
        events.push("sessionEnd");
      }
      override async beforeCompaction(): Promise<void> {
        events.push("beforeCompaction");
      }
      override async afterCompaction(): Promise<void> {
        events.push("afterCompaction");
      }
      override async subagentStart(): Promise<void> {
        events.push("subagentStart");
      }
      override async subagentStop(): Promise<void> {
        events.push("subagentStop");
      }
    }
    const hook = new CompositeHook([new RecordingHook(), new RecordingHook()]);
    const context = ctx();

    await hook.beforeIteration(context);
    await hook.emitReasoning("thinking...");
    await hook.onStream(context, "hi");
    await hook.onStreamEnd(context, { resuming: true });
    await hook.beforeExecuteTools(context);
    await hook.afterIteration(context);
    await hook.sessionStart(context);
    await hook.sessionEnd(context);
    await hook.beforeCompaction(context);
    await hook.afterCompaction(context);
    await hook.subagentStart(context);
    await hook.subagentStop(context);

    expect(events).toEqual([
      "beforeIteration",
      "beforeIteration",
      "emitReasoning:thinking...",
      "emitReasoning:thinking...",
      "onStream:hi",
      "onStream:hi",
      "onStreamEnd:true",
      "onStreamEnd:true",
      "beforeExecuteTools",
      "beforeExecuteTools",
      "afterIteration",
      "afterIteration",
      "sessionStart",
      "sessionStart",
      "sessionEnd",
      "sessionEnd",
      "beforeCompaction",
      "beforeCompaction",
      "afterCompaction",
      "afterCompaction",
      "subagentStart",
      "subagentStart",
      "subagentStop",
      "subagentStop",
    ]);
  });

  it("isolates beforeIteration errors and still calls later hooks", async () => {
    const calls: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    class Bad extends AgentHook {
      override async beforeIteration(): Promise<void> {
        throw new Error("boom");
      }
    }
    class Good extends AgentHook {
      override async beforeIteration(): Promise<void> {
        calls.push("good");
      }
    }

    await new CompositeHook([new Bad(), new Good()]).beforeIteration(ctx());

    expect(calls).toEqual(["good"]);
  });

  it("isolates onStream errors and still calls later hooks", async () => {
    const calls: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    class Bad extends AgentHook {
      override async onStream(): Promise<void> {
        throw new Error("stream-boom");
      }
    }
    class Good extends AgentHook {
      override async onStream(context: AgentHookContext, delta: string): Promise<void> {
        calls.push(delta);
      }
    }

    await new CompositeHook([new Bad(), new Good()]).onStream(ctx(), "delta");

    expect(calls).toEqual(["delta"]);
  });

  it("isolates errors for all remaining async methods", async () => {
    const calls: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    class Bad extends AgentHook {
      override async emitReasoning(): Promise<void> {
        throw new Error("err");
      }
      override async onStreamEnd(): Promise<void> {
        throw new Error("err");
      }
      override async beforeExecuteTools(): Promise<void> {
        throw new Error("err");
      }
      override async afterIteration(): Promise<void> {
        throw new Error("err");
      }
      override async sessionStart(): Promise<void> {
        throw new Error("err");
      }
      override async sessionEnd(): Promise<void> {
        throw new Error("err");
      }
      override async beforeCompaction(): Promise<void> {
        throw new Error("err");
      }
      override async afterCompaction(): Promise<void> {
        throw new Error("err");
      }
      override async subagentStart(): Promise<void> {
        throw new Error("err");
      }
      override async subagentStop(): Promise<void> {
        throw new Error("err");
      }
    }
    class Good extends AgentHook {
      override async emitReasoning(): Promise<void> {
        calls.push("emitReasoning");
      }
      override async onStreamEnd(): Promise<void> {
        calls.push("onStreamEnd");
      }
      override async beforeExecuteTools(): Promise<void> {
        calls.push("beforeExecuteTools");
      }
      override async afterIteration(): Promise<void> {
        calls.push("afterIteration");
      }
      override async sessionStart(): Promise<void> {
        calls.push("sessionStart");
      }
      override async sessionEnd(): Promise<void> {
        calls.push("sessionEnd");
      }
      override async beforeCompaction(): Promise<void> {
        calls.push("beforeCompaction");
      }
      override async afterCompaction(): Promise<void> {
        calls.push("afterCompaction");
      }
      override async subagentStart(): Promise<void> {
        calls.push("subagentStart");
      }
      override async subagentStop(): Promise<void> {
        calls.push("subagentStop");
      }
    }
    const hook = new CompositeHook([new Bad(), new Good()]);
    const context = ctx();

    await hook.emitReasoning("test");
    await hook.onStreamEnd(context, { resuming: false });
    await hook.beforeExecuteTools(context);
    await hook.afterIteration(context);
    await hook.sessionStart(context);
    await hook.sessionEnd(context);
    await hook.beforeCompaction(context);
    await hook.afterCompaction(context);
    await hook.subagentStart(context);
    await hook.subagentStop(context);

    expect(calls).toEqual([
      "emitReasoning",
      "onStreamEnd",
      "beforeExecuteTools",
      "afterIteration",
      "sessionStart",
      "sessionEnd",
      "beforeCompaction",
      "afterCompaction",
      "subagentStart",
      "subagentStop",
    ]);
  });

  it("pipes finalizeContent through every hook", () => {
    class Upper extends AgentHook {
      override finalizeContent(context: AgentHookContext, content: string | null): string | null {
        return content ? content.toUpperCase() : content;
      }
    }
    class Suffix extends AgentHook {
      override finalizeContent(context: AgentHookContext, content: string | null): string | null {
        return content ? `${content}!` : content;
      }
    }

    expect(new CompositeHook([new Upper(), new Suffix()]).finalizeContent(ctx(), "hello")).toBe("HELLO!");
  });

  it("passes null through finalizeContent", () => {
    expect(new CompositeHook([new AgentHook()]).finalizeContent(ctx(), null)).toBeNull();
  });

  it("orders finalizeContent as a pipeline", () => {
    const steps: string[] = [];
    class H1 extends AgentHook {
      override finalizeContent(context: AgentHookContext, content: string | null): string | null {
        steps.push(`H1:${content}`);
        return content?.toUpperCase() ?? null;
      }
    }
    class H2 extends AgentHook {
      override finalizeContent(context: AgentHookContext, content: string | null): string | null {
        steps.push(`H2:${content}`);
        return `${content}!`;
      }
    }

    const result = new CompositeHook([new H1(), new H2()]).finalizeContent(ctx(), "hi");

    expect(result).toBe("HI!");
    expect(steps).toEqual(["H1:hi", "H2:HI"]);
  });

  it("fans out tool registration and system prompt build hooks in order", () => {
    const events: string[] = [];
    const registry = new ToolRegistry();
    class RegisterA extends AgentHook {
      override onRegisterTools(context: AgentToolRegistrationContext): void {
        events.push(`register:${context.metadata.phase}`);
        context.registry.register(new StaticTool("hook_a", "A"));
      }
      override onBuildSystemPrompt(context: SystemPromptBuildContext): void {
        events.push("prompt:a");
        context.upsertSection({ id: "a", content: "A" });
      }
    }
    class RegisterB extends AgentHook {
      override onRegisterTools(context: AgentToolRegistrationContext): void {
        events.push(`register:${context.workspace}`);
        context.registry.register(new StaticTool("hook_b", "B"));
      }
      override onBuildSystemPrompt(context: SystemPromptBuildContext): void {
        events.push("prompt:b");
        context.upsertSection({ id: "b", content: "B" }, { after: "a" });
      }
    }
    const prompt = new SystemPromptBuildContext({
      sections: [{ id: "base", content: "Base" }],
      workspace: "/tmp/work",
    });
    const hook = new CompositeHook([new RegisterA(), new RegisterB()]);

    hook.onRegisterTools({ registry, workspace: "/tmp/work", metadata: { phase: "init" } });
    hook.onBuildSystemPrompt(prompt);

    expect(registry.has("hook_a")).toBe(true);
    expect(registry.has("hook_b")).toBe(true);
    expect(prompt.render()).toBe("Base\n\n---\n\nA\n\n---\n\nB");
    expect(events).toEqual(["register:init", "register:/tmp/work", "prompt:a", "prompt:b"]);
  });

  it("isolates sync extension hook errors and still calls later hooks", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events: string[] = [];
    class Bad extends AgentHook {
      override onRegisterTools(): void {
        throw new Error("register-boom");
      }
      override onBuildSystemPrompt(): void {
        throw new Error("prompt-boom");
      }
    }
    class Good extends AgentHook {
      override onRegisterTools(): void {
        events.push("register");
      }
      override onBuildSystemPrompt(): void {
        events.push("prompt");
      }
    }
    const hook = new CompositeHook([new Bad(), new Good()]);

    hook.onRegisterTools({ registry: new ToolRegistry(), metadata: {} });
    hook.onBuildSystemPrompt(new SystemPromptBuildContext());

    expect(events).toEqual(["register", "prompt"]);
  });

  it("wantsStreaming is true when any hook wants streaming", () => {
    class No extends AgentHook {
      override wantsStreaming(): boolean {
        return false;
      }
    }
    class Yes extends AgentHook {
      override wantsStreaming(): boolean {
        return true;
      }
    }

    expect(new CompositeHook([new No(), new Yes(), new No()]).wantsStreaming()).toBe(true);
  });

  it("wantsStreaming is false when every hook returns false", () => {
    expect(new CompositeHook([new AgentHook(), new AgentHook()]).wantsStreaming()).toBe(false);
  });

  it("wantsStreaming is false for an empty composite", () => {
    expect(new CompositeHook([]).wantsStreaming()).toBe(false);
  });

  it("empty hook lists behave like no-op hooks", async () => {
    const hook = new CompositeHook([]);
    const context = ctx();

    await hook.beforeIteration(context);
    await hook.onStream(context, "delta");
    await hook.onStreamEnd(context, { resuming: false });
    await hook.beforeExecuteTools(context);
    await hook.afterIteration(context);
    await hook.sessionStart(context);
    await hook.sessionEnd(context);
    await hook.beforeCompaction(context);
    await hook.afterCompaction(context);
    await hook.subagentStart(context);
    await hook.subagentStop(context);

    expect(hook.finalizeContent(context, "test")).toBe("test");
  });

  it("supports hook-like objects without reraise state", async () => {
    const calls: string[] = [];
    const legacyHook = {
      beforeIteration: async () => {
        calls.push("legacy");
      },
    } as unknown as AgentHook;

    await new CompositeHook([legacyHook]).beforeIteration(ctx());

    expect(calls).toEqual(["legacy"]);
  });

  it("can wrap another composite", async () => {
    const calls: string[] = [];
    class Inner extends AgentHook {
      override async beforeIteration(): Promise<void> {
        calls.push("inner");
      }
    }

    await new CompositeHook([new CompositeHook([new Inner()])]).beforeIteration(ctx());

    expect(calls).toEqual(["inner"]);
  });

  it("agent loop lets extra hooks register tools during init and refresh", () => {
    const phases: string[] = [];
    class RegisterHook extends AgentHook {
      override onRegisterTools(context: AgentToolRegistrationContext): void {
        phases.push(String(context.metadata.phase));
        context.registry.register(new StaticTool("hook_tool", "ok"));
      }
    }

    const loop = makeLoop([new RegisterHook()]);

    expect(loop.tools.get("hook_tool")).toBeDefined();
    loop.registerDefaultTools();
    expect(loop.tools.get("hook_tool")).toBeDefined();
    expect(phases).toEqual(["init", "refresh"]);
  });

  it("agent loop extra hooks receive calls", async () => {
    const events: string[] = [];
    class TrackingHook extends AgentHook {
      override async beforeIteration(context: AgentHookContext): Promise<void> {
        events.push(`beforeIteration:${context.iteration}`);
      }
      override async afterIteration(context: AgentHookContext): Promise<void> {
        events.push(`afterIteration:${context.iteration}`);
      }
    }
    const loop = makeLoop([new TrackingHook()]);
    (loop.runner as any).run = vi.fn(async (spec: any) => {
      const context = new AgentHookContext({ iteration: 0, messages: spec.messages });
      await spec.hook?.beforeIteration(context);
      await spec.hook?.afterIteration(context);
      return { finalContent: "done", toolCalls: [], messages: spec.messages, stopReason: "", usage: {} };
    });

    const [content] = await loop.runAgentLoop([{ role: "user", content: "hi" }]);

    expect(content).toBe("done");
    expect(events).toContain("beforeIteration:0");
    expect(events).toContain("afterIteration:0");
  });

  it("agent loop isolates errors from extra hooks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    class BadHook extends AgentHook {
      override async beforeIteration(): Promise<void> {
        throw new Error("I am broken");
      }
    }
    const loop = makeLoop([new BadHook()]);
    (loop.runner as any).run = vi.fn(async (spec: any) => {
      await spec.hook?.beforeIteration(new AgentHookContext({ iteration: 0, messages: spec.messages }));
      return { finalContent: "still works", toolCalls: [], messages: spec.messages, stopReason: "", usage: {} };
    });

    const [content] = await loop.runAgentLoop([{ role: "user", content: "hi" }]);

    expect(content).toBe("still works");
  });

  it("agent loop extra hooks do not swallow progress errors", async () => {
    const provider = {
      generation: { maxTokens: 4096 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(
        async () =>
          new LLMResponse({
            content: "working",
            toolCalls: [new ToolCallRequest({ id: "c1", name: "list_dir", arguments: { path: "." } })],
          }),
      ),
    };
    const loop = makeLoop([new AgentHook()], provider);
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.tools.execute = vi.fn(async () => "ok");

    await expect(
      loop.runAgentLoop([], {
        onProgress: async () => {
          throw new Error("progress failed");
        },
      }),
    ).rejects.toThrow("progress failed");
  });

  it("agent loop without hooks keeps backward-compatible max-iteration behavior", async () => {
    const provider = {
      generation: { maxTokens: 4096 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(
        async () =>
          new LLMResponse({
            content: "working",
            toolCalls: [new ToolCallRequest({ id: "c1", name: "list_dir", arguments: { path: "." } })],
          }),
      ),
    };
    const loop = makeLoop([], provider);
    const registry = new ToolRegistry();
    registry.register(new StaticTool("list_dir", "ok"));
    loop.tools = registry as any;
    loop.maxIterations = 2;

    const [content, toolsUsed] = await loop.runAgentLoop([]);

    expect(content).toBe(
      "I reached the tool-call iteration limit (2), but have not completed the task yet. You can try splitting the task into smaller steps.",
    );
    expect(toolsUsed).toEqual(["list_dir", "list_dir"]);
  });
});
