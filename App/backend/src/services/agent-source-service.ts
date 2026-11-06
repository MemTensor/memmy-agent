import { createConnectionCompensation, type ConnectionAction, type ConnectionEvent } from "@memmy/agent-source-core";
/** Agent source service module. */
import { randomUUID } from "node:crypto";
import { memoryScanUnavailable } from "../adapters/outbound/memory-client/errors.js";
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH } from "@memmy/local-api-contracts";
import {
  setTimeout as waitForWorkerProgress
} from "node:timers/promises";
import type {
  AddManualInput,
  AgentSourceMemoryPluginConflict,
  AgentSourcePluginActionInput,
  AgentSourceStatus,
  AgentSourceView,
  ManagedAgentSourceImportInput,
  ManagedAgentSourceImportResult,
  ManagedAgentSourceUpdateInput,
  ScanPermission
} from "@memmy/local-api-contracts";
import type {
  ConversationMessage,
  ScanProgress
} from "@memmy/agent-source-readers/adapters/types";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { SourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import type { AgentSourceRepository, AgentSourceRecord } from "../infrastructure/agent-source-store/index.js";
import type { IngestionService } from "./ingestion-service.js";
import { AgentSourceUnavailableError } from "./runtime-errors.js";
import type { SkillInstallationState } from "../adapters/outbound/skill-writer/skill-directory.js";
import type { SkillDistributionService } from "./skill-distribution-service.js";
import {
  createAgentSourceLifecycleAnalytics,
  resolvePluginSourceKind,
  type AgentSourceInstallType,
  type AgentSourceLifecycleAnalytics,
} from "../analytics/agent-source-analytics.js";
import type {
  MemoryDesktopAddAnalytics
} from "../analytics/memory-add-analytics.js";
import { errorCodeFromUnknown } from "../analytics/analytics-transport.js";
import {
  extractManagedAgentHistory,
  selectIncrementalManagedMessages
} from "./managed-agent-history.js";
export type { ScanProgress } from "@memmy/agent-source-readers/adapters/types";

const SCAN_MESSAGE_YIELD_INTERVAL = 100;
const IMPORT_PROCESSING_COHORT_SIZE = 100;
// Allow a slow summary and its provider retries to finish without mistaking a
// quiet shared queue for completion. The producer never leases tasks itself.
const IMPORT_PROCESSING_TIMEOUT_MS = 2_400_000;
const IMPORT_PROGRESS_POLL_INTERVAL_MS = 250;
/** Contract for agent source service. */
export interface AgentSourceService {
  list(): Promise<AgentSourceView[]>;
  addManual(input: AddManualInput): Promise<AgentSourceView>;
  importManaged(sourceId: string, input: ManagedAgentSourceImportInput): Promise<ManagedAgentSourceImportResult>;
  syncManaged(sourceId: string): Promise<ManagedAgentSourceImportResult>;
  updateManaged(sourceId: string, input: ManagedAgentSourceUpdateInput): Promise<AgentSourceView>;
  remove(sourceId: string): Promise<void>;
  installSkill(sourceId: string, action?: Pick<AgentSourcePluginActionInput, "installType">, beforeInstall?: () => void | Promise<void>): Promise<void>;
  uninstallSkill(sourceId: string, action?: Pick<AgentSourcePluginActionInput, "installType">): Promise<void>;
  installPlugin(sourceId: string, action?: AgentSourcePluginActionInput, beforeInstall?: () => void | Promise<void>): Promise<void>;
  uninstallPlugin(sourceId: string, action?: AgentSourcePluginActionInput): Promise<void>;
  isAutomaticConnectionAllowed(sourceId: string): Promise<boolean>;
  isInstalledHookCurrent(sourceId: string): Promise<boolean>;
  detectMemoryPluginConflicts(): Promise<AgentSourceMemoryPluginConflict[]>;
}

export interface ProcessingFailure {
  memoryId: string;
  reason: string;
}

/** Contract for agent source scan options. */
export interface AgentSourceScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  progressSourceId?: string;
}

/** Contract for create agent source service options. */
export interface CreateAgentSourceServiceOptions {
  sourceRegistry: SourceRegistry;
  agentSourceRepository: AgentSourceRepository;
  ingestionService: IngestionService;
  memoryClient: Pick<MemoryClient, "addMemory" | "reconcileAgentSkills" | "completeSourceTurn" | "enqueueImportSummaries" | "getMemoryProcessingStatus" | "agentSources">;
  skillDistributionService: SkillDistributionService;
  agentSourceAnalytics?: AgentSourceLifecycleAnalytics;
  memoryAddAnalytics?: Pick<
    MemoryDesktopAddAnalytics,
    "trackAddStarted" | "trackAddSucceeded" | "trackAddFailed"
  >;
  getScanPermission?: () => Promise<ScanPermission>;
  now?: () => string;
  createId?: () => string;
}

/** Creates create agent source service. */
export function createAgentSourceService(options: CreateAgentSourceServiceOptions): AgentSourceService {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;
  const agentSourceAnalytics = options.agentSourceAnalytics ?? createAgentSourceLifecycleAnalytics();
  const compensation = createConnectionCompensation(async sourceId => (await options.memoryClient.agentSources?.connectionState(sourceId))?.connectionEvent);

  return {
    async list() {
      return await listSources(options);
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
      logProcessingFailures(sourceId, processingFailures);

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

    async isAutomaticConnectionAllowed(sourceId) {
      return automaticConnectionAllowed(options, sourceId);
    },

    async installSkill(sourceId, action = {}, beforeInstall) {
      const explicitAction = action.installType !== "auto_inject" ? await compensation.begin(sourceId, "connected", "skill") : undefined;
      let successful = false;
      try {
        const startedAt = Date.now();
        const installType = normalizePluginInstallType(action.installType);
        const statusBefore = readSourceStatus(options, sourceId);
        const permission = await readScanPermission(options);
        const builtin = readSourceBuiltin(options, sourceId);
        try {
          await ensureSourceAvailable(options, sourceId);
          const installationBefore = installType === "auto_inject"
            ? undefined
            : await options.skillDistributionService.readInstallationState?.(sourceId);
          if (installType === "auto_inject") {
            await installAutomatically(options, sourceId, "skill", compensation, beforeInstall);
          } else {
            await beforeInstall?.();
            await (beforeInstall ? options.skillDistributionService.install(sourceId, beforeInstall) : options.skillDistributionService.install(sourceId));
          }
          ensureSourceExists(options, sourceId);
          if (installType === "auto_inject") {
            options.agentSourceRepository.setConnectionState(sourceId, "skill_installed", false);
          } else {
            const event = await confirmAgentSkillConnection(options, sourceId, "skill", installationBefore);
            compensation.record(explicitAction, event);
            options.agentSourceRepository.setConnectionState(sourceId, "skill_installed", false);
          }
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
        successful = true;
      } finally { await compensation.settle(explicitAction, successful); }
    },

    async uninstallSkill(sourceId, action = {}) {
      if (action.installType === "auto_inject") return cleanupAutomaticInstallation(options, sourceId, "skill", compensation);
      const explicitAction = await compensation.begin(sourceId, "disconnected", "skill");
      let successful = false;
      try {
        const startedAt = Date.now();
        const statusBefore = readSourceStatus(options, sourceId);
        const permission = await readScanPermission(options);
        const builtin = readSourceBuiltin(options, sourceId);
        try {
          const event = await disconnectAgentSkillConnection(options, sourceId, "skill", compensation, explicitAction);
          compensation.record(explicitAction, event);
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
        successful = true;
      } finally { await compensation.settle(explicitAction, successful); }
    },

    async installPlugin(sourceId, action = {}, beforeInstall) {
      const explicitAction = action.installType !== "auto_inject" ? await compensation.begin(sourceId, "connected", "plugin") : undefined;
      let successful = false;
      try {
        const startedAt = Date.now();
        const installType = normalizePluginInstallType(action.installType);
        const statusBefore = readSourceStatus(options, sourceId);
        const permission = await readScanPermission(options);
        try {
          await ensureSourceAvailable(options, sourceId);
          const installationBefore = installType === "auto_inject"
            ? undefined
            : await options.skillDistributionService.readInstallationState?.(sourceId);
          if (installType === "auto_inject") {
            await installAutomatically(options, sourceId, "plugin", compensation, beforeInstall);
          } else {
            await beforeInstall?.();
            await (beforeInstall ? options.skillDistributionService.installPlugin(sourceId, beforeInstall) : options.skillDistributionService.installPlugin(sourceId));
          }
          ensureSourceExists(options, sourceId);
          if (installType === "auto_inject") {
            options.agentSourceRepository.setConnectionState(sourceId, "plugin_installed", false);
          } else {
            const event = await confirmAgentSkillConnection(options, sourceId, "plugin", installationBefore);
            compensation.record(explicitAction, event);
            options.agentSourceRepository.setConnectionState(sourceId, "plugin_installed", false);
          }
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
        successful = true;
      } finally { await compensation.settle(explicitAction, successful); }
    },

    async isInstalledHookCurrent(sourceId) {
      return options.skillDistributionService.isInstalledHookCurrent?.(sourceId) ?? true;
    },

    async uninstallPlugin(sourceId, action = {}) {
      if (action.installType === "auto_inject") return cleanupAutomaticInstallation(options, sourceId, "plugin", compensation);
      const explicitAction = await compensation.begin(sourceId, "disconnected", "plugin");
      let successful = false;
      try {
        const startedAt = Date.now();
        const installType = normalizePluginInstallType(action.installType);
        const statusBefore = readSourceStatus(options, sourceId);
        const permission = await readScanPermission(options);
        try {
          const event = await disconnectAgentSkillConnection(options, sourceId, "plugin", compensation, explicitAction);
          compensation.record(explicitAction, event);
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
        successful = true;
      } finally { await compensation.settle(explicitAction, successful); }
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

  const memorySources = options.memoryClient.agentSources
    ? await options.memoryClient.agentSources.list().then((result) => result.sources).catch((error: unknown) => {
      if (!memoryScanUnavailable(error)) throw error;
      // Discovery and managed sources remain available without a compatible scanner.
      // The separate scan status reports the reason; no second scan is started here.
      return [];
    })
    : [];
  const memoryById = new Map(memorySources.map((source) => [source.sourceId, source]));
  const supersededRemovals = new Set<string>();
  await Promise.all(builtinViews.map(async (source) => {
    if (source.status === "not_connected" || !options.agentSourceRepository.isAutoInjectSuppressed(source.sourceId)) return;
    const suppressedRevision = options.agentSourceRepository.getSuppressedRevision?.(source.sourceId) ?? null;
    if (typeof suppressedRevision !== "number" || !options.memoryClient.agentSources?.connectionState) return;
    const current = await options.memoryClient.agentSources.connectionState(source.sourceId).catch(() => undefined);
    if (isSuppressionSuperseded(suppressedRevision, current?.connectionEvent)) {
      supersededRemovals.add(source.sourceId);
    }
  }));
  return [
    ...builtinViews.map((source) => ({
      ...source,
      ...memoryById.get(source.sourceId),
      // A failed removal can already have deleted every detectable marker.
      // Keep the removal action until an explicit cleanup attempt completes
      // or a newer committed connection/disconnection supersedes it.
      ...(source.status !== "not_connected"
        && options.agentSourceRepository.isAutoInjectSuppressed(source.sourceId)
        && !supersededRemovals.has(source.sourceId)
        ? { status: resolvePluginSourceKind(source.sourceId) ? "plugin_installed" : "skill_installed" } as const
        : {}),
      syncBoundaryAt: memoryById.get(source.sourceId)?.syncBoundaryAt ?? options.agentSourceRepository.getScanWatermark(source.sourceId)?.baselineAt ?? null
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

function isSuppressionSuperseded(
  suppressedRevision: number | null | undefined,
  event: { revision?: number } | undefined
): boolean {
  return typeof suppressedRevision === "number"
    && typeof event?.revision === "number"
    && event.revision > suppressedRevision;
}

/** An unavailable authority is an error, never permission to write Agent files. */
async function automaticConnectionAllowed(options: CreateAgentSourceServiceOptions, sourceId: string): Promise<boolean> {
  const client = options.memoryClient.agentSources;
  if (!client?.connectionState) throw new Error("Memory connection authority is unavailable. Retry after Memory is updated or reachable.");
  const { connectionState, connectionEvent } = await client.connectionState(sourceId);
  if (connectionState === "disconnected") return false;
  if (!options.agentSourceRepository.isAutoInjectSuppressed(sourceId)) return true;
  if (connectionState !== "connected") return false;
  // A completed removal or an earlier failed removal is superseded once a
  // strictly newer explicit reconnect commits in Memory.
  if (readSourceStatus(options, sourceId) === "not_connected") return true;
  const suppressedRevision = options.agentSourceRepository.getSuppressedRevision?.(sourceId) ?? null;
  return isSuppressionSuperseded(suppressedRevision, connectionEvent);
}

async function installAutomatically(
  options: CreateAgentSourceServiceOptions, sourceId: string, kind: "skill" | "plugin",
  compensation: ReturnType<typeof createConnectionCompensation>, beforeInstall?: () => void | Promise<void>
): Promise<void> {
  await compensation.capture(sourceId);
  const guard = async () => {
    await beforeInstall?.();
    if (!(await automaticConnectionAllowed(options, sourceId))) throw new Error("Automatic integration blocked by disconnection or pending cleanup");
    await beforeInstall?.();
  };
  await guard();
  let attempted = false;
  let installError: unknown;
  try {
    const beforeWrite = async () => { await guard(); attempted = true; };
    if (kind === "plugin") await options.skillDistributionService.installPlugin(sourceId, beforeWrite);
    else await options.skillDistributionService.install(sourceId, beforeWrite);
  } catch (error) { installError = error; }
  if (attempted) {
    try { await guard(); } catch (authorizationError) {
      try { await cleanupAutomaticInstallation(options, sourceId, kind, compensation); }
      catch (cleanupError) { throw new AggregateError([installError, authorizationError, cleanupError].filter(Boolean), "Automatic integration could not be confirmed. Cleanup failed. Retry removal."); }
      throw new AggregateError([installError, authorizationError].filter(Boolean), "Automatic integration canceled; installed files removed.");
    }
  }
  if (installError) throw installError;
}

/** Rollback rechecks the user's latest action before and after every file operation. */
async function cleanupAutomaticInstallation(
  options: CreateAgentSourceServiceOptions, sourceId: string, kind: "skill" | "plugin",
  compensation: ReturnType<typeof createConnectionCompensation>
): Promise<void> {
  const baseline = await compensation.baseline(sourceId);
  ensureSourceExists(options, sourceId);
  const actionBeforeCleanup = compensation.currentAction(sourceId);
  const pendingLocalRemoval = options.agentSourceRepository.isAutoInjectSuppressed(sourceId)
    && readSourceStatus(options, sourceId) !== "not_connected";
  options.agentSourceRepository.setConnectionState(sourceId, kind === "plugin" ? "plugin_installed" : "skill_installed", true);
  options.agentSourceRepository.setSuppressedRevision?.(sourceId, baseline.event?.revision ?? 0);
  await compensation.compensate(sourceId, baseline, {
    remove: [() => kind === "plugin" ? options.skillDistributionService.uninstallPlugin(sourceId) : options.skillDistributionService.uninstall(sourceId)],
    install: desiredKind => desiredKind === "plugin" ? options.skillDistributionService.installPlugin(sourceId) : options.skillDistributionService.install(sourceId),
    commit: async decision => {
      // A newer local operation already saved its own success or retry state.
      if (compensation.currentAction(sourceId) !== actionBeforeCleanup && !decision.kind && !decision.event) return;
      if (decision.kind) options.agentSourceRepository.setConnectionState(sourceId, decision.kind === "plugin" ? "plugin_installed" : "skill_installed", false);
      else if (!pendingLocalRemoval || decision.event?.state === "disconnected") {
        options.agentSourceRepository.setConnectionState(sourceId, "not_connected", true);
        if (typeof decision.event?.revision === "number") {
          options.agentSourceRepository.setSuppressedRevision?.(sourceId, decision.event.revision);
        }
      }
    }
  });
}

async function disconnectAgentSkillConnection(
  options: CreateAgentSourceServiceOptions,
  sourceId: string,
  kind: "skill" | "plugin",
  compensation: ReturnType<typeof createConnectionCompensation>,
  action: ConnectionAction
): Promise<ConnectionEvent | undefined> {
  let connectionEvent: ConnectionEvent | undefined;
  let preparationError: Error | undefined;
  const startedRevision = action.startedEventKnown ? (action.startedEvent?.revision ?? 0) : null;
  try {
    ensureSourceExists(options, sourceId);
    const cleanupStatus = kind === "plugin" || resolvePluginSourceKind(sourceId) ? "plugin_installed" : "skill_installed";
    options.agentSourceRepository.setConnectionState(sourceId, cleanupStatus, true);
    options.agentSourceRepository.setSuppressedRevision?.(sourceId, startedRevision);
  } catch (error) {
    preparationError = error instanceof Error ? error : new Error(String(error));
  }
  try {
    connectionEvent = await notifyAgentSkillConnection(options, sourceId, "disconnected", kind);
    compensation.record(action, connectionEvent);
  } catch (error) {
    if (preparationError) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AggregateError([preparationError, error],
        `Agent disconnection could not be confirmed. Cleanup state could not be saved. Retry removal. ${preparationError.message} ${reason}`);
    }
    throw error;
  }
  if (preparationError) {
    throw new Error(`Skill sharing is stopped. Cleanup state could not be saved. Retry removal. ${preparationError.message}`,
      { cause: preparationError });
  }
  if (typeof connectionEvent?.revision === "number") {
    try {
      options.agentSourceRepository.setSuppressedRevision?.(sourceId, connectionEvent.revision);
    } catch {
      // Preparation already recorded the pre-disconnect watermark.
    }
  }
  let saving = false;
  try {
    await compensation.compensate(sourceId, compensation.after(action), {
      remove: [async () => {
        saving = false;
        if (kind === "plugin") await options.skillDistributionService.uninstallPlugin(sourceId);
        else await options.skillDistributionService.uninstall(sourceId);
      }],
      install: async desiredKind => {
        saving = false;
        if (desiredKind === "plugin") await options.skillDistributionService.installPlugin(sourceId);
        else await options.skillDistributionService.install(sourceId);
      },
      commit: async decision => {
        if (compensation.currentAction(sourceId) !== action && !decision.kind && !decision.event) return;
        saving = true;
        options.agentSourceRepository.setConnectionState(sourceId,
          decision.kind === "plugin" ? "plugin_installed" : decision.kind === "skill" ? "skill_installed" : "not_connected",
          !decision.kind);
        if (!decision.kind && typeof (decision.event?.revision ?? connectionEvent?.revision) === "number") {
          options.agentSourceRepository.setSuppressedRevision?.(
            sourceId,
            (decision.event?.revision ?? connectionEvent?.revision)!
          );
        }
        saving = false;
      }
    }, action);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(saving
      ? `Skill sharing is stopped. Cleanup state could not be saved. Retry removal. ${reason}`
      : `Skill sharing is stopped. Integration cleanup failed. Retry removal. ${reason}`, { cause: error });
  }
  return connectionEvent;
}

async function confirmAgentSkillConnection(
  options: CreateAgentSourceServiceOptions,
  sourceId: string,
  kind: "skill" | "plugin",
  before: SkillInstallationState | undefined
): Promise<ConnectionEvent | undefined> {
  try {
    return await notifyAgentSkillConnection(options, sourceId, "connected", kind);
  } catch (error) {
    if (before && !before.skillInstalled && before.pluginInstalled === false) {
      try {
        await notifyAgentSkillConnection(options, sourceId, "disconnected", kind);
      } catch (compensationError) {
        const retainedStatus = kind === "plugin" || resolvePluginSourceKind(sourceId) ? "plugin_installed" : "skill_installed";
        options.agentSourceRepository.setStatus(sourceId, retainedStatus);
        throw new AggregateError([error, compensationError],
          "Agent connection result is uncertain. Integration retained so disconnection can be retried.");
      }
    }
    if (before) await options.skillDistributionService.rollbackInstallation?.(sourceId, kind, before);
    throw error;
  }
}

/** Keep explicit connection actions visible to the Memory service. */
async function notifyAgentSkillConnection(
  options: CreateAgentSourceServiceOptions,
  sourceId: string,
  connectionState: "connected" | "disconnected",
  connectionKind: "skill" | "plugin"
): Promise<ConnectionEvent | undefined> {
  // A failed notification fails the action so an explicit retry can deliver it.
  const result = await options.memoryClient.reconcileAgentSkills({
    sourceAgentId: sourceId,
    complete: false,
    connectionState,
    connectionKind,
    disconnected: connectionState === "disconnected",
    skills: []
  });
  return result?.connectionEvent;
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
      const previousPending = pendingMemoryIds.size;
      await reconcileImportProcessing(options.memoryClient, pendingMemoryIds, failures);
      scanOptions.signal?.throwIfAborted();
      if (pendingMemoryIds.size < previousPending) lastProgressAt = Date.now();
      emitProgress(scanOptions, {
        sourceId: progressSourceId,
        phase: "summarize",
        current: completedMemoryCount + cohort.length - pendingMemoryIds.size,
        total: ownedMemoryIds.length,
        message: "Summarizing and indexing latest memories"
      });
      if (pendingMemoryIds.size === 0) break;
      if (Date.now() - lastProgressAt >= IMPORT_PROCESSING_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for ${pendingMemoryIds.size} imported memories to finish indexing`);
      }
      // enqueueImportSummaries wakes the shared scheduler, including existing
      // pending jobs. Observe durable target state rather than starting a drain.
      await waitForWorkerProgress(IMPORT_PROGRESS_POLL_INTERVAL_MS, undefined, { signal: scanOptions.signal });
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

function logProcessingFailures(sourceId: string, failures: readonly ProcessingFailure[]): void {
  for (const failure of failures) {
    logScanItemSkip(sourceId, failure.memoryId, failure.reason);
  }
}

function logScanItemSkip(sourceId: string, conversationId: string, reason: string): void {
  console.warn(`[agent-source] scan.item_skipped ${JSON.stringify({ sourceId, conversationId, reason })}`);
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
