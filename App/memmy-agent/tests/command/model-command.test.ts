import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { resolveModelSelection } from "../../src/providers/model-catalog.js";

function provider(defaultModel: string, maxTokens = 123): any {
  return {
    getDefaultModel: () => defaultModel,
    spec: { name: "openai" },
    generation: { max_tokens: maxTokens, maxTokens, temperature: 0.1, reasoning_effort: null, reasoningEffort: null },
  };
}

const temporaryRoots: string[] = [];

afterEach(() => {
  delete process.env.MEMMY_CONFIG;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeLoop(userMode: "byok" | "account" = "byok"): AgentLoop {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-model-command-"));
  temporaryRoots.push(root);
  const configPath = path.join(root, "config.yaml");
  fs.writeFileSync(configPath, [
    "providers:",
    "  openai:",
    "    apiKey: test-key",
    "    endpoints:",
    "      chat:",
    "        apiBase: https://api.openai.com/v1",
    "        protocol: openai-chat-completions",
    "  memmy_account:",
    "    ownerAccountId: account-1",
    "    apiKey: account-secret",
    "    endpoints:",
    "      platform:",
    "        apiBase: https://account.example.test/v1",
    "        protocol: memmy-account",
    "modelPresets:",
    "  base:",
    "    endpoint: chat",
    "    provider: openai",
    "    model: base-model",
    "    source: byok",
    "    capabilities: [agent]",
    "  platform:",
    "    endpoint: platform",
    "    provider: memmy_account",
    "    model: agent_chat",
    "    source: account",
    "    ownerAccountId: account-1",
    "    capabilities: [agent]",
    "  fast:",
    "    endpoint: chat",
    "    provider: openai",
    "    model: openai/gpt-4.1",
    "    source: byok",
    "    capabilities: [agent]",
    "    maxTokens: 4096",
    "    contextWindowTokens: 32768",
    "modelAssignments:",
    "  byok:",
    "    agent:",
    "      candidates: [base, fast]",
    "      default: base",
    "  account:",
    "    ownerAccountId: account-1",
    "    agent:",
    "      candidates: [platform, fast]",
    "      default: platform",
    "app:",
    `  userMode: ${userMode}`,
    "  userId: account-1",
    "agents:",
    "  defaults:",
    "    modelPreset: base",
    "    provider: openai",
    "    model: base-model",
    "",
  ].join("\n"));
  process.env.MEMMY_CONFIG = configPath;
  const config = new Config({
    providers: {
      openai: {
        apiKey: "test-key",
        endpoints: {
          chat: { apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions" },
        },
      },
      memmy_account: {
        ownerAccountId: "account-1",
        apiKey: "account-secret",
        endpoints: {
          platform: { apiBase: "https://account.example.test/v1", protocol: "memmy-account" },
        },
      },
    },
    modelPresets: {
      base: { endpoint: "chat", provider: "openai", model: "base-model", source: "byok", capabilities: ["agent"] },
      fast: { endpoint: "chat", provider: "openai", model: "openai/gpt-4.1", source: "byok", capabilities: ["agent"] },
      platform: {
        endpoint: "platform",
        provider: "memmy_account",
        model: "agent_chat",
        source: "account",
        ownerAccountId: "account-1",
        capabilities: ["agent"],
      },
    },
    modelAssignments: {
      byok: { agent: { candidates: ["base", "fast"], default: "base" } },
      account: {
        ownerAccountId: "account-1",
        agent: { candidates: ["platform", "fast"], default: "platform" },
      },
    },
    app: { userMode, userId: "account-1" },
    agents: {
      defaults: {
        modelPreset: "base",
        provider: "openai",
        model: "base-model",
      },
    },
    fileMemory: { enabled: true },
  });
  return new AgentLoop({
    config,
    bus: new MessageBus(),
    provider: provider("base-model", 123),
    workspace: root,
    model: "base-model",
    contextWindowTokens: 1000,
    modelSelectionResolver: (input) => resolveModelSelection(input),
    modelPresets: {
      base: new ModelPresetConfig({
        endpoint: "chat",
        provider: "openai",
        model: "base-model",
        source: "byok",
        capabilities: ["agent"],
        maxTokens: 123,
        contextWindowTokens: 1000,
      }),
      fast: new ModelPresetConfig({
        endpoint: "chat",
        provider: "openai",
        model: "openai/gpt-4.1",
        source: "byok",
        capabilities: ["agent"],
        maxTokens: 4096,
        contextWindowTokens: 32_768,
      }),
    },
  });
}

function ctx(
  loop: AgentLoop,
  raw: string,
  args = "",
  sessionInput: any = null,
  turnId: string | null = null,
): CommandContext {
  const msg = new InboundMessage({ channel: "cli", senderId: "user", chatId: "direct", content: raw });
  const session = sessionInput === true
    ? loop.sessions.getOrCreate(msg.sessionKey)
    : sessionInput;
  return new CommandContext({ msg, session, key: msg.sessionKey, raw, args, loop, turnId });
}

describe("model command", () => {
  it("lists current and available presets", async () => {
    const loop = makeLoop();
    const out = await cmdModel(ctx(loop, "/model"));
    expect(out.content).toContain("Current model: `openai / base-model`");
    expect(out.content).toContain("Current preset: `base`");
    expect(out.content).toContain("Available presets: `base`, `fast`");
    expect(out.metadata).toEqual({ renderAs: "text" });
  });

  it("lists preset to Provider/model mappings", async () => {
    const loop = makeLoop();
    const out = await cmdModel(ctx(loop, "/model list", "list"));
    expect(out.content).toContain("`base` -> `openai / base-model`");
    expect(out.content).toContain("`fast` -> `openai / openai/gpt-4.1`");
  });

  it("lists only current account-mode assignments and resolves the owner-bound default", async () => {
    const loop = makeLoop("account");

    const status = await cmdModel(ctx(loop, "/model"));
    const list = await cmdModel(ctx(loop, "/model list", "list"));

    expect(status.content).toContain("Current model: `memmy_account / General text`");
    expect(status.content).toContain("Current preset: `platform`");
    expect(list.content).toContain("`platform` -> `memmy_account / General text`");
    expect(list.content).toContain("`fast` -> `openai / openai/gpt-4.1`");
    expect(list.content).not.toContain("`base`");
  });

  it("switches only the current Session and not the process-wide model", async () => {
    const loop = makeLoop();
    const mirrorUpdated = vi.fn();
    loop.guiTranscriptMirror = { sessionUpdated: mirrorUpdated } as any;
    const context = ctx(loop, "/model fast", "fast", true);
    const other = loop.sessions.getOrCreate("cli:other");

    const out = await cmdModel(context);

    expect(out.content).toContain("Switched this Session to `fast`.");
    expect(out.content).toContain("Model: `openai / openai/gpt-4.1`");
    expect(context.session?.metadata.modelPreset).toBe("fast");
    expect(loop.sessions.reload(context.key)?.metadata.modelPreset).toBe("fast");
    expect(other.metadata.modelPreset).toBeUndefined();
    expect(loop.modelPreset).toBe("base");
    expect(loop.model).toBe("base-model");
    expect(loop.contextWindowTokens).toBe(1000);
    expect(mirrorUpdated).toHaveBeenCalledWith(context.key);
  });

  it("publishes a safe request-scoped selection update for websocket TUI switches", async () => {
    const loop = makeLoop();
    const requestId = "77777777-7777-4777-8777-777777777777";
    const msg = new InboundMessage({
      channel: "websocket",
      senderId: "tui",
      chatId: "chat-model",
      content: "/model fast",
      metadata: { client_request_id: requestId },
    });
    const session = loop.sessions.getOrCreate(msg.sessionKey);
    const context = new CommandContext({
      msg,
      session,
      key: msg.sessionKey,
      raw: "/model fast",
      args: "fast",
      loop,
    });

    await cmdModel(context);

    const update = loop.bus.outbound.getNowait();
    expect(update).toMatchObject({
      channel: "websocket",
      chatId: "chat-model",
      metadata: {
        runtimeModelUpdated: true,
        webuiRequestSessionKey: "websocket:chat-model",
        clientRequestId: requestId,
        modelSelection: {
          preset_id: "fast",
          provider: "openai",
          endpoint_id: "chat",
          protocol: "openai-chat-completions",
          model: "openai/gpt-4.1",
          source: "byok",
          owner_account_id: null,
          capabilities: ["agent"],
        },
      },
    });
    expect(JSON.stringify(update)).not.toContain("test-key");
  });

  it("keeps old state for unknown preset", async () => {
    const loop = makeLoop();
    const context = ctx(loop, "/model missing", "missing", true);
    const out = await cmdModel(context);
    expect(out.content).toContain("Could not switch model preset");
    expect(out.content).not.toContain('"modelPreset');
    expect(out.content).toContain("model_selection_unavailable");
    expect(out.content).toContain("Available presets: `base`, `fast`");
    expect(context.session?.metadata.modelPreset).toBeUndefined();
    expect(loop.modelPreset).toBe("base");
    expect(loop.model).toBe("base-model");
  });

  it("is registered as exact and prefix and appears in help and palette", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const out = await router.dispatch(ctx(loop, "/model fast", "", true));
    expect(out?.content).toContain("Switched this Session");
    expect(loop.modelPreset).toBe("base");
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/model", arg_hint: "[list|preset]" })]));
    expect(buildHelpText()).toContain("/model [list|preset]");
  });

  it("appears in help and command palette", () => {
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/model", arg_hint: "[list|preset]" })]));
    expect(buildHelpText()).toContain("/model [list|preset]");
  });
});

describe("goal command", () => {
  it("shows the empty Goal state without args", async () => {
    const loop = makeLoop();
    const content = (await cmdGoal(ctx(loop, "/goal")))?.content ?? "";
    expect(content).toContain('"goal_id": null');
    expect(content).toContain("Available: create <objective>");
  });

  it("shows the Goal control help", async () => {
    const loop = makeLoop();
    const content = (await cmdGoal(ctx(loop, "/goal help", "help")))?.content ?? "";
    expect(content).toContain("/goal create <objective>");
    expect(content).toContain("/goal budget <positive-int|none>");
  });

  it("rejects Goal creation when the command has no top-level turn identity", async () => {
    const loop = makeLoop();
    expect((await cmdGoal(ctx(loop, "/goal do work", "do work")))?.content)
      .toContain("goal_route_unavailable");
  });

  it("creates persistent Goal state instead of rewriting the model prompt", async () => {
    const loop = makeLoop();
    const schedule = vi.spyOn(loop, "scheduleGoalWork");
    const commandCtx = ctx(loop, "/goal audit the repo", "audit the repo", true, "turn-goal-1");
    const out = await cmdGoal(commandCtx);
    expect(out.content).toContain("Goal created.");
    expect(loop.goalRuntime.get(commandCtx.key)).toMatchObject({
      objective: "audit the repo",
      status: "active",
    });
    expect(schedule).toHaveBeenCalledOnce();
    expect(commandCtx.msg.content).toBe("/goal audit the repo");
  });

  it("is registered and appears in help and palette", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal ship it", "ship it", true, "turn-goal-2");
    const out = await router.dispatch(commandCtx);
    expect(out?.content).toContain("Goal created.");
    expect(loop.goalRuntime.get(commandCtx.key)?.objective).toBe("ship it");
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({
      command: "/goal",
      arg_hint: "[status|help|create <objective>|pause|resume|edit <objective>|budget <n|none>|clear]",
    })]));
    expect(buildHelpText()).toContain("/goal [status|help|create <objective>|pause|resume|edit <objective>|budget <n|none>|clear]");
  });

  it("dispatches through the command router", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const loop = makeLoop();
    const commandCtx = ctx(loop, "/goal ship it", "ship it", true, "turn-goal-3");

    const out = await router.dispatch(commandCtx);

    expect(out?.content).toContain("Goal created.");
    expect(loop.goalRuntime.get(commandCtx.key)?.objective).toBe("ship it");
  });

  it("appears in help and command palette", () => {
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/goal" })]));
    expect(buildHelpText()).toContain("/goal [status|help|create <objective>|pause|resume|edit <objective>|budget <n|none>|clear]");
  });
});
