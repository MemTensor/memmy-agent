import type { AccountChannel } from "@memmy/local-api-contracts";
import { dirname, join } from "node:path";
import type { AppStateStore } from "../infrastructure/app-state-store/index.js";
import { type MemmyConfigWriter } from "../infrastructure/memmy-config/index.js";
import type { ScanPreferencesStore } from "../infrastructure/memmy-config/agent-access.js";
import type { AgentAdapterRegistry } from "../adapters/outbound/agent-adapter/index.js";
import {
  createBuiltinOnboardingInsightSamplers,
  createSourceRegistryOnboardingConversationWindowReader
} from "../adapters/outbound/agent-source/onboarding-insight-samplers.js";
import type { SourceRegistry } from "../adapters/outbound/agent-source/source-registry.js";
import { createHttpMemmyAgentAdminClient } from "../adapters/outbound/memmy-agent-admin-client/http-memmy-agent-admin-client.js";
import type { MemmyAgentAdminClient } from "../adapters/outbound/memmy-agent-admin-client/index.js";
import type { SkillTargetRegistry } from "../adapters/outbound/skill-writer/target-registry.js";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { PermissionManager } from "../permission/index.js";
import {
  createAgentSourceLifecycleAnalytics,
  resolveLoggedInAnalyticsUserId,
} from "../analytics/agent-source-analytics.js";
import { createMemoryDesktopAddAnalytics } from "../analytics/memory-add-analytics.js";
import { createToolConnectionAnalytics } from "../analytics/tool-connection-analytics.js";
import { createAgentSourceService, type AgentSourceService } from "./agent-source-service.js";
import { createAgentSourceAutoInjectService, type AgentSourceAutoInjectService } from "./agent-source-auto-inject-service.js";
import { createBuiltinAgentSourceRegistry } from "./builtin-agent-source-registry.js";
import { createBuiltinSkillTargetRegistry } from "./builtin-skill-target-registry.js";
import { createAppConfigService, type AppConfigService } from "./app-config-service.js";
import { createAccountService, type AccountService } from "./account-service.js";
import { createAsrService, type AsrService } from "./asr-service.js";
import { createTokenQuotaService, type TokenQuotaService } from "./token-quota-service.js";
import {
  createByokTokenUsageService,
  type ByokTokenUsageService
} from "./byok-token-usage-service.js";
import {
  createBootstrapService,
  type BootstrapScenario,
  type BootstrapService
} from "./bootstrap-service.js";
import { createChannelService, type ChannelService } from "./channel-service.js";
import { createIntegrationService, type IntegrationService } from "./integration-service.js";
import { createIngestionService, type IngestionService } from "./ingestion-service.js";
import { createLocalDataService, type LocalDataService } from "./local-data-service.js";
import { createMemoryDetailService, type MemoryDetailService } from "./memory-detail-service.js";
import {
  createOnboardingInsightService,
  type OnboardingInsightAgentTaskModelResolver,
  type OnboardingInsightService
} from "./onboarding-insight-service.js";
import { createOnboardingFirstReportMemoryWriter } from "./onboarding-first-report-memory-writer.js";
import { createPanelService, type PanelService } from "./panel-service.js";
import { createProgressBus, type ProgressBus } from "./progress-bus.js";
import { createSearchService, type SearchService } from "./search-service.js";
import { createSessionService, type SessionService } from "./session-service.js";
import {
  createSkillDistributionService,
  type SkillDistributionService
} from "./skill-distribution-service.js";
import { createTurnService, type TurnService } from "./turn-service.js";

export interface BackendServices {
  memoryClient: MemoryClient;
  agentAdapterRegistry: AgentAdapterRegistry;
  bootstrap: BootstrapService;
  appConfig: AppConfigService;
  account: AccountService;
  /** Integrations. */
  integrations: IntegrationService;
  /** Channels. */
  channels: ChannelService;
  localData: LocalDataService;
  agentSources: AgentSourceService;
  agentSourceAutoInject: AgentSourceAutoInjectService;
  onboardingInsight: OnboardingInsightService;
  progressBus: ProgressBus;
  session: SessionService;
  turn: TurnService;
  search: SearchService;
  memoryDetail: MemoryDetailService;
  panel: PanelService;
  byokTokenUsage: ByokTokenUsageService;
  /** Asr. */
  asr: AsrService;
  /** Token quota. */
  tokenQuota: TokenQuotaService;
}

export interface CreateBackendServicesOptions {
  appStateStore: AppStateStore;
  agentAdapterRegistry: AgentAdapterRegistry;
  memoryClient: MemoryClient;
  cloudClient: CloudClient;
  permissionManager: PermissionManager;
  bootstrapScenario?: BootstrapScenario;
  sourceRegistry?: SourceRegistry;
  ingestionService?: IngestionService;
  skillDistributionService?: SkillDistributionService;
  skillTargetRegistry?: SkillTargetRegistry;
  progressBus?: ProgressBus;
  /** Memmy config writer. */
  memmyConfigWriter?: MemmyConfigWriter;
  /** Memmy config path. */
  memmyConfigPath?: string;
  /** Memmy agent admin client. */
  memmyAgentAdminClient?: MemmyAgentAdminClient;
  /** Memmy agent admin bootstrap secret. */
  memmyAgentAdminBootstrapSecret?: string | null;
  /** Verification channel supported by the current desktop package. */
  accountChannel?: AccountChannel;
  scanPreferencesStore?: ScanPreferencesStore;
}

export function createBackendServices(options: CreateBackendServicesOptions): BackendServices {
  const progressBus = options.progressBus ?? createProgressBus();
  const sourceRegistry =
    options.sourceRegistry ??
    createBuiltinAgentSourceRegistry();
  const skillTargetRegistry =
    options.skillTargetRegistry ??
    createBuiltinSkillTargetRegistry(options.memmyConfigPath);
  const skillDistributionService =
    options.skillDistributionService ??
    createSkillDistributionService({
      targetRegistry: skillTargetRegistry
    });
  const memmyAgentAdminClient =
    options.memmyAgentAdminClient ??
    createHttpMemmyAgentAdminClient({ bootstrapSecret: options.memmyAgentAdminBootstrapSecret });
  const memmyConfigWriter = options.memmyConfigWriter ?? createUnavailableMemmyConfigWriter();
  const accountSessionRepository = options.appStateStore.repositories.accountSession;
  const resolveAnalyticsUserId = () => {
    const session = accountSessionRepository.get();
    if (!session.authenticated) return null;
    return resolveLoggedInAnalyticsUserId({
      cloudUuid: accountSessionRepository.getCloudUuid(),
      userId: session.profile.userId,
    });
  };
  const resolveAnalyticsUserMode = () => {
    const mode = options.appStateStore.repositories.bootstrap.getAppSettings().userMode;
    return mode === "account" || mode === "byok" ? mode : null;
  };
  const resolveMemoryUserId = () => {
    const session = accountSessionRepository.get();
    return session.authenticated ? session.profile.userId : "local-user";
  };
  const ingestionService =
    options.ingestionService ??
    createIngestionService({
      memoryClient: options.memoryClient,
      agentSourceRepository: options.appStateStore.repositories.agentSources,
      memoryAddAnalytics: createMemoryDesktopAddAnalytics({
        getUserId: resolveAnalyticsUserId,
        getUserMode: resolveAnalyticsUserMode,
      }),
    });
  const agentSources = createAgentSourceService({
    sourceRegistry,
    agentSourceRepository: options.appStateStore.repositories.agentSources,
    ingestionService,
    memoryClient: options.memoryClient,
    skillDistributionService,
    getScanPermission: () => options.permissionManager.getScanPermission(),
    agentSourceAnalytics: createAgentSourceLifecycleAnalytics({
      getUserId: resolveAnalyticsUserId,
      getUserMode: resolveAnalyticsUserMode,
    }),
    scanStoreDirectory: join(dirname(options.appStateStore.databasePath), "agent-source-scans"),
  });
  const toolConnectionAnalytics = createToolConnectionAnalytics({
    getUserId: resolveAnalyticsUserId,
    getUserMode: resolveAnalyticsUserMode,
  });

  return {
    memoryClient: options.memoryClient,
    agentAdapterRegistry: options.agentAdapterRegistry,
    bootstrap: createBootstrapService({
      ...options,
      scanPreferencesStore: options.scanPreferencesStore
    }),
    appConfig: createAppConfigService({
      bootstrapRepository: options.appStateStore.repositories.bootstrap,
      cloudClient: options.cloudClient,
      accountSessionRepository: options.appStateStore.repositories.accountSession,
      memmyConfigWriter: options.memmyConfigWriter,
      memoryClient: options.memoryClient,
      scanPreferencesStore: options.scanPreferencesStore
    }),
    account: createAccountService({
      cloudClient: options.cloudClient,
      accountSessionRepository: options.appStateStore.repositories.accountSession,
      bootstrapRepository: options.appStateStore.repositories.bootstrap,
      memmyConfigWriter: options.memmyConfigWriter,
      memoryClient: options.memoryClient,
      accountChannel: options.accountChannel
    }),
    integrations: createIntegrationService({
      cloudClient: options.cloudClient,
      composioMachineTokenRepository: options.appStateStore.repositories.composioMachineToken,
      toolConnectionAnalytics,
    }),
    channels: createChannelService({
      memmyConfigWriter,
      memmyAgentAdminClient,
      toolConnectionAnalytics,
    }),
    localData: createLocalDataService({
      localDataStore: options.appStateStore.localDataStore,
      memoryClient: options.memoryClient
    }),
    agentSources,
    agentSourceAutoInject: createAgentSourceAutoInjectService({
      agentSources,
      permissionManager: options.permissionManager,
      getScanPreferences: () => options.scanPreferencesStore?.getScanPreferences()
        ?? options.appStateStore.repositories.bootstrap.getScanPreferences()
    }),
    // First-report sampling stays inside Desktop: it reads a small recent-history
    // window for onboarding and is separate from Memory's persistent Agent scan.
    onboardingInsight: createOnboardingInsightService({
      samplers: createBuiltinOnboardingInsightSamplers(),
      conversationWindowReader: createSourceRegistryOnboardingConversationWindowReader(sourceRegistry),
      memoryWriter: createOnboardingFirstReportMemoryWriter(options.memoryClient),
      agentModelResolver: createCatalogAgentTaskModelResolver(options.appStateStore, memmyConfigWriter)
    }),
    progressBus,
    session: createSessionService({
      memoryClient: options.memoryClient,
      idempotencyStore: options.appStateStore.repositories.idempotency
    }),
    turn: createTurnService({
      memoryClient: options.memoryClient,
      idempotencyStore: options.appStateStore.repositories.idempotency
    }),
    search: createSearchService({
      memoryClient: options.memoryClient
    }),
    memoryDetail: createMemoryDetailService({
      memoryClient: options.memoryClient
    }),
    panel: createPanelService({
      memoryClient: options.memoryClient,
      getUserId: resolveMemoryUserId
    }),
    byokTokenUsage: createByokTokenUsageService({
      repository: options.appStateStore.repositories.byokTokenUsage
    }),
    asr: createAsrService({
      bootstrapRepository: options.appStateStore.repositories.bootstrap,
      accountSessionRepository: options.appStateStore.repositories.accountSession,
      memmyConfigWriter,
      cloudClient: options.cloudClient
    }),
    tokenQuota: createTokenQuotaService({
      cloudClient: options.cloudClient,
      accountSessionRepository: options.appStateStore.repositories.accountSession
    })
  };
}

export { createBootstrapService };
export type { BootstrapScenario, BootstrapService };

function createCatalogAgentTaskModelResolver(
  appStateStore: AppStateStore,
  memmyConfigWriter: MemmyConfigWriter
): OnboardingInsightAgentTaskModelResolver {
  const { bootstrap, accountSession } = appStateStore.repositories;

  return {
    async getAgentTaskModel() {
      const userMode = bootstrap.getAppSettings().userMode;
      if (userMode !== "account" && userMode !== "byok") return null;
      const account = accountSession.get();
      const resolved = await memmyConfigWriter.resolveAssignedModel?.({
        mode: userMode,
        activeAccountId: account.authenticated ? account.profile.userId : null,
        capability: "agent"
      });
      if (!resolved?.ok) return null;
      return {
        providerName: resolved.context.provider,
        model: resolved.context.model,
        apiBase: resolved.provider.apiBase,
        apiKey: resolved.provider.apiKey ?? "",
        apiType: agentApiType(resolved.context.protocol),
        extraHeaders: resolved.provider.extraHeaders,
        extraBody: resolved.provider.extraBody
      };
    }
  };
}

function agentApiType(protocol: string): "auto" | "chatCompletions" | "responses" {
  if (protocol === "openai-responses") return "responses";
  if (protocol === "openai-chat-completions" || protocol === "memmy-account") return "chatCompletions";
  return "auto";
}

function createUnavailableMemmyConfigWriter(): MemmyConfigWriter {
  const unavailable = () => {
    throw new Error("Memmy config writer is not configured");
  };

  return {
    writeAccountModelProjection: async () => unavailable(),
    clearAccountModelProjection: async () => unavailable(),
    patchChannelConfig: async () => unavailable(),
    patchMcpServerConfig: async () => unavailable()
  };
}
