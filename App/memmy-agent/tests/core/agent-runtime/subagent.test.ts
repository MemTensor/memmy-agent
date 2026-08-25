import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { SubagentManager, SubagentStatus, SubagentHook } from "../../../src/core/agent-runtime/subagent.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { DEFAULT_MAX_TOKENS } from "../../../src/token-budget.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-subagent-"));
}

function manager(extra: Record<string, any> = {}): SubagentManager {
  const provider = {
    generation: { maxTokens: DEFAULT_MAX_TOKENS },
    getDefaultModel: () => "test-model",
  };
  return new SubagentManager({
    provider,
    workspace: tmpDir(),
    bus: new MessageBus(),
    model: "test-model",
    maxToolResultChars: 16_000,
    ...extra,
  });
}

describe("SubagentManager", () => {
  it("tracks status defaults and hook iteration updates", async () => {
    const status = new SubagentStatus({ taskId: "t1", label: "label", taskDescription: "do it" });
    expect(status.phase).toBe("initializing");
    expect(status.iteration).toBe(0);
    expect(status.toolEvents).toEqual([]);

    const hook = new SubagentHook("t1", status);
    await hook.afterIteration(new AgentHookContext({
      iteration: 3,
      toolEvents: [{ name: "read_file", status: "ok", detail: "done" }],
      usage: { prompt_tokens: 10 },
    }));
    expect(status.iteration).toBe(3);
    expect(status.toolEvents).toHaveLength(1);
    expect(status.usage.prompt_tokens).toBe(10);
  });

  it("builds subagent-scoped tools through ToolLoader", () => {
    const sm = manager();
    const tools = sm.buildTools();
    expect(tools.has("read_file")).toBe(true);
    expect(tools.has("write_file")).toBe(true);
    expect(tools.has("exec")).toBe(true);
    expect(tools.has("write_stdin")).toBe(true);
    expect(tools.has("message")).toBe(false);
    expect(tools.has("spawn")).toBe(false);
  });

  it("includes available skills in the subagent prompt and honors disabled skills", () => {
    const workspace = tmpDir();
    try {
      const skillsRoot = path.join(workspace, "skills");
      fs.mkdirSync(path.join(skillsRoot, "alpha_skill"), { recursive: true });
      fs.writeFileSync(
        path.join(skillsRoot, "alpha_skill", "SKILL.md"),
        "---\nname: alpha_skill\ndescription: Disabled test skill\n---\n\n# Alpha",
        "utf8",
      );
      fs.mkdirSync(path.join(skillsRoot, "beta_skill"), { recursive: true });
      const betaPath = path.join(skillsRoot, "beta_skill", "SKILL.md");
      fs.writeFileSync(
        betaPath,
        "---\nname: beta_skill\ndescription: Available test skill\n---\n\n# Beta",
        "utf8",
      );
      const memoryPath = path.join(skillsRoot, "memory", "SKILL.md");
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
      fs.writeFileSync(
        memoryPath,
        "---\nname: memory\ndescription: User-created helper\n---\n\n# User Memory Helper",
        "utf8",
      );

      const prompt = manager({ workspace, disabledSkills: ["alpha_skill"] }).buildSubagentPrompt();

      expect(prompt).toContain("## Skills");
      expect(prompt).toContain("Use read_file to read SKILL.md");
      expect(prompt).toContain("beta_skill");
      expect(prompt).toContain(betaPath);
      expect(prompt).toContain(memoryPath);
      expect(prompt).toContain("User-created helper");
      expect(prompt).not.toContain("alpha_skill");
      expect(prompt).not.toContain("# File Memory");
      expect(prompt).not.toContain("# Recent History");
      expect(prompt.match(/# Verification Contract/g)).toHaveLength(1);
      expect(prompt).toContain("If a tool result says its full output was persisted");
      expect(prompt).not.toContain("{% include 'agent/verification-contract.md' %}");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("spawns, tracks by session, forwards run spec fields, and cleans up", async () => {
    const sm = manager({
      contextWindowTokens: 128_000,
      maxIterations: 37,
      llmWallTimeoutForSession: (key: string | null) => (key === "cli:direct" ? 0 : null),
    });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seenSpec: any = null;
    sm.runner.run = vi.fn(async (spec) => {
      seenSpec = spec;
      await blocker;
      return new AgentRunResult({ finalContent: "done", messages: [], stopReason: "completed" });
    });
    sm.announceResult = vi.fn(async () => undefined) as any;
    const actualModelContext = {
      presetId: "account-default",
      provider: "memmy_account",
      endpointId: "platform",
      protocol: "openai-chat-completions" as const,
      model: "agent_chat",
      source: "account" as const,
      ownerAccountId: "account-1",
      capability: "agent" as const,
      capabilities: ["agent" as const],
    };

    const out = await sm.spawn({
      task: "A long task that needs a short display label",
      sessionKey: "cli:direct",
      temperature: 0.9,
      actualModelContext,
    });
    expect(out).toContain("started");
    expect(sm.getRunningCount()).toBe(1);
    expect(sm.getRunningCountBySession("cli:direct")).toBe(1);
    expect([...sm.taskStatuses.values()][0].label).toBe("A long task that needs a short...");

    release();
    await Promise.all([...sm.runningTasks.values()]);
    expect(seenSpec.maxIterations).toBe(37);
    expect(seenSpec.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(seenSpec.contextWindowTokens).toBe(128_000);
    expect(seenSpec.temperature).toBe(0.9);
    expect(seenSpec.maxIterationsMessage).toBe(
      "The subagent reached its iteration limit before completing the task; its report may be incomplete.",
    );
    expect(seenSpec.maxIterationsFinalPrompt).toContain("produce a final report for the parent agent");
    expect(seenSpec.errorMessage).toBeNull();
    expect(seenSpec.failOnToolError).toBe(true);
    expect(seenSpec.sessionKey).toBe("cli:direct");
    expect(seenSpec.llmTimeoutS).toBe(0);
    expect(seenSpec.abortSignal).toBeInstanceOf(AbortSignal);
    expect(seenSpec.checkpointCallback).toBeTypeOf("function");
    expect(seenSpec.actualModelContext).toEqual(actualModelContext);
    expect(Object.isFrozen(seenSpec.actualModelContext)).toBe(true);
    expect(Object.isFrozen(seenSpec.actualModelContext.capabilities)).toBe(true);
    expect(sm.getRunningCount()).toBe(0);
    expect(sm.getRunningCountBySession("cli:direct")).toBe(0);
  });

  it("uses inherited account model context when a subagent read_file result contains an image", async () => {
    const workspace = tmpDir();
    const imagePath = path.join(workspace, "input.png");
    fs.writeFileSync(imagePath, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]));

    class AccountProvider extends LLMProvider {
      mainCalls: any[] = [];
      imageCalls: any[] = [];

      getDefaultModel(): string {
        return "agent_chat";
      }

      supportsAccountImageTextFallback(): boolean {
        return true;
      }

      async chat(args: any): Promise<LLMResponse> {
        this.mainCalls.push(args);
        if (this.mainCalls.length === 1) {
          return new LLMResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [new ToolCallRequest({
              id: "read-image",
              name: "read_file",
              arguments: { path: imagePath },
            })],
          });
        }
        return new LLMResponse({ content: "The image is a test fixture." });
      }

      async runAccountImageTextFallback(args: any): Promise<LLMResponse> {
        this.imageCalls.push(args);
        return new LLMResponse({ content: "Image 1: a test fixture" });
      }
    }

    const provider = new AccountProvider();
    const sm = manager({ provider, workspace, model: "agent_chat", maxIterations: 3 });
    sm.announceResult = vi.fn(async () => undefined) as any;

    await sm.spawn({
      task: `Read and describe ${imagePath}`,
      workspace,
      provider,
      model: "agent_chat",
      actualModelContext: {
        presetId: "account-default",
        provider: "memmy_account",
        endpointId: "platform",
        protocol: "openai-chat-completions",
        model: "agent_chat",
        source: "account",
        ownerAccountId: "account-1",
        capability: "agent",
        capabilities: ["agent"],
      },
    });
    await Promise.all([...sm.runningTasks.values()]);

    expect(provider.mainCalls).toHaveLength(2);
    expect(provider.imageCalls).toHaveLength(1);
    expect(JSON.stringify(provider.imageCalls[0].messages)).toContain("data:image/png;base64");
    expect(JSON.stringify(provider.mainCalls[1].messages)).toContain("Image 1: a test fixture");
    expect(JSON.stringify(provider.mainCalls[1].messages)).not.toContain('"type":"image_url"');
  });

  it("forwards an explicit provider maxTokens value without replacing it", async () => {
    const sm = manager({
      provider: {
        generation: { maxTokens: 1234 },
        getDefaultModel: () => "small-model",
      },
      model: "small-model",
      contextWindowTokens: 32_000,
    });
    const status = new SubagentStatus({ taskId: "small", label: "small", taskDescription: "do it" });
    let seenSpec: any = null;
    sm.runner.run = vi.fn(async (spec) => {
      seenSpec = spec;
      return new AgentRunResult({ finalContent: "done", messages: [], stopReason: "completed" });
    });
    sm.announceResult = vi.fn(async () => undefined) as any;

    await sm.runSubagent(
      "small",
      "do it",
      "small",
      { channel: "cli", chatId: "direct" },
      status,
    );

    expect(seenSpec.maxTokens).toBe(1234);
    expect(seenSpec.contextWindowTokens).toBe(32_000);
  });

  it("announces results as inbound system messages with session override", async () => {
    const bus = new MessageBus();
    const sm = manager({ bus });
    await sm.announceResult(
      "t1",
      "label",
      "do task",
      "result text",
      { channel: "telegram", chatId: "123", sessionKey: "telegram:123:thread" },
      "ok",
      "msg-1",
    );

    const msg = await bus.consumeInbound();
    expect(msg.channel).toBe("system");
    expect(msg.senderId).toBe("subagent");
    expect(msg.metadata.injectedEvent).toBe("subagentResult");
    expect(msg.metadata.subagentTaskId).toBe("t1");
    expect(msg.metadata.originMessageId).toBe("msg-1");
    expect(msg.sessionKeyOverride).toBe("telegram:123:thread");
    expect(msg.content).toContain("completed successfully");
  });

  it("formats partial progress from successful and failing tool events", () => {
    const text = SubagentManager.formatPartialProgress({
      toolEvents: [
        { name: "read_file", status: "ok", detail: "read" },
        { name: "grep", status: "ok", detail: "matched" },
        { name: "exec", status: "error", detail: "timeout" },
      ],
    });
    expect(text).toContain("Completed steps:");
    expect(text).toContain("grep");
    expect(text).toContain("Failure:");
    expect(text).toContain("timeout");
  });

  it("updates provider, runner, and context window together", () => {
    const sm = manager();
    const provider = { generation: { maxTokens: 1234 }, model: "new-model" };
    sm.setProvider(provider, "new-model", 64_000);
    expect(sm.provider).toBe(provider);
    expect(sm.model).toBe("new-model");
    expect(sm.contextWindowTokens).toBe(64_000);
    expect(sm.runner.provider).toBe(provider);
  });
});
