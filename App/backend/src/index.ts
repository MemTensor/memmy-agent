/** Src module. */
import { RuntimeConfigSchema, type AppSettingsDto, type LastLaunchMode, type RuntimeConfig } from "@memmy/local-api-contracts";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createDefaultAgentAdapterRegistry, type AgentAdapterRegistry } from "./adapters/outbound/agent-adapter/index.js";
import { createAppStateStore } from "./infrastructure/app-state-store/index.js";
import { createHttpCloudClient, type CloudClient } from "./adapters/outbound/cloud-client/index.js";
import {
  createHttpMemoryClient,
  createMemosSqliteMemoryClient,
  discoverMemosSqliteSources,
  type MemoryClient,
  type MemoryLayerConfig
} from "./adapters/outbound/memory-client/index.js";
import { resolveDefaultRuntimeConfigPath, writeRuntimeConfigFile } from "./infrastructure/cli-binary/index.js";
import {
  createMemmyConfigWriter,
  readAgentGatewayBootstrapSecret,
  resolveDefaultMemmyConfigPath
} from "./infrastructure/memmy-config/index.js";
import { createPermissionManager } from "./permission/index.js";
import { createLocalApiServer } from "./adapters/inbound/local-api/server.js";
import { createBackendServices, type BootstrapScenario } from "./services/index.js";
import {
  createAgentSourceAutoScanService,
  DEFAULT_AGENT_SOURCE_AUTO_SCAN_INTERVAL_MS,
  type AgentSourceAutoScanService
} from "./services/agent-source-auto-scan-service.js";
import { resolveCloudClientConfig, type CloudClientConfig } from "./config/service-urls.js";
import { resetAccountRuntimeForDesktopInstallChange } from "./services/desktop-install-state-service.js";
import { syncRuntimeConfigWithAppState } from "./services/runtime-config-sync-service.js";
import { loadCloudServiceEnv } from "./load-env.js";

export type { BootstrapScenario };
export { loadCloudServiceEnv };
export { sendGa4Events, resolveGa4Config } from "./analytics/ga4-client.js";
export type { Ga4Config, Ga4Event, SendGa4EventsOptions } from "./analytics/ga4-client.js";

const DEFAULT_MEMORY_LAYER_TIMEOUT_MS = 20_000;

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
  /** Memmy config path. */
  memmyConfigPath?: string;
  /** Memory service address exposed to desktop and browser-debug clients. */
  memoryBaseUrl?: string;
  /** Desktop install fingerprint. */
  desktopInstallFingerprint?: string;
  /** Agent source auto scan interval in ms. Defaults to one hour. */
  agentSourceAutoScanIntervalMs?: number;
  /** Agent source auto scan initial delay in ms. Defaults to the interval. */
  agentSourceAutoScanInitialDelayMs?: number;
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
  const appStateStore = createAppStateStore({ databasePath: options.databasePath });
  let server: Awaited<ReturnType<typeof createLocalApiServer>> | null = null;
  let autoScan: AgentSourceAutoScanService | null = null;

  try {
    const memmyConfigPath = options.memmyConfigPath ?? process.env.MEMMY_CONFIG ?? resolveDefaultMemmyConfigPath();
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
      memmyConfigPath
    });

    const permissionManager = createPermissionManager({
      appStateStore,
      runtimeToken: options.localToken
    });
    const memoryClient = options.memoryClient ?? createDefaultMemoryClient(process.env);
    await memoryClient.reloadConfig({ reason: "desktop_startup" });
    const scanWorker = options.memoryClient ? undefined : { databasePath: appStateStore.databasePath };
    const cloudConfig = resolveCloudClientConfig(process.env);
    const cloudClient = options.cloudClient ?? createDefaultCloudClient(cloudConfig);
    const agentAdapterRegistry =
      options.agentAdapterRegistry ??
      createDefaultAgentAdapterRegistry({
        pluginDirectories: options.agentAdapterPluginDirectories
      });
    const memmyConfigWriter = createMemmyConfigWriter({ configPath: memmyConfigPath });
    const services = createBackendServices({
      appStateStore,
      agentAdapterRegistry,
      memoryClient,
      cloudClient,
      permissionManager,
      bootstrapScenario: options.bootstrapScenario,
      memmyConfigWriter,
      memmyConfigPath,
      memmyAgentAdminBootstrapSecret: await readAgentGatewayBootstrapSecret(memmyConfigPath)
    });
    const localToken = await permissionManager.getRuntimeToken();
    const composioMcpToken = `mmt_${randomBytes(32).toString("base64url")}`;
    server = createLocalApiServer({
      permissionManager,
      services,
      composioMcpToken,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      scanWorker
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

    const runtimeConfig = RuntimeConfigSchema.parse({
      baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
      localToken,
      memory: options.memoryBaseUrl ? { baseUrl: options.memoryBaseUrl } : undefined
    });
    await writeRuntimeConfigFile(runtimeConfig, options.runtimeConfigPath ?? resolveDefaultRuntimeConfigPath());
    autoScan = createAgentSourceAutoScanService({
      baseUrl: runtimeConfig.baseUrl,
      localToken,
      intervalMs: options.agentSourceAutoScanIntervalMs ?? DEFAULT_AGENT_SOURCE_AUTO_SCAN_INTERVAL_MS,
      initialDelayMs: options.agentSourceAutoScanInitialDelayMs,
      getScanPreferences: () => appStateStore.repositories.bootstrap.getScanPreferences()
    });
    autoScan.start();

    const boundServer = server;
    const boundAutoScan = autoScan;
    return {
      runtimeConfig,
      getAppSettings() {
        return appStateStore.repositories.bootstrap.getAppSettings();
      },
      recordLaunchMode(mode: LastLaunchMode) {
        return appStateStore.repositories.bootstrap.recordLastLaunchMode(mode);
      },
      async close() {
        boundAutoScan.close();
        await boundServer.close();
        appStateStore.close();
      }
    };
  } catch (error) {
    autoScan?.close();
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
function createDefaultCloudClient(config: CloudClientConfig): CloudClient {
  return createHttpCloudClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs
  });
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
 * Priority:
 * 1. The standard HTTP memory layer pointed to by MEMMY_MEMORY_LAYER_URL.
 * 2. A read-only client over this project's MemoryService SQLite database.
 * Fails outright when no real data source is available, to avoid the desktop app silently showing fake data.
 */
function createDefaultMemoryClient(env: NodeJS.ProcessEnv): MemoryClient {
  const memoryLayerConfig = readMemoryLayerConfig(env);
  if (memoryLayerConfig) {
    return createHttpMemoryClient(memoryLayerConfig);
  }

  if (env.MEMMY_DISABLE_MEMOS_SQLITE !== "1") {
    const sources = discoverMemosSqliteSources(env);
    if (sources.length > 0) {
      return createMemosSqliteMemoryClient({ sources });
    }
  }

  throw new Error("MEMMY_MEMORY_LAYER_URL or a local Memmy memory SQLite source is required");
}
