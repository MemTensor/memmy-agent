/** Current runtime config boundary tests. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { withRuntimeConfigWriteLock } from "@memmy/migrations";
import {
  createMemmyConfigWriter,
  mapModelProtocol,
  patchChannelConfigInMemmyConfig,
  patchMcpServerConfigInMemmyConfig,
  readAgentGatewayBootstrapSecret,
  readBundledPluginPreferences,
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

function file(initial?: Record<string, unknown> | string, name = "config.yaml"): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "memmy-config-current-"));
  const target = join(tempDir, name);
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

  it("reads only explicit bundled plugin enablement and preserves state on invalid config", async () => {
    await expect(readBundledPluginPreferences(file({}), ["literature-review"]))
      .resolves.toEqual({});
    await expect(readBundledPluginPreferences(file({
      plugins: { "literature-review": { enabled: false } }
    }), ["literature-review"])).resolves.toEqual({
      "literature-review": { enabled: false }
    });
    await expect(readBundledPluginPreferences(file("plugins:\n  literature-review:\n    enabled: maybe\n"), [
      "literature-review"
    ])).resolves.toBeNull();
    await expect(readBundledPluginPreferences(file("plugins: ["), ["literature-review"]))
      .resolves.toBeNull();
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

  it("runs an asynchronous MCP guard with the actual config path before committing", async () => {
    const target = file({ futureSection: { keepMe: true }, tools: { mcpServers: { existing: { command: "keep" } } } });
    const original = readFileSync(target, "utf8");
    const guardedPaths: string[] = [];
    await patchMcpServerConfigInMemmyConfig("composio", { type: "streamableHttp", url: "http://127.0.0.1:9000" }, target, {
      beforeCommit: async (configPath) => {
        await Promise.resolve();
        guardedPaths.push(configPath);
        expect(readFileSync(target, "utf8")).toBe(original);
      }
    });

    expect(guardedPaths).toEqual([target]);
    expect(YAML.parse(readFileSync(target, "utf8"))).toMatchObject({
      futureSection: { keepMe: true },
      tools: { mcpServers: { existing: { command: "keep" }, composio: { type: "streamableHttp", url: "http://127.0.0.1:9000" } } }
    });
    expect(readdirSync(dirname(target))).toEqual(["config.yaml"]);
  });

  it("preserves existing configuration and releases temporary files and the lock when an MCP guard rejects", async () => {
    const target = file({ futureSection: { keepMe: true }, tools: { mcpServers: { existing: { command: "keep" } } } });
    const original = readFileSync(target, "utf8");
    const rejection = new Error("Backend closed before MCP configuration commit");
    const guardedPaths: string[] = [];
    const writer = createMemmyConfigWriter({ configPath: target });

    await expect(writer.patchMcpServerConfig("composio", { type: "streamableHttp", url: "http://127.0.0.1:9000" }, {
      beforeCommit: (configPath) => {
        guardedPaths.push(configPath);
        throw rejection;
      }
    })).rejects.toMatchObject({ code: "migration_io_failed", cause: rejection });

    expect(guardedPaths).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(readdirSync(dirname(target))).toEqual(["config.yaml"]);
    await expect(withRuntimeConfigWriteLock(target, async () => "released")).resolves.toBe("released");
  });

  it("rejects a stale MCP write after waiting for the runtime config lock", async () => {
    const target = file({ futureSection: { keepMe: true }, tools: { mcpServers: { existing: { command: "keep" } } } });
    const original = readFileSync(target, "utf8");
    let releaseLock: () => void = () => undefined;
    const mayReleaseLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    let lockAcquired: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const holdingLock = withRuntimeConfigWriteLock(target, async () => {
      lockAcquired();
      await mayReleaseLock;
    });
    await acquired;

    let active = true;
    let settled = false;
    const guardedPaths: string[] = [];
    const rejection = new Error("Backend closed while the MCP write waited for its lock");
    const outcome = createMemmyConfigWriter({ configPath: target }).patchMcpServerConfig("composio", {
      type: "streamableHttp", url: "http://127.0.0.1:9000", headers: { Authorization: "old-backend-token" }
    }, {
      beforeCommit: (configPath) => {
        guardedPaths.push(configPath);
        if (!active) throw rejection;
      }
    }).then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect(guardedPaths).toEqual([]);
      expect(readFileSync(target, "utf8")).toBe(original);
    } finally {
      active = false;
      releaseLock();
      await holdingLock;
      await outcome;
    }

    expect(await outcome).toMatchObject({ code: "migration_io_failed", cause: rejection });
    expect(guardedPaths).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(readdirSync(dirname(target))).toEqual(["config.yaml"]);
    await expect(withRuntimeConfigWriteLock(target, async () => "released")).resolves.toBe("released");
  });

  it("writes the resolved UI language instead of clearing system", async () => {
    const cnTarget = file({ memmyMemory: { domain: "keep" } }, "cn.yaml");
    await createMemmyConfigWriter({ configPath: cnTarget, accountChannel: "phone" })
      .writeMemoryLanguage?.("system");
    expect(YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(cnTarget, "utf8")))).toMatchObject({
      memmyMemory: { domain: "keep", language: "zh-CN" }
    });

    const intlTarget = file({ memmyMemory: { language: "zh-CN" } }, "intl.yaml");
    await createMemmyConfigWriter({ configPath: intlTarget, accountChannel: "email" })
      .writeMemoryLanguage?.("system");
    expect(YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(intlTarget, "utf8"))).memmyMemory.language).toBe("en-US");

    const explicitTarget = file({}, "explicit.yaml");
    await createMemmyConfigWriter({ configPath: explicitTarget, accountChannel: "email" })
      .writeMemoryLanguage?.("zh-CN");
    expect(YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(explicitTarget, "utf8"))).memmyMemory.language).toBe("zh-CN");
  });

  it.each(["ja-jp", "fr-fr"])("publishes the explicit future output language %s without changing unrelated runtime configuration", async (language) => {
    const target = file({ memmyMemory: { domain: "keep", futureOption: true }, app: { futureAppField: "keep" } });
    await createMemmyConfigWriter({ configPath: target, accountChannel: "email" }).writeMemoryLanguage?.(language);
    const saved = YAML.parse(await import("node:fs/promises").then(({ readFile }) => readFile(target, "utf8")));
    expect(saved).toMatchObject({
      memmyMemory: { domain: "keep", futureOption: true, language: Intl.getCanonicalLocales(language)[0] },
      app: { futureAppField: "keep" }
    });
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
      "openai_compatible", "anthropic", "google", "deepseek", "zhipu", "qwen", "kimi", "minimax", "baidu", "doubao",
      "stepfun", "xiaomi"
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
      doubao: "volcengine",
      stepfun: "stepfun",
      xiaomi: "xiaomi_mimo"
    });
    expect(mapModelProtocol("stepfun")).toEqual({
      agentProvider: "stepfun",
      agentApiType: "auto",
      memoryProvider: "openai_compatible"
    });
    expect(mapModelProtocol("xiaomi")).toEqual({
      agentProvider: "xiaomi_mimo",
      agentApiType: "auto",
      memoryProvider: "openai_compatible"
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
