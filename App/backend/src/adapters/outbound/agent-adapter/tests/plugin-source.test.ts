/** Plugin source tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_ADAPTER_PLUGIN_MANIFEST,
  createDirectoryAgentAdapterPluginSource,
  createInMemoryAgentAdapterPluginSource,
  nodePluginFileSystem,
  type AgentAdapterPluginFileSystem
} from "../plugin-source.js";
import type { AgentAdapterPluginManifest } from "../types/index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("agent adapter plugin sources", () => {
  it("returns sorted copies from the in-memory plugin source", async () => {
    const lowPriority = createManifest("cursor", 1);
    const highPriority = createManifest("codex", 10);
    const custom = { ...createManifest("custom", 10), id: "alpha", kind: "custom" as const };
    const source = createInMemoryAgentAdapterPluginSource([lowPriority, highPriority, custom]);

    const manifests = await source.loadManifests();
    manifests.pop();

    expect(manifests.map((manifest) => manifest.id)).toEqual(["alpha", "codex"]);
    expect((await source.loadManifests()).map((manifest) => manifest.id)).toEqual(["alpha", "codex", "cursor"]);
  });

  it("loads nested and file-based manifests from plugin directories", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapters-"));
    const cursorDir = join(tempDir, "cursor");
    const pluginModuleDir = join(tempDir, "modules");
    mkdirSync(cursorDir);
    mkdirSync(pluginModuleDir);
    writeFileSync(join(tempDir, "ignored.txt"), "not a manifest");
    writeFileSync(
      join(cursorDir, AGENT_ADAPTER_PLUGIN_MANIFEST),
      JSON.stringify(createManifest("cursor", 1, "./cursor.js"))
    );
    writeFileSync(
      join(tempDir, "codex.agent-adapter.json"),
      JSON.stringify(createManifest("codex", 5, "./modules/codex.js"))
    );

    const source = createDirectoryAgentAdapterPluginSource({
      pluginDirectories: [tempDir]
    });

    await expect(nodePluginFileSystem.readText(join(tempDir, "ignored.txt"))).resolves.toBe("not a manifest");
    await expect(nodePluginFileSystem.readDirectory(tempDir)).resolves.toEqual(
      expect.arrayContaining([
        { name: "cursor", isDirectory: true },
        { name: "codex.agent-adapter.json", isDirectory: false }
      ])
    );
    await expect(source.loadManifests()).resolves.toMatchObject([
      {
        id: "codex",
        modulePath: resolve(tempDir, "modules/codex.js")
      },
      {
        id: "cursor",
        modulePath: resolve(cursorDir, "cursor.js")
      }
    ]);
  });

  it("reports invalid JSON with the manifest path", async () => {
    const fileSystem: AgentAdapterPluginFileSystem = {
      async readDirectory() {
        return [{ name: "broken.agent-adapter.json", isDirectory: false }];
      },
      async readText() {
        return "{";
      }
    };
    const source = createDirectoryAgentAdapterPluginSource({
      pluginDirectories: ["/plugins"],
      fileSystem
    });

    await expect(source.loadManifests()).rejects.toThrow("Failed to parse /plugins/broken.agent-adapter.json");
  });

  it("rethrows non-missing manifest read errors", async () => {
    const fileSystem: AgentAdapterPluginFileSystem = {
      async readDirectory() {
        return [{ name: "blocked.agent-adapter.json", isDirectory: false }];
      },
      async readText() {
        const error = new Error("blocked") as Error & { code: string };
        error.code = "EACCES";
        throw error;
      }
    };
    const source = createDirectoryAgentAdapterPluginSource({
      pluginDirectories: ["/plugins"],
      fileSystem
    });

    await expect(source.loadManifests()).rejects.toThrow("blocked");
  });

  it("rethrows non-missing plugin directory read errors", async () => {
    const fileSystem: AgentAdapterPluginFileSystem = {
      async readDirectory() {
        const error = new Error("directory blocked") as Error & { code: string };
        error.code = "EACCES";
        throw error;
      },
      async readText() {
        throw new Error("unexpected read");
      }
    };
    const source = createDirectoryAgentAdapterPluginSource({
      pluginDirectories: ["/plugins"],
      fileSystem
    });

    await expect(source.loadManifests()).rejects.toThrow("directory blocked");
  });
});

/** Creates create manifest. */
function createManifest(
  id: "cursor" | "codex" | "custom",
  priority: number,
  modulePath = "./plugin.js"
): AgentAdapterPluginManifest {
  return {
    id,
    kind: id,
    displayName: id,
    version: "1.0.0",
    modulePath,
    enabled: true,
    priority,
    capabilities: {
      detect: true,
      scan: true,
      installSkill: true,
      removeSkill: true
    }
  };
}
