import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { buildHelpText, builtinCommandPalette } from "../../../src/command/builtin.js";
import { setConfigPath } from "../../../src/config/loader.js";
import { Config } from "../../../src/config/schema.js";
import { findByName } from "../../../src/providers/registry.js";
import { makeProvider } from "../../../src/providers/factory.js";
import { OpenAICompatProvider } from "../../../src/providers/openai-compat-provider.js";
import { stripModelPrefix as stripCodexModelPrefix } from "../../../src/providers/openai-codex-provider.js";
import { GitHubCopilotProvider, getStorage } from "../../../src/providers/github-copilot-provider.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage, OutboundMessage } from "../../../src/core/runtime-messages/events.js";
import { CronJob, CronJobState, CronPayload, CronSchedule } from "../../../src/cron/types.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import {
  RESTART_NOTIFY_CHANNEL_ENV,
  RESTART_NOTIFY_CHAT_ID_ENV,
  RESTART_STARTED_AT_ENV,
} from "../../../src/utils/restart.js";
import {
  agent,
  cliRuntimeLogsEnabled,
  deleteOauthFiles,
  gateway,
  isRootInteractiveRequest,
  isRootVersionRequest,
  loadRuntimeConfig,
  main,
  mergeMissingDefaults,
  modelDisplay,
  onboard,
  pluginsListRows,
  providerLogin,
  providerLogout,
  resolveOauthProvider,
  serve,
  setCliRuntimeLogs,
  setConfigValue,
  setPromptSessionForTest,
  setRootInteractiveRunnerForTest,
  startGatewayHealthServer,
  status,
  warnDeprecatedConfigKeys,
} from "../../../src/entrypoints/cli/commands.js";
import { API_MAX_BODY_BYTES } from "../../../src/entrypoints/openai-like-api/server.js";
import { setQuestionary } from "../../../src/entrypoints/cli/onboard.js";
import { VERSION } from "../../../src/version.js";

const ENV_KEYS = [
  "MEMMY_AGENT_DATA_DIR",
  "MEMMY_CONFIG",
  "MEMMY_CLOUD_SERVICE",
  "OAUTH_CLI_KIT_TOKEN_PATH",
  "OPENAI_CODEX_TOKEN_PATH",
  "CHATGPT_TOKEN_PATH",
  "OPENAI_CODEX_ACCOUNT_ID",
  "OPENAI_CODEX_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_ACCESS_TOKEN",
  RESTART_NOTIFY_CHANNEL_ENV,
  RESTART_NOTIFY_CHAT_ID_ENV,
  RESTART_STARTED_AT_ENV,
  "GITHUB_COPILOT_ACCESS_TOKEN",
  "GITHUB_TOKEN",
];
const roots: string[] = [];
const originalStdinIsTty = (process.stdin as any).isTTY;

function tempRoot(prefix = "memmy-cli-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeConfig(root: string, data: Record<string, any> = {}, name = "config.yaml"): string {
  const configPath = path.join(root, name);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(data), "utf8");
  return configPath;
}

function fakeAgentLoop(content = "mock-response"): any {
  return {
    processDirect: vi.fn(async () => ({ channel: "cli", chatId: "direct", content, metadata: {} })),
    connectMcp: vi.fn(async () => undefined),
    closeMcp: vi.fn(async () => undefined),
    stop: vi.fn(),
    sessions: { flushAll: vi.fn(() => 0) },
  };
}

async function closeServer(server: any): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakePrompt<T> {
  constructor(private readonly value: T) {}
  async ask(): Promise<T> {
    return this.value;
  }
}

function usePrompt(responses: any[]): void {
  const next = () => {
    if (!responses.length) throw new Error("prompt exhausted");
    return responses.shift();
  };
  setQuestionary({
    select(_message, options) {
      const choices = Array.isArray(options) ? options : options.choices;
      const raw = next();
      if (raw === "done") return new FakePrompt("[Done]");
      if (raw === "back") return new FakePrompt("<- Back");
      if (raw instanceof RegExp) return new FakePrompt(choices.find((choice) => raw.test(choice)) ?? choices[0]);
      return new FakePrompt(raw);
    },
    confirm() {
      return new FakePrompt(Boolean(next()));
    },
    text() {
      return new FakePrompt(next());
    },
    autocomplete() {
      return new FakePrompt(next());
    },
    pressAnyKeyToContinue() {
      return new FakePrompt(null);
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setQuestionary(null);
  setPromptSessionForTest(null);
  setRootInteractiveRunnerForTest(null);
  setCliRuntimeLogs(false);
  (process.stdin as any).isTTY = originalStdinIsTty;
  setConfigPath(null);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CLI command helpers", () => {
  it("includes core slash commands in the command palette and help", () => {
    const names = builtinCommandPalette().map((item) => item.command);

    expect(names).toEqual(expect.arrayContaining(["/restart", "/status", "/history", "/help"]));
    expect(buildHelpText()).toContain("/restart");
  });

  it("can hide history DAG from config-aware command palettes", () => {
    expect(builtinCommandPalette().map((item) => item.command)).toContain("/history-dag");
    expect(builtinCommandPalette({ sessionDagEnabled: false }).map((item) => item.command)).not.toContain("/history-dag");
  });

  it("routes root version requests through versionCallback", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(isRootVersionRequest(["node", "memmy", "-V"])).toBe(true);
    expect(isRootVersionRequest(["node", "memmy", "--version"])).toBe(true);
    await main(["node", "memmy", "--version"]);

    expect(log).toHaveBeenCalledWith(VERSION);
  });

  it("routes bare memmy to the Ink TUI", async () => {
    const runRoot = vi.fn(async () => undefined);
    setRootInteractiveRunnerForTest(runRoot);

    expect(isRootInteractiveRequest(["node", "memmy"])).toBe(true);
    await main(["node", "memmy"]);

    expect(runRoot).toHaveBeenCalledOnce();
  });

  it("matches explicit provider prefixes", () => {
    const config = new Config({ agents: { defaults: { model: "ollama/llama3.2" } } });

    expect(config.getProviderName()).toBe("ollama");
    expect(config.getApiBase()).toBe("http://localhost:11434/v1");
    expect(findByName("openai-codex")?.name).toBe("openai_codex");
  });

  it("returns plugin list rows", () => {
    const root = tempRoot();
    setConfigPath(writeConfig(root, {}));

    const rows = pluginsListRows();

    expect(Array.isArray(rows)).toBe(true);
    if (rows.length) expect(rows[0]).toEqual(expect.objectContaining({ name: expect.any(String), source: expect.any(String) }));
  });

  it("merges missing defaults without overwriting existing values", () => {
    expect(mergeMissingDefaults({ enabled: true, nested: { token: "keep" } }, { enabled: false, nested: { token: "", mode: "polling" } })).toEqual({
      enabled: true,
      nested: { token: "keep", mode: "polling" },
    });
  });

  it("loads runtime config with explicit config and workspace override", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cli-config-"));
    const configPath = path.join(root, "config.yaml");
    fs.writeFileSync(configPath, YAML.stringify({ agents: { defaults: { model: "openai/gpt-test" } } }), "utf8");

    const config = loadRuntimeConfig(configPath, path.join(root, "workspace"));

    expect(config.agents.defaults.model).toBe("openai/gpt-test");
    expect(config.agents.defaults.workspace).toBe(path.join(root, "workspace"));
  });

  it("onboard creates config, channel defaults, workspace templates, and leaves legacy cron store untouched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-onboard-"));
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const legacyDir = path.join(root, "cron");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "jobs.json"), "[]", "utf8");
    process.env.MEMMY_AGENT_DATA_DIR = root;

    const config = await onboard({ config: configPath, workspace });
    delete process.env.MEMMY_AGENT_DATA_DIR;

    expect(config.agents.defaults.workspace).toBe(workspace);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(true);
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.agents.defaults.maxTokens).toBe(65_536);
    expect(raw.agents.defaults.maxTokens).toBe(65_536);
    expect(raw.channels.websocket).toEqual(expect.objectContaining({ enabled: true }));
    expect(raw.channels.slack).toEqual(expect.objectContaining({ enabled: false }));
    expect(raw.fileMemory).toEqual({ enabled: false });
    expect(config.fileMemory.enabled).toBe(false);
    expect(fs.existsSync(path.join(workspace, "memory", "history.jsonl"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(workspace, "memory", "MEMORY.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);

    expect(fs.existsSync(path.join(legacyDir, "jobs.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "cron", "jobs.json"))).toBe(false);
  });

  it("onboard wizard does not write missing config when the user exits without saving", async () => {
    const root = tempRoot("memmy-onboard-wizard-");
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    usePrompt(["[X] Exit Without Saving"]);

    const config = await onboard({ config: configPath, workspace, wizard: true });

    expect(config.agents.defaults.workspace).toBe(workspace);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("onboard asks before resetting an existing config in an interactive terminal", async () => {
    const root = tempRoot("memmy-onboard-existing-");
    const configPath = writeConfig(root, {
      agents: { defaults: { model: "openai/custom-model", workspace: path.join(root, "old-workspace") } },
    });
    const workspace = path.join(root, "new-workspace");
    (process.stdin as any).isTTY = true;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    usePrompt([true]);

    const config = await onboard({ config: configPath, workspace });

    expect(config.agents.defaults.model).toBe(new Config().agents.defaults.model);
    expect(config.agents.defaults.workspace).toBe(workspace);
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(raw.agents.defaults.model).toBe(new Config().agents.defaults.model);
    expect(raw.agents.defaults.workspace).toBe(workspace);
  });

  it("sets app.userId through config set and mirrors it into memmyMemory.userId", () => {
    const root = tempRoot("memmy-config-set-");
    const configPath = writeConfig(root, {});

    const result = setConfigValue("app.userId", "user_123", { config: configPath });
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(result.key).toBe("app.userId");
    expect(result.value).toBe("user_123");
    expect(result.config.app.userId).toBe("user_123");
    expect(result.config.memmyMemory.userId).toBe("user_123");
    expect(raw.app.userId).toBe("user_123");
    expect(raw.memmyMemory.userId).toBe("user_123");
    expect(raw.identity).toBeUndefined();
  });

  it("preserves image generation profiles through config set", () => {
    const root = tempRoot("memmy-config-set-image-");
    const configPath = writeConfig(root, {
      tools: {
        imageGeneration: {
          enabled: true,
          activeProfile: "account",
          profiles: {
            account: {
              provider: "memmy_account",
              model: "image_gen",
              apiKey: "cloud-login-uuid",
              apiBase: "https://cloud.example.com/api/agentExternal/v1",
            },
            byok: {
              provider: "openai",
              model: "gpt-image-1",
              apiKey: "sk-byok",
              apiBase: "https://api.openai.com/v1",
            },
          },
        },
      },
    });

    setConfigValue("app.userId", "user_123", { config: configPath });
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(raw.tools.imageGeneration.activeProfile).toBe("account");
    expect(raw.tools.imageGeneration.profiles.account).toMatchObject({
      provider: "memmy_account",
      model: "image_gen",
      apiKey: "cloud-login-uuid",
    });
    expect(raw.tools.imageGeneration.profiles.byok).toMatchObject({
      provider: "openai",
      model: "gpt-image-1",
      apiKey: "sk-byok",
    });
  });

  it("runs memmy config set app.userId", async () => {
    const root = tempRoot("memmy-config-set-cli-");
    const configPath = writeConfig(root, {});
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["node", "memmy", "config", "set", "app.userId", "user_cli_123", "-c", configPath]);
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(raw.app.userId).toBe("user_cli_123");
    expect(raw.memmyMemory.userId).toBe("user_cli_123");
    expect(log.mock.calls.flat().join("\n")).toContain("app.userId: user_cli_123");
  });

  it("rejects unsupported config set keys", () => {
    const root = tempRoot("memmy-config-set-bad-");
    const configPath = writeConfig(root, {});

    expect(() => setConfigValue("agents.defaults.model", "openai/test", { config: configPath }))
      .toThrow("unsupported config key");
  });

  it("serve uses api.timeout from config when no CLI timeout override is supplied", async () => {
    const root = tempRoot("memmy-serve-timeout-");
    const workspace = path.join(root, "workspace");
    const configPath = writeConfig(root, {
      agents: { defaults: { workspace, model: "openai/test-model" } },
      api: { host: "127.0.0.1", port: 0, timeout: 0.01 },
    });
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue({
      processDirect: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { content: "late" };
      }),
      connectMcp: vi.fn(async () => undefined),
      closeMcp: vi.fn(async () => undefined),
    } as any);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const server = await serve({ config: configPath });
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(504);
      expect(body.error.message).toContain("Request timed out after 0.01s");
      expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("serve connects MCP on startup and closes it when the API server closes", async () => {
    const root = tempRoot("memmy-serve-mcp-");
    const workspace = path.join(root, "workspace");
    const configPath = writeConfig(root, {
      agents: { defaults: { workspace, model: "openai/test-model" } },
      api: { host: "127.0.0.1", port: 0, timeout: 1 },
    });
    const loop = fakeAgentLoop("ok");
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(loop as any);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const server = await serve({ config: configPath });
    expect(loop.connectMcp).toHaveBeenCalledTimes(1);
    await closeServer(server);

    expect(loop.closeMcp).toHaveBeenCalledTimes(1);
  });

  it("serve rejects oversized API request bodies before invoking the agent", async () => {
    const root = tempRoot("memmy-serve-body-limit-");
    const workspace = path.join(root, "workspace");
    const configPath = writeConfig(root, {
      agents: { defaults: { workspace, model: "openai/test-model" } },
      api: { host: "127.0.0.1", port: 0, timeout: 1 },
    });
    const loop = fakeAgentLoop("ok");
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(loop as any);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const server = await serve({ config: configPath });
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(API_MAX_BODY_BYTES + 1),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(413);
      expect(body.error.message).toContain("20MB");
      expect(loop.processDirect).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("gateway starts a configured health endpoint and can stop cleanly", async () => {
    const root = tempRoot("memmy-gateway-");
    const workspace = path.join(root, "workspace");
    const configPath = writeConfig(root, {
      agents: { defaults: { workspace, model: "openai/test-model" } },
      fileMemory: { enabled: true },
      channels: {
        websocket: { enabled: true, port: 0 },
      },
      gateway: {
        host: "127.0.0.1",
        port: 0,
        heartbeat: { enabled: false, intervalS: 900, keepRecentMessages: 4 },
      },
    });
    const fakeSessions = {
      getOrCreate: vi.fn(() => ({
        addMessage: vi.fn(),
        retainRecentLegalSuffix: vi.fn(),
      })),
      save: vi.fn(),
      listSessions: vi.fn(() => []),
    };
    let loopRunning = true;
    const fakeLoop: any = {
      workspace,
      model: "agent_chat",
      unifiedSession: false,
      fileMemoryEnabled: true,
      tools: { get: vi.fn(() => undefined) },
      provider: null,
      refreshProviderSnapshot: vi.fn(() => {
        fakeLoop.model = "openai/refreshed-model";
      }),
      run: vi.fn(async () => {
        while (loopRunning) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }),
      dispatchMessage: vi.fn(async () => undefined),
      processMessage: vi.fn(async () => null),
      processDirect: vi.fn(async () => null),
      llmRuntime: vi.fn(() => ({ provider: {}, model: "openai/test-model" })),
      scheduleBackground: vi.fn((promise: Promise<any>) => {
        void promise.catch(() => undefined);
      }),
      dream: {
        run: vi.fn(async () => undefined),
        setProvider: vi.fn(),
        maxBatchSize: 0,
        maxIterations: 0,
        annotateLineAges: false,
      },
      stop: vi.fn(() => {
        loopRunning = false;
      }),
      closeMcp: vi.fn(async () => undefined),
      sessions: {
        ...fakeSessions,
        flush: vi.fn(async () => undefined),
      },
    };
    let cronStorePath = "";
    let publishedModelUpdate: OutboundMessage | undefined;
    vi.spyOn(AgentLoop, "fromConfig").mockImplementation((_loaded: any, bus: any, extra: any = {}) => {
      cronStorePath = extra.cronService?.storePath ?? "";
      if (typeof extra.runtimeModelPublisher === "function") {
        extra.runtimeModelPublisher("gpt-x", "fast");
        publishedModelUpdate = bus.outbound.getNowait();
      }
      return fakeLoop as any;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const runtime = await gateway({ config: configPath });
    const address = runtime.healthServer.address();
    const actualPort = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${actualPort}/health`);
    const missing = await fetch(`http://127.0.0.1:${actualPort}/missing`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(missing.status).toBe(404);
    expect(runtime.heartbeat.enabled).toBe(false);
    expect(runtime.heartbeat.intervalS).toBe(900);
    expect(cronStorePath).toBe(path.join(workspace, "cron", "jobs.json"));
    expect(runtime.manager.webuiRuntimeModelName?.()).toBe("openai/refreshed-model");
    const websocketChannel = runtime.manager.getChannel("websocket");
    expect(websocketChannel).toBeInstanceOf(WebSocketChannel);
    expect((websocketChannel as any).webuiTitleService).toMatchObject({
      sessions: fakeLoop.sessions,
      llmRuntime: expect.any(Function),
      tokenUsageRecorder: expect.objectContaining({
        recordAgentChatUsage: expect.any(Function),
      }),
    });
    expect(fakeLoop.refreshProviderSnapshot).toHaveBeenCalled();
    expect(publishedModelUpdate?.metadata).toMatchObject({
      runtimeModelUpdated: true,
      model: "gpt-x",
      model_preset: "fast",
    });
    expect(fakeLoop.run).toHaveBeenCalledTimes(1);
    await runtime.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "chat-1",
      content: "hello",
      metadata: { wantsStream: true },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeLoop.dispatchMessage).not.toHaveBeenCalled();
    expect(fakeLoop.processMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(true);
    expect(runtime.cron.listJobs({ includeDisabled: true }).map((job) => job.id)).toContain("dream");
    expect((websocketChannel as WebSocketChannel).fileMemoryEnabled).toBe(true);
    await runtime.stop();
    expect(fakeLoop.stop).toHaveBeenCalledTimes(1);
  });

  it("gateway health helper serves only the health endpoint", async () => {
    const server = await startGatewayHealthServer("127.0.0.1", 0);
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const notFound = await fetch(`http://127.0.0.1:${port}/nope`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
      expect(notFound.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  async function startCronGatewayWithFakeLoop({
    processDirect,
    isSessionBusy = vi.fn(() => false),
    isSessionGoalActive = vi.fn(() => false),
    waitForCronTargetAvailable = vi.fn(async () => undefined),
  }: {
    processDirect: any;
    isSessionBusy?: any;
    isSessionGoalActive?: any;
    waitForCronTargetAvailable?: any;
  }): Promise<{
    runtime: Awaited<ReturnType<typeof gateway>>;
    fakeLoop: any;
    sessionsByKey: Map<string, any>;
  }> {
    const root = tempRoot("memmy-cron-gateway-");
    const workspace = path.join(root, "workspace");
    const configPath = writeConfig(root, {
      agents: { defaults: { workspace, model: "openai/test-model" } },
      gateway: {
        host: "127.0.0.1",
        port: 0,
        heartbeat: { enabled: false, intervalS: 900, keepRecentMessages: 4 },
      },
    });
    const sessionsByKey = new Map<string, any>();
    const sessions = {
      getOrCreate: vi.fn((key: string) => {
        let session = sessionsByKey.get(key);
        if (!session) {
          session = {
            key,
            messages: [],
            metadata: {},
            addMessage: vi.fn((role: string, content: string, extra: Record<string, any> = {}) => {
              session.messages.push({ role, content, ...extra });
            }),
            retainRecentLegalSuffix: vi.fn(),
          };
          sessionsByKey.set(key, session);
        }
        return session;
      }),
      save: vi.fn(),
      listSessions: vi.fn(() => []),
      flush: vi.fn(async () => undefined),
    };
    let loopRunning = true;
    const fakeLoop: any = {
      workspace,
      model: "agent_chat",
      unifiedSession: false,
      fileMemoryEnabled: false,
      tools: { get: vi.fn(() => undefined) },
      provider: null,
      refreshProviderSnapshot: vi.fn(),
      run: vi.fn(async () => {
        while (loopRunning) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }),
      dispatchMessage: vi.fn(async () => undefined),
      processMessage: vi.fn(async () => null),
      processDirect,
      llmRuntime: vi.fn(() => ({ provider: {}, model: "openai/test-model" })),
      scheduleBackground: vi.fn((promise: Promise<any>) => {
        void promise.catch(() => undefined);
      }),
      dream: {
        run: vi.fn(async () => undefined),
        setProvider: vi.fn(),
        maxBatchSize: 0,
        maxIterations: 0,
        annotateLineAges: false,
      },
      stop: vi.fn(() => {
        loopRunning = false;
      }),
      closeMcp: vi.fn(async () => undefined),
      cancelActiveTasks: vi.fn(async () => 0),
      sessions,
      isSessionBusy,
      isSessionGoalActive,
      waitForCronTargetAvailable,
    };
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(fakeLoop);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtime = await gateway({ config: configPath });
    return { runtime, fakeLoop, sessionsByKey };
  }

  function makeCronJob(payload: CronPayload, nextRunAtMs = 1_780_000_000_000): CronJob {
    return new CronJob({
      id: "cron-test",
      name: "cron test",
      schedule: new CronSchedule({ kind: "at", atMs: nextRunAtMs }),
      payload,
      state: new CronJobState({ nextRunAtMs }),
    });
  }

  it("removes and guards Dream cron when file memory is disabled", async () => {
    const processDirect = vi.fn();
    const { runtime, fakeLoop } = await startCronGatewayWithFakeLoop({
      processDirect,
    });
    try {
      expect(
        runtime.cron
          .listJobs({ includeDisabled: true })
          .map((job) => job.id),
      ).not.toContain("dream");
      const result = await runtime.cron.onJob?.(
        new CronJob({
          id: "dream",
          name: "dream",
          schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }),
          payload: new CronPayload({ kind: "systemEvent" }),
        }),
      );
      expect(result).toBe("File memory is disabled.");
      expect(fakeLoop.dream.run).not.toHaveBeenCalled();
      expect(processDirect).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });

  it("delivers WebUI cron fallback messages as non-streaming proactive transcript messages", async () => {
    const processDirect = vi.fn(async () => ({ content: "cron final", metadata: {} }));
    const { runtime, fakeLoop, sessionsByKey } = await startCronGatewayWithFakeLoop({ processDirect });
    try {
      const due = 1_780_000_000_000;
      await runtime.cron.onJob?.(makeCronJob(new CronPayload({
        message: "提醒",
        deliver: true,
        channel: "websocket",
        to: "chat-1",
        sessionKey: "websocket:chat-1",
        channelMeta: {
          webui: true,
          webui_language: "zh-CN",
          turn_id: "stale-turn",
          turnId: "stale-turn",
          wantsStream: true,
          streamId: "old-stream",
          toolEvents: [{ phase: "start" }],
        },
      }), due));

      expect(processDirect).toHaveBeenCalledWith(expect.stringContaining("Reminder: 提醒"), expect.objectContaining({
        sessionKey: "cron:cron-test",
        channel: "websocket",
        chatId: "chat-1",
        metadata: expect.objectContaining({ turn_id: "stale-turn" }),
        messageSendCallback: expect.any(Function),
      }));
      expect(fakeLoop.waitForCronTargetAvailable).toHaveBeenCalledWith("websocket", "websocket:chat-1");
      const outbound = runtime.bus.outbound.getNowait();
      expect(outbound).toMatchObject({
        channel: "websocket",
        chatId: "chat-1",
        content: "cron final",
        metadata: {
          webui: true,
          webui_language: "zh-CN",
          proactiveDelivery: "cron",
          cronJobId: "cron-test",
          scheduledForMs: due,
        },
      });
      expect(outbound?.metadata).not.toHaveProperty("turn_id");
      expect(outbound?.metadata).not.toHaveProperty("turnId");
      expect(outbound?.metadata).not.toHaveProperty("wantsStream");
      expect(outbound?.metadata).not.toHaveProperty("streamId");
      expect(outbound?.metadata).not.toHaveProperty("toolEvents");
      expect(outbound?.metadata).not.toHaveProperty("recordChannelDelivery");
      expect(outbound?.metadata.delayedByMs).toEqual(expect.any(Number));
      const session = sessionsByKey.get("websocket:chat-1");
      expect(session.messages).toEqual([
        { role: "assistant", content: "cron final", channelDelivery: true },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it("routes WebUI cron message-tool delivery through the same proactive path and skips fallback duplicates", async () => {
    const processDirect = vi.fn(async (_prompt: string, options: any) => {
      await options.messageSendCallback(new OutboundMessage({
        channel: "websocket",
        chatId: "chat-1",
        content: "message tool final",
        metadata: {
          ...options.metadata,
          recordChannelDelivery: true,
        },
      }));
      return { content: "fallback should not send", metadata: {} };
    });
    const { runtime, sessionsByKey } = await startCronGatewayWithFakeLoop({ processDirect });
    try {
      await runtime.cron.onJob?.(makeCronJob(new CronPayload({
        message: "发消息",
        deliver: true,
        channel: "websocket",
        to: "chat-1",
        sessionKey: "websocket:chat-1",
        channelMeta: { webui: true, webui_language: "zh-CN", turn_id: "old" },
      })));

      const outbound = runtime.bus.outbound.getNowait();
      expect(outbound?.content).toBe("message tool final");
      expect(outbound?.metadata).toMatchObject({
        webui: true,
        webui_language: "zh-CN",
        proactiveDelivery: "cron",
        cronJobId: "cron-test",
      });
      expect(outbound?.metadata).not.toHaveProperty("turn_id");
      expect(outbound?.metadata).not.toHaveProperty("recordChannelDelivery");
      expect(runtime.bus.outbound.getNowait()).toBeUndefined();
      expect(sessionsByKey.get("websocket:chat-1").messages).toEqual([
        { role: "assistant", content: "message tool final", channelDelivery: true },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it("adds the WebUI active-goal delay notice before cron delivery", async () => {
    const due = 1_780_000_000_000;
    const processDirect = vi.fn(async () => ({ content: "goal summary", metadata: {} }));
    const { runtime } = await startCronGatewayWithFakeLoop({
      processDirect,
      isSessionGoalActive: vi.fn(() => true),
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(due + 12_000);
    try {
      await runtime.cron.onJob?.(makeCronJob(new CronPayload({
        message: "总结目标进展",
        deliver: true,
        channel: "websocket",
        to: "chat-1",
        sessionKey: "websocket:chat-1",
        channelMeta: { webui: true, webui_language: "zh-CN" },
      }), due));

      const outbound = runtime.bus.outbound.getNowait();
      expect(outbound?.content).toBe(
        "由于这条定时任务到点时当前长期目标尚未完成，实际发送延迟了 12 秒。\n\n" +
        "goal summary",
      );
      expect(outbound?.metadata.delayedByMs).toBe(12_000);
    } finally {
      nowSpy.mockRestore();
      await runtime.stop();
    }
  });

  it("does not apply WebUI cron waiting or metadata cleanup to non-WebUI channels", async () => {
    const processDirect = vi.fn(async () => ({ content: "slack final", metadata: {} }));
    const isSessionBusy = vi.fn(() => true);
    const isSessionGoalActive = vi.fn(() => true);
    const waitForCronTargetAvailable = vi.fn(async () => undefined);
    const { runtime } = await startCronGatewayWithFakeLoop({
      processDirect,
      isSessionBusy,
      isSessionGoalActive,
      waitForCronTargetAvailable,
    });
    try {
      await runtime.cron.onJob?.(makeCronJob(new CronPayload({
        message: "slack reminder",
        deliver: true,
        channel: "slack",
        to: "C123",
        sessionKey: "slack:C123",
        channelMeta: {
          turn_id: "keep-turn",
          wantsStream: true,
          slack: { thread_ts: "111.222" },
        },
      })));

      expect(isSessionBusy).not.toHaveBeenCalled();
      expect(isSessionGoalActive).not.toHaveBeenCalled();
      expect(waitForCronTargetAvailable).not.toHaveBeenCalled();
      expect(processDirect).toHaveBeenCalledWith(expect.any(String), expect.not.objectContaining({
        messageSendCallback: expect.any(Function),
      }));
      const outbound = runtime.bus.outbound.getNowait();
      expect(outbound).toMatchObject({
        channel: "slack",
        chatId: "C123",
        content: "slack final",
        metadata: {
          turn_id: "keep-turn",
          wantsStream: true,
          slack: { thread_ts: "111.222" },
        },
      });
      expect(outbound?.metadata).not.toHaveProperty("proactiveDelivery");
      expect(outbound?.metadata).not.toHaveProperty("cronJobId");
      expect(outbound?.metadata).not.toHaveProperty("delayedByMs");
    } finally {
      await runtime.stop();
    }
  });

  it("agent without a message enters interactive chat mode", async () => {
    const root = tempRoot();
    const configPath = writeConfig(root, { agents: { defaults: { workspace: path.join(root, "workspace"), model: "test-model" } } });
    const promptAsync = vi.fn()
      .mockResolvedValueOnce("hello")
      .mockResolvedValueOnce("exit");
    setPromptSessionForTest({ promptAsync });
    (process.stdin as any).isTTY = true;
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    vi.spyOn(AgentLoop, "fromConfig").mockImplementation((config: any, bus: any) => {
      let running = true;
      return {
        run: vi.fn(async () => {
          while (running) {
            const inbound = bus.inbound.getNowait();
            if (inbound) {
              await bus.publishOutbound(new OutboundMessage({
                channel: inbound.channel,
                chatId: inbound.chatId,
                content: `reply: ${inbound.content}`,
                metadata: {},
              }));
              await bus.publishOutbound(new OutboundMessage({
                channel: inbound.channel,
                chatId: inbound.chatId,
                content: "",
                metadata: {},
              }));
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }),
        stop: vi.fn(() => {
          running = false;
        }),
        closeMcp: vi.fn(async () => undefined),
        config,
      } as any;
    });

    await agent({ config: configPath });

    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(logs.join("\n")).toContain("Interactive mode");
    expect(logs.join("\n")).toContain("reply: hello");
    expect(logs.join("\n")).toContain("Goodbye");
  });

  it("agent with a message streams direct output without duplicate final printing", async () => {
    const root = tempRoot();
    const configPath = writeConfig(root, { agents: { defaults: { workspace: path.join(root, "workspace"), model: "test-model" } } });
    const processDirect = vi.fn(async (_content: string, opts: Record<string, any>) => {
      await opts.onStream("he");
      await opts.onStream("llo");
      await opts.onStreamEnd({ resuming: false });
      return { channel: "cli", chatId: "direct", content: "hello", metadata: { streamed: true } };
    });
    const loop = {
      processDirect,
      closeMcp: vi.fn(async () => undefined),
      stop: vi.fn(),
      sessions: { flushAll: vi.fn(() => 0) },
    };
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(loop as any);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.map(String).join(" "));
    });

    const result = await agent({ message: "hello", config: configPath, markdown: false, logs: true });

    expect(result).toBe("hello");
    expect(processDirect).toHaveBeenCalledWith("hello", expect.objectContaining({
      sessionKey: "cli:direct",
      onProgress: expect.any(Function),
      onStream: expect.any(Function),
      onStreamEnd: expect.any(Function),
    }));
    expect(writes.join("")).toContain("hello");
    expect(logs.join("\n")).not.toContain("hello");
    expect(cliRuntimeLogsEnabled()).toBe(true);
    expect(fs.existsSync(path.join(root, "workspace", "AGENTS.md"))).toBe(true);
    expect(loop.stop).toHaveBeenCalledTimes(1);
    expect(loop.closeMcp).toHaveBeenCalledTimes(1);
    expect(loop.sessions.flushAll).toHaveBeenCalledTimes(1);
  });

  it("agent prints a matching CLI restart notice before a direct turn", async () => {
    const root = tempRoot();
    const configPath = writeConfig(root, { agents: { defaults: { workspace: path.join(root, "workspace"), model: "test-model" } } });
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(fakeAgentLoop("ok") as any);
    process.env[RESTART_NOTIFY_CHANNEL_ENV] = "cli";
    process.env[RESTART_NOTIFY_CHAT_ID_ENV] = "direct";
    process.env[RESTART_STARTED_AT_ENV] = String(Date.now() / 1000);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.map(String).join(" "));
    });

    await agent({ message: "hello", config: configPath, sessionId: "cli:direct" });

    expect(logs.join("\n")).toContain("Restart completed");
    expect(process.env[RESTART_NOTIFY_CHANNEL_ENV]).toBeUndefined();
  });

  it("status reports config, workspace, model, and provider API states", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-status-"));
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");

    await onboard({ config: configPath, workspace });
    const output = status({ config: configPath });

    expect(output).toContain("memmy Status");
    expect(output).toContain("Config:");
    expect(output).toContain("Workspace:");
    expect(output).toContain("Model:");
    expect(output).toContain("OpenRouter API:");
    expect(output).toContain("Anthropic API:");
    expect(output).toContain("OpenAI API:");
  });

  it("matches GitHub Copilot Codex models before OpenAI Codex when the prefix is hyphenated", () => {
    const config = new Config({ agents: { defaults: { model: "github-copilot/gpt-5.3-codex" } } });

    expect(config.getProviderName()).toBe("github_copilot");
  });

  it("matches OpenAI Codex models when the provider prefix is hyphenated", () => {
    const config = new Config({ agents: { defaults: { model: "openai-codex/gpt-5.1-codex" } } });

    expect(config.getProviderName()).toBe("openai_codex");
  });

  it("excludes OAuth provider blocks from config dumps", () => {
    const providers = new Config().toObject().providers;

    expect(providers).not.toHaveProperty("openaiCodex");
    expect(providers).not.toHaveProperty("githubCopilot");
    expect(providers).not.toHaveProperty("openai_codex");
    expect(providers).not.toHaveProperty("github_copilot");
  });

  it("removes OAuth token and sibling lock files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-oauth-"));
    const tokenPath = path.join(root, "auth", "codex.json");
    const lockPath = path.join(root, "auth", "codex.lock");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "{}", "utf8");
    fs.writeFileSync(lockPath, "", "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const removed = deleteOauthFiles(tokenPath, "OpenAI Codex");

    expect(removed.sort()).toEqual([lockPath, tokenPath].sort());
    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(log).toHaveBeenCalledWith("Logged out from OpenAI Codex");
  });

  it("reports a successful OAuth logout when the token file is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-oauth-missing-"));
    const tokenPath = path.join(root, "auth", "codex.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(deleteOauthFiles(tokenPath, "OpenAI Codex")).toEqual([]);
    expect(log).toHaveBeenCalledWith("No local OAuth credentials found for OpenAI Codex");
  });

  it("rejects unknown OAuth providers for login and logout", async () => {
    expect(() => resolveOauthProvider("not-a-real-provider")).toThrow(/Unknown OAuth provider/);
    await expect(providerLogin("not-a-real-provider")).rejects.toThrow(/Unknown OAuth provider/);
    await expect(providerLogout("not-a-real-provider")).rejects.toThrow(/Unknown OAuth provider/);
  });

  it("resolves GitHub Copilot token storage under the auth directory", () => {
    process.env.MEMMY_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-data-"));

    const tokenPath = getStorage().getTokenPath();

    expect(path.basename(tokenPath)).toBe("github-copilot.json");
    expect(path.basename(path.dirname(tokenPath))).toBe("auth");
  });

  it("honors OAuth token path overrides for GitHub Copilot storage", () => {
    const tokenPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memmy-gh-oauth-")), "github-copilot.json");
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = tokenPath;

    expect(getStorage().getTokenPath()).toBe(tokenPath);
  });

  it("matches explicit Ollama provider names without an API key", () => {
    const config = Config.fromObject({ agents: { defaults: { provider: "ollama", model: "llama3.2" } } });

    expect(config.getProviderName()).toBe("ollama");
    expect(config.getApiBase()).toBe("http://localhost:11434/v1");
  });

  it("accepts camel-case explicit provider names for coding-plan providers", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "volcengineCodingPlan", model: "doubao-1-5-pro" } },
      providers: { volcengineCodingPlan: { apiKey: "test-key" } },
    });

    expect(config.getProviderName()).toBe("volcengine_coding_plan");
    expect(config.getApiBase()).toBe("https://ark.cn-beijing.volces.com/api/coding/v3");
  });

  it("accepts local providers without API keys and uses their localhost defaults", () => {
    const lmStudio = Config.fromObject({
      agents: { defaults: { provider: "lm_studio", model: "local-model" } },
      providers: { lmStudio: { apiKey: null } },
    });
    const atomicChat = Config.fromObject({
      agents: { defaults: { provider: "atomic_chat", model: "local-model" } },
      providers: { atomicChat: { apiKey: null } },
    });

    expect(lmStudio.getApiKey()).toBeNull();
    expect(lmStudio.getApiBase()).toBe("http://localhost:1234/v1");
    expect(atomicChat.getApiKey()).toBeNull();
    expect(atomicChat.getApiBase()).toBe("http://localhost:1337/v1");
  });

  it("finds providers by camel-case and hyphen aliases", () => {
    expect(findByName("volcengineCodingPlan")?.name).toBe("volcengine_coding_plan");
    expect(findByName("github-copilot")?.name).toBe("github_copilot");
    expect(findByName("longcat")?.name).toBe("longcat");
    expect(findByName("atomic-chat")?.name).toBe("atomic_chat");
  });

  it("resolves LongCat and Xiaomi MIMO explicit and inferred provider settings", () => {
    const explicitLongcat = Config.fromObject({
      agents: { defaults: { provider: "longcat", model: "LongCat-Flash-Chat" } },
      providers: { longcat: { apiKey: "test-key" } },
    });
    const inferredLongcat = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "longcat/LongCat-Flash-Chat" } },
      providers: { longcat: { apiKey: "test-key" } },
    });
    const explicitMimo = Config.fromObject({
      agents: { defaults: { provider: "xiaomi_mimo", model: "MiniMax-M1-80k" } },
      providers: { xiaomiMimo: { apiKey: "test-key" } },
    });
    const inferredMimo = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "mimo/MiniMax-M1-80k" } },
      providers: { xiaomiMimo: { apiKey: "test-key" } },
    });

    expect(explicitLongcat.getProviderName()).toBe("longcat");
    expect(explicitLongcat.getApiBase()).toBe("https://api.longcat.chat/openai/v1");
    expect(inferredLongcat.getProviderName()).toBe("longcat");
    expect(explicitMimo.getProviderName()).toBe("xiaomi_mimo");
    expect(explicitMimo.getApiBase()).toBe("https://api.xiaomimimo.com/v1");
    expect(inferredMimo.getProviderName()).toBe("xiaomi_mimo");
    expect(inferredMimo.getApiBase()).toBe("https://api.xiaomimimo.com/v1");
  });

  it("auto-detects local providers from configured API bases", () => {
    const ollama = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "llama3.2" } },
      providers: { ollama: { apiBase: "http://localhost:11434/v1" } },
    });
    const both = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "llama3.2" } },
      providers: {
        vllm: { apiBase: "http://localhost:8000" },
        ollama: { apiBase: "http://localhost:11434/v1" },
      },
    });
    const vllm = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "llama3.2" } },
      providers: { vllm: { apiBase: "http://localhost:8000" } },
    });

    expect(ollama.getProviderName()).toBe("ollama");
    expect(ollama.getApiBase()).toBe("http://localhost:11434/v1");
    expect(both.getProviderName()).toBe("ollama");
    expect(vllm.getProviderName()).toBe("vllm");
    expect(vllm.getApiBase()).toBe("http://localhost:8000");
  });

  it("keeps OpenAI-compatible default models unchanged", () => {
    const provider = new OpenAICompatProvider({ defaultModel: "github-copilot/gpt-5.3-codex" });

    expect(provider.getDefaultModel()).toBe("github-copilot/gpt-5.3-codex");
  });

  it("creates GitHub Copilot providers and strips prefixed model names for requests", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "github-copilot", model: "github-copilot/gpt-4.1" } },
    });
    const provider = makeProvider(config);
    const direct = new GitHubCopilotProvider({ defaultModel: "github-copilot/gpt-5.1" });

    expect(provider).toBeInstanceOf(GitHubCopilotProvider);
    expect(
      direct.buildKwargs({
        messages: [{ role: "user", content: "hi" }],
        model: "github-copilot/gpt-5.1",
        maxTokens: 16,
        temperature: 0.1,
      }).model,
    ).toBe("gpt-5.1");
  });

  it("refreshes the GitHub Copilot client API key before use", async () => {
    const provider = new GitHubCopilotProvider({ defaultModel: "github-copilot/gpt-4" });
    const client: any = { apiKey: "no-key" };
    const tokenSpy = vi.spyOn(provider, "getCopilotAccessToken").mockResolvedValue("copilot-access-token");
    (provider as any).ensureClient = vi.fn(async () => client);

    await provider.refreshClientApiKey();

    expect(provider.apiKey).toBe("copilot-access-token");
    expect(client.apiKey).toBe("copilot-access-token");
    expect(tokenSpy).toHaveBeenCalledOnce();
  });

  it("strips OpenAI Codex model prefixes with hyphens or underscores", () => {
    expect(stripCodexModelPrefix("openai-codex/gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(stripCodexModelPrefix("openai_codex/gpt-5.1-codex")).toBe("gpt-5.1-codex");
  });

  it("passes custom provider extra headers through to the OpenAI-compatible provider", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "custom", model: "gpt-4o-mini" } },
      providers: {
        custom: {
          apiKey: "test-key",
          apiBase: "https://example.com/v1",
          extraHeaders: {
            "APP-Code": "demo-app",
            "x-session-affinity": "sticky-session",
          },
        },
      },
    });

    const provider = makeProvider(config) as OpenAICompatProvider;

    expect(provider.apiKey).toBe("test-key");
    expect(provider.apiBase).toBe("https://example.com/v1");
    expect((provider as any).defaultHeaders["APP-Code"]).toBe("demo-app");
    expect((provider as any).defaultHeaders["x-session-affinity"]).toBe("sticky-session");
  });

  it("reports preset names in model display strings", () => {
    const config = Config.fromObject({
      agents: { defaults: { modelPreset: "fast" } },
      modelPresets: { fast: { model: "openai/gpt-4o-mini", provider: "openai" } },
    });

    expect(modelDisplay(config)).toEqual(["openai/gpt-4o-mini", " (preset: fast)"]);
  });

  it("warns about deprecated memoryWindow config keys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-deprecated-"));
    const configPath = path.join(root, "config.yaml");
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { memoryWindow: 42 } } }), "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(warnDeprecatedConfigKeys(configPath)).toEqual([
      "`memoryWindow` in your config is no longer used and can be safely removed.",
    ]);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockClear();
    loadRuntimeConfig(configPath);

    expect(warn).toHaveBeenCalledWith("`memoryWindow` in your config is no longer used and can be safely removed.");
  });
});

describe("CLI command parity with memmy test_commands", () => {
  it("onboard fresh install", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const config = await onboard({ config: configPath, workspace });

    expect(config.agents.defaults.workspace).toBe(workspace);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "memory", "MEMORY.md"))).toBe(false);
    expect(config.fileMemory.enabled).toBe(false);
    expect(log).toHaveBeenCalledWith("memmy is ready");
  });

  it("onboard preserves explicit file memory enablement", async () => {
    const root = tempRoot();
    const configPath = writeConfig(root, {
      fileMemory: { enabled: true },
    });
    const workspace = path.join(root, "workspace");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const config = await onboard({ config: configPath, workspace });
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(config.fileMemory.enabled).toBe(true);
    expect(raw.fileMemory.enabled).toBe(true);
    expect(fs.existsSync(path.join(workspace, "memory", "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(true);
  });

  it("onboard existing config refresh", async () => {
    const root = tempRoot();
    const configPath = writeConfig(root, { agents: { defaults: { model: "openai/test-model" } } });
    const workspace = path.join(root, "workspace");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const config = await onboard({ config: configPath, workspace });

    expect(config.agents.defaults.model).toBe("openai/test-model");
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(true);
  });

  it("onboard existing workspace safe create", async () => {
    const root = tempRoot();
    const configPath = writeConfig(root, {});
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "keep.txt"), "keep", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await onboard({ config: configPath, workspace });

    expect(fs.existsSync(path.join(workspace, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(true);
  });

  it("onboard uses explicit config and workspace paths", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "instance", "config.yaml");
    const workspace = path.join(root, "workspace");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const config = await onboard({ config: configPath, workspace });

    expect(config.agents.defaults.workspace).toBe(workspace);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(true);
    expect(log.mock.calls.flat().join("\n")).toContain(path.resolve(configPath));
  });

  it("config matches github copilot codex with hyphen prefix", () => {
    const config = new Config({ agents: { defaults: { model: "github-copilot/gpt-5.3-codex" } } });
    expect(config.getProviderName()).toBe("github_copilot");
  });

  it("config matches openai codex with hyphen prefix", () => {
    const config = new Config({ agents: { defaults: { model: "openai-codex/gpt-5.1-codex" } } });
    expect(config.getProviderName()).toBe("openai_codex");
  });

  it("config dump excludes oauth provider blocks", () => {
    const providers = new Config().toObject().providers;
    expect(providers).not.toHaveProperty("openaiCodex");
    expect(providers).not.toHaveProperty("githubCopilot");
  });

  it("provider logout openai codex removes local oauth files", async () => {
    const tokenPath = path.join(tempRoot(), "auth", "codex.json");
    const lockPath = path.join(path.dirname(tokenPath), "codex.lock");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "{}", "utf8");
    fs.writeFileSync(lockPath, "", "utf8");
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = tokenPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await providerLogout("openai-codex");

    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(log).toHaveBeenCalledWith("Logged out from OpenAI Codex");
  });

  it("provider logout openai codex succeeds when no local oauth file", async () => {
    const tokenPath = path.join(tempRoot(), "auth", "codex.json");
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = tokenPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await providerLogout("openai-codex");

    expect(log).toHaveBeenCalledWith("No local OAuth credentials found for OpenAI Codex");
  });

  it("provider logout github copilot removes local oauth files", async () => {
    const tokenPath = path.join(tempRoot(), "auth", "github-copilot.json");
    const lockPath = path.join(path.dirname(tokenPath), "github-copilot.lock");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "{}", "utf8");
    fs.writeFileSync(lockPath, "", "utf8");
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = tokenPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await providerLogout("github-copilot");

    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(log).toHaveBeenCalledWith("Logged out from GitHub Copilot");
  });

  it("provider logout github copilot succeeds when no local oauth file", async () => {
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = path.join(tempRoot(), "auth", "github-copilot.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await providerLogout("github-copilot");

    expect(log).toHaveBeenCalledWith("No local OAuth credentials found for GitHub Copilot");
  });

  it("provider logout rejects unknown provider", async () => {
    await expect(providerLogout("not-a-real-provider")).rejects.toThrow(/Unknown OAuth provider/);
  });

  it("provider logout paths resolve to expected files", () => {
    process.env.MEMMY_AGENT_DATA_DIR = tempRoot();
    expect(path.basename(path.join(process.env.MEMMY_AGENT_DATA_DIR, "auth", "codex.json"))).toBe("codex.json");
    const ghPath = getStorage().getTokenPath();
    expect(path.basename(ghPath)).toBe("github-copilot.json");
    expect(path.basename(path.dirname(ghPath))).toBe("auth");
  });

  it("provider login openai codex saves env OAuth token", async () => {
    const tokenPath = path.join(tempRoot(), "auth", "codex.json");
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = tokenPath;
    process.env.OPENAI_CODEX_ACCOUNT_ID = "acct-test";
    process.env.OPENAI_CODEX_ACCESS_TOKEN = "access-test";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await providerLogin("openai-codex");

    expect(JSON.parse(fs.readFileSync(tokenPath, "utf8"))).toEqual({
      accountId: "acct-test",
      access: "access-test",
    });
    expect(log).toHaveBeenCalledWith("Authenticated with OpenAI Codex: acct-test");
  });

  it("provider login rejects unknown provider", async () => {
    await expect(providerLogin("not-a-real-provider")).rejects.toThrow(/Unknown OAuth provider/);
  });

  it("config explicit ollama provider uses default localhost api base", () => {
    const config = Config.fromObject({ agents: { defaults: { provider: "ollama", model: "llama3.2" } } });
    expect(config.getProviderName()).toBe("ollama");
    expect(config.getApiBase()).toBe("http://localhost:11434/v1");
  });

  it("config accepts lm studio without api key and uses default localhost api base", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "lm_studio", model: "local-model" } },
      providers: { lmStudio: { apiKey: null } },
    });
    expect(config.getProviderName()).toBe("lm_studio");
    expect(config.getApiKey()).toBeNull();
    expect(config.getApiBase()).toBe("http://localhost:1234/v1");
  });

  it("config accepts atomic chat without api key and uses default localhost api base", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "atomic_chat", model: "local-model" } },
      providers: { atomicChat: { apiKey: null } },
    });
    expect(config.getProviderName()).toBe("atomic_chat");
    expect(config.getApiKey()).toBeNull();
    expect(config.getApiBase()).toBe("http://localhost:1337/v1");
  });

  it("findByName accepts camelCase and hyphen aliases", () => {
    expect(findByName("volcengineCodingPlan")?.name).toBe("volcengine_coding_plan");
    expect(findByName("github-copilot")?.name).toBe("github_copilot");
    expect(findByName("longcat")?.name).toBe("longcat");
    expect(findByName("atomic-chat")?.name).toBe("atomic_chat");
  });

  it("config explicit longcat provider resolves provider name", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "longcat", model: "LongCat-Flash-Chat" } },
      providers: { longcat: { apiKey: "test-key" } },
    });
    expect(config.getProviderName()).toBe("longcat");
    expect(config.getApiBase()).toBe("https://api.longcat.chat/openai/v1");
  });

  it("config auto detects longcat from model keyword", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "longcat/LongCat-Flash-Chat" } },
      providers: { longcat: { apiKey: "test-key" } },
    });
    expect(config.getProviderName()).toBe("longcat");
  });

  it("config explicit xiaomi mimo provider uses defaultApiBase", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "xiaomi_mimo", model: "MiniMax-M1-80k" } },
      providers: { xiaomiMimo: { apiKey: "test-key" } },
    });
    expect(config.getProviderName()).toBe("xiaomi_mimo");
    expect(config.getApiBase()).toBe("https://api.xiaomimimo.com/v1");
  });

  it("config auto detects xiaomi mimo from model keyword", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "mimo/MiniMax-M1-80k" } },
      providers: { xiaomiMimo: { apiKey: "test-key" } },
    });
    expect(config.getProviderName()).toBe("xiaomi_mimo");
    expect(config.getApiBase()).toBe("https://api.xiaomimimo.com/v1");
  });

  it("config auto detects ollama from local api base", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "llama3.2" } },
      providers: { ollama: { apiBase: "http://localhost:11434/v1" } },
    });
    expect(config.getProviderName()).toBe("ollama");
    expect(config.getApiBase()).toBe("http://localhost:11434/v1");
  });

  it("config prefers ollama over vllm when both local providers configured", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "llama3.2" } },
      providers: {
        vllm: { apiBase: "http://localhost:8000" },
        ollama: { apiBase: "http://localhost:11434/v1" },
      },
    });
    expect(config.getProviderName()).toBe("ollama");
    expect(config.getApiBase()).toBe("http://localhost:11434/v1");
  });

  it("config falls back to vllm when ollama not configured", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "auto", model: "llama3.2" } },
      providers: { vllm: { apiBase: "http://localhost:8000" } },
    });
    expect(config.getProviderName()).toBe("vllm");
    expect(config.getApiBase()).toBe("http://localhost:8000");
  });

  it("openai compat provider passes model through", () => {
    const provider = new OpenAICompatProvider({ defaultModel: "github-copilot/gpt-5.3-codex" });
    expect(provider.getDefaultModel()).toBe("github-copilot/gpt-5.3-codex");
  });

  it("makeProvider uses github copilot backend", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "github-copilot", model: "github-copilot/gpt-4.1" } },
    });
    expect(makeProvider(config)).toBeInstanceOf(GitHubCopilotProvider);
  });

  it("github copilot provider strips prefixed model name", () => {
    const provider = new GitHubCopilotProvider({ defaultModel: "github-copilot/gpt-5.1" });
    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      model: "github-copilot/gpt-5.1",
      maxTokens: 16,
      temperature: 0.1,
    });
    expect(kwargs.model).toBe("gpt-5.1");
  });

  it("github copilot provider refreshes client api key before chat", async () => {
    const provider = new GitHubCopilotProvider({ defaultModel: "github-copilot/gpt-4" });
    const client: any = { apiKey: "no-key" };
    vi.spyOn(provider, "getCopilotAccessToken").mockResolvedValue("copilot-access-token");
    (provider as any).ensureClient = vi.fn(async () => client);

    await provider.refreshClientApiKey();

    expect(provider.apiKey).toBe("copilot-access-token");
    expect(client.apiKey).toBe("copilot-access-token");
  });

  it("openai codex strip prefix supports hyphen and underscore", () => {
    expect(stripCodexModelPrefix("openai-codex/gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(stripCodexModelPrefix("openai_codex/gpt-5.1-codex")).toBe("gpt-5.1-codex");
  });

  it("makeProvider passes extra headers to custom provider", () => {
    const config = Config.fromObject({
      agents: { defaults: { provider: "custom", model: "gpt-4o-mini" } },
      providers: {
        custom: {
          apiKey: "test-key",
          apiBase: "https://example.com/v1",
          extraHeaders: { "APP-Code": "demo-app", "x-session-affinity": "sticky-session" },
        },
      },
    });
    const provider = makeProvider(config) as OpenAICompatProvider;
    expect((provider as any).defaultHeaders["APP-Code"]).toBe("demo-app");
    expect((provider as any).defaultHeaders["x-session-affinity"]).toBe("sticky-session");
  });

  it("agent workspace override does not migrate legacy cron", async () => {
    const root = tempRoot();
    const configPath = writeConfig(root, {});
    const legacyDir = path.join(root, "global", "cron");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "jobs.json"), "[]", "utf8");
    process.env.MEMMY_AGENT_DATA_DIR = path.join(root, "global");
    const override = path.join(root, "override-workspace");
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(fakeAgentLoop() as any);

    await agent({ message: "hello", config: configPath, workspace: override });

    expect(fs.existsSync(path.join(legacyDir, "jobs.json"))).toBe(true);
    expect(fs.existsSync(path.join(override, "cron", "jobs.json"))).toBe(false);
  });

  it("agent custom config workspace does not migrate legacy cron", async () => {
    const root = tempRoot();
    const customWorkspace = path.join(root, "custom-workspace");
    const configPath = writeConfig(root, { agents: { defaults: { workspace: customWorkspace } } });
    const legacyDir = path.join(root, "global", "cron");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "jobs.json"), "[]", "utf8");
    process.env.MEMMY_AGENT_DATA_DIR = path.join(root, "global");
    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(fakeAgentLoop() as any);

    await agent({ message: "hello", config: configPath });

    expect(fs.existsSync(path.join(legacyDir, "jobs.json"))).toBe(true);
    expect(fs.existsSync(path.join(customWorkspace, "cron", "jobs.json"))).toBe(false);
  });
});
