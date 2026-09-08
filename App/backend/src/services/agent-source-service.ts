/** Agent source service module. */
import { createHash, randomUUID } from "node:crypto";
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH } from "@memmy/local-api-contracts";
import {
  setImmediate as yieldToEventLoop,
  setTimeout as waitForWorkerProgress
} from "node:timers/promises";
import type {
  AddManualInput,
  AgentSourceMemoryPluginConflict,
  AgentSourcePluginActionInput,
  AgentSourceScanMode,
  AgentSourceStatus,
  AgentSourceView,
  ManagedAgentSourceImportInput,
  ManagedAgentSourceImportResult,
  ManagedAgentSourceUpdateInput,
  ScanPermission,
  ScanResult
} from "@memmy/local-api-contracts";
import type {
  ConversationMessage,
  ScanOptions,
  ScanProgress,
  SourceAdapter
} from "../adapters/outbound/agent-source/types.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { SourceRegistry } from "../adapters/outbound/agent-source/source-registry.js";
import type { AgentSourceRepository, AgentSourceRecord } from "../infrastructure/agent-source-store/index.js";
import {
  isCompleteMemoryTurn,
  type IngestionService,
  type IngestionStats
} from "./ingestion-service.js";
import { AgentSourceUnavailableError } from "./runtime-errors.js";
import type { SkillDistributionService } from "./skill-distribution-service.js";
import {
  createAgentSourceLifecycleAnalytics,
  type AgentSourceInstallType,
  type AgentSourceLifecycleAnalytics,
} from "../analytics/agent-source-analytics.js";
import { errorCodeFromUnknown } from "../analytics/analytics-transport.js";
import {
  extractManagedAgentHistory,
  selectIncrementalManagedMessages
} from "./managed-agent-history.js";
import {
  orderedTurns,
  splitTurn,
  stableTurnIdentity,
  isCompleteTurn,
  legacyTurnId,
  legacyTurnRequestId
} from "@memmy/agent-source-core";
import { openAppAgentSourceScanStore, type AppAgentSourceScanStore } from "../infrastructure/agent-source-scan-store/index.js";

export type { ScanProgress } from "../adapters/outbound/agent-source/types.js";

const SCAN_MESSAGE_YIELD_INTERVAL = 100;
const IMPORT_WORKER_BATCH_SIZE = 1;
const IMPORT_PROCESSING_COHORT_SIZE = 100;
// A targeted run leases one job so the timeout never depends on queue ordering.
// One summary can make three content attempts, each with four 180s HTTP attempts
// and backoff; keep a safety margin without replaying the worker request.
const IMPORT_WORKER_TIMEOUT_MS = 2_400_000;
const IMPORT_PROGRESS_POLL_INTERVAL_MS = 250;
const INITIAL_GLOBAL_MEMORY_LIMIT = 1_000;
const INITIAL_ABSENT_SOURCE_MEMORY_LIMIT = 200;
const INITIAL_SOURCE_MEMORY_LIMIT = 1_000;

/** Contract for agent source service. */
export interface AgentSourceService {
  readonly supportsPersistentScan?: true;
  list(): Promise<AgentSourceView[]>;
  scanAll(options?: AgentSourceScanOptions): Promise<ScanResult[]>;
  scanOne(sourceId: string, options?: AgentSourceScanOptions): Promise<ScanResult>;
  collectOne(sourceId: string, options?: AgentSourceScanOptions): Promise<CollectedSourceScan>;
  collectAll(options?: AgentSourceScanOptions): Promise<CollectedSourceScan[]>;
  ingestCollected(collected: readonly CollectedSourceScan[], options?: AgentSourceScanOptions): Promise<ScanResult[]>;
  processImportSummaries(memoryIds: readonly string[], options?: AgentSourceScanOptions): Promise<ProcessingFailure[]>;
  addManual(input: AddManualInput): Promise<AgentSourceView>;
  importManaged(sourceId: string, input: ManagedAgentSourceImportInput): Promise<ManagedAgentSourceImportResult>;
  syncManaged(sourceId: string): Promise<ManagedAgentSourceImportResult>;
  updateManaged(sourceId: string, input: ManagedAgentSourceUpdateInput): Promise<AgentSourceView>;
  remove(sourceId: string): Promise<void>;
  installSkill(sourceId: string): Promise<void>;
  uninstallSkill(sourceId: string): Promise<void>;
  installPlugin(sourceId: string, action?: AgentSourcePluginActionInput): Promise<void>;
  uninstallPlugin(sourceId: string, action?: AgentSourcePluginActionInput): Promise<void>;
  detectMemoryPluginConflicts(): Promise<AgentSourceMemoryPluginConflict[]>;
}

export interface ProcessingFailure {
  memoryId: string;
  reason: string;
}

/** Contract for agent source scan options. */
export interface AgentSourceScanOptions {
  since?: string;
  mode?: AgentSourceScanMode;
  scanStartedAt?: string;
  maxMessages?: number;
  maxScanTargets?: number;
  order?: "source_default" | "recent_first";
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  progressSourceId?: string;
  scanJobId?: string;
}

/** Contract for create agent source service options. */
export interface CreateAgentSourceServiceOptions {
  sourceRegistry: SourceRegistry;
  agentSourceRepository: AgentSourceRepository;
  ingestionService: IngestionService;
  memoryClient: Pick<MemoryClient, "addMemory" | "enqueueImportSummaries" | "getMemoryProcessingStatus" | "runWorker">;
  skillDistributionService: SkillDistributionService;
  agentSourceAnalytics?: AgentSourceLifecycleAnalytics;
  getScanPermission?: () => Promise<ScanPermission>;
  now?: () => string;
  createId?: () => string;
  scanStoreDirectory?: string;
}

/** Creates create agent source service. */
export function createAgentSourceService(options: CreateAgentSourceServiceOptions): AgentSourceService {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;
  const agentSourceAnalytics = options.agentSourceAnalytics ?? createAgentSourceLifecycleAnalytics();

  return {
    supportsPersistentScan: true,
    async list() {
      return await listSources(options);
    },

    async scanAll(scanOptions = {}) {
      if (!scanOptions.scanJobId && !options.scanStoreDirectory) {
        const collected = await this.collectAll(scanOptions);
        const results = await this.ingestCollected(collected, scanOptions);
        const failures = await this.processImportSummaries(results.flatMap((result) => result.memoryIds ?? []), { ...scanOptions, progressSourceId: "all" });
        appendProcessingFailuresToResults(results, failures);
        return results;
      }
      return scanPersistent(options, "all", scanOptions, now);
    },

    async collectAll(scanOptions = {}) {
      scanOptions.signal?.throwIfAborted();
      const adapters = await detectAvailableSourceAdapters(options);
      const collected = await Promise.all(
        adapters.map((adapter) => this.collectOne(adapter.descriptor.sourceId, scanOptions))
      );
      await yieldToEventLoop();
      return shouldApplyInitialGlobalBound(scanOptions, collected) ? boundInitialSubset(collected) : collected;
    },

    async collectOne(sourceId, scanOptions = {}) {
      return collectSourceMessages(options, sourceId, scanOptions, now);
    },

    async ingestCollected(collected, scanOptions = {}) {
      const results: ScanResult[] = [];
      for (const source of collected) {
        scanOptions.signal?.throwIfAborted();
        results.push(await ingestCollectedSource(options, source, scanOptions, now));
      }
      return results;
    },

    async processImportSummaries(memoryIds, scanOptions = {}) {
      return processPendingImportSummaries(options, memoryIds, scanOptions);
    },

    async scanOne(sourceId, scanOptions = {}) {
      if (!scanOptions.scanJobId && !options.scanStoreDirectory) {
        const collected = await this.collectOne(sourceId, scanOptions);
        const result = await ingestCollectedSource(options, collected, scanOptions, now);
        const failures = await processPendingImportSummaries(options, result.memoryIds ?? [], { ...scanOptions, progressSourceId: sourceId });
        appendProcessingFailures(result, failures);
        return result;
      }
      const results = await scanPersistent(options, sourceId, scanOptions, now);
      return results[0] ?? {
        sourceId,
        discoveredConversations: 0,
        emittedMessages: 0,
        skipped: 0,
        errors: [{ conversationId: "scan", reason: "No result" }]
      };
    },

    async addManual(input) {
      const sourceId = createId();
      options.agentSourceRepository.upsertSource({
        sourceId,
        displayName: input.displayName,
        dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
        builtin: false
      });

      return toAgentSourceView(options.agentSourceRepository.listSources().find((source) => source.sourceId === sourceId));
    },

    async importManaged(sourceId, input) {
      const source = ensureManagedSource(options, sourceId);
      if (input.dataPath) {
        options.agentSourceRepository.upsertSource({
          sourceId,
          displayName: source.displayName,
          dataPath: input.dataPath,
          builtin: false
        });
      }

      const messages = sortManagedMessagesForIngestion(input.messages.map((message) => ({
        messageId: message.messageId,
        sourceId,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        workspacePath: message.workspacePath ?? null,
        gitRoot: message.gitRoot ?? null,
        rawMeta: message.rawMeta ?? {}
      })));
      const stats = await options.ingestionService.ingest(toAsyncIterable(messages), {
        sourceId,
        memorySource: source.displayName,
        deferProcessing: true,
        totalMessages: messages.length,
        scanMode: input.mode
      });
      const processingFailures = await processPendingImportSummaries(options, stats.memoryIds, {
        progressSourceId: sourceId
      });
      stats.errors.push(...processingFailures.map((failure) => ({
        conversationId: failure.memoryId,
        reason: failure.reason
      })));

      const existingWatermark = options.agentSourceRepository.getScanWatermark(sourceId);
      const syncBoundaryAt = input.mode === "initial_subset"
        ? input.syncBoundaryAt ?? existingWatermark?.baselineAt ?? earliestMessageCreatedAt(messages)
        : existingWatermark?.baselineAt ?? input.syncBoundaryAt ?? earliestMessageCreatedAt(messages);
      if (input.final && stats.errors.length === 0) {
        const scannedAt = now();
        options.agentSourceRepository.setLastScannedAt(sourceId, scannedAt);
        options.agentSourceRepository.upsertScanWatermark({
          sourceId,
          mode: input.mode,
          baselineAt: syncBoundaryAt,
          latestSeenCreatedAt: maxIso(
            maxIso(existingWatermark?.latestSeenCreatedAt, input.latestSeenAt),
            latestMessageCreatedAt(messages)
          ),
          updatedAt: scannedAt
        });
      }

      return {
        sourceId,
        attempted: stats.attempted,
        written: stats.written,
        deduped: stats.deduped,
        failed: stats.failed,
        memoryIds: stats.memoryIds,
        syncBoundaryAt,
        errors: stats.errors
      };
    },

    async syncManaged(sourceId) {
      const source = ensureManagedSource(options, sourceId);
      if (!source.syncRecipe) {
        throw new Error("Managed Agent source has not completed first-time format discovery");
      }
      const syncBoundaryAt = options.agentSourceRepository.getScanWatermark(sourceId)?.baselineAt;
      if (!syncBoundaryAt) {
        throw new Error("Managed Agent source has no recorded initial sync boundary");
      }
      const messages = selectIncrementalManagedMessages(
        extractManagedAgentHistory(source.syncRecipe),
        syncBoundaryAt
      );
      const result = await this.importManaged(sourceId, {
        mode: "incremental",
        messages,
        syncBoundaryAt,
        latestSeenAt: latestMessageCreatedAt(messages),
        final: true
      });
      if (result.errors.length > 0) {
        throw new Error(`Managed Agent automatic sync failed: ${result.errors.map((error) => error.reason).join("; ")}`);
      }
      return result;
    },

    async updateManaged(sourceId, input) {
      const source = ensureManagedSource(options, sourceId);
      if (input.syncRecipe) {
        const messages = selectIncrementalManagedMessages(
          extractManagedAgentHistory(input.syncRecipe),
          "1970-01-01T00:00:00.000Z"
        );
        if (messages.length === 0) {
          throw new Error("Managed Agent sync recipe found no complete user/assistant turns");
        }
      }
      if (input.dataPath || input.syncRecipe) {
        options.agentSourceRepository.upsertSource({
          sourceId,
          displayName: source.displayName,
          dataPath: input.dataPath ?? source.dataPath,
          builtin: false,
          ...(input.syncRecipe ? { syncRecipe: input.syncRecipe } : {})
        });
      }
      if (input.skillInstalled !== undefined) {
        options.agentSourceRepository.setStatus(sourceId, input.skillInstalled ? "skill_installed" : "not_connected");
      }
      return toAgentSourceView(
        options.agentSourceRepository.listSources().find((candidate) => candidate.sourceId === sourceId)
      );
    },

    async remove(sourceId) {
      options.agentSourceRepository.removeSource(sourceId);
    },

    async installSkill(sourceId) {
      const startedAt = Date.now();
      const statusBefore = readSourceStatus(options, sourceId);
      const permission = await readScanPermission(options);
      const builtin = readSourceBuiltin(options, sourceId);
      try {
        await ensureSourceAvailable(options, sourceId);
        await options.skillDistributionService.install(sourceId);
        ensureSourceExists(options, sourceId);
        options.agentSourceRepository.setStatus(sourceId, "skill_installed");
        agentSourceAnalytics.trackSkillInstalled({
          sourceId,
          builtin,
          permission,
          statusBefore,
          statusAfter: "skill_installed",
          success: true,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        agentSourceAnalytics.trackSkillInstalled({
          sourceId,
          builtin,
          permission,
          statusBefore,
          statusAfter: statusBefore,
          success: false,
          latencyMs: Date.now() - startedAt,
          errorCode: errorCodeFromUnknown(error),
        });
        throw error;
      }
    },

    async uninstallSkill(sourceId) {
      const startedAt = Date.now();
      const statusBefore = readSourceStatus(options, sourceId);
      const permission = await readScanPermission(options);
      const builtin = readSourceBuiltin(options, sourceId);
      try {
        await options.skillDistributionService.uninstall(sourceId);
        ensureSourceExists(options, sourceId);
        options.agentSourceRepository.setStatus(sourceId, "not_connected");
        agentSourceAnalytics.trackSkillUninstalled({
          sourceId,
          builtin,
          permission,
          statusBefore,
          statusAfter: "not_connected",
          success: true,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        agentSourceAnalytics.trackSkillUninstalled({
          sourceId,
          builtin,
          permission,
          statusBefore,
          statusAfter: statusBefore,
          success: false,
          latencyMs: Date.now() - startedAt,
          errorCode: errorCodeFromUnknown(error),
        });
        throw error;
      }
    },

    async installPlugin(sourceId, action = {}) {
      const startedAt = Date.now();
      const installType = normalizePluginInstallType(action.installType);
      const statusBefore = readSourceStatus(options, sourceId);
      const permission = await readScanPermission(options);
      try {
        await ensureSourceAvailable(options, sourceId);
        await options.skillDistributionService.installPlugin(sourceId);
        ensureSourceExists(options, sourceId);
        options.agentSourceRepository.setStatus(sourceId, "plugin_installed");
        agentSourceAnalytics.trackPluginInstalled({
          sourceId,
          permission,
          statusBefore,
          statusAfter: "plugin_installed",
          installType,
          success: true,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        agentSourceAnalytics.trackPluginInstalled({
          sourceId,
          permission,
          statusBefore,
          statusAfter: statusBefore,
          installType,
          success: false,
          latencyMs: Date.now() - startedAt,
          errorCode: errorCodeFromUnknown(error),
        });
        throw error;
      }
    },

    async uninstallPlugin(sourceId, action = {}) {
      const startedAt = Date.now();
      const installType = normalizePluginInstallType(action.installType);
      const statusBefore = readSourceStatus(options, sourceId);
      const permission = await readScanPermission(options);
      try {
        await options.skillDistributionService.uninstallPlugin(sourceId);
        ensureSourceExists(options, sourceId);
        options.agentSourceRepository.setStatus(sourceId, "not_connected");
        agentSourceAnalytics.trackPluginUninstalled({
          sourceId,
          permission,
          statusBefore,
          statusAfter: "not_connected",
          installType,
          success: true,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        agentSourceAnalytics.trackPluginUninstalled({
          sourceId,
          permission,
          statusBefore,
          statusAfter: statusBefore,
          installType,
          success: false,
          latencyMs: Date.now() - startedAt,
          errorCode: errorCodeFromUnknown(error),
        });
        throw error;
      }
    },

    async detectMemoryPluginConflicts() {
      const permission = await readScanPermission(options);
      const conflicts = await options.skillDistributionService.detectMemoryPluginConflicts?.() ?? [];
      for (const conflict of conflicts) {
        agentSourceAnalytics.trackPluginConflictDetected({
          sourceId: conflict.sourceId,
          configPath: conflict.configPath,
          installedPluginId: conflict.installedPluginId,
          permission,
        });
      }
      return conflicts;
    }
  };
}

/** Handles list sources. */
async function listSources(options: CreateAgentSourceServiceOptions): Promise<AgentSourceView[]> {
  const persisted = options.agentSourceRepository.listSources();
  const persistedById = new Map(persisted.map((source) => [source.sourceId, source]));
  const builtinViews = await Promise.all(options.sourceRegistry.list().map(async (adapter) => {
    const available = await adapter.detect();
    const existing = persistedById.get(adapter.descriptor.sourceId);
    if (existing) {
      persistedById.delete(adapter.descriptor.sourceId);
      return {
        ...toAgentSourceView(existing, available),
        displayName: adapter.descriptor.displayName,
        dataPath: adapter.descriptor.dataPath,
        builtin: adapter.descriptor.builtin
      };
    }

    return {
      sourceId: adapter.descriptor.sourceId,
      displayName: adapter.descriptor.displayName,
      dataPath: adapter.descriptor.dataPath,
      builtin: adapter.descriptor.builtin,
      available,
      status: "not_connected",
      messageCount: 0,
      lastScannedAt: null,
      syncReady: false
    } satisfies AgentSourceView;
  }));

  return [
    ...builtinViews.map((source) => ({
      ...source,
      syncBoundaryAt: options.agentSourceRepository.getScanWatermark(source.sourceId)?.baselineAt ?? null
    })),
    ...[...persistedById.values()].map((source) =>
      toAgentSourceView(
        source,
        true,
        options.agentSourceRepository.getScanWatermark(source.sourceId)?.baselineAt ?? null
      )
    )
  ];
}

async function detectAvailableSourceAdapters(options: CreateAgentSourceServiceOptions) {
  const adapters = options.sourceRegistry.list();
  const detected = await Promise.all(adapters.map(async (adapter) => ({
    adapter,
    available: await adapter.detect()
  })));
  return detected.filter((entry) => entry.available).map((entry) => entry.adapter);
}

interface PersistentSourceStage {
  adapter: SourceAdapter;
  sourceId: string;
  mode: AgentSourceScanMode;
  since?: string;
  errors: Array<{ conversationId: string; reason: string }>;
  scanErrorCount: number;
}

/** Runs the production scan through a durable, bounded staging store. */
async function scanPersistent(
  options: CreateAgentSourceServiceOptions,
  requestedSourceId: string,
  scanOptions: AgentSourceScanOptions,
  now: () => string
): Promise<ScanResult[]> {
  const adapters = requestedSourceId === "all"
    ? options.sourceRegistry.list()
    : [options.sourceRegistry.require(requestedSourceId)];
  const jobId = scanOptions.scanJobId ?? randomUUID();
  const directory = options.scanStoreDirectory ?? `${process.cwd()}/agent-source-scans`;
  const store = openAppAgentSourceScanStore(`${directory}/${jobId}.sqlite`, {
    jobId, sourceId: requestedSourceId, mode: scanOptions.mode ?? "incremental", phase: "stage", createdAt: now(), updatedAt: now()
  });
  const results: ScanResult[] = [];
  let completed = false;
  try {
    const available: SourceAdapter[] = [];
    for (const adapter of adapters) {
      scanOptions.signal?.throwIfAborted();
      if (await adapter.detect()) available.push(adapter);
      else if (requestedSourceId !== "all") throw new AgentSourceUnavailableError(adapter.descriptor.displayName);
    }
    const globalInitial = requestedSourceId === "all" && available.length > 0 &&
      (scanOptions.mode === "initial_subset" || (scanOptions.mode === undefined && available.every((adapter) => !options.agentSourceRepository.getScanWatermark(adapter.descriptor.sourceId))));
    const stages: PersistentSourceStage[] = [];
    for (const adapter of available) {
      scanOptions.signal?.throwIfAborted();
      const sourceId = adapter.descriptor.sourceId;
      const watermark = options.agentSourceRepository.getScanWatermark(sourceId);
      const mode = scanOptions.mode ?? (watermark ? "incremental" : "initial_subset");
      const since = scanOptions.since ?? (mode === "incremental" ? watermarkCursor(watermark) : undefined);
      stages.push(await stagePersistentSource(options, store, adapter, mode, since, scanOptions, now));
    }
    if (globalInitial) {
      for (const stage of stages) {
        scanOptions.signal?.throwIfAborted();
        store.saveMeta({ jobId: store.getMeta()?.jobId ?? jobId, sourceId: store.getMeta()?.sourceId ?? requestedSourceId, mode: stage.mode, phase: "prepare", createdAt: store.getMeta()?.createdAt ?? now(), updatedAt: now() });
        const sourceState = store.getSourceState(stage.sourceId);
        store.saveSourceState({ ...(sourceState ?? { sourceId: stage.sourceId, mode: stage.mode, messageCount: store.count(stage.sourceId), resultCount: store.resultCount(stage.sourceId), errorCount: stage.scanErrorCount, updatedAt: now() }), phase: "prepare", updatedAt: now() });
        await preparePersistentSource(options, store, stage.sourceId, stage.mode);
      }
      store.selectInitialTurns(stages.map((stage) => stage.sourceId), INITIAL_GLOBAL_MEMORY_LIMIT, INITIAL_ABSENT_SOURCE_MEMORY_LIMIT);
    }
    for (const stage of stages) {
      const result = await ingestPersistentStagedSource(options, store, stage, scanOptions, now, globalInitial);
      results.push(result);
      store.saveSourceState({
        sourceId: stage.sourceId,
        mode: stage.mode,
        phase: result.errorCount && result.errorCount > 0 ? "failed" : "done",
        messageCount: result.emittedMessages,
        resultCount: store.resultCount(stage.sourceId),
        errorCount: result.errorCount ?? result.errors.length,
        updatedAt: now(),
        ...(stage.since ? { watermarkedSince: stage.since } : {})
      });
    }
    const hasErrors = results.some((result) => (result.errorCount ?? result.errors.length) > 0);
    store.saveMeta({ jobId, sourceId: requestedSourceId, mode: scanOptions.mode ?? "incremental", phase: hasErrors ? "failed" : "done", createdAt: store.getMeta()?.createdAt ?? now(), updatedAt: now(), ...(hasErrors ? { error: "Agent source scan completed with errors" } : {}) });
    // Keep large result details available for the paged results endpoint until
    // the client consumes the final page. Small jobs can release their store
    // immediately as before.
    completed = !hasErrors && !results.some((result) => result.detailsTruncated);
    return results;
  } catch (error) {
    store.saveMeta({ ...(store.getMeta() ?? { jobId, sourceId: requestedSourceId, mode: scanOptions.mode ?? "incremental", phase: "stage", createdAt: now(), updatedAt: now() }), phase: "failed", updatedAt: now(), error: error instanceof Error ? error.message : "Agent source scan failed" });
    throw error;
  } finally {
    if (completed) store.remove();
    else store.close();
  }
}

async function stagePersistentSource(
  options: CreateAgentSourceServiceOptions,
  store: AppAgentSourceScanStore,
  adapter: SourceAdapter,
  mode: AgentSourceScanMode,
  since: string | undefined,
  scanOptions: AgentSourceScanOptions,
  now: () => string
): Promise<PersistentSourceStage> {
  const sourceId = adapter.descriptor.sourceId;
  options.agentSourceRepository.upsertSource({ sourceId, displayName: adapter.descriptor.displayName, dataPath: adapter.descriptor.dataPath, builtin: adapter.descriptor.builtin });
  store.saveMeta({ jobId: store.getMeta()?.jobId ?? scanOptions.scanJobId ?? "", sourceId: store.getMeta()?.sourceId ?? sourceId, mode, phase: "stage", createdAt: store.getMeta()?.createdAt ?? now(), updatedAt: now() });
  store.saveSourceState({ sourceId, mode, phase: "stage", messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: 0, updatedAt: now(), ...(since ? { watermarkedSince: since } : {}) });
  const errors: Array<{ conversationId: string; reason: string }> = [];
  let scanErrorCount = 0;
  let batch: ConversationMessage[] = [];
  let bytes = 0;
  let emittedOrdinal = 0;
  try {
    for await (const message of adapter.scan({
      since,
      order: scanOptions.order ?? (mode === "initial_subset" ? "recent_first" : "source_default"),
      fullHistory: true,
      signal: scanOptions.signal,
      onProgress: (progress) => emitProgress(scanOptions, { ...progress, phase: "scan" })
    })) {
      scanOptions.signal?.throwIfAborted();
      const messageBytes = Buffer.byteLength(JSON.stringify(message));
      if (messageBytes > 64 * 1024 * 1024) {
        scanErrorCount += 1;
        if (errors.length < 1000) errors.push({ conversationId: message.conversationId, reason: "scan record exceeds 64 MiB limit" });
        store.saveResult({ sourceId, conversationId: message.conversationId, error: "scan record exceeds 64 MiB limit" });
        continue;
      }
      if (batch.length > 0 && (batch.length >= 500 || bytes + messageBytes > 8 * 1024 * 1024)) {
        store.stageBatch(batch);
        const last = batch[batch.length - 1]!;
        store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
        batch = [];
        bytes = 0;
      }
      batch.push({ ...message, ordinal: emittedOrdinal++ });
      bytes += messageBytes;
      if (batch.length >= 500 || bytes >= 8 * 1024 * 1024) {
        store.stageBatch(batch);
        const last = batch[batch.length - 1]!;
        store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
        batch = [];
        bytes = 0;
      }
    }
    if (batch.length > 0) {
      store.stageBatch(batch);
      const last = batch[batch.length - 1]!;
      store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
    }
  } catch (error) {
    if (scanOptions.signal?.aborted) throw error;
    scanErrorCount += 1;
    const reason = error instanceof Error ? error.message : "Agent source scan failed";
    if (errors.length < 1000) errors.push({ conversationId: "scan", reason });
    store.saveResult({ sourceId, conversationId: "scan", error: reason });
  }
  store.saveSourceState({ sourceId, mode, phase: scanErrorCount > 0 ? "failed" : "stage", messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: scanErrorCount, updatedAt: now(), ...(since ? { watermarkedSince: since } : {}) });
  return { adapter, sourceId, mode, since, errors, scanErrorCount };
}

async function ingestPersistentStagedSource(
  options: CreateAgentSourceServiceOptions,
  store: AppAgentSourceScanStore,
  stage: PersistentSourceStage,
  scanOptions: AgentSourceScanOptions,
  now: () => string,
  globalInitial: boolean
): Promise<ScanResult> {
  const { sourceId, mode, since } = stage;
  if (!globalInitial) {
    store.saveMeta({ jobId: store.getMeta()?.jobId ?? scanOptions.scanJobId ?? "", sourceId: store.getMeta()?.sourceId ?? sourceId, mode, phase: "prepare", createdAt: store.getMeta()?.createdAt ?? now(), updatedAt: now() });
    const sourceState = store.getSourceState(sourceId);
    store.saveSourceState({ ...(sourceState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: now() }), phase: "prepare", updatedAt: now() });
    await preparePersistentSource(options, store, sourceId, mode);
    if (mode === "initial_subset") store.selectInitialTurns([sourceId], INITIAL_SOURCE_MEMORY_LIMIT, 0);
  }
  store.saveMeta({ jobId: store.getMeta()?.jobId ?? scanOptions.scanJobId ?? "", sourceId: store.getMeta()?.sourceId ?? sourceId, mode, phase: "ingest", createdAt: store.getMeta()?.createdAt ?? now(), updatedAt: now() });
  const preparedState = store.getSourceState(sourceId);
  store.saveSourceState({ ...(preparedState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: now() }), phase: "ingest", updatedAt: now() });
  const ingestion = await ingestPersistentSource(options, store, sourceId, scanOptions, []);
  const scannedAt = now();
  options.agentSourceRepository.setLastScannedAt(sourceId, scannedAt);
  const skillResult = await ingestSourceSkills(options, sourceId, scanOptions, store);
  if (stage.errors.length === 0 && ingestion.errors.length === 0 && skillResult.errorCount === 0) updatePersistentWatermark(options, sourceId, mode, ingestion.latestSeenAt, scannedAt, since);
  const allErrors = [...stage.errors, ...ingestion.errors, ...skillResult.errors];
  const errorCount = stage.scanErrorCount + ingestion.errorCount + skillResult.errorCount;
  const memoryIdCount = ingestion.memoryIdCount + skillResult.memoryIdCount;
  store.saveMeta({ jobId: store.getMeta()?.jobId ?? scanOptions.scanJobId ?? "", sourceId: store.getMeta()?.sourceId ?? sourceId, mode, phase: "summarize", createdAt: store.getMeta()?.createdAt ?? scannedAt, updatedAt: scannedAt });
  store.saveSourceState({ sourceId, mode, phase: "summarize", messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount, updatedAt: scannedAt, ...(since ? { watermarkedSince: since } : {}) });
  return {
    sourceId,
    discoveredConversations: store.conversationCount(sourceId),
    emittedMessages: store.count(sourceId),
    skipped: ingestion.deduped,
    memoryIds: ingestion.memoryIds,
    memoryIdCount,
    errorCount,
    detailsTruncated: errorCount > 1000 || memoryIdCount > 1000,
    errors: allErrors.slice(0, 1000)
  };
}

async function preparePersistentSource(options: CreateAgentSourceServiceOptions, store: AppAgentSourceScanStore, sourceId: string, mode: AgentSourceScanMode): Promise<void> {
  let cursor: { conversationId: string; createdAt: string; messageId: string; ordinal: number } | undefined;
  let currentId: string | null = null;
  let currentTurn: ConversationMessage[] = [];
  let turnIndex = 0;
  let hash = createHash("sha256");
  let first = true;
  let latest: ConversationMessage | null = null;
  const flushTurn = () => {
    if (!currentTurn.length || !isCompleteTurn(currentTurn)) return;
    const firstMessage = currentTurn[0]!;
    const lastMessage = currentTurn[currentTurn.length - 1]!;
    const turn = { sourceId, conversationId: firstMessage.conversationId, turnIndex, messages: currentTurn };
    store.saveTurnMeta({
      sourceId,
      conversationId: firstMessage.conversationId,
      turnId: stableTurnIdentity(turn),
      firstMessageId: firstMessage.messageId,
      firstCreatedAt: firstMessage.createdAt,
      lastMessageId: lastMessage.messageId,
      lastCreatedAt: lastMessage.createdAt,
      selected: true
    });
    turnIndex += 1;
  };
  const flush = () => {
    if (!currentId || !latest) return;
    hash.update("]");
    const contentHash = hash.digest("hex");
    const checkpoint = options.agentSourceRepository.getConversationCheckpoint(sourceId, currentId);
    const selected = mode === "full" || mode === "initial_subset" || !checkpoint
      || Date.parse(latest.createdAt) > Date.parse(checkpoint.lastCreatedAt)
      || (Date.parse(latest.createdAt) === Date.parse(checkpoint.lastCreatedAt) && latest.messageId.localeCompare(checkpoint.lastMessageId) > 0)
      || checkpoint.contentHash !== contentHash;
    store.saveConversationMeta({ sourceId, conversationId: currentId, lastMessageId: latest.messageId, lastCreatedAt: latest.createdAt, contentHash, selected });
  };
  while (true) {
    const page = readScanPage(store, sourceId, cursor);
    if (page.length === 0) break;
    for (const message of page) {
      if (message.conversationId !== currentId) {
        flushTurn();
        flush();
        currentId = message.conversationId;
        currentTurn = [];
        turnIndex = 0;
        hash = createHash("sha256");
        hash.update("[");
        first = true;
      }
      if (message.role === "user" && currentTurn.length > 0) {
        flushTurn();
        currentTurn = [];
      }
      currentTurn.push(message);
      if (!first) hash.update(",");
      first = false;
      hash.update(JSON.stringify({ messageId: message.messageId, role: message.role, content: message.content, createdAt: message.createdAt, toolName: hashMetaString(message, "toolName") ?? hashMetaString(message, "hermesToolName"), toolCallId: hashMetaString(message, "toolCallId") ?? hashMetaString(message, "hermesToolCallId") }));
      latest = message;
    }
    const last = page[page.length - 1]!;
    cursor = { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 };
  }
  flushTurn();
  if (currentId && latest) flush();
}

function hashMetaString(message: ConversationMessage, key: string): string | undefined {
  const value = message.rawMeta[key];
  return typeof value === "string" ? value : undefined;
}

async function ingestPersistentSource(
  options: CreateAgentSourceServiceOptions,
  store: AppAgentSourceScanStore,
  sourceId: string,
  scanOptions: AgentSourceScanOptions,
  initialErrors: readonly { conversationId: string; reason: string }[]
): Promise<{ memoryIds: string[]; memoryIdCount: number; deduped: number; errorCount: number; errors: Array<{ conversationId: string; reason: string }>; latestSeenAt: string | null }> {
  const memoryIds: string[] = [];
  let memoryIdCount = 0;
  const pendingIds: string[] = [];
  const errors = initialErrors.slice(0, 1000);
  let errorCount = initialErrors.length;
  let deduped = 0;
  let latestSeenAt: string | null = null;
  let activeConversationId: string | null = null;
  let activeConversationFailed = false;
  const commitConversation = () => {
    if (!activeConversationId || activeConversationFailed) return;
    const meta = store.getConversationMeta(sourceId, activeConversationId);
    if (!meta) return;
    const updatedAt = new Date().toISOString();
    const checkpoint = { sourceId, conversationId: activeConversationId, lastMessageId: meta.lastMessageId, lastCreatedAt: meta.lastCreatedAt, contentHash: meta.contentHash, updatedAt };
    store.saveCheckpoint(checkpoint);
    options.agentSourceRepository.upsertConversationCheckpoint(checkpoint);
  };
  const pages = (async function*() {
    let cursor: { conversationId: string; createdAt: string; messageId: string; ordinal: number } | undefined;
    while (true) {
      const page = readScanPage(store, sourceId, cursor);
      if (page.length === 0) break;
      for (const message of page) {
        yield message;
      }
      const last = page[page.length - 1]!;
      cursor = { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 };
    }
  })();
  for await (const turn of orderedTurns(pages)) {
    scanOptions.signal?.throwIfAborted();
    const turnLatest = turn.messages[turn.messages.length - 1]?.createdAt ?? null;
    if (turnLatest && (!latestSeenAt || Date.parse(turnLatest) > Date.parse(latestSeenAt))) latestSeenAt = turnLatest;
    if (turn.conversationId !== activeConversationId) {
      commitConversation();
      activeConversationId = turn.conversationId;
      activeConversationFailed = false;
    }
    const conversationMeta = store.getConversationMeta(sourceId, turn.conversationId);
    if (conversationMeta?.selected === false) continue;
    const selectedTurn = store.getTurnMeta(sourceId, turn.conversationId, stableTurnIdentity(turn));
    if (selectedTurn && !selectedTurn.selected) continue;
    let turnSucceeded = true;
    // Leave ample room for JSON escaping and the add-memory envelope while
    // keeping every request below the 1 MiB wire limit.
    const parts = splitTurn(turn, 4000, 512 * 1024);
    for (const part of parts) {
      const contentHash = createHash("sha256").update(part.content).digest("hex");
      const requestId = parts.length === 1
        ? legacyTurnRequestId(turn)
        : createHash("sha256").update([stableTurnIdentity(turn), String(part.partIndex), contentHash].join("\u0000")).digest("hex");
      const turnId = parts.length === 1 ? legacyTurnId(turn) : `${sourceId}:${part.parentTurnId}:${part.partIndex}`;
      try {
        const added = await options.memoryClient.addMemory({
          requestId,
          adapterId: `agent-source:${sourceId}`,
          content: part.content,
          layer: "L1",
          title: firstTurnLine(part.messages) ?? `${sourceId} conversation`,
          tags: ["agent-source", sourceId],
          source: sourceId,
          turnId,
          createdAt: part.messages[0]!.createdAt,
          deferProcessing: true
        });
        if (added.duplicate) deduped += part.messages.length;
        else {
          memoryIdCount += 1;
          if (memoryIds.length < 1000) memoryIds.push(added.id);
          pendingIds.push(added.id);
          if (pendingIds.length >= IMPORT_PROCESSING_COHORT_SIZE) {
            const cohort = pendingIds.splice(0, pendingIds.length);
            const failures = await processPendingImportSummaries(options, cohort, { ...scanOptions, progressSourceId: sourceId });
            if (failures.length > 0) activeConversationFailed = true;
            const mapped = failures.map((failure) => ({ conversationId: failure.memoryId, reason: failure.reason }));
            errorCount += mapped.length;
            errors.push(...mapped.slice(0, Math.max(0, 1000 - errors.length)));
            for (const failure of failures) store.saveResult({ sourceId, conversationId: failure.memoryId, error: failure.reason });
          }
        }
        store.saveResult({ sourceId, conversationId: turn.conversationId, memoryId: added.id });
      } catch (error) {
        turnSucceeded = false;
        activeConversationFailed = true;
        const reason = error instanceof Error ? error.message : "Agent source ingestion failed";
        errorCount += 1;
        if (errors.length < 1000) errors.push({ conversationId: turn.conversationId, reason });
        store.saveResult({ sourceId, conversationId: turn.conversationId, error: reason });
      }
    }
    if (!turnSucceeded) activeConversationFailed = true;
    emitProgress(scanOptions, { sourceId, phase: "add", current: memoryIds.length + deduped, total: store.count(sourceId), message: "Adding raw memories" });
  }
  if (pendingIds.length > 0) {
    const failures = await processPendingImportSummaries(options, pendingIds, { ...scanOptions, progressSourceId: sourceId });
    if (failures.length > 0) activeConversationFailed = true;
    const mapped = failures.map((failure) => ({ conversationId: failure.memoryId, reason: failure.reason }));
    errorCount += mapped.length;
    errors.push(...mapped.slice(0, Math.max(0, 1000 - errors.length)));
    for (const failure of failures) store.saveResult({ sourceId, conversationId: failure.memoryId, error: failure.reason });
  }
  commitConversation();
  return { memoryIds, memoryIdCount, deduped, errorCount, errors, latestSeenAt };
}

function readScanPage(store: AppAgentSourceScanStore, sourceId: string, cursor?: { conversationId: string; createdAt: string; messageId: string; ordinal: number }): ConversationMessage[] {
  const page: ConversationMessage[] = [];
  let bytes = 0;
  for (const message of store.messages(sourceId, cursor, 500)) {
    page.push(message);
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (page.length >= 500 || bytes >= 8 * 1024 * 1024) break;
  }
  return page;
}

function firstTurnLine(messages: readonly ConversationMessage[]): string | undefined {
  const value = messages.find((message) => message.role === "user")?.content;
  const line = value?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  return line ? (line.length <= 120 ? line : `${line.slice(0, 117)}...`) : undefined;
}

function updatePersistentWatermark(options: CreateAgentSourceServiceOptions, sourceId: string, mode: AgentSourceScanMode, latestSeenAt: string | null, scannedAt: string, since?: string): void {
  const existing = options.agentSourceRepository.getScanWatermark(sourceId);
  options.agentSourceRepository.upsertScanWatermark({ sourceId, mode, baselineAt: existing?.baselineAt ?? since ?? scannedAt, latestSeenCreatedAt: maxIso(existing?.latestSeenCreatedAt ?? null, latestSeenAt), updatedAt: scannedAt });
}

export interface CollectedSourceScan {
  sourceId: string;
  scanMode?: AgentSourceScanMode;
  scanStartedAt?: string;
  watermarkedSince?: string;
  conversationIds: string[];
  messages: ConversationMessage[];
  errors: Array<{ conversationId: string; reason: string }>;
}

/** Handles collect source messages. */
async function collectSourceMessages(
  options: CreateAgentSourceServiceOptions,
  sourceId: string,
  scanOptions: AgentSourceScanOptions,
  now: () => string
): Promise<CollectedSourceScan> {
  const adapter = options.sourceRegistry.require(sourceId);
  if (!(await adapter.detect())) {
    throw new AgentSourceUnavailableError(adapter.descriptor.displayName);
  }

  options.agentSourceRepository.upsertSource({
    sourceId: adapter.descriptor.sourceId,
    displayName: adapter.descriptor.displayName,
    dataPath: adapter.descriptor.dataPath,
    builtin: adapter.descriptor.builtin
  });

  const watermark = options.agentSourceRepository.getScanWatermark(sourceId);
  const scanMode = scanOptions.mode ?? (watermark ? "incremental" : "initial_subset");
  const scanStartedAt = scanOptions.scanStartedAt ?? now();
  const since = scanOptions.since ?? (scanMode === "incremental" ? watermarkCursor(watermark) : undefined);
  const maxMessages = scanOptions.maxMessages;
  const maxScanTargets =
    scanOptions.maxScanTargets ?? (scanMode === "initial_subset" ? INITIAL_SOURCE_MEMORY_LIMIT : undefined);
  const order = scanOptions.order ?? (scanMode === "initial_subset" ? "recent_first" : "source_default");

  const collected: CollectedSourceScan = {
    sourceId,
    scanMode,
    scanStartedAt,
    watermarkedSince: since,
    conversationIds: [],
    messages: [],
    errors: []
  };
  const conversationIds = new Set<string>();

  emitProgress(scanOptions, {
    sourceId,
    phase: "scan",
    current: 0,
    total: 0,
    message: "Scanning source history"
  });

  try {
    for await (const message of adapter.scan({
      since,
      maxMessages,
      maxScanTargets,
      order,
      signal: scanOptions.signal,
      onProgress(progress) {
        emitProgress(scanOptions, {
          sourceId: progress.sourceId,
          phase: "scan",
          current: collected.messages.length,
          total: 0,
          message: progress.message
        });
      }
    })) {
      scanOptions.signal?.throwIfAborted();
      collected.messages.push(message);
      if (!conversationIds.has(message.conversationId)) {
        conversationIds.add(message.conversationId);
        collected.conversationIds.push(message.conversationId);
      }
      if (collected.messages.length % SCAN_MESSAGE_YIELD_INTERVAL === 0) {
        emitProgress(scanOptions, {
          sourceId,
          phase: "scan",
          current: collected.messages.length,
          total: 0,
          message: "Scanning source history"
        });
        await yieldToEventLoop();
      }
    }
  } catch (error) {
    if (scanOptions.signal?.aborted) {
      throw error;
    }
    collected.errors.push({
      conversationId: "scan",
      reason: error instanceof Error ? error.message : "Agent source scan failed"
    });
  }

  const bounded =
    scanMode === "initial_subset"
      ? boundSourceToRecentMemoryUnits(collected, INITIAL_SOURCE_MEMORY_LIMIT)
      : collected;
  const checkpointFiltered = scanMode === "incremental"
    ? filterCheckpointedConversations(options, bounded)
    : bounded;
  emitProgress(scanOptions, {
    sourceId,
    phase: "scan",
    current: checkpointFiltered.messages.length,
    total: checkpointFiltered.messages.length,
    message: "Source scan completed"
  });
  return checkpointFiltered;
}

async function ingestCollectedSource(
  options: CreateAgentSourceServiceOptions,
  collected: CollectedSourceScan,
  scanOptions: AgentSourceScanOptions,
  now: () => string
): Promise<ScanResult> {
  let skipped = 0;
  let stats: IngestionStats | undefined;
  const errors = [...collected.errors];

  emitProgress(scanOptions, {
    sourceId: collected.sourceId,
    phase: "add",
    current: 0,
    total: collected.messages.length,
    message: "Adding raw memories"
  });

  try {
    const ingestMessages = sortMessagesForIngestion(collected.messages);
    stats = await options.ingestionService.ingest(toAsyncIterable(ingestMessages), {
      sourceId: collected.sourceId,
      signal: scanOptions.signal,
      deferProcessing: true,
      totalMessages: ingestMessages.length,
      scanMode: collected.scanMode ?? scanOptions.mode,
      replaySeenConversationIds: findContentRevisedConversationIds(options, collected),
      onProgress(progress) {
        emitProgress(scanOptions, {
          sourceId: progress.sourceId,
          phase: "add",
          current: progress.current,
          total: progress.total,
          message: "Adding raw memories"
        });
      }
    });
    scanOptions.signal?.throwIfAborted();
    skipped = stats.deduped;
    errors.push(...stats.errors);
  } catch (error) {
    if (scanOptions.signal?.aborted) {
      throw error;
    }
    errors.push({
      conversationId: "ingest",
      reason: error instanceof Error ? error.message : "Agent source ingestion failed"
    });
  }

  const scannedAt = now();
  options.agentSourceRepository.setLastScannedAt(collected.sourceId, scannedAt);
  if (stats) {
    updateConversationCheckpoints(options, collected, stats.completedConversationIds, scannedAt);
  }
  if (
    stats &&
    errors.length === 0 &&
    stats.incompleteConversationIds.length === 0 &&
    stats.failedConversationIds.length === 0
  ) {
    updateScanWatermark(options, collected, scanOptions, scannedAt);
  }
  errors.push(...(await ingestSourceSkills(options, collected.sourceId, scanOptions)).errors);
  return {
    sourceId: collected.sourceId,
    discoveredConversations: collected.conversationIds.length,
    emittedMessages: collected.messages.length,
    skipped,
    memoryIds: stats?.memoryIds ?? [],
    errors
  };
}

interface SkillScanOutcome {
  errors: Array<{ conversationId: string; reason: string }>;
  errorCount: number;
  memoryIdCount: number;
}

async function ingestSourceSkills(
  options: CreateAgentSourceServiceOptions,
  sourceId: string,
  scanOptions: AgentSourceScanOptions,
  store?: AppAgentSourceScanStore
): Promise<SkillScanOutcome> {
  if (!options.skillDistributionService.listSkills) return { errors: [], errorCount: 0, memoryIdCount: 0 };

  const errors: Array<{ conversationId: string; reason: string }> = [];
  let errorCount = 0;
  let memoryIdCount = 0;
  let skills;
  try {
    skills = await options.skillDistributionService.listSkills(sourceId);
  } catch (error) {
    const detail = {
      conversationId: "skills",
      reason: error instanceof Error ? error.message : "Agent Skill scan failed"
    };
    store?.saveResult({ sourceId, conversationId: detail.conversationId, error: detail.reason });
    return { errors: [detail], errorCount: 1, memoryIdCount: 0 };
  }

  for (const skill of skills) {
    scanOptions.signal?.throwIfAborted();
    try {
      const added = await options.memoryClient.addMemory({
        requestId: `agent-source-skill:${sourceId}:${skill.sourceSkillId}:${skill.sourceContentHash}`,
        adapterId: `agent-source:${sourceId}`,
        content: skill.content,
        layer: "Skill",
        title: skill.title,
        tags: ["agent-source", "cross-agent-skill", sourceId],
        source: sourceId,
        turnId: `skill:${skill.sourceSkillId}:${skill.sourceSkillVersion}`,
        createdAt: skill.updatedAt,
        sourceAgentId: sourceId,
        sourceSkillId: skill.sourceSkillId,
        sourceSkillPath: skill.sourceSkillPath,
        sourceSkillVersion: skill.sourceSkillVersion,
        sourceContentHash: skill.sourceContentHash
      });
      memoryIdCount += 1;
      store?.saveResult({ sourceId, conversationId: `skill:${skill.sourceSkillId}`, memoryId: added.id });
    } catch (error) {
      errorCount += 1;
      const detail = {
        conversationId: `skill:${skill.sourceSkillId}`,
        reason: error instanceof Error ? error.message : "Agent Skill import failed"
      };
      store?.saveResult({ sourceId, conversationId: detail.conversationId, error: detail.reason });
      if (errors.length < 1000) errors.push(detail);
    }
  }
  return { errors, errorCount, memoryIdCount };
}

function filterCheckpointedConversations(
  options: CreateAgentSourceServiceOptions,
  collected: CollectedSourceScan
): CollectedSourceScan {
  const grouped = groupMessagesByConversation(collected.messages);
  const included = new Set<string>();
  for (const [conversationId, messages] of grouped) {
    const latest = latestConversationMessage(messages);
    const contentHash = conversationContentHash(messages);
    const checkpoint = options.agentSourceRepository.getConversationCheckpoint(
      collected.sourceId,
      conversationId
    );
    if (!checkpoint || !latest || compareMessageCursor(latest, checkpoint) > 0 || checkpoint.contentHash !== contentHash) {
      included.add(conversationId);
    }
  }
  return {
    ...collected,
    conversationIds: collected.conversationIds.filter((id) => included.has(id)),
    messages: collected.messages.filter((message) => included.has(message.conversationId))
  };
}

function findContentRevisedConversationIds(
  options: CreateAgentSourceServiceOptions,
  collected: CollectedSourceScan
): ReadonlySet<string> {
  const revised = new Set<string>();
  for (const [conversationId, messages] of groupMessagesByConversation(collected.messages)) {
    const latest = latestConversationMessage(messages);
    const checkpoint = options.agentSourceRepository.getConversationCheckpoint(
      collected.sourceId,
      conversationId
    );
    if (
      latest &&
      checkpoint &&
      compareMessageCursor(latest, checkpoint) === 0 &&
      checkpoint.contentHash !== conversationContentHash(messages)
    ) {
      revised.add(conversationId);
    }
  }
  return revised;
}

function updateConversationCheckpoints(
  options: CreateAgentSourceServiceOptions,
  collected: CollectedSourceScan,
  completedConversationIds: readonly string[],
  updatedAt: string
): void {
  const grouped = groupMessagesByConversation(collected.messages);
  for (const conversationId of completedConversationIds) {
    const latest = latestConversationMessage(grouped.get(conversationId) ?? []);
    if (!latest) continue;
    options.agentSourceRepository.upsertConversationCheckpoint({
      sourceId: collected.sourceId,
      conversationId,
      lastMessageId: latest.messageId,
      lastCreatedAt: latest.createdAt,
      contentHash: conversationContentHash(grouped.get(conversationId) ?? []),
      updatedAt
    });
  }
}

function groupMessagesByConversation(
  messages: readonly ConversationMessage[]
): Map<string, ConversationMessage[]> {
  const grouped = new Map<string, ConversationMessage[]>();
  for (const message of messages) {
    const current = grouped.get(message.conversationId) ?? [];
    current.push(message);
    grouped.set(message.conversationId, current);
  }
  return grouped;
}

function latestConversationMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  return [...messages].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.messageId.localeCompare(left.messageId)
  )[0];
}

function compareMessageCursor(
  message: ConversationMessage,
  checkpoint: { lastCreatedAt: string; lastMessageId: string }
): number {
  return Date.parse(message.createdAt) - Date.parse(checkpoint.lastCreatedAt) ||
    message.messageId.localeCompare(checkpoint.lastMessageId);
}

function conversationContentHash(messages: readonly ConversationMessage[]): string {
  const content = sortMessagesForIngestion(messages).map((message) => ({
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    toolName: conversationMetaString(message, "toolName") ?? conversationMetaString(message, "hermesToolName"),
    toolCallId: conversationMetaString(message, "toolCallId") ?? conversationMetaString(message, "hermesToolCallId")
  }));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function conversationMetaString(message: ConversationMessage, key: string): string | undefined {
  const value = message.rawMeta[key];
  return typeof value === "string" ? value : undefined;
}

function shouldApplyInitialGlobalBound(
  scanOptions: AgentSourceScanOptions,
  collected: readonly CollectedSourceScan[]
): boolean {
  return scanOptions.mode === "initial_subset" || collected.every((source) => source.scanMode === "initial_subset");
}

function boundInitialSubset(collected: readonly CollectedSourceScan[]): CollectedSourceScan[] {
  const ranked = sortMemoryUnitsRecent(collected.flatMap(buildSourceMemoryUnits));
  const selectedKeys = new Set<string>();
  const selectedUnits = ranked.slice(0, INITIAL_GLOBAL_MEMORY_LIMIT);
  for (const unit of selectedUnits) {
    selectedKeys.add(unit.unitKey);
  }

  const presentSources = new Set(selectedUnits.map((unit) => unit.sourceId));
  for (const source of collected) {
    if (presentSources.has(source.sourceId)) {
      continue;
    }
    for (const unit of sortMemoryUnitsRecent(buildSourceMemoryUnits(source)).slice(0, INITIAL_ABSENT_SOURCE_MEMORY_LIMIT)) {
      if (!selectedKeys.has(unit.unitKey)) {
        selectedKeys.add(unit.unitKey);
        selectedUnits.push(unit);
      }
    }
  }

  const unitsBySource = new Map<string, SourceMemoryUnit[]>();
  for (const unit of selectedUnits) {
    const units = unitsBySource.get(unit.sourceId) ?? [];
    units.push(unit);
    unitsBySource.set(unit.sourceId, units);
  }

  return collected.map((source) => {
    return applySelectedMemoryUnits(source, unitsBySource.get(source.sourceId) ?? []);
  });
}

interface SourceMemoryUnit {
  sourceId: string;
  conversationId: string;
  unitKey: string;
  createdAt: string;
  messages: ConversationMessage[];
}

function boundSourceToRecentMemoryUnits(source: CollectedSourceScan, limit: number): CollectedSourceScan {
  return applySelectedMemoryUnits(source, sortMemoryUnitsRecent(buildSourceMemoryUnits(source)).slice(0, limit));
}

function applySelectedMemoryUnits(source: CollectedSourceScan, units: readonly SourceMemoryUnit[]): CollectedSourceScan {
  const messages = sortMessagesForIngestion(units.flatMap((unit) => unit.messages));
  return {
    ...source,
    messages,
    conversationIds: uniqueConversationIds(messages)
  };
}

function buildSourceMemoryUnits(source: CollectedSourceScan): SourceMemoryUnit[] {
  const messagesByConversation = new Map<string, ConversationMessage[]>();
  for (const message of sortMessagesForIngestion(source.messages)) {
    const messages = messagesByConversation.get(message.conversationId) ?? [];
    messages.push(message);
    messagesByConversation.set(message.conversationId, messages);
  }

  return [...messagesByConversation.values()].flatMap((messages) => buildConversationMemoryUnits(source.sourceId, messages));
}

function buildConversationMemoryUnits(sourceId: string, messages: readonly ConversationMessage[]): SourceMemoryUnit[] {
  const units: SourceMemoryUnit[] = [];
  let current: ConversationMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      pushCompleteMemoryUnit(sourceId, current, units);
      current = [message];
      continue;
    }

    if (current.length > 0) {
      current.push(message);
    }
  }

  pushCompleteMemoryUnit(sourceId, current, units);
  return units;
}

function pushCompleteMemoryUnit(
  sourceId: string,
  messages: readonly ConversationMessage[],
  units: SourceMemoryUnit[]
): void {
  if (!isCompleteMemoryTurn(messages)) {
    return;
  }
  const userMessage = messages[0]!;

  units.push({
    sourceId,
    conversationId: userMessage.conversationId,
    unitKey: `${sourceId}:${userMessage.conversationId}:${userMessage.messageId}`,
    createdAt: userMessage.createdAt,
    messages: [...messages]
  });
}

function sortMemoryUnitsRecent(units: readonly SourceMemoryUnit[]): SourceMemoryUnit[] {
  return [...units].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.conversationId.localeCompare(right.conversationId) ||
    left.unitKey.localeCompare(right.unitKey)
  );
}

function updateScanWatermark(
  options: CreateAgentSourceServiceOptions,
  collected: CollectedSourceScan,
  scanOptions: AgentSourceScanOptions,
  scannedAt: string
): void {
  const scanMode = collected.scanMode ?? scanOptions.mode ?? "incremental";
  const existing = options.agentSourceRepository.getScanWatermark(collected.sourceId);
  const latestSeenCreatedAt = maxIso(existing?.latestSeenCreatedAt ?? null, latestMessageCreatedAt(collected.messages));
  options.agentSourceRepository.upsertScanWatermark({
    sourceId: collected.sourceId,
    mode: scanMode,
    baselineAt: existing?.baselineAt ?? collected.scanStartedAt ?? scannedAt,
    latestSeenCreatedAt,
    updatedAt: scannedAt
  });
}

function watermarkCursor(watermark: ReturnType<AgentSourceRepository["getScanWatermark"]>): string | undefined {
  if (!watermark) {
    return undefined;
  }
  return maxIso(watermark.latestSeenCreatedAt, watermark.baselineAt) ?? undefined;
}

function latestMessageCreatedAt(messages: readonly { createdAt: string }[]): string | null {
  return messages.reduce<string | null>((latest, message) => maxIso(latest, message.createdAt), null);
}

function earliestMessageCreatedAt(messages: readonly { createdAt: string }[]): string | null {
  return messages.reduce<string | null>((earliest, message) => {
    if (!earliest || Date.parse(message.createdAt) < Date.parse(earliest)) {
      return message.createdAt;
    }
    return earliest;
  }, null);
}

function maxIso(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) {
    return right ?? null;
  }
  if (!right) {
    return left;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function sortMessagesForIngestion(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return [...messages].sort((left, right) =>
    left.conversationId.localeCompare(right.conversationId) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.messageId.localeCompare(right.messageId)
  );
}

function sortManagedMessagesForIngestion(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) =>
      left.message.conversationId.localeCompare(right.message.conversationId) ||
      Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt) ||
      left.index - right.index
    )
    .map((entry) => entry.message);
}

function uniqueConversationIds(messages: readonly ConversationMessage[]): string[] {
  return [...new Set(messages.map((message) => message.conversationId))];
}

async function processPendingImportSummaries(
  options: CreateAgentSourceServiceOptions,
  memoryIds: readonly string[],
  scanOptions: AgentSourceScanOptions
): Promise<ProcessingFailure[]> {
  scanOptions.signal?.throwIfAborted();
  const ownedMemoryIds = [...new Set(memoryIds)];
  const failures: ProcessingFailure[] = [];
  const progressSourceId = scanOptions.progressSourceId ?? "all";
  emitProgress(scanOptions, {
    sourceId: progressSourceId,
    phase: "summarize",
    current: 0,
    total: ownedMemoryIds.length,
    message: "Summarizing and indexing latest memories"
  });

  let completedMemoryCount = 0;
  for (let offset = 0; offset < ownedMemoryIds.length; offset += IMPORT_PROCESSING_COHORT_SIZE) {
    const cohort = ownedMemoryIds.slice(offset, offset + IMPORT_PROCESSING_COHORT_SIZE);
    await options.memoryClient.enqueueImportSummaries(cohort);
    const pendingMemoryIds = new Set(cohort);
    let lastProgressAt = Date.now();

    while (pendingMemoryIds.size > 0) {
      scanOptions.signal?.throwIfAborted();
      const targets = [...pendingMemoryIds];
      const workerOutcome = options.memoryClient.runWorker({
        limit: IMPORT_WORKER_BATCH_SIZE,
        targetMemoryIds: targets,
        priorityCohortOnly: true,
        signal: scanOptions.signal,
        timeoutMs: IMPORT_WORKER_TIMEOUT_MS
      }).then((result) => ({ kind: "worker" as const, result }));
      let result: Awaited<ReturnType<MemoryClient["runWorker"]>> | undefined;

      while (!result) {
        const outcome = await Promise.race([
          workerOutcome,
          waitForWorkerProgress(IMPORT_PROGRESS_POLL_INTERVAL_MS, undefined, { signal: scanOptions.signal })
            .then(() => ({ kind: "poll" as const }))
        ]);
        if (outcome.kind === "worker") result = outcome.result;
        const previousPending = pendingMemoryIds.size;
        await reconcileImportProcessing(options.memoryClient, pendingMemoryIds, failures);
        if (pendingMemoryIds.size < previousPending) lastProgressAt = Date.now();
        emitProgress(scanOptions, {
          sourceId: progressSourceId,
          phase: "summarize",
          current: completedMemoryCount + cohort.length - pendingMemoryIds.size,
          total: ownedMemoryIds.length,
          message: "Summarizing and indexing latest memories"
        });
        if (pendingMemoryIds.size === 0 && !result) {
          result = (await workerOutcome).result;
        }
      }

      if (pendingMemoryIds.size === 0) break;
      if (Date.now() - lastProgressAt >= IMPORT_WORKER_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for ${pendingMemoryIds.size} imported memories to finish indexing`);
      }
      if (result.leased === 0 && result.embeddingRetries.leased === 0) {
        await waitForWorkerProgress(IMPORT_PROGRESS_POLL_INTERVAL_MS, undefined, { signal: scanOptions.signal });
      }
      await yieldToEventLoop();
    }
    completedMemoryCount += cohort.length;
  }
  return failures;
}

async function reconcileImportProcessing(
  memoryClient: Pick<MemoryClient, "getMemoryProcessingStatus">,
  pendingMemoryIds: Set<string>,
  failures: ProcessingFailure[]
): Promise<void> {
  const refreshed = await memoryClient.getMemoryProcessingStatus([...pendingMemoryIds]);
  const processingByMemoryId = new Map(refreshed.items.map((item) => [item.memoryId, item]));
  const activeMemoryIds = new Set(refreshed.items
    .filter((item) => item.state === "summary_pending" || item.state === "summarizing" ||
      item.state === "embedding_pending" || item.state === "embedding")
    .map((item) => item.memoryId));
  for (const memoryId of pendingMemoryIds) {
    if (activeMemoryIds.has(memoryId)) continue;
    const processing = processingByMemoryId.get(memoryId);
    if (!processing) {
      failures.push({ memoryId, reason: "Memory processing state is missing" });
    } else if (processing.state === "failed") {
      failures.push({ memoryId, reason: processing.errorMessage || "Memory processing failed" });
    }
    pendingMemoryIds.delete(memoryId);
  }
}

function appendProcessingFailures(result: ScanResult, failures: readonly ProcessingFailure[]): void {
  result.errors.push(...failures.map((failure) => ({
    conversationId: failure.memoryId,
    reason: failure.reason
  })));
}

function appendProcessingFailuresToResults(
  results: readonly ScanResult[],
  failures: readonly ProcessingFailure[]
): void {
  const resultByMemoryId = new Map<string, ScanResult>();
  for (const result of results) {
    for (const memoryId of result.memoryIds ?? []) resultByMemoryId.set(memoryId, result);
  }
  for (const failure of failures) {
    const result = resultByMemoryId.get(failure.memoryId);
    if (result) appendProcessingFailures(result, [failure]);
  }
}


async function* toAsyncIterable(messages: readonly ConversationMessage[]): AsyncIterable<ConversationMessage> {
  for (const message of messages) {
    yield message;
  }
}

function emitProgress(scanOptions: AgentSourceScanOptions, progress: ScanProgress): void {
  scanOptions.onProgress?.(progress);
}

/**
 * Ensures the source exists in the repository.
 *
 * @param options Service dependencies.
 * @param sourceId Source id.
 */
function ensureSourceExists(options: CreateAgentSourceServiceOptions, sourceId: string): void {
  const exists = options.agentSourceRepository.listSources().some((source) => source.sourceId === sourceId);
  if (exists) {
    return;
  }

  const adapter = options.sourceRegistry.get(sourceId);
  if (!adapter) {
    return;
  }

  options.agentSourceRepository.upsertSource({
    sourceId: adapter.descriptor.sourceId,
    displayName: adapter.descriptor.displayName,
    dataPath: adapter.descriptor.dataPath,
    builtin: adapter.descriptor.builtin
  });
}

async function ensureSourceAvailable(options: CreateAgentSourceServiceOptions, sourceId: string): Promise<void> {
  const adapter = options.sourceRegistry.get(sourceId);
  if (!adapter) {
    return;
  }

  if (!(await adapter.detect())) {
    throw new AgentSourceUnavailableError(adapter.descriptor.displayName);
  }
}

/**
 * Converts a repository record into an HTTP view.
 *
 * @param source Repository record.
 * @returns AgentSourceView.
 */
function toAgentSourceView(
  source: AgentSourceRecord | undefined,
  available = true,
  syncBoundaryAt: string | null = null
): AgentSourceView {
  if (!source) {
    throw new Error("Agent source was not persisted");
  }

  return {
    sourceId: source.sourceId,
    displayName: source.displayName,
    dataPath: source.dataPath,
    builtin: source.builtin,
    available,
    status: source.status,
    messageCount: source.messageCount,
    lastScannedAt: source.lastScannedAt,
    syncBoundaryAt,
    syncReady: Boolean(source.syncRecipe)
  };
}

function ensureManagedSource(
  options: Pick<CreateAgentSourceServiceOptions, "agentSourceRepository">,
  sourceId: string
): AgentSourceRecord {
  const source = options.agentSourceRepository.listSources().find((candidate) => candidate.sourceId === sourceId);
  if (!source) {
    throw new Error(`Unknown Agent source: ${sourceId}`);
  }
  if (source.builtin) {
    throw new Error(`Agent source is not managed by Memmy Agent: ${sourceId}`);
  }
  return source;
}

function normalizePluginInstallType(value: string | undefined): AgentSourceInstallType {
  if (
    value === "manual" ||
    value === "onboarding" ||
    value === "auto_inject" ||
    value === "conflict_replace"
  ) {
    return value;
  }
  return "manual";
}

function readSourceStatus(
  options: Pick<CreateAgentSourceServiceOptions, "agentSourceRepository">,
  sourceId: string,
): AgentSourceStatus {
  const source = options.agentSourceRepository.listSources().find((candidate) => candidate.sourceId === sourceId);
  return source?.status ?? "not_connected";
}

function readSourceBuiltin(
  options: Pick<CreateAgentSourceServiceOptions, "agentSourceRepository" | "sourceRegistry">,
  sourceId: string,
): boolean {
  const source = options.agentSourceRepository.listSources().find((candidate) => candidate.sourceId === sourceId);
  if (source) return source.builtin;
  return options.sourceRegistry.list().some((adapter) => adapter.descriptor.sourceId === sourceId);
}

async function readScanPermission(
  options: Pick<CreateAgentSourceServiceOptions, "getScanPermission">,
): Promise<ScanPermission | undefined> {
  if (!options.getScanPermission) return undefined;
  return await options.getScanPermission();
}
