import { nextScanGeneration } from "./scan-version.js";
import { matchesScanExecution, compareScanVersions, type ScanVersion, type ScanLifecycle, type ScanControlInput } from "@memmy/agent-source-core/scan-state";
import { readLegacyScanState } from "./legacy-state.js";
import { openSourceCheckpoints, publishSourceCheckpoints, type SourceCheckpoints } from "./source-checkpoints.js";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, relative } from "node:path";
import Database from "better-sqlite3";
import { loadMemmyConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import type { MemoryService } from "../service/memory-service.js";
import { MemoryServiceError } from "../utils/error.js";
import {
  resolveClaudeCodeHomeDirectory,
  resolveCodexHomeDirectory,
  resolveDeepseekHarnessHomeDirectory,
  resolveHermesHomeDirectory,
  resolveOpenclawStateDirectory,
  resolveOpencodeConfigDirectory,
  resolvePiAgentDirectory,
  resolveQwenworkHomeDirectory,
  resolveWorkbuddyHomeDirectory
} from "./agent-paths.js";
import { createClaudeCodeSourceAdapter } from "./adapters/claude-code/index.js";
import { createCodexSourceAdapter } from "./adapters/codex/index.js";
import { createCursorSourceAdapter } from "./adapters/cursor/index.js";
import { createDeepseekHarnessSourceAdapter } from "./adapters/deepseek-harness/index.js";
import { createHermesSourceAdapter } from "./adapters/hermes/index.js";
import { createOpenclawSourceAdapter } from "./adapters/openclaw/index.js";
import { createOpencodeSourceAdapter } from "./adapters/opencode/index.js";
import { createPiSourceAdapter } from "./adapters/pi/index.js";
import { createQwenworkSourceAdapter } from "./adapters/qwenwork/index.js";
import { createSourceRegistry, type SourceRegistry } from "./adapters/source-registry.js";
import type { ConversationMessage, ScanProgress, SourceAdapter } from "./adapters/types.js";
import {
  hasStagedSourceTurn,
  isCompleteTurn,
  orderedTurns,
  sourceTurnFromMessages,
  sourceTurnFailureReason,
  sourceTurnSkipBlocksWatermark,
  sourceTurnSkipWatermarkEffect,
  buildSourceTurnRequest,
  renderTurnClipped,
  stableTurnIdentity,
  legacyTurnId,
  legacyImportTurnIdFromMessages,
  legacyTurnRequestId,
  type ScanStore
} from "@memmy/agent-source-core";
import { openMemoryAgentSourceScanStore, readScanRequestedMode, type MemoryAgentSourceScanStore } from "./scan-store.js";
import { createWorkbuddySourceAdapter } from "./adapters/workbuddy/index.js";
import { createClaudeCodeSkillTarget } from "./integration/claude-code/index.js";
import { createCodexSkillTarget } from "./integration/codex/index.js";
import { createCursorSkillTarget } from "./integration/cursor/index.js";
import { createDeepseekHarnessSkillTarget } from "./integration/deepseek-harness/index.js";
import { createHermesSkillTarget } from "./integration/hermes/index.js";
import { createOpenclawSkillTarget } from "./integration/openclaw/index.js";
import { createOpencodeSkillTarget } from "./integration/opencode/index.js";
import { createPiSkillTarget } from "./integration/pi/index.js";
import { createQwenworkSkillTarget } from "./integration/qwenwork/index.js";
import {
  createSkillTargetRegistry,
  type SkillTargetRegistry
} from "./integration/target-registry.js";
import { renderMemmyDefaultSkillManifest } from "./integration/templates/memmy-default.js";
import { createWorkbuddySkillTarget } from "./integration/workbuddy/index.js";
import type {
  MemoryDesktopAddAnalytics,
  MemoryDesktopAddScanMode
} from "../server/memory-add-analytics.js";

const logger = createMemoryLogger("agent-source");
const INITIAL_SCAN_DELAY_MS = 5 * 60 * 1000;
const SCHEDULED_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_SCAN_MESSAGE_LIMIT = 1_000;
const COMPLETED_DETAILS_RETENTION_MS = 60 * 60 * 1000;
const SCAN_EVENT_LOOP_BUDGET_MS = 8;
const SCAN_CHECKPOINT_ITEM_LIMIT = 500;

export type AgentConnectionStatus = "not_connected" | "skill_installed" | "plugin_installed";

export interface AgentSourceView {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
  available: boolean;
  status: AgentConnectionStatus;
  messageCount: number;
  lastScannedAt: string | null;
}

export interface AgentSourceScanState {
  version?: ScanVersion;
  status?: ScanLifecycle;
  running: boolean;
  jobId: string | null;
  attemptId?: string;
  sourceId: string | null;
  mode: "initial_subset" | "incremental" | "full" | null;
  progress: ScanProgress | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  results?: Array<{ sourceId: string; discoveredConversations: number; emittedMessages: number; skipped: number; memoryIds?: string[]; memoryIdCount?: number; errorCount?: number; detailsTruncated?: boolean; errors: Array<{ conversationId: string; reason: string }> }>;
}

export interface ScanControlResult { ok: true; outcome: "applied" | "already_terminal" | "conflict"; snapshot: AgentSourceScanState }

export interface AgentSourceExecutor {
  list(): Promise<{ executorAvailable: true; sources: AgentSourceView[] }>;
  clearAllData(): Promise<ReturnType<MemoryService["clearAllData"]>>;
  startScan(input: unknown): Promise<{ accepted: true; jobId: string; attemptId?: string; attemptStartedAt?: string; version?: ScanVersion }>;
  scanStatus(): AgentSourceScanState;
  pauseScan(input?: ScanControlInput): Promise<ScanControlResult>;
  cancelScan(input?: ScanControlInput): Promise<ScanControlResult>;
  scanResults?(jobId: string, cursor?: string, limit?: number): Promise<{ items: Array<{ sourceId: string; conversationId: string; memoryId?: string; error?: string }>; nextCursor: string | null; attemptId?: string }>;
  mutateConnection(
    sourceId: string,
    kind: "plugin" | "skill",
    method: "POST" | "DELETE",
    installType?: "manual" | "auto_inject"
  ): Promise<unknown>;
  startAutomation(): void;
  dispose(): void | Promise<void>;
}

interface PersistedSourceState {
  status: AgentConnectionStatus;
  autoInjectSuppressed?: boolean;
  messageCount: number;
  lastScannedAt: string | null;
  latestSeenAt: string | null;
  contentHash?: string;
  recoveryPending?: boolean;
  syncBoundaryAt?: string | null;
}

interface PersistedState {
  version: 2;
  legacyRecoveryChecked?: boolean;
  sources: Record<string, PersistedSourceState>;
}

export interface CreateAgentSourceExecutorOptions {
  service: MemoryService;
  configPath?: string;
  sourceRegistry?: SourceRegistry;
  statePath?: string;
  initialScanDelayMs?: number;
  scheduledScanIntervalMs?: number;
  scheduleWorker?: () => void;
  integrationRegistry?: SkillTargetRegistry;
  /** Resolves the Agent root used for optional cross-Agent Skill ingestion. */
  resolveAgentSkillRoot?: (sourceId: string) => string | null;
  scanStoreDirectory?: string;
  legacyDatabasePath?: string;
  memoryAddAnalytics?: Pick<
    MemoryDesktopAddAnalytics,
    "trackAddStarted" | "trackAddSucceeded" | "trackAddFailed"
  >;
}

export function createAgentSourceExecutor(options: CreateAgentSourceExecutorOptions): AgentSourceExecutor {
  const registry = options.sourceRegistry ?? createBuiltinSourceRegistry();
  const configPath = options.configPath ?? join(
    process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"),
    "config.yaml"
  );
  const integrationRegistry = options.integrationRegistry ?? createBuiltinIntegrationRegistry(configPath);
  const statePath = options.statePath ?? join(dirname(configPath), "memory-service", "agent-sources.json");
  const scanStoreDirectory = options.scanStoreDirectory ?? join(dirname(statePath), "agent-source-scans");
  let statePromise: Promise<PersistedState> | undefined;
  const generation = nextScanGeneration(scanStoreDirectory);
  let sequence = 0;
  let scan: AgentSourceScanState = { ...restoredScanState(scanStoreDirectory), version: { generation, sequence } };
  scan.status = scan.running ? "running" : scan.completedAt ? (scan.error ? "failed" : "completed") : scan.progress?.phase === "stopped" ? "paused" : "idle";
  function setScan(next: AgentSourceScanState): void {
    scan = { ...next, version: { generation, sequence: ++sequence },
      status: next.running ? "running" : next.completedAt ? (next.error ? "failed" : "completed") : next.progress?.phase === "stopped" ? "paused" : next.status === "cancelled" ? "cancelled" : "idle" };
  }
  const snapshot = () => structuredClone(scan);
  const controlResult = (outcome: ScanControlResult["outcome"]): ScanControlResult => ({ ok: true, outcome, snapshot: snapshot() });
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanAbortController: AbortController | undefined;
  let activeScanRequest: ReturnType<typeof normalizeScanInput> | undefined;
  let scanPaused = false;
  let progressBeforePause: ScanProgress | null = null;
  let resumePausedScan: (() => void) | undefined;
  let disposed = false;
  let canceling = false;
  let clearing = false;
  let automationStarted = false;
  const activeScans = new Set<Promise<void>>();
  const canceledScanJobs = new Set<string>();
  let activeAutomation: Promise<void> | undefined;

  const readState = () => statePromise ??= loadState(statePath).then(async (state) => {
    if (!state.legacyRecoveryChecked && options.legacyDatabasePath) {
      const legacy = readLegacyScanState(options.legacyDatabasePath);
      const unfinishedAll = legacy.some((source) => source.sourceId === "all");
      for (const adapter of registry.list()) {
        const sourceId = adapter.descriptor.sourceId;
        const previous = legacy.find((source) => source.sourceId === sourceId);
        const existing = state.sources[sourceId];
        if ((!existing && previous) || unfinishedAll || previous?.unfinished) {
          state.sources[sourceId] = {
            ...(existing ?? emptySourceState()),
            ...(!existing && previous ? { messageCount: previous.messageCount, lastScannedAt: previous.lastScannedAt } : {}),
            recoveryPending: true
          };
        }
      }
      state.legacyRecoveryChecked = true;
      await writeState(statePath, state);
    }
    return state;
  });
  const persist = async (state: PersistedState) => writeState(statePath, state);

  async function list(): Promise<{ executorAvailable: true; sources: AgentSourceView[] }> {
    const state = await readState();
    const sources = await Promise.all(registry.list().map(async (adapter) => {
      const stored = state.sources[adapter.descriptor.sourceId];
      const available = await adapter.detect();
      const target = integrationRegistry.get(adapter.descriptor.sourceId);
      const installed = target
        ? await target.isInstalled(adapter.descriptor.sourceId).catch((error) => {
            logger.warn("connection.status_read_failed", {
              sourceId: adapter.descriptor.sourceId,
              ...memoryErrorFields(error)
            });
            return false;
          })
        : false;
      return {
        ...adapter.descriptor,
        available,
        status: installed ? connectionStatus(adapter.descriptor.sourceId) : "not_connected",
        messageCount: stored?.messageCount ?? 0,
        lastScannedAt: stored?.lastScannedAt ?? null,
        syncBoundaryAt: stored?.syncBoundaryAt ?? null
      };
    }));
    return { executorAvailable: true, sources };
  }

  async function startScan(input: unknown): Promise<{ accepted: true; jobId: string; attemptId?: string; attemptStartedAt?: string; version?: ScanVersion }> {
    if (clearing) throw new MemoryServiceError("conflict", "Clearing Memory data; try again after it completes");
    if (canceling) throw new MemoryServiceError("conflict", "Canceling the previous scan");
    if (disposed) throw new MemoryServiceError("conflict", "Agent source executor is shutting down");
    const expected = (input ?? {}) as ScanControlInput;
    if (!matchesScanExecution(scan, expected.expectedExecution) || (expected.expectedVersion && (!scan.version || compareScanVersions(scan.version, expected.expectedVersion) !== 0))) {
      throw new MemoryServiceError("conflict", "Scan state changed; refresh before starting or resuming");
    }
    const request = normalizeScanInput(input);
    if (request.sourceId !== "all" && !registry.get(request.sourceId)) throw new MemoryServiceError("invalid_argument", "Unknown Agent source");
    if (!scanAbortController && scan.progress?.phase === "stopped" && !scan.completedAt && scan.sourceId !== request.sourceId) {
      throw new MemoryServiceError("conflict", "Resume or cancel the recovered scan first");
    }
    if (scan.running) throw new MemoryServiceError("conflict", "An Agent source scan is already running");
    if (scanPaused && scanAbortController && activeScanRequest && scan.jobId) {
      if (!sameScanRequest(activeScanRequest, request)) {
        throw new MemoryServiceError("conflict", "Resume or stop the paused Agent source scan first");
      }
      const jobId = scan.jobId;
      scanPaused = false;
      setScan({
        ...scan,
        running: true,
        progress: progressBeforePause ?? {
          sourceId: request.sourceId,
          phase: "scan",
          current: 0,
          total: 0,
          message: "Scanning Agent history"
        },
        error: null
      });
      resumePausedScan?.();
      resumePausedScan = undefined;
      logger.info("scan.resumed", { jobId, sourceId: request.sourceId });
      return { accepted: true, jobId, attemptId: scan.attemptId, attemptStartedAt: scan.startedAt ?? undefined, version: scan.version };
    }
    if (scanPaused) {
      throw new MemoryServiceError("conflict", "Stop the paused Agent source scan before starting another scan");
    }
    const jobId = findReusableScanJob(scanStoreDirectory, request.sourceId, request.mode, canceledScanJobs)
      ?? `agent-scan-${randomUUID()}`;
    const recovering = scan.jobId === jobId && scan.progress?.phase === "stopped" && !scan.completedAt;
    const attemptId = recovering ? scan.attemptId ?? `${jobId}:legacy` : randomUUID();
    const startedAt = recovering ? scan.startedAt : new Date().toISOString();
    setScan({
      running: true,
      jobId,
      attemptId,
      sourceId: request.sourceId,
      mode: request.mode ?? null,
      progress: null,
      startedAt,
      completedAt: null,
      error: null
    });
    activeScanRequest = request;
    progressBeforePause = null;
    const controller = new AbortController();
    scanAbortController = controller;
    const sourceIds = request.sourceId === "all"
      ? registry.list().map(adapter => adapter.descriptor.sourceId) : [request.sourceId];
    const activeScan = options.service.withAgentSourceScanPermit(sourceIds, controller.signal,
      () => runScan(request, controller.signal, jobId)).then(() => {
      if (scan.jobId !== jobId || controller.signal.aborted) return;
      setScan({ ...scan, running: false, completedAt: scan.completedAt ?? new Date().toISOString() });
      logger.info("scan.completed", { jobId, sourceId: request.sourceId });
    }).catch((error) => {
      if (scan.jobId !== jobId || controller.signal.aborted) return;
      setScan({
        ...scan,
        running: false,
        completedAt: scan.completedAt ?? new Date().toISOString(),
        error: scan.error ?? (error instanceof Error ? error.message || "Agent source import failed" : String(error))
      });
      logger.error("scan.failed", { jobId, sourceId: request.sourceId, ...memoryErrorFields(error) });
    }).finally(() => {
      activeScans.delete(activeScan);
      if (scanAbortController === controller) {
        scanAbortController = undefined;
        activeScanRequest = undefined;
        scanPaused = false;
        progressBeforePause = null;
        resumePausedScan = undefined;
      }
    });
    activeScans.add(activeScan);
    logger.info("scan.started", { jobId, sourceId: request.sourceId, mode: request.mode });
    return { accepted: true, jobId, attemptId: scan.attemptId, attemptStartedAt: scan.startedAt ?? undefined, version: scan.version };
  }

  async function runScan(
    request: ReturnType<typeof normalizeScanInput>,
    signal: AbortSignal,
    jobId: string
  ): Promise<void> {
    const failures: string[] = [];
    setScan({ ...scan, results: [] });
    let failureCount = 0;
    const adapters = request.sourceId === "all"
      ? registry.list()
      : [registry.require(request.sourceId)];
    const state = await readState();
    let store: MemoryAgentSourceScanStore | undefined;
    let checkpoints: SourceCheckpoints | undefined;
    const preparedContentHashes = new Map<string, string>();
    const checkpoint = createScanCheckpoint(signal, () => waitWhilePaused(signal));
    const persistCompletion = (error: string | null) => {
      if (!store) return;
      const completedAt = new Date().toISOString();
      const completion = { ...scan, running: false, completedAt, error };
      store.saveMeta({ jobId, sourceId: request.sourceId, mode: request.mode ?? "incremental",
        phase: error ? "failed" : "done", createdAt: store.getMeta()?.createdAt ?? completedAt,
        updatedAt: completedAt, ...(error ? { error } : {}), completion: JSON.stringify(completion) });
      setScan({ ...scan, running: false, completedAt, error });
    };
    try {
      checkpoints = openSourceCheckpoints(`${statePath}.checkpoints.sqlite`);
      store = await openMemoryAgentSourceScanStore(join(scanStoreDirectory, `${jobId}.sqlite`), {
        jobId, sourceId: request.sourceId, mode: request.mode ?? "incremental", phase: "stage",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      const requestedMode = store.requestedMode();
      if (request.mode === undefined && requestedMode !== undefined) request.mode = requestedMode ?? undefined;
      if (requestedMode === undefined) store.saveRequestedMode(request.mode ?? null);
      setScan({ ...scan, mode: request.mode ?? null });
      store.beginAttempt(scan.attemptId!, scan.startedAt ?? undefined);
      // Legacy waitForProcessing requests/options no longer change scan completion.
      // Processing belongs to durable background jobs, independently of this scan.
      const available: SourceAdapter[] = [];
      for (const adapter of adapters) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        if (await adapter.detect()) available.push(adapter);
        else if (request.sourceId !== "all") throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
      }
      for (const adapter of available) {
        const sourceId = adapter.descriptor.sourceId;
        if (checkpoints.hasSource(sourceId)) continue;
        const previous = state.sources[sourceId];
        if (previous && (previous.lastScannedAt || previous.latestSeenAt || previous.messageCount > 0)) {
          // Older states have no durable per-message identities. Reconcile once
          // using the same safe replay policy as legacy desktop tasks.
          state.sources[sourceId] = { ...previous, recoveryPending: true };
          await persist(state);
        }
        checkpoints.initializeSource(sourceId);
      }
      const preservedModes = new Map<string, "initial_subset" | "incremental" | "full">();
      if (!request.mode) {
        for (const adapter of available) {
          const existing = store.getSourceState(adapter.descriptor.sourceId);
          if (existing && existing.phase !== "done" && (existing.mode === "initial_subset" || existing.mode === "incremental" || existing.mode === "full")) {
            preservedModes.set(adapter.descriptor.sourceId, existing.mode);
          }
        }
      }
      const globalInitial = request.sourceId === "all" && available.length > 0 && !available.some((adapter) => state.sources[adapter.descriptor.sourceId]?.recoveryPending) &&
        (request.mode === "initial_subset" || (request.mode === undefined && preservedModes.size === 0 && available.every((adapter) => !state.sources[adapter.descriptor.sourceId]?.lastScannedAt)));
      const stages: StandaloneSourceStage[] = [];
      for (const adapter of available) {
        const stored = state.sources[adapter.descriptor.sourceId] ?? emptySourceState();
        const mode = stored.recoveryPending ? "full" : request.mode ?? preservedModes.get(adapter.descriptor.sourceId) ?? (stored.lastScannedAt ? "incremental" : "initial_subset");
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "stage", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        stages.push(await stageStandaloneSource(adapter, stored, mode, store, signal, checkpoint, (progress) => {
          if (scan.jobId === jobId && !signal.aborted && !scanPaused) { progressBeforePause = progress; setScan({ ...scan, progress }); }
        }));
      }
      for (const stage of stages) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        const { sourceId, mode } = stage;
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "prepare", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        const sourceState = store.getSourceState(sourceId);
        store.saveSourceState({ ...(sourceState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: new Date().toISOString() }), phase: "prepare", updatedAt: new Date().toISOString() });
        preparedContentHashes.set(sourceId, await prepareStandaloneSource(store, checkpoints, sourceId, mode, stage.stored.latestSeenAt, checkpoint, (progress) => {
          if (scan.jobId === jobId && !signal.aborted && !scanPaused) { progressBeforePause = progress; setScan({ ...scan, progress }); }
        }));
      }
      if (globalInitial) store.selectInitialTurns(stages.map((stage) => stage.sourceId), INITIAL_SCAN_MESSAGE_LIMIT, 200);
      for (const stage of stages) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        const { stored, mode, sourceId } = stage;
        if (mode === "initial_subset" && !globalInitial) store.selectInitialTurns([sourceId], INITIAL_SCAN_MESSAGE_LIMIT, 0);
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "ingest", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        const preparedState = store.getSourceState(sourceId);
        store.saveSourceState({ ...(preparedState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: new Date().toISOString() }), phase: "ingest", updatedAt: new Date().toISOString() });
        const result = await ingestStagedMessages(options.service, store, checkpoints, sourceId, signal, checkpoint, (progress) => {
          if (scan.jobId === jobId && !signal.aborted && !scanPaused) { progressBeforePause = progress; setScan({ ...scan, progress }); }
        }, options.scheduleWorker, options.memoryAddAnalytics, persistentScanMode(mode));
        const skillResult = await ingestAgentSkills(
          options.service,
          sourceId,
          store,
          checkpoint,
          options.resolveAgentSkillRoot,
          options.scheduleWorker,
          options.memoryAddAnalytics,
          persistentScanMode(mode),
          signal,
          () => waitWhilePaused(signal)
        );
        await checkpoint();
        const sourceErrorCount = store.resultSummary(sourceId).errors;
        const sourceErrors = store.errorDetails(sourceId);
        failureCount += sourceErrorCount;
        for (const detail of sourceErrors.map((item) => `${item.conversationId}: ${item.reason}`)) {
          if (failures.length >= 1000) break;
          failures.push(detail);
        }
        const now = new Date().toISOString();
        signal.throwIfAborted();
        if (sourceErrorCount === 0 && !result.hasUncommittedSkips) {
          // Raw records and required jobs are durable now; model outcomes cannot invalidate this checkpoint.
          // Cancellation may retain committed batches. Keep source-wide completion below
          // publication so an interrupted scan can safely replay the remaining conversations.
          await publishSourceCheckpoints(store, checkpoints, sourceId, () => waitWhilePaused(signal));
        }
        const nextSourceState: PersistedSourceState = {
          ...stored,
          ...(sourceErrorCount === 0 && !result.hasUncommittedSkips ? { recoveryPending: false, syncBoundaryAt: stored.syncBoundaryAt ?? result.latestSeenAt } : {}),
          messageCount: checkpoints.messageCount(sourceId),
          ...(sourceErrorCount === 0 && !result.hasUncommittedSkips
            ? { lastScannedAt: now }
            : stored.lastScannedAt ? { lastScannedAt: stored.lastScannedAt } : {}),
          ...(sourceErrorCount === 0 && !result.hasUncommittedSkips && preparedContentHashes.has(sourceId)
            ? { contentHash: preparedContentHashes.get(sourceId) }
            : stored.contentHash ? { contentHash: stored.contentHash } : {}),
          // An unfinished recent turn keeps the watermark at its latest activity,
          // so the next incremental scan re-reads its conversation and captures it.
          latestSeenAt: stage.scanErrorCount === 0 && result.errorCount === 0 && skillResult.errorCount === 0 && !result.hasUncommittedSkips
            ? (result.retryFrom ?? result.latestSeenAt ?? stored.latestSeenAt)
            : stored.latestSeenAt
        };
        await writeState(statePath, { ...state, sources: { ...state.sources, [sourceId]: nextSourceState } }, signal);
        // A pause can arrive while the source state is being published. Keep
        // its stopped progress until resumed, before publishing source-done.
        await checkpoint();
        if (scan.jobId !== jobId) throw new MemoryServiceError("conflict", "Agent source scan was replaced");
        state.sources[sourceId] = nextSourceState;
        const details = [...store.results(sourceId, "0", 500)];
        const summary = store.resultSummary(sourceId);
        setScan({ ...scan, results: [...(scan.results ?? []), {
          sourceId, discoveredConversations: summary.conversations,
          emittedMessages: store.count(sourceId), skipped: result.skipped,
          memoryIds: details.flatMap((row) => row.memoryId ? [row.memoryId] : []),
          memoryIdCount: summary.memories, errorCount: Math.max(sourceErrorCount, summary.errors),
          detailsTruncated: store.resultCount(sourceId) > 500,
          errors: sourceErrors
        }] });
        store.saveSourceState({
          sourceId,
          mode,
          phase: sourceErrorCount > 0 || result.hasUncommittedSkips ? "failed" : "done",
          messageCount: result.messageCount,
          resultCount: store.resultCount(sourceId),
          errorCount: sourceErrorCount,
          updatedAt: now
        });
        setScan({ ...scan, progress: { sourceId, phase: "done", current: store.count(sourceId), total: store.count(sourceId), message: `Imported ${result.written} memories and ${skillResult.written} skills` } });
      }
      // A source disappearing between attempts must not erase its unresolved failures.
      for (const sourceId of store.unresolvedSourceIds()) {
        if (scan.results?.some((result) => result.sourceId === sourceId)) continue;
        const summary = store.resultSummary(sourceId);
        const errors = store.errorDetails(sourceId);
        failureCount += summary.errors;
        failures.push(...errors.slice(0, 3).map((item) => `${sourceId}: ${item.reason}`));
        setScan({ ...scan, results: [...(scan.results ?? []), { sourceId, discoveredConversations: summary.conversations, emittedMessages: store.count(sourceId),
          skipped: 0, memoryIdCount: summary.memories, errorCount: summary.errors, errors }] });
      }
      await checkpoint();
      // A recovered job can contain staged work for a source whose path is
      // temporarily unavailable (or no longer registered). Keep the job
      // retryable rather than publishing success for only the visible sources.
      const unavailableSources = store.unfinishedSourceIds().filter(sourceId => !available.some(adapter => adapter.descriptor.sourceId === sourceId));
      if (unavailableSources.length > 0) {
        throw new Error(`Agent source scan has unfinished unavailable sources: ${unavailableSources.join(", ")}`);
      }
      if (failureCount > 0) {
        throw new Error(`Agent source scan completed with ${failureCount} import failure${failureCount === 1 ? "" : "s"}: ${failures.slice(0, 3).join("; ")}`);
      }
      persistCompletion(null);
    } catch (error) {
      if (signal.aborted) {
        const meta = store?.getMeta();
        if (meta) store!.saveMeta({ ...meta, phase: "stopped", updatedAt: new Date().toISOString() });
      } else {
        persistCompletion(error instanceof Error ? error.message || "Agent source import failed" : String(error));
      }
      throw error;
    } finally {
      store?.close();
      checkpoints?.close();
      if (canceledScanJobs.has(jobId)) {
        // Windows cannot unlink SQLite while its handle is open. Explicit
        // cancellation clears this job; shutdown still preserves retry state.
        const path = join(scanStoreDirectory, `${jobId}.sqlite`);
        try {
          await Promise.all([rm(path, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
        } finally {
          canceledScanJobs.delete(jobId);
        }
      }
    }
  }

  async function pauseScan(input: ScanControlInput = {}): Promise<ScanControlResult> {
    if (clearing) return controlResult("conflict");
    if (!matchesScanExecution(scan, input.expectedExecution) || (input.expectedVersion && (!scan.version || compareScanVersions(scan.version, input.expectedVersion) !== 0))) return controlResult("conflict");
    if (canceling) return controlResult("conflict");
    if (scan.completedAt) return controlResult("already_terminal");
    if (scanPaused || scan.progress?.phase === "stopped") return controlResult("applied");
    if (!scan.running || !scanAbortController || !activeScanRequest) {
      return controlResult("already_terminal");
    }
    progressBeforePause = scan.progress;
    scanPaused = true;
    setScan({
      ...scan,
      running: false,
      progress: {
        sourceId: scan.progress?.sourceId ?? activeScanRequest.sourceId,
        phase: "stopped",
        current: scan.progress?.current ?? 0,
        total: scan.progress?.total ?? 0,
        message: "Agent source scan paused"
      }
    });
    logger.info("scan.paused", { jobId: scan.jobId, sourceId: activeScanRequest.sourceId });
    return controlResult("applied");
  }

  async function cancelScan(input: ScanControlInput = {}): Promise<ScanControlResult> {
    if (!matchesScanExecution(scan, input.expectedExecution) || (input.expectedVersion && (!scan.version || compareScanVersions(scan.version, input.expectedVersion) !== 0))) return controlResult("conflict");
    if (scan.completedAt) return controlResult("already_terminal");
    const controller = scanAbortController;
    if (!controller && !scanPaused && scan.progress?.phase !== "stopped") return controlResult("already_terminal");
    if (canceling) return controlResult("conflict");
    const jobId = scan.jobId;
    const sourceId = activeScanRequest?.sourceId;
    canceling = true;
    scanPaused = false;
    controller?.abort();
    if (jobId) canceledScanJobs.add(jobId);
    resumePausedScan?.();
    resumePausedScan = undefined;
    try {
      await Promise.all([...activeScans]);
      if (jobId) {
        const path = join(scanStoreDirectory, `${jobId}.sqlite`);
        await Promise.all([rm(path, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
      }
      setScan({ ...emptyScanState(), jobId: scan.jobId, attemptId: scan.attemptId, startedAt: scan.startedAt, sourceId: scan.sourceId, status: "cancelled" });
      activeScanRequest = undefined;
      progressBeforePause = null;
      logger.info("scan.canceled", { jobId, sourceId });
      return controlResult("applied");
    } finally {
      canceling = false;
    }
  }

  async function scanResults(jobId: string, cursor = "0", limit = 100): Promise<{ items: Array<{ sourceId: string; conversationId: string; memoryId?: string; error?: string }>; nextCursor: string | null; attemptId?: string }> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new MemoryServiceError("invalid_argument", "Invalid scan job id");
    const path = join(scanStoreDirectory, `${jobId}.sqlite`);
    if (!existsSync(path)) return { items: [], nextCursor: null };
    const store = await openMemoryAgentSourceScanStore(path, { jobId, sourceId: "all", mode: "incremental", phase: "ingest", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    try {
      const attemptId = store.getMeta()?.attemptId;
      const separator = cursor.lastIndexOf("/");
      if (separator >= 0) {
        if (cursor.slice(0, separator) !== attemptId) throw new MemoryServiceError("conflict", "Scan attempt changed; reload results from the first page");
        cursor = cursor.slice(separator + 1);
      }
      const safeLimit = Math.min(500, Math.max(1, limit));
      const safeCursor = Number.isFinite(Number(cursor)) && Number(cursor) >= 0 ? String(Math.floor(Number(cursor))) : "0";
      const rows = [...store.results(undefined, safeCursor, safeLimit)];
      const items = rows.map(({ cursor: _cursor, ...item }) => item);
      const nextCursor = rows.length < safeLimit ? null : `${attemptId}/${rows.at(-1)!.cursor}`;
      return { items, nextCursor, attemptId };
    } finally {
      store.close();

    }
  }

  let unitsSinceYield = 0;
  let lastYieldAt = performance.now();
  async function waitWhilePaused(signal: AbortSignal): Promise<void> {
    if (++unitsSinceYield >= 100 || performance.now() - lastYieldAt >= 16) {
      await yieldEventLoop();
      unitsSinceYield = 0;
      lastYieldAt = performance.now();
    }
    signal.throwIfAborted();
    while (scanPaused) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          resumePausedScan = undefined;
          reject(signal.reason ?? new Error("Agent source scan canceled"));
        };
        resumePausedScan = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    signal.throwIfAborted();
  }

  async function mutateConnection(
    sourceId: string,
    kind: "plugin" | "skill",
    method: "POST" | "DELETE",
    installType: "manual" | "auto_inject" = "manual"
  ): Promise<unknown> {
    const adapter = registry.require(sourceId);
    if (!(await adapter.detect())) {
      throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
    }
    const target = integrationRegistry.get(sourceId);
    if (!target) throw new MemoryServiceError("invalid_argument", `Agent source ${sourceId} cannot be connected automatically`);
    if (method === "POST") {
      if (!(await target.resolveRootDirectory())) {
        throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
      }
      if (kind === "plugin") {
        if (!target.installPlugin) {
          throw new MemoryServiceError("invalid_argument", `${adapter.descriptor.displayName} does not support automatic Hook or plugin installation`);
        }
        await target.installPlugin(sourceId);
      } else {
        await target.install(renderMemmyDefaultSkillManifest(sourceId));
      }
    } else {
      if (kind === "plugin" && target.uninstallPlugin) await target.uninstallPlugin(sourceId);
      await target.uninstall(sourceId);
    }
    const state = await readState();
    const stored = state.sources[sourceId] ?? emptySourceState();
    const nextState: PersistedSourceState = {
      ...stored,
      status: method === "POST" ? connectionStatus(sourceId) : "not_connected"
    };
    if (method === "DELETE") {
      nextState.autoInjectSuppressed = true;
    } else if (installType === "manual") {
      delete nextState.autoInjectSuppressed;
    }
    state.sources[sourceId] = nextState;
    await persist(state);
    logger.info(method === "POST" ? "connection.installed" : "connection.removed", { sourceId, kind });
    return { ok: true, sourceId, status: state.sources[sourceId].status };
  }

  function scheduleAutomation(delay: number, startup: boolean): void {
    if (disposed || clearing) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      activeAutomation = runAutomation(startup)
        .catch((error) => logger.warn("automation.failed", memoryErrorFields(error)))
        .finally(() => scheduleAutomation(
          options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
          false
        ));
    }, delay);
    scanTimer.unref?.();
  }

  async function runAutomation(startup: boolean): Promise<void> {
    if (disposed || clearing || scan.running || scanPaused || scan.progress?.phase === "stopped") return;
    const config = loadMemmyConfig(configPath).config.agentAccess;
    // Refresh an existing connection even when automatic *new* connections are
    // disabled. Explicit removal remains authoritative.
    const refreshTarget = integrationRegistry.get("opencode");
    if (registry.get("opencode") && refreshTarget?.isInstalledHookCurrent) {
      const stateBeforeRefresh = await readState();
      if (!stateBeforeRefresh.sources.opencode?.autoInjectSuppressed
        && (stateBeforeRefresh.sources.opencode?.status === "plugin_installed" || await refreshTarget.isInstalled("opencode"))) {
        try {
          if (!(await refreshTarget.isInstalledHookCurrent())) {
            const latestState = await readState();
            if (!disposed && !clearing && !latestState.sources.opencode?.autoInjectSuppressed) {
              await mutateConnection("opencode", "plugin", "POST", "auto_inject");
              const installedState = await readState();
              if (installedState.sources.opencode?.autoInjectSuppressed) {
                await mutateConnection("opencode", "plugin", "DELETE", "auto_inject");
              }
            }
          }
        } catch (error) {
          logger.warn("connection.auto_update_failed", { sourceId: "opencode", ...memoryErrorFields(error) });
        }
      }
    }
    if (config.autoInjectSkill) {
      const state = await readState();
      const discovered = await list();
      for (const source of discovered.sources) {
        if (disposed || clearing) return;
        if (!source.available || source.status !== "not_connected" || state.sources[source.sourceId]?.autoInjectSuppressed === true) continue;
        try {
          const kind = agentConnectionKind(source.sourceId);
          await mutateConnection(source.sourceId, kind, "POST", "auto_inject");
          const currentState = await readState();
          if (currentState.sources[source.sourceId]?.autoInjectSuppressed === true) {
            await mutateConnection(source.sourceId, kind, "DELETE", "auto_inject");
          }
        } catch (error) {
          logger.warn("connection.auto_install_failed", { sourceId: source.sourceId, ...memoryErrorFields(error) });
        }
      }
    }
    const enabled = startup ? config.autoScanKnownAgents : config.watchFileChanges;
    if (enabled && !disposed && !clearing) await startScan({ sourceId: "all" });
  }

  async function clearAllData(): Promise<ReturnType<MemoryService["clearAllData"]>> {
    if (disposed) throw new MemoryServiceError("conflict", "Agent source executor is shutting down");
    if (clearing) throw new MemoryServiceError("conflict", "Memory data is already being cleared");
    clearing = true;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = undefined;
    try {
      if (scan.running || scanPaused || scan.progress?.phase === "stopped") {
        const cancelled = await cancelScan({ expectedVersion: scan.version });
        if (cancelled.outcome === "conflict") {
          throw new MemoryServiceError("conflict", "Could not stop the Agent source scan before clearing Memory data");
        }
      }
      if (activeAutomation) await activeAutomation;
      await Promise.all([...activeScans]);

      const current = await readState();
      const sources = Object.fromEntries(Object.entries(current.sources).map(([sourceId, source]) => [sourceId, {
        status: source.status,
        ...(source.autoInjectSuppressed === true ? { autoInjectSuppressed: true } : {}),
        messageCount: 0,
        lastScannedAt: null,
        latestSeenAt: null
      } satisfies PersistedSourceState]));
      const resetState: PersistedState = { version: 2, legacyRecoveryChecked: true, sources };
      await persist(resetState);
      statePromise = Promise.resolve(resetState);

      await removeScanDatabases(scanStoreDirectory);
      await removeSQLiteDatabase(`${statePath}.checkpoints.sqlite`);
      scanPaused = false;
      activeScanRequest = undefined;
      progressBeforePause = null;
      resumePausedScan = undefined;
      setScan(emptyScanState());

      return await options.service.clearAllData();
    } finally {
      clearing = false;
      if (!disposed && automationStarted) {
        const config = loadMemmyConfig(configPath).config.agentAccess;
        scheduleAutomation(
          config.autoScanKnownAgents
            ? options.initialScanDelayMs ?? INITIAL_SCAN_DELAY_MS
            : options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
          config.autoScanKnownAgents
        );
      }
    }
  }

  return {
    list,
    clearAllData,
    startScan,
    scanStatus: snapshot,
    pauseScan,
    cancelScan,
    scanResults,
    mutateConnection,
    startAutomation() {
      automationStarted = true;
      if (scanTimer || disposed) return;
      const config = loadMemmyConfig(configPath).config.agentAccess;
      scheduleAutomation(
        config.autoScanKnownAgents
          ? options.initialScanDelayMs ?? INITIAL_SCAN_DELAY_MS
          : options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
        config.autoScanKnownAgents
      );
    },
    async dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = undefined;
      scanPaused = false;
      scanAbortController?.abort();
      resumePausedScan?.();
      resumePausedScan = undefined;
      await activeAutomation;
      await Promise.all(activeScans);
    }
  };
}

async function removeScanDatabases(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const databases = entries.filter((entry) => /\.sqlite(?:-(?:wal|shm))?$/.test(entry));
  await Promise.all(databases.map((entry) => rm(join(directory, entry), { force: true })));
}

async function removeSQLiteDatabase(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((file) => rm(file, { force: true })));
}

function findReusableScanJob(directory: string, sourceId: string, mode?: string, excludedJobs: ReadonlySet<string> = new Set()): string | null {
  if (!existsSync(directory)) return null;
  let selected: { jobId: string; updatedAt: number } | null = null;
  for (const name of readdirSync(directory).filter((value) => value.endsWith(".sqlite"))) {
    const path = join(directory, name);
    let db: InstanceType<typeof Database> | undefined;
    try {
      db = new Database(path, { readonly: true });
      const row = db.prepare("SELECT job_id AS jobId, source_id AS sourceId, mode, phase, updated_at AS updatedAt FROM scan_meta WHERE id=1").get() as { jobId: string; sourceId: string; mode?: string; phase: string; updatedAt: string } | undefined;
      const requestedMode = readScanRequestedMode(db);
      db.close();
      db = undefined;
      if (row && excludedJobs.has(row.jobId)) continue;
      if (row?.phase === "done") {
        const updatedAt = Date.parse(row.updatedAt);
        if (Number.isFinite(updatedAt) && Date.now() - updatedAt > COMPLETED_DETAILS_RETENTION_MS) {
          rmSync(path, { force: true });
          rmSync(`${path}-wal`, { force: true });
          rmSync(`${path}-shm`, { force: true });
        }
        continue;
      }
      if (row && row.sourceId === sourceId && (!mode || (requestedMode === undefined ? !row.mode || row.mode === mode : requestedMode === mode))) {
        const updatedAt = Date.parse(row.updatedAt);
        if (!selected || updatedAt > selected.updatedAt) selected = { jobId: row.jobId, updatedAt };
      }
    } catch { /* leave corrupt stores for explicit diagnostics */ }
    finally { db?.close(); }
  }
  return selected?.jobId ?? null;
}

function sameScanRequest(
  left: ReturnType<typeof normalizeScanInput>,
  right: ReturnType<typeof normalizeScanInput>
): boolean {
  return left.sourceId === right.sourceId && (right.mode === undefined || left.mode === right.mode);
}

export function createBuiltinSourceRegistry(): SourceRegistry {
  return createSourceRegistry([
    createCursorSourceAdapter(),
    createClaudeCodeSourceAdapter(),
    createCodexSourceAdapter(),
    createOpencodeSourceAdapter(),
    createOpenclawSourceAdapter(),
    createHermesSourceAdapter(),
    createDeepseekHarnessSourceAdapter(),
    createWorkbuddySourceAdapter(),
    createPiSourceAdapter(),
    createQwenworkSourceAdapter()
  ]);
}

export function createBuiltinIntegrationRegistry(configPath: string): SkillTargetRegistry {
  return createSkillTargetRegistry([
    createCursorSkillTarget({ memmyConfigPath: configPath }),
    createClaudeCodeSkillTarget({ memmyConfigPath: configPath }),
    createCodexSkillTarget({ memmyConfigPath: configPath }),
    createOpencodeSkillTarget({ memmyConfigPath: configPath }),
    createOpenclawSkillTarget({ memmyConfigPath: configPath }),
    createHermesSkillTarget({ memmyConfigPath: configPath }),
    createDeepseekHarnessSkillTarget({ memmyConfigPath: configPath }),
    createWorkbuddySkillTarget(),
    createPiSkillTarget(),
    createQwenworkSkillTarget()
  ]);
}

interface StandaloneSourceStage {
  adapter: SourceAdapter;
  stored: PersistedSourceState;
  sourceId: string;
  mode: "initial_subset" | "incremental" | "full";
  staged: number;
  scanErrorCount: number;
  errors: string[];
}

async function stageStandaloneSource(
  adapter: SourceAdapter,
  stored: PersistedSourceState,
  mode: "initial_subset" | "incremental" | "full",
  store: MemoryAgentSourceScanStore,
  signal: AbortSignal,
  checkpoint: () => Promise<void>,
  onProgress: (progress: ScanProgress) => void
): Promise<StandaloneSourceStage> {
  const sourceId = adapter.descriptor.sourceId;
  const errors: string[] = [];
  let scanErrorCount = 0;
  const batch: ConversationMessage[] = [];
  let batchBytes = 0;
  let staged = 0;
  let emittedOrdinal = 0;
  store.saveSourceState({
    sourceId,
    mode,
    phase: "stage",
    messageCount: store.count(sourceId),
    resultCount: store.resultCount(sourceId),
    errorCount: 0,
    updatedAt: new Date().toISOString(),
    ...(stored.latestSeenAt ? { watermarkedSince: stored.latestSeenAt } : {})
  });
  try {
    for await (const message of adapter.scan({
      ...(mode === "incremental" && stored.latestSeenAt ? { since: stored.latestSeenAt } : {}),
      order: mode === "initial_subset" ? "recent_first" : "source_default",
      // Incremental scans must honor the persisted boundary. Initial and full
      // scans read every historical message; initial scans still select only
      // the recent memory subset before capture.
      fullHistory: mode === "initial_subset" || mode === "full",
      signal,
      onProgress
    })) {
      await checkpoint();
      const normalizedMessage = message.sourceId === sourceId ? message : { ...message, sourceId };
      const bytes = Buffer.byteLength(JSON.stringify(normalizedMessage));
      if (bytes > 64 * 1024 * 1024) {
        recordScanItemSkip(store, sourceId, message.conversationId, "record exceeds 64 MiB", `read:${message.messageId}`);
        continue;
      }
      if (batch.length > 0 && (batch.length >= 100 || batchBytes + bytes > 8 * 1024 * 1024)) {
        staged += store.stageBatch(batch);
        const last = batch[batch.length - 1]!;
        store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
        batch.length = 0;
        batchBytes = 0;
      }
      store.resolveItem(sourceId, message.conversationId, `read:${message.messageId}`);
      batch.push({ ...normalizedMessage, ordinal: emittedOrdinal++ });
      batchBytes += bytes;
      if (batch.length >= 100 || batchBytes >= 8 * 1024 * 1024) {
        staged += store.stageBatch(batch);
        const last = batch[batch.length - 1]!;
        store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
        batch.length = 0;
        batchBytes = 0;
      }
    }
    if (batch.length > 0) {
      staged += store.stageBatch(batch);
      const last = batch[batch.length - 1]!;
      store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
    }
    store.resolveItem(sourceId, "scan", "reader");
    if (!store.getConversationMeta(sourceId, "scan")) store.resolveItem(sourceId, "scan", "legacy");
  } catch (error) {
    if (signal.aborted) throw error;
    scanErrorCount += 1;
    const reason = error instanceof Error ? error.message : "Agent source scan failed";
    if (errors.length < 1000) errors.push(`${sourceId}: ${reason}`);
    store.saveResult({ sourceId, conversationId: "scan", itemKey: "reader", error: reason });
  }
  store.saveSourceState({
    sourceId,
    mode,
    phase: scanErrorCount > 0 ? "failed" : "stage",
    messageCount: store.count(sourceId),
    resultCount: store.resultCount(sourceId),
    errorCount: scanErrorCount,
    updatedAt: new Date().toISOString(),
    ...(stored.latestSeenAt ? { watermarkedSince: stored.latestSeenAt } : {})
  });
  return { adapter, stored, sourceId, mode, staged, scanErrorCount, errors };
}

async function ingestStagedMessages(
  service: MemoryService,
  store: MemoryAgentSourceScanStore,
  checkpoints: SourceCheckpoints,
  sourceId: string,
  signal: AbortSignal,
  checkpoint: () => Promise<void>,
  onProgress: (progress: ScanProgress) => void,
  scheduleWorker?: () => void,
  memoryAddAnalytics?: Pick<
    MemoryDesktopAddAnalytics,
    "trackAddStarted" | "trackAddSucceeded" | "trackAddFailed"
  >,
  scanMode?: MemoryDesktopAddScanMode
): Promise<{ written: number; skipped: number; messageCount: number; errors: string[]; errorCount: number; latestSeenAt: string | null; retryFrom: string | null; hasUncommittedSkips: boolean }> {
  let written = 0;
  let messageCount = 0;
  let skipped = 0;
  let itemKey = "legacy";
  let processed = 0;
  // Staging is finished, so this total stays fixed throughout ingestion.
  const totalMessages = store.count(sourceId);
  let latestSeenAt: string | null = null;
  let retryFrom: string | null = null;
  const errors: string[] = [];
  let errorCount = 0;
  let hasUncommittedSkips = false;
  let activeConversationId: string | null = null;
  let activeConversationFailed = false;
  let wholeConversationAttempted = true;
  const noteUncommittedSkip = (reason: string, latestActivityAt: string | null) => {
    if (!sourceTurnSkipBlocksWatermark(reason)) return;
    activeConversationFailed = true;
    const effect = sourceTurnSkipWatermarkEffect(reason, latestActivityAt);
    if (effect === "rescan") hasUncommittedSkips = true;
    else if (effect === "retry" && latestActivityAt && (!retryFrom || Date.parse(latestActivityAt) < Date.parse(retryFrom))) {
      retryFrom = latestActivityAt;
    }
  };
  const noteCaptureFailure = () => {
    activeConversationFailed = true;
    hasUncommittedSkips = true;
  };
  const commitConversation = () => {
    if (!activeConversationId || activeConversationFailed) return;
    if (wholeConversationAttempted) store.resolveItem(sourceId, activeConversationId, "legacy");
    const meta = store.getConversationMeta(sourceId, activeConversationId);
    if (!meta) return;
    const checkpoint = {
      sourceId,
      conversationId: activeConversationId,
      lastMessageId: meta.lastMessageId,
      lastCreatedAt: meta.lastCreatedAt,
      contentHash: meta.contentHash,
      updatedAt: new Date().toISOString()
    };
    store.saveCheckpoint(checkpoint);
  };
  const memoryIds: string[] = [];
  const flush = (force = false) => {
    if (memoryIds.length === 0 || (!force && memoryIds.length < 100)) return;
    service.enqueuePendingImportSummaries(INITIAL_SCAN_MESSAGE_LIMIT, memoryIds.splice(0));
    scheduleWorker?.();
  };
  const pages = (async function*() {
    let cursor: Parameters<ScanStore["messages"]>[1];
    while (true) {
      const page = readScanPage(store, sourceId, cursor);
      if (page.length === 0) break;
      for (const message of page) {
        // orderedTurns can consume pages without emitting a turn (unfinished
        // history or one very long turn), so checkpoint before grouping too.
        await checkpoint();
        yield message;
      }
      const last = page[page.length - 1]!;
      cursor = { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 };
    }
  })();
  for await (const turn of orderedTurns(pages)) {
    await checkpoint();
    signal.throwIfAborted();
    // Staged message identity survives enrichment of previously missing native turn metadata.
    itemKey = `turn:${turn.messages[0]!.messageId}`;
    const turnLatest = turn.messages[turn.messages.length - 1]?.createdAt ?? null;
    if (turnLatest && (latestSeenAt === null || Date.parse(turnLatest) > Date.parse(latestSeenAt))) latestSeenAt = turnLatest;
    if (turn.conversationId !== activeConversationId) {
      commitConversation();
      activeConversationId = turn.conversationId;
      activeConversationFailed = false;
      wholeConversationAttempted = true;
    }
    const conversationMeta = store.getConversationMeta(sourceId, turn.conversationId);
    if (conversationMeta?.selected === false) {
      wholeConversationAttempted = false;
      processed += turn.messages.length;
      onProgress({ sourceId, phase: "add", current: processed, total: totalMessages, message: "Capturing conversation turns" });
      continue;
    }
    const selectedTurn = store.getTurnMeta(sourceId, turn.conversationId, stableTurnIdentity(turn));
    if (selectedTurn && !selectedTurn.selected) {
      wholeConversationAttempted = false;
      processed += turn.messages.length;
      onProgress({ sourceId, phase: "add", current: processed, total: totalMessages, message: "Capturing conversation turns" });
      continue;
    }
    if (hasStagedSourceTurn(turn.messages[0])) {
      let addAnalyticsBase: {
        adapterId: string;
        conversationId: string;
        turnId: string;
        scanMode?: MemoryDesktopAddScanMode;
      } | undefined;
      let addStartedAt = 0;
      let reportedAdd = false;
      try {
        const sourceTurn = sourceTurnFromMessages(turn.messages);
        if (!sourceTurn) {
          const reason = sourceTurnFailureReason(turn.messages);
          recordScanItemSkip(store, sourceId, turn.conversationId, reason, itemKey, turnLatest);
          noteUncommittedSkip(reason, turnLatest);
          processed += turn.messages.length;
          onProgress({ sourceId, phase: "add", current: processed, total: totalMessages, message: "Capturing conversation turns" });
          continue;
        }
        const legacyImportTurnId = legacyImportTurnIdFromMessages(sourceId, turn.conversationId, turn.messages);
        const resolvedScanMode = persistentScanMode(store.getSourceState(sourceId)?.mode ?? scanMode);
        addAnalyticsBase = {
          adapterId: `agent-source:${sourceId}`,
          conversationId: turn.conversationId,
          turnId: sourceTurn.turnId,
          ...(resolvedScanMode ? { scanMode: resolvedScanMode } : {})
        };
        addStartedAt = Date.now();
        const result = service.completeSourceTurn({
          ...buildSourceTurnRequest(sourceTurn, "agent_source_scan"),
          ...(legacyImportTurnId ? { legacyImportTurnId } : {}),
          ...(scanMode === "initial_subset" || scanMode === "full" ? { captureLegacyHistory: true } : {})
        });
        if (result.status === "rejected" && result.reason === "legacy_before_activation" && (scanMode === "initial_subset" || scanMode === "full")) {
          recordScanItemSkip(store, sourceId, turn.conversationId, result.reason, itemKey, turnLatest);
          noteUncommittedSkip(result.reason, turnLatest);
          processed += turn.messages.length;
          onProgress({ sourceId, phase: "add", current: processed, total: totalMessages, message: "Capturing conversation turns" });
          continue;
        }
        if (result.status === "pending" || result.status === "conflict") {
          const reason = result.reason ?? result.status;
          recordScanItemSkip(store, sourceId, turn.conversationId, reason, itemKey, turnLatest);
          noteUncommittedSkip(reason, turnLatest);
          processed += turn.messages.length;
          onProgress({ sourceId, phase: "add", current: processed, total: totalMessages, message: "Capturing conversation turns" });
          continue;
        }
        const ids = result.result?.l1MemoryIds ?? [];
        if (result.status !== "stored") skipped += turn.messages.length;
        if (result.status === "stored") {
          written += ids.length;
          memoryAddAnalytics?.trackAddStarted(addAnalyticsBase);
          memoryAddAnalytics?.trackAddSucceeded({
            ...addAnalyticsBase,
            durationMs: Date.now() - addStartedAt,
            storedCount: Math.max(ids.length, 1)
          });
          reportedAdd = true;
        }
        if (ids.length === 0) store.saveResult({ sourceId, itemKey, conversationId: turn.conversationId });
        for (const memoryId of ids) store.saveResult({ sourceId, itemKey, conversationId: turn.conversationId, memoryId });
        checkpoints.markMessages(turn.messages);
        messageCount += turn.messages.length;
        if (result.status === "stored") scheduleWorker?.();
      } catch (error) {
        const reason = error instanceof Error ? error.message : "native turn ingestion failed";
        activeConversationFailed = true;
        hasUncommittedSkips = true;
        errorCount += 1;
        if (errors.length < 1000) errors.push(`${turn.conversationId}: ${reason}`);
        recordScanItemSkip(store, sourceId, turn.conversationId, reason, itemKey);
        noteCaptureFailure();
        if (addAnalyticsBase && !reportedAdd) {
          memoryAddAnalytics?.trackAddStarted(addAnalyticsBase);
          memoryAddAnalytics?.trackAddFailed({
            ...addAnalyticsBase,
            durationMs: Date.now() - addStartedAt,
            error
          });
        }
      }
      processed += turn.messages.length;
      onProgress({ sourceId, phase: "add", current: processed, total: totalMessages, message: "Capturing conversation turns" });
      continue;
    }
    let succeeded = true;
    const resolvedScanMode = persistentScanMode(store.getSourceState(sourceId)?.mode ?? scanMode);
    const addAnalyticsBase = {
      adapterId: `agent-source:${sourceId}`,
      conversationId: turn.conversationId,
      turnId: legacyTurnId(turn),
      ...(resolvedScanMode ? { scanMode: resolvedScanMode } : {})
    };
    const addStartedAt = Date.now();
    // One turn is one memory. Splitting an agentic turn fans a single exchange
    // out into hundreds of near-empty tool-call fragments, so an oversized turn
    // is clipped to the wire budget instead of being fanned out.
    try {
      const added = service.addMemory({
        requestId: legacyTurnRequestId(turn), adapterId: `agent-source:${sourceId}`,
        content: renderTurnClipped(turn.messages), layer: "L1",
        title: titleForTurn(sourceId, turn.messages), tags: ["agent-source", sourceId], source: sourceId,
        turnId: addAnalyticsBase.turnId, createdAt: turn.messages[0]!.createdAt, deferProcessing: true
      });
      if (!added.duplicate) {
        memoryAddAnalytics?.trackAddStarted(addAnalyticsBase);
        memoryAddAnalytics?.trackAddSucceeded({
          ...addAnalyticsBase,
          durationMs: Date.now() - addStartedAt,
          storedCount: 1
        });
      }
      store.saveResult({ sourceId, itemKey, conversationId: turn.conversationId, memoryId: added.id });
      store.saveImportMemory(sourceId, added.id);
      memoryIds.push(added.id);
      if (!added.duplicate) written += 1;
      else skipped += turn.messages.length;
      checkpoints.markMessages(turn.messages);
    } catch (error) {
      succeeded = false;
      activeConversationFailed = true;
      const reason = error instanceof Error ? error.message : String(error);
      errorCount += 1;
      if (errors.length < 1000) errors.push(`${turn.conversationId}: ${reason}`);
      hasUncommittedSkips = true;
      recordScanItemSkip(store, sourceId, turn.conversationId, reason, itemKey);
      memoryAddAnalytics?.trackAddStarted(addAnalyticsBase);
      memoryAddAnalytics?.trackAddFailed({
        ...addAnalyticsBase,
        durationMs: Date.now() - addStartedAt,
        error
      });
    }
    if (succeeded) {
      messageCount += turn.messages.length;
      flush();
    }
    processed += turn.messages.length;
    onProgress({ sourceId, phase: "add", current: processed, total: totalMessages, message: "Adding raw memories" });
  }
  flush(true);
  commitConversation();
  return { written, skipped, messageCount, errors, errorCount, latestSeenAt, retryFrom, hasUncommittedSkips };
}

async function prepareStandaloneSource(
  store: MemoryAgentSourceScanStore,
  checkpoints: SourceCheckpoints,
  sourceId: string,
  mode: "initial_subset" | "incremental" | "full",
  latestSeenAt: string | null,
  checkpoint: () => Promise<void>,
  onProgress: (progress: ScanProgress) => void
): Promise<string> {
  let cursor: Parameters<ScanStore["messages"]>[1];
  let prepared = 0;
  const total = store.count(sourceId);
  onProgress({ sourceId, phase: "prepare", current: 0, total });
  let currentConversation: string | null = null;
  let currentTurn: ConversationMessage[] = [];
  let hash = createHash("sha256");
  let first = true;
  let latest: ConversationMessage | null = null;
  const sourceHash = createHash("sha256");
  sourceHash.update("[");
  let firstSourceMessage = true;
  const flushTurn = () => {
    if (!currentTurn.length || (!hasStagedSourceTurn(currentTurn[0]) && !isCompleteTurn(currentTurn))) return;
    const firstMessage = currentTurn[0]!;
    const lastMessage = currentTurn[currentTurn.length - 1]!;
    const turn = { sourceId, conversationId: firstMessage.conversationId, turnIndex: 0, messages: currentTurn };
    store.saveTurnMeta({
      sourceId,
      conversationId: firstMessage.conversationId,
      turnId: stableTurnIdentity(turn),
      firstMessageId: firstMessage.messageId,
      firstCreatedAt: firstMessage.createdAt,
      lastMessageId: lastMessage.messageId,
      lastCreatedAt: lastMessage.createdAt,
      // A conversation may contain years of history but only one new turn.
      // Select turns at the watermark, not every turn in that conversation.
      selected: mode !== "incremental" || !latestSeenAt ||
        isAtOrAfter(lastMessage.createdAt, latestSeenAt)
    });
  };
  const flushConversation = () => {
    if (!currentConversation || !latest) return;
    hash.update("]");
    const contentHash = hash.digest("hex");
    const previous = checkpoints.getCheckpoint(sourceId, currentConversation);
    const selected = mode !== "incremental" || !previous
      || previous.contentHash !== contentHash
      || previous.lastCreatedAt !== latest.createdAt
      || previous.lastMessageId !== latest.messageId;
    store.saveConversationMeta({
      sourceId,
      conversationId: currentConversation,
      lastMessageId: latest.messageId,
      lastCreatedAt: latest.createdAt,
      contentHash,
      selected
    });
  };
  while (true) {
    const page = readScanPage(store, sourceId, cursor);
    if (page.length === 0) break;
    for (const message of page) {
      await checkpoint();
      if (++prepared % 100 === 0) onProgress({ sourceId, phase: "prepare", current: prepared, total });
      if (message.conversationId !== currentConversation) {
        flushTurn();
        flushConversation();
        currentConversation = message.conversationId;
        currentTurn = [];
        hash = createHash("sha256");
        hash.update("[");
        first = true;
      }
      if (currentTurn.length > 0 && (hasStagedSourceTurn(message) ? message.rawMeta.sourceTurnId !== currentTurn[0]?.rawMeta.sourceTurnId : message.role === "user")) {
        flushTurn();
        currentTurn = [];
      }
      currentTurn.push(message);
      if (!first) hash.update(",");
      first = false;
      const hashable = {
        messageId: message.messageId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        toolName: hashMeta(message, "toolName") ?? hashMeta(message, "hermesToolName"),
        toolCallId: hashMeta(message, "toolCallId") ?? hashMeta(message, "hermesToolCallId"),
        ...(hasStagedSourceTurn(message) ? { sourceTurn: message.rawMeta } : {})
      };
      const serialized = JSON.stringify(hashable);
      if (!firstSourceMessage) sourceHash.update(",");
      firstSourceMessage = false;
      sourceHash.update(serialized);
      hash.update(serialized);
      latest = message;
    }
    const last = page[page.length - 1]!;
    cursor = { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 };
  }
  flushTurn();
  flushConversation();
  sourceHash.update("]");
  const contentHash = sourceHash.digest("hex");
  return contentHash;
}

/** Promise-only iteration can monopolize Node's microtask queue; release HTTP I/O regularly. */
function createScanCheckpoint(signal: AbortSignal, waitIfPaused: () => Promise<void>): () => Promise<void> {
  let yieldAt = performance.now() + SCAN_EVENT_LOOP_BUDGET_MS;
  let items = 0;
  return async () => {
    signal.throwIfAborted();
    await waitIfPaused();
    if (++items < SCAN_CHECKPOINT_ITEM_LIMIT && performance.now() < yieldAt) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    await waitIfPaused();
    items = 0;
    yieldAt = performance.now() + SCAN_EVENT_LOOP_BUDGET_MS;
  };
}

function isAtOrAfter(value: string, boundary: string): boolean {
  const valueAt = Date.parse(value);
  const boundaryAt = Date.parse(boundary);
  return !Number.isFinite(valueAt) || !Number.isFinite(boundaryAt) || valueAt >= boundaryAt;
}

function hashMeta(message: ConversationMessage, key: string): string | undefined {
  const value = message.rawMeta[key];
  return typeof value === "string" ? value : undefined;
}

function recordScanItemSkip(
  store: MemoryAgentSourceScanStore,
  sourceId: string,
  conversationId: string,
  reason: string,
  itemKey = "legacy",
  latestActivityAt?: string | null
): void {
  logger.warn("scan.item_skipped", { sourceId, conversationId, reason });
  // Preserve v1.2.6: unfinished turns are held/revisited by the watermark,
  // not failed imports. Unavailable capture and actual write failures still fail.
  if (reason === "turn_cancelled" || (latestActivityAt !== undefined && sourceTurnSkipBlocksWatermark(reason) &&
    sourceTurnSkipWatermarkEffect(reason, latestActivityAt) !== "rescan")) {
    store.resolveItem(sourceId, conversationId, itemKey);
    return;
  }
  store.saveResult({ sourceId, conversationId, itemKey, error: reason });
}

function readScanPage(store: MemoryAgentSourceScanStore, sourceId: string, cursor?: { conversationId: string; createdAt: string; messageId: string; ordinal: number }): ConversationMessage[] {
  const page: ConversationMessage[] = [];
  let bytes = 0;
  for (const message of store.messages(sourceId, cursor, 500)) {
    page.push(message);
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (page.length >= 500 || bytes >= 8 * 1024 * 1024) break;
  }
  return page;
}

async function ingestAgentSkills(
  service: MemoryService,
  sourceId: string,
  store: MemoryAgentSourceScanStore,
  checkpoint: () => Promise<void>,
  resolveAgentSkillRoot: (sourceId: string) => string | null = agentRootDirectory,
  scheduleWorker?: () => void,
  memoryAddAnalytics?: Pick<
    MemoryDesktopAddAnalytics,
    "trackAddStarted" | "trackAddSucceeded" | "trackAddFailed"
  >,
  scanMode?: MemoryDesktopAddScanMode,
  signal?: AbortSignal,
  waitIfPaused: () => Promise<void> = async () => undefined
): Promise<{ written: number; memoryIdCount: number; errorCount: number; errors: string[] }> {
  const root = resolveAgentSkillRoot(sourceId);
  if (!root) return { written: 0, memoryIdCount: 0, errorCount: 0, errors: [] };
  const skillsRoot = join(root, "skills");
  const errors: string[] = [];
  let written = 0;
  let memoryIdCount = 0;
  let errorCount = 0;
  const pendingIds: string[] = [];
  const flush = (force = false) => {
    if (pendingIds.length === 0 || (!force && pendingIds.length < 100)) return;
    service.enqueuePendingImportSummaries(INITIAL_SCAN_MESSAGE_LIMIT, pendingIds.splice(0));
    scheduleWorker?.();
  };
  for await (const filePath of findSkillFiles(skillsRoot, checkpoint)) {
    await checkpoint();
    const sourceSkillId = relative(skillsRoot, dirname(filePath)).replaceAll("\\", "/");
    const addAnalyticsBase = {
      adapterId: `agent-source:${sourceId}`,
      conversationId: `skill:${sourceSkillId}`,
      turnId: `skill:${sourceSkillId}`,
      layer: "Skill" as const,
      ...(scanMode ? { scanMode } : {})
    };
    const addStartedAt = Date.now();
    await checkpoint();
    try {
      const content = await readFile(filePath, "utf8");
      const contentHash = createHash("sha256").update(content).digest("hex");
      const requestId = `agent-source-skill:${sourceId}:${sourceSkillId}:${contentHash}`;
      const fileStat = await stat(filePath);
      const turnId = `skill:${sourceSkillId}:${contentHash}`;
      addAnalyticsBase.turnId = turnId;
      await waitIfPaused();
      signal?.throwIfAborted();
      const added = service.addMemory({
        requestId,
        adapterId: `agent-source:${sourceId}`,
        content,
        layer: "Skill",
        title: frontmatterValue(content, "name") ?? sourceSkillId,
        tags: ["agent-source", "cross-agent-skill", sourceId],
        source: sourceId,
        turnId,
        createdAt: fileStat.mtime.toISOString(),
        sourceAgentId: sourceId,
        sourceSkillId,
        sourceSkillPath: filePath,
        sourceSkillVersion: frontmatterValue(content, "version") ?? contentHash,
        sourceContentHash: contentHash,
        deferProcessing: true
      });
      if (added.duplicate !== true && added.status !== "deleted") {
        memoryAddAnalytics?.trackAddStarted(addAnalyticsBase);
        memoryAddAnalytics?.trackAddSucceeded({
          ...addAnalyticsBase,
          durationMs: Date.now() - addStartedAt,
          storedCount: 1
        });
      }
      if (!added.duplicate && added.status !== "deleted") written += 1;
      memoryIdCount += 1;
      store.saveResult({ sourceId, conversationId: `skill:${sourceSkillId}`, memoryId: added.id });
      if (added.status !== "deleted") {
        store.saveImportMemory(sourceId, added.id);
        pendingIds.push(added.id);
        flush();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      errorCount += 1;
      if (errors.length < 1000) errors.push(`skill:${sourceSkillId}: ${reason}`);
      recordScanItemSkip(
        store,
        sourceId,
        `skill:${sourceSkillId}`,
        reason
      );
      memoryAddAnalytics?.trackAddStarted(addAnalyticsBase);
      memoryAddAnalytics?.trackAddFailed({
        ...addAnalyticsBase,
        durationMs: Date.now() - addStartedAt,
        error
      });
    }
  }
  await checkpoint();
  flush(true);
  return { written, memoryIdCount, errorCount, errors };
}

async function* findSkillFiles(root: string, checkpoint: () => Promise<void>): AsyncGenerator<string> {
  yield* visit(root, 0);

  async function* visit(directory: string, depth: number): AsyncGenerator<string> {
    await checkpoint();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await checkpoint();
      if (entry.name === "memmy-memory" || entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") yield path;
      else if (depth < 2 && entry.isDirectory()) yield* visit(path, depth + 1);
    }
  }
}

function agentRootDirectory(sourceId: string): string | null {
  switch (sourceId) {
    case "cursor": return join(homedir(), ".cursor");
    case "claude_code": return resolveClaudeCodeHomeDirectory();
    case "codex": return resolveCodexHomeDirectory();
    case "opencode": return resolveOpencodeConfigDirectory();
    case "openclaw": return resolveOpenclawStateDirectory();
    case "hermes": return resolveHermesHomeDirectory();
    case "deepseek_harness": return resolveDeepseekHarnessHomeDirectory();
    case "workbuddy": return resolveWorkbuddyHomeDirectory();
    case "pi": return resolvePiAgentDirectory();
    case "qwenwork": return resolveQwenworkHomeDirectory();
    default: return null;
  }
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  return content.slice(3, end)
    .match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, "im"))?.[1]
    ?.trim();
}

function persistentScanMode(value: string | undefined): MemoryDesktopAddScanMode | undefined {
  return value === "initial_subset" || value === "incremental" || value === "full" ? value : undefined;
}

function titleForTurn(sourceId: string, messages: readonly ConversationMessage[]): string {
  const firstLine = messages[0]?.content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const title = firstLine || `${sourceId} conversation`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

function normalizeScanInput(value: unknown): {
  sourceId: string;
  mode?: "initial_subset" | "incremental" | "full";
  waitForProcessing?: boolean;
} {
  const input = record(value);
  if (input.mode !== undefined && !["initial_subset", "incremental", "full"].includes(String(input.mode))) throw new MemoryServiceError("invalid_argument", "Invalid scan mode");
  const sourceId = typeof input.sourceId === "string" && input.sourceId.trim() ? input.sourceId.trim() : "all";
  const mode = input.mode === "initial_subset" || input.mode === "incremental" || input.mode === "full"
    ? input.mode
    : undefined;
  return { sourceId, ...(mode ? { mode } : {}), ...(input.waitForProcessing === true ? { waitForProcessing: true } : {}) };
}

function emptyScanState(): AgentSourceScanState {
  return {
    running: false,
    jobId: null,
    sourceId: null,
    mode: null,
    progress: null,
    startedAt: null,
    completedAt: null,
    error: null
  };
}

function emptySourceState(): PersistedSourceState {
  return {
    status: "not_connected",
    messageCount: 0,
    lastScannedAt: null,
    latestSeenAt: null
  };
}

async function loadState(path: string): Promise<PersistedState> {
  try {
    const parsed = JSON.parse(await readStateWithoutLegacyIds(path)) as unknown;
    const value = record(parsed);
    const sourceValues = record(value.sources);
    const hasLegacyIds = Object.values(sourceValues).some((raw) => Object.hasOwn(record(raw), "importedRequestIds"));
    const sources = Object.fromEntries(Object.entries(sourceValues).map(([sourceId, raw]) => {
      const source = record(raw);
      const status = source.status === "skill_installed" || source.status === "plugin_installed" ? source.status : "not_connected";
      return [sourceId, {
        status,
        ...(source.autoInjectSuppressed === true ? { autoInjectSuppressed: true } : {}),
        messageCount: typeof source.messageCount === "number" && Number.isFinite(source.messageCount) ? Math.max(0, Math.floor(source.messageCount)) : 0,
        lastScannedAt: typeof source.lastScannedAt === "string" ? source.lastScannedAt : null,
        latestSeenAt: typeof source.latestSeenAt === "string" ? source.latestSeenAt : null,
        ...(source.recoveryPending === true ? { recoveryPending: true } : {}),
        ...(typeof source.syncBoundaryAt === "string" ? { syncBoundaryAt: source.syncBoundaryAt } : {}),
        ...(typeof source.contentHash === "string" ? { contentHash: source.contentHash } : {})
      } satisfies PersistedSourceState];
    }));
    const state: PersistedState = {
      version: 2,
      legacyRecoveryChecked: value.legacyRecoveryChecked === true,
      sources
    };
    if (value.version !== 2 || hasLegacyIds) await writeState(path, state);
    return state;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 2, sources: {} };
    throw error;
  }
}

/** Streams legacy state while replacing the unbounded ID arrays with empty arrays. */
async function readStateWithoutLegacyIds(path: string): Promise<string> {
  const temporaryPath = `${path}.v2-migration-${process.pid}-${Date.now()}-${randomUUID()}`;
  const input = createReadStream(path, { encoding: "utf8" });
  await new Promise<void>((resolve, reject) => {
    input.once("open", () => resolve());
    input.once("error", reject);
  });
  const output = createWriteStream(temporaryPath, { encoding: "utf8" });
  let inString = false;
  let escaped = false;
  let pendingLegacyArray = false;
  let skipDepth = 0;
  let skipString = false;
  let skipEscaped = false;
  let keyBuffer = "";
  try {
    for await (const chunk of input) {
      const text = String(chunk);
      let emitted = "";
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]!;
        if (skipDepth > 0) {
          if (skipString) {
            if (skipEscaped) skipEscaped = false;
            else if (char === "\\") skipEscaped = true;
            else if (char === '"') skipString = false;
          } else if (char === '"') skipString = true;
          else if (char === "[") skipDepth += 1;
          else if (char === "]") skipDepth -= 1;
          continue;
        }
        if (inString) {
          emitted += char;
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') { inString = false; keyBuffer += char; }
          else if (keyBuffer.length < 32) keyBuffer += char;
          continue;
        }
        if (char === '"') {
          inString = true;
          keyBuffer = '"';
          emitted += char;
          continue;
        }
        if (pendingLegacyArray) {
          emitted += char;
          if (/\s/u.test(char)) continue;
          if (char === "[") {
            emitted = emitted.slice(0, -1) + "[]";
            pendingLegacyArray = false;
            skipDepth = 1;
            skipString = false;
            skipEscaped = false;
          } else {
            pendingLegacyArray = false;
          }
          continue;
        }
        emitted += char;
        if (char === ":" && keyBuffer === '"importedRequestIds"') pendingLegacyArray = true;
        if (!/\s/u.test(char)) keyBuffer = "";
      }
      if (emitted && !output.write(emitted)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");
    return await readFile(temporaryPath, "utf8");
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeState(path: string, state: PersistedState, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  signal?.throwIfAborted();
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, signal });
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function connectionStatus(sourceId: string): AgentConnectionStatus {
  return agentConnectionKind(sourceId) === "plugin" ? "plugin_installed" : "skill_installed";
}

function agentConnectionKind(sourceId: string): "plugin" | "skill" {
  return ["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "deepseek_harness"].includes(sourceId)
    ? "plugin"
    : "skill";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Surface an interrupted Memory job as paused so every UI can resume or cancel it. */
function restoredScanState(directory: string): AgentSourceScanState {
  if (!existsSync(directory)) return emptyScanState();
  let latest: AgentSourceScanState = emptyScanState();
  let latestAt = 0;
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sqlite"))) {
    let db: InstanceType<typeof Database> | undefined;
    try {
      db = new Database(join(directory, name), { readonly: true, fileMustExist: true });
      const row = db.prepare("SELECT * FROM scan_meta WHERE id=1").get() as { attempt_id?: string; attempt_started_at?: string; completion?: string; error?: string; job_id: string; source_id: string; mode: AgentSourceScanState["mode"]; phase: string; created_at: string; updated_at: string } | undefined;
      if (!row || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.job_id)) continue;
      if (Date.parse(row.updated_at) < latestAt) continue;
      latestAt = Date.parse(row.updated_at);
      if (row.completion) { latest = JSON.parse(row.completion) as AgentSourceScanState; continue; }
      if (row.phase === "done") { latest = emptyScanState(); continue; }
      // scan_meta.mode describes the last source, not the global request.
      // Legacy global jobs have no reliable request mode; retain their per-source
      // recovery behavior instead of forcing one source's mode on all others.
      const requestedMode = readScanRequestedMode(db);
      latest = { ...emptyScanState(), attemptId: row.attempt_id ?? `${row.job_id}:legacy`,
        ...(row.phase === "failed" ? { completedAt: row.updated_at, error: row.error ?? "Agent source import failed" } : {}), jobId: row.job_id, sourceId: row.source_id, mode: requestedMode === undefined ? (row.source_id === "all" ? null : row.mode) : requestedMode,
        startedAt: row.attempt_started_at ?? row.created_at,
        progress: row.phase === "failed" ? null : { sourceId: row.source_id, phase: "stopped", current: 0, total: 0, message: "Interrupted scan is ready to resume" }
      };
    } catch (error) {
      logger.warn("scan.restore_failed", { file: name, ...memoryErrorFields(error) });
    } finally { db?.close(); }
  }
  return latest;
}
