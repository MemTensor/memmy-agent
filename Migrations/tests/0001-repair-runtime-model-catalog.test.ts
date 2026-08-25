import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRuntimeModelCatalogV107 } from "../src/migrations/v1.0.7/0001-normalize-runtime-model-catalog.js";
import { repairRuntimeModelCatalogV109 } from "../src/migrations/v1.0.9/0001-repair-runtime-model-catalog.js";
import { runMigrationsForTest } from "../src/runner.js";
import type { MigrationLogger, RunMigrationsOptions } from "../src/types.js";

const roots: string[] = [];

function logger(): MigrationLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-model-catalog-repair-"));
  roots.push(root);
  return fs.realpath(root);
}

function options(root: string, configPath: string): RunMigrationsOptions {
  return {
    targets: {
      agentWorkspace: root,
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
    },
    logger: logger(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("v1.0.9/0001-repair-runtime-model-catalog", () => {
  it("attributes repair failures to the v1.0.9 migration", async () => {
    const root = await workspace();
    const configPath = path.join(root, "config.yaml");
    await fs.writeFile(configPath, YAML.stringify({
      memmyMemory: { activeProfile: "broken" },
    }), "utf8");

    await expect(repairRuntimeModelCatalogV109.up({
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: logger(),
    })).rejects.toMatchObject({
      code: "migration_config_invalid",
      migrationId: repairRuntimeModelCatalogV109.id,
      scope: "runtime-config",
    });
  });

  it("leaves the original migration pending until a config file appears", async () => {
    const root = await workspace();
    const configPath = path.join(root, "config.yaml");

    const deferred = await runMigrationsForTest(options(root, configPath), {
      definitions: [normalizeRuntimeModelCatalogV107],
    });
    expect(deferred).toMatchObject({
      applied: [],
      skipped: [],
      deferred: [normalizeRuntimeModelCatalogV107.id],
    });

    await fs.writeFile(configPath, YAML.stringify({
      providers: {
        openai: { apiBase: "https://api.example.test/v1", apiKey: "sk-legacy" },
      },
      agents: { defaults: { model: "openai/gpt-4.1" } },
    }), "utf8");

    const applied = await runMigrationsForTest(options(root, configPath), {
      definitions: [normalizeRuntimeModelCatalogV107],
    });
    expect(applied.applied.map((item) => item.id)).toEqual([normalizeRuntimeModelCatalogV107.id]);
    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.providers.openai).not.toHaveProperty("apiBase");
    expect(config.providers.openai.endpoints.chat).toMatchObject({
      apiBase: "https://api.example.test/v1",
      protocol: "openai-chat-completions",
    });
  });

  it("repairs a legacy field reintroduced after the v1.0.7 marker was written", async () => {
    const root = await workspace();
    const configPath = path.join(root, "config.yaml");
    await fs.writeFile(configPath, YAML.stringify({
      providers: {
        openai: { apiBase: "https://api.example.test/v1", apiKey: "sk-legacy" },
      },
      agents: { defaults: { model: "openai/gpt-4.1" } },
    }), "utf8");

    await runMigrationsForTest(options(root, configPath), {
      definitions: [normalizeRuntimeModelCatalogV107],
    });
    const current = YAML.parse(await fs.readFile(configPath, "utf8"));
    current.providers.openai.apiBase = "https://api.changed.test/v1/";
    current.providers.openai.apiType = "responses";
    await fs.writeFile(configPath, YAML.stringify(current), "utf8");

    const repaired = await runMigrationsForTest(options(root, configPath), {
      definitions: [normalizeRuntimeModelCatalogV107, repairRuntimeModelCatalogV109],
    });
    expect(repaired.skipped).toEqual([normalizeRuntimeModelCatalogV107.id]);
    expect(repaired.applied.map((item) => item.id)).toEqual([repairRuntimeModelCatalogV109.id]);

    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.providers.openai).not.toHaveProperty("apiBase");
    expect(config.providers.openai).not.toHaveProperty("apiType");
    expect(Object.values(config.providers.openai.endpoints)).toContainEqual(expect.objectContaining({
      apiBase: "https://api.changed.test/v1",
      protocol: "openai-responses",
    }));

    const repeated = await runMigrationsForTest(options(root, configPath), {
      definitions: [normalizeRuntimeModelCatalogV107, repairRuntimeModelCatalogV109],
    });
    expect(repeated.applied).toEqual([]);
    expect(repeated.skipped).toEqual([
      normalizeRuntimeModelCatalogV107.id,
      repairRuntimeModelCatalogV109.id,
    ]);
  });
});
