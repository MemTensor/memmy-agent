/** Registry initialization tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_ADAPTER_PLUGIN_MANIFEST,
  createInMemoryAgentAdapterPluginSource,
  createDefaultAgentAdapterRegistry,
  resolveBuiltinAgentAdapterPluginDirectory
} from "../index.js";
import type { AgentAdapterPluginManifest } from "../types/index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("default agent adapter registry", () => {
  it("resolves the built-in plugin directory from a base directory", () => {
    expect(resolveBuiltinAgentAdapterPluginDirectory("/memmy/dist/src/adapters/outbound/agent-adapter")).toBe(
      "/memmy/dist/src/adapters/outbound/agent-adapter/plugins"
    );
  });

  it("initializes with the built-in plugin directory by default", async () => {
    const registry = createDefaultAgentAdapterRegistry();

    await expect(registry.list()).resolves.toEqual([]);
  });

  it("initializes with an injected plugin source", async () => {
    const registry = createDefaultAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([])
    });

    await expect(registry.list()).resolves.toEqual([]);
  });

  it("initializes from an empty plugin directory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapter-empty-"));
    const registry = createDefaultAgentAdapterRegistry({
      pluginDirectories: [tempDir]
    });

    await expect(registry.list()).resolves.toEqual([]);
  });

  it("initializes from a missing plugin directory", async () => {
    const registry = createDefaultAgentAdapterRegistry({
      pluginDirectories: [join(tmpdir(), `memmy-agent-adapter-missing-${Date.now()}`)]
    });

    await expect(registry.list()).resolves.toEqual([]);
  });

  it("initializes with a valid plugin", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapter-valid-"));
    writePlugin(tempDir, createManifest("cursor"));
    const registry = createDefaultAgentAdapterRegistry({
      pluginDirectories: [tempDir]
    });

    await expect(registry.list()).resolves.toEqual([
      {
        id: "cursor",
        kind: "cursor",
        displayName: "cursor",
        version: "1.0.0",
        capabilities: {
          detect: true,
          scan: true,
          installSkill: true,
          removeSkill: true
        }
      }
    ]);
  });

  it("ignores disabled plugins during initialization", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapter-disabled-"));
    writeManifestOnly(tempDir, {
      ...createManifest("cursor"),
      enabled: false,
      modulePath: "./missing-plugin.mjs"
    });
    const registry = createDefaultAgentAdapterRegistry({
      pluginDirectories: [tempDir]
    });

    await expect(registry.list()).resolves.toEqual([]);
  });

  it("rejects duplicate plugin ids", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapter-duplicate-id-"));
    writeTopLevelManifest(tempDir, "duplicate-a.agent-adapter.json", createManifest("cursor", "duplicate"));
    writeTopLevelManifest(tempDir, "duplicate-b.agent-adapter.json", createManifest("codex", "duplicate"));
    const registry = createDefaultAgentAdapterRegistry({
      pluginDirectories: [tempDir]
    });

    await expect(registry.list()).rejects.toThrow("Duplicate Agent Adapter plugin id: duplicate");
  });

  it("rejects duplicate plugin kinds", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapter-duplicate-kind-"));
    writeManifestOnly(tempDir, createManifest("cursor", "cursor-a"));
    writeManifestOnly(tempDir, createManifest("cursor", "cursor-b"));
    const registry = createDefaultAgentAdapterRegistry({
      pluginDirectories: [tempDir]
    });

    await expect(registry.list()).rejects.toThrow("Duplicate Agent Adapter plugin kind: cursor");
  });
});

/**
 * Writes a complete, loadable plugin.
 */
function writePlugin(pluginDirectory: string, manifest: AgentAdapterPluginManifest): void {
  writeManifestOnly(pluginDirectory, manifest);
  writeFileSync(
    join(pluginDirectory, manifest.id, "plugin.mjs"),
    `
      export function createAdapter({ manifest }) {
        return {
          kind: manifest.kind,
          descriptor: {
            id: manifest.id,
            kind: manifest.kind,
            displayName: manifest.displayName,
            version: manifest.version,
            capabilities: manifest.capabilities
          },
          async detect() { return []; },
          async validateSource() { return { valid: true }; },
          async *scan() {},
          async installSkill() { return { installed: true }; },
          async removeSkill() { return { removed: true }; }
        };
      }
    `
  );
}

/**
 * Writes only the plugin manifest, for the disabled and duplicate-declaration scenarios.
 */
function writeManifestOnly(pluginDirectory: string, manifest: AgentAdapterPluginManifest): void {
  const adapterDirectory = join(pluginDirectory, manifest.id);
  mkdirSync(adapterDirectory, { recursive: true });
  writeFileSync(join(adapterDirectory, AGENT_ADAPTER_PLUGIN_MANIFEST), JSON.stringify(manifest));
}

/**
 * Writes a top-level plugin manifest file, for the scenario where plugins with the same id cannot share a directory name.
 */
function writeTopLevelManifest(
  pluginDirectory: string,
  fileName: string,
  manifest: AgentAdapterPluginManifest
): void {
  writeFileSync(join(pluginDirectory, fileName), JSON.stringify(manifest));
}

/**
 * Builds a plugin manifest for the initialization tests.
 */
function createManifest(kind: "cursor" | "codex", id = kind): AgentAdapterPluginManifest {
  return {
    id,
    kind,
    displayName: kind,
    version: "1.0.0",
    modulePath: "./plugin.mjs",
    enabled: true,
    priority: 0,
    capabilities: {
      detect: true,
      scan: true,
      installSkill: true,
      removeSkill: true
    }
  };
}
