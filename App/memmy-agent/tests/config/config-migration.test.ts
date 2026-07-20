import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onboard } from "../../src/entrypoints/cli/commands.js";
import { ConfigLoadError, loadConfig, saveConfig } from "../../src/config/loader.js";
import { Config } from "../../src/config/schema.js";
import { validateUrlTarget } from "../../src/security/network.js";

const roots: string[] = [];

function tmpConfig(data: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-migration-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify(data), "utf8");
  return file;
}

function tmpRawConfig(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-migration-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("config migrations", () => {
  it("keeps maxTokens and ignores legacy memoryWindow", () => {
    const configPath = tmpConfig({ agents: { defaults: { maxTokens: 1234, memoryWindow: 42 } } });

    const config = loadConfig(configPath);

    expect(config.agents.defaults.maxTokens).toBe(1234);
    expect(config.agents.defaults.contextWindowTokens).toBe(200_000);
    expect((config.agents.defaults as any).memory_window).toBeUndefined();
  });

  it("writes contextWindowTokens but not memoryWindow", () => {
    const configPath = tmpConfig({ agents: { defaults: { maxTokens: 2222, memoryWindow: 30 } } });

    const config = loadConfig(configPath);
    saveConfig(config, configPath);
    const defaults = YAML.parse(fs.readFileSync(configPath, "utf8")).agents.defaults;

    expect(defaults.maxTokens).toBe(2222);
    expect(defaults.contextWindowTokens).toBe(200_000);
    expect(defaults).not.toHaveProperty("memoryWindow");
  });

  it("preserves explicit legacy-sized contextWindowTokens", () => {
    const configPath = tmpConfig({ agents: { defaults: { contextWindowTokens: 65_536 } } });

    const config = loadConfig(configPath);
    saveConfig(config, configPath);
    const defaults = YAML.parse(fs.readFileSync(configPath, "utf8")).agents.defaults;

    expect(config.agents.defaults.contextWindowTokens).toBe(65_536);
    expect(defaults.contextWindowTokens).toBe(65_536);
  });

  it("preserves app cloudUuid across load and save", () => {
    const configPath = tmpConfig({ app: { cloudUuid: "cloud-login-uuid", source: "desktop" } });

    const config = loadConfig(configPath);
    expect(config.app).toEqual({ cloudUuid: "cloud-login-uuid", source: "desktop" });
    expect(new Config().toObject()).not.toHaveProperty("app");

    saveConfig(config, configPath);
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(saved.app).toEqual({ cloudUuid: "cloud-login-uuid", source: "desktop" });
  });

  it("preserves top-level sessionDag and contextCompaction across load and save", () => {
    const configPath = tmpConfig({
      sessionDag: {
        enabled: true,
        maxBuilderContextNodes: 64,
        maxUpdateAttempts: 7,
        retryBackoffMs: [1000, 5000, 30000],
        maxConcurrentSessionQueues: 6,
        compactionCatchupTimeoutMs: 180000,
      },
      contextCompaction: {
        summaryMode: "dag",
      },
      agents: {
        defaults: {
          sessionDag: { enabled: false },
          contextCompaction: { summaryMode: "text" },
          summaryMode: "text",
        },
      },
    });

    const config = loadConfig(configPath);

    expect(config.sessionDag.maxBuilderContextNodes).toBe(64);
    expect(config.contextCompaction.summaryMode).toBe("dag");

    saveConfig(config, configPath);
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(saved.sessionDag).toEqual({
      enabled: true,
      debugLog: true,
      maxBuilderContextNodes: 64,
      maxUpdateAttempts: 7,
      retryBackoffMs: [1000, 5000, 30000],
      maxConcurrentSessionQueues: 6,
      compactionCatchupTimeoutMs: 180000,
    });
    expect(saved.contextCompaction).toEqual({ summaryMode: "dag" });
    expect(saved.agents.defaults.sessionDag).toBeUndefined();
    expect(saved.agents.defaults.contextCompaction).toBeUndefined();
    expect(saved.agents.defaults.summaryMode).toBeUndefined();
  });

  it("drops unsupported legacy login identity fields on save", () => {
    const configPath = tmpConfig({
      uuid: "legacy-top-level-cloud-uuid",
      identity: {
        userId: "legacy-identity-user"
      },
      memmyMemory: {
        enabled: true,
        userId: "legacy-memory-user"
      }
    });

    const config = loadConfig(configPath);
    expect(config.app).toEqual({});
    expect(config.memmyMemory.userId).toBe("legacy-memory-user");

    saveConfig(config, configPath);
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(saved.app).toBeUndefined();
    expect(saved.memmyMemory.userId).toBe("legacy-memory-user");
    expect(saved.uuid).toBeUndefined();
    expect(saved.identity).toBeUndefined();
  });

  it("preserves BYOK memory profile fields across load and save", () => {
    const configPath = tmpConfig({
      memmyMemory: {
        enabled: true,
        activeProfile: "byok",
        storage: {
          endpoint: "http://127.0.0.1:18888"
        },
        profiles: {
          byok: {
            userId: "local-user",
            summary: {
              provider: "openai_compatible",
              endpoint: "https://api.example.com/v1",
              model: "gpt-4o",
              apiKey: "sk-memory"
            },
            evolution: {
              provider: "openai_compatible",
              endpoint: "https://api.example.com/v1",
              model: "gpt-4o-mini",
              apiKey: "sk-skill"
            },
            embedding: {
              provider: "openai_compatible",
              endpoint: "https://embedding.example.com/v1",
              model: "text-embedding-3-small",
              apiKey: "sk-embedding"
            }
          }
        }
      }
    });

    saveConfig(loadConfig(configPath), configPath);
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(saved.memmyMemory.activeProfile).toBe("byok");
    expect(saved.memmyMemory.userId).toBeUndefined();
    expect(saved.memmyMemory.profiles.byok.summary).toEqual({
      provider: "openai_compatible",
      endpoint: "https://api.example.com/v1",
      model: "gpt-4o",
      apiKey: "sk-memory"
    });
    expect(saved.memmyMemory.profiles.byok.evolution).toEqual({
      provider: "openai_compatible",
      endpoint: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-skill"
    });
    expect(saved.memmyMemory.profiles.byok.embedding).toEqual({
      provider: "openai_compatible",
      endpoint: "https://embedding.example.com/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-embedding"
    });
    expect(saved.memmyMemory.storage.endpoint).toBe("http://127.0.0.1:18888");
  });

  it("preserves account memory profile fields across load and save", () => {
    const configPath = tmpConfig({
      app: {
        userId: "user-1"
      },
      memmyMemory: {
        activeProfile: "account",
        profiles: {
          account: {
            userId: "user-1",
            summary: {
              endpoint: "https://apigw.example.com/api/agentExternal/v1",
              model: "memory_summary",
              apiKey: "cloud-uuid"
            },
            evolution: {
              endpoint: "https://apigw.example.com/api/agentExternal/v1",
              model: "memory_evolution",
              apiKey: "cloud-uuid"
            },
            embedding: {
              endpoint: "https://apigw.example.com/api/agentExternal/v1",
              model: "embedding",
              apiKey: "cloud-uuid"
            }
          }
        }
      }
    });

    saveConfig(loadConfig(configPath), configPath);
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(saved.memmyMemory.activeProfile).toBe("account");
    expect(saved.memmyMemory.userId).toBeUndefined();
    expect(saved.memmyMemory.profiles.account.userId).toBe("user-1");
    expect(saved.memmyMemory.profiles.account.summary.model).toBe("memory_summary");
    expect(saved.memmyMemory.profiles.account.evolution.model).toBe("memory_evolution");
    expect(saved.memmyMemory.profiles.account.embedding.model).toBe("embedding");
  });

  it("keeps legacy memmyMemory role fields across load and save", () => {
    const configPath = tmpConfig({
      memmyMemory: {
        enabled: true,
        userId: "legacy-memory-user",
        summary: {
          provider: "openai_compatible",
          endpoint: "https://api.example.com/v1",
          model: "gpt-4o"
        },
        evolution: {
          provider: "openai_compatible",
          endpoint: "https://api.example.com/v1",
          model: "gpt-4o-mini"
        },
        embedding: {
          provider: "local"
        }
      }
    });

    saveConfig(loadConfig(configPath), configPath);
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(saved.memmyMemory.userId).toBe("legacy-memory-user");
    expect(saved.memmyMemory.summary.model).toBe("gpt-4o");
    expect(saved.memmyMemory.evolution.model).toBe("gpt-4o-mini");
    expect(saved.memmyMemory.embedding.provider).toBe("local");
    expect(saved.memmyMemory.profiles).toBeUndefined();
  });

  it("migrates legacy my tool keys", () => {
    const config = loadConfig(tmpConfig({ tools: { myEnabled: false, mySet: true } }));

    expect(config.tools.my.enable).toBe(false);
    expect(config.tools.my.allowSet).toBe(true);
  });

  it("rewrites legacy my tool keys on save", () => {
    const configPath = tmpConfig({ tools: { myEnabled: false, mySet: true } });

    saveConfig(loadConfig(configPath), configPath);
    const tools = YAML.parse(fs.readFileSync(configPath, "utf8")).tools;

    expect(tools).not.toHaveProperty("myEnabled");
    expect(tools).not.toHaveProperty("mySet");
    expect(tools.my).toEqual({ enable: false, allowSet: true });
  });

  it("lets new my tool keys take precedence over legacy keys", () => {
    const config = loadConfig(tmpConfig({ tools: { myEnabled: false, mySet: false, my: { enable: true, allowSet: true } } }));

    expect(config.tools.my.enable).toBe(true);
    expect(config.tools.my.allowSet).toBe(true);
  });

  it("does not crash onboard with legacy memoryWindow", async () => {
    const configPath = tmpConfig({ agents: { defaults: { maxTokens: 3333, memoryWindow: 50 } } });
    const workspace = path.join(path.dirname(configPath), "workspace");

    await expect(onboard({ config: configPath, workspace, wizard: false })).resolves.toBeTruthy();
  });

  it("onboard refresh backfills missing channel fields", async () => {
    const configPath = tmpConfig({
      channels: {
        qq: {
          enabled: false,
          appId: "",
          secret: "",
          allowFrom: [],
        },
      },
    });
    const workspace = path.join(path.dirname(configPath), "workspace");

    await onboard({ config: configPath, workspace, wizard: false });
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8"));

    expect(saved.channels.qq.msgFormat).toBe("plain");
  });

  it("resets SSRF whitelist when the next config is empty", async () => {
    const whitelisted = tmpConfig({ tools: { ssrfWhitelist: ["100.64.0.0/10"] } });
    const defaulted = tmpConfig({});

    loadConfig(whitelisted);
    await expect(validateUrlTarget("http://100.100.1.1/api")).resolves.toEqual([true, ""]);

    loadConfig(defaulted);
    const [ok] = await validateUrlTarget("http://100.100.1.1/api");
    expect(ok).toBe(false);
  });

  it("throws instead of silently using defaults when the config file cannot be parsed", () => {
    const configPath = tmpRawConfig("{");

    expect(() => loadConfig(configPath)).toThrow(ConfigLoadError);
    try {
      loadConfig(configPath);
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain(configPath);
    }
  });

  it("throws instead of silently using defaults when schema validation fails", () => {
    const configPath = tmpConfig({ channels: { sendMaxRetries: 99 } });

    expect(() => loadConfig(configPath)).toThrow(ConfigLoadError);
    expect(() => loadConfig(configPath)).toThrow(/sendMaxRetries/);
    expect(() => loadConfig(configPath)).toThrow(new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("does not silently reset the SSRF whitelist when a bad config fails to load", async () => {
    const whitelisted = tmpConfig({ tools: { ssrfWhitelist: ["100.64.0.0/10"] } });
    const bad = tmpConfig({
      tools: { ssrfWhitelist: ["100.64.0.0/10"] },
      channels: { sendMaxRetries: 99 },
    });

    loadConfig(whitelisted);
    await expect(validateUrlTarget("http://100.100.1.1/api")).resolves.toEqual([true, ""]);

    expect(() => loadConfig(bad)).toThrow(ConfigLoadError);
    // The failed load must not have touched any global state (like the SSRF whitelist):
    // the last successfully loaded config stays in effect until a valid config loads.
    const [ok] = await validateUrlTarget("http://100.100.1.1/api");
    expect(ok).toBe(true);
  });

  it("still loads defaults when the config file does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-migration-"));
    roots.push(root);
    const missingPath = path.join(root, "does-not-exist", "config.yaml");

    const config = loadConfig(missingPath);

    expect(config.agents.defaults.model).toBe(new Config().agents.defaults.model);
    expect(config.channels.sendMaxRetries).toBe(3);
  });
});
