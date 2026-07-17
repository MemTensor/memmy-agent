/** Plugin loader module. */
import type { AgentAdapter } from "./types/adapter.js";
import type {
  AgentAdapterModuleLoader,
  AgentAdapterPluginFactory,
  AgentAdapterPluginManifest,
  AgentAdapterPluginModule
} from "./types/plugin.js";

export function createDynamicImportModuleLoader(): AgentAdapterModuleLoader {
  return {
    async importModule(modulePath: string) {
      return import(modulePath);
    }
  };
}

export interface AgentAdapterPluginLoader {
  loadAdapter(manifest: AgentAdapterPluginManifest): Promise<AgentAdapter>;
}

export interface CreateAgentAdapterPluginLoaderOptions {
  moduleLoader?: AgentAdapterModuleLoader;
}

/** Creates create agent adapter plugin loader. */
export function createAgentAdapterPluginLoader(
  options: CreateAgentAdapterPluginLoaderOptions = {}
): AgentAdapterPluginLoader {
  const moduleLoader = options.moduleLoader ?? createDynamicImportModuleLoader();

  return {
    async loadAdapter(manifest) {
      const moduleValue = await moduleLoader.importModule(manifest.modulePath);
      const createAdapter = resolvePluginFactory(moduleValue, manifest.modulePath);
      const adapter = await createAdapter({ manifest });

      validateAdapter(manifest, adapter);
      return adapter;
    }
  };
}

/** Handles resolve plugin factory. */
function resolvePluginFactory(moduleValue: unknown, modulePath: string): AgentAdapterPluginFactory {
  const moduleRecord = asPluginModule(moduleValue, modulePath);

  if (typeof moduleRecord.createAdapter === "function") {
    return moduleRecord.createAdapter;
  }

  if (typeof moduleRecord.default === "function") {
    return moduleRecord.default;
  }

  if (isObjectWithFactory(moduleRecord.default)) {
    return moduleRecord.default.createAdapter;
  }

  throw new Error(`Agent adapter plugin module ${modulePath} must export createAdapter`);
}

/**
 * Validates that the adapter created by the plugin factory matches the manifest declaration.
 */
function validateAdapter(manifest: AgentAdapterPluginManifest, adapter: AgentAdapter): void {
  if (adapter.kind !== manifest.kind) {
    throw new Error(
      `Agent adapter plugin ${manifest.id} created kind ${adapter.kind}, expected ${manifest.kind}`
    );
  }

  if (adapter.descriptor.id !== manifest.id) {
    throw new Error(
      `Agent adapter plugin ${manifest.id} created descriptor id ${adapter.descriptor.id}`
    );
  }
}

/**
 * Narrows the dynamic import result to a plugin module object.
 */
function asPluginModule(moduleValue: unknown, modulePath: string): AgentAdapterPluginModule {
  if (typeof moduleValue === "object" && moduleValue !== null) {
    return moduleValue as AgentAdapterPluginModule;
  }

  throw new Error(`Agent adapter plugin module ${modulePath} must be an object`);
}

/**
 * Determines whether the default export is an object with a createAdapter function.
 */
function isObjectWithFactory(value: unknown): value is { createAdapter: AgentAdapterPluginFactory } {
  return (
    typeof value === "object" &&
    value !== null &&
    "createAdapter" in value &&
    typeof value.createAdapter === "function"
  );
}
