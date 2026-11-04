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
  readBundledPluginPreferences,
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
import { defaultCollabHome, refreshCollabAgentSkills } from "./services/collab-added-agents.js";
import { createCollabAgentAccessService } from "./services/collab-agent-access-service.js";
import { createProjectDirectoryService } from "./services/project-directory-service.js";
import type { PluginService } from "./services/plugin-service.js";
import {
  resolveCloudClientConfig,
  resolvePluginRegistryBaseUrl,
  type CloudClientConfig
} from "./config/service-urls.js";
import { resetAccountRuntimeForDesktopInstallChange } from "./services/desktop-install-state-service.js";
import {
  syncRuntimeConfigForStartup,
  syncRuntimeConfigWithAppState
} from "./services/runtime-config-sync-service.js";
import { loadCloudServiceEnv } from "./load-env.js";
import type { MemmyAgentAdminClient } from "./adapters/outbound/memmy-agent-admin-client/index.js";
import {
  createCompositePluginRegistry,
  createHttpPluginRegistry,
  loadBundledPluginCatalog,
  type BundledPluginCatalog,
  type PluginRegistry
} from "./adapters/outbound/plugin-registry/index.js";
import {
  reconcileBundledPlugins,
  suppressBundledPlugins
} from "./services/bundled-plugin-bootstrap-service.js";
import { reconcileEntitledPlugins } from "./services/plugin-entitlement-reconcile-service.js";

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
  /** Directory containing immutable `*.release.json` files and their MPP archives. */
  bundledPluginDirectory?: string;
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
  let pluginService: PluginService | null = null;

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
    const bundledCatalog = await tryLoadBundledPluginCatalog(
      options.bundledPluginDirectory ?? process.env.MEMMY_BUNDLED_PLUGINS_DIR
    );
    const bundledPreferences = bundledCatalog
      ? await readBundledPluginPreferences(
          memmyConfigPath,
          bundledCatalog.managedPluginIds
        )
      : {};
    const services = createBackendServices({
      appStateStore,
      agentAdapterRegistry,
      memoryClient,
      cloudClient,
      permissionManager,
      bootstrapScenario: options.bootstrapScenario,
      timeZone: configuredTimeZone,
      memmyConfigWriter,
      memmyConfigPath,
      scanPreferencesStore,
      accountChannel: options.accountChannel,
      memmyAgentAdminClient: options.memmyAgentAdminClient,
      memmyAgentAdminBootstrapSecret: await readAgentGatewayBootstrapSecret(memmyConfigPath),
      pluginRegistry: configuredPluginRegistry(process.env, bundledCatalog?.registry, (): Record<string, string> => {
        const cloudUuid = appStateStore.repositories.accountSession.getCloudUuid();
        return cloudUuid ? { authorization: `Bearer ${cloudUuid}` } : {};
      }),
      trustedBundledPluginRoots: bundledCatalog ? [bundledCatalog.trustedArtifactRoot] : undefined
    });
    pluginService = services.plugins;
    if (bundledCatalog) {
      const failures = await suppressBundledPlugins({
        plugins: services.plugins,
        releases: bundledCatalog.releases,
        managedPluginIds: bundledCatalog.managedPluginIds,
        enabledById: Object.fromEntries(
          bundledCatalog.managedPluginIds.map((pluginId) => [
            pluginId,
            bundledPreferences?.[pluginId]?.enabled !== false
          ])
        )
      });
      for (const failure of failures) {
        console.warn(
          `Suppressed bundled plugin deactivation failed for ${failure.pluginId}: ${failure.message}`
        );
      }
    }
    await services.plugins.restoreActive();
    if (bundledCatalog && bundledPreferences) {
      const failures = await reconcileBundledPlugins({
        plugins: services.plugins,
        releases: bundledCatalog.releases,
        userUninstalledIds: new Set(appStateStore.repositories.plugins.listUserUninstalledIds()),
        enabledById: Object.fromEntries(
          bundledCatalog.releases.map((release) => [
            release.id,
            bundledPreferences[release.id]?.enabled !== false
          ])
        )
      });
      for (const failure of failures) {
        console.warn(`Bundled plugin bootstrap failed for ${failure.pluginId}: ${failure.message}`);
      }
    }
    // Runs on every launch so an entitled plugin missing after an upgrade is reinstalled.
    const reconcileEntitlements = async () => {
      const failures = await reconcileEntitledPlugins({
        plugins: services.plugins,
        userUninstalledIds: new Set(appStateStore.repositories.plugins.listUserUninstalledIds()),
        entitlements: appStateStore.repositories.accountSession.getEntitlements()
      });
      for (const failure of failures) {
        console.warn(`Entitled plugin reconciliation failed for ${failure.pluginId}: ${failure.message}`);
      }
    };
    await reconcileEntitlements();
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
    /** Reads the login mode on every call: switching between account and API Key takes effect without a restart. */
    const userMode = () => appStateStore.repositories.bootstrap.getAppSettings().userMode;
    /**
     * 协作项目只在账号模式可用。API Key 模式（byok）不连接云端，但上一次登录留下的凭据还在这台机器上，
     * 不在这里挡住的话，项目与成员会在纯本地环境里出现。知识库不按这条处理：它有自己的账号会话语义。
     */
    const getCollabAccount = () => (userMode() === "byok" ? null : getCloudAccount());
    /**
     * 用户添加的 Agent 只装 memmy-project，Memmy 不读它们的任务记录，所以这里只用内置来源；
     * 启动时顺手把它们的技能刷到当前版本。
     */
    const collabHome = defaultCollabHome();
    const collabAgentRegistry = createBuiltinAgentSourceRegistry();
    /**
     * 在其他 Agent 中使用协作项目的授权。读取任务、安装 `memmy-project` 都看这一份：
     * 未授权时本机任务读取器一个适配器也不给，根本就不去扫它们的记录。
     */
    const collabAgentAccess = createCollabAgentAccessService({
      homeDirectory: collabHome,
      skillDistributionService: services.skillDistribution,
      sourceRegistry: collabAgentRegistry
    });
    // 用户自己添加的 Agent 不在授权范围里：添加它们本身就是那一下授权，启动时照旧刷到当前版本。
    void refreshCollabAgentSkills({ homeDirectory: collabHome }).then((updated) => {
      if (updated > 0) console.log(`Refreshed the memmy-project skill of ${updated} added agent(s)`);
    }).catch((error: unknown) => {
      console.warn(`Refreshing added agents' skills did not complete: ${error instanceof Error ? error.message : String(error)}`);
    });
    // 内置 Agent 看协作项目的授权：授权还在时给新出现的 Agent 补装，未授权时什么也不写。
    void collabAgentAccess.read()
      .then(async (access) => (access.granted ? await collabAgentAccess.install() : null))
      .then((result) => {
        const failed = result?.results.filter((item) => !item.ok) ?? [];
        if (failed.length) console.warn(`memmy-project install did not complete for: ${failed.map((item) => item.sourceId).join(", ")}`);
      })
      .catch((error: unknown) => {
        console.warn(`Installing memmy-project at startup did not complete: ${error instanceof Error ? error.message : String(error)}`);
      });
    const collab = createCollabService({
      cloudBaseUrl: cloudConfig.baseUrl,
      getAccount: getCollabAccount,
      userMode,
      // The backend reads this machine's agent sessions itself, so association works without the Memory service.
      localSessions: createLocalSessionReader({
        registry: collabAgentRegistry,
        // 未授权时一个都不读；关掉的 Agent 也不进入扫描范围，而不是读完再筛。
        adapters: async () => {
          const allowed = new Set(await collabAgentAccess.readableSourceIds());
          return collabAgentRegistry.list().filter((adapter) => allowed.has(adapter.descriptor.sourceId));
        }
      }),
      agentAccess: () => collabAgentAccess.read(),
      ...(process.env.MEMMY_SESSION_LINK_BASE_URL?.trim() ? { linkBaseUrl: process.env.MEMMY_SESSION_LINK_BASE_URL.trim() } : {}),
      // 协作项目的指令存在协作侧自己的文件里，与本机项目的项目指令互不影响。
      collabInstructions: services.collabInstructions,
      // 只在一个方向上写：停止共享时把背景与规范写回创建者的本机项目。
      projectInstructions: services.projectInstructions
    });
    // Groups associated with an online project pick up new sessions, and associated sessions their new turns.
    collabSyncTimer = setInterval(() => {
      // API Key 模式不连接云端：没有账号就没有可同步的协作项目，定时任务也就不必去试。
      if (userMode() === "byok") return;
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
      collabAgentAccess,
      projectDirectory: createProjectDirectoryService(),
      permissionManager,
      services,
      composioMcpToken,
      timeZone: configuredTimeZone,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      pluginCapabilitiesChanged: () => reloadAgentMcp(options.memmyAgentAdminClient)
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
    await memmyConfigWriter.patchMcpServerConfig("plugins", {
      type: "streamableHttp",
      url: `http://127.0.0.1:${(address as AddressInfo).port}/mcp/plugins`,
      headers: { "x-memmy-mcp-token": composioMcpToken },
      // Interaction capabilities can legitimately wait while the user reads a
      // long card or leaves the app in the background. Non-interactive command
      // work remains bounded by the plugin runtime's own timeout.
      toolTimeout: 7 * 24 * 60 * 60
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
    const boundPluginService = services.plugins;
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
        try {
          await boundServer.close();
        } finally {
          await boundPluginService.shutdown();
          appStateStore.close();
        }
      }
    };
  } catch (error) {
    clearInterval(collabSyncTimer);
    await server?.close().catch(() => undefined);
    await pluginService?.shutdown();
    appStateStore.close();
    throw error;
  }
}

function configuredPluginRegistry(
  env: NodeJS.ProcessEnv,
  bundledRegistry?: PluginRegistry,
  authHeaders?: () => Record<string, string>
): PluginRegistry | undefined {
  const baseUrl = resolvePluginRegistryBaseUrl(env);
  const remoteRegistry = baseUrl ? createHttpPluginRegistry({ baseUrl, authHeaders }) : undefined;
  // Explicit remote distribution must never fall back to a locally bundled package.
  if (env.MEMMY_PLUGIN_REGISTRY_URL?.trim()) return remoteRegistry;
  return bundledRegistry ? createCompositePluginRegistry(bundledRegistry, remoteRegistry) : remoteRegistry;
}

async function tryLoadBundledPluginCatalog(directory: string | undefined): Promise<BundledPluginCatalog | null> {
  const normalized = directory?.trim();
  if (!normalized) return null;
  try {
    return await loadBundledPluginCatalog(normalized);
  } catch (error) {
    console.warn(`Bundled plugins are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function reloadAgentMcp(client: MemmyAgentAdminClient | undefined): Promise<void> {
  if (!client) return;
  try {
    const result = await client.reloadMcpConfig();
    if (!result.ok) console.warn(`Agent MCP reload did not complete: ${result.message}`);
  } catch (error) {
    console.warn(`Agent MCP reload unavailable: ${error instanceof Error ? error.message : String(error)}`);
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
