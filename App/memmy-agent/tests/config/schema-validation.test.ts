import { describe, expect, it } from "vitest";
import { WebSocketConfig } from "../../src/integrations/channels/websocket.js";
import {
  AgentDefaults,
  ApiConfig,
  Config,
  ContextCompactionConfig,
  GatewayConfig,
  InlineFallbackConfig,
  MCPServerConfig,
  ModelPresetConfig,
  SessionDagConfig,
} from "../../src/config/schema.js";

describe("config schema validation", () => {
  it("validates AgentDefaults numeric bounds and enums", () => {
    expect(new AgentDefaults().temperature).toBe(0.7);
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
    expect(() => new ModelPresetConfig({ provider: "openai" })).toThrow(/modelPreset model/);
    expect(() => new ModelPresetConfig({ model: "" })).toThrow(/modelPreset model/);
    expect(() => new InlineFallbackConfig({ provider: "openai" })).toThrow(/fallback model/);
    expect(() => new InlineFallbackConfig({ model: "gpt-4.1" })).toThrow(/fallback provider/);
    expect(() => new InlineFallbackConfig({ provider: "", model: "gpt-4.1" })).toThrow(/fallback provider/);

    expect(new ModelPresetConfig({ model: "gpt-4.1" }).model).toBe("gpt-4.1");
    expect(new ModelPresetConfig({ model: "gpt-4.1" }).temperature).toBe(0.7);
    expect(new InlineFallbackConfig({ provider: "openai", model: "gpt-4.1" }).provider).toBe("openai");
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
      retryBackoffMs: [1000, 5000, 30000, 60000, 90000],
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

    expect(() => new ContextCompactionConfig({ summaryMode: "xml" })).toThrow(/contextCompaction\.summaryMode/);
    expect(() => new SessionDagConfig({ enabled: "true" })).toThrow(/sessionDag\.enabled/);
    expect(() => new SessionDagConfig({ debugLog: "true" })).toThrow(/sessionDag\.debugLog/);
    expect(() => new Config({
      sessionDag: { enabled: false },
    })).toThrow(/requires sessionDag\.enabled=true/);
    expect(() => new SessionDagConfig({ maxBuilderContextNodes: 0 })).toThrow(/maxBuilderContextNodes/);
    expect(() => new SessionDagConfig({ maxUpdateAttempts: 21 })).toThrow(/maxUpdateAttempts/);
    expect(() => new SessionDagConfig({ retryBackoffMs: [] })).toThrow(/retryBackoffMs/);
    expect(() => new SessionDagConfig({ retryBackoffMs: [999] })).toThrow(/retryBackoffMs/);
    expect(() => new SessionDagConfig({ maxConcurrentSessionQueues: 17 })).toThrow(/maxConcurrentSessionQueues/);
    expect(() => new SessionDagConfig({ compactionCatchupTimeoutMs: 999 })).toThrow(/compactionCatchupTimeoutMs/);
    expect(() => new Config({
      sessionDag: { enabled: false },
      contextCompaction: { summaryMode: "dag" },
    })).toThrow(/requires sessionDag\.enabled=true/);
  });

});
