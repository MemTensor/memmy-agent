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
