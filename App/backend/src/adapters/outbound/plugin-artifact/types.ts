import type { PluginRelease } from "../plugin-registry/index.js";

export interface PluginArtifactLocation {
  artifactHash: string | null;
  rootPath: string | null;
}

export interface PluginArtifactManager {
  install(release: PluginRelease): Promise<PluginArtifactLocation>;
  remove(plugin: PluginArtifactLocation): Promise<void>;
}
