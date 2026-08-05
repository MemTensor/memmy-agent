import {
  skillMetaFromMemory,
  traceMetaFromMemory
} from "../algorithm/plugin-algorithms.js";
import { PROJECT_VERSION } from "../cli/project-version.js";
import {
  DEFAULT_MEMMY_CONFIG,
  loadMemmyConfig,
  resolveEvolutionConfig,
  type MemmyConfig
} from "../config/index.js";
import { createMemoryLogger } from "../logging/logger.js";
import { resolveMemoryAgentRegion } from "../model/agent-region.js";
import { createEmbedder } from "../model/embedder.js";
import { createLlmClient } from "../model/llm.js";
import type { MemoryLlmModelRole } from "../model/token-usage.js";
import type { Embedder,LlmClient } from "../model/types.js";
import {
  sqliteBackendCapabilities,
  type StorageBackend,
  type StorageBackendCapabilities
} from "../storage/backend.js";
import type { MemoryDb } from "../storage/db.js";
import {
  Repositories,
  jobToRef,
  kindFromMemory,
  type ChangeLogRecord,
  type EpisodeRecord,
  type EvolutionJobRecord,
  type RawTurnRecord,
  type SessionRecord
} from "../storage/repositories.js";
import type { SerializedMemoryVector } from "../storage/sqlite-vec-store.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../types.js";
import type {
  FeedbackRequest,
  HealthResponse,
  InjectedContext,
  JobRef,
  MemoryAddRequest,
  MemoryDetailItem,
  MemoryExportRequest,
  MemoryGovernanceRequest,
  MemoryImportRequest,
  MemoryMarkdownExportRequest,
  MemoryMarkdownImportRequest,
  MemoryKind,
  MemoryLayer,
  MemoryListItem,
  MemoryProvenance,
  MemoryProcessingRecord,
  MemoryReloadConfigRequest,
  MemoryReloadConfigResponse,
  MemoryRow,
  MemorySearchRequest,
  RawTurnRedactRequest,
  RecallHit,
  RepairSuggestionRequest,
  RequestEnvelope,
  RetrievalMode,
  RuntimeNamespace,
  SessionCheckpointPayload,
  SessionCheckpointRequest,
  SessionCompactRequest,
  SessionOpenRequest,
  SkillUseRequest,
  SubagentCompleteRequest,
  SubagentStartRequest,
  ToolCallPayload,
  ToolObserveRequest,
  TurnCompleteRequest,
  TurnStartRequest
} from "../types.js";
import { MemoryServiceError } from "../utils/error.js";
import { newId,stableHash,stableStringify } from "../utils/id.js";
import { isRecord,stringifyForMemory } from "../utils/json.js";
import { clip,firstLine } from "../utils/text.js";
import { nowIso } from "../utils/time.js";
import {
  EmbeddingJobProcessor
} from "./embedding/embedding-job-processor.js";
import { EvolutionJobProcessor } from "./evolution/evolution-job-processor.js";
import { traceReflectionWasScored,traceSortKey } from "./evolution/span-pipeline.js";
import {
  FeedbackExperienceService,
  polarityFromTurnFeedback,
  synthesizeDecisionRepairDraft,
  type FeedbackResponse
} from "./feedback/feedback-experience.js";
import {
  ImportJobProcessor,
  memoryHasImportPipeline
} from "./import/import-job-processor.js";
import {
  isAgentSourceImportMemoryAdd,
  memoryAddImportTrace,
  memoryAddKey,
  memoryAddTags,
  normalizeMemoryAddCreatedAt,
  titleFromImportTrace,
  toolCallsFromUnknown
} from "./import/memory-import-pipeline.js";
import { recordApiLog } from "./model-audit/model-call-audit.js";
import {
  parseMemoryMarkdownBundle,
  renderMemoryMarkdownBundle
} from "./governance/markdown-audit.js";
import {
  hasProjectScope,
  namespaceIdFromContext as canonicalNamespaceIdFromContext,
  namespaceForMemory,
  namespaceForRawTurn,
  namespaceForSession,
  memoryFilterForNamespace,
  normalizeNamespace,
  projectIdFromMemory,
  sameProjectScope,
  tenantIdFromSession
} from "./namespace/namespace-scope.js";
import {
  EpisodeReadModel,
  episodeRef,
  type MemoryGetResponse
} from "./read-model/episode.js";
import {
  detailFromMemory,
  memoryDetailWithLayerPayload,
  memoryEtag,
  procedureFromSkillMemory
} from "./read-model/memory.js";
import { PanelReadModel } from "./read-model/panel-read.js";
import {
  SkillReadModel
} from "./read-model/skill.js";
import {
  RetrievalService,
  memoryLayersForIntent,
  memoryMatchesTags,
  readableMemoryIdKind,
  retrievedMemorySourceIds
} from "./retrieval/retrieval-service.js";
import {
  SessionTurnService,
  rawTurnSummary as sessionRawTurnSummary,
  repairEvidenceValueDiff as sessionRepairEvidenceValueDiff
} from "./session/session-turn-service.js";
import { SkillTrialResolver } from "./trials/skill-trial-resolver.js";
import {
  buildSearchQuery,
  sanitizeMemoryAddRequest,
  turnStartContextHints
} from "./turn/turn-normalization.js";
import {
  createWorkerJobHandlers,
  type ClosedEpisodeTrigger,
  type EnqueueJobInput
} from "./worker/job-handlers.js";
import { WorkerRunner } from "./worker/worker-runner.js";

const serviceLogger = createMemoryLogger("memory-service");

export type { FeedbackResponse } from "./feedback/feedback-experience.js";


function evolutionUsesSharedLlm(config: MemmyConfig): boolean {
  const evolution = config.evolution;
  return !evolution.provider && !evolution.model && !evolution.endpoint && !evolution.apiKey;
}

function createConfiguredMemoryLlm(config: MemmyConfig, modelRole: MemoryLlmModelRole): LlmClient {
  return createLlmClient(
    modelRole === "memory_summary" ? config.summary : resolveEvolutionConfig(config),
    {
      modelRole,
      agentRegion: resolveMemoryAgentRegion(config.activeProfile)
    }
  );
}

export interface MemoryServiceOptions {
  db?: MemoryDb;
  backend?: StorageBackend;
  mode?: "local" | "cloud" | "dev";
  configPath?: string;
  configLoader?: (configPath?: string) => {
    config: MemmyConfig;
    path?: string;
  };
  config?: MemmyConfig;
  llm?: LlmClient;
  skillLlm?: LlmClient;
  embedder?: Embedder;
}

export interface CompleteTurnResponse {
  turnId: string;
  sessionId: string;
  episodeId: string;
  rawTurnId: string;
  l1MemoryId: string;
  l1MemoryIds: string[];
  closedEpisodeIds: string[];
  scheduledEvolution: boolean;
  jobs: JobRef[];
  changeSeq: number;
  syncCursor: string;
  etag: string;
  serverTime: string;
  duplicate?: boolean;
}
type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;

interface DecisionRepairSummary {
  repairId?: string;
  contextHash?: string;
  skipped?: boolean;
  reason?: string;
  attachedPolicyIds?: string[];
}

type InternalMemorySearchRequest = MemorySearchRequest & {
  episodeId?: string;
  turnId?: string;
  tags?: string[];
  limit?: number;
  contextBudget?: number;
  includeInjectedContext?: boolean;
  retrievalMode?: RetrievalMode;
  targetSkillId?: string;
  contextHints?: Record<string, unknown>;
  injectedContextQuery?: string;
  recordEvent?: boolean;
};

function requireMemoryDb(options: MemoryServiceOptions): MemoryDb {
  if (!options.db) {
    throw new Error("MemoryService requires either db or backend");
  }
  return options.db;
}

export class MemoryService {
  private readonly embeddingJobs: EmbeddingJobProcessor;
  private readonly evolutionJobs: EvolutionJobProcessor;
  private readonly feedbackExperience: FeedbackExperienceService;
  private readonly skillTrials: SkillTrialResolver;
  private readonly episodeReadModel: EpisodeReadModel;
  private readonly importJobs: ImportJobProcessor;
  private readonly panelReadModel: PanelReadModel;
  private readonly retrieval: RetrievalService;
  private readonly sessionTurns: SessionTurnService;
  private readonly skillReadModel: SkillReadModel;
  private readonly workerHandlers: ReturnType<typeof createWorkerJobHandlers>;
  private readonly workerRunner: WorkerRunner;
  private readonly repos: Repositories;
  private readonly startedAt = Date.now();
  private readonly mode: "local" | "cloud" | "dev";
  private config: MemmyConfig;
  private llm: LlmClient;
  private skillLlm: LlmClient;
  private embedder: Embedder;
  private readonly embeddingRetryWorkerId = `embedding-retry-${newId("worker")}`;

  constructor(private readonly options: MemoryServiceOptions) {
    this.repos = options.backend?.repositories() ?? new Repositories(requireMemoryDb(options).db);
    this.mode = options.mode ?? "local";
    this.config = cloneMemmyConfig(options.config ?? DEFAULT_MEMMY_CONFIG);
    this.llm = options.llm ?? createConfiguredMemoryLlm(this.config, "memory_summary");
    this.skillLlm = options.skillLlm ??
      (options.llm && evolutionUsesSharedLlm(this.config)
        ? options.llm
        : createConfiguredMemoryLlm(this.config, "memory_evolution"));
    this.embedder = options.embedder ?? createEmbedder(this.config.embedding);
    const workerHandlerOwner = this;
    this.workerHandlers = createWorkerJobHandlers({
      repos: this.repos,
      get capture() { return workerHandlerOwner.config.algorithm.capture; },
      get reward() { return workerHandlerOwner.config.algorithm.reward; },
      nowIso,
      requireSession: this.requireSession.bind(this),
      feedbackTargetFromEpisode: (episode) => this.feedbackExperience.feedbackTargetFromEpisode(episode),
      traceReflectionWasScored,
      traceSortKey,
      processors: {
        import: {
          summarizeCapturedTrace: this.summarizeCapturedTrace.bind(this),
          summarizeImportedTrace: this.summarizeImportedTrace.bind(this)
        },
        evolution: {
          induceL2: (job) => this.evolutionJobs.induceL2(job),
          materializeNegativeExperience: (job) => this.evolutionJobs.materializeNegativeExperience(job),
          abstractL3: (job) => this.evolutionJobs.abstractL3(job),
          crystallizeSkill: (job) => this.evolutionJobs.crystallizeSkill(job),
          associateL2: (job) => this.evolutionJobs.associateL2(job),
          splitBigTurn: (job) => this.evolutionJobs.splitBigTurn(job)
        },
        feedback: {
          applyReward: (job) => this.evolutionJobs.applyReward(job),
          reflectTrace: (job) => this.evolutionJobs.reflectTrace(job),
          resolveSkillTrial: (job) => this.skillTrials.resolveSkillTrial(job)
        },
        embedding: {
          embedMemory: this.embedMemory.bind(this)
        }
      }
    });
    const evolutionOwner = this;
    this.evolutionJobs = new EvolutionJobProcessor({
      repos: this.repos,
      get config() { return evolutionOwner.config; },
      get llm() { return evolutionOwner.llm; },
      get skillLlm() { return evolutionOwner.skillLlm; },
      traceMeta: this.traceMeta.bind(this),
      namespaceIdFromMemory,
      buildMemory: (input) => this.buildMemory(input as Parameters<MemoryService["buildMemory"]>[0]),
      enqueueJob: this.workerHandlers.enqueueJob,
      enqueueEpisodeRewardAfterReflection: this.workerHandlers.enqueueEpisodeRewardAfterReflection,
      finalizeClosedEpisode: this.workerHandlers.finalizeClosedEpisode,
      resolvePendingSkillTrialsForReward: (input) => this.skillTrials.resolvePendingSkillTrialsForReward(input),
      decisionRepairTraceSources: (memories) => this.feedbackExperience.decisionRepairTraceSources(memories),
      synthesizeDecisionRepairDraft: (input) => synthesizeDecisionRepairDraft(input, {
        useLlm: this.config.algorithm.feedback.useLlm,
        llm: this.skillLlm
      }),
      scheduleEmbeddingAfterTextUpdate: (input) => this.embeddingJobs.scheduleEmbeddingAfterTextUpdate(input),
      repairEvidenceValueDiff: sessionRepairEvidenceValueDiff
    });
    const trialOwner = this;
    this.skillTrials = new SkillTrialResolver({
      repos: this.repos,
      get config() { return trialOwner.config; },
      requireRawTurn: this.requireRawTurn.bind(this),
      assertRawTurnInScope: this.assertRawTurnInScope.bind(this),
      requireExistingMemory: this.requireExistingMemory.bind(this),
      assertMemoryInScope: this.assertMemoryInScope.bind(this),
      traceMeta: this.traceMeta.bind(this),
      feedbackTargetFromRawTurn: (rawTurn) => this.feedbackExperience.feedbackTargetFromRawTurn(rawTurn)
    });
    const feedbackOwner = this;
    this.feedbackExperience = new FeedbackExperienceService({
      repos: this.repos,
      get config() { return feedbackOwner.config; },
      get skillLlm() { return feedbackOwner.skillLlm; },
      get embedder() { return feedbackOwner.embedder; },
      memoryAddEnabled: this.memoryAddEnabled.bind(this),
      resolveContext: this.resolveContext.bind(this),
      assertSessionInScope: this.assertSessionInScope.bind(this),
      assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
      assertRawTurnInScope: this.assertRawTurnInScope.bind(this),
      assertMemoryInScope: this.assertMemoryInScope.bind(this),
      requireEpisode: this.requireEpisode.bind(this),
      requireRawTurn: this.requireRawTurn.bind(this),
      requireExistingMemory: this.requireExistingMemory.bind(this),
      traceMeta: this.traceMeta.bind(this),
      buildMemory: (input) => this.buildMemory(input as Parameters<MemoryService["buildMemory"]>[0]),
      enqueueJob: this.workerHandlers.enqueueJob,
      encodeChangeCursor: this.encodeChangeCursor.bind(this),
      readOnlyCursor: this.readOnlyCursor.bind(this),
      findExistingSkillForPolicy: this.evolutionJobs.findExistingSkillForPolicy.bind(this.evolutionJobs),
      upsertEvolutionMemory: this.evolutionJobs.upsertEvolutionMemory.bind(this.evolutionJobs),
      pendingTrialsForFeedback: this.skillTrials.pendingTrialsForFeedback.bind(this.skillTrials)
    });
    const importJobOwner = this;
    this.importJobs = new ImportJobProcessor({
      get config() { return importJobOwner.config; },
      nowIso,
      transaction: this.repos.transaction.bind(this.repos),
      createError: (code, message) => new MemoryServiceError(code, message),
      assertMemoryAddEnabled: this.assertMemoryAddEnabled.bind(this),
      assertMemoryInScope: this.assertMemoryInScope.bind(this),
      sanitizeMemoryAddRequest,
      resolveContext: this.resolveContext.bind(this),
      requireSession: this.requireSession.bind(this),
      assertSessionInScope: this.assertSessionInScope.bind(this),
      normalizeMemoryAddCreatedAt,
      memoryAddImportTrace,
      isAgentSourceImportMemoryAdd,
      titleFromImportTrace,
      memoryAddTags,
      memoryAddKey,
      toolCallsFromUnknown,
      renderTraceMemoryValue,
      buildMemory: (input) => this.buildMemory(input as Parameters<MemoryService["buildMemory"]>[0]),
      kindFromMemory,
      namespaceIdFromMemory,
      enqueueJob: this.enqueueJob.bind(this),
      jobToRef,
      recordApiLog: (operation, request, result, latencyMs, success, at, agentId) =>
        recordApiLog(this.repos.runtime, operation, request, result, latencyMs, success, at, agentId),
      memories: this.repos.memories,
      processing: this.repos.processing,
      runtime: this.repos.runtime
    });
    const embeddingJobOwner = this;
    this.embeddingJobs = new EmbeddingJobProcessor({
      repos: this.repos,
      get embedder() { return embeddingJobOwner.embedder; },
      get llm() { return embeddingJobOwner.llm; },
      get capture() { return embeddingJobOwner.config.algorithm.capture; },
      nowIso,
      enqueueJob: this.enqueueJob.bind(this),
      enqueueImportSummaryIfMissing: this.workerHandlers.enqueueImportSummaryIfMissing,
      enqueueEmbeddingRetry: this.workerHandlers.enqueueEmbeddingRetry,
      appendEmbeddingRetryChange: this.workerHandlers.appendEmbeddingRetryChange,
      summarizeTraceForCapture: this.evolutionJobs.summarizeTraceForCapture.bind(this.evolutionJobs)
    });
    const workerRunnerOwner = this;
    this.workerRunner = new WorkerRunner({
      repos: this.repos,
      get embedder() { return workerRunnerOwner.embedder; },
      get capture() { return workerRunnerOwner.config.algorithm.capture; },
      embeddingRetryWorkerId: this.embeddingRetryWorkerId,
      memoryAddEnabled: this.memoryAddEnabled.bind(this),
      nowIso,
      encodeChangeCursor: this.encodeChangeCursor.bind(this),
      namespaceIdFromMemory,
      runWorkerNoWrite: this.runWorkerNoWrite.bind(this),
      restartFailedProcessing: this.restartFailedProcessing.bind(this),
      enqueueJob: this.workerHandlers.enqueueJob,
      enqueueEmbeddingRetry: this.workerHandlers.enqueueEmbeddingRetry,
      appendJobChange: this.workerHandlers.appendJobChange,
      appendEmbeddingRetryChange: this.workerHandlers.appendEmbeddingRetryChange,
      jobHandlers: this.workerHandlers,
      embeddingJobs: this.embeddingJobs
    });
    this.episodeReadModel = new EpisodeReadModel({
      repos: this.repos,
      assertMemorySearchEnabled: this.assertMemorySearchEnabled.bind(this),
      resolveContext: this.resolveContext.bind(this),
      requireSession: this.requireSession.bind(this),
      requireEpisode: this.requireEpisode.bind(this),
      assertSessionInScope: this.assertSessionInScope.bind(this),
      assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
      assertMemoryInScope: this.assertMemoryInScope.bind(this),
      namespaceForSession,
      readableMemoryIdKind,
      invalidArgument: (message) => new MemoryServiceError("invalid_argument", message),
      notFound: (message) => new MemoryServiceError("not_found", message),
      memoryMatchesTags,
      rawTurnSummary: sessionRawTurnSummary,
      rawTurnIdFromMemory,
      episodeIdFromMemory: (memory) => traceMetaFromMemory(memory)?.episodeId,
      traceSortKey,
      detailFromMemory,
      memoryDetailWithLayerPayload,
      memoryEtag,
      stableHash,
      nowIso
    });
    this.skillReadModel = new SkillReadModel({
      repositories: this.repos,
      assertMemorySearchEnabled: this.assertMemorySearchEnabled.bind(this),
      assertMemoryAddEnabled: this.assertMemoryAddEnabled.bind(this),
      assertMemoryInScope: this.assertMemoryInScope.bind(this),
      assertSessionInScope: this.assertSessionInScope.bind(this),
      requireOpenSession: this.requireOpenSession.bind(this),
      ensureEpisode: this.ensureEpisode.bind(this),
      resolveSkillTrialEvidence: this.skillTrials.resolveSkillTrialEvidence.bind(this.skillTrials),
      encodeChangeCursor: this.encodeChangeCursor.bind(this),
      skillMetaFromMemory,
      detailFromMemory,
      procedureFromSkillMemory,
      namespaceForSession,
      namespaceForMemory,
      nowIso,
      newId,
      stableHash,
      createError: (code, message) => new MemoryServiceError(code, message)
    });
    const panelReadOwner = this;
    this.panelReadModel = new PanelReadModel({
      repos: this.repos,
      config: () => panelReadOwner.config,
      storageCapabilities: this.storageCapabilities.bind(this),
      schemaVersion: this.schemaVersion.bind(this),
      health: this.health.bind(this),
      models: () => ({
        summary: panelReadOwner.llm.status(),
        evolution: panelReadOwner.skillLlm.status(),
        embedding: panelReadOwner.embedder.status()
      }),
      resolveContext: this.resolveContext.bind(this),
      encodeChangeCursor: this.encodeChangeCursor.bind(this),
      decodeChangeCursor: this.decodeChangeCursor.bind(this),
      episodeRef,
      rawTurnSummary: sessionRawTurnSummary,
      now: nowIso
    });
    const retrievalOwner = this;
    this.retrieval = new RetrievalService({
      repos: this.repos,
      get config() { return retrievalOwner.config; },
      get llm() { return retrievalOwner.llm; },
      get skillLlm() { return retrievalOwner.skillLlm; },
      get embedder() { return retrievalOwner.embedder; },
      assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
      assertMemorySearchEnabled: this.assertMemorySearchEnabled.bind(this),
      memoryAddEnabled: this.memoryAddEnabled.bind(this),
      memorySearchEnabled: this.memorySearchEnabled.bind(this),
      queryRewriteEnabled: this.queryRewriteEnabled.bind(this),
      requireEpisode: this.requireEpisode.bind(this),
      resolveContext: this.resolveContext.bind(this),
      turnStartRetrievalLimit: this.turnStartRetrievalLimit.bind(this),
      memoryHasImportPipeline,
      namespaceIdFromContext,
      withTimeout
    });
    const sessionTurnOwner = this;
    this.sessionTurns = new SessionTurnService({
      repos: this.repos,
      get config() { return sessionTurnOwner.config; },
      get llm() { return sessionTurnOwner.llm; },
      get skillLlm() { return sessionTurnOwner.skillLlm; },
      assertEpisodeInScope: this.assertEpisodeInScope.bind(this),
      assertMemoryAddEnabled: this.assertMemoryAddEnabled.bind(this),
      assertRawTurnInScope: this.assertRawTurnInScope.bind(this),
      assertSessionInScope: this.assertSessionInScope.bind(this),
      buildMemory: this.buildMemory.bind(this),
      closeSessionNoWrite: this.closeSessionNoWrite.bind(this),
      completeTurnNoWrite: this.completeTurnNoWrite.bind(this),
      decisionRepairTraceSources: this.feedbackExperience.decisionRepairTraceSources.bind(this.feedbackExperience),
      encodeChangeCursor: this.encodeChangeCursor.bind(this),
      enqueueJob: this.enqueueJob.bind(this),
      feedbackTargetFromEpisode: this.feedbackExperience.feedbackTargetFromEpisode.bind(this.feedbackExperience),
      finalizeClosedEpisode: this.finalizeClosedEpisode.bind(this),
      isMemoryReadyForRetrieval: this.isMemoryReadyForRetrieval.bind(this),
      maybeCreateDecisionRepair: this.feedbackExperience.maybeCreateDecisionRepair.bind(this.feedbackExperience),
      memoryAddEnabled: this.memoryAddEnabled.bind(this),
      memorySearchEnabled: this.memorySearchEnabled.bind(this),
      observeToolNoWrite: this.observeToolNoWrite.bind(this),
      openSessionNoWrite: this.openSessionNoWrite.bind(this),
      pendingTrialsForFeedback: this.skillTrials.pendingTrialsForFeedback.bind(this.skillTrials),
      queryVector: this.queryVector.bind(this),
      requireEpisode: this.requireEpisode.bind(this),
      requireOpenSession: this.requireOpenSession.bind(this),
      requireSession: this.requireSession.bind(this),
      retrievalTuningConfig: this.retrievalTuningConfig.bind(this),
      search: this.search.bind(this),
      startTurnNoWrite: this.startTurnNoWrite.bind(this),
      subagentStartNoWrite: this.subagentStartNoWrite.bind(this),
      traceMeta: this.traceMeta.bind(this),
      turnStartRetrievalLimit: this.turnStartRetrievalLimit.bind(this),
      synthesizeDecisionRepairDraft: (input) => synthesizeDecisionRepairDraft(input, {
        useLlm: this.config.algorithm.feedback.useLlm,
        llm: this.skillLlm
      }),
      firstLine,
      memoryLayersForIntent,
      namespaceIdFromContext,
      namespaceIdFromMemory,
      namespaceIdFromSession,
      normalizeRequestTags,
      polarityFromTurnFeedback,
      rawTurnIdFromMemory,
      renderTraceMemoryValue,
      retrievedMemorySourceIds,
      sanitizeTraceToolCalls,
      stringFromMeta,
      stringifyForMemory,
      withDuplicateFlag
    });
    serviceLogger.info("initialized", memoryConfigLogFields(this.config));
  }

  private memoryAddEnabled(): boolean {
    return this.config.algorithm.enableMemoryAdd;
  }

  private memorySearchEnabled(): boolean {
    return this.config.algorithm.enableMemorySearch;
  }

  private queryRewriteEnabled(): boolean {
    return this.config.algorithm.enableQueryRewrite;
  }

  private turnStartRetrievalLimit(): number {
    const retrieval = this.config.algorithm.retrieval;
    return Math.max(1, retrieval.tier1TopK + retrieval.tier2TopK + retrieval.tier3TopK);
  }

  health(routes: string[] = []): HealthResponse {
    const schema = this.schemaVersion();
    const backend = this.storageCapabilities();
    return {
      ok: true,
      version: PROJECT_VERSION,
      uptimeMs: Date.now() - this.startedAt,
      mode: this.mode,
      activeProfile: this.config.activeProfile,
      storage: {
        ...backend,
        schemaVersion: String(schema.version),
        ready: schema.version > 0,
        lastMigrationId: schema.lastMigrationId
      },
      models: {
        summary: this.llm.status(),
        evolution: this.skillLlm.status(),
        embedding: this.embedder.status()
      },
      capabilities: {
        routes,
        tools: [
          "session.open",
          "session.close",
          "turn.start",
          "turn.complete",
          ...(this.memorySearchEnabled() ? ["memory.search"] : []),
          ...(this.memoryAddEnabled() ? ["memory.add"] : []),
          ...(this.memorySearchEnabled() ? ["memory.get"] : []),
          ...(this.memoryAddEnabled() ? ["memory.delete"] : []),
          "panel.overview",
          "panel.analysis",
          "panel.items"
        ],
        memoryLayers: ["L1", "L2", "L3", "Skill"],
        supportsCli: true
      },
      serverTime: nowIso()
    };
  }

  reloadConfig(request: MemoryReloadConfigRequest = {}): MemoryReloadConfigResponse {
    const previousConfig = this.config;
    const loader = this.options.configLoader ?? loadMemmyConfig;
    const nextConfig = cloneMemmyConfig(loader(this.options.configPath).config);
    const changed = stableStringify(previousConfig) !== stableStringify(nextConfig);
    const requiresRestart = stableStringify(previousConfig.storage) !== stableStringify(nextConfig.storage);
    const reloadedAt = nowIso();

    this.config = nextConfig;
    this.llm = createConfiguredMemoryLlm(nextConfig, "memory_summary");
    this.skillLlm = createConfiguredMemoryLlm(nextConfig, "memory_evolution");
    this.embedder = createEmbedder(nextConfig.embedding);
    if (!requiresRestart && request.restartFailedProcessing !== false) {
      this.restartFailedProcessing(reloadedAt);
    }
    serviceLogger.info("config.reloaded", {
      changed,
      requiresRestart,
      restartFailedProcessing: !requiresRestart && request.restartFailedProcessing !== false,
      ...memoryConfigLogFields(this.config)
    });

    return {
      activeProfile: this.config.activeProfile,
      changed,
      requiresRestart,
      models: {
        summary: this.llm.status(),
        evolution: this.skillLlm.status(),
        embedding: this.embedder.status()
      },
      reloadedAt
    };
  }

  private storageCapabilities(): StorageBackendCapabilities {
    return this.options.backend?.capabilities() ?? sqliteBackendCapabilities(requireMemoryDb(this.options));
  }

  private schemaVersion(): { version: number; lastMigrationId?: string } {
    if (this.options.db) {
      return this.options.db.schemaVersion();
    }
    const capabilities = this.storageCapabilities();
    const version = Number(capabilities.schemaVersion);
    return {
      version: Number.isFinite(version) ? version : 0
    };
  }

  async idempotent<T>(
    operation: string,
    request: RequestEnvelope,
    fingerprint: unknown,
    run: () => T | Promise<T>
  ): Promise<T> {
    if (!this.memoryAddEnabled()) {
      return run();
    }
    const idempotencyKey = request.adapterId && request.requestId
      ? `${operation}:${request.adapterId}:${request.requestId}`
      : undefined;
    if (!idempotencyKey) {
      return run();
    }
    const requestHash = stableHash({ operation, fingerprint });
    const existing = this.repos.runtime.getIdempotency(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new MemoryServiceError("conflict", "idempotency key reused with different request body");
      }
      return withDuplicateFlag(existing.response) as T;
    }
    const response = await run();
    this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, response);
    return response;
  }

  adapterActivate(request: RequestEnvelope & {
    capabilities?: {
      lifecycle?: boolean;
      tools?: boolean;
      observations?: boolean;
      panel?: boolean;
    };
  } = {}): {
    adapterId: string;
    serviceVersion: string;
    acceptedCapabilities: {
      lifecycle: boolean;
      tools: boolean;
      observations: boolean;
      panel: boolean;
    };
    effectiveNamespace: {
      userId: string;
      projectId?: string;
      workspaceId?: string;
      profileId?: string;
    };
    expiresAt?: string;
    serverTime: string;
  } {
    const namespace = normalizeNamespace(request.namespace);
    return {
      adapterId: request.adapterId ?? "anonymous",
      serviceVersion: PROJECT_VERSION,
      acceptedCapabilities: {
        lifecycle: request.capabilities?.lifecycle ?? true,
        tools: request.capabilities?.tools ?? true,
        observations: request.capabilities?.observations ?? true,
        panel: request.capabilities?.panel ?? true
      },
      effectiveNamespace: {
        userId: namespace.userId,
        projectId: namespace.projectId ?? namespace.workspaceId,
        workspaceId: namespace.workspaceId,
        profileId: namespace.profileId
      },
      serverTime: nowIso()
    };
  }

  openSession(request: SessionOpenRequest): {
    sessionId: string;
    userId: string;
    source: string;
    profileId: string;
    projectId?: string;
    workspaceId?: string;
    conversationId?: string;
    status: "open";
    resumed: boolean;
    changeSeq?: number;
    syncCursor?: string;
    duplicate?: boolean;
    openedAt: string;
    serverTime: string;
  } {
    return this.sessionTurns.openSession(request);
  }

  closeSession(sessionId: string, request: RequestEnvelope = {}): {
    ok: true;
    sessionId: string;
    status: "closed";
    closedEpisodeIds: string[];
    changeSeq: number;
    syncCursor: string;
    closedAt: string;
    serverTime: string;
  } {
    return this.sessionTurns.closeSession(sessionId, request);
  }

  compactSession(sessionId: string, request: SessionCompactRequest = {}): {
    memorySnapshot: {
      summary: string;
      sourceTurnIds: string[];
      sourceMemoryIds: string[];
      tokenEstimate?: number;
    };
    contextPacketId: string;
    rawTurnId?: string;
    l1MemoryId?: string;
    changeSeq?: number;
    syncCursor?: string;
    jobs: JobRef[];
    serverTime: string;
  } {
    return this.sessionTurns.compactSession(sessionId, request);
  }

  checkpointSession(sessionId: string, request: SessionCheckpointRequest): {
    checkpointId: string;
    checkpoint: SessionCheckpointPayload;
    memorySnapshot: {
      summary: string;
      sourceTurnIds: string[];
      sourceMemoryIds: string[];
      tokenEstimate?: number;
    };
    contextPacketId: string;
    rawTurnId?: string;
    l1MemoryId?: string;
    changeSeq?: number;
    syncCursor?: string;
    jobs: JobRef[];
    serverTime: string;
  } {
    if (!request.task.trim()) {
      throw new MemoryServiceError("invalid_argument", "session checkpoint requires a non-empty task");
    }
    const list = (value: string[] | undefined): string[] => Array.isArray(value)
      ? value.map((item) => item.trim()).filter(Boolean).slice(0, 32)
      : [];
    const checkpoint: SessionCheckpointPayload = {
      task: request.task.trim(),
      changes: list(request.changes),
      validated: list(request.validated),
      unverified: list(request.unverified),
      nextSteps: list(request.nextSteps)
    };
    const summary = [
      `Task: ${checkpoint.task}`,
      "Changes:",
      ...(checkpoint.changes.length ? checkpoint.changes.map((item) => `- ${item}`) : ["- none recorded"]),
      "Validated:",
      ...(checkpoint.validated.length ? checkpoint.validated.map((item) => `- ${item}`) : ["- none recorded"]),
      "Unverified:",
      ...(checkpoint.unverified.length ? checkpoint.unverified.map((item) => `- ${item}`) : ["- none recorded"]),
      "Next steps:",
      ...(checkpoint.nextSteps.length ? checkpoint.nextSteps.map((item) => `- ${item}`) : ["- none recorded"])
    ].join("\n");
    const result = this.compactSession(sessionId, {
      namespace: request.namespace,
      episodeId: request.episodeId,
      summary,
      sourceTurnIds: request.sourceTurnIds,
      sourceMemoryIds: request.sourceMemoryIds,
      tokenEstimate: request.tokenEstimate,
      createL1: request.createL1,
      checkpoint
    });
    return {
      ...result,
      checkpointId: result.rawTurnId ?? result.contextPacketId,
      checkpoint
    };
  }

  async startTurn(request: TurnStartRequest & Record<string, unknown>): Promise<{
    contextPacketId: string;
    turnId: string;
    sessionId: string;
    episodeId: string;
    closedEpisodeIds: string[];
    searchEventId: string;
    hits: RecallHit[];
    injectedContext: InjectedContext;
    sourceMemoryIds: string[];
    droppedDueToBudget: Array<{
      id: string;
      kind: MemoryKind;
      memoryLayer: MemoryLayer;
      reason: "token_budget";
      tokenEstimate?: number;
    }>;
    status: string[];
    serverTime: string;
  }> {
    return this.sessionTurns.startTurn(request);
  }

  completeTurn(turnId: string, request: TurnCompleteRequest & Record<string, unknown>): CompleteTurnResponse {
    return this.sessionTurns.completeTurn(turnId, request);
  }

  async observeTool(input: ToolObserveRequest): Promise<{
    ok: true;
    eventId: string;
    rawTurnId?: string;
    repair?: DecisionRepairSummary;
    changeSeq?: number;
    syncCursor?: string;
    serverTime: string;
  }> {
    return this.sessionTurns.observeTool(input);
  }


  subagentStart(input: SubagentStartRequest): {
    ok: true;
    eventId: string;
    childSessionId?: string;
    rawTurnId: string;
    changeSeq: number;
    syncCursor: string;
    serverTime: string;
  } {
    return this.sessionTurns.subagentStart(input);
  }

  subagentComplete(input: SubagentCompleteRequest): CompleteTurnResponse {
    return this.sessionTurns.subagentComplete(input);
  }

  async repairSuggestion(input: RepairSuggestionRequest): Promise<{
    suggestedAction: "none" | "append_hint" | "replacement_suggestion";
    appendHint?: {
      content: string;
      sourceMemoryIds: string[];
    };
    replacementSuggestion?: {
      content: string;
      sourceMemoryIds: string[];
    };
    reason?: string;
    sourceMemoryIds: string[];
  }> {
    return this.sessionTurns.repairSuggestion(input);
  }

  async search(request: InternalMemorySearchRequest): Promise<{
    searchEventId: string;
    hits: RecallHit[];
    injectedContext: InjectedContext;
    candidateMemoryIds: string[];
    sourceMemoryIds: string[];
    droppedDueToBudget: Array<{
      id: string;
      kind: MemoryKind;
      memoryLayer: MemoryLayer;
      reason: "token_budget";
      tokenEstimate?: number;
    }>;
    tierLatencyMs: {
      search: number;
      rerank: number;
      budget: number;
      total: number;
    };
    status: string[];
    verbose: boolean;
    serverTime: string;
  }> {
    return this.retrieval.search(request);
  }


  private isMemoryReadyForRetrieval(memory: MemoryRow): boolean {
    return this.retrieval.isMemoryReadyForRetrieval(memory);
  }


  private retrievalTuningConfig(): {
    tier1TopK: number;
    tier2TopK: number;
    tier3TopK: number;
    candidatePoolFactor: number;
    weightCosine: number;
    weightPriority: number;
    mmrLambda: number;
    rrfConstant: number;
    relativeThresholdFloor: number;
    minSkillEta: number;
    minTraceSim: number;
    episodeGoalMinSim: number;
    minWorldModelConfidence: number;
    includeLowValue: boolean;
    tagFilter: "auto" | "on" | "off";
    keywordTopK: number;
    skillEtaBlend: number;
    smartSeed: boolean;
    smartSeedRatio: number;
    multiChannelBypass: boolean;
    skillInjectionMode: "summary" | "full";
    skillSummaryChars: number;
    decayHalfLifeDays: number;
    domain: "" | "research";
    readOnlyInjectionProfile: "all" | "experience" | "skill" | "skill_experience";
  } {
    return this.retrieval.retrievalTuningConfig();
  }

  addMemory(request: MemoryAddRequest): {
    id: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
    status: "activated" | "resolving" | "archived" | "deleted";
    title: string;
    summary: string;
    tags: string[];
    createdAt: string;
    serverTime: string;
  } {
    const previous = request.supersedesMemoryId
      ? this.requireExistingMemory(request.supersedesMemoryId)
      : undefined;
    if (previous) {
      this.assertMemoryInScope(previous, request.namespace);
      if ((request.layer ?? "L1") !== previous.memoryLayer) {
        throw new MemoryServiceError("conflict", "superseding memories must use the same memory layer");
      }
    }
    const added = this.importJobs.addMemory(request);
    if (!previous) return added;

    const inserted = this.requireExistingMemory(added.id);
    const at = nowIso();
    const supersession = this.repos.transaction(() => this.repos.memories.supersede({
      oldMemory: previous,
      newMemory: inserted,
      projectId: projectIdFromMemory(inserted),
      reason: request.supersessionReason,
      actor: request.namespace ? { ...request.namespace } : {},
      createdAt: at
    }));
    this.repos.runtime.appendChange({
      memoryId: supersession.oldMemory.id,
      namespaceId: namespaceIdFromMemory(supersession.oldMemory),
      kind: kindFromMemory(supersession.oldMemory),
      op: "archived",
      entityId: supersession.oldMemory.id,
      userId: supersession.oldMemory.userId,
      changeType: "superseded",
      before: previous,
      after: supersession.oldMemory,
      source: "memory.supersede",
      createdAt: at
    });
    this.repos.runtime.insertAudit({
      userId: inserted.userId,
      sessionId: inserted.sessionId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "supersede",
      targetKind: kindFromMemory(previous),
      targetId: previous.id,
      before: previous,
      after: supersession.oldMemory,
      meta: {
        supersededByMemoryId: inserted.id,
        relationId: supersession.relation.id,
        reason: request.supersessionReason
      },
      createdAt: at
    });
    return added;
  }

  exportMarkdown(request: MemoryMarkdownExportRequest = {}): {
    markdown: string;
    count: number;
    projectId?: string;
    generatedAt: string;
  } {
    this.assertMemorySearchEnabled();
    const context = this.resolveContext(request);
    const memories = this.repos.memories.list({
      ...memoryFilterForNamespace(context.namespace),
      status: request.includeArchived ? ["activated", "resolving", "archived"] : ["activated", "resolving"]
    }, 100_000);
    return {
      markdown: renderMemoryMarkdownBundle(memories),
      count: memories.length,
      projectId: context.namespace.projectId,
      generatedAt: nowIso()
    };
  }

  importMarkdown(request: MemoryMarkdownImportRequest): {
    applied: boolean;
    count: number;
    updated: string[];
    created: string[];
    rejected: Array<{ id: string; reason: string }>;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    if (!request.markdown?.trim()) {
      throw new MemoryServiceError("invalid_argument", "markdown audit import requires markdown");
    }
    const context = this.resolveContext(request);
    const documents = parseMemoryMarkdownBundle(request.markdown);
    const updated: string[] = [];
    const created: string[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    for (const document of documents) {
      try {
        const existing = this.repos.memories.get(document.frontMatter.id);
        if (existing) {
          this.assertMemoryInScope(existing, request.namespace);
          if (document.frontMatter.memoryLayer !== existing.memoryLayer) {
            throw new MemoryServiceError("conflict", "markdown audit cannot change memory layer");
          }
          if (request.apply !== false) {
            const at = nowIso();
            const next = this.repos.memories.update({
              ...existing,
              memoryValue: document.body,
              tags: uniq(document.frontMatter.tags),
              info: { ...existing.info, title: document.frontMatter.title, tags: uniq(document.frontMatter.tags) },
              properties: {
                ...existing.properties,
                tags: uniq(document.frontMatter.tags),
                info: { ...existing.properties.info, title: document.frontMatter.title, tags: uniq(document.frontMatter.tags) },
                internal_info: {
                  ...existing.properties.internal_info,
                  title: document.frontMatter.title,
                  provenance: document.frontMatter.provenance ?? existing.properties.internal_info.provenance
                }
              },
              updatedAt: at,
              contentHash: stableHash(document.body)
            });
            this.repos.runtime.appendChange({
              memoryId: next.id,
              namespaceId: namespaceIdFromMemory(next),
              kind: kindFromMemory(next),
              op: "updated",
              entityId: next.id,
              userId: next.userId,
              changeType: "markdown_audit_update",
              before: existing,
              after: next,
              source: "markdown.audit",
              createdAt: at
            });
            this.repos.runtime.insertAudit({
              userId: next.userId,
              sessionId: next.sessionId,
              actor: request.namespace ? { ...request.namespace } : {},
              action: "markdown_update",
              targetKind: kindFromMemory(next),
              targetId: next.id,
              before: existing,
              after: next,
              meta: {},
              createdAt: at
            });
          }
          updated.push(existing.id);
          continue;
        }
        if (request.apply === false) {
          created.push(document.frontMatter.id);
          continue;
        }
        const added = this.addMemory({
          namespace: request.namespace,
          source: context.namespace.source,
          content: document.body,
          layer: document.frontMatter.memoryLayer as MemoryLayer,
          title: document.frontMatter.title,
          tags: document.frontMatter.tags,
          provenance: document.frontMatter.provenance
        });
        created.push(added.id);
      } catch (error) {
        rejected.push({
          id: document.frontMatter.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return {
      applied: request.apply !== false,
      count: documents.length,
      updated,
      created,
      rejected,
      serverTime: nowIso()
    };
  }

  timeline(input: RequestEnvelope & {
    userId?: string;
    sessionId?: string;
    episodeId?: string;
    layers?: MemoryLayer[];
    tags?: string[];
    limit?: number;
    cursor?: number;
  }): {
    sessionId?: string;
    episodeId?: string;
    traces: MemoryListItem[];
    rawTurns?: ReturnType<typeof sessionRawTurnSummary>[];
    items: MemoryListItem[];
    nextCursor?: string;
    serverTime: string;
  } {
    return this.episodeReadModel.timeline(input);
  }

  getMemory(id: string, request: RequestEnvelope = {}): MemoryGetResponse {
    return this.episodeReadModel.getMemory(id, request);
  }

  async worldModelQuery(input: InternalMemorySearchRequest): Promise<{
    hits: RecallHit[];
    queried: {
      query: string;
      tags: string[];
      limit: number;
    };
    worldModels: Array<RecallHit & {
      body: string;
      sourceMemoryIds: string[];
    }>;
    injectedContext: InjectedContext;
    status: string[];
    serverTime: string;
  }> {
    return this.retrieval.worldModelQuery(input);
  }

  listSkills(input: RequestEnvelope & {
    userId?: string;
    q?: string;
    tags?: string[];
    limit?: number;
    cursor?: number;
  } = {}): {
    skills: Array<MemoryListItem & {
      name: string;
      invocationGuide?: string;
      reliabilityScore?: number;
      successRate?: number;
      betaPosterior?: {
        alpha: number;
        beta: number;
        mean: number;
      };
      utilityScore?: number;
      evidenceCount?: number;
      lastUsedAt?: string;
    }>;
    items: MemoryListItem[];
    nextCursor?: string;
    serverTime: string;
  } {
    return this.skillReadModel.listSkills(input);
  }

  getSkill(skillId: string, request: RequestEnvelope = {}): MemoryDetailItem & {
    name: string;
    invocationGuide: string;
    procedure?: string[];
    sourcePolicyIds: string[];
    sourceWorldModelIds: string[];
    evidenceAnchorIds: string[];
    reliability: {
      eta: number;
      supportCount: number;
      usageCount: number;
      lastUsedAt?: string;
      pendingTrials: number;
      successRate: number;
      betaPosterior: {
        alpha: number;
        beta: number;
        mean: number;
      };
      trialsAttempted: number;
      trialsPassed: number;
    };
  } {
    return this.skillReadModel.getSkill(skillId, request);
  }

  useSkill(skillId: string, request: SkillUseRequest): {
    skillId: string;
    trialId: string;
    status: "pending";
    changeSeq: number;
    syncCursor: string;
    serverTime: string;
    duplicate?: boolean;
  } {
    return this.skillReadModel.useSkill(skillId, request);
  }

  async feedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    return this.feedbackExperience.feedback(request);
  }

  exportBundle(request: MemoryExportRequest = {}): {
    schemaVersion: number;
    exportedAt: string;
    manifest: {
      service: string;
      includeRawText: boolean;
      includeAudit: boolean;
      backend: StorageBackendCapabilities["backend"];
      tables: string[];
    };
    tables: Record<string, Array<Record<string, unknown>>>;
    serverTime: string;
  } {
    this.assertMemorySearchEnabled();
    const context = this.resolveContext(request);
    const tables = scopeBundleTables(
      this.repos.runtime.exportBundleTables(request.includeRawText === true),
      context.namespace
    );
    const scopedMemoryIds = new Set((tables.memories ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string"));
    tables.memory_vectors = this.repos.vectors.exportRows()
      .filter((row) => scopedMemoryIds.has(row.memory_id))
      .map((row) => ({ ...row }));
    if (request.includeAudit === false) {
      delete tables.audit_logs;
    }
    if (this.memoryAddEnabled()) {
      this.repos.runtime.insertAudit({
        userId: context.userId,
        actor: request.namespace ? { ...request.namespace } : {},
        action: "export",
        targetKind: "bundle",
        targetId: `export_${stableHash(nowIso()).slice(0, 16)}`,
        meta: {
          includeRawText: request.includeRawText === true,
          includeAudit: request.includeAudit !== false,
          tables: Object.keys(tables)
        },
        createdAt: nowIso()
      });
    }
    return {
      schemaVersion: this.schemaVersion().version,
      exportedAt: nowIso(),
      manifest: {
        service: "memmy-memory-service",
        includeRawText: request.includeRawText === true,
        includeAudit: request.includeAudit !== false,
        backend: this.storageCapabilities().backend,
        tables: Object.keys(tables)
      },
      tables,
      serverTime: nowIso()
    };
  }

  importBundle(request: MemoryImportRequest): {
    ok: true;
    importedAt: string;
    conflictStrategy: "skip" | "replace" | "error";
    inserted: Record<string, number>;
    skipped: Record<string, number>;
    replaced: Record<string, number>;
    migrationMap: Record<string, Record<string, string>>;
    conflicts: Array<{
      table: string;
      primaryKey: string;
      sourceId: string;
      targetId: string;
      action: "skipped" | "replaced" | "error";
    }>;
    reembedMemoryIds: string[];
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    if (!request.bundle || !request.bundle.tables || typeof request.bundle.tables !== "object") {
      throw new MemoryServiceError("invalid_argument", "import bundle must contain tables");
    }
    const context = this.resolveContext(request);
    const inputTables = request.bundle.tables as Record<string, Array<Record<string, unknown>>>;
    const enforceBundleScope = hasProjectScope(context.namespace) || Boolean(context.namespace.tenantId);
    const scopedInputTables = enforceBundleScope ? scopeBundleTables(inputTables, context.namespace) : inputTables;
    if (enforceBundleScope && bundleTableRowCount(scopedInputTables) !== bundleTableRowCount(inputTables)) {
      throw new MemoryServiceError("not_found", "bundle contains records outside the requested namespace");
    }
    const importedAt = nowIso();
    const result = this.repos.runtime.importBundleTables(scopedInputTables, {
      conflictStrategy: request.conflictStrategy ?? "skip"
    });
    const importedVectors = importedMemoryVectors(scopedInputTables.memory_vectors);
    this.repos.vectors.importRows(importedVectors);
    result.inserted.memory_vectors = importedVectors.length;
    const reembedMemoryIds = importedReembedMemoryIds(
      scopedInputTables,
      this.embedder.config.model ?? this.embedder.config.provider
    );
    const audit = this.repos.runtime.insertAudit({
      userId: context.userId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "import",
      targetKind: "bundle",
      targetId: `import_${stableHash(importedAt).slice(0, 16)}`,
      meta: {
        sourceSchemaVersion: request.bundle.schemaVersion,
        sourceExportedAt: request.bundle.exportedAt,
        conflictStrategy: request.conflictStrategy ?? "skip",
        inserted: result.inserted,
        skipped: result.skipped,
        replaced: result.replaced,
        migrationMap: result.migrationMap,
        conflicts: result.conflicts,
        reembedMemoryIds
      },
      createdAt: importedAt
    });
    return {
      ok: true,
      importedAt,
      conflictStrategy: request.conflictStrategy ?? "skip",
      inserted: result.inserted,
      skipped: result.skipped,
      replaced: result.replaced,
      migrationMap: result.migrationMap,
      conflicts: result.conflicts,
      reembedMemoryIds,
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  archiveMemory(id: string, request: MemoryGovernanceRequest = {}): {
    ok: true;
    id: string;
    kind: MemoryKind;
    status: "archived";
    changeSeq: number;
    syncCursor: string;
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const memory = this.requireExistingMemory(id);
    this.assertMemoryInScope(memory, request.namespace);
    const kind = kindFromMemory(memory);
    const archived = this.repos.memories.archive(memory.id, nowIso());
    if (!archived) {
      throw new MemoryServiceError("not_found", `memory not found: ${id}`);
    }
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: archived.id,
      namespaceId: namespaceIdFromMemory(archived),
      kind: kindFromMemory(archived),
      op: "archived",
      entityId: archived.id,
      userId: archived.userId,
      changeType: "archive",
      version: archived.version,
      before: memory,
      after: archived,
      source: "panel.archive",
      createdAt: archived.updatedAt
    });
    const audit = this.repos.runtime.insertAudit({
      userId: archived.userId,
      sessionId: archived.sessionId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "archive",
      targetKind: kindFromMemory(archived),
      targetId: archived.id,
      before: memory,
      after: archived,
      meta: { reason: request.reason },
      createdAt: archived.updatedAt
    });
    return {
      ok: true,
      id: archived.id,
      kind: kindFromMemory(archived),
      status: "archived",
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? namespaceForMemory(archived)),
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  deleteMemory(id: string, request: MemoryGovernanceRequest = {}): {
    ok: true;
    id: string;
    kind: MemoryKind;
    status: "deleted";
    changeSeq: number;
    syncCursor: string;
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const memory = this.requireExistingMemory(id);
    this.assertMemoryInScope(memory, request.namespace);
    const kind = kindFromMemory(memory);
    const deleted = this.repos.memories.softDelete(memory.id, nowIso());
    if (!deleted) {
      throw new MemoryServiceError("not_found", `memory not found: ${id}`);
    }
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: deleted.id,
      namespaceId: namespaceIdFromMemory(deleted),
      kind: kindFromMemory(deleted),
      op: "deleted",
      entityId: deleted.id,
      userId: deleted.userId,
      changeType: "delete",
      version: deleted.version,
      before: memory,
      after: deleted,
      source: "panel.delete",
      createdAt: deleted.updatedAt
    });
    const audit = this.repos.runtime.insertAudit({
      userId: deleted.userId,
      sessionId: deleted.sessionId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "delete",
      targetKind: kindFromMemory(deleted),
      targetId: deleted.id,
      before: memory,
      after: deleted,
      meta: { reason: request.reason },
      createdAt: deleted.updatedAt
    });
    return {
      ok: true,
      id: deleted.id,
      kind: kindFromMemory(deleted),
      status: "deleted",
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? namespaceForMemory(deleted)),
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  deletePanelTask(id: string, request: MemoryGovernanceRequest = {}): {
    ok: true;
    id: string;
    deletedMemoryIds: string[];
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const episode = this.requireEpisode(id);
    this.assertEpisodeInScope(episode, request.namespace);
    const deletedMemoryIds: string[] = [];

    this.repos.transaction(() => {
      for (const memoryId of episode.l1MemoryIds) {
        if (!this.repos.memories.get(memoryId)) continue;
        this.deleteMemory(memoryId, request);
        deletedMemoryIds.push(memoryId);
      }
      if (!this.repos.runtime.deleteEpisode(id)) {
        throw new MemoryServiceError("not_found", `episode not found: ${id}`);
      }
    });

    return {
      ok: true,
      id,
      deletedMemoryIds,
      serverTime: nowIso()
    };
  }

  redactRawTurn(rawTurnId: string, request: RawTurnRedactRequest = {}): {
    ok: true;
    rawTurnId: string;
    mode: "redact" | "delete";
    changeSeq: number;
    syncCursor: string;
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const rawTurn = this.repos.runtime.getRawTurn(rawTurnId);
    if (!rawTurn) {
      throw new MemoryServiceError("not_found", `raw turn not found: ${rawTurnId}`);
    }
    this.assertRawTurnInScope(rawTurn, request.namespace);
    const session = this.repos.runtime.getSession(rawTurn.sessionId);
    const rawTurnNamespace = session ? namespaceForSession(session) : namespaceForRawTurn(rawTurn);
    const at = nowIso();
    const mode = request.mode ?? "redact";
    const redacted: RawTurnRecord = {
      ...rawTurn,
      userText: undefined,
      assistantText: undefined,
      reasoningSummary: undefined,
      toolCalls: [],
      toolResults: [],
      messagePayload: {
        ...(rawTurn.messagePayload ?? {}),
        governance: {
          redacted: true,
          mode,
          reason: request.reason,
          at
        }
      },
      status: mode === "delete" ? "deleted" : rawTurn.status,
      redactedAt: at,
      deletedAt: mode === "delete" ? at : rawTurn.deletedAt
    };
    this.repos.runtime.updateRawTurn(redacted);
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: namespaceIdFromContext(rawTurnNamespace),
      kind: "raw_turn",
      op: mode === "delete" ? "deleted" : "updated",
      entityId: rawTurn.id,
      userId: rawTurn.userId,
      changeType: mode === "delete" ? "raw_turn_delete" : "raw_turn_redact",
      before: rawTurn,
      after: redacted,
      source: "panel.raw_redact",
      createdAt: at
    });
    const audit = this.repos.runtime.insertAudit({
      userId: rawTurn.userId,
      sessionId: rawTurn.sessionId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: mode === "delete" ? "raw_delete" : "raw_redact",
      targetKind: "raw_turn",
      targetId: rawTurn.id,
      before: sessionRawTurnSummary(rawTurn),
      after: sessionRawTurnSummary(redacted),
      meta: { reason: request.reason },
      createdAt: at
    });
    return {
      ok: true,
      rawTurnId: rawTurn.id,
      mode,
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? rawTurnNamespace),
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  auditLogs(input: RequestEnvelope & {
    userId?: string;
    targetKind?: string;
    targetId?: string;
    limit?: number;
  } = {}): {
    items: ReturnType<Repositories["runtime"]["listAudit"]>;
    serverTime: string;
  } {
    return this.panelReadModel.auditLogs(input);
  }

  serviceLogs(input: RequestEnvelope & {
    userId?: string;
    limit?: number;
    cursor?: string;
  } = {}): {
    cursor: string;
    entries: Array<{
      type: "change" | "audit" | "job";
      id: string;
      at: string;
      userId?: string;
      action: string;
      targetKind?: string;
      targetId?: string;
      source?: string;
      payload?: unknown;
    }>;
    changes: ReturnType<MemoryService["panelChanges"]>["changes"];
    audits: ReturnType<Repositories["runtime"]["listAudit"]>;
    jobs: EvolutionJobRecord[];
    serverTime: string;
  } {
    return this.panelReadModel.serviceLogs(input);
  }

  apiLogs(input: RequestEnvelope & {
    tools?: Array<"memory_add" | "memory_search" | "skill_generate" | "skill_evolve">;
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    limit?: number;
    offset?: number;
  } = {}): {
    logs: ReturnType<Repositories["runtime"]["listApiLogs"]>["logs"];
    total: number;
    limit: number;
    offset: number;
    nextOffset?: number;
    serverTime: string;
  } {
    return this.panelReadModel.apiLogs(input);
  }

  serviceMetrics(input: RequestEnvelope & { userId?: string } = {}): {
    storage: StorageBackendCapabilities;
    schema: { version: number; lastMigrationId?: string };
    memory: ReturnType<MemoryService["panelOverview"]>["stats"];
    changeSeq: number;
    feedback: {
      recent: number;
    };
    jobs: Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number>;
    embeddingRetries: Record<"pending" | "in_progress" | "succeeded" | "failed", number>;
    models: HealthResponse["models"];
    serverTime: string;
  } {
    return this.panelReadModel.serviceMetrics(input);
  }

  adminStatus(input: RequestEnvelope & { userId?: string } = {}, routes: string[] = []): {
    health: HealthResponse;
    overview: ReturnType<MemoryService["panelOverview"]>;
    failedJobs: EvolutionJobRecord[];
    deadLetterJobs: EvolutionJobRecord[];
    serverTime: string;
  } {
    return this.panelReadModel.adminStatus(input, routes);
  }

  configStatus(_input: RequestEnvelope = {}): {
    version: number;
    config: MemmyConfig;
    redacted: boolean;
    serverTime: string;
  } {
    return this.panelReadModel.configStatus(_input);
  }

  panelOverview(input: RequestEnvelope & { userId?: string } = {}): {
    stats: {
      byLayer: Record<MemoryLayer, number>;
      byStatus: Record<"activated" | "resolving" | "archived" | "deleted", number>;
      episodes: Record<"open" | "processing" | "closed", number>;
      jobs: Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number>;
      embeddingRetries: Record<"pending" | "in_progress" | "succeeded" | "failed", number>;
      lastChangeSeq?: number;
    };
    counts: Record<MemoryLayer, number>;
    queuedJobs: number;
    latestChangeSeq: number;
    cursor: string;
    etag: string;
    serverTime: string;
  } {
    return this.panelReadModel.panelOverview(input);
  }

  panelOverviewSummary(input: RequestEnvelope & { userId?: string } = {}): {
    counts: {
      memories: number;
      skills: number;
      experiences: number;
      worldModels: number;
    };
    sourceDistribution: Array<{
      source: string;
      count: number;
      percentage: number;
    }>;
    dailyActivity: Array<{ date: string; count: number }>;
  } {
    return this.panelReadModel.panelOverviewSummary(input);
  }

  evolutionOverview(input: RequestEnvelope & { userId?: string } = {}) {
    return this.panelReadModel.evolutionOverview(input);
  }

  namespaceAudit(input: RequestEnvelope & { userId?: string } = {}) {
    return this.panelReadModel.namespaceAudit(input);
  }

  projectContextPack(input: RequestEnvelope & { userId?: string } = {}) {
    return this.panelReadModel.projectContextPack(input);
  }

  projectContextPacks(input: RequestEnvelope & { userId?: string } = {}) {
    return this.panelReadModel.projectContextPacks(input);
  }

  panelAnalysis(input: RequestEnvelope & { userId?: string } = {}): {
    metrics: {
      avgRecallScore: number;
      recallEvents: number;
      activeSkills: number;
      recentlyUsedSkills: number;
      avgToolLatencyMs: number;
      p95ToolLatencyMs: number;
    };
    dailyMemoryWrites: Array<{ date: string; count: number }>;
    dailySkillEvolutions: Array<{ date: string; count: number }>;
    toolLatency: {
      tools: Array<{ name: string; calls: number; avgMs: number; p95Ms: number }>;
      series: Array<{ name: string; points: Array<{ date: string; avgMs: number }> }>;
    };
  } {
    return this.panelReadModel.panelAnalysis(input);
  }

  panelItems(input: RequestEnvelope & {
    userId?: string;
    layer?: MemoryLayer;
    status?: "activated" | "resolving" | "archived" | "deleted";
    q?: string;
    tags?: string[];
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    projectId?: string;
    workspaceId?: string;
    page?: number;
    limit?: number;
    cursor?: string | number;
  }): {
    items: MemoryListItem[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    etag: string;
    nextCursor?: string;
    serverTime: string;
  } {
    return this.panelReadModel.panelItems(input);
  }

  panelTasks(input: RequestEnvelope & { q?: string; page?: number }): {
    tasks: Array<{
      id: string;
      episode: Record<string, unknown>;
      memoryIds: string[];
      turns: ReturnType<typeof sessionRawTurnSummary>[];
      updatedAt: string;
    }>;
    page: number;
    pageSize: 20;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    serverTime: string;
  } {
    return this.panelReadModel.panelTasks(input);
  }

  panelChanges(input: RequestEnvelope & {
    userId?: string;
    limit?: number;
    cursor?: string;
  } = {}): {
    cursor: string;
    changes: Array<{
      seq: number;
      op: "created" | "updated" | "archived" | "deleted";
      kind: MemoryKind | "session" | "episode" | "job" | "feedback" | "raw_turn" | "repair" | "skill_trial" | "recall" | "artifact";
      id: string;
      version?: number;
      source: "turn_complete" | "feedback" | "worker" | "panel" | "system";
      updatedAt: string;
    }>;
    hasMore: boolean;
    items: ChangeLogRecord[];
    serverTime: string;
  } {
    return this.panelReadModel.panelChanges(input);
  }

  panelJobs(input: RequestEnvelope & {
    userId?: string;
    status?: "queued" | "leased" | "succeeded" | "failed" | "dead_letter";
    limit?: number;
  } = {}): {
    jobs: Array<EvolutionJobRecord & {
      error?: {
        code: string;
        message: string;
      };
    }>;
    items: EvolutionJobRecord[];
    nextCursor?: string;
    serverTime: string;
  } {
    return this.panelReadModel.panelJobs(input);
  }

  memoryProcessingStatus(memoryIds: readonly string[], request: RequestEnvelope = {}): {
    items: MemoryProcessingRecord[];
    serverTime: string;
  } {
    return this.importJobs.memoryProcessingStatus(memoryIds, request);
  }

  retryMemoryProcessing(memoryId: string, request: RequestEnvelope = {}): {
    accepted: boolean;
    processing: MemoryProcessingRecord;
    job?: JobRef;
    serverTime: string;
  } {
    return this.importJobs.retryMemoryProcessing(memoryId, request);
  }

  rateMemory(id: string, useful: boolean, request: MemoryGovernanceRequest = {}) {
    this.assertMemoryAddEnabled();
    const memory = this.requireExistingMemory(id);
    this.assertMemoryInScope(memory, request.namespace);
    const at = nowIso();
    const before = memory;
    const opposite = useful ? "quality-not-useful" : "quality-useful";
    const tag = useful ? "quality-useful" : "quality-not-useful";
    const updated = this.repos.memories.update({
      ...memory,
      tags: uniq([...memory.tags.filter((item) => item !== opposite), tag]),
      info: { ...memory.info, quality_rating: useful ? "useful" : "not_useful", quality_rated_at: at },
      updatedAt: at
    });
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: updated.id, namespaceId: namespaceIdFromMemory(updated), kind: kindFromMemory(updated), op: "updated",
      entityId: updated.id, userId: updated.userId, changeType: "quality_rating", before, after: updated,
      source: "panel.quality", createdAt: at
    });
    const audit = this.repos.runtime.insertAudit({
      userId: updated.userId, sessionId: updated.sessionId, actor: request.namespace ? { ...request.namespace } : {},
      action: useful ? "mark_useful" : "mark_not_useful", targetKind: kindFromMemory(updated), targetId: updated.id,
      before, after: updated, meta: { reason: request.reason }, createdAt: at
    });
    return { ok: true, id: updated.id, useful, changeSeq, auditId: audit.id, serverTime: at };
  }

  reviewCandidates(request: RequestEnvelope & { layer?: MemoryLayer; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(request.limit ?? 100, 1000));
    const memories = this.repos.memories.list({
      ...request.namespace ? memoryFilterForNamespace(request.namespace) : {},
      memoryLayer: request.layer ?? ["L2", "L3", "Skill"],
      status: "resolving"
    }, limit);
    return {
      items: memories.map((memory) => candidateReviewCard(memory)),
      total: memories.length,
      serverTime: nowIso()
    };
  }

  approveCandidate(
    id: string,
    request: MemoryGovernanceRequest & { content?: string; title?: string } = {}
  ) {
    this.assertMemoryAddEnabled();
    const memory = this.requireReviewCandidate(id, request);
    const at = nowIso();
    const title = request.title?.trim();
    const content = request.content?.trim();
    const internal = memory.properties.internal_info;
    const updated = this.repos.memories.update({
      ...memory,
      status: "activated",
      memoryValue: content || memory.memoryValue,
      tags: uniq([...memory.tags, "review-approved"]),
      info: {
        ...memory.info,
        ...(title ? { title } : {}),
        review_status: "approved",
        reviewed_at: at
      },
      properties: {
        ...memory.properties,
        status: "activated",
        tags: uniq([...(memory.properties.tags ?? []), "review-approved"]),
        info: {
          ...memory.properties.info,
          ...(title ? { title } : {}),
          review_status: "approved",
          reviewed_at: at
        },
        internal_info: {
          ...internal,
          ...(title ? { title } : {}),
          review: { status: "approved", reviewed_at: at, edited: Boolean(title || content) }
        }
      },
      contentHash: content ? stableHash(content) : memory.contentHash,
      updatedAt: at
    });
    return this.recordCandidateReview(memory, updated, "approved", request);
  }

  rejectCandidate(id: string, request: MemoryGovernanceRequest = {}) {
    this.assertMemoryAddEnabled();
    const memory = this.requireReviewCandidate(id, request);
    const at = nowIso();
    const internal = memory.properties.internal_info;
    const updated = this.repos.memories.update({
      ...memory,
      status: "archived",
      tags: uniq([...memory.tags, "review-rejected"]),
      info: { ...memory.info, review_status: "rejected", reviewed_at: at, review_reason: request.reason },
      properties: {
        ...memory.properties,
        status: "archived",
        tags: uniq([...(memory.properties.tags ?? []), "review-rejected"]),
        info: { ...memory.properties.info, review_status: "rejected", reviewed_at: at, review_reason: request.reason },
        internal_info: { ...internal, review: { status: "rejected", reviewed_at: at, reason: request.reason } }
      },
      updatedAt: at
    });
    return this.recordCandidateReview(memory, updated, "rejected", request);
  }

  bulkApproveHighConfidenceCandidates(
    request: MemoryGovernanceRequest & { minimumConfidence?: number; layer?: MemoryLayer } = {}
  ) {
    const minimumConfidence = Math.max(0, Math.min(request.minimumConfidence ?? 0.8, 1));
    const candidates = this.reviewCandidates({ ...request, layer: request.layer, limit: 1000 }).items
      .filter((candidate) => candidate.confidence >= minimumConfidence);
    const approved = candidates.map((candidate) => this.approveCandidate(candidate.id, request));
    return { approved: approved.length, minimumConfidence, ids: approved.map((item) => item.id), serverTime: nowIso() };
  }

  private requireReviewCandidate(id: string, request: MemoryGovernanceRequest): MemoryRow {
    const memory = this.requireExistingMemory(id);
    this.assertMemoryInScope(memory, request.namespace);
    if (memory.memoryLayer === "L1" || memory.status !== "resolving") {
      throw new MemoryServiceError("conflict", "only resolving L2/L3/Skill memories can be reviewed");
    }
    return memory;
  }

  private recordCandidateReview(
    before: MemoryRow,
    after: MemoryRow,
    decision: "approved" | "rejected",
    request: MemoryGovernanceRequest
  ) {
    const at = after.updatedAt;
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: after.id, namespaceId: namespaceIdFromMemory(after), kind: kindFromMemory(after),
      op: decision === "approved" ? "updated" : "archived", entityId: after.id, userId: after.userId,
      changeType: `review_${decision}`, before, after, source: "panel.review", createdAt: at
    });
    const audit = this.repos.runtime.insertAudit({
      userId: after.userId, sessionId: after.sessionId, actor: request.namespace ? { ...request.namespace } : {},
      action: `review_${decision}`, targetKind: kindFromMemory(after), targetId: after.id, before, after,
      meta: { reason: request.reason }, createdAt: at
    });
    return { ok: true, id: after.id, layer: after.memoryLayer, status: after.status, decision, changeSeq, auditId: audit.id, serverTime: nowIso() };
  }

  mergeMemories(targetId: string, sourceId: string, request: MemoryGovernanceRequest = {}) {
    this.assertMemoryAddEnabled();
    if (targetId === sourceId) throw new MemoryServiceError("invalid_argument", "merge source and target must differ");
    const target = this.requireExistingMemory(targetId);
    const source = this.requireExistingMemory(sourceId);
    this.assertMemoryInScope(target, request.namespace);
    this.assertMemoryInScope(source, request.namespace);
    if (target.memoryLayer !== source.memoryLayer) throw new MemoryServiceError("conflict", "merged memories must use the same layer");
    const at = nowIso();
    const merged = this.repos.transaction(() => this.repos.memories.supersede({
      oldMemory: source, newMemory: target, projectId: projectIdFromMemory(target),
      reason: request.reason ?? `duplicate of ${target.id}`, actor: request.namespace ? { ...request.namespace } : {}, createdAt: at
    }));
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: merged.oldMemory.id, namespaceId: namespaceIdFromMemory(merged.oldMemory), kind: kindFromMemory(merged.oldMemory), op: "archived",
      entityId: merged.oldMemory.id, userId: merged.oldMemory.userId, changeType: "merged_duplicate", before: source,
      after: merged.oldMemory, source: "panel.merge", createdAt: at
    });
    const audit = this.repos.runtime.insertAudit({
      userId: target.userId, sessionId: target.sessionId, actor: request.namespace ? { ...request.namespace } : {}, action: "merge",
      targetKind: kindFromMemory(target), targetId: target.id, before: { target, source }, after: merged,
      meta: { sourceMemoryId: source.id, relationId: merged.relation.id, reason: request.reason }, createdAt: at
    });
    return { ok: true, targetId, archivedSourceId: sourceId, relationId: merged.relation.id, changeSeq, auditId: audit.id, serverTime: at };
  }

  promoteL1ToL2(id: string, request: MemoryGovernanceRequest = {}) {
    const source = this.requireExistingMemory(id);
    this.assertMemoryInScope(source, request.namespace);
    if (source.memoryLayer !== "L1") throw new MemoryServiceError("invalid_argument", "manual promotion requires an L1 memory");
    return this.addMemory({
      ...request,
      content: source.memoryValue,
      layer: "L2",
      title: `Experience: ${firstLine(source.memoryValue).slice(0, 100)}`,
      tags: uniq([...source.tags, "manual-promotion", "experience"]),
      source: request.source ?? "memory-console",
      sessionId: source.sessionId,
      sourceMemoryIds: [source.id],
      provenance: { sourceMemoryIds: [source.id] }
    });
  }

  promoteCandidates(request: RequestEnvelope = {}) {
    this.assertMemoryAddEnabled();
    const candidates = this.repos.runtime.listPendingCandidatePool({ now: nowIso(), limit: 10_000 })
      .filter((candidate) => {
        const memory = this.repos.memories.get(candidate.sourceMemoryId);
        return Boolean(memory && (!request.namespace || sameProjectScope(namespaceForMemory(memory), request.namespace)));
      });
    const memoryIds = uniq(candidates.map((candidate) => candidate.sourceMemoryId));
    const jobs = memoryIds.map((memoryId) => {
      const memory = this.requireExistingMemory(memoryId);
      return this.enqueueJob({
        jobType: "l2_induction", userId: memory.userId, sessionId: memory.sessionId, targetMemoryId: memory.id,
        payload: { sourceMemoryId: memory.id, reason: "manual_candidate_promotion" }, createdAt: nowIso()
      });
    });
    return { accepted: jobs.length, candidateCount: candidates.length, memoryIds, jobs: jobs.map(jobToRef), serverTime: nowIso() };
  }

  retryFailedWorkerJobs(request: RequestEnvelope & { limit?: number } = {}) {
    this.assertMemoryAddEnabled();
    const limit = Math.max(1, Math.min(request.limit ?? 100, 10_000));
    const failed = [
      ...this.panelReadModel.panelJobs({ ...request, status: "failed", limit }).items,
      ...this.panelReadModel.panelJobs({ ...request, status: "dead_letter", limit }).items
    ].slice(0, limit);
    const retried = this.repos.runtime.retryFailedJobIds(failed.map((job) => job.id));
    for (const { before, after } of retried) this.workerHandlers.appendJobChange(after, "queued", before);
    return { retried: retried.length, jobIds: retried.map((item) => item.after.id), serverTime: nowIso() };
  }

  async runWorkerWithEvolutionSummary(limit = 100, request: RequestEnvelope & { targetMemoryIds?: string[] } = {}) {
    const before = this.panelReadModel.panelOverviewSummary(request).layerCounts;
    const worker = await this.runWorkerOnce(limit, request);
    const after = this.panelReadModel.panelOverviewSummary(request).layerCounts;
    return {
      ...worker,
      generated: { L2: Math.max(0, after.L2 - before.L2), L3: Math.max(0, after.L3 - before.L3), Skill: Math.max(0, after.Skill - before.Skill) }
    };
  }

  private restartFailedProcessing(at: string, limit = 10000): number {
    return this.importJobs.restartFailedProcessing(at, limit);
  }

  enqueuePendingImportSummaries(limit = 10000, targetMemoryIds?: readonly string[], request: RequestEnvelope = {}): {
    enqueued: number;
    memoryIds: string[];
    serverTime: string;
  } {
    const scopedTargetIds = request.namespace
      ? targetMemoryIds
        ? targetMemoryIds.filter((id) => {
          const memory = this.repos.memories.get(id);
          if (!memory) return false;
          this.assertMemoryInScope(memory, request.namespace);
          return true;
        })
        : this.repos.memories.list({ ...memoryFilterForNamespace(request.namespace) }, 10_000).map((memory) => memory.id)
      : targetMemoryIds;
    return this.importJobs.enqueuePendingImportSummaries(limit, scopedTargetIds);
  }

  nextWorkerRunAt(): number | undefined {
    return this.workerRunner.nextWorkerRunAt();
  }

  reconcileWorkerStartup(limit = 10000): ReturnType<WorkerRunner["reconcileWorkerStartup"]> {
    return this.workerRunner.reconcileWorkerStartup(limit);
  }

  runWorkerOnce(
    limit = 100,
    request: RequestEnvelope & { targetMemoryIds?: string[] } = {}
  ): ReturnType<WorkerRunner["runWorkerOnce"]> {
    if (request.namespace && !request.targetMemoryIds) {
      const targetMemoryIds = this.repos.memories.list({ ...memoryFilterForNamespace(request.namespace) }, 10_000)
        .map((memory) => memory.id);
      return this.workerRunner.runWorkerOnce(limit, { ...request, targetMemoryIds });
    }
    if (request.namespace && request.targetMemoryIds) {
      for (const id of request.targetMemoryIds) {
        const memory = this.repos.memories.get(id);
        if (!memory) continue;
        this.assertMemoryInScope(memory, request.namespace);
      }
    }
    return this.workerRunner.runWorkerOnce(limit, request);
  }

  private async queryVector(query: string): Promise<number[] | undefined> {
    return this.retrieval.queryVector(query);
  }

  private async embedMemory(job: EvolutionJobRecord): Promise<void> {
    return this.embeddingJobs.embedMemory(job);
  }

  private async summarizeImportedTrace(job: EvolutionJobRecord): Promise<void> {
    return this.embeddingJobs.summarizeImportedTrace(job);
  }

  private async summarizeCapturedTrace(job: EvolutionJobRecord): Promise<void> {
    return this.embeddingJobs.summarizeCapturedTrace(job);
  }

  private enqueueJob(input: EnqueueJobInput): EvolutionJobRecord {
    return this.workerHandlers.enqueueJob(input);
  }

  private finalizeClosedEpisode(
    episode: EpisodeRecord,
    at: string,
    trigger: ClosedEpisodeTrigger
  ): EvolutionJobRecord[] {
    return this.workerHandlers.finalizeClosedEpisode(episode, at, trigger);
  }

  private buildMemory(input: {
    id?: string;
    userId: string;
    conversationId?: string;
    sessionId?: string;
    agentId?: string;
    appId?: string;
    tenantId?: string;
    projectId?: string;
    profileId?: string;
    workspacePath?: string;
    provenance?: Partial<MemoryProvenance>;
    layer: MemoryLayer;
    kind: MemoryKind;
    lifecycleStatus?: "candidate" | "active" | "archived";
    memoryType: string;
    key?: string;
    value: string;
    tags: string[];
    info?: Record<string, unknown>;
    internal?: Record<string, unknown>;
    createdAt?: string;
  }): MemoryRow {
    const at = input.createdAt ?? nowIso();
    const memoryStatus = memoryStatusForLifecycleStatus(input.lifecycleStatus ?? "active");
    const inputInfo = input.info ?? {};
    const inputInternal = input.internal ?? {};
    const semanticTags = uniq(input.tags.map((tag) => tag.trim()).filter(Boolean));
    const sourceSession = input.sessionId ? this.repos.runtime.getSession(input.sessionId) : undefined;
    const sessionTenantId = sourceSession ? tenantIdFromSession(sourceSession) : undefined;
    const tenantId = input.tenantId ?? sessionTenantId ?? stringFromMeta(inputInfo, "tenant_id") ?? input.provenance?.tenantId ?? "local";
    const sourceAgent = normalizeMemorySourceAgent(
      input.provenance?.sourceAgent ?? input.agentId ?? stringFromMeta(inputInfo, "source") ?? DEFAULT_NAMESPACE_SOURCE
    );
    const tags = normalizeMemoryTagsForSource(semanticTags, sourceAgent);
    const provenance: MemoryProvenance = {
      sourceAgent,
      tenantId,
      profileId: input.provenance?.profileId ?? input.profileId,
      projectId: input.provenance?.projectId ?? input.projectId,
      workspaceId: input.provenance?.workspaceId ?? input.appId,
      workspacePath: input.provenance?.workspacePath ?? input.workspacePath,
      sessionId: input.provenance?.sessionId ?? input.sessionId,
      turnId: input.provenance?.turnId ?? stringFromMeta(inputInfo, "turn_id"),
      adapterId: input.provenance?.adapterId,
      requestId: input.provenance?.requestId,
      sourceMemoryIds: uniq([
        ...(input.provenance?.sourceMemoryIds ?? []),
        ...stringArray(inputInternal.source_memory_ids)
      ]),
      repository: input.provenance?.repository,
      branch: input.provenance?.branch,
      commit: input.provenance?.commit,
      capturedAt: input.provenance?.capturedAt ?? at
    };
    const info = {
      ...inputInfo,
      tags: uniq([...tags, ...stringArray(inputInfo.tags)]),
      ...(stringFromMeta(inputInfo, "source") ? { source: sourceAgent } : {}),
      tenant_id: tenantId,
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.profileId ? { profile_id: input.profileId } : {})
    };
    return {
      id: input.id ?? newId(memoryIdPrefix(input.layer, input.kind)),
      timeline: at,
      userId: input.userId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      appId: input.appId,
      memoryType: input.memoryType,
      status: memoryStatus,
      visibility: "private",
      memoryKey: input.key,
      memoryValue: input.value,
      tags,
      info,
      properties: {
        memory_type: input.memoryType,
        status: memoryStatus,
        tags,
        info,
        internal_info: {
          memory_layer: input.layer,
          memory_kind: input.kind,
          schema_version: 1,
          ...inputInternal,
          ...(isRecord(inputInternal.trace)
            ? { trace: { ...inputInternal.trace, tags: semanticTags } }
            : {}),
          provenance
        }
      },
      memoryLayer: input.layer,
      contentHash: stableHash(input.value),
      version: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null
    };
  }

  private assertMemoryAddEnabled(): void {
    if (!this.memoryAddEnabled()) {
      throw new MemoryServiceError("forbidden", "memory add is disabled by config");
    }
  }

  private assertMemorySearchEnabled(): void {
    if (!this.memorySearchEnabled()) {
      throw new MemoryServiceError("forbidden", "memory search is disabled by config");
    }
  }

  private readOnlyCursor(namespace?: RuntimeNamespace): { changeSeq: number; syncCursor: string } {
    const scoped = namespace ? normalizeNamespace(namespace) : undefined;
    const changeSeq = this.repos.runtime.latestChangeSeq(
      scoped?.userId,
      scoped ? namespaceIdFromContext(scoped) : undefined
    );
    return {
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, scoped)
    };
  }

  private openSessionNoWrite(request: SessionOpenRequest): ReturnType<MemoryService["openSession"]> {
    const namespace = normalizeNamespace({
      ...request.namespace,
      source: request.source ?? request.namespace?.source ?? DEFAULT_NAMESPACE_SOURCE,
      profileId: request.profileId ?? request.namespace?.profileId ?? "default",
      projectId: request.projectId ?? request.namespace?.projectId,
      workspaceId: request.workspaceId ?? request.namespace?.workspaceId,
      workspacePath: request.workspacePath ?? request.namespace?.workspacePath
    });
    const existing = request.sessionId
      ? this.repos.runtime.getSession(request.sessionId)
      : namespace.sessionKey
        ? this.repos.runtime.findOpenSessionByHostKey({
            userId: namespace.userId,
            source: request.source ?? namespace.source,
            profileId: request.profileId ?? namespace.profileId,
            hostSessionKey: namespace.sessionKey
          })
        : undefined;
    if (existing) {
      this.assertSessionInScope(existing, request.namespace);
      return {
        sessionId: existing.id,
        userId: existing.userId,
        source: existing.source,
        profileId: existing.profileId,
        projectId: existing.projectId,
        workspaceId: existing.workspaceId,
        conversationId: existing.conversationId,
        status: "open",
        resumed: true,
        openedAt: existing.openedAt,
        serverTime: nowIso()
      };
    }
    const sessionId = request.sessionId ?? `session_${stableHash({
      userId: namespace.userId,
      source: request.source ?? namespace.source,
      profileId: request.profileId ?? namespace.profileId,
      sessionKey: namespace.sessionKey ?? "readonly"
    }).slice(0, 20)}`;
    return {
      sessionId,
      userId: namespace.userId,
      source: request.source ?? namespace.source,
      profileId: request.profileId ?? namespace.profileId,
      projectId: namespace.projectId,
      workspaceId: namespace.workspaceId,
      conversationId: stringFromMeta(request.meta, "conversationId"),
      status: "open",
      resumed: false,
      openedAt: nowIso(),
      serverTime: nowIso()
    };
  }

  private closeSessionNoWrite(sessionId: string, request: RequestEnvelope): ReturnType<MemoryService["closeSession"]> {
    const existing = this.repos.runtime.getSession(sessionId);
    if (existing) {
      this.assertSessionInScope(existing, request.namespace);
    }
    const cursor = this.readOnlyCursor(request.namespace ?? (existing ? namespaceForSession(existing) : undefined));
    return {
      ok: true,
      sessionId,
      status: "closed",
      closedEpisodeIds: [],
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      closedAt: nowIso(),
      serverTime: nowIso()
    };
  }

  private async startTurnNoWrite(
    request: TurnStartRequest & Record<string, unknown>
  ): ReturnType<MemoryService["startTurn"]> {
    const turnId = request.turnId ?? newId("turn");
    const episodeId = `episode_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
    const contextHints = turnStartContextHints(request);
    const search = await this.search({
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: request.namespace,
      sessionId: request.sessionId,
      turnId,
      query: buildSearchQuery({ ...request, contextHints }, this.config.domain),
      layers: ["Skill", "L2", "L1", "L3"],
      limit: this.turnStartRetrievalLimit(),
      contextBudget: typeof request.contextBudget === "number" ? request.contextBudget : undefined,
      includeInjectedContext: true,
      retrievalMode: "turn_start",
      contextHints,
      injectedContextQuery: request.query
    });
    return {
      contextPacketId: `ctx_${stableHash(`${request.sessionId}:${episodeId}:${turnId}:${search.searchEventId}`).slice(0, 20)}`,
      turnId,
      sessionId: request.sessionId,
      episodeId,
      closedEpisodeIds: [],
      searchEventId: search.searchEventId,
      hits: search.hits,
      injectedContext: search.injectedContext,
      sourceMemoryIds: search.sourceMemoryIds,
      droppedDueToBudget: search.droppedDueToBudget,
      status: uniq([...search.status, "memory_add:disabled:no_turn_write"]),
      serverTime: nowIso()
    };
  }

  private completeTurnNoWrite(
    turnId: string,
    request: TurnCompleteRequest & Record<string, unknown>
  ): CompleteTurnResponse {
    const cursor = this.readOnlyCursor(request.namespace);
    const rawTurnId = `raw_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
    const episodeId = request.episodeId ?? `episode_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
    return {
      turnId,
      sessionId: request.sessionId,
      episodeId,
      rawTurnId,
      l1MemoryId: "",
      l1MemoryIds: [],
      closedEpisodeIds: [],
      scheduledEvolution: false,
      jobs: [],
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      etag: stableHash({ memoryAdd: false, sessionId: request.sessionId, turnId }),
      serverTime: nowIso()
    };
  }

  private observeToolNoWrite(input: ToolObserveRequest): Promise<{
    ok: true;
    eventId: string;
    rawTurnId?: string;
    repair?: DecisionRepairSummary;
    changeSeq?: number;
    syncCursor?: string;
    serverTime: string;
  }> {
    const cursor = this.readOnlyCursor(input.namespace);
    return Promise.resolve({
      ok: true,
      eventId: `event_${stableHash({ toolName: input.toolName, sessionId: input.sessionId, turnId: input.turnId }).slice(0, 20)}`,
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      serverTime: nowIso()
    });
  }

  private subagentStartNoWrite(input: SubagentStartRequest): ReturnType<MemoryService["subagentStart"]> {
    const cursor = this.readOnlyCursor(input.namespace);
    const rawTurnId = `raw_${stableHash(`readonly:subagent:${input.sessionId}:${input.subagentId ?? input.task}`).slice(0, 20)}`;
    return {
      ok: true,
      eventId: `event_${stableHash(rawTurnId).slice(0, 20)}`,
      rawTurnId,
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      serverTime: nowIso()
    };
  }

  private runWorkerNoWrite(request: RequestEnvelope): ReturnType<MemoryService["runWorkerOnce"]> {
    const cursor = this.readOnlyCursor(request.namespace);
    return Promise.resolve({
      leased: 0,
      succeeded: 0,
      failed: 0,
      jobs: [],
      embeddingRetries: {
        leased: 0,
        succeeded: 0,
        failed: 0,
        items: []
      },
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      serverTime: nowIso()
    });
  }


  private requireSession(sessionId: string): SessionRecord {
    const session = this.repos.runtime.getSession(sessionId);
    if (!session) {
      throw new MemoryServiceError("not_found", `session not found: ${sessionId}`);
    }
    return session;
  }

  private requireOpenSession(sessionId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    if (session.status !== "open") {
      throw new MemoryServiceError("conflict", `session is closed: ${sessionId}`);
    }
    return session;
  }

  private requireExistingMemory(id: string): MemoryRow {
    const memory = this.repos.memories.get(id);
    if (!memory) {
      throw new MemoryServiceError("not_found", `memory not found: ${id}`);
    }
    return memory;
  }

  private requireRawTurn(rawTurnId: string): RawTurnRecord {
    const rawTurn = this.repos.runtime.getRawTurn(rawTurnId);
    if (!rawTurn) {
      throw new MemoryServiceError("not_found", `raw turn not found: ${rawTurnId}`);
    }
    return rawTurn;
  }

  private traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null {
    if (!memory) return null;
    const rawTurnId = rawTurnIdFromMemory(memory);
    const rawTurn = rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined;
    return traceMetaFromMemoryWithRaw(memory, rawTurn);
  }

  private requireEpisode(episodeId: string): EpisodeRecord {
    const episode = this.repos.runtime.getEpisode(episodeId);
    if (!episode) {
      throw new MemoryServiceError("not_found", `episode not found: ${episodeId}`);
    }
    return episode;
  }

  private assertSessionInScope(session: SessionRecord, namespace?: RuntimeNamespace): void {
    if (namespace && !sameProjectScope(namespaceForSession(session), namespace)) {
      throw new MemoryServiceError("not_found", `session not found: ${session.id}`);
    }
  }

  private assertMemoryInScope(memory: MemoryRow, namespace?: RuntimeNamespace): void {
    if (namespace && !sameProjectScope(this.namespaceForMemoryScope(memory), namespace)) {
      throw new MemoryServiceError("not_found", `memory not found: ${memory.id}`);
    }
  }

  private assertEpisodeInScope(episode: EpisodeRecord, namespace?: RuntimeNamespace): void {
    const session = this.repos.runtime.getSession(episode.sessionId);
    const actual = session
      ? namespaceForSession(session)
      : { source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", userId: episode.userId, projectId: episode.projectId };
    if (namespace && !sameProjectScope(actual, namespace)) {
      throw new MemoryServiceError("not_found", `episode not found: ${episode.id}`);
    }
  }

  private assertRawTurnInScope(rawTurn: RawTurnRecord, namespace?: RuntimeNamespace): void {
    const session = this.repos.runtime.getSession(rawTurn.sessionId);
    const actual = session ? namespaceForSession(session) : namespaceForRawTurn(rawTurn);
    if (namespace && !sameProjectScope(actual, namespace)) {
      throw new MemoryServiceError("not_found", `raw turn not found: ${rawTurn.id}`);
    }
  }

  private namespaceForMemoryScope(memory: MemoryRow): RuntimeNamespace {
    if (memory.sessionId) {
      const session = this.repos.runtime.getSession(memory.sessionId);
      if (session) return namespaceForSession(session);
    }
    return namespaceForMemory(memory);
  }


  private encodeChangeCursor(seq: number, namespace?: RuntimeNamespace): string {
    const capabilities = this.storageCapabilities();
    const payload = {
      v: 1,
      backendId: capabilities.backendId,
      schemaVersion: capabilities.schemaVersion,
      namespaceId: namespace ? namespaceIdFromContext(normalizeNamespace(namespace)) : "",
      seq
    };
    return `cur_${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  }

  private decodeChangeCursor(cursor: string | undefined, namespace?: RuntimeNamespace): number {
    if (!cursor) return 0;
    if (/^\d+$/.test(cursor)) return Number(cursor);
    if (!cursor.startsWith("cur_")) {
      throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8")) as unknown;
    } catch {
      throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
    }
    if (!isRecord(payload) || payload.v !== 1 || typeof payload.seq !== "number") {
      throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
    }
    const capabilities = this.storageCapabilities();
    if (
      payload.backendId !== capabilities.backendId ||
      payload.schemaVersion !== capabilities.schemaVersion
    ) {
      throw new MemoryServiceError("conflict", "change cursor belongs to a different backend or schema");
    }
    return Math.max(0, Math.floor(payload.seq));
  }


  private ensureEpisode(session: SessionRecord, episodeId?: string): EpisodeRecord {
    return this.sessionTurns.ensureEpisode(session, episodeId);
  }

  private resolveContext(request: RequestEnvelope & { sessionId?: string; userId?: string }): {
    userId: string;
    conversationId?: string;
    namespace: RuntimeNamespace;
  } {
    if (request.sessionId) {
      const session = this.repos.runtime.getSession(request.sessionId);
      if (session) {
        this.assertSessionInScope(session, request.namespace);
        return {
          userId: session.userId,
          conversationId: session.conversationId,
          namespace: namespaceForSession(session)
        };
      }
    }
    const namespace = normalizeNamespace(request.namespace);
    const userId = request.userId ?? namespace.userId;
    return {
      userId,
      namespace: {
        ...namespace,
        userId
      }
    };
  }
}

function withDuplicateFlag(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), duplicate: true }
    : value;
}

function stringFromMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" ? value : undefined;
}

function memoryIdPrefix(layer: MemoryLayer, kind: MemoryKind): string {
  if (kind === "span") return "span";
  if (layer === "L1" || kind === "trace") return "trace";
  if (layer === "L2" || kind === "policy") return "policy";
  if (layer === "L3" || kind === "world_model") return "world";
  return "skill";
}


function normalizeRequestTags(tags: readonly string[] | undefined): string[] {
  const reserved = new Set(["trace", "turn", "memmy", "openclaw"]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags ?? []) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (reserved.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}


function renderTraceMemoryValue(step: {
  summary: string;
  rawTurnId?: string;
  stepIndex?: number;
  userText?: string;
  agentText?: string;
  toolCalls: Array<{ name: string; input?: unknown; output?: unknown; error?: string }>;
  reflection: { text: string | null; alpha: number };
  value: number;
  priority: number;
}): string {
  const parts = [
    `Summary: ${step.summary}`,
    step.rawTurnId ? `RawTurn: ${step.rawTurnId}` : undefined,
    typeof step.stepIndex === "number" ? `TraceStep: ${step.stepIndex}` : undefined,
    step.userText ? `User:\n${step.userText}` : undefined,
    step.toolCalls.length
      ? [
          "Tool calls:",
          ...step.toolCalls.map((call) =>
            `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`
          )
        ].join("\n")
      : undefined,
    step.agentText ? `Agent:\n${step.agentText}` : undefined,
    step.reflection.text ? `Reflection: ${clip(step.reflection.text, 800)}` : undefined,
    `Alpha: ${step.reflection.alpha}`,
    `Value: ${step.value}`,
    `Priority: ${step.priority}`
  ].filter(Boolean);
  return parts.join("\n");
}

function sanitizeTraceToolCalls(toolCalls: ToolCallPayload[]): ToolCallPayload[] {
  return toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    success: call.success,
    errorCode: call.errorCode,
    error: call.error ?? errorMessageFromUnknown(call.output),
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    thinkingBefore: call.thinkingBefore,
    assistantTextBefore: call.assistantTextBefore
  }));
}

function memoryStatusForLifecycleStatus(status: "candidate" | "active" | "archived"): "activated" | "resolving" | "archived" {
  if (status === "archived") return "archived";
  return status === "candidate" ? "resolving" : "activated";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}


function importedReembedMemoryIds(tables: Record<string, unknown>, currentEmbeddingModel: string): string[] {
  const ids = new Set<string>();
  for (const row of importedMemoryVectors(tables.memory_vectors)) {
    if (shouldReembedImportedVector(row.embedding_model, row.embedding, currentEmbeddingModel)) {
      ids.add(row.memory_id);
    }
  }
  return [...ids];
}

function importedMemoryVectors(value: unknown): SerializedMemoryVector[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("memory_vectors rows must be objects");
    const vectorField = item.vector_field;
    if (vectorField !== "vec" && vectorField !== "vec_summary" && vectorField !== "vec_action") {
      throw new Error("memory_vectors.vector_field is invalid");
    }
    if (
      typeof item.memory_id !== "string" ||
      typeof item.embedding !== "string" ||
      typeof item.embedding_dim !== "number" ||
      typeof item.updated_at !== "string"
    ) {
      throw new Error("memory_vectors row is incomplete");
    }
    return {
      memory_id: item.memory_id,
      vector_field: vectorField,
      embedding: item.embedding,
      embedding_model: typeof item.embedding_model === "string" ? item.embedding_model : null,
      embedding_provider: typeof item.embedding_provider === "string" ? item.embedding_provider : null,
      embedding_dim: item.embedding_dim,
      updated_at: item.updated_at
    };
  });
}

function shouldReembedImportedVector(
  embeddingModel: unknown,
  embedding: unknown,
  currentEmbeddingModel: string
): boolean {
  if (typeof embeddingModel === "string" && embeddingModel.trim()) {
    return embeddingModel !== currentEmbeddingModel;
  }
  return embedding !== null && embedding !== undefined;
}

function namespaceIdFromMemory(memory: MemoryRow): string {
  return namespaceIdFromContext(namespaceForMemory(memory));
}

function namespaceIdFromSession(session: SessionRecord): string {
  return namespaceIdFromContext(namespaceForSession(session));
}

function namespaceIdFromContext(namespace: RuntimeNamespace): string {
  return canonicalNamespaceIdFromContext(namespace);
}

function scopeBundleTables(
  tables: Record<string, Array<Record<string, unknown>>>,
  namespace: RuntimeNamespace
): Record<string, Array<Record<string, unknown>>> {
  const normalized = normalizeNamespace(namespace);
  const memoryIds = new Set<string>();
  const sessionIds = new Set<string>();
  const episodeIds = new Set<string>();
  const rawTurnIds = new Set<string>();

  const memories = tables.memories ?? [];
  for (const row of memories) {
    const sessionId = stringField(row, "session_id");
    const projectId = memoryProjectId(row, tables.sessions);
    const tenantId = memoryTenantId(row, tables.sessions);
    if (sameProjectScope({ source: "unknown", profileId: "default", projectId, tenantId, userId: stringField(row, "user_id") }, normalized)) {
      const id = stringField(row, "id");
      if (id) memoryIds.add(id);
      if (sessionId) sessionIds.add(sessionId);
    }
  }
  for (const row of tables.sessions ?? []) {
    const id = stringField(row, "id");
    if (!id) continue;
    const projectId = stringField(row, "project_id") ?? jsonStringField(row, "meta_json", "project_id");
    const tenantId = jsonStringField(row, "meta_json", "tenant_id") ?? jsonStringField(row, "meta_json", "tenantId");
    if (sameProjectScope({ source: stringField(row, "source") ?? "unknown", profileId: stringField(row, "profile_id") ?? "default", projectId, tenantId, userId: stringField(row, "user_id") }, normalized)) sessionIds.add(id);
  }
  for (const row of tables.episodes ?? []) {
    const id = stringField(row, "id");
    const sessionId = stringField(row, "session_id");
    if (id && ((sessionId && sessionIds.has(sessionId)) || (!sessionId && sameProjectScope({ source: "unknown", profileId: "default", projectId: stringField(row, "project_id"), tenantId: "local", userId: stringField(row, "user_id") }, normalized)))) episodeIds.add(id);
  }
  for (const row of tables.raw_turns ?? []) {
    const id = stringField(row, "id");
    const sessionId = stringField(row, "session_id");
    const episodeId = stringField(row, "episode_id");
    if (id && ((sessionId && sessionIds.has(sessionId)) || (episodeId && episodeIds.has(episodeId)))) rawTurnIds.add(id);
  }

  const scoped = (table: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> => rows.filter((row) => {
    if (table === "memories") return memoryIds.has(stringField(row, "id") ?? "");
    if (table === "memory_vectors") return memoryIds.has(stringField(row, "memory_id") ?? "");
    if (table === "sessions") return sessionIds.has(stringField(row, "id") ?? "");
    if (table === "episodes") return episodeIds.has(stringField(row, "id") ?? "");
    if (table === "raw_turns") return rawTurnIds.has(stringField(row, "id") ?? "");
    if (table === "memory_relations") return memoryIds.has(stringField(row, "source_memory_id") ?? "") && memoryIds.has(stringField(row, "target_memory_id") ?? "");
    if (table === "memory_change_log") return stringField(row, "namespace_id") === namespaceIdFromContext(normalized) || memoryIds.has(stringField(row, "memory_id") ?? "") || memoryIds.has(stringField(row, "entity_id") ?? "");
    if (table === "embedding_retry_queue" || table === "memory_processing_state") return memoryIds.has(stringField(row, "target_id") ?? stringField(row, "memory_id") ?? "");
    if (table === "trace_policy_links") return memoryIds.has(stringField(row, "l1_memory_id") ?? "") && memoryIds.has(stringField(row, "l2_memory_id") ?? "");
    if (table === "l2_candidate_pool") return memoryIds.has(stringField(row, "source_memory_id") ?? "");
    if (table === "skill_trials") return rowReferencesSets(row, sessionIds, episodeIds, rawTurnIds, memoryIds, ["skill_memory_id", "l1_memory_id"]);
    if (table === "artifacts") return rowReferencesSets(row, sessionIds, episodeIds, rawTurnIds, memoryIds, []);
    if (table === "feedback" || table === "decision_repairs" || table === "evolution_jobs") return rowReferencesSets(row, sessionIds, episodeIds, rawTurnIds, memoryIds, ["l1_memory_id", "target_memory_id"]);
    if (table === "recall_events") return stringField(row, "namespace_id") === namespaceIdFromContext(normalized) || rowReferencesSets(row, sessionIds, episodeIds, rawTurnIds, memoryIds, []);
    if (table === "api_logs" || table === "audit_logs") return bundleLogReferencesScope(row, sessionIds, episodeIds, rawTurnIds, memoryIds, normalized);
    return false;
  });

  const result: Record<string, Array<Record<string, unknown>>> = {};
  for (const [table, rows] of Object.entries(tables)) result[table] = scoped(table, rows);
  return result;
}

function bundleTableRowCount(tables: Record<string, Array<Record<string, unknown>>>): number {
  return Object.values(tables).reduce((total, rows) => total + rows.length, 0);
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value ? value : undefined;
}

function jsonStringField(row: Record<string, unknown>, jsonKey: string, key: string): string | undefined {
  const raw = stringField(row, jsonKey);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[key] === "string" && parsed[key] ? parsed[key] as string : undefined;
  } catch {
    return undefined;
  }
}

function memoryProjectId(row: Record<string, unknown>, sessions: Array<Record<string, unknown>> | undefined): string | undefined {
  const sessionId = stringField(row, "session_id");
  const session = sessions?.find((candidate) => stringField(candidate, "id") === sessionId);
  return stringField(row, "project_id") ?? jsonStringField(row, "info_json", "project_id") ?? stringField(row, "app_id") ?? stringField(session ?? {}, "project_id");
}

function memoryTenantId(row: Record<string, unknown>, sessions: Array<Record<string, unknown>> | undefined): string | undefined {
  const sessionId = stringField(row, "session_id");
  const session = sessions?.find((candidate) => stringField(candidate, "id") === sessionId);
  return jsonStringField(row, "info_json", "tenant_id") ?? jsonStringField(row, "info_json", "tenantId") ?? jsonStringField(session ?? {}, "meta_json", "tenant_id") ?? "local";
}

function rowReferencesSets(
  row: Record<string, unknown>,
  sessions: Set<string>,
  episodes: Set<string>,
  rawTurns: Set<string>,
  memories: Set<string>,
  extraMemoryKeys: string[]
): boolean {
  const refs = [
    ["session_id", sessions], ["episode_id", episodes], ["raw_turn_id", rawTurns],
    ...extraMemoryKeys.map((key) => [key, memories] as const)
  ] as Array<[string, Set<string>]>;
  return refs.some(([key, ids]) => {
    const value = stringField(row, key);
    return Boolean(value && ids.has(value));
  });
}

function bundleLogReferencesScope(
  row: Record<string, unknown>,
  sessions: Set<string>,
  episodes: Set<string>,
  rawTurns: Set<string>,
  memories: Set<string>,
  namespace: RuntimeNamespace
): boolean {
  const actor = parseBundleJson(row.actor_json);
  const input = parseBundleJson(row.input_json);
  const output = parseBundleJson(row.output_json);
  const namespaceRecord = isRecord(actor) ? actor : undefined;
  if (namespaceRecord && sameProjectScope({ source: "unknown", profileId: "default", projectId: stringValue(namespaceRecord, "projectId") ?? stringValue(namespaceRecord, "project_id"), tenantId: stringValue(namespaceRecord, "tenantId") ?? stringValue(namespaceRecord, "tenant_id") }, namespace)) return true;
  return [row, input, output].some((value) => bundleValueReferencesSets(value, sessions, episodes, rawTurns, memories));
}

function bundleValueReferencesSets(value: unknown, sessions: Set<string>, episodes: Set<string>, rawTurns: Set<string>, memories: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => bundleValueReferencesSets(item, sessions, episodes, rawTurns, memories));
  if (!isRecord(value)) return false;
  for (const [key, next] of Object.entries(value)) {
    if (typeof next === "string" && ((key.toLowerCase().includes("session") && sessions.has(next)) || (key.toLowerCase().includes("episode") && episodes.has(next)) || (key.toLowerCase().includes("raw_turn") && rawTurns.has(next)) || ((key.toLowerCase().includes("memory") || key.toLowerCase().includes("trace") || key.toLowerCase().includes("span")) && memories.has(next)))) return true;
    if (bundleValueReferencesSets(next, sessions, episodes, rawTurns, memories)) return true;
  }
  return false;
}

function parseBundleJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function stringValue(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" && value[key] ? value[key] as string : undefined;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function traceMetaFromMemoryWithRaw(memory: MemoryRow, rawTurn?: RawTurnRecord): TraceMeta | null {
  const trace = traceMetaFromMemory(memory);
  if (!trace || !rawTurn) return trace;

  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const rawSpan = isRecord(internalTrace.raw_span) ? internalTrace.raw_span : {};
  const hasUserSpan = rawSpan.user_text === true;
  const hasAgentSpan = rawSpan.agent_text === true;
  const isRedacted = Boolean(rawTurn.redactedAt || rawTurn.deletedAt);

  return {
    ...trace,
    toolCalls: isRedacted
      ? trace.toolCalls
      : rawTurn.toolCalls.filter(isToolCallPayload),
    userText: isRedacted
      ? (hasUserSpan ? "[REDACTED]" : trace.userText)
      : (trace.userText || (hasUserSpan ? rawTurn.userText ?? "" : "")),
    agentText: isRedacted
      ? (hasAgentSpan ? "[REDACTED]" : trace.agentText)
      : (trace.agentText || (hasAgentSpan ? rawTurn.assistantText ?? "" : ""))
  };
}

function rawTurnIdFromMemory(memory: MemoryRow): string | undefined {
  const sourceRawTurnId = memory.properties.internal_info.source_raw_turn_id;
  if (typeof sourceRawTurnId === "string" && sourceRawTurnId) return sourceRawTurnId;
  const rawTurnId = memory.properties.internal_info.raw_turn_id;
  if (typeof rawTurnId === "string" && rawTurnId) return rawTurnId;
  const trace = memory.properties.internal_info.trace;
  return isRecord(trace) ? stringFromRecord(trace, "raw_turn_id") : undefined;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isToolCallPayload(value: unknown): value is ToolCallPayload {
  return isRecord(value) && typeof value.name === "string";
}

function errorMessageFromUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const message = value.error ?? value.message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

function cloneMemmyConfig(config: MemmyConfig): MemmyConfig {
  return structuredClone(config);
}

function normalizeMemorySourceAgent(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized || DEFAULT_NAMESPACE_SOURCE;
}

function normalizeMemoryTagsForSource(tags: string[], sourceAgent: string): string[] {
  const base = tags.map((tag) => tag.trim()).filter(Boolean);
  if (sourceAgent === DEFAULT_NAMESPACE_SOURCE) {
    return uniq(base);
  }
  return uniq([...base, "agent-source", sourceAgent]);
}

function candidateReviewCard(memory: MemoryRow) {
  const internal = memory.properties.internal_info;
  const policy = isRecord(internal.policy) ? internal.policy : {};
  const world = isRecord(internal.world_model) ? internal.world_model : {};
  const skill = isRecord(internal.skill) ? internal.skill : {};
  const confidence = clamp01(firstFiniteNumber(
    memory.info.policy_confidence,
    memory.info.confidence,
    memory.info.eta,
    policy.policy_confidence,
    world.confidence,
    skill.eta
  ) ?? 0);
  const evidenceIds = uniq([
    ...stringArray(internal.source_memory_ids),
    ...stringArray(internal.source_trace_ids),
    ...stringArray(internal.source_policy_ids),
    ...stringArray(internal.evidence_anchor_ids)
  ]).slice(0, 5);
  const episodeIds = uniq([
    ...stringArray(internal.source_episode_ids),
    ...stringArray(policy.source_episode_ids)
  ]);
  return {
    id: memory.id,
    suggestedLayer: memory.memoryLayer,
    title: stringFromMeta(memory.info, "title") ?? stringFromMeta(internal, "title") ?? firstLine(memory.memoryValue),
    conclusion: memory.memoryValue,
    confidence,
    confidenceLabel: confidence >= 0.8 ? "high" : confidence >= 0.6 ? "medium" : "low",
    risk: confidence >= 0.8 && evidenceIds.length >= 2 ? "low" : confidence >= 0.6 ? "medium" : "high",
    evidence: {
      episodeCount: episodeIds.length,
      l1Count: evidenceIds.filter((id) => id.startsWith("trace_")).length,
      ids: evidenceIds
    },
    updatedAt: memory.updatedAt
  };
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(value, 1));
}

function memoryConfigLogFields(config: MemmyConfig): Record<string, unknown> {
  const evolution = resolveEvolutionConfig(config);
  return {
    activeProfile: config.activeProfile,
    memoryAddEnabled: config.algorithm.enableMemoryAdd,
    memorySearchEnabled: config.algorithm.enableMemorySearch,
    summaryModel: {
      provider: config.summary.provider,
      vendor: config.summary.vendor,
      model: config.summary.model,
      maxTokens: config.summary.maxTokens,
      timeoutMs: config.summary.timeoutMs,
      maxRetries: config.summary.maxRetries,
      malformedRetries: config.summary.malformedRetries
    },
    evolutionModel: {
      provider: evolution.provider,
      vendor: evolution.vendor,
      model: evolution.model,
      maxTokens: evolution.maxTokens,
      timeoutMs: evolution.timeoutMs,
      maxRetries: evolution.maxRetries,
      malformedRetries: evolution.malformedRetries
    },
    embeddingModel: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      timeoutMs: config.embedding.timeoutMs,
      maxRetries: config.embedding.maxRetries
    },
    evolutionGates: {
      l2UseLlm: config.algorithm.l2Induction.useLlm,
      l2MinEpisodes: config.algorithm.l2Induction.minEpisodesForInduction,
      l2MinGain: config.algorithm.l2Induction.minGain,
      l3UseLlm: config.algorithm.l3Abstraction.useLlm,
      l3MinPolicies: config.algorithm.l3Abstraction.minPolicies,
      l3MinPolicyGain: config.algorithm.l3Abstraction.minPolicyGain,
      l3MinPolicySupport: config.algorithm.l3Abstraction.minPolicySupport,
      l3ClusterMinSimilarity: config.algorithm.l3Abstraction.clusterMinSimilarity,
      skillUseLlm: config.algorithm.skill.useLlm,
      skillMinSupport: config.algorithm.skill.minSupport,
      skillMinGain: config.algorithm.skill.minGain
    }
  };
}
