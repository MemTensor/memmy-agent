import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upgradeSummaryTimeoutV112 } from "../src/migrations/v1.1.2/0001-upgrade-summary-timeout.js";
import type { MigrationLogger } from "../src/types.js";

const temporaryDirectories: string[] = [];

function logger(): MigrationLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function fixture(config: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-summary-timeout-migration-"));
  temporaryDirectories.push(root);
  const configPath = path.join(root, "config.yaml");
  await fs.writeFile(configPath, YAML.stringify(config), "utf8");
  return { root, configPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("v1.1.2/0001-upgrade-summary-timeout", () => {
  it("upgrades the legacy 45-second summary timeout to 180 seconds", async () => {
    const { root, configPath } = await fixture({
      memmyMemory: {
        summary: { model: "gpt-main", timeoutMs: 45_000 },
        evolution: { timeoutMs: 45_000 },
      },
    });

    await expect(upgradeSummaryTimeoutV112.up({
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: logger(),
    })).resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });

    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.memmyMemory.summary).toEqual({ model: "gpt-main", timeoutMs: 180_000 });
    expect(config.memmyMemory.evolution.timeoutMs).toBe(45_000);
  });

  it("preserves a user-defined summary timeout", async () => {
    const { root, configPath } = await fixture({
      memmyMemory: { summary: { timeoutMs: 90_000 } },
    });

    await expect(upgradeSummaryTimeoutV112.up({
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: configPath,
      sessionDagDir: path.join(root, "session-dag"),
      logger: logger(),
    })).resolves.toEqual({ scanned: 1, changed: 0, ignored: 1 });

    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.memmyMemory.summary.timeoutMs).toBe(90_000);
  });
});
