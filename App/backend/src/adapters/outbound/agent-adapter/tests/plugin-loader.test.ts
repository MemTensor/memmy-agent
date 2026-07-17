/** Plugin loader tests. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentAdapterPluginLoader,
  createDynamicImportModuleLoader
} from "../plugin-loader.js";
import type {
  AgentAdapter,
  AgentAdapterModuleLoader,
  AgentAdapterPluginManifest
} from "../types/index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("agent adapter plugin loader", () => {
  it("loads an adapter from a named factory export", async () => {
    const manifest = createManifest("cursor");
    const loader = createAgentAdapterPluginLoader({
      moduleLoader: createFakeModuleLoader({
        createAdapter: () => createAdapter(manifest)
      })
    });

    await expect(loader.loadAdapter(manifest)).resolves.toMatchObject({
      kind: "cursor"
    });
  });

  it("loads an adapter from a default function export", async () => {
    const manifest = createManifest("codex");
    const loader = createAgentAdapterPluginLoader({
      moduleLoader: createFakeModuleLoader({
        default: () => createAdapter(manifest)
      })
    });

    await expect(loader.loadAdapter(manifest)).resolves.toMatchObject({
      kind: "codex"
    });
  });

  it("loads an adapter from a default object factory export", async () => {
    const manifest = createManifest("custom");
    const loader = createAgentAdapterPluginLoader({
      moduleLoader: createFakeModuleLoader({
        default: {
          createAdapter: () => createAdapter(manifest)
        }
      })
    });

    await expect(loader.loadAdapter(manifest)).resolves.toMatchObject({
      kind: "custom"
    });
  });

  it("loads modules through dynamic import", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-adapter-module-"));
    const modulePath = join(tempDir, "plugin.mjs");
    writeFileSync(modulePath, "export const marker = 'loaded';\n");

    await expect(createDynamicImportModuleLoader().importModule(pathToFileURL(modulePath).href)).resolves.toMatchObject({
      marker: "loaded"
    });
  });

  it("rejects modules without a plugin factory", async () => {
    const manifest = createManifest("cursor");
    const loader = createAgentAdapterPluginLoader({
      moduleLoader: createFakeModuleLoader({})
    });

    await expect(loader.loadAdapter(manifest)).rejects.toThrow("must export createAdapter");
  });

  it("rejects non-object plugin modules", async () => {
    const manifest = createManifest("cursor");
    const loader = createAgentAdapterPluginLoader({
      moduleLoader: createFakeModuleLoader(undefined)
    });

    await expect(loader.loadAdapter(manifest)).rejects.toThrow("must be an object");
  });

  it("rejects adapters with a different kind than the manifest", async () => {
    const manifest = createManifest("cursor");
    const wrongManifest = createManifest("codex");
    const loader = createAgentAdapterPluginLoader({
      moduleLoader: createFakeModuleLoader({
        createAdapter: () => createAdapter(wrongManifest)
      })
    });

    await expect(loader.loadAdapter(manifest)).rejects.toThrow("created kind codex, expected cursor");
  });

  it("rejects adapters with a different descriptor id than the manifest", async () => {
    const manifest = createManifest("cursor");
    const loader = createAgentAdapterPluginLoader({
      moduleLoader: createFakeModuleLoader({
        createAdapter: () => ({
          ...createAdapter(manifest),
          descriptor: {
            ...createAdapter(manifest).descriptor,
            id: "other"
          }
        })
      })
    });

    await expect(loader.loadAdapter(manifest)).rejects.toThrow("created descriptor id other");
  });
});

/** Creates create fake module loader. */
function createFakeModuleLoader(moduleValue: unknown): AgentAdapterModuleLoader {
  return {
    async importModule() {
      return moduleValue;
    }
  };
}

/** Creates create manifest. */
function createManifest(kind: "cursor" | "codex" | "custom"): AgentAdapterPluginManifest {
  return {
    id: kind,
    kind,
    displayName: kind,
    version: "1.0.0",
    modulePath: `${kind}.js`,
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

/**
 * Builds a test adapter from the plugin manifest that satisfies the validation rules.
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
     * The test adapter produces no discovery results.
     */
    async detect() {
      return [];
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
