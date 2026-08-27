import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as topLevel from "../src/index.js";
import { AgentHook, AgentHookContext } from "../src/core/agent-runtime/hook.js";
import { AgentLoop } from "../src/core/agent-runtime/loop.js";
import { OutboundMessage } from "../src/core/runtime-messages/events.js";
import { setConfigPath } from "../src/config/loader.js";
import { Config } from "../src/config/schema.js";
import { MemmyAgent, Memmy, RunResult, FileNotFoundError } from "../src/memmy-agent.js";
import { makeProvider } from "../src/providers/factory.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-facade-"));
  roots.push(root);
  return root;
}

function writeConfig(root: string, overrides: Record<string, any> = {}): string {
  const data = {
    providers: { openrouter: { apiKey: "sk-test-key" } },
    agents: { defaults: { model: "openai/gpt-4.1" } },
    ...overrides,
  };
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
  return file;
}

function fakeLoop(root = tmpRoot()): AgentLoop {
  return new AgentLoop({
    config: new Config({ agents: { defaults: { workspace: root, provider: "custom", model: "test-model" } } }),
    workspace: root,
    provider: {
      generation: { maxTokens: 100 },
      chat: vi.fn(),
      getDefaultModel: () => "test-model",
    },
    sessionDir: path.join(root, "sessions"),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setConfigPath(path.join(os.tmpdir(), "memmy-agent-empty-config.yaml"));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Memmy programmatic facade", () => {
  it("throws when loading a missing config file", () => {
    expect(() => Memmy.fromConfig("/nonexistent/config.yaml")).toThrow(FileNotFoundError);
  });

  it("creates an instance from config with a workspace override", () => {
    const root = tmpRoot();
    const configPath = writeConfig(root);

    const bot = Memmy.fromConfig(configPath, root);

    expect(bot.agentLoop).toBeInstanceOf(AgentLoop);
    expect(bot.agentLoop.workspace).toBe(path.resolve(root));
  });

  it("creates an instance from the default config path", () => {
    const root = tmpRoot();
    setConfigPath(writeConfig(root));

    const bot = Memmy.fromConfig();

    expect(bot.agentLoop).toBeInstanceOf(AgentLoop);
  });

  it("returns RunResult from run", async () => {
    const loop = fakeLoop();
    loop.processDirect = vi.fn(async () => new OutboundMessage({ channel: "cli", chatId: "direct", content: "Hello back!" })) as any;
    const bot = new Memmy(loop);

    const result = await bot.run("hi");

    expect(result).toBeInstanceOf(RunResult);
    expect(result.content).toBe("Hello back!");
    expect(loop.processDirect).toHaveBeenCalledWith("hi", { sessionKey: "sdk:default" });
  });

  it("runs with user hooks", async () => {
    const loop = fakeLoop();
    class TestHook extends AgentHook {
      override async beforeIteration(context: AgentHookContext): Promise<void> {
        void context;
      }
    }
    loop.processDirect = vi.fn(async () => new OutboundMessage({ channel: "cli", chatId: "direct", content: "done" })) as any;
    const previousHooks = loop.extraHooks;
    const bot = new Memmy(loop);

    const result = await bot.run("hi", { hooks: [new TestHook()] });

    expect(result.content).toBe("done");
    expect(bot.agentLoop.extraHooks).toBe(previousHooks);
  });

  it("restores hooks when run errors", async () => {
    const loop = fakeLoop();
    loop.processDirect = vi.fn(async () => {
      throw new Error("boom");
    }) as any;
    const originalHooks = loop.extraHooks;

    await expect(new Memmy(loop).run("hi", { hooks: [new AgentHook()] })).rejects.toThrow("boom");

    expect(loop.extraHooks).toBe(originalHooks);
  });

  it("returns an empty result for a null response", async () => {
    const loop = fakeLoop();
    loop.processDirect = vi.fn(async () => null) as any;

    const result = await new Memmy(loop).run("hi");

    expect(result.content).toBe("");
  });

  it("uses workspace overrides from config loading", () => {
    const root = tmpRoot();
    const configPath = writeConfig(root);
    const customWorkspace = path.join(root, "custom_workspace");
    fs.mkdirSync(customWorkspace);

    const bot = Memmy.fromConfig(configPath, customWorkspace);

    expect(bot.agentLoop.workspace).toBe(path.resolve(customWorkspace));
  });

  it("uses the GitHub Copilot provider backend from SDK config", () => {
    const config = new Config({
      agents: {
        defaults: {
          provider: "github-copilot",
          model: "github-copilot/gpt-4.1",
        },
      },
    });

    const provider = makeProvider(config);

    expect(provider.constructor.name).toBe("GitHubCopilotProvider");
  });

  it("passes a custom session key", async () => {
    const loop = fakeLoop();
    loop.processDirect = vi.fn(async () => new OutboundMessage({ channel: "cli", chatId: "direct", content: "ok" })) as any;

    await new Memmy(loop).run("hi", { sessionKey: "user-alice" });

    expect(loop.processDirect).toHaveBeenCalledWith("hi", { sessionKey: "user-alice" });
  });

  it("exports Memmy and RunResult from the top level", () => {
    expect(topLevel.Memmy).toBe(Memmy);
    expect(topLevel.RunResult).toBe(RunResult);
  });

  it("populates toolsUsed across iterations", async () => {
    const loop = fakeLoop();
    loop.processDirect = (async (message: string) => {
      const extras = loop.extraHooks;
      const messages = [{ role: "user", content: message }];
      const ctx1 = new AgentHookContext({
        iteration: 0,
        messages,
        toolCalls: [
          { id: "c1", name: "read_file", arguments: {} },
          { id: "c2", name: "grep", arguments: {} },
        ],
      });
      for (const hook of extras) await hook.afterIteration(ctx1);
      messages.push({ role: "assistant", content: "ok" });
      const ctx2 = new AgentHookContext({
        iteration: 1,
        messages,
        toolCalls: [{ id: "c3", name: "web_fetch", arguments: {} }],
      });
      for (const hook of extras) await hook.afterIteration(ctx2);
      return new OutboundMessage({ channel: "cli", chatId: "direct", content: "final" });
    }) as any;

    const result = await new Memmy(loop).run("do stuff");

    expect(result.content).toBe("final");
    expect(result.toolsUsed).toEqual(["read_file", "grep", "web_fetch"]);
  });

  it("populates final messages from the last iteration", async () => {
    const loop = fakeLoop();
    loop.processDirect = (async (message: string) => {
      const messages = [
        { role: "user", content: message },
        { role: "assistant", content: "hi there" },
      ];
      const ctx = new AgentHookContext({ iteration: 0, messages });
      for (const hook of loop.extraHooks) await hook.afterIteration(ctx);
      return new OutboundMessage({ channel: "cli", chatId: "direct", content: "hi there" });
    }) as any;

    const result = await new Memmy(loop).run("hello");

    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("leaves result capture fields empty when no iterations run", async () => {
    const loop = fakeLoop();
    loop.processDirect = vi.fn(async () => new OutboundMessage({ channel: "cli", chatId: "direct", content: "noop" })) as any;

    const result = await new Memmy(loop).run("hi");

    expect(result.toolsUsed).toEqual([]);
    expect(result.messages).toEqual([]);
  });

  it("fires user hooks alongside the capture hook", async () => {
    const loop = fakeLoop();
    const seenIterations: number[] = [];
    class UserHook extends AgentHook {
      override async afterIteration(context: AgentHookContext): Promise<void> {
        seenIterations.push(context.iteration ?? -1);
      }
    }
    loop.processDirect = (async () => {
      expect(loop.extraHooks).toHaveLength(2);
      const ctx = new AgentHookContext({ iteration: 7, messages: [] });
      for (const hook of loop.extraHooks) await hook.afterIteration(ctx);
      return new OutboundMessage({ channel: "cli", chatId: "direct", content: "ok" });
    }) as any;

    await new Memmy(loop).run("x", { hooks: [new UserHook()] });

    expect(seenIterations).toEqual([7]);
  });

  it("restores existing hooks after populated capture iterations", async () => {
    const loop = fakeLoop();
    const sentinelHook = new AgentHook();
    loop.extraHooks = [sentinelHook];
    loop.processDirect = (async () => {
      const ctx = new AgentHookContext({ iteration: 0, messages: [] });
      for (const hook of loop.extraHooks) await hook.afterIteration(ctx);
      return new OutboundMessage({ channel: "cli", chatId: "direct", content: "done" });
    }) as any;

    await new Memmy(loop).run("hello");

    expect(loop.extraHooks).toEqual([sentinelHook]);
  });
});
