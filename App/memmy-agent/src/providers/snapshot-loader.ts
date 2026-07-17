import { loadConfig, resolveConfigEnvVars } from "../config/loader.js";
import type { ImageGenerationToolConfig } from "../config/schema.js";
import { buildProviderSnapshot, type ProviderSnapshot } from "./factory.js";

export interface ReloadingProviderSnapshotLoaderOptions {
  /**
   * Fixed config file path; when omitted, each call reads the current default config path.
   */
  configPath?: string | null;
}

export type ProviderSnapshotLoader = (opts?: any) => ProviderSnapshot;
export type ToolsSnapshotLoader = () => { imageGeneration: ImageGenerationToolConfig };

/**
 * Create a provider snapshot loader that rereads the config file on every call.
 *
 * @param options Config file path options.
 * @returns Provider snapshot loader.
 */
export function makeReloadingProviderSnapshotLoader(
  options: ReloadingProviderSnapshotLoaderOptions = {},
): ProviderSnapshotLoader {
  const configPath = options.configPath ?? null;
  return (opts = {}) => {
    const config = resolveConfigEnvVars(loadConfig(configPath));
    return buildProviderSnapshot(config, opts);
  };
}

export function makeReloadingToolsSnapshotLoader(
  options: ReloadingProviderSnapshotLoaderOptions = {},
): ToolsSnapshotLoader {
  const configPath = options.configPath ?? null;
  return () => {
    const config = resolveConfigEnvVars(loadConfig(configPath));
    return { imageGeneration: config.tools.imageGeneration };
  };
}
