/** Current runtime config boundary tests. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemmyConfigWriter,
  mapModelProtocol,
  patchChannelConfigInMemmyConfig,
  patchMcpServerConfigInMemmyConfig,
  readAgentGatewayBootstrapSecret,
  readConfiguredAgentTimeZone,
  readRuntimeMemmyConfigState,
  resolveDefaultMemmyConfigPath,
  writeAppCloudUuidToMemmyConfig
} from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function file(initial?: Record<string, unknown> | string): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "memmy-config-current-"));
  const target = join(tempDir, "config.yaml");
  if (initial !== undefined) writeFileSync(target, typeof initial === "string" ? initial : YAML.stringify(initial), "utf8");
  return target;
}

describe("memmy runtime config current contract", () => {
  it("resolves the default file path", () => {
    expect(resolveDefaultMemmyConfigPath("C:/Users/tester")).toBe(join("C:/Users/tester", ".memmy", "config.yaml"));
  });

  it("reads current timezone and websocket bootstrap secrets", async () => {
    const target = file({
      agents: { defaults: { timezone: "+08:00" } },
      channels: { websocket: { tokenIssueSecret: "gateway-secret", token: "fallback" } }
    });
    await expect(readConfiguredAgentTimeZone(target)).resolves.toBe("+08:00");
    await expect(readAgentGatewayBootstrapSecret(target)).resolves.toBe("gateway-secret");
  });

  it("falls back to websocket token and returns null for absent config", async () => {
    await expect(readAgentGatewayBootstrapSecret(file({ channels: { websocket: { token: "fallback" } } })))
      .resolves.toBe("fallback");
    await expect(readAgentGatewayBootstrapSecret(file({ channels: { websocket: { enabled: true } } })))
      .resolves.toBeNull();
    await expect(readAgentGatewayBootstrapSecret(join(tempDir!, "missing.yaml"))).resolves.toBeNull();
  });

  it("rejects invalid configured timezone without changing the file", async () => {
    const target = file({ agents: { defaults: { timezone: "Mars/Base" } } });
    await expect(readConfiguredAgentTimeZone(target)).rejects.toThrow(/invalid agents.defaults.timezone/);
  });

  it("reports missing, empty, and invalid YAML distinctly", async () => {
    await expect(readRuntimeMemmyConfigState(file())).resolves.toMatchObject({ status: "missing" });
    await expect(readRuntimeMemmyConfigState(file(""))).resolves.toMatchObject({ status: "empty" });
    await expect(readRuntimeMemmyConfigState(file("agents: ["))).resolves.toMatchObject({ status: "invalid_yaml" });
  });

  it("derives the canonical BYOK context and exact Provider endpoint snapshot", async () => {
    const target = file(currentByokCatalog());
    await expect(readRuntimeMemmyConfigState(target)).resolves.toMatchObject({
      status: "valid_byok",
      context: {
        presetId: "agent",
        provider: "openai",
        endpointId: "chat",
        protocol: "openai-chat-completions",
        model: "gpt-5",
        source: "byok",
        ownerAccountId: null,
        capability: "agent"
      },
      provider: {
        provider: "openai",
        endpointId: "chat",
        apiBase: "https://api.example.test/v1",
        apiKey: "sk-main"
      }
    });
  });

  it("does not infer a legacy Provider-level URL as current catalog", async () => {
    const target = file({
      agents: { defaults: { modelPreset: "legacy" } },
      providers: { openai: { apiBase: "https://legacy.example.test/v1", apiKey: "secret" } },
      modelPresets: { legacy: { provider: "openai", model: "gpt-old" } }
    });
    await expect(readRuntimeMemmyConfigState(target)).resolves.toMatchObject({ status: "no_model_config" });
  });

  it("derives account mode only from an owner-bound account assignment", async () => {
    const target = file(currentAccountCatalog());
    await expect(readRuntimeMemmyConfigState(target)).resolves.toEqual({
      status: "valid_account",
      configPath: target,
      cloudUuid: "cloud-token",
      userId: "owner-a"
    });
  });

  it("reports an incomplete owner-bound account projection as unavailable", async () => {
    const current = currentAccountCatalog() as any;
    delete current.providers.memmy_account.endpoints.platform;
    await expect(readRuntimeMemmyConfigState(file(current))).resolves.toMatchObject({ status: "no_model_config" });
  });

  it("updates login fields without dropping unrelated app/root fields", async () => {
    const target = file({
      uuid: "legacy-root",
      identity: { userId: "legacy" },
      app: { cloudUuid: "old", locale: "zh-CN", futureAppField: { keep: true } },
      futureSection: { keepMe: true }
    });
    await writeAppCloudUuidToMemmyConfig("cloud-token", target);
    const state = await readRuntimeMemmyConfigState(target);
    expect(state).toMatchObject({ status: "valid_account", cloudUuid: "cloud-token" });
    const saved = YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(target, "utf8")));
    expect(saved).not.toHaveProperty("uuid");
    expect(saved).not.toHaveProperty("identity");
    expect(saved.app).toMatchObject({ cloudUuid: "cloud-token", locale: "zh-CN", futureAppField: { keep: true } });
    expect(saved.futureSection.keepMe).toBe(true);
  });

  it("patches channels and MCP servers concurrently without losing unrelated fields", async () => {
    const target = file({
      futureSection: { keepMe: true },
      channels: { websocket: { token: "keep-token" } },
      tools: { mcpServers: { existing: { type: "stdio", command: "existing", futureServerField: "keep" } } }
    });
    await Promise.all([
      patchChannelConfigInMemmyConfig("feishu", { enabled: true, appId: "app" }, target),
      patchMcpServerConfigInMemmyConfig("composio", { type: "streamableHttp", url: "http://127.0.0.1:9000" }, target)
    ]);
    const saved = YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(target, "utf8")));
    expect(saved.futureSection.keepMe).toBe(true);
    expect(saved.channels.websocket.token).toBe("keep-token");
    expect(saved.channels.feishu).toEqual({ enabled: true, appId: "app" });
    expect(saved.tools.mcpServers.existing.futureServerField).toBe("keep");
    expect(saved.tools.mcpServers.composio.url).toBe("http://127.0.0.1:9000");
  });

  it("exposes the same shared writers through createMemmyConfigWriter", async () => {
    const target = file({
      futureSection: { keepMe: true },
      app: { futureAppField: { keep: true } },
      providers: { future: { futureProviderField: { keep: true } } }
    });
    const writer = createMemmyConfigWriter({ configPath: target });
    await writer.writeUserMode?.("byok");
    await writer.patchChannelConfig("weixin", { enabled: true });
    await writer.patchMcpServerConfig("demo", { type: "stdio", command: "demo" });
    const saved = YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(target, "utf8")));
    expect(saved).toMatchObject({
      futureSection: { keepMe: true },
      app: { userMode: "byok", futureAppField: { keep: true } },
      providers: { future: { futureProviderField: { keep: true } } },
      channels: { weixin: { enabled: true } },
      tools: { mcpServers: { demo: { type: "stdio", command: "demo" } } }
    });
  });

  it("rejects blank and unsafe channel/MCP names before writing", async () => {
    const target = file({ futureSection: { keepMe: true } });
    await expect(patchChannelConfigInMemmyConfig("../unsafe", { enabled: true }, target)).rejects.toThrow(/invalid channel name/);
    await expect(patchMcpServerConfigInMemmyConfig("", { type: "stdio" }, target)).rejects.toThrow(/channel name is required/);
    const saved = YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(target, "utf8")));
    expect(saved).toEqual({ futureSection: { keepMe: true } });
  });

  it("keeps account login alias and provider mapping behavior", async () => {
    const target = file({});
    await writeAppCloudUuidToMemmyConfig("cloud-token", target);
    await expect(readRuntimeMemmyConfigState(target)).resolves.toMatchObject({ status: "valid_account", cloudUuid: "cloud-token" });
    expect(Object.fromEntries([
      "openai_compatible", "anthropic", "google", "deepseek", "zhipu", "qwen", "kimi", "minimax", "baidu", "doubao"
    ].map((provider) => [provider, mapModelProtocol(provider as any).agentProvider]))).toEqual({
      openai_compatible: "openai",
      anthropic: "anthropic",
      google: "gemini",
      deepseek: "deepseek",
      zhipu: "zhipu",
      qwen: "dashscope",
      kimi: "moonshot",
      minimax: "minimax",
      baidu: "qianfan",
      doubao: "volcengine"
    });
  });
});

function currentByokCatalog(): Record<string, unknown> {
  return {
    agents: { defaults: { modelPreset: "agent" } },
    providers: {
      openai: {
        apiKey: "sk-main",
        endpoints: { chat: { apiBase: "https://api.example.test/v1", protocol: "openai-chat-completions" } }
      }
    },
    modelPresets: {
      agent: {
        provider: "openai", endpoint: "chat", model: "gpt-5", source: "byok",
        capabilities: ["agent", "memory_summary", "memory_evolution"]
      }
    },
    modelAssignments: {
      byok: {
        agent: { candidates: ["agent"], default: "agent" },
        memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null
      },
      account: { agent: { candidates: [], default: null } }
    }
  };
}

function currentAccountCatalog(): Record<string, unknown> {
  return {
    app: { cloudUuid: "cloud-token", userId: "owner-a" },
    providers: {
      memmy_account: {
        ownerAccountId: "owner-a", apiKey: "cloud-token",
        endpoints: { platform: { apiBase: "https://cloud.example.test/v1", protocol: "memmy-account" } }
      }
    },
    modelPresets: {
      platform: {
        provider: "memmy_account", endpoint: "platform", model: "agent_chat", source: "account",
        ownerAccountId: "owner-a", capabilities: ["agent"]
      }
    },
    modelAssignments: {
      byok: { agent: { candidates: [], default: null } },
      account: { ownerAccountId: "owner-a", agent: { candidates: ["platform"], default: "platform" } }
    }
  };
}
