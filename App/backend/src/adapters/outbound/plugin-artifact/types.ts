import type { PluginRelease } from "../plugin-registry/index.js";
import type { PluginRecord } from "../../../infrastructure/app-state-store/repositories/plugin-repo.js";

export interface PluginArtifactManager {
  install(release: PluginRelease): Promise<{ artifactHash: string | null; rootPath: string | null }>;
  remove(plugin: Pick<PluginRecord, "artifactHash" | "rootPath">): Promise<void>;
}
