import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flattenLegacyMemoryModelConfig } from "../src/migrations/v1.0.7/legacy-memory-model-config.js";
import { mutateRuntimeConfig } from "../src/runtime-config-writer.js";
import {
  MigrationError,
  type AgentWorkspaceMigrationContext,
  type MigrationLogger,
  type MigrationResult,
} from "../src/types.js";

const MIGRATION_ID = "v1.0.7/0001-normalize-runtime-model-catalog";

type MigrationHooks = {
  beforeCommit?: (configPath: string) => Promise<void>;
};

const temporaryDirectories: string[] = [];

function logger(): MigrationLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function fixture(
  config: unknown,
): Promise<{ root: string; configPath: string; context: AgentWorkspaceMigrationContext }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-memory-config-migration-"));
  temporaryDirectories.push(root);
  const configPath = path.join(root, "config.yaml");
  await fs.writeFile(configPath, YAML.stringify(config));
  return {
    root,
    configPath,
    context: {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: logger(),
    },
  };
}

async function migratedConfig(configPath: string): Promise<Record<string, any>> {
  return YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
}

async function flattenMemoryModelConfigForTest(
  context: AgentWorkspaceMigrationContext,
  hooks: MigrationHooks = {},
): Promise<MigrationResult> {
  try {
    const result = await mutateRuntimeConfig(
      context.runtimeConfigFile,
      flattenLegacyMemoryModelConfig,
      { createIfMissing: false, beforeCommit: hooks.beforeCommit },
    );
    if (!result.sourceExists) return { scanned: 0, changed: 0, ignored: 1 };
    return result.changed
      ? { scanned: 1, changed: 1, ignored: 0 }
      : { scanned: 1, changed: 0, ignored: 1 };
  } catch (error) {
    if (error instanceof MigrationError && error.migrationId === null) {
      throw new MigrationError(error.code, error.message, {
        migrationId: MIGRATION_ID,
        scope: "runtime-config",
        cause: error.cause,
      });
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("legacy Memory model config normalization", () => {
  it("migrates an account profile to follow/cloud without treating platform roles as fixed", async () => {
    const { configPath, context } = await fixture({
      app: { cloudUuid: "cloud-uuid" },
      providers: {
        memmy_account: {
          apiBase: "https://account.example/v1",
          apiKey: "cloud-uuid",
        },
      },
      agents: {
        defaults: {
          provider: "memmy_account",
          model: "agent_chat",
        },
      },
      memmyMemory: {
        activeProfile: "account",
        storage: { backend: "sqlite", customField: "preserved" },
        profiles: {
          account: {
            userId: "account-user",
            summary: {
              endpoint: "https://account.example/v1",
              model: "memory_summary",
              apiKey: "cloud-uuid",
            },
            evolution: {
              endpoint: "https://account.example/v1",
              model: "memory_evolution",
              apiKey: "cloud-uuid",
            },
            embedding: {
              endpoint: "https://account.example/v1",
              model: "embedding",
              apiKey: "cloud-uuid",
            },
          },
          byok: {
            userId: "local-user-7",
            summary: {
              provider: "openai_compatible",
              endpoint: "https://memory.example/v1",
              model: "fixed-summary",
              apiKey: "sk-summary",
            },
            embedding: {
              provider: "openai_compatible",
              endpoint: "https://embedding.example/v1",
              model: "text-embedding-3-small",
              apiKey: "sk-embedding",
            },
          },
        },
        unknownField: { keep: true },
      },
    });

    await expect(flattenMemoryModelConfigForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 1,
      ignored: 0,
    });

    const config = await migratedConfig(configPath);
    expect(config.memmyMemory).toMatchObject({
      userId: "local-user-7",
      roleRouting: {
        summary: "follow",
        evolution: "follow",
      },
      summary: {
        provider: "openai_compatible",
        model: "fixed-summary",
      },
      embedding: {
        mode: "cloud",
        custom: {
          provider: "openai_compatible",
          endpoint: "https://embedding.example/v1",
          model: "text-embedding-3-small",
          apiKey: "sk-embedding",
        },
      },
      storage: { backend: "sqlite", customField: "preserved" },
      unknownField: { keep: true },
    });
    expect(config.memmyMemory.activeProfile).toBeUndefined();
    expect(config.memmyMemory.profiles).toBeUndefined();
    expect(config.memmyMemory.evolution).toBeUndefined();
    expect(config.app.userId).toBe("account-user");
  });

  it("maps matching BYOK roles to follow and different roles to fixed", async () => {
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
            userId: "local-user",
            summary: {
              provider: "openai_compatible",
              endpoint: "https://api.example.com/v1",
              model: "gpt-main",
              apiKey: "sk-agent",
              timeoutMs: 45_000,
            },
            evolution: {
              provider: "anthropic",
              endpoint: "https://anthropic.example",
              model: "claude-fixed",
              apiKey: "sk-evolution",
              timeoutMs: 75_000,
            },
            embedding: {
              provider: "local",
              batchSize: 16,
            },
          },
        },
      },
    });

    await flattenMemoryModelConfigForTest(context);
    const config = await migratedConfig(configPath);

    expect(config.memmyMemory.roleRouting).toEqual({
      summary: "follow",
      evolution: "fixed",
    });
    expect(config.memmyMemory.summary).toMatchObject({
      model: "gpt-main",
      timeoutMs: 45_000,
    });
    expect(config.memmyMemory.evolution).toMatchObject({
      model: "claude-fixed",
      timeoutMs: 75_000,
    });
    expect(config.memmyMemory.embedding).toEqual({
      mode: "local",
      batchSize: 16,
    });
  });

  it("uses named Agent presets when deciding follow and preserves preset data", async () => {
    const originalPreset = {
      provider: "anthropic",
      model: "claude-main",
      maxTokens: 65_536,
      contextWindowTokens: 200_000,
      temperature: 0.2,
      reasoningEffort: "medium",
    };
    const { configPath, context } = await fixture({
      providers: {
        anthropic: {
          apiBase: "https://anthropic.example",
          apiKey: "sk-agent",
        },
      },
      modelPresets: {
        "work-claude": originalPreset,
      },
      agents: {
        defaults: {
          modelPreset: "work-claude",
        },
      },
      memmyMemory: {
        activeProfile: "byok",
        profiles: {
          byok: {
            summary: {
              provider: "anthropic",
              endpoint: "https://anthropic.example",
              model: "claude-main",
              apiKey: "sk-agent",
            },
            embedding: {
              provider: "local",
            },
          },
        },
      },
    });

    await flattenMemoryModelConfigForTest(context);
    const config = await migratedConfig(configPath);

    expect(config.memmyMemory.roleRouting.summary).toBe("follow");
    expect(config.modelPresets["work-claude"]).toEqual(originalPreset);
    expect(config.agents.defaults.modelPreset).toBe("work-claude");
  });

  it("keeps explicit new routing, root fixed models, embedding mode, and custom fields", async () => {
    const { configPath, context } = await fixture({
      memmyMemory: {
        activeProfile: "account",
        roleRouting: {
          summary: "fixed",
          evolution: "follow",
          futureRole: "keep",
        },
        summary: {
          provider: "anthropic",
          endpoint: "https://summary.example",
          model: "summary-fixed",
          apiKey: "sk-summary",
        },
        evolution: {
          provider: "openai_compatible",
          endpoint: "https://root-evolution.example",
          model: "root-evolution",
        },
        embedding: {
          mode: "custom",
          custom: {
            endpoint: "https://new-embedding.example",
            model: "new-embedding",
            apiKey: "sk-new",
          },
          cache: false,
        },
        profiles: {
          byok: {
            evolution: {
              provider: "anthropic",
              endpoint: "https://legacy-evolution.example",
              model: "legacy-evolution",
            },
            embedding: {
              provider: "openai_compatible",
              endpoint: "https://legacy-embedding.example",
              model: "legacy-embedding",
              apiKey: "sk-legacy",
            },
          },
        },
      },
    });

    await flattenMemoryModelConfigForTest(context);
    const config = await migratedConfig(configPath);

    expect(config.memmyMemory.roleRouting).toEqual({
      summary: "fixed",
      evolution: "follow",
      futureRole: "keep",
    });
    expect(config.memmyMemory.evolution.model).toBe("root-evolution");
    expect(config.memmyMemory.embedding).toEqual({
      mode: "custom",
      custom: {
        provider: "openai_compatible",
        endpoint: "https://new-embedding.example",
        model: "new-embedding",
        apiKey: "sk-new",
      },
      cache: false,
    });
  });

  it("migrates root-only legacy roles and remote embedding", async () => {
    const { configPath, context } = await fixture({
      providers: {
        deepseek: {
          apiBase: "https://api.deepseek.com",
          apiKey: "sk-agent",
        },
      },
      agents: {
        defaults: {
          provider: "deepseek",
          model: "deepseek-chat",
        },
      },
      memmyMemory: {
        userId: "root-local-user",
        summary: {
          provider: "openai_compatible",
          endpoint: "https://api.deepseek.com",
          model: "deepseek-chat",
        },
        evolution: {
          provider: "openai_compatible",
          endpoint: "https://evolution.example",
          model: "fixed-evolution",
        },
        embedding: {
          provider: "openai_compatible",
          endpoint: "https://embedding.example",
          model: "embedding-model",
          apiKey: "sk-embedding",
          batchSize: 8,
        },
      },
    });

    await flattenMemoryModelConfigForTest(context);
    const config = await migratedConfig(configPath);

    expect(config.memmyMemory.roleRouting).toEqual({
      summary: "follow",
      evolution: "fixed",
    });
    expect(config.memmyMemory.embedding).toEqual({
      mode: "custom",
      custom: {
        provider: "openai_compatible",
        endpoint: "https://embedding.example",
        model: "embedding-model",
        apiKey: "sk-embedding",
      },
      batchSize: 8,
    });
    expect(config.memmyMemory.userId).toBe("root-local-user");
  });

  it("does not recover account user id from an orphaned account profile", async () => {
    const { configPath, context } = await fixture({
      memmyMemory: {
        activeProfile: "account",
        profiles: {
          account: {
            userId: "orphaned-account-user",
          },
        },
      },
    });

    await flattenMemoryModelConfigForTest(context);
    const config = await migratedConfig(configPath);

    expect(config.app).toBeUndefined();
    expect(config.memmyMemory.userId).toBe("local-user");
  });

  it.each([
    ["a config without Memory", { agents: { defaults: {} } }],
    [
      "an already migrated config",
      {
        memmyMemory: {
          roleRouting: { summary: "follow", evolution: "fixed" },
          summary: { provider: "anthropic", model: "fixed" },
          embedding: { mode: "local" },
        },
      },
    ],
  ])("ignores %s without rewriting it", async (_label, input) => {
    const { configPath, context } = await fixture(input);
    const before = await fs.readFile(configPath);

    await expect(flattenMemoryModelConfigForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
    await expect(fs.readFile(configPath)).resolves.toEqual(before);
  });

  it("ignores a missing config file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-memory-config-missing-"));
    temporaryDirectories.push(root);
    const context: AgentWorkspaceMigrationContext = {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: path.join(root, "missing.yaml"),
      sessionDagDir: path.join(root, "session-dag"),
      logger: logger(),
    };

    await expect(flattenMemoryModelConfigForTest(context)).resolves.toEqual({
      scanned: 0,
      changed: 0,
      ignored: 1,
    });
  });

  it.each([
    ["invalid YAML", "memmyMemory: [\n"],
    ["a non-object root", "- list\n"],
    ["an invalid active profile", "memmyMemory:\n  activeProfile: other\n"],
    ["invalid profiles", "memmyMemory:\n  profiles: []\n"],
    [
      "invalid explicit routing",
      "memmyMemory:\n  roleRouting:\n    summary: sometimes\n  profiles: {}\n",
    ],
  ])("rejects %s without changing the source", async (_label, source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-memory-config-invalid-"));
    temporaryDirectories.push(root);
    const configPath = path.join(root, "config.yaml");
    await fs.writeFile(configPath, source);
    const context: AgentWorkspaceMigrationContext = {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: logger(),
    };

    await expect(flattenMemoryModelConfigForTest(context)).rejects.toMatchObject({
      code: "migration_config_invalid",
      migrationId: MIGRATION_ID,
      scope: "runtime-config",
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(source);
  });

  it("detects a source change before commit and leaves no migration temp", async () => {
    const { root, configPath, context } = await fixture({
      memmyMemory: {
        activeProfile: "byok",
        profiles: {
          byok: {
            embedding: { provider: "local" },
          },
        },
      },
    });
    const replacement = "memmyMemory:\n  roleRouting:\n    summary: follow\n    evolution: follow\n";

    await expect(
      flattenMemoryModelConfigForTest(context, {
        beforeCommit: async () => {
          await fs.writeFile(configPath, replacement);
        },
      }),
    ).rejects.toMatchObject({ code: "migration_source_changed" });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(replacement);
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("is idempotent when up is called directly twice", async () => {
    const { configPath, context } = await fixture({
      memmyMemory: {
        activeProfile: "byok",
        profiles: {
          byok: {
            embedding: { provider: "local" },
          },
        },
      },
    });

    await flattenMemoryModelConfigForTest(context);
    const afterFirst = await fs.readFile(configPath);
    await expect(flattenMemoryModelConfigForTest(context)).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
    await expect(fs.readFile(configPath)).resolves.toEqual(afterFirst);
  });
});
