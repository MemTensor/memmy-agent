/** Service urls module. */
import { resolveCloudServiceBaseUrl } from "@memmy/local-api-contracts";

export interface CloudClientConfig {
  /** Cloud API base URL. */
  baseUrl: string;
  /** Timeout ms. */
  timeoutMs: number;
}

/** Handles resolve cloud client config. */
export function resolveCloudClientConfig(env: NodeJS.ProcessEnv): CloudClientConfig {
  return {
    baseUrl: env.MEMMY_CLOUD_URL?.trim() || resolveCloudServiceBaseUrl(env.MEMMY_CLOUD_SERVICE),
    timeoutMs: Number.parseInt(env.MEMMY_CLOUD_TIMEOUT_MS ?? "5000", 10)
  };
}

/**
 * Resolves the base URL of the plugin registry.
 *
 * Entitlement-gated releases are served by the Cloud service itself, so the
 * registry defaults to the Cloud base URL instead of being configured (and
 * kept in sync) separately. `MEMMY_PLUGIN_REGISTRY_URL` overrides it, which is
 * what a loopback development registry uses.
 *
 * @param env process environment.
 * @returns the registry base URL, or undefined when no Cloud service is configured either.
 */
export function resolvePluginRegistryBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.MEMMY_PLUGIN_REGISTRY_URL?.trim();
  if (override) return override;
  try {
    return resolveCloudClientConfig(env).baseUrl;
  } catch {
    return undefined;
  }
}
