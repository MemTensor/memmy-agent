import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { homedir } from "node:os";
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
  isCompleteTurn,
  orderedTurns,
  splitTurn,
  stableTurnIdentity,
  legacyTurnId,
  legacyTurnRequestId,
  type ScanStore
} from "@memmy/agent-source-core";
import { openMemoryAgentSourceScanStore, type MemoryAgentSourceScanStore } from "./scan-store.js";
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

const logger = createMemoryLogger("agent-source");
const INITIAL_SCAN_DELAY_MS = 5 * 60 * 1000;
const SCHEDULED_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_SCAN_MESSAGE_LIMIT = 1_000;
const COMPLETED_DETAILS_RETENTION_MS = 60 * 60 * 1000;

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
  running: boolean;
  jobId: string | null;
  sourceId: string | null;
  mode: "initial_subset" | "incremental" | "full" | null;
  progress: ScanProgress | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface AgentSourceExecutor {
  list(): Promise<{ executorAvailable: true; sources: AgentSourceView[] }>;
  startScan(input: unknown): Promise<{ accepted: true; jobId: string }>;
  scanStatus(): AgentSourceScanState;
  pauseScan(): Promise<{ ok: true }>;
  cancelScan(): Promise<{ ok: true }>;
  scanResults?(jobId: string, cursor?: string, limit?: number): Promise<{ items: Array<{ sourceId: string; conversationId: string; memoryId?: string; error?: string }>; nextCursor: string | null }>;
  mutateConnection(sourceId: string, kind: "plugin" | "skill", method: "POST" | "DELETE"): Promise<unknown>;
  startAutomation(): void;
  dispose(): void;
}

interface PersistedSourceState {
  status: AgentConnectionStatus;
  messageCount: number;
  lastScannedAt: string | null;
  latestSeenAt: string | null;
  contentHash?: string;
}

interface PersistedState {
  version: 2;
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
  let scan: AgentSourceScanState = emptyScanState();
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanAbortController: AbortController | undefined;
  let activeScanRequest: ReturnType<typeof normalizeScanInput> | undefined;
  let scanPaused = false;
  let progressBeforePause: ScanProgress | null = null;
  let resumePausedScan: (() => void) | undefined;
  let disposed = false;

  const readState = () => statePromise ??= loadState(statePath);
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
        lastScannedAt: stored?.lastScannedAt ?? null
      };
    }));
    return { executorAvailable: true, sources };
  }

  async function startScan(input: unknown): Promise<{ accepted: true; jobId: string }> {
    const request = normalizeScanInput(input);
    if (scan.running) throw new MemoryServiceError("conflict", "An Agent source scan is already running");
    if (scanPaused && scanAbortController && activeScanRequest && scan.jobId) {
      if (!sameScanRequest(activeScanRequest, request)) {
        throw new MemoryServiceError("conflict", "Resume or stop the paused Agent source scan first");
      }
      const jobId = scan.jobId;
      scanPaused = false;
      scan = {
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
      };
      resumePausedScan?.();
      resumePausedScan = undefined;
      logger.info("scan.resumed", { jobId, sourceId: request.sourceId });
      return { accepted: true, jobId };
    }
    if (scanPaused) {
      throw new MemoryServiceError("conflict", "Stop the paused Agent source scan before starting another scan");
    }
    const jobId = findReusableScanJob(scanStoreDirectory, request.sourceId, request.mode)
      ?? `agent-scan-${Date.now().toString(36)}`;
    scan = {
      running: true,
      jobId,
      sourceId: request.sourceId,
      mode: request.mode ?? null,
      progress: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null
    };
    activeScanRequest = request;
    progressBeforePause = null;
    const controller = new AbortController();
    scanAbortController = controller;
    void runScan(request, controller.signal, jobId).then(() => {
      if (scan.jobId !== jobId) return;
      scan = { ...scan, running: false, completedAt: new Date().toISOString() };
      logger.info("scan.completed", { jobId, sourceId: request.sourceId });
    }).catch((error) => {
      if (scan.jobId !== jobId || controller.signal.aborted) return;
      scan = {
        ...scan,
        running: false,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      logger.error("scan.failed", { jobId, sourceId: request.sourceId, ...memoryErrorFields(error) });
    }).finally(() => {
      if (scanAbortController === controller) {
        scanAbortController = undefined;
        activeScanRequest = undefined;
        scanPaused = false;
        progressBeforePause = null;
        resumePausedScan = undefined;
      }
    });
    logger.info("scan.started", { jobId, sourceId: request.sourceId, mode: request.mode });
    return { accepted: true, jobId };
  }

  async function runScan(
    request: ReturnType<typeof normalizeScanInput>,
    signal: AbortSignal,
    jobId: string
  ): Promise<void> {
    const failures: string[] = [];
    let failureCount = 0;
    const adapters = request.sourceId === "all"
      ? registry.list()
      : [registry.require(request.sourceId)];
    const state = await readState();
    let store: MemoryAgentSourceScanStore | undefined;
    let completed = false;
    const preparedContentHashes = new Map<string, string>();
    try {
      store = await openMemoryAgentSourceScanStore(join(scanStoreDirectory, `${jobId}.sqlite`), {
        jobId, sourceId: request.sourceId, mode: request.mode ?? "incremental", phase: "stage",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      const available: SourceAdapter[] = [];
      for (const adapter of adapters) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        if (await adapter.detect()) available.push(adapter);
        else if (request.sourceId !== "all") throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
      }
      const globalInitial = request.sourceId === "all" && available.length > 0 &&
        (request.mode === "initial_subset" || (request.mode === undefined && available.every((adapter) => !state.sources[adapter.descriptor.sourceId]?.lastScannedAt)));
      const stages: StandaloneSourceStage[] = [];
      for (const adapter of available) {
        const stored = state.sources[adapter.descriptor.sourceId] ?? emptySourceState();
        const mode = request.mode ?? (stored.lastScannedAt ? "incremental" : "initial_subset");
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "stage", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        stages.push(await stageStandaloneSource(adapter, stored, mode, store, signal, () => waitWhilePaused(signal), (progress) => {
          if (!scanPaused) { progressBeforePause = progress; scan = { ...scan, progress }; }
        }));
      }
      for (const stage of stages) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        const { sourceId, mode } = stage;
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "prepare", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        const sourceState = store.getSourceState(sourceId);
        store.saveSourceState({ ...(sourceState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: new Date().toISOString() }), phase: "prepare", updatedAt: new Date().toISOString() });
        preparedContentHashes.set(sourceId, await prepareStandaloneSource(store, sourceId, mode, stage.stored.latestSeenAt, stage.stored.contentHash));
      }
      if (globalInitial) store.selectInitialTurns(stages.map((stage) => stage.sourceId), INITIAL_SCAN_MESSAGE_LIMIT, 200);
      for (const stage of stages) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        const { adapter, stored, mode, sourceId, staged } = stage;
        if (mode === "initial_subset" && !globalInitial) store.selectInitialTurns([sourceId], INITIAL_SCAN_MESSAGE_LIMIT, 0);
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "ingest", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        const preparedState = store.getSourceState(sourceId);
        store.saveSourceState({ ...(preparedState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: new Date().toISOString() }), phase: "ingest", updatedAt: new Date().toISOString() });
        const result = await ingestStagedMessages(options.service, store, sourceId, signal, (progress) => {
          if (!scanPaused) { progressBeforePause = progress; scan = { ...scan, progress }; }
        }, options.scheduleWorker);
        const skillResult = await ingestAgentSkills(
          options.service,
          sourceId,
          store,
          options.resolveAgentSkillRoot,
          options.scheduleWorker
        );
        const sourceErrorCount = stage.scanErrorCount + result.errorCount + skillResult.errorCount;
        failureCount += sourceErrorCount;
        for (const detail of [...stage.errors, ...result.errors, ...skillResult.errors]) {
          if (failures.length >= 1000) break;
          failures.push(detail);
        }
        const now = new Date().toISOString();
        state.sources[sourceId] = {
          ...stored,
          messageCount: mode === "incremental"
            ? stored.messageCount + result.messageCount
            : result.messageCount,
          lastScannedAt: now,
          ...(stage.scanErrorCount === 0 && result.errorCount === 0 && skillResult.errorCount === 0 && preparedContentHashes.has(sourceId)
            ? { contentHash: preparedContentHashes.get(sourceId) }
            : stored.contentHash ? { contentHash: stored.contentHash } : {}),
          latestSeenAt: stage.scanErrorCount === 0 && result.errorCount === 0 && skillResult.errorCount === 0
            ? (result.latestSeenAt ?? stored.latestSeenAt)
            : stored.latestSeenAt
        };
        await persist(state);
        store.saveSourceState({
          sourceId,
          mode,
          phase: sourceErrorCount > 0 ? "failed" : "done",
          messageCount: result.messageCount,
          resultCount: store.resultCount(sourceId),
          errorCount: sourceErrorCount,
          updatedAt: now
        });
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "summarize", createdAt: store.getMeta()?.createdAt ?? now, updatedAt: now });
        scan = { ...scan, progress: { sourceId, phase: "done", current: staged, total: staged, message: `Imported ${result.written} memories and ${skillResult.written} skills` } };
      }
      store.saveMeta({ jobId, sourceId: request.sourceId, mode: request.mode ?? "incremental", phase: "done", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (failureCount > 0) {
        const meta = store.getMeta();
        if (meta) store.saveMeta({ ...meta, phase: "failed", updatedAt: new Date().toISOString(), error: failures.slice(0, 3).join("; ") });
      }
      completed = failureCount === 0 && store.resultCount() <= INITIAL_SCAN_MESSAGE_LIMIT;
    } catch (error) {
      if (store) {
        const meta = store.getMeta();
        if (meta) store.saveMeta({ ...meta, phase: "failed", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    } finally {
      if (store) {
        if (completed) store.remove();
        else store.close();
      }
    }
    if (failureCount > 0) {
      throw new Error(`Agent source scan completed with ${failureCount} import failure${failureCount === 1 ? "" : "s"}: ${failures.slice(0, 3).join("; ")}`);
    }
  }

  async function pauseScan(): Promise<{ ok: true }> {
    if (scanPaused) return { ok: true };
    if (!scan.running || !scanAbortController || !activeScanRequest) {
      throw new MemoryServiceError("conflict", "No Agent source scan is running");
    }
    progressBeforePause = scan.progress;
    scanPaused = true;
    scan = {
      ...scan,
      running: false,
      progress: {
        sourceId: scan.progress?.sourceId ?? activeScanRequest.sourceId,
        phase: "stopped",
        current: scan.progress?.current ?? 0,
        total: scan.progress?.total ?? 0,
        message: "Agent source scan paused"
      }
    };
    logger.info("scan.paused", { jobId: scan.jobId, sourceId: activeScanRequest.sourceId });
    return { ok: true };
  }

  async function cancelScan(): Promise<{ ok: true }> {
    const controller = scanAbortController;
    if (!controller && !scanPaused) return { ok: true };
    const jobId = scan.jobId;
    const sourceId = activeScanRequest?.sourceId;
    scanPaused = false;
    controller?.abort();
    if (jobId) {
      const path = join(scanStoreDirectory, `${jobId}.sqlite`);
      await Promise.all([
        rm(path, { force: true }),
        rm(`${path}-wal`, { force: true }),
        rm(`${path}-shm`, { force: true })
      ]);
    }
    resumePausedScan?.();
    resumePausedScan = undefined;
    scan = emptyScanState();
    activeScanRequest = undefined;
    progressBeforePause = null;
    logger.info("scan.canceled", { jobId, sourceId });
    return { ok: true };
  }

  async function scanResults(jobId: string, cursor = "0", limit = 100): Promise<{ items: Array<{ sourceId: string; conversationId: string; memoryId?: string; error?: string }>; nextCursor: string | null }> {
    const path = join(scanStoreDirectory, `${jobId}.sqlite`);
    if (!existsSync(path)) return { items: [], nextCursor: null };
    const store = await openMemoryAgentSourceScanStore(path, { jobId, sourceId: "all", mode: "incremental", phase: "ingest", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    let removeAfterRead = false;
    try {
      const safeLimit = Math.min(500, Math.max(1, limit));
      const safeCursor = Number.isFinite(Number(cursor)) && Number(cursor) >= 0 ? String(Math.floor(Number(cursor))) : "0";
      const rows = [...store.results(undefined, safeCursor, safeLimit)];
      const items = rows.map(({ cursor: _cursor, ...item }) => item);
      const nextCursor = rows.length < safeLimit ? null : rows.at(-1)?.cursor ?? null;
      removeAfterRead = nextCursor === null && store.getMeta()?.phase === "done";
      return { items, nextCursor };
    } finally {
      store.close();
      if (removeAfterRead) {
        await Promise.all([rm(path, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
      }
    }
  }

  async function waitWhilePaused(signal: AbortSignal): Promise<void> {
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
    method: "POST" | "DELETE"
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
    state.sources[sourceId] = {
      ...stored,
      status: method === "POST" ? connectionStatus(sourceId) : "not_connected"
    };
    await persist(state);
    logger.info(method === "POST" ? "connection.installed" : "connection.removed", { sourceId, kind });
    return { ok: true, sourceId, status: state.sources[sourceId].status };
  }

  function scheduleAutomation(delay: number, startup: boolean): void {
    if (disposed) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      void runAutomation(startup)
        .catch((error) => logger.warn("automation.failed", memoryErrorFields(error)))
        .finally(() => scheduleAutomation(
          options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
          false
        ));
    }, delay);
    scanTimer.unref?.();
  }

  async function runAutomation(startup: boolean): Promise<void> {
    if (disposed || scan.running) return;
    const config = loadMemmyConfig(configPath).config.agentAccess;
    if (config.autoInjectSkill) {
      const discovered = await list();
      for (const source of discovered.sources) {
        if (!source.available || source.status !== "not_connected") continue;
        try {
          await mutateConnection(source.sourceId, agentConnectionKind(source.sourceId), "POST");
        } catch (error) {
          logger.warn("connection.auto_install_failed", { sourceId: source.sourceId, ...memoryErrorFields(error) });
        }
      }
    }
    const enabled = startup ? config.autoScanKnownAgents : config.watchFileChanges;
    if (enabled) await startScan({ sourceId: "all" });
  }

  return {
    list,
    startScan,
    scanStatus: () => scan,
    pauseScan,
    cancelScan,
    scanResults,
    mutateConnection,
    startAutomation() {
      if (scanTimer || disposed) return;
      const config = loadMemmyConfig(configPath).config.agentAccess;
      scheduleAutomation(
        config.autoScanKnownAgents
          ? options.initialScanDelayMs ?? INITIAL_SCAN_DELAY_MS
          : options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
        config.autoScanKnownAgents
      );
    },
    dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = undefined;
      scanPaused = false;
      scanAbortController?.abort();
      resumePausedScan?.();
      resumePausedScan = undefined;
      scanAbortController = undefined;
    }
  };
}

function findReusableScanJob(directory: string, sourceId: string, mode?: string): string | null {
  if (!existsSync(directory)) return null;
  let selected: { jobId: string; updatedAt: number } | null = null;
  for (const name of readdirSync(directory).filter((value) => value.endsWith(".sqlite"))) {
    const path = join(directory, name);
    try {
      const db = new Database(path, { readonly: true });
      const row = db.prepare("SELECT job_id AS jobId, source_id AS sourceId, mode, phase, updated_at AS updatedAt FROM scan_meta WHERE id=1").get() as { jobId: string; sourceId: string; mode?: string; phase: string; updatedAt: string } | undefined;
      db.close();
      if (row?.phase === "done") {
        const updatedAt = Date.parse(row.updatedAt);
        if (Number.isFinite(updatedAt) && Date.now() - updatedAt > COMPLETED_DETAILS_RETENTION_MS) {
          rmSync(path, { force: true });
          rmSync(`${path}-wal`, { force: true });
          rmSync(`${path}-shm`, { force: true });
        }
        continue;
      }
      if (row && row.sourceId === sourceId && (!mode || !row.mode || row.mode === mode)) {
        const updatedAt = Date.parse(row.updatedAt);
        if (!selected || updatedAt > selected.updatedAt) selected = { jobId: row.jobId, updatedAt };
      }
    } catch { /* leave corrupt stores for explicit diagnostics */ }
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
  waitIfPaused: () => Promise<void>,
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
      fullHistory: true,
      signal,
      onProgress
    })) {
      await waitIfPaused();
      signal.throwIfAborted();
      const normalizedMessage = message.sourceId === sourceId ? message : { ...message, sourceId };
      const bytes = Buffer.byteLength(JSON.stringify(normalizedMessage));
      if (bytes > 64 * 1024 * 1024) {
        const reason = "record exceeds 64 MiB";
        scanErrorCount += 1;
        if (errors.length < 1000) errors.push(`${sourceId}:${message.conversationId}: ${reason}`);
        store.saveResult({ sourceId, conversationId: message.conversationId, error: reason });
        continue;
      }
      if (batch.length > 0 && (batch.length >= 500 || batchBytes + bytes > 8 * 1024 * 1024)) {
        staged += store.stageBatch(batch);
        const last = batch[batch.length - 1]!;
        store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
        batch.length = 0;
        batchBytes = 0;
      }
      batch.push({ ...normalizedMessage, ordinal: emittedOrdinal++ });
      batchBytes += bytes;
      if (batch.length >= 500 || batchBytes >= 8 * 1024 * 1024) {
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
  } catch (error) {
    if (signal.aborted) throw error;
    scanErrorCount += 1;
    const reason = error instanceof Error ? error.message : "Agent source scan failed";
    if (errors.length < 1000) errors.push(`${sourceId}: ${reason}`);
    store.saveResult({ sourceId, conversationId: "scan", error: reason });
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
  sourceId: string,
  signal: AbortSignal,
  onProgress: (progress: ScanProgress) => void,
  scheduleWorker?: () => void
): Promise<{ written: number; messageCount: number; errors: string[]; errorCount: number; latestSeenAt: string | null }> {
  let written = 0;
  let messageCount = 0;
  let processed = 0;
  let latestSeenAt: string | null = null;
  const errors: string[] = [];
  let errorCount = 0;
  let activeConversationId: string | null = null;
  let activeConversationFailed = false;
  const commitConversation = () => {
    if (!activeConversationId || activeConversationFailed) return;
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
        yield message;
      }
      const last = page[page.length - 1]!;
      cursor = { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 };
    }
  })();
  for await (const turn of orderedTurns(pages)) {
    signal.throwIfAborted();
    const turnLatest = turn.messages[turn.messages.length - 1]?.createdAt ?? null;
    if (turnLatest && (latestSeenAt === null || Date.parse(turnLatest) > Date.parse(latestSeenAt))) latestSeenAt = turnLatest;
    if (turn.conversationId !== activeConversationId) {
      commitConversation();
      activeConversationId = turn.conversationId;
      activeConversationFailed = false;
    }
    const conversationMeta = store.getConversationMeta(sourceId, turn.conversationId);
    if (conversationMeta?.selected === false) continue;
    const selectedTurn = store.getTurnMeta(sourceId, turn.conversationId, stableTurnIdentity(turn));
    if (selectedTurn && !selectedTurn.selected) continue;
    let succeeded = true;
    // Leave ample room for JSON escaping and the add-memory envelope while
    // keeping every request below the 1 MiB wire limit.
    const parts = splitTurn(turn, 4000, 512 * 1024);
    for (const part of parts) {
      const requestId = parts.length === 1
        ? legacyTurnRequestId(turn)
        : createHash("sha256").update([stableTurnIdentity(turn), String(part.partIndex), part.contentHash].join("\u0000")).digest("hex");
      const turnId = parts.length === 1 ? legacyTurnId(turn) : `${sourceId}:${part.parentTurnId}:${part.partIndex}`;
      try {
        const added = service.addMemory({
          requestId, adapterId: `agent-source:${sourceId}`, content: part.content, layer: "L1",
          title: titleForTurn(sourceId, part.messages), tags: ["agent-source", sourceId], source: sourceId,
          turnId, createdAt: part.messages[0]!.createdAt, deferProcessing: true
        });
        if (added.duplicate) store.saveResult({ sourceId, conversationId: turn.conversationId, memoryId: added.id });
        else { store.saveResult({ sourceId, conversationId: turn.conversationId, memoryId: added.id }); memoryIds.push(added.id); written += 1; }
      } catch (error) {
        succeeded = false;
        activeConversationFailed = true;
        const reason = error instanceof Error ? error.message : String(error);
        errorCount += 1;
        if (errors.length < 1000) errors.push(`${turn.conversationId}: ${reason}`);
        store.saveResult({ sourceId, conversationId: turn.conversationId, error: reason });
      }
    }
    if (succeeded) {
      messageCount += turn.messages.length;
      flush();
    }
    processed += turn.messages.length;
    onProgress({ sourceId, phase: "add", current: processed, total: store.count(sourceId), message: "Adding raw memories" });
  }
  flush(true);
  commitConversation();
  return { written, messageCount, errors, errorCount, latestSeenAt };
}

async function prepareStandaloneSource(
  store: MemoryAgentSourceScanStore,
  sourceId: string,
  mode: "initial_subset" | "incremental" | "full",
  latestSeenAt: string | null,
  previousContentHash?: string
): Promise<string> {
  let cursor: Parameters<ScanStore["messages"]>[1];
  let currentConversation: string | null = null;
  let currentTurn: ConversationMessage[] = [];
  let hash = createHash("sha256");
  let first = true;
  let latest: ConversationMessage | null = null;
  const sourceHash = createHash("sha256");
  sourceHash.update("[");
  let firstSourceMessage = true;
  const flushTurn = () => {
    if (!currentTurn.length || !isCompleteTurn(currentTurn)) return;
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
      selected: true
    });
  };
  const flushConversation = () => {
    if (!currentConversation || !latest) return;
    hash.update("]");
    const selected = mode !== "incremental" || !latestSeenAt || Date.parse(latest.createdAt) > Date.parse(latestSeenAt);
    store.saveConversationMeta({
      sourceId,
      conversationId: currentConversation,
      lastMessageId: latest.messageId,
      lastCreatedAt: latest.createdAt,
      contentHash: hash.digest("hex"),
      selected
    });
  };
  while (true) {
    const page = readScanPage(store, sourceId, cursor);
    if (page.length === 0) break;
    for (const message of page) {
      if (message.conversationId !== currentConversation) {
        flushTurn();
        flushConversation();
        currentConversation = message.conversationId;
        currentTurn = [];
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
      const hashable = {
        messageId: message.messageId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        toolName: hashMeta(message, "toolName") ?? hashMeta(message, "hermesToolName"),
        toolCallId: hashMeta(message, "toolCallId") ?? hashMeta(message, "hermesToolCallId")
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
  if (mode === "incremental" && previousContentHash !== contentHash) store.selectAllConversations(sourceId);
  return contentHash;
}

function hashMeta(message: ConversationMessage, key: string): string | undefined {
  const value = message.rawMeta[key];
  return typeof value === "string" ? value : undefined;
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
  resolveAgentSkillRoot: (sourceId: string) => string | null = agentRootDirectory,
  scheduleWorker?: () => void
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
  for await (const filePath of findSkillFiles(skillsRoot)) {
    const content = await readFile(filePath, "utf8");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const sourceSkillId = relative(skillsRoot, dirname(filePath)).replaceAll("\\", "/");
    const requestId = `agent-source-skill:${sourceId}:${sourceSkillId}:${contentHash}`;
    const fileStat = await stat(filePath);
    try {
      const added = service.addMemory({
        requestId,
        adapterId: `agent-source:${sourceId}`,
        content,
        layer: "Skill",
        title: frontmatterValue(content, "name") ?? sourceSkillId,
        tags: ["agent-source", "cross-agent-skill", sourceId],
        source: sourceId,
        turnId: `skill:${sourceSkillId}:${contentHash}`,
        createdAt: fileStat.mtime.toISOString(),
        sourceAgentId: sourceId,
        sourceSkillId,
        sourceSkillPath: filePath,
        sourceSkillVersion: frontmatterValue(content, "version") ?? contentHash,
        sourceContentHash: contentHash,
        deferProcessing: true
      });
      written += 1;
      memoryIdCount += 1;
      store.saveResult({ sourceId, conversationId: `skill:${sourceSkillId}`, memoryId: added.id });
      if (!added.duplicate) {
        pendingIds.push(added.id);
        flush();
      }
    } catch (error) {
      const reason = `skill ${sourceSkillId}: ${error instanceof Error ? error.message : String(error)}`;
      errorCount += 1;
      if (errors.length < 1000) errors.push(reason);
      store.saveResult({ sourceId, conversationId: `skill:${sourceSkillId}`, error: reason });
    }
  }
  flush(true);
  return { written, memoryIdCount, errorCount, errors };
}

async function* findSkillFiles(root: string): AsyncGenerator<string> {
  yield* visit(root, 0);

  async function* visit(directory: string, depth: number): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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

function titleForTurn(sourceId: string, messages: readonly ConversationMessage[]): string {
  const firstLine = messages[0]?.content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const title = firstLine || `${sourceId} conversation`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

function normalizeScanInput(value: unknown): {
  sourceId: string;
  mode?: "initial_subset" | "incremental" | "full";
} {
  const input = record(value);
  const sourceId = typeof input.sourceId === "string" && input.sourceId.trim() ? input.sourceId.trim() : "all";
  const mode = input.mode === "initial_subset" || input.mode === "incremental" || input.mode === "full"
    ? input.mode
    : undefined;
  return { sourceId, ...(mode ? { mode } : {}) };
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
        messageCount: typeof source.messageCount === "number" && Number.isFinite(source.messageCount) ? Math.max(0, Math.floor(source.messageCount)) : 0,
        lastScannedAt: typeof source.lastScannedAt === "string" ? source.lastScannedAt : null,
        latestSeenAt: typeof source.latestSeenAt === "string" ? source.latestSeenAt : null,
        ...(typeof source.contentHash === "string" ? { contentHash: source.contentHash } : {})
      } satisfies PersistedSourceState];
    }));
    const state: PersistedState = {
      version: 2,
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

async function writeState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
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
