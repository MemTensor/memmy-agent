/** Src module. */
import { RuntimeConfigSchema, type AccountChannel, type AppSettingsDto, type LastLaunchMode, type RuntimeConfig } from "@memmy/local-api-contracts";
import { randomBytes } from "node:crypto";
import { removeLegacyKnowledgeCredentials } from "@memmy/knowledge";
import type { AddressInfo } from "node:net";
import { createDefaultAgentAdapterRegistry, type AgentAdapterRegistry } from "./adapters/outbound/agent-adapter/index.js";
import { createAppStateStore } from "./infrastructure/app-state-store/index.js";
import { createHttpCloudClient, type CloudClient } from "./adapters/outbound/cloud-client/index.js";
import {
  createHttpMemoryClient,
  type MemoryClient,
  type MemoryLayerConfig
} from "./adapters/outbound/memory-client/index.js";
import { resolveDefaultRuntimeConfigPath, writeRuntimeConfigFile } from "./infrastructure/cli-binary/index.js";
import {
  createMemmyConfigWriter,
  readConfiguredAgentTimeZone,
  readAgentGatewayBootstrapSecret
} from "./infrastructure/memmy-config/index.js";
import {
  createMemoryScanPreferencesStore,
  ensureMemoryScanPreferences
} from "./infrastructure/memmy-config/agent-access.js";
import { createPermissionManager } from "./permission/index.js";
import { createLocalApiServer } from "./adapters/inbound/local-api/server.js";
import { createBackendServices, type BootstrapScenario } from "./services/index.js";
import { migrateLegacyCollabInstructions } from "./services/collab-instructions-service.js";
import { createCollabCloudRequest, createCollabService } from "./services/collab-service.js";
import { createLocalSessionReader } from "./adapters/outbound/agent-source/session-reference/local-session-reader.js";
import { createBuiltinAgentSourceRegistry } from "./services/builtin-agent-source-registry.js";
import { createProjectDirectoryService } from "./services/project-directory-service.js";
import { resolveCloudClientConfig, type CloudClientConfig } from "./config/service-urls.js";
import { resetAccountRuntimeForDesktopInstallChange } from "./services/desktop-install-state-service.js";
import {
  syncRuntimeConfigForStartup,
  syncRuntimeConfigWithAppState
} from "./services/runtime-config-sync-service.js";
import { loadCloudServiceEnv } from "./load-env.js";
import type { MemmyAgentAdminClient } from "./adapters/outbound/memmy-agent-admin-client/index.js";

export type { BootstrapScenario };
export { loadCloudServiceEnv };
export { syncRuntimeConfigForStartup };
export { trackAnalyticsEvent } from "./analytics/analytics-transport.js";
export { createHttpMemmyAgentAdminClient } from "./adapters/outbound/memmy-agent-admin-client/http-memmy-agent-admin-client.js";

const DEFAULT_MEMORY_LAYER_TIMEOUT_MS = 20_000;
/** New sessions of associated groups reach the project within about a minute. */
const COLLAB_SYNC_INTERVAL_MS = 60_000;

export interface CreateLocalBackendOptions {
  databasePath: string;
  localToken?: string;
  bootstrapScenario?: BootstrapScenario;
  heartbeatIntervalMs?: number;
  memoryClient?: MemoryClient;
  cloudClient?: CloudClient;
  agentAdapterRegistry?: AgentAdapterRegistry;
  agentAdapterPluginDirectories?: string[];
  runtimeConfigPath?: string;
  /** Memmy config path. Required unless MEMMY_CONFIG is set. */
  memmyConfigPath?: string;
  /** Memory service address exposed to desktop and browser-debug clients. */
  memoryBaseUrl?: string;
  /** Resolves when the managed Memory service is ready for startup config reload. */
  memoryReady?: Promise<void>;
  /** Desktop install fingerprint. */
  desktopInstallFingerprint?: string;
  /** Login channel supported by the current desktop package. */
  accountChannel?: AccountChannel;
  /** Running Agent Gateway client; when present, refreshes MCP after startup config writes. */
  memmyAgentAdminClient?: MemmyAgentAdminClient;
  /** Skip only the startup MCP reload when the caller will start the Agent after bridge config is written. */
  skipAgentMcpReload?: boolean;
}

export interface LocalBackend {
  runtimeConfig: RuntimeConfig;
  /** Reads get app settings. */
  getAppSettings(): AppSettingsDto;
  /** Handles record launch mode. */
  recordLaunchMode(mode: LastLaunchMode): AppSettingsDto;
  close(): Promise<void>;
}

export async function createLocalBackend(options: CreateLocalBackendOptions): Promise<LocalBackend> {
  loadCloudServiceEnv();
  const memmyConfigPath = options.memmyConfigPath ?? process.env.MEMMY_CONFIG;
  if (!memmyConfigPath) {
    throw new Error("memmyConfigPath or MEMMY_CONFIG is required");
  }
  const appStateStore = createAppStateStore({ databasePath: options.databasePath });
  let server: Awaited<ReturnType<typeof createLocalApiServer>> | null = null;
  let collabSyncTimer: ReturnType<typeof setInterval> | undefined;

  try {
    if (options.desktopInstallFingerprint) {
      await resetAccountRuntimeForDesktopInstallChange({
        appStateStore,
        databasePath: options.databasePath,
        memmyConfigPath,
        installFingerprint: options.desktopInstallFingerprint
      });
    }
    await syncRuntimeConfigWithAppState({
      appStateStore,
      memmyConfigPath,
      accountChannel: options.accountChannel
    });
    await ensureMemoryScanPreferences(
      memmyConfigPath,
      appStateStore.repositories.bootstrap.getScanPreferences()
    );
    const scanPreferencesStore = createMemoryScanPreferencesStore(memmyConfigPath);

    const permissionManager = createPermissionManager({
      appStateStore,
      runtimeToken: options.localToken
    });
    const memoryClient = options.memoryClient ?? createDefaultMemoryClient(process.env);
    const memmyConfigWriter = createMemmyConfigWriter({
      configPath: memmyConfigPath,
      accountChannel: options.accountChannel
    });
    await memmyConfigWriter.writeMemoryLanguage?.(
      appStateStore.repositories.bootstrap.getAppSettings().language
    );
    const memoryConfigReload = options.memoryReady
      ? options.memoryReady.then(() => memoryClient.reloadConfig({ reason: "desktop_startup" }))
      : memoryClient.reloadConfig({ reason: "desktop_startup" });
    void memoryConfigReload.catch((error) => {
      console.warn(
        `Memory config reload failed during desktop startup: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    const scanProcess = options.memoryClient ? undefined : { databasePath: appStateStore.databasePath };
    const cloudConfig = resolveCloudClientConfig(process.env);
    const cloudClient = options.cloudClient ?? createDefaultCloudClient(
      cloudConfig,
      tryGetInstallationId(appStateStore)
    );
    const agentAdapterRegistry =
      options.agentAdapterRegistry ??
      createDefaultAgentAdapterRegistry({
        pluginDirectories: options.agentAdapterPluginDirectories
      });
    const configuredTimeZone = await readConfiguredAgentTimeZone(memmyConfigPath);
    const services = createBackendServices({
      appStateStore,
      agentAdapterRegistry,
      memoryClient,
      cloudClient,
      permissionManager,
      bootstrapScenario: options.bootstrapScenario,
      memmyConfigWriter,
      memmyConfigPath,
      scanPreferencesStore,
      accountChannel: options.accountChannel,
      memmyAgentAdminClient: options.memmyAgentAdminClient,
      memmyAgentAdminBootstrapSecret: await readAgentGatewayBootstrapSecret(memmyConfigPath)
    });
    const localToken = await permissionManager.getRuntimeToken();
    const composioMcpToken = `mmt_${randomBytes(32).toString("base64url")}`;
    await removeLegacyKnowledgeCredentials(memmyConfigPath);
    // 老版本把协作项目的云端指令镜像在本机项目指令文件里。搬到协作侧自己的文件后从老文件删掉，
    // 否则同一段指令会被两个钩子各注入一次。
    const legacyInstructions = await services.projectInstructions.snapshot();
    const legacyCloudEntries = Object.entries(legacyInstructions.projects)
      .filter(([, entry]) => entry.origin === "cloud" && Boolean(entry.cloudProjectId))
      .map(([directory, entry]) => ({ directory, text: entry.text, cloudProjectId: entry.cloudProjectId }));
    if (legacyCloudEntries.length) {
      const moved = await migrateLegacyCollabInstructions({
        collabInstructions: services.collabInstructions,
        legacyEntries: legacyCloudEntries,
        forgetLegacy: (directory) => services.projectInstructions.forget(directory)
      });
      if (moved) console.log(`Moved ${moved} cloud project instruction(s) out of the local project instructions file`);
    }
    // Knowledge bases and online projects both act as the signed-in Memmy account.
    const getCloudAccount = () => {
      const account = appStateStore.repositories.accountSession;
      const session = account.get();
      const credential = account.getCloudUuid();
      if (!session.authenticated || !credential) return null;
      return {
        accountId: session.profile.userId,
        credential,
        // Shown on the person's own sessions, so members see the same name everywhere.
        memberName: session.profile.nickname
      };
    };
    const collab = createCollabService({
      cloudBaseUrl: cloudConfig.baseUrl,
      getAccount: getCloudAccount,
      // The backend reads this machine's agent sessions itself, so association works without the Memory service.
      localSessions: createLocalSessionReader({ registry: createBuiltinAgentSourceRegistry() }),
      ...(process.env.MEMMY_SESSION_LINK_BASE_URL?.trim() ? { linkBaseUrl: process.env.MEMMY_SESSION_LINK_BASE_URL.trim() } : {}),
      // 协作项目的指令存在协作侧自己的文件里，与本机项目的项目指令互不影响。
      collabInstructions: services.collabInstructions
    });
    // Groups associated with an online project pick up new sessions, and associated sessions their new turns.
    collabSyncTimer = setInterval(() => {
      void collab.syncLinkedSessions().catch((error: unknown) => {
        console.warn(`Online project sync did not complete: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, COLLAB_SYNC_INTERVAL_MS);
    collabSyncTimer.unref();
    server = createLocalApiServer({
      knowledge: {
        baseUrl: cloudConfig.baseUrl,
        getSession: getCloudAccount
      },
      collab,
      projectDirectory: createProjectDirectoryService(),
      permissionManager,
      services,
      composioMcpToken,
      timeZone: configuredTimeZone,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      scanProcess
    });
    await server.listen({ host: "127.0.0.1", port: 0 });

    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local API did not bind to a TCP port");
    }

    // Write the Composio MCP bridge into the agent config (tools.mcpServers.composio), so the agent connects to the local MCP server based on it.
    await memmyConfigWriter.patchMcpServerConfig("composio", {
      type: "streamableHttp",
      url: `http://127.0.0.1:${(address as AddressInfo).port}/mcp/composio`,
      headers: { "x-memmy-mcp-token": composioMcpToken },
      toolTimeout: 60
    });
    const memmyAgentAdminClient = options.memmyAgentAdminClient;
    if (memmyAgentAdminClient && !options.skipAgentMcpReload) {
      // The bridge config must be written first, but MCP connections must not delay the first window.
      void Promise.resolve()
        .then(() => memmyAgentAdminClient.reloadMcpConfig())
        .then((result) => {
          if (!result.ok) console.warn(`Agent MCP reload did not complete: ${result.message}`);
        })
        .catch((error: unknown) => {
          console.warn(`Agent MCP reload unavailable during backend startup: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    const runtimeConfig = RuntimeConfigSchema.parse({
      baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
      localToken,
      timeZone: configuredTimeZone,
      memory: options.memoryBaseUrl ? { baseUrl: options.memoryBaseUrl } : undefined
    });
    await writeRuntimeConfigFile(runtimeConfig, options.runtimeConfigPath ?? resolveDefaultRuntimeConfigPath());
    // Agents connected before this build keep their old skill unless it is rewritten; do it in the background
    // so the first window is not delayed.
    void Promise.resolve()
      .then(() => services.agentSources.refreshInstalledSkills())
      .then((refreshed) => {
        if (refreshed.length) console.info(`Memmy skill refreshed for: ${refreshed.join(", ")}`);
      })
      .catch((error: unknown) => {
        console.warn(`Memmy skill refresh did not complete: ${error instanceof Error ? error.message : String(error)}`);
      });
    const boundServer = server;
    return {
      runtimeConfig,
      getAppSettings() {
        return appStateStore.repositories.bootstrap.getAppSettings();
      },
      recordLaunchMode(mode: LastLaunchMode) {
        return appStateStore.repositories.bootstrap.recordLastLaunchMode(mode);
      },
      async close() {
        clearInterval(collabSyncTimer);
        await boundServer.close();
        appStateStore.close();
      }
    };
  } catch (error) {
    clearInterval(collabSyncTimer);
    await server?.close().catch(() => undefined);
    appStateStore.close();
    throw error;
  }
}

/**
 * Creates the default CloudClient.
 *
 * @param config the Cloud HTTP configuration.
 * @returns an HTTP CloudClient pointing at the real cloud account service.
 */
function createDefaultCloudClient(config: CloudClientConfig, deviceId?: string): CloudClient {
  return createHttpCloudClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    deviceId
  });
}

function tryGetInstallationId(appStateStore: ReturnType<typeof createAppStateStore>): string | undefined {
  try {
    return appStateStore.repositories.deviceIdentity.getOrCreateInstallationId();
  } catch {
    return undefined;
  }
}

export function readMemoryLayerConfig(env: NodeJS.ProcessEnv): MemoryLayerConfig | null {
  const baseUrl = (env.MEMMY_MEMORY_LAYER_URL ?? env.MEMMY_MEMORY_URL ?? env.MEMORY_SERVICE_URL)?.trim();
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl,
    token: env.MEMMY_MEMORY_LAYER_TOKEN ?? env.MEMMY_MEMORY_TOKEN ?? env.MEMORY_SERVICE_TOKEN ?? "",
    timeoutMs: Number.parseInt(env.MEMMY_MEMORY_LAYER_TIMEOUT_MS ?? String(DEFAULT_MEMORY_LAYER_TIMEOUT_MS), 10),
    maxRetries: Number.parseInt(env.MEMMY_MEMORY_LAYER_MAX_RETRIES ?? "3", 10)
  };
}

/**
 * Creates the default MemoryClient.
 *
 * Memory is a process boundary: Desktop always talks to it over HTTP and never
 * reads the service-owned SQLite database.
 */
function createDefaultMemoryClient(env: NodeJS.ProcessEnv): MemoryClient {
  const memoryLayerConfig = readMemoryLayerConfig(env);
  if (memoryLayerConfig) {
    return createHttpMemoryClient(memoryLayerConfig);
  }

  throw new Error("MEMMY_MEMORY_LAYER_URL is required");
}
