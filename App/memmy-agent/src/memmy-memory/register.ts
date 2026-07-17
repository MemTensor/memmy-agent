import type { Config } from "../config/schema.js";
import { MemmyMemoryClient } from "./client.js";
import { resolveMemmyMemoryConfig } from "./config.js";
import { discoverMemmyMemoryConnection } from "./discovery.js";
import { MemmyMemoryHook } from "./hook.js";
import type { MemmyMemoryInstallOptions } from "./types.js";

export type MemmyMemoryIntegration = {
  enabled: boolean;
  client?: MemmyMemoryClient;
  hook?: MemmyMemoryHook;
};

export function createMemmyMemoryIntegration(
  config: Config | Record<string, any> | null | undefined,
  options: Omit<MemmyMemoryInstallOptions, "hooks"> = {},
): MemmyMemoryIntegration {
  const resolved = resolveMemmyMemoryConfig(config);
  if (!resolved.enabled) return { enabled: false };
  const connection = discoverMemmyMemoryConnection();
  const client = new MemmyMemoryClient(connection);
  const hook = new MemmyMemoryHook(client, {
    workspace: options.workspace ?? null,
    userId: resolved.userId,
  });
  void hook.initialize().catch((error) => {
    hook.lastError = error instanceof Error ? error.message : String(error);
  });
  return { enabled: true, client, hook };
}

export function installMemmyMemory(
  config: Config | Record<string, any> | null | undefined,
  options: MemmyMemoryInstallOptions = {},
): MemmyMemoryIntegration {
  const integration = createMemmyMemoryIntegration(config, options);
  if (integration.hook && Array.isArray(options.hooks)) options.hooks.push(integration.hook);
  return integration;
}
