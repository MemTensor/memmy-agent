/** Registry module. */
import { resolve } from "node:path";
import { createAgentAdapterDescriptor } from "./manifest.js";
import { createAgentAdapterPluginLoader, type AgentAdapterPluginLoader } from "./plugin-loader.js";
import { createDirectoryAgentAdapterPluginSource } from "./plugin-source.js";
import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  DetectAgentsInput,
  DetectedAgentSource
} from "./types/adapter.js";
import type { AgentKind } from "./types/domain.js";
import type { AgentAdapterPluginManifest, AgentAdapterPluginSource } from "./types/plugin.js";

// Contract for agent adapter registry.
export interface AgentAdapterRegistry {
  list(): Promise<AgentAdapterDescriptor[]>;
  get(kind: AgentKind): Promise<AgentAdapter>;
  detectAll(input: DetectAgentsInput): Promise<DetectedAgentSource[]>;
  reload(): Promise<void>;
}

export interface CreateAgentAdapterRegistryOptions {
  pluginSource: AgentAdapterPluginSource;
  pluginLoader?: AgentAdapterPluginLoader;
}

export interface CreateDefaultAgentAdapterRegistryOptions {
  pluginDirectories?: string[];
  pluginSource?: AgentAdapterPluginSource;
  pluginLoader?: AgentAdapterPluginLoader;
}

interface LoadedAgentAdapter {
  manifest: AgentAdapterPluginManifest;
  adapter: AgentAdapter;
}

/** Handles resolve builtin agent adapter plugin directory. */
export function resolveBuiltinAgentAdapterPluginDirectory(baseDirectory = import.meta.dirname): string {
  return resolve(baseDirectory, "./plugins");
}

/** Creates create default agent adapter registry. */
export function createDefaultAgentAdapterRegistry(
  options: CreateDefaultAgentAdapterRegistryOptions = {}
): AgentAdapterRegistry {
  const pluginSource =
    options.pluginSource ??
    createDirectoryAgentAdapterPluginSource({
      pluginDirectories: options.pluginDirectories ?? [resolveBuiltinAgentAdapterPluginDirectory()]
    });

  return createAgentAdapterRegistry({
    pluginSource,
    pluginLoader: options.pluginLoader
  });
}

/** Creates create agent adapter registry. */
export function createAgentAdapterRegistry(options: CreateAgentAdapterRegistryOptions): AgentAdapterRegistry {
  const pluginLoader = options.pluginLoader ?? createAgentAdapterPluginLoader();
  let loadedAdapters: LoadedAgentAdapter[] | undefined;

  /** Reads get loaded adapters. */
  async function getLoadedAdapters(): Promise<LoadedAgentAdapter[]> {
    loadedAdapters ??= await loadAdapters(options.pluginSource, pluginLoader);
    return loadedAdapters;
  }

  return {
    async list(): Promise<AgentAdapterDescriptor[]> {
      const adapters = await getLoadedAdapters();
      return adapters.map(({ manifest }) => createAgentAdapterDescriptor(manifest));
    },

    async get(kind: AgentKind): Promise<AgentAdapter> {
      const adapters = await getLoadedAdapters();
      const loaded = adapters.find(({ manifest }) => manifest.kind === kind);

      if (!loaded) {
        throw new Error(`Agent adapter is not registered: ${kind}`);
      }

      return loaded.adapter;
    },

    /**
     * Runs discovery on all adapters that declare detect support.
     */
    async detectAll(input: DetectAgentsInput): Promise<DetectedAgentSource[]> {
      const adapters = await getLoadedAdapters();
      const detectableAdapters = adapters.filter(({ manifest }) => manifest.capabilities.detect);
      const detected = await Promise.all(
        detectableAdapters.map(({ adapter }) => adapter.detect(input))
      );

      return detected.flat();
    },

    /**
     * Re-reads the plugin source and rebuilds the adapter cache.
     */
    async reload(): Promise<void> {
      loadedAdapters = await loadAdapters(options.pluginSource, pluginLoader);
    }
  };
}

/**
 * Loads all enabled adapters from the plugin source and checks for duplicate ids/kinds.
 */
async function loadAdapters(
  pluginSource: AgentAdapterPluginSource,
  pluginLoader: AgentAdapterPluginLoader
): Promise<LoadedAgentAdapter[]> {
  const manifests = (await pluginSource.loadManifests()).filter((manifest) => manifest.enabled);
  assertUniquePluginFields(manifests);

  return Promise.all(
    manifests.map(async (manifest) => ({
      manifest,
      adapter: await pluginLoader.loadAdapter(manifest)
    }))
  );
}

/**
 * Validates that neither the id nor the kind of enabled plugins is duplicated.
 */
function assertUniquePluginFields(manifests: AgentAdapterPluginManifest[]): void {
  assertUnique(manifests, "id", (manifest) => manifest.id);
  assertUnique(manifests, "kind", (manifest) => manifest.kind);
}

/**
 * Generic uniqueness-validation helper.
 */
function assertUnique(
  manifests: AgentAdapterPluginManifest[],
  fieldName: string,
  getValue: (manifest: AgentAdapterPluginManifest) => string
): void {
  const seen = new Set<string>();

  for (const manifest of manifests) {
    const value = getValue(manifest);

    if (seen.has(value)) {
      throw new Error(`Duplicate Agent Adapter plugin ${fieldName}: ${value}`);
    }

    seen.add(value);
  }
}
