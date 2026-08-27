/** Registry tests. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInMemoryAgentAdapterPluginSource } from "../plugin-source.js";
import { createAgentAdapterRegistry } from "../registry.js";
import type {
  AgentAdapter,
  AgentAdapterPluginManifest,
  AgentAdapterPluginSource
} from "../types/index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("agent adapter registry", () => {
  it("uses the dynamic plugin loader when no loader is injected", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapter-registry-"));
    mkdirSync(tempDir, { recursive: true });
    const modulePath = join(tempDir, "plugin.mjs");
    writeFileSync(
      modulePath,
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
    const manifest = {
      ...createManifest("cursor", true),
      modulePath: pathToFileURL(modulePath).href
    };
    const registry = createAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([manifest])
    });

    await expect(registry.get("cursor")).resolves.toMatchObject({ kind: "cursor" });
  });

  it("loads plugin adapters lazily and exposes descriptors", async () => {
    const cursor = createManifest("cursor", true);
    const codex = createManifest("codex", false);
    const loader = createCountingLoader([cursor, codex]);
    const registry = createAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([cursor, codex]),
      pluginLoader: loader
    });

    expect(loader.loadCount).toBe(0);
    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({ id: "codex", capabilities: expect.objectContaining({ detect: false }) }),
      expect.objectContaining({ id: "cursor", capabilities: expect.objectContaining({ detect: true }) })
    ]);
    await expect(registry.get("cursor")).resolves.toMatchObject({ kind: "cursor" });
    expect(loader.loadCount).toBe(2);
  });

  it("runs detect on detectable adapters only", async () => {
    const cursor = createManifest("cursor", true);
    const codex = createManifest("codex", false);
    const registry = createAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([cursor, codex]),
      pluginLoader: createCountingLoader([cursor, codex])
    });

    await expect(registry.detectAll({ homeDir: "/home/user" })).resolves.toEqual([
      {
        kind: "cursor",
        displayName: "cursor",
        rootPath: "/home/user/cursor"
      }
    ]);
  });

  it("reloads manifests and adapters", async () => {
    const cursor = createManifest("cursor", true);
    const codex = createManifest("codex", true);
    const pluginSource = createMutablePluginSource([cursor]);
    const loader = createCountingLoader([cursor, codex]);
    const registry = createAgentAdapterRegistry({
      pluginSource,
      pluginLoader: loader
    });

    await expect(registry.list()).resolves.toHaveLength(1);
    pluginSource.setManifests([codex]);
    await registry.reload();
    await expect(registry.list()).resolves.toEqual([expect.objectContaining({ id: "codex" })]);
    expect(loader.loadCount).toBe(2);
  });

  it("rejects missing adapters", async () => {
    const registry = createAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([]),
      pluginLoader: createCountingLoader([])
    });

    await expect(registry.get("cursor")).rejects.toThrow("Agent adapter is not registered: cursor");
  });

  it("rejects enabled duplicate plugin ids", async () => {
    const registry = createAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([
        createManifest("cursor", true, "duplicate"),
        createManifest("codex", true, "duplicate")
      ]),
      pluginLoader: createCountingLoader([])
    });

    await expect(registry.list()).rejects.toThrow("Duplicate Agent Adapter plugin id: duplicate");
  });

  it("rejects enabled duplicate plugin kinds", async () => {
    const registry = createAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([
        createManifest("cursor", true, "cursor-a"),
        createManifest("cursor", true, "cursor-b")
      ]),
      pluginLoader: createCountingLoader([])
    });

    await expect(registry.list()).rejects.toThrow("Duplicate Agent Adapter plugin kind: cursor");
  });

  it("ignores disabled plugins during loading and duplicate checks", async () => {
    const enabled = createManifest("cursor", true, "cursor");
    const disabled = { ...createManifest("cursor", true, "cursor-disabled"), enabled: false };
    const loader = createCountingLoader([enabled]);
    const registry = createAgentAdapterRegistry({
      pluginSource: createInMemoryAgentAdapterPluginSource([enabled, disabled]),
      pluginLoader: loader
    });

    await expect(registry.list()).resolves.toEqual([expect.objectContaining({ id: "cursor" })]);
    expect(loader.loadCount).toBe(1);
  });
});

/** Creates create manifest. */
function createManifest(
  kind: "cursor" | "codex",
  canDetect: boolean,
  id: string = kind
): AgentAdapterPluginManifest {
  return {
    id,
    kind,
    displayName: kind,
    version: "1.0.0",
    modulePath: `${kind}.js`,
    enabled: true,
    priority: kind === "codex" ? 10 : 0,
    capabilities: {
      detect: canDetect,
      scan: true,
      installSkill: true,
      removeSkill: true
    }
  };
}

/**
 * Builds a plugin loader that tracks the number of loads.
 */
function createCountingLoader(manifests: AgentAdapterPluginManifest[]) {
  let loadCount = 0;
  const adapters = new Map(manifests.map((manifest) => [manifest.id, createAdapter(manifest)]));

  return {
    get loadCount() {
      return loadCount;
    },
    /**
     * Counts the number of loads and returns a test adapter matching the plugin manifest.
     */
    async loadAdapter(manifest: AgentAdapterPluginManifest) {
      loadCount += 1;
      const adapter = adapters.get(manifest.id);
      if (!adapter) {
        throw new Error(`Missing test adapter: ${manifest.id}`);
      }

      return adapter;
    }
  };
}

/**
 * Builds a test adapter from the plugin manifest, with detect emitting an assertable path.
 */
function createAdapter(manifest: AgentAdapterPluginManifest): AgentAdapter {
  return {
    kind: manifest.kind,
    descriptor: {
      id: manifest.id,
      kind: manifest.kind,
      displayName: manifest.displayName,
      version: manifest.version,
      capabilities: manifest.capabilities
    },
    /**
     * Emits a discovery result containing homeDir and kind, making dispatch behavior easy to assert.
     */
    async detect(input) {
      return [
        {
          kind: manifest.kind,
          displayName: manifest.displayName,
          rootPath: `${input.homeDir}/${manifest.kind}`
        }
      ];
    },
    /**
     * The test adapter validates successfully by default.
     */
    async validateSource() {
      return { valid: true };
    },
    /**
     * The test adapter emits no scan records by default.
     */
    async *scan() {
      return undefined;
    },
    /**
     * The test adapter installs successfully by default.
     */
    async installSkill() {
      return { installed: true };
    },
    /**
     * The test adapter removes successfully by default.
     */
    async removeSkill() {
      return { removed: true };
    }
  };
}

/**
 * Builds a mutable plugin source for verifying reload behavior.
 */
function createMutablePluginSource(initialManifests: AgentAdapterPluginManifest[]) {
  let manifests = initialManifests;
  const source: AgentAdapterPluginSource & {
    setManifests(nextManifests: AgentAdapterPluginManifest[]): void;
  } = {
    /**
     * Returns the current list of plugin manifests.
     */
    async loadManifests() {
      return manifests;
    },
    /**
     * Replaces the list of plugin manifests, simulating a change in the plugin source.
     */
    setManifests(nextManifests) {
      manifests = nextManifests;
    }
  };

  return source;
}
