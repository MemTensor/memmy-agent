import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRuntimeModelCatalogForTest } from "../src/migrations/v1.0.7/0001-normalize-runtime-model-catalog.js";
import type { AgentWorkspaceMigrationContext } from "../src/types.js";

const roots: string[] = [];

async function fixture(config: unknown): Promise<{ configPath: string; context: AgentWorkspaceMigrationContext }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-model-catalog-migration-"));
  roots.push(root);
  const configPath = path.join(root, "config.yaml");
  await fs.writeFile(configPath, YAML.stringify(config), "utf8");
  return {
    configPath,
    context: {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
}

async function readConfig(configPath: string): Promise<Record<string, any>> {
  return YAML.parse(await fs.readFile(configPath, "utf8"));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("v1.0.7/0001-normalize-runtime-model-catalog", () => {
  it("builds a stable catalog from a key-only README provider config", async () => {
    const { configPath, context } = await fixture({
      providers: { openai: { apiKey: "sk-readme" } },
      agents: { defaults: { model: "openai/gpt-4.1" } },
    });

    await normalizeRuntimeModelCatalogForTest(context);
    const once = await fs.readFile(configPath, "utf8");
    const config = await readConfig(configPath);
    const presetId = config.modelAssignments.byok.agent.default;
    expect(config.providers.openai.endpoints.chat).toMatchObject({
      apiBase: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
    });
    expect(config.providers.openai.endpoints.chat).not.toHaveProperty("apiKey");
    expect(config.modelPresets[presetId]).toMatchObject({
      provider: "openai",
      endpoint: "chat",
      model: "gpt-4.1",
      source: "byok",
      capabilities: ["agent"],
    });
    expect(config.modelAssignments.byok.agent).toEqual({
      candidates: [presetId],
      default: presetId,
    });
    expect(config.app.modelCatalogVersion).toBe(1);

    await expect(normalizeRuntimeModelCatalogForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(once);

    config.providers.openai.apiKey = "sk-rotated";
    await fs.writeFile(configPath, YAML.stringify(config), "utf8");
    await expect(normalizeRuntimeModelCatalogForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
    const rotated = await readConfig(configPath);
    expect(rotated.providers.openai.endpoints.chat).not.toHaveProperty("apiKey");
    expect(
      rotated.providers.openai.endpoints.chat.apiKey
      ?? rotated.providers.openai.apiKey,
    ).toBe("sk-rotated");
  });

  it("preserves the legacy responses protocol and withholds the version marker from incomplete catalogs", async () => {
    const complete = await fixture({
      providers: { openai: { api_key: "sk-responses", api_type: "responses" } },
      agents: { defaults: { model: "openai/gpt-4.1" } },
    });
    const incomplete = await fixture({
      app: { modelCatalogVersion: 1 },
      providers: { openai: { apiKey: "sk-without-model" } },
    });

    await normalizeRuntimeModelCatalogForTest(complete.context);
    await normalizeRuntimeModelCatalogForTest(incomplete.context);
    const completeConfig = await readConfig(complete.configPath);
    const incompleteConfig = await readConfig(incomplete.configPath);
    const presetId = completeConfig.modelAssignments.byok.agent.default;
    expect(completeConfig.providers.openai.endpoints.chat.protocol).toBe("openai-responses");
    expect(completeConfig.modelPresets[presetId].endpoint).toBe("chat");
    expect(completeConfig.app.modelCatalogVersion).toBe(1);
    expect(incompleteConfig.app?.modelCatalogVersion).toBeUndefined();
  });

  it("normalizes aliases, endpoints, presets, capabilities, and independent assignments", async () => {
    const { configPath, context } = await fixture({
      futureSection: { keepMe: true },
      agent: { provider: "openai_compatible", model: "gpt-4.1", workspace: "C:/custom" },
      providers: {
        openai_compatible: {
          api_key: "sk-agent",
          api_base: "https://api.example/v1/",
          api_type: "chat_completions",
          futureProvider: { keep: true },
        },
      },
      modelPresets: {
        fast: { provider: "openai_compatible", model: "gpt-4.1", label: "Fast" },
      },
      memmyMemory: {
        summary: {
          provider: "openai_compatible",
          endpoint: "https://api.example/v1",
          model: "gpt-4.1",
          apiKey: "sk-agent",
        },
        evolution: {
          provider: "anthropic",
          endpoint: "https://anthropic.example",
          model: "claude-4",
          apiKey: "sk-claude",
        },
        embedding: {
          mode: "custom",
          custom: {
            provider: "openai_compatible",
            endpoint: "https://embedding.example/v1",
            model: "text-embedding-3-small",
            apiKey: "sk-embedding",
          },
        },
      },
      tools: {
        my: { obsolete: true },
        myEnabled: true,
        asr: {
          provider: "aliyun",
          baseUrl: "https://dashscope.example/v1",
          modelId: "qwen3-asr-flash",
          apiKey: "sk-asr",
        },
        imageGeneration: {
          profiles: {
            account: { provider: "google", apiBase: "https://account.invalid", model: "account-image" },
            byok: { provider: "qwen", apiBase: "https://image.example/v1", model: "qwen-image", apiKey: "sk-image" },
          },
        },
      },
      modelAssignments: {
        account: {
          ownerAccountId: "account-a",
          agent: { candidates: ["account-preset"], default: "account-preset" },
          memorySummary: "account-summary",
          memoryEvolution: null,
          embedding: null,
          asr: null,
          imageGeneration: null,
        },
      },
    });

    await expect(normalizeRuntimeModelCatalogForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 1,
      ignored: 0,
    });
    const config = await readConfig(configPath);
    expect(config.agent).toBeUndefined();
    expect(config.agents.defaults.workspace).toBe("C:/custom");
    expect(config.providers.openai).toMatchObject({
      apiKey: "sk-agent",
      futureProvider: { keep: true },
      endpoints: {
        chat: {
          apiBase: "https://api.example/v1",
          protocol: "openai-chat-completions",
        },
      },
    });
    expect(config.providers.openai_compatible).toBeUndefined();
    expect(config.modelPresets.fast).toMatchObject({
      provider: "openai",
      endpoint: "chat",
      source: "byok",
      capabilities: ["agent", "memory_summary"],
    });
    expect(config.modelPresets.fast.label).toBeUndefined();
    expect(config.modelAssignments.byok.agent).toEqual({ candidates: ["fast"], default: "fast" });
    expect(config.modelAssignments.byok.memorySummary).toBe("fast");
    expect(config.modelAssignments.byok.memoryEvolution).toMatch(/^byok-anthropic-/);
    expect(config.modelAssignments.byok.embedding).toMatch(/^byok-openai-/);
    expect(config.modelAssignments.byok.asr).toMatch(/^byok-dashscope-/);
    expect(config.modelAssignments.byok.imageGeneration).toMatch(/^byok-dashscope-/);
    expect(config.memmyMemory.summary).toBeUndefined();
    expect(config.memmyMemory.evolution).toBeUndefined();
    expect(config.memmyMemory.embedding).toBeUndefined();
    expect(config.modelAssignments.account).toEqual({
      ownerAccountId: "account-a",
      agent: { candidates: ["account-preset"], default: "account-preset" },
      memorySummary: "account-summary",
      memoryEvolution: null,
      embedding: null,
      asr: null,
      imageGeneration: null,
    });
    expect(config.tools.my).toBeUndefined();
    expect(config.tools.myEnabled).toBeUndefined();
    expect(config.tools.imageGeneration).toEqual({});
    expect(config.futureSection.keepMe).toBe(true);
    expect(config.app.modelCatalogVersion).toBe(1);
  });

  it("preserves unknown endpoint and preset fields and is idempotent", async () => {
    const { configPath, context } = await fixture({
      app: { modelCatalogVersion: 1 },
      providers: {
        openai: {
          apiKey: "sk",
          futureProvider: true,
          endpoints: {
            chat: {
              apiBase: "https://api.example/v1",
              protocol: "openai-chat-completions",
              futureEndpoint: { keep: true },
            },
          },
        },
      },
      modelPresets: {
        stable: {
          provider: "openai",
          endpoint: "chat",
          model: "gpt-5",
          source: "byok",
          capabilities: ["agent"],
          futurePreset: { keep: true },
        },
      },
      modelAssignments: {
        byok: {
          agent: { candidates: ["stable"], default: "stable" },
          memorySummary: null,
          memoryEvolution: null,
          embedding: null,
          asr: null,
          imageGeneration: null,
        },
        account: {
          agent: { candidates: [], default: null },
          memorySummary: null,
          memoryEvolution: null,
          embedding: null,
          asr: null,
          imageGeneration: null,
        },
      },
    });

    await normalizeRuntimeModelCatalogForTest(context);
    const once = await fs.readFile(configPath, "utf8");
    await expect(normalizeRuntimeModelCatalogForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(once);
    const config = await readConfig(configPath);
    expect(config.providers.openai.endpoints.chat.futureEndpoint.keep).toBe(true);
    expect(config.modelPresets.stable.futurePreset.keep).toBe(true);
  });

  it("defers a missing config without creating it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-model-catalog-missing-"));
    roots.push(root);
    const configPath = path.join(root, "config.yaml");
    const context: AgentWorkspaceMigrationContext = {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    await expect(normalizeRuntimeModelCatalogForTest(context)).resolves.toEqual({
      scanned: 0,
      changed: 0,
      ignored: 0,
      deferred: true,
    });
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports invalid YAML against the consolidated migration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-model-catalog-invalid-"));
    roots.push(root);
    const configPath = path.join(root, "config.yaml");
    const source = "memmyMemory: [\n";
    await fs.writeFile(configPath, source, "utf8");
    const context: AgentWorkspaceMigrationContext = {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await expect(normalizeRuntimeModelCatalogForTest(context)).rejects.toMatchObject({
      code: "migration_config_invalid",
      migrationId: "v1.0.7/0001-normalize-runtime-model-catalog",
      scope: "runtime-config",
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(source);
  });

  it("rekeys a legacy account preset by owner without rebinding another owner", async () => {
    const first = await fixture({
      app: { userId: "owner-a" },
      providers: {
        memmy_account: {
          ownerAccountId: "owner-a",
          apiKey: "local-token",
          apiBase: "https://account.example/v1",
        },
      },
      modelPresets: {
        "memmy-account": {
          provider: "memmy_account",
          model: "agent_chat",
          label: "Account",
        },
      },
      agents: { defaults: { modelPreset: "memmy-account", fallbackModels: ["memmy-account"] } },
    });
    const second = await fixture({
      app: { userId: "owner-b" },
      providers: {
        memmy_account: {
          ownerAccountId: "owner-b",
          apiKey: "local-token",
          apiBase: "https://account.example/v1",
        },
      },
      modelPresets: {
        "memmy-account": { provider: "memmy_account", model: "agent_chat" },
      },
      agents: { defaults: { modelPreset: "memmy-account" } },
    });

    await normalizeRuntimeModelCatalogForTest(first.context);
    await normalizeRuntimeModelCatalogForTest(second.context);
    const firstConfig = await readConfig(first.configPath);
    const secondConfig = await readConfig(second.configPath);
    const firstId = Object.keys(firstConfig.modelPresets)[0]!;
    const secondId = Object.keys(secondConfig.modelPresets)[0]!;
    expect(firstId).toMatch(/^memmy-account-[a-f0-9]{12}-agent$/);
    expect(secondId).toMatch(/^memmy-account-[a-f0-9]{12}-agent$/);
    expect(firstId).not.toBe(secondId);
    expect(firstConfig.agents.defaults.modelPreset).toBe(firstId);
    expect(firstConfig.agents.defaults.fallbackModels).toEqual([firstId]);
    expect(firstConfig.modelAssignments.account.agent).toEqual({
      candidates: [firstId],
      default: firstId,
    });
    expect(firstConfig.modelPresets[firstId].ownerAccountId).toBe("owner-a");
    expect(Object.values(firstConfig.modelPresets)).toHaveLength(6);
    expect(firstConfig.providers.memmy_account.endpoints.platform.protocol).toBe("memmy-account");
    expect(firstConfig.modelAssignments.account).toMatchObject({
      ownerAccountId: "owner-a",
      memorySummary: expect.stringContaining("memory-summary"),
      memoryEvolution: expect.stringContaining("memory-evolution"),
      embedding: expect.stringContaining("embedding"),
      asr: expect.stringContaining("asr"),
      imageGeneration: expect.stringContaining("image-generation"),
    });

    const once = await fs.readFile(first.configPath, "utf8");
    await normalizeRuntimeModelCatalogForTest(first.context);
    await expect(fs.readFile(first.configPath, "utf8")).resolves.toBe(once);
  });

  it("preserves every dormant account assignment field when the current owner differs", async () => {
    const dormantAssignment = {
      ownerAccountId: "owner-a",
      agent: { candidates: ["owner-a-agent"], default: "owner-a-agent", futureAgent: true },
      memorySummary: "owner-a-summary",
      memoryEvolution: "owner-a-evolution",
      embedding: "owner-a-embedding",
      asr: "owner-a-asr",
      imageGeneration: "owner-a-image",
      futureAssignment: { keep: true },
    };
    const { configPath, context } = await fixture({
      app: { userId: "owner-b" },
      providers: {
        memmy_account: {
          ownerAccountId: "owner-b",
          apiBase: "https://account.example/v1",
        },
      },
      modelPresets: {
        "owner-a-agent": {
          provider: "memmy_account",
          endpoint: "platform",
          model: "agent_chat",
          source: "account",
          ownerAccountId: "owner-a",
          capabilities: ["agent"],
        },
      },
      modelAssignments: { account: dormantAssignment },
    });

    await normalizeRuntimeModelCatalogForTest(context);
    const config = await readConfig(configPath);
    expect(config.modelAssignments.account).toEqual(dormantAssignment);
    expect(config.modelAssignments.account.agent.default).toBe("owner-a-agent");
  });

  it("freezes alias endpoint auth, deduplicates by full identity, and rewrites all endpoint references", async () => {
    const { configPath, context } = await fixture({
      providers: {
        openai: {
          apiKey: "sk-canonical",
          endpoints: {
            canonical: { apiBase: "https://same.example/v1", protocol: "openai-chat-completions" },
            canonicalDuplicate: { apiBase: "https://same.example/v1", protocol: "openai-chat-completions" },
          },
        },
        openai_compatible: {
          apiKey: "sk-alias",
          endpoints: {
            alias: { apiBase: "https://same.example/v1", protocol: "openai-chat-completions", futureEndpoint: true },
            aliasDuplicate: { apiBase: "https://same.example/v1", protocol: "openai-chat-completions" },
          },
        },
      },
      modelPresets: {
        canonicalPreset: { provider: "openai", endpoint: "canonicalDuplicate", model: "gpt-a" },
        aliasPreset: { provider: "openai_compatible", endpoint: "alias", model: "gpt-b" },
        aliasDuplicatePreset: { provider: "openai_compatible", endpoint: "aliasDuplicate", model: "gpt-c" },
      },
    });

    await normalizeRuntimeModelCatalogForTest(context);
    const config = await readConfig(configPath);
    expect(config.providers.openai_compatible).toBeUndefined();
    expect(Object.keys(config.providers.openai.endpoints)).toHaveLength(2);
    expect(config.modelPresets.canonicalPreset.endpoint).toBe("canonical");
    expect(config.modelPresets.aliasPreset.endpoint).toBe(config.modelPresets.aliasDuplicatePreset.endpoint);
    const aliasEndpoint = config.providers.openai.endpoints[config.modelPresets.aliasPreset.endpoint];
    expect(aliasEndpoint).toMatchObject({ apiKey: "sk-alias", futureEndpoint: true });
    expect(config.providers.openai.endpoints.canonical).not.toHaveProperty("apiKey");
    expect(config.providers.openai.apiKey).toBe("sk-canonical");
  });

  it("fails stably without rewriting an endpoint that is missing apiBase", async () => {
    const { configPath, context } = await fixture({
      providers: {
        openai: {
          endpoints: {
            broken: { protocol: "openai-chat-completions", futureEndpoint: { keep: true } },
          },
        },
      },
    });
    const before = await fs.readFile(configPath, "utf8");

    await expect(normalizeRuntimeModelCatalogForTest(context)).rejects.toMatchObject({
      code: "migration_config_invalid",
      message: "Endpoint openai/broken is missing apiBase",
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(before);
  });

  it("flattens legacy Memory profiles before building the catalog in one write", async () => {
    const { configPath, context } = await fixture({
      providers: {
        openai: {
          apiBase: "https://api.example.com/v1/",
          apiKey: "sk-agent",
        },
      },
      agents: {
        defaults: {
          provider: "openai",
          model: "gpt-main",
        },
      },
      memmyMemory: {
        activeProfile: "byok",
        profiles: {
          byok: {
            summary: {
              provider: "openai_compatible",
              endpoint: "https://api.example.com/v1",
              model: "gpt-main",
              apiKey: "sk-agent",
            },
            evolution: {
              provider: "anthropic",
              endpoint: "https://anthropic.example",
              model: "claude-fixed",
              apiKey: "sk-evolution",
            },
            embedding: { provider: "local", batchSize: 16 },
          },
        },
      },
    });

    await expect(normalizeRuntimeModelCatalogForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 1,
      ignored: 0,
    });

    const config = await readConfig(configPath);
    const agentPreset = config.modelAssignments.byok.agent.default;
    expect(config.modelAssignments.byok.memorySummary).toBe(agentPreset);
    expect(config.modelAssignments.byok.memoryEvolution).toMatch(/^byok-anthropic-/);
    expect(config.modelAssignments.byok.embedding).toBeNull();
    expect(config.memmyMemory.roleRouting).toEqual({
      summary: "follow",
      evolution: "fixed",
    });
    expect(config.memmyMemory.activeProfile).toBeUndefined();
    expect(config.memmyMemory.profiles).toBeUndefined();
    expect(config.memmyMemory.summary).toBeUndefined();
    expect(config.memmyMemory.evolution).toBeUndefined();
    expect(config.memmyMemory.embedding).toBeUndefined();
  });

  it("removes an invalid BYOK account projection without disturbing valid assignments", async () => {
    const { configPath, context } = await fixture({
      providers: {
        memmy_account: {
          ownerAccountId: "owner-a",
          endpoints: {
            platform: {
              apiBase: "https://account.example/v1",
              protocol: "memmy-account",
            },
          },
        },
        openai: {
          apiKey: "sk-valid",
          endpoints: {
            chat: {
              apiBase: "https://api.openai.com/v1",
              protocol: "openai-chat-completions",
            },
          },
        },
      },
      modelPresets: {
        invalidAccountCopy: {
          provider: "memmy_account",
          endpoint: "platform",
          model: "agent_chat",
          source: "byok",
          capabilities: ["agent"],
        },
        validMemory: {
          provider: "openai",
          endpoint: "chat",
          model: "gpt-4.1-mini",
          source: "byok",
          capabilities: ["memory_summary", "memory_evolution"],
        },
      },
      modelAssignments: {
        byok: {
          agent: { candidates: ["invalidAccountCopy"], default: "invalidAccountCopy" },
          memorySummary: "validMemory",
          memoryEvolution: "validMemory",
          embedding: null,
          asr: null,
          imageGeneration: null,
        },
      },
    });

    await normalizeRuntimeModelCatalogForTest(context);

    const config = await readConfig(configPath);
    expect(config.modelPresets.invalidAccountCopy).toBeUndefined();
    expect(config.modelAssignments.byok.agent).toEqual({ candidates: [], default: null });
    expect(config.modelAssignments.byok.memorySummary).toBe("validMemory");
    expect(config.modelAssignments.byok.memoryEvolution).toBe("validMemory");
  });
});
