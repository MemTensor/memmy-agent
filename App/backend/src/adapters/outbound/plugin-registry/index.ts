/** Trusted plugin registry boundary. */
import type { PluginManifest } from "@memmy/local-api-contracts";

export type PluginArtifactDescriptor = {
  sha256: string;
} & (
  | { url: string; localPath?: never }
  | { localPath: string; url?: never }
);

export interface PluginRelease {
  manifest: PluginManifest;
  artifact?: PluginArtifactDescriptor;
}

export interface PluginRegistry {
  resolve(pluginId: string, version?: string): Promise<PluginRelease>;
}

export { createHttpPluginRegistry, type CreateHttpPluginRegistryOptions } from "./http-plugin-registry.js";
export {
  loadBundledPluginCatalog,
  type BundledPluginCatalog,
  type BundledPluginRelease
} from "./bundled-plugin-registry.js";

/** Resolves bundled releases first while retaining an optional development registry fallback. */
export function createCompositePluginRegistry(
  primary: PluginRegistry,
  fallback?: PluginRegistry
): PluginRegistry {
  return {
    async resolve(pluginId, version) {
      try {
        return await primary.resolve(pluginId, version);
      } catch (error) {
        if (!fallback || (error as { code?: unknown })?.code !== "not_found") throw error;
        return fallback.resolve(pluginId, version);
      }
    }
  };
}

export function createInMemoryPluginRegistry(releases: PluginRelease[]): PluginRegistry {
  return {
    async resolve(pluginId, version) {
      const matches = releases.filter((release) =>
        release.manifest.id === pluginId && (!version || release.manifest.version === version)
      );
      const release = matches.at(-1);
      if (!release) {
        throw Object.assign(new Error(`Plugin release not found: ${pluginId}${version ? `@${version}` : ""}`), {
          code: "not_found" as const
        });
      }
      return structuredClone(release);
    }
  };
}
