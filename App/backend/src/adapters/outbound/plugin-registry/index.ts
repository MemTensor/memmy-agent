/** Trusted plugin registry boundary. */
import type { PluginManifest } from "@memmy/local-api-contracts";

export interface PluginArtifactDescriptor {
  url: string;
  sha256: string;
}

export interface PluginRelease {
  manifest: PluginManifest;
  artifact?: PluginArtifactDescriptor;
}

export interface PluginRegistry {
  resolve(pluginId: string, version?: string): Promise<PluginRelease>;
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
