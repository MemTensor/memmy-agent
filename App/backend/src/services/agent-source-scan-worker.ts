import { parentPort, workerData } from "node:worker_threads";
import {
  createHttpMemoryClient,
  createMemosSqliteMemoryClient,
  discoverMemosSqliteSources,
  type MemoryClient,
  type MemoryLayerConfig
} from "../adapters/outbound/memory-client/index.js";
import { createAppStateStore, type AppStateStore } from "../infrastructure/app-state-store/index.js";
import { createAgentSourceScanJournal, type AgentSourceScanJournal } from "../infrastructure/agent-source-scan-journal/index.js";
import { createAgentSourceService } from "./agent-source-service.js";
import { createBuiltinAgentSourceRegistry } from "./builtin-agent-source-registry.js";
import { createIngestionService } from "./ingestion-service.js";
import type { SkillDistributionService } from "./skill-distribution-service.js";
import {
  type AgentSourceScanWorkerCommand,
  type AgentSourceScanWorkerData,
  type AgentSourceScanWorkerMessage,
  isScanResumeStateReference,
  type ScanResumeState,
  type ScanResumeStateReference,
  runAgentSourceScanJob
} from "./agent-source-scan-runner.js";

const DEFAULT_MEMORY_LAYER_TIMEOUT_MS = 20_000;

if (!parentPort) {
  throw new Error("Agent source scan worker requires a parent port");
}

const controller = new AbortController();
parentPort.on("message", (message: AgentSourceScanWorkerCommand) => {
  if (message.type === "abort") {
    controller.abort();
  }
});

void runWorker().catch((error: unknown) => {
  if (!controller.signal.aborted) {
    postWorkerMessage({
      type: "failed",
      message: error instanceof Error ? error.message : "Agent source scan worker failed"
    });
  }
}).finally(() => {
  parentPort?.close();
});

async function runWorker(): Promise<void> {
  const data = workerData as AgentSourceScanWorkerData;
  let appStateStore: AppStateStore | null = null;
  try {
    appStateStore = createAppStateStore({ databasePath: data.databasePath });
    const scanJournal = createAgentSourceScanJournal(appStateStore.db);
    const memoryClient = createDefaultMemoryClient(process.env);
    const agentSources = createAgentSources(appStateStore, memoryClient);
    await runAgentSourceScanJob(
      {
        ...data.job,
        resume: readResumeState(scanJournal, data.job.resume),
        controller
      },
      agentSources,
      {
        onProgress(progress) {
          postWorkerMessage({ type: "progress", progress });
        },
        onResumeChanged(resume) {
          postWorkerMessage({ type: "resume", resume: resume ? writeResumeState(scanJournal, data, resume) : null });
        },
        onCompleted(results) {
          postWorkerMessage({ type: "completed", results });
        }
      }
    );
  } finally {
    appStateStore?.close();
  }
}

function createAgentSources(appStateStore: AppStateStore, memoryClient: MemoryClient) {
  const sourceRegistry = createBuiltinAgentSourceRegistry();
  const ingestionService = createIngestionService({
    memoryClient,
    agentSourceRepository: appStateStore.repositories.agentSources
  });

  return createAgentSourceService({
    sourceRegistry,
    agentSourceRepository: appStateStore.repositories.agentSources,
    ingestionService,
    memoryClient,
    skillDistributionService: createUnavailableSkillDistributionService()
  });
}

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

function createUnavailableSkillDistributionService(): SkillDistributionService {
  const unavailable = async () => {
    throw new Error("Skill distribution is not available in agent source scan worker");
  };

  return {
    install: unavailable,
    uninstall: unavailable,
    installPlugin: unavailable,
    uninstallPlugin: unavailable
  };
}

function readResumeState(scanJournal: AgentSourceScanJournal, resume: AgentSourceScanWorkerData["job"]["resume"]): ScanResumeState | null {
  if (!resume) {
    return null;
  }

  if (!isScanResumeStateReference(resume)) {
    return resume;
  }

  return scanJournal.readResume(resume.jobId);
}

function writeResumeState(
  scanJournal: AgentSourceScanJournal,
  data: AgentSourceScanWorkerData,
  resume: ScanResumeState
): ScanResumeStateReference {
  scanJournal.writeResume({
    jobId: data.job.jobId,
    sourceId: data.job.sourceId,
    mode: data.job.mode,
    resume
  });

  if (resume.phase === "add") {
    return {
      storage: "sqlite",
      phase: "add",
      jobId: data.job.jobId,
      sourceId: resume.collected[0]?.sourceId ?? data.job.sourceId,
      messageCount: resume.collected.reduce((sum, source) => sum + source.messages.length, 0),
      sourceCount: resume.collected.length
    };
  }

  return {
    storage: "sqlite",
    phase: "summarize",
    jobId: data.job.jobId,
    sourceId: data.job.sourceId,
    resultCount: resume.results.length
  };
}

function postWorkerMessage(message: AgentSourceScanWorkerMessage): void {
  parentPort?.postMessage(message);
}
