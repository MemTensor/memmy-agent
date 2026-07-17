/** Agent source service module. */
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type {
  AddManualInput,
  AgentSourceMemoryPluginConflict,
  AgentSourceScanMode,
  AgentSourceView,
  ScanResult
} from "@memmy/local-api-contracts";
import type {
  ConversationMessage,
  ScanOptions,
  ScanProgress
} from "../adapters/outbound/agent-source/types.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { SourceRegistry } from "../adapters/outbound/agent-source/source-registry.js";
import type { AgentSourceRepository, AgentSourceRecord } from "../infrastructure/agent-source-store/index.js";
import type { IngestionService } from "./ingestion-service.js";
import { AgentSourceUnavailableError } from "./runtime-errors.js";
import type { SkillDistributionService } from "./skill-distribution-service.js";

export type { ScanProgress } from "../adapters/outbound/agent-source/types.js";

const SCAN_MESSAGE_YIELD_INTERVAL = 100;
const IMPORT_SUMMARY_PRIORITY_LIMIT = 100;
const IMPORT_SUMMARY_PRIORITY_BATCH_SIZE = 20;
const IMPORT_SUMMARY_STANDARD_BATCH_SIZE = 100;
const IMPORT_WORKER_TIMEOUT_MS = 600_000;
const INITIAL_GLOBAL_MEMORY_LIMIT = 1_000;
const INITIAL_ABSENT_SOURCE_MEMORY_LIMIT = 200;
const INITIAL_SOURCE_MEMORY_LIMIT = 1_000;

/** Contract for agent source service. */
export interface AgentSourceService {
  list(): Promise<AgentSourceView[]>;
  scanAll(options?: AgentSourceScanOptions): Promise<ScanResult[]>;
  scanOne(sourceId: string, options?: AgentSourceScanOptions): Promise<ScanResult>;
  collectOne(sourceId: string, options?: AgentSourceScanOptions): Promise<CollectedSourceScan>;
  collectAll(options?: AgentSourceScanOptions): Promise<CollectedSourceScan[]>;
  ingestCollected(collected: readonly CollectedSourceScan[], options?: AgentSourceScanOptions): Promise<ScanResult[]>;
  processImportSummaries(options?: AgentSourceScanOptions): Promise<void>;
  addManual(input: AddManualInput): Promise<AgentSourceView>;
  remove(sourceId: string): Promise<void>;
  installSkill(sourceId: string): Promise<void>;
  uninstallSkill(sourceId: string): Promise<void>;
  installPlugin(sourceId: string): Promise<void>;
  uninstallPlugin(sourceId: string): Promise<void>;
  detectMemoryPluginConflicts(): Promise<AgentSourceMemoryPluginConflict[]>;
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
}

/** Contract for create agent source service options. */
export interface CreateAgentSourceServiceOptions {
  sourceRegistry: SourceRegistry;
  agentSourceRepository: AgentSourceRepository;
  ingestionService: IngestionService;
  memoryClient: Pick<MemoryClient, "enqueueImportSummaries" | "runWorker">;
  skillDistributionService: SkillDistributionService;
  now?: () => string;
  createId?: () => string;
}

/** Creates create agent source service. */
export function createAgentSourceService(options: CreateAgentSourceServiceOptions): AgentSourceService {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;

  return {
    async list() {
      return await listSources(options);
    },

    async scanAll(scanOptions = {}) {
      const collected = await this.collectAll(scanOptions);
      const results = await this.ingestCollected(collected, scanOptions);
      await this.processImportSummaries(scanOptions);
      return results;
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

    async processImportSummaries(scanOptions = {}) {
      await processPendingImportSummaries(options, scanOptions);
    },

    async scanOne(sourceId, scanOptions = {}) {
      const collected = await this.collectOne(sourceId, scanOptions);
      const result = await ingestCollectedSource(options, collected, scanOptions, now);
      await processPendingImportSummaries(options, { ...scanOptions, progressSourceId: sourceId });
      return result;
    },

    async addManual(input) {
      const sourceId = createId();
      options.agentSourceRepository.upsertSource({
        sourceId,
        displayName: input.displayName,
        dataPath: input.dataPath,
        builtin: false
      });

      return toAgentSourceView(options.agentSourceRepository.listSources().find((source) => source.sourceId === sourceId));
    },

    async remove(sourceId) {
      options.agentSourceRepository.removeSource(sourceId);
    },

    async installSkill(sourceId) {
      await ensureSourceAvailable(options, sourceId);
      await options.skillDistributionService.install(sourceId);
      ensureSourceExists(options, sourceId);
      options.agentSourceRepository.setStatus(sourceId, "skill_installed");
    },

    async uninstallSkill(sourceId) {
      await options.skillDistributionService.uninstall(sourceId);
      ensureSourceExists(options, sourceId);
      options.agentSourceRepository.setStatus(sourceId, "not_connected");
    },

    async installPlugin(sourceId) {
      await ensureSourceAvailable(options, sourceId);
      await options.skillDistributionService.installPlugin(sourceId);
      ensureSourceExists(options, sourceId);
      options.agentSourceRepository.setStatus(sourceId, "plugin_installed");
    },

    async uninstallPlugin(sourceId) {
      await options.skillDistributionService.uninstallPlugin(sourceId);
      ensureSourceExists(options, sourceId);
      options.agentSourceRepository.setStatus(sourceId, "not_connected");
    },

    async detectMemoryPluginConflicts() {
      return options.skillDistributionService.detectMemoryPluginConflicts?.() ?? [];
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
      return toAgentSourceView(existing, available);
    }

    return {
      sourceId: adapter.descriptor.sourceId,
      displayName: adapter.descriptor.displayName,
      dataPath: adapter.descriptor.dataPath,
      builtin: adapter.descriptor.builtin,
      available,
      status: "not_connected",
      messageCount: 0,
      lastScannedAt: null
    } satisfies AgentSourceView;
  }));

  return [...builtinViews, ...[...persistedById.values()].map((source) => toAgentSourceView(source))];
}

async function detectAvailableSourceAdapters(options: CreateAgentSourceServiceOptions) {
  const adapters = options.sourceRegistry.list();
  const detected = await Promise.all(adapters.map(async (adapter) => ({
    adapter,
    available: await adapter.detect()
  })));
  return detected.filter((entry) => entry.available).map((entry) => entry.adapter);
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
      if (maxMessages !== undefined && collected.messages.length >= maxMessages) {
        break;
      }
      collected.messages.push(message);
      if (!collected.conversationIds.includes(message.conversationId)) {
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
  emitProgress(scanOptions, {
    sourceId,
    phase: "scan",
    current: bounded.messages.length,
    total: bounded.messages.length,
    message: "Source scan completed"
  });
  return bounded;
}

async function ingestCollectedSource(
  options: CreateAgentSourceServiceOptions,
  collected: CollectedSourceScan,
  scanOptions: AgentSourceScanOptions,
  now: () => string
): Promise<ScanResult> {
  let skipped = 0;
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
    const stats = await options.ingestionService.ingest(toAsyncIterable(ingestMessages), {
      sourceId: collected.sourceId,
      signal: scanOptions.signal,
      deferProcessing: true,
      totalMessages: ingestMessages.length,
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

  options.agentSourceRepository.setLastScannedAt(collected.sourceId, now());
  updateScanWatermark(options, collected, scanOptions, now());
  return {
    sourceId: collected.sourceId,
    discoveredConversations: collected.conversationIds.length,
    emittedMessages: collected.messages.length,
    skipped,
    errors
  };
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
  if (messages.length === 0 || !messages.some((message) => message.role === "assistant")) {
    return;
  }

  const userMessage = messages.find((message) => message.role === "user");
  if (!userMessage) {
    return;
  }

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

function latestMessageCreatedAt(messages: readonly ConversationMessage[]): string | null {
  return messages.reduce<string | null>((latest, message) => maxIso(latest, message.createdAt), null);
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

function uniqueConversationIds(messages: readonly ConversationMessage[]): string[] {
  return [...new Set(messages.map((message) => message.conversationId))];
}

async function processPendingImportSummaries(
  options: CreateAgentSourceServiceOptions,
  scanOptions: AgentSourceScanOptions
): Promise<void> {
  scanOptions.signal?.throwIfAborted();
  const queued = await options.memoryClient.enqueueImportSummaries();
  const pendingMemoryIds = new Set(queued.memoryIds);
  const progressSourceId = scanOptions.progressSourceId ?? "all";
  let indexed = 0;
  let prioritySummaries = 0;
  emitProgress(scanOptions, {
    sourceId: progressSourceId,
    phase: "summarize",
    current: 0,
    total: pendingMemoryIds.size,
    message: "Summarizing and indexing latest memories"
  });

  while (pendingMemoryIds.size > 0) {
    scanOptions.signal?.throwIfAborted();
    const limit = prioritySummaries < IMPORT_SUMMARY_PRIORITY_LIMIT
      ? IMPORT_SUMMARY_PRIORITY_BATCH_SIZE
      : IMPORT_SUMMARY_STANDARD_BATCH_SIZE;
    const result = await options.memoryClient.runWorker({
      limit,
      signal: scanOptions.signal,
      timeoutMs: IMPORT_WORKER_TIMEOUT_MS
    });

    prioritySummaries += result.jobs.filter((job) =>
      job.jobType === "import_summary" &&
      Boolean(job.targetMemoryId && queued.memoryIds.includes(job.targetMemoryId))
    ).length;
    indexed += consumeIndexedMemoryIds(pendingMemoryIds, result);
    emitProgress(scanOptions, {
      sourceId: progressSourceId,
      phase: "summarize",
      current: indexed,
      total: queued.memoryIds.length,
      message: "Summarizing and indexing latest memories"
    });

    if (result.leased === 0 && result.embeddingRetries.leased === 0) {
      break;
    }
    await yieldToEventLoop();
  }
}

function consumeIndexedMemoryIds(
  pendingMemoryIds: Set<string>,
  result: Awaited<ReturnType<Pick<MemoryClient, "runWorker">["runWorker"]>>
): number {
  let indexed = 0;
  for (const job of result.jobs) {
    if (job.jobType !== "embedding" || job.status !== "succeeded" || !job.targetMemoryId) {
      continue;
    }
    if (pendingMemoryIds.delete(job.targetMemoryId)) {
      indexed += 1;
    }
  }
  for (const retry of result.embeddingRetries.items) {
    if (retry.status !== "succeeded") {
      continue;
    }
    if (pendingMemoryIds.delete(retry.targetMemoryId)) {
      indexed += 1;
    }
  }
  return indexed;
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
function toAgentSourceView(source: AgentSourceRecord | undefined, available = true): AgentSourceView {
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
    lastScannedAt: source.lastScannedAt
  };
}
