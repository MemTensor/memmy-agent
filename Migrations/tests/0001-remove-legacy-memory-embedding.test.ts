import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeLegacyMemoryEmbeddingV119 } from "../src/migrations/v1.1.9/0001-remove-legacy-memory-embedding.js";
import type { MigrationLogger } from "../src/types.js";

const temporaryDirectories: string[] = [];

function logger(): MigrationLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function fixture(config: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-remove-embedding-migration-"));
  temporaryDirectories.push(root);
  const configPath = path.join(root, "config.yaml");
  await fs.writeFile(configPath, YAML.stringify(config), "utf8");
  return { root, configPath };
}

function context(root: string, configPath: string) {
  return {
    profileWorkspace: root,
    sessionsDir: path.join(root, "sessions"),
    runtimeConfigFile: configPath,
    sessionDagDir: path.join(root, "session-dag"),
    logger: logger(),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("v1.1.9/0001-remove-legacy-memory-embedding", () => {
  it("removes memmyMemory.embedding while preserving the rest of the config", async () => {
    const { root, configPath } = await fixture({
      app: { userMode: "byok" },
      memmyMemory: {
        embedding: { mode: "local", provider: "local" },
        storage: { sqlitePath: "/tmp/memory.sqlite" },
      },
    });

    await expect(removeLegacyMemoryEmbeddingV119.up(context(root, configPath))).resolves.toEqual({
      scanned: 1,
      changed: 1,
      ignored: 0,
    });

    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.memmyMemory.embedding).toBeUndefined();
    expect(config.memmyMemory.storage).toEqual({ sqlitePath: "/tmp/memory.sqlite" });
  });

  it("is idempotent when the legacy field is already absent", async () => {
    const { root, configPath } = await fixture({ memmyMemory: { enabled: true } });

    await expect(removeLegacyMemoryEmbeddingV119.up(context(root, configPath))).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
  });
});
