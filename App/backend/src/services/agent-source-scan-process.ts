import {
  createHttpMemoryClient,
  type MemoryClient,
  type MemoryLayerConfig
} from "../adapters/outbound/memory-client/index.js";
import {
  createAgentSourceLifecycleAnalytics,
  resolveLoggedInAnalyticsUserId,
} from "../analytics/agent-source-analytics.js";
import { createMemoryDesktopAddAnalytics } from "../analytics/memory-add-analytics.js";
import { createAppStateStore, type AppStateStore } from "../infrastructure/app-state-store/index.js";
import { createAgentSourceService } from "./agent-source-service.js";
import { createBuiltinAgentSourceRegistry } from "./builtin-agent-source-registry.js";
import { createBuiltinSkillTargetRegistry } from "./builtin-skill-target-registry.js";
import { createIngestionService } from "./ingestion-service.js";
import { createSkillDistributionService } from "./skill-distribution-service.js";
import { isScanResumeStateReference, type AgentSourceScanProcessCommand, type AgentSourceScanProcessData, type AgentSourceScanProcessMessage, runAgentSourceScanJob } from "./agent-source-scan-runner.js";
import { dirname, join } from "node:path";
import { migrateLegacyScanJournal } from "./agent-source-scan-migration.js";

const DEFAULT_MEMORY_LAYER_TIMEOUT_MS = 20_000;

if (!process.send) {
  throw new Error("Agent source scan process requires an IPC channel");
}

const controller = new AbortController();
let started = false;

process.on("message", (message: AgentSourceScanProcessCommand) => {
  if (message.type === "abort") {
    controller.abort();
    return;
  }

  if (started) return;
  started = true;
  void runProcess(message.data).catch((error: unknown) => {
    if (!controller.signal.aborted) {
      postProcessMessage({
        type: "failed",
        message: error instanceof Error ? error.message : "Agent source scan process failed"
      });
    }
  }).finally(() => {
    if (process.connected) process.disconnect?.();
  });
});

process.once("disconnect", () => {
  controller.abort();
});

async function runProcess(data: AgentSourceScanProcessData): Promise<void> {
  let appStateStore: AppStateStore | null = null;
  try {
    appStateStore = createAppStateStore({ databasePath: data.databasePath });
    const legacyMigrationSucceeded = migrateLegacyScanJournal(
      data.databasePath,
      join(dirname(data.databasePath), "agent-source-scans", `${data.job.jobId}.sqlite`),
      data.job.jobId
    );
    const preservedResume = data.job.resume && isScanResumeStateReference(data.job.resume) ? data.job.resume : null;
    const preserveLegacyResume = Boolean(preservedResume && !legacyMigrationSucceeded);
    const memoryClient = createDefaultMemoryClient(process.env);
    const agentSources = createAgentSources(appStateStore, memoryClient);
    await runAgentSourceScanJob(
      {
        ...data.job,
        // The durable per-job store is the source of truth. Do not hydrate the
        // legacy journal arrays into JavaScript while resuming an old job.
        resume: null,
        controller
      },
      agentSources,
      {
        onProgress(progress) {
          postProcessMessage({ type: "progress", progress });
        },
        onResumeChanged(resume) {
          postProcessMessage({ type: "resume", resume: preserveLegacyResume ? preservedResume : null });
        },
        onCompleted(results) {
          postProcessMessage({ type: "completed", results });
        }
      }
    );
  } finally {
    appStateStore?.close();
  }
}

function createAgentSources(appStateStore: AppStateStore, memoryClient: MemoryClient) {
  const sourceRegistry = createBuiltinAgentSourceRegistry();
  const accountSessionRepository = appStateStore.repositories.accountSession;
  const resolveAnalyticsUserId = () => {
    const session = accountSessionRepository.get();
    if (!session.authenticated) return null;
    return resolveLoggedInAnalyticsUserId({
      cloudUuid: accountSessionRepository.getCloudUuid(),
      userId: session.profile.userId,
    });
  };
  const resolveAnalyticsUserMode = () => {
    const mode = appStateStore.repositories.bootstrap.getAppSettings().userMode;
    return mode === "account" || mode === "byok" ? mode : null;
  };
  const ingestionService = createIngestionService({
    memoryClient,
    agentSourceRepository: appStateStore.repositories.agentSources,
    memoryAddAnalytics: createMemoryDesktopAddAnalytics({
      getUserId: resolveAnalyticsUserId,
      getUserMode: resolveAnalyticsUserMode,
    }),
  });

  return createAgentSourceService({
    sourceRegistry,
    agentSourceRepository: appStateStore.repositories.agentSources,
    ingestionService,
    memoryClient,
    skillDistributionService: createSkillDistributionService({
      targetRegistry: createBuiltinSkillTargetRegistry()
    }),
    scanStoreDirectory: `${dataDirectoryForScanStore(appStateStore)}`,
    agentSourceAnalytics: createAgentSourceLifecycleAnalytics({
      getUserId: resolveAnalyticsUserId,
      getUserMode: resolveAnalyticsUserMode,
    }),
  });
}

function dataDirectoryForScanStore(appStateStore: AppStateStore): string {
  return join(dirname(appStateStore.databasePath), "agent-source-scans");
}

function createDefaultMemoryClient(env: NodeJS.ProcessEnv): MemoryClient {
  const memoryLayerConfig = readMemoryLayerConfig(env);
  if (memoryLayerConfig) {
    return createHttpMemoryClient(memoryLayerConfig);
  }

  throw new Error("MEMMY_MEMORY_LAYER_URL is required");
}

function readMemoryLayerConfig(env: NodeJS.ProcessEnv): MemoryLayerConfig | null {
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

function postProcessMessage(message: AgentSourceScanProcessMessage): void {
  if (process.connected) process.send?.(message);
}
