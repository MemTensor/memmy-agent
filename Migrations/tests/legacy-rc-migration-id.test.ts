import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { removeLegacyMemoryEmbeddingV119 } from "../src/migrations/v1.1.9/0001-remove-legacy-memory-embedding.js";
import { renameMemmyComputerUseMcpV119 } from "../src/migrations/v1.1.9/0002-rename-memmy-computer-use-mcp.js";
import { runMigrationsForTest } from "../src/runner.js";
import { getMigrationStatePaths, readMigrationState, runtimeConfigTargetKey } from "../src/state-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("upgrade from the old rc Computer Use migration id", () => {
  it.each([true, false])("applies both current migrations after an old rc record (already renamed=%s)", async (alreadyRenamed) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-legacy-rc-upgrade-"));
    roots.push(root);
    const configPath = path.join(root, "config.yaml");
    const server = { type: "stdio", command: "open-computer-use", args: ["mcp"], env: { CUSTOM_SETTING: "preserve" } };
    await fs.writeFile(configPath, YAML.stringify({
      tools: { mcpServers: { [alreadyRenamed ? "memmy_computer_use" : "open_computer_use"]: server } },
      memmyMemory: { embedding: { provider: "local" }, activeProfile: "byok", profiles: { byok: { embedding: { provider: "local" } } } },
    }));
    const paths = getMigrationStatePaths(root);
    await fs.mkdir(paths.directory, { recursive: true });
    const legacyId = "v1.1.9/0001-rename-memmy-computer-use-mcp";
    await fs.writeFile(paths.file, JSON.stringify({
      formatVersion: 2, scope: "agent-workspace", applied: [{
        id: legacyId, introducedIn: "1.1.9", appliedAt: "2026-10-09T00:00:00.000Z",
        target: { type: "runtime-config", key: runtimeConfigTargetKey(configPath) },
      }],
    }));
    const definitions = [removeLegacyMemoryEmbeddingV119, renameMemmyComputerUseMcpV119];
    const options = {
      targets: { agentWorkspace: root, runtimeConfigFile: configPath, sessionDagDir: path.join(root, "session-dag") },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const first = await runMigrationsForTest(options, { definitions });
    expect(first.applied.map((item) => item.id)).toEqual(definitions.map((definition) => definition.id));
    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.tools.mcpServers).toEqual({ memmy_computer_use: server });
    expect(config.memmyMemory.embedding).toBeUndefined();
    expect(config.memmyMemory.profiles.byok.embedding).toEqual({ provider: "local" });
    const state = await readMigrationState(paths.file, definitions);
    expect(state.applied.map((item) => item.id)).toEqual([legacyId, ...definitions.map((definition) => definition.id)]);
    const second = await runMigrationsForTest(options, { definitions });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(definitions.map((definition) => definition.id));
  });
});
