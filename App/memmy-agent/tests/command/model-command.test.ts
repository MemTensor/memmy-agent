import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../src/core/runtime-messages/queue.js";
import {
  buildHelpText,
  builtinCommandPalette,
  cmdGoal,
  cmdModel,
  registerBuiltinCommands,
} from "../../src/command/builtin.js";
import { CommandContext, CommandRouter } from "../../src/command/router.js";
import { Config, ModelPresetConfig } from "../../src/config/schema.js";

function provider(defaultModel: string, maxTokens = 123): any {
  return {
    getDefaultModel: () => defaultModel,
    generation: { max_tokens: maxTokens, maxTokens, temperature: 0.1, reasoning_effort: null, reasoningEffort: null },
  };
}

function makeLoop(): AgentLoop {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-model-command-"));
  return new AgentLoop({
    config: new Config({ fileMemory: { enabled: true } }),
    bus: new MessageBus(),
    provider: provider("base-model", 123),
    workspace: root,
    model: "base-model",
    contextWindowTokens: 1000,
    modelPresets: {
      fast: new ModelPresetConfig({ model: "openai/gpt-4.1", maxTokens: 4096, contextWindowTokens: 32_768 }),
    },
  });
}

function ctx(loop: AgentLoop, raw: string, args = "", session: any = null): CommandContext {
  const msg = new InboundMessage({ channel: "cli", senderId: "user", chatId: "direct", content: raw });
  return new CommandContext({ msg, session, key: msg.sessionKey, raw, args, loop });
}

describe("model command", () => {
  it("lists current and available presets", async () => {
    const loop = makeLoop();
    const out = await cmdModel(ctx(loop, "/model"));
    expect(out.content).toContain("Current model: `base-model`");
    expect(out.content).toContain("Current preset: `default`");
    expect(out.content).toContain("Available presets: `default`, `fast`");
    expect(out.metadata).toEqual({ renderAs: "text" });
  });

  it("switches preset and runtime dependents", async () => {
    const loop = makeLoop();
    const out = await cmdModel(ctx(loop, "/model fast", "fast"));
    expect(out.content).toContain("Switched model preset to `fast`.");
    expect(out.content).toContain("Model: `openai/gpt-4.1`");
    expect(loop.modelPreset).toBe("fast");
    expect(loop.model).toBe("openai/gpt-4.1");
    expect((loop.subagents as any).model).toBe("openai/gpt-4.1");
    expect((loop.consolidator as any).model).toBe("openai/gpt-4.1");
    expect((loop.dream as any).model).toBe("openai/gpt-4.1");
  });

  it("switches back to default", async () => {
    const loop = makeLoop();
    loop.setModelPreset("fast");
    const out = await cmdModel(ctx(loop, "/model default", "default"));
    expect(out.content).toContain("Switched model preset to `default`.");
    expect(loop.modelPreset).toBe("default");
    expect(loop.model).toBe("base-model");
    expect(loop.contextWindowTokens).toBe(1000);
  });

  it("keeps old state for unknown preset", async () => {
    const loop = makeLoop();
    const out = await cmdModel(ctx(loop, "/model missing", "missing"));
    expect(out.content).toContain("Could not switch model preset");
    expect(out.content).not.toContain('"modelPreset');
    expect(out.content).toContain("Available presets: `default`, `fast`");
    expect(loop.modelPreset).toBeNull();
    expect(loop.model).toBe("base-model");
  });

  it("is registered as exact and prefix and appears in help and palette", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const out = await router.dispatch(ctx(loop, "/model fast"));
    expect(out?.content).toContain("Switched model preset");
    expect(loop.modelPreset).toBe("fast");
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/model", arg_hint: "[preset]" })]));
    expect(buildHelpText()).toContain("/model [preset]");
  });

  it("appears in help and command palette", () => {
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/model", arg_hint: "[preset]" })]));
    expect(buildHelpText()).toContain("/model [preset]");
  });
});

describe("goal command", () => {
  it("shows usage without args and rejects mid-turn without session", async () => {
    const loop = makeLoop();
    expect((await cmdGoal(ctx(loop, "/goal")))?.content).toContain("Usage: /goal");
    expect((await cmdGoal(ctx(loop, "/goal do work", "do work")))?.content).toContain("/stop");
  });

  it("shows usage without args", async () => {
    const loop = makeLoop();
    expect((await cmdGoal(ctx(loop, "/goal")))?.content).toContain("Usage: /goal");
  });

  it("rejects mid-turn starts when no session is available", async () => {
    const loop = makeLoop();
    expect((await cmdGoal(ctx(loop, "/goal do work", "do work")))?.content).toContain("/stop");
  });

  it("rewrites to an agent prompt when a session is available", async () => {
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal audit the repo", "audit the repo", {});
    const out = await cmdGoal(commandCtx);
    expect(out).toBeNull();
    expect(commandCtx.msg.content).toContain("audit the repo");
    expect(commandCtx.msg.content).toContain("long_task");
    expect(commandCtx.msg.metadata.originalCommand).toBe("/goal");
    expect(commandCtx.msg.metadata.originalContent).toBe("/goal audit the repo");
    expect(typeof commandCtx.msg.metadata.goalStartedAt).toBe("number");
  });

  it("is registered and appears in help and palette", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal ship it", "ship it", {});
    const out = await router.dispatch(commandCtx);
    expect(out).toBeNull();
    expect(commandCtx.msg.content).toContain("ship it");
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/goal", arg_hint: "<goal>" })]));
    expect(buildHelpText()).toContain("/goal <goal>");
  });

  it("dispatches through the command router", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal ship it", "ship it", {});

    const out = await router.dispatch(commandCtx);

    expect(out).toBeNull();
    expect(commandCtx.msg.content).toContain("ship it");
  });

  it("appears in help and command palette", () => {
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/goal", arg_hint: "<goal>" })]));
    expect(buildHelpText()).toContain("/goal <goal>");
  });
});
