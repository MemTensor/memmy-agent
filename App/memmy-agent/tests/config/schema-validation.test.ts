import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigLoadError, loadConfig, saveConfig } from "../../src/config/loader.js";
import { WebSocketConfig } from "../../src/integrations/channels/websocket.js";
import { DEFAULT_MAX_TOKENS } from "../../src/token-budget.js";
import { systemUtcOffset } from "../../src/utils/time-zone.js";
import {
  AgentDefaults,
  ApiConfig,
  BrowserToolsConfig,
  Config,
  ContextCompactionConfig,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  GatewayConfig,
  InlineFallbackConfig,
  MCPServerConfig,
  ModelPresetConfig,
  SessionDagConfig,
} from "../../src/config/schema.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function configFile(contents = ""): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-schema-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

describe("config schema validation", () => {
  it("serializes only providers with explicit connection settings", () => {
    const emptyProviders = new Config().toObject().providers;
    expect(emptyProviders).toEqual({});

    const providers = new Config({
      providers: {
        openai: { endpoints: { chat: { apiBase: "https://openai.example.test/v1", protocol: "openai-responses" } } },
        anthropic: { apiKey: "anthropic-key" },
        gemini: { endpoints: { chat: { apiBase: "https://gemini.example.test", protocol: "gemini-generate-content" } } },
        deepseek: { extraHeaders: { "X-Test": "header" } },
        zhipu: { extraBody: { trace: true } },
        bedrock: { region: "us-east-1" },
      },
    }).toObject().providers;

    expect(new Set(Object.keys(providers))).toEqual(new Set([
      "bedrock",
      "openai",
      "anthropic",
      "gemini",
      "deepseek",
      "zhipu",
    ]));
    expect(providers).not.toHaveProperty("qwen");
  });

  it("round-trips current Provider endpoint blocks through the shared writer", () => {
    const file = configFile(YAML.stringify({
      providers: {
        openai: {
          apiKey: "openai-key",
          endpoints: {
            chat: {
              apiBase: "https://openai.example.test/v1",
              protocol: "openai-chat-completions",
            },
          },
        },
      },
      channels: {
        sendProgress: false,
      },
    }));
    const config = loadConfig(file);

    saveConfig(config, file);

    const saved = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(saved.providers).toEqual({
      openai: expect.objectContaining({
        apiKey: "openai-key",
        endpoints: {
          chat: {
            apiBase: "https://openai.example.test/v1",
            protocol: "openai-chat-completions",
          },
        },
      }),
    });
    expect(saved.channels.sendProgress).toBe(false);
  });

  it("defines and round-trips browser tool defaults", () => {
    const defaults = new BrowserToolsConfig();
    expect(defaults.toObject()).toEqual({
      enabled: true,
      maxSessions: 4,
      idleTimeoutS: 900,
    });
    const configured = new Config({
      tools: {
        browser: {
          enabled: false,
          maxSessions: 8,
          idleTimeoutS: 3600,
        },
      },
    });
    expect(configured.tools.browser.toObject()).toEqual({
      enabled: false,
      maxSessions: 8,
      idleTimeoutS: 3600,
    });
    expect(configured.toObject().tools.browser).toEqual(
      configured.tools.browser.toObject(),
    );
  });

  it.each([
    [null, /tools\.browser must be an object/],
    [[], /tools\.browser must be an object/],
    [{ enabled: "true" }, /tools\.browser\.enabled/],
    [{ maxSessions: 0 }, /tools\.browser\.maxSessions/],
    [{ maxSessions: 9 }, /tools\.browser\.maxSessions/],
    [{ idleTimeoutS: 59 }, /tools\.browser\.idleTimeoutS/],
    [{ idleTimeoutS: 3601 }, /tools\.browser\.idleTimeoutS/],
  ])("rejects invalid browser tool config %#", (browser, error) => {
    expect(() => new Config({ tools: { browser } } as any)).toThrow(error);
  });

  it("defaults file memory off and preserves explicit booleans", () => {
    const defaults = new Config();
    const enabled = new Config({ fileMemory: { enabled: true } });
    const disabled = new Config({ fileMemory: { enabled: false } });

    expect(defaults.fileMemory.enabled).toBe(false);
    expect(new Config({ fileMemory: {} }).fileMemory.enabled).toBe(false);
    expect(enabled.fileMemory.enabled).toBe(true);
    expect(disabled.fileMemory.enabled).toBe(false);
    expect(defaults.toObject().fileMemory).toEqual({ enabled: false });
    expect(enabled.toObject().fileMemory).toEqual({ enabled: true });
  });

  it.each([
    [{ fileMemory: null }, /fileMemory must be an object/],
    [{ fileMemory: [] }, /fileMemory must be an object/],
    [{ fileMemory: "false" }, /fileMemory must be an object/],
    [{ fileMemory: 0 }, /fileMemory must be an object/],
    [{ fileMemory: { enabled: "false" } }, /fileMemory\.enabled/],
    [{ fileMemory: { enabled: 0 } }, /fileMemory\.enabled/],
    [{ fileMemory: { enabled: null } }, /fileMemory\.enabled/],
  ])("rejects invalid file memory config %#", (input, error) => {
    expect(() => new Config(input as any)).toThrow(error);
  });

  it("does not accept aliases or couple file memory to memmy memory", () => {
    expect(new Config({ fileMemory: { enable: true } }).fileMemory.enabled).toBe(false);
    expect(
      new Config({
        agents: { defaults: { fileMemory: { enabled: true } } },
      } as any).fileMemory.enabled,
    ).toBe(false);

    for (const fileMemoryEnabled of [false, true]) {
      for (const memmyMemoryEnabled of [false, true]) {
        const config = new Config({
          fileMemory: { enabled: fileMemoryEnabled },
          memmyMemory: { enabled: memmyMemoryEnabled },
        });
        expect(config.fileMemory.enabled).toBe(fileMemoryEnabled);
        expect(config.memmyMemory.enabled).toBe(memmyMemoryEnabled);
      }
    }
  });

  it("round-trips explicit file memory booleans through config files", () => {
    for (const enabled of [false, true]) {
      const file = configFile();
      saveConfig(new Config({ fileMemory: { enabled } }), file);
      expect(loadConfig(file).fileMemory.enabled).toBe(enabled);
    }
  });

  it.each([
    "fileMemory: null\n",
    "fileMemory: []\n",
    "fileMemory: false\n",
    "fileMemory:\n  enabled: \"false\"\n",
    "fileMemory:\n  enabled: 0\n",
    "fileMemory:\n  enabled: null\n",
  ])("rejects invalid file memory YAML without rewriting it", (contents) => {
    const file = configFile(contents);

    expect(() => loadConfig(file)).toThrow(/fileMemory/);
    expect(fs.readFileSync(file, "utf8")).toBe(contents);
  });

  it("fails loudly for invalid unrelated sections without rewriting the config", () => {
    const contents = "sessionDag:\n  debugLog: \"true\"\n";
    const file = configFile(contents);

    expect(() => loadConfig(file)).toThrow(ConfigLoadError);
    expect(() => loadConfig(file)).toThrow(/sessionDag\.debugLog/);
    expect(fs.readFileSync(file, "utf8")).toBe(contents);
  });

  it("validates AgentDefaults numeric bounds and enums", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(65_536);
    expect(new AgentDefaults().maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(new AgentDefaults().temperature).toBe(0.7);
    expect(new AgentDefaults().timezone).toBe(systemUtcOffset());
    expect(new AgentDefaults({ timezone: "Asia/Shanghai" }).timezone).toBe("+08:00");
    expect(() => new AgentDefaults({ maxConcurrentSubagents: 0 })).toThrow(/maxConcurrentSubagents/);
    expect(() => new AgentDefaults({ providerRetryMode: "forever" })).toThrow(/providerRetryMode/);
    expect(() => new AgentDefaults({ toolHintMaxLength: 19 })).toThrow(/toolHintMaxLength/);
    expect(() => new AgentDefaults({ toolHintMaxLength: 501 })).toThrow(/toolHintMaxLength/);
    expect(() => new AgentDefaults({ sessionTtlMinutes: -1 })).toThrow(/sessionTtlMinutes/);
    expect(() => new AgentDefaults({ idleCompactAfterMinutes: -1 })).toThrow(/sessionTtlMinutes/);
    expect(() => new AgentDefaults({ maxMessages: -1 })).toThrow(/maxMessages/);
    expect(() => new AgentDefaults({ consolidationRatio: 0.05 })).toThrow(/consolidationRatio/);
    expect(() => new AgentDefaults({ consolidationRatio: 1 })).toThrow(/consolidationRatio/);

    const defaults = new AgentDefaults({
      maxConcurrentSubagents: 1,
      providerRetryMode: "persistent",
      toolHintMaxLength: 20,
      sessionTtlMinutes: 0,
      maxMessages: 0,
      consolidationRatio: 0.95,
    });

    expect(defaults.maxConcurrentSubagents).toBe(1);
    expect(defaults.providerRetryMode).toBe("persistent");
    expect(defaults.toolHintMaxLength).toBe(20);
    expect(defaults.sessionTtlMinutes).toBe(0);
    expect(defaults.maxMessages).toBe(0);
    expect(defaults.consolidationRatio).toBe(0.95);
  });

  it("requires model names in presets and inline fallback entries", () => {
    const base = { endpoint: "chat", provider: "openai", source: "byok", capabilities: ["agent"] };
    expect(() => new ModelPresetConfig({ ...base })).toThrow(/modelPreset model/);
    expect(() => new ModelPresetConfig({ ...base, model: "" })).toThrow(/modelPreset model/);
    expect(() => new InlineFallbackConfig({ provider: "openai" })).toThrow(/fallback model/);
    expect(() => new InlineFallbackConfig({ model: "gpt-4.1" })).toThrow(/fallback provider/);
    expect(() => new InlineFallbackConfig({ provider: "", model: "gpt-4.1" })).toThrow(/fallback provider/);

    expect(new ModelPresetConfig({ ...base, model: "gpt-4.1" }).model).toBe("gpt-4.1");
    expect(new ModelPresetConfig({ ...base, model: "gpt-4.1" }).maxTokens).toBe(32_768);
    expect(new ModelPresetConfig({ ...base, model: "gpt-4.1" }).temperature).toBe(0.7);
    expect(new InlineFallbackConfig({ provider: "openai", model: "gpt-4.1" }).provider).toBe("openai");
  });

  it("resolves model token defaults only for BYOK text-generation presets", () => {
    const preset = (overrides: Record<string, unknown> = {}) => new ModelPresetConfig({
      endpoint: "chat",
      model: "gpt-5.6",
      provider: "openai",
      source: "byok",
      capabilities: ["agent"],
      ...overrides,
    });

    const defaults = new AgentDefaults();
    expect(defaults.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(defaults.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(preset()).toMatchObject({ maxTokens: 128_000, contextWindowTokens: 1_050_000 });
    expect(preset({ provider: "custom-openai" })).toMatchObject({
      maxTokens: 128_000,
      contextWindowTokens: 1_050_000,
    });
    expect(preset({ model: "private-model" })).toMatchObject({
      maxTokens: DEFAULT_MAX_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
    expect(preset({ source: "account", ownerAccountId: "account-1" })).toMatchObject({
      maxTokens: DEFAULT_MAX_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    });

    for (const capability of ["embedding", "asr", "image_generation"]) {
      expect(preset({ capabilities: [capability] })).toMatchObject({
        maxTokens: DEFAULT_MAX_TOKENS,
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      });
    }
    for (const capability of ["agent", "memory_summary", "memory_evolution"]) {
      expect(preset({ capabilities: [capability] })).toMatchObject({
        maxTokens: 128_000,
        contextWindowTokens: 1_050_000,
      });
    }

    expect(preset({ maxTokens: 12_345 })).toMatchObject({
      maxTokens: 12_345,
      contextWindowTokens: 1_050_000,
    });
    expect(preset({ contextWindowTokens: 345_678 })).toMatchObject({
      maxTokens: 128_000,
      contextWindowTokens: 345_678,
    });
    expect(preset({ maxTokens: 12_345, contextWindowTokens: 345_678 })).toMatchObject({
      maxTokens: 12_345,
      contextWindowTokens: 345_678,
    });

    for (const model of ["Gpt-5.6", " gpt-5.6 ", "gpt-5.6-unknown-snapshot"]) {
      expect(preset({ model })).toMatchObject({
        maxTokens: DEFAULT_MAX_TOKENS,
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      });
    }

    const config = new Config();
    config.agents.defaults.model = "gpt-5.6";
    expect(config.resolvePreset("default")).toMatchObject({
      maxTokens: DEFAULT_MAX_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
  });

  it("declares MCP server fields with camelCase defaults while preserving extensions", () => {
    const defaults = new MCPServerConfig();

    expect(defaults.command).toBe("");
    expect(defaults.args).toEqual([]);
    expect(defaults.env).toEqual({});
    expect(defaults.cwd).toBe("");
    expect(defaults.url).toBe("");
    expect(defaults.headers).toEqual({});
    expect(defaults.toolTimeout).toBe(30);
    expect(defaults.enabledTools).toEqual(["*"]);

    const configured = new MCPServerConfig({
      type: "stdio",
      command: "npx",
      args: ["-y", "@example/server"],
      env: { TOKEN: "secret" },
      cwd: "/tmp/workspace",
      headers: { Authorization: "Bearer token" },
      toolTimeout: 45,
      enabledTools: ["search"],
      extensionField: "kept",
    });

    expect(configured.type).toBe("stdio");
    expect(configured.command).toBe("npx");
    expect(configured.args).toEqual(["-y", "@example/server"]);
    expect(configured.env).toEqual({ TOKEN: "secret" });
    expect(configured.cwd).toBe("/tmp/workspace");
    expect(configured.headers).toEqual({ Authorization: "Bearer token" });
    expect(configured.toolTimeout).toBe(45);
    expect(configured.enabledTools).toEqual(["search"]);
    expect((configured as any).extensionField).toBe("kept");
  });

  it("keeps memmy-agent local service defaults distinct", () => {
    const api = new ApiConfig();
    const websocket = new WebSocketConfig();
    const gateway = new GatewayConfig();

    expect(api.port).toBe(18990);
    expect(websocket.port).toBe(18980);
    expect(gateway.port).toBe(18970);
    expect(new Set([api.port, websocket.port, gateway.port]).size).toBe(3);
  });

  it("validates session DAG and context compaction config", () => {
    const defaults = new Config();

    expect(defaults.sessionDag.toObject()).toEqual({
      enabled: true,
      debugLog: true,
      maxBuilderContextNodes: 40,
      maxUpdateAttempts: 5,
      retryBackoffMs: [0, 3000, 5000, 10000],
      maxConcurrentSessionQueues: 4,
      compactionCatchupTimeoutMs: 120000,
    });
    expect(defaults.contextCompaction.toObject()).toEqual({ summaryMode: "dag" });
    expect(defaults.toObject()).toMatchObject({
      sessionDag: defaults.sessionDag.toObject(),
      contextCompaction: { summaryMode: "dag" },
    });

    expect(new ContextCompactionConfig({ summaryMode: "dag" }).summaryMode).toBe("dag");
    expect(new ContextCompactionConfig({ summaryMode: "text" }).summaryMode).toBe("text");
    expect(new SessionDagConfig({ enabled: false }).enabled).toBe(false);
    expect(new SessionDagConfig({ debugLog: false }).debugLog).toBe(false);
    expect(new SessionDagConfig({ debugLog: true }).debugLog).toBe(true);
    expect(new SessionDagConfig({ debugLog: true }).toObject()).toMatchObject({ debugLog: true });
    expect(new SessionDagConfig({ retryBackoffMs: [0, 3000, 5000, 10000] }).toObject()).toMatchObject({
      retryBackoffMs: [0, 3000, 5000, 10000],
    });

    expect(() => new ContextCompactionConfig({ summaryMode: "xml" })).toThrow(/contextCompaction\.summaryMode/);
    expect(() => new SessionDagConfig({ enabled: "true" })).toThrow(/sessionDag\.enabled/);
    expect(() => new SessionDagConfig({ debugLog: "true" })).toThrow(/sessionDag\.debugLog/);
    expect(() => new Config({
      sessionDag: { enabled: false },
    })).toThrow(/requires sessionDag\.enabled=true/);
    expect(() => new SessionDagConfig({ maxBuilderContextNodes: 0 })).toThrow(/maxBuilderContextNodes/);
    expect(() => new SessionDagConfig({ maxUpdateAttempts: 21 })).toThrow(/maxUpdateAttempts/);
    expect(() => new SessionDagConfig({ retryBackoffMs: [] })).toThrow(/retryBackoffMs/);
    expect(() => new SessionDagConfig({ retryBackoffMs: [-1] })).toThrow(/retryBackoffMs/);
    expect(() => new SessionDagConfig({ retryBackoffMs: [1.5] })).toThrow(/retryBackoffMs/);
    expect(() => new SessionDagConfig({ retryBackoffMs: [600_001] })).toThrow(/retryBackoffMs/);
    expect(() => new SessionDagConfig({ maxConcurrentSessionQueues: 17 })).toThrow(/maxConcurrentSessionQueues/);
    expect(() => new SessionDagConfig({ compactionCatchupTimeoutMs: 999 })).toThrow(/compactionCatchupTimeoutMs/);
    expect(() => new Config({
      sessionDag: { enabled: false },
      contextCompaction: { summaryMode: "dag" },
    })).toThrow(/requires sessionDag\.enabled=true/);
  });

});
