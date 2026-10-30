import type { Config } from "../config/schema.js";
import { AgentHookContext } from "../core/agent-runtime/hook.js";
import {
  resolveAnalyticsUserModeFromConfig,
  resolveLiveAnalyticsUserMode,
  resolveLiveLoggedInAnalyticsUserId,
  resolveLoggedInAnalyticsUserId,
} from "../analytics/cloud-analytics.js";
import { MemmyMemoryClient } from "./client.js";
import { resolveMemmyMemoryConfig } from "./config.js";
import { discoverMemmyMemoryConnection } from "./discovery.js";
import { MemmyMemoryHook } from "./hook.js";
import { L3UserProjectSync } from "./l3-user-project-sync.js";
import type { MemmyMemoryInstallOptions } from "./types.js";
import { getStandaloneTaskWorkspacesDir } from "../config/paths.js";
import type { WebuiProjectRegistrySnapshot } from "../entrypoints/frontend-bridge/projects.js";

export type MemmyMemoryIntegration = {
  enabled: boolean;
  client?: MemmyMemoryClient;
  hook?: MemmyMemoryHook;
  dispose?: () => Promise<void>;
  closeSession?: (sessionKey: string, reason?: string) => Promise<void>;
  /** Starts pushing the desktop project registry to Memory for L3 project recognition. */
  startL3UserProjectSync?: (readProjects: () => WebuiProjectRegistrySnapshot) => void;
};

export {
  resolveAnalyticsUserModeFromConfig,
  resolveLiveAnalyticsUserMode,
  resolveLiveLoggedInAnalyticsUserId,
  resolveLoggedInAnalyticsUserId,
};

export function createMemmyMemoryIntegration(
  config: Config | Record<string, any> | null | undefined,
  options: Omit<MemmyMemoryInstallOptions, "hooks"> = {},
): MemmyMemoryIntegration {
  const resolved = resolveMemmyMemoryConfig(config);
  if (!resolved.enabled) return { enabled: false };
  const defaults = config && typeof config === "object"
    ? (config as Record<string, any>).agents?.defaults
    : undefined;
  const connection = {
    ...discoverMemmyMemoryConnection(),
    timeZone: typeof defaults?.timezone === "string" ? defaults.timezone : undefined
  };
  const client = new MemmyMemoryClient(connection);
  const hook = new MemmyMemoryHook(client, {
    workspace: options.workspace ?? null,
    userId: resolved.userId,
    retrievalLayers: resolved.retrievalLayers,
    // Prefer disk config: AgentLoop keeps a cloned in-memory Config that stays
    // stale after desktop switches account ↔ byok and rewrites config.yaml.
    getAnalyticsUserId: () => resolveLiveLoggedInAnalyticsUserId(),
    getAnalyticsUserMode: () => resolveLiveAnalyticsUserMode(),
  });
  void hook.initialize().catch((error) => {
    hook.lastError = error instanceof Error ? error.message : String(error);
  });
  let projectSync: L3UserProjectSync | null = null;
  return {
    enabled: true,
    client,
    hook,
    dispose: async () => {
      projectSync?.stop();
      await hook.dispose();
    },
    startL3UserProjectSync: (readProjects) => {
      if (projectSync) return;
      projectSync = new L3UserProjectSync({
        client,
        envelope: {
          adapterId: "memmy-agent",
          source: "memmy-agent",
          namespace: {
            source: "memmy-agent",
            profileId: "default",
            ...(resolved.userId ? { userId: resolved.userId } : {}),
          },
        },
        readProjects,
        standaloneRoots: () => [getStandaloneTaskWorkspacesDir()],
      });
      projectSync.start();
    },
    closeSession: (sessionKey, reason = "deleted") => hook.sessionEnd(new AgentHookContext({
      sessionKey,
      reason,
      metadata: { lifecycle: "session" },
    })),
  };
}

export function installMemmyMemory(
  config: Config | Record<string, any> | null | undefined,
  options: MemmyMemoryInstallOptions = {},
): MemmyMemoryIntegration {
  const integration = createMemmyMemoryIntegration(config, options);
  if (integration.hook && Array.isArray(options.hooks)) options.hooks.push(integration.hook);
  return integration;
}
