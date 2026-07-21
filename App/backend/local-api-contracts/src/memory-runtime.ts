/** Memory runtime module. */
import { z } from "zod";

/** Schema for iso time. */
export const IsoTimeSchema = z.string().datetime();
export type IsoTime = z.infer<typeof IsoTimeSchema>;

/** Schema for cursor. */
export const CursorSchema = z.string();
export type Cursor = z.infer<typeof CursorSchema>;

/** Schema for memory kind. */
export const MemoryKindSchema = z.enum(["trace", "policy", "world_model", "skill"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

/** Schema for memory layer. */
export const MemoryLayerSchema = z.enum(["L1", "L2", "L3", "Skill"]);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

/** Schema for memory status. */
export const MemoryStatusSchema = z.enum(["activated", "resolving", "archived", "deleted"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/** Schema for job status. */
export const JobStatusSchema = z.enum(["queued", "leased", "succeeded", "failed", "dead_letter"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Schema for job type. */
export const JobTypeSchema = z.enum([
  "episode_idle_close",
  "trace_summary",
  "import_summary",
  "reflection",
  "embedding",
  "reward",
  "l2_association",
  "l2_induction",
  "l3_abstraction",
  "skill_crystallization",
  "skill_trial_resolve"
]);
export type JobType = z.infer<typeof JobTypeSchema>;

const NonEmptyStringSchema = z.string().min(1);
const UnknownRecordSchema = z.record(z.string(), z.unknown());

export const InjectedContextSectionSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  kind: MemoryKindSchema,
  memoryLayer: MemoryLayerSchema,
  memoryIds: z.array(NonEmptyStringSchema),
  content: z.string(),
  tokenEstimate: z.number().int().nonnegative().optional()
});

/** Schema for injected context. */
export const InjectedContextSchema = z.object({
  markdown: z.string(),
  sections: z.array(InjectedContextSectionSchema),
  tokenEstimate: z.number().int().nonnegative().optional()
});
export type InjectedContext = z.infer<typeof InjectedContextSchema>;

/** Schema for recall hit. */
export const RecallHitSchema = z.object({
  id: NonEmptyStringSchema,
  kind: MemoryKindSchema,
  memoryLayer: MemoryLayerSchema,
  status: MemoryStatusSchema,
  title: z.string().optional(),
  snippet: z.string(),
  score: z.number(),
  tags: z.array(z.string()),
  updatedAt: IsoTimeSchema.optional(),
  source: z.enum(["search", "episode", "rule", "skill"])
});
export type RecallHit = z.infer<typeof RecallHitSchema>;

/** Schema for memory metrics. */
export const MemoryMetricsSchema = z.object({
  value: z.number().optional(),
  alpha: z.number().optional(),
  reflectionDone: z.boolean()
});
export type MemoryMetrics = z.infer<typeof MemoryMetricsSchema>;

export const MemoryProcessingStateSchema = z.enum([
  "summary_pending",
  "summarizing",
  "embedding_pending",
  "embedding",
  "ready",
  "ready_text_only",
  "failed"
]);
export type MemoryProcessingState = z.infer<typeof MemoryProcessingStateSchema>;

export const MemoryProcessingRecordSchema = z.object({
  memoryId: NonEmptyStringSchema,
  state: MemoryProcessingStateSchema,
  stage: z.enum(["summary", "embedding"]).nullable().optional(),
  activeJobId: NonEmptyStringSchema.nullable().optional(),
  attemptCount: z.number().int().nonnegative(),
  manualRetryCount: z.number().int().nonnegative(),
  retryAction: z.enum(["retry", "open_settings", "none"]),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  failedAt: IsoTimeSchema.nullable().optional(),
  updatedAt: IsoTimeSchema
});
export type MemoryProcessingRecord = z.infer<typeof MemoryProcessingRecordSchema>;

export const MemoryListItemSchema = z.object({
  id: NonEmptyStringSchema,
  kind: MemoryKindSchema,
  memoryLayer: MemoryLayerSchema,
  status: MemoryStatusSchema,
  title: NonEmptyStringSchema,
  summary: z.string(),
  tags: z.array(z.string()),
  processing: MemoryProcessingRecordSchema.optional(),
  metrics: MemoryMetricsSchema.optional(),
  metadata: UnknownRecordSchema.optional(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  version: z.number().int().nonnegative()
});
export type MemoryListItem = z.infer<typeof MemoryListItemSchema>;

/** Definition for memory detail item. */
export const MemoryDetailItemSchema = MemoryListItemSchema.extend({
  body: z.string(),
  createdAt: IsoTimeSchema,
  sourceMemoryIds: z.array(NonEmptyStringSchema),
  metadata: UnknownRecordSchema
});
export type MemoryDetailItem = z.infer<typeof MemoryDetailItemSchema>;

/** Schema for raw turn summary. */
export const RawTurnSummarySchema = z.object({
  rawTurnId: NonEmptyStringSchema,
  episodeId: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema,
  userText: z.string().optional(),
  assistantText: z.string().optional(),
  reasoningSummary: z.string().optional(),
  toolCalls: z.array(z.unknown()).optional(),
  toolResults: z.array(z.unknown()).optional(),
  createdAt: IsoTimeSchema
});
export type RawTurnSummary = z.infer<typeof RawTurnSummarySchema>;

/** Schema for episode ref. */
export const EpisodeRefSchema = z.object({
  id: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  title: z.string().optional(),
  summary: z.string().optional(),
  status: z.enum(["open", "processing", "closed"]),
  startedAt: IsoTimeSchema.optional(),
  endedAt: IsoTimeSchema.optional(),
  turnCount: z.number().int().nonnegative().optional(),
  rTask: z.number().optional(),
  rewardSkipped: z.boolean().optional(),
  rewardReason: z.string().optional(),
  closeReason: z.string().optional(),
  topicState: z.string().optional(),
  abandonReason: z.string().optional(),
  pipelineStatus: z.enum(["idle", "running", "succeeded", "failed"]).optional(),
  pipelineError: z.string().optional(),
  skillMemoryIds: z.array(NonEmptyStringSchema).optional(),
  linkedSkillId: NonEmptyStringSchema.optional(),
  skillStatus: z.string().optional(),
  skillReason: z.string().optional()
});
export type EpisodeRef = z.infer<typeof EpisodeRefSchema>;

/** Schema for job ref. */
export const JobRefSchema = z.object({
  jobId: NonEmptyStringSchema,
  jobType: JobTypeSchema,
  status: JobStatusSchema,
  targetMemoryId: NonEmptyStringSchema.optional()
});
export type JobRef = z.infer<typeof JobRefSchema>;

/** Schema for runtime request fields. */
const RuntimeRequestFieldsSchema = z.object({
  requestId: NonEmptyStringSchema.optional(),
  adapterId: NonEmptyStringSchema.optional(),
  source: NonEmptyStringSchema.optional()
});

export const MemoryActiveProfileSchema = z.enum(["account", "byok"]);
export type MemoryActiveProfile = z.infer<typeof MemoryActiveProfileSchema>;

export const MemoryModelStatusSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  configured: z.boolean(),
  remote: z.boolean(),
  lastOkAt: IsoTimeSchema.optional(),
  lastError: z.string().optional()
});
export type MemoryModelStatus = z.infer<typeof MemoryModelStatusSchema>;

export const MemoryModelsStatusSchema = z.object({
  summary: MemoryModelStatusSchema,
  evolution: MemoryModelStatusSchema,
  embedding: MemoryModelStatusSchema
});
export type MemoryModelsStatus = z.infer<typeof MemoryModelsStatusSchema>;

/** Schema for memory health snapshot. */
export const MemoryHealthSnapshotSchema = z.object({
  ok: z.boolean(),
  version: NonEmptyStringSchema,
  uptimeMs: z.number().nonnegative(),
  mode: z.enum(["local", "cloud", "dev"]),
  storage: z.object({
    backend: z.enum(["sqlite", "polardb"]),
    schemaVersion: NonEmptyStringSchema,
    ready: z.boolean(),
    lastMigrationId: z.string().optional()
  }),
  capabilities: z.object({
    routes: z.array(z.string()),
    tools: z.array(z.string()),
    memoryLayers: z.array(MemoryLayerSchema),
    supportsCli: z.boolean()
  }),
  activeProfile: MemoryActiveProfileSchema,
  models: MemoryModelsStatusSchema,
  serverTime: IsoTimeSchema
});
export type MemoryHealthSnapshot = z.infer<typeof MemoryHealthSnapshotSchema>;

export const MemoryReloadConfigInputSchema = RuntimeRequestFieldsSchema.extend({
  reason: z.string().optional(),
  restartFailedProcessing: z.boolean().optional()
});
export type MemoryReloadConfigInput = z.infer<typeof MemoryReloadConfigInputSchema>;

export const MemoryReloadConfigOutputSchema = z.object({
  activeProfile: MemoryActiveProfileSchema,
  changed: z.boolean(),
  requiresRestart: z.boolean(),
  models: MemoryModelsStatusSchema,
  reloadedAt: IsoTimeSchema
});
export type MemoryReloadConfigOutput = z.infer<typeof MemoryReloadConfigOutputSchema>;

/** Definition for open session input. */
export const OpenSessionInputSchema = RuntimeRequestFieldsSchema.extend({
  sessionId: NonEmptyStringSchema.optional(),
  workspacePath: z.string().optional()
});
export type OpenSessionInput = z.infer<typeof OpenSessionInputSchema>;

/** Schema for open session output. */
export const OpenSessionOutputSchema = z.object({
  sessionId: NonEmptyStringSchema,
  status: z.literal("open"),
  episodeId: NonEmptyStringSchema.optional(),
  resumed: z.boolean(),
  serverTime: IsoTimeSchema
});
export type OpenSessionOutput = z.infer<typeof OpenSessionOutputSchema>;

/** Definition for close session input. */
export const CloseSessionInputSchema = RuntimeRequestFieldsSchema.passthrough();
export type CloseSessionInput = z.infer<typeof CloseSessionInputSchema>;

/** Schema for close session output. */
export const CloseSessionOutputSchema = z.object({
  ok: z.literal(true),
  sessionId: NonEmptyStringSchema,
  status: z.literal("closed"),
  closedEpisodeIds: z.array(NonEmptyStringSchema),
  changeSeq: z.number().int().nonnegative().optional(),
  syncCursor: CursorSchema.optional(),
  serverTime: IsoTimeSchema
});
export type CloseSessionOutput = z.infer<typeof CloseSessionOutputSchema>;

/** Definition for start turn input. */
export const StartTurnInputSchema = RuntimeRequestFieldsSchema.extend({
  sessionId: NonEmptyStringSchema,
  query: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema.optional(),
  contextHints: UnknownRecordSchema.optional(),
  contextBudget: z.number().int().nonnegative().optional()
});
export type StartTurnInput = z.infer<typeof StartTurnInputSchema>;

/** Schema for start turn output. */
export const StartTurnOutputSchema = z.object({
  turnId: NonEmptyStringSchema,
  contextPacketId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  episodeId: NonEmptyStringSchema,
  injectedContext: InjectedContextSchema,
  searchEventId: NonEmptyStringSchema,
  sourceMemoryIds: z.array(NonEmptyStringSchema),
  hits: z.array(RecallHitSchema),
  status: z.array(z.string()),
  serverTime: IsoTimeSchema
});
export type StartTurnOutput = z.infer<typeof StartTurnOutputSchema>;

/** Definition for complete turn input. */
export const CompleteTurnInputSchema = RuntimeRequestFieldsSchema.extend({
  sessionId: NonEmptyStringSchema,
  episodeId: NonEmptyStringSchema.optional(),
  query: NonEmptyStringSchema,
  answer: NonEmptyStringSchema,
  reasoningSummary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  toolCalls: z.array(z.unknown()).optional(),
  toolResults: z.array(z.unknown()).optional(),
  artifacts: z.array(z.unknown()).optional(),
  sourceMemoryIds: z.array(NonEmptyStringSchema).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["succeeded", "failed", "cancelled"]).optional()
});
export type CompleteTurnInput = z.infer<typeof CompleteTurnInputSchema>;

/** Schema for complete turn output. */
export const CompleteTurnOutputSchema = z.object({
  turnId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  episodeId: NonEmptyStringSchema,
  rawTurnId: NonEmptyStringSchema,
  l1MemoryId: NonEmptyStringSchema,
  scheduledEvolution: z.boolean(),
  jobs: z.array(JobRefSchema),
  changeSeq: z.number().int().nonnegative(),
  serverTime: IsoTimeSchema
});
export type CompleteTurnOutput = z.infer<typeof CompleteTurnOutputSchema>;

/** Definition for search input. */
export const SearchInputSchema = RuntimeRequestFieldsSchema.extend({
  query: NonEmptyStringSchema,
  sessionId: z.string().optional(),
  layers: z.array(MemoryLayerSchema).optional(),
  verbose: z.boolean().optional()
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

/** Schema for default search output. */
export const DefaultSearchOutputSchema = z.object({
  injectedContext: z.string()
}).strict();

export const VerboseSearchDebugSchema = z.object({
  searchEventId: NonEmptyStringSchema,
  hits: z.array(RecallHitSchema),
  sourceMemoryIds: z.array(NonEmptyStringSchema),
  status: z.array(z.string()),
  sections: z.array(InjectedContextSectionSchema),
  tokenEstimate: z.number().int().nonnegative().optional(),
  serverTime: IsoTimeSchema
});

export const VerboseSearchOutputSchema = z.object({
  injectedContext: z.string(),
  debug: VerboseSearchDebugSchema
}).strict();
export const SearchOutputSchema = z.union([VerboseSearchOutputSchema, DefaultSearchOutputSchema]);
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

/** Definition for add memory input. */
export const AddMemoryInputSchema = RuntimeRequestFieldsSchema.extend({
  content: NonEmptyStringSchema,
  layer: MemoryLayerSchema.optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  createdAt: IsoTimeSchema.optional(),
  deferProcessing: z.boolean().optional()
});
export type AddMemoryInput = z.infer<typeof AddMemoryInputSchema>;

/** Schema for add memory output. */
export const AddMemoryOutputSchema = z.object({
  id: NonEmptyStringSchema,
  kind: MemoryKindSchema,
  memoryLayer: MemoryLayerSchema,
  status: MemoryStatusSchema,
  title: NonEmptyStringSchema,
  summary: z.string(),
  tags: z.array(z.string()),
  createdAt: IsoTimeSchema,
  serverTime: IsoTimeSchema
});
export type AddMemoryOutput = z.infer<typeof AddMemoryOutputSchema>;

/** Schema for get memory output. */
export const GetMemoryOutputSchema = z.object({
  item: MemoryDetailItemSchema.extend({
    trace: z
      .object({
        episodeId: NonEmptyStringSchema,
        rawTurnId: NonEmptyStringSchema,
        turnId: NonEmptyStringSchema
      })
      .optional(),
    policy: z
      .object({
        utilityScore: z.number().optional(),
        confidence: z.number().optional(),
        evidenceMemoryIds: z.array(NonEmptyStringSchema),
        repairHints: z.array(z.string()).optional()
      })
      .optional(),
    worldModel: z
      .object({
        sourceMemoryIds: z.array(NonEmptyStringSchema),
        confidence: z.number().optional()
      })
      .optional(),
    skill: z
      .object({
        invocationGuide: z.string(),
        procedure: z.array(z.string()).optional(),
        sourcePolicyIds: z.array(NonEmptyStringSchema),
        sourceWorldModelIds: z.array(NonEmptyStringSchema),
        reliabilityScore: z.number().optional(),
        utilityScore: z.number().optional(),
        evidenceCount: z.number().int().nonnegative().optional()
      })
      .optional()
  }),
  refs: z
    .object({
      rawTurn: RawTurnSummarySchema.optional(),
      episode: EpisodeRefSchema.optional(),
      policyLinks: z
        .array(
          z.object({
            policyMemoryId: NonEmptyStringSchema,
            traceMemoryId: NonEmptyStringSchema,
            relation: NonEmptyStringSchema
          })
        )
        .optional(),
      skillTrials: z
        .array(
          z.object({
            trialId: NonEmptyStringSchema,
            status: z.enum(["pending", "pass", "fail", "unknown"]),
            episodeId: NonEmptyStringSchema.optional(),
            reward: z.number().optional()
          })
        )
        .optional()
    })
    .optional(),
  version: z.number().int().nonnegative(),
  etag: z.string().optional()
});
export type GetMemoryOutput = z.infer<typeof GetMemoryOutputSchema>;

/** Definition for delete memory input. */
export const DeleteMemoryInputSchema = RuntimeRequestFieldsSchema;
export type DeleteMemoryInput = z.infer<typeof DeleteMemoryInputSchema>;

/** Schema for delete memory output. */
export const DeleteMemoryOutputSchema = z.object({
  ok: z.literal(true),
  id: NonEmptyStringSchema,
  kind: MemoryKindSchema,
  status: z.literal("deleted"),
  changeSeq: z.number().int().nonnegative(),
  syncCursor: CursorSchema,
  auditId: NonEmptyStringSchema.optional(),
  serverTime: IsoTimeSchema
});
export type DeleteMemoryOutput = z.infer<typeof DeleteMemoryOutputSchema>;

/** Schema for worker run output. */
export const WorkerRunOutputSchema = z.object({
  leased: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  jobs: z.array(JobRefSchema),
  embeddingRetries: z.object({
    leased: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    items: z.array(z.object({
      id: NonEmptyStringSchema,
      status: z.string(),
      targetKind: z.string(),
      targetMemoryId: NonEmptyStringSchema,
      vectorField: z.string(),
      attempts: z.number().int().nonnegative(),
      lastError: z.string().nullable().optional()
    }))
  }),
  changeSeq: z.number().int().nonnegative(),
  syncCursor: CursorSchema,
  serverTime: IsoTimeSchema
});
export type WorkerRunOutput = z.infer<typeof WorkerRunOutputSchema>;

/** Schema for enqueue import summaries output. */
export const EnqueueImportSummariesOutputSchema = z.object({
  enqueued: z.number().int().nonnegative(),
  memoryIds: z.array(NonEmptyStringSchema),
  serverTime: IsoTimeSchema
});
export type EnqueueImportSummariesOutput = z.infer<typeof EnqueueImportSummariesOutputSchema>;

export const MemoryProcessingStatusInputSchema = RuntimeRequestFieldsSchema.extend({
  memoryIds: z.array(NonEmptyStringSchema).max(10_000)
});
export type MemoryProcessingStatusInput = z.infer<typeof MemoryProcessingStatusInputSchema>;

export const MemoryProcessingStatusOutputSchema = z.object({
  items: z.array(MemoryProcessingRecordSchema),
  serverTime: IsoTimeSchema
});
export type MemoryProcessingStatusOutput = z.infer<typeof MemoryProcessingStatusOutputSchema>;

export const RetryMemoryProcessingOutputSchema = z.object({
  accepted: z.boolean(),
  processing: MemoryProcessingRecordSchema,
  job: JobRefSchema.optional(),
  serverTime: IsoTimeSchema
});
export type RetryMemoryProcessingOutput = z.infer<typeof RetryMemoryProcessingOutputSchema>;

/** Schema for panel items input. */
export const PanelItemsInputSchema = z.object({
  layer: MemoryLayerSchema.optional(),
  status: MemoryStatusSchema.optional(),
  q: z.string().optional(),
  sourceAgent: z.string().trim().min(1).optional(),
  excludedSourceAgents: z.array(z.string().trim().min(1)).optional(),
  page: z.coerce.number().int().positive().optional()
});
export type PanelItemsInput = z.infer<typeof PanelItemsInputSchema>;

/** Schema for panel task list input. */
export const PanelTasksInputSchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().positive().optional()
});
export type PanelTasksInput = z.infer<typeof PanelTasksInputSchema>;

/** Schema for memory api log tool name. */
export const MemoryApiLogToolNameSchema = z.enum(["memory_add", "memory_search", "skill_generate", "skill_evolve"]);
export type MemoryApiLogToolName = z.infer<typeof MemoryApiLogToolNameSchema>;

/** Schema for memory api logs input. */
export const MemoryApiLogsInputSchema = z.object({
  tools: z.array(MemoryApiLogToolNameSchema).optional(),
  sourceAgent: z.string().trim().min(1).optional(),
  excludedSourceAgents: z.array(z.string().trim().min(1)).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional()
});
export type MemoryApiLogsInput = z.infer<typeof MemoryApiLogsInputSchema>;

/** Schema for panel change kind. */
export const PanelChangeKindSchema = z.union([
  MemoryKindSchema,
  z.enum(["session", "episode", "job", "feedback", "raw_turn", "repair", "skill_trial", "recall", "artifact"])
]);
export type PanelChangeKind = z.infer<typeof PanelChangeKindSchema>;

/** Schema for panel changes input. */
export const PanelChangesInputSchema = z.object({
  cursor: CursorSchema.optional(),
  kind: PanelChangeKindSchema.optional(),
  limit: z.coerce.number().int().positive().optional()
});
export type PanelChangesInput = z.infer<typeof PanelChangesInputSchema>;

/** Schema for panel jobs input. */
export const PanelJobsInputSchema = z.object({
  status: JobStatusSchema.optional(),
  jobType: JobTypeSchema.optional(),
  targetMemoryId: z.string().optional(),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().positive().optional()
});
export type PanelJobsInput = z.infer<typeof PanelJobsInputSchema>;

/** Schema for panel overview output. */
export const PanelOverviewOutputSchema = z.object({
  counts: z.object({
    memories: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    experiences: z.number().int().nonnegative(),
    worldModels: z.number().int().nonnegative()
  }),
  dailyActivity: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: z.number().int().nonnegative()
  })),
  sourceDistribution: z.array(z.object({
    source: z.string().min(1),
    count: z.number().int().nonnegative(),
    percentage: z.number().min(0).max(100)
  }))
});
export type PanelOverviewOutput = z.infer<typeof PanelOverviewOutputSchema>;

/** Schema for panel analysis output. */
export const PanelAnalysisOutputSchema = z.object({
  metrics: z.object({
    avgRecallScore: z.number().nonnegative(),
    recallEvents: z.number().int().nonnegative(),
    activeSkills: z.number().int().nonnegative(),
    recentlyUsedSkills: z.number().int().nonnegative(),
    avgToolLatencyMs: z.number().int().nonnegative(),
    p95ToolLatencyMs: z.number().int().nonnegative()
  }),
  dailyMemoryWrites: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: z.number().int().nonnegative()
  })),
  dailySkillEvolutions: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: z.number().int().nonnegative()
  })),
  toolLatency: z.object({
    tools: z.array(z.object({
      name: z.string().min(1),
      calls: z.number().int().nonnegative(),
      avgMs: z.number().int().nonnegative(),
      p95Ms: z.number().int().nonnegative()
    })),
    series: z.array(z.object({
      name: z.string().min(1),
      points: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        avgMs: z.number().int().nonnegative()
      }))
    }))
  })
});
export type PanelAnalysisOutput = z.infer<typeof PanelAnalysisOutputSchema>;

/** Schema for panel items output. */
export const PanelItemsOutputSchema = z.object({
  items: z.array(MemoryListItemSchema),
  page: z.number().int().positive(),
  pageSize: z.literal(20),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
  serverTime: IsoTimeSchema
});
export type PanelItemsOutput = z.infer<typeof PanelItemsOutputSchema>;

/** Schema for a task shown in the memory panel. */
export const PanelTaskItemSchema = z.object({
  id: NonEmptyStringSchema,
  episode: EpisodeRefSchema,
  memoryIds: z.array(NonEmptyStringSchema),
  turns: z.array(RawTurnSummarySchema),
  updatedAt: IsoTimeSchema
});
export type PanelTaskItem = z.infer<typeof PanelTaskItemSchema>;

/** Schema for panel task list output. */
export const PanelTasksOutputSchema = z.object({
  tasks: z.array(PanelTaskItemSchema),
  page: z.number().int().positive(),
  pageSize: z.literal(20),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
  serverTime: IsoTimeSchema
});
export type PanelTasksOutput = z.infer<typeof PanelTasksOutputSchema>;

/** Schema for deleting a task from the memory panel. */
export const DeletePanelTaskOutputSchema = z.object({
  ok: z.literal(true),
  id: NonEmptyStringSchema,
  deletedMemoryIds: z.array(NonEmptyStringSchema),
  serverTime: IsoTimeSchema
});
export type DeletePanelTaskOutput = z.infer<typeof DeletePanelTaskOutputSchema>;

/** Schema for memory api log. */
export const MemoryApiLogSchema = z.object({
  id: z.number().int().nonnegative(),
  toolName: MemoryApiLogToolNameSchema,
  sourceAgent: NonEmptyStringSchema.optional(),
  inputJson: z.string(),
  outputJson: z.string(),
  durationMs: z.number().int().nonnegative(),
  success: z.boolean(),
  calledAt: IsoTimeSchema
});
export type MemoryApiLog = z.infer<typeof MemoryApiLogSchema>;

/** Schema for memory api logs output. */
export const MemoryApiLogsOutputSchema = z.object({
  logs: z.array(MemoryApiLogSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().optional(),
  serverTime: IsoTimeSchema
});
export type MemoryApiLogsOutput = z.infer<typeof MemoryApiLogsOutputSchema>;

/** Schema for panel item detail output. */
export const PanelItemDetailOutputSchema = z.object({
  item: MemoryDetailItemSchema,
  version: z.number().int().nonnegative(),
  etag: NonEmptyStringSchema
});
export type PanelItemDetailOutput = z.infer<typeof PanelItemDetailOutputSchema>;

/** Schema for panel changes output. */
export const PanelChangesOutputSchema = z.object({
  cursor: CursorSchema,
  serverTime: IsoTimeSchema,
  changes: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      op: z.enum(["created", "updated", "archived", "deleted"]),
      kind: PanelChangeKindSchema,
      id: NonEmptyStringSchema,
      version: z.number().int().nonnegative().optional(),
      source: z.enum(["turn_complete", "feedback", "worker", "panel", "system"]),
      updatedAt: IsoTimeSchema
    })
  ),
  hasMore: z.boolean()
});
export type PanelChangesOutput = z.infer<typeof PanelChangesOutputSchema>;

/** Schema for panel jobs output. */
export const PanelJobsOutputSchema = z.object({
  jobs: z.array(
    z.object({
      id: NonEmptyStringSchema,
      jobType: JobTypeSchema,
      status: JobStatusSchema,
      targetMemoryId: NonEmptyStringSchema.optional(),
      createdAt: IsoTimeSchema,
      updatedAt: IsoTimeSchema,
      error: z
        .object({
          code: NonEmptyStringSchema,
          message: z.string()
        })
        .optional()
    })
  ),
  nextCursor: CursorSchema.optional()
});
export type PanelJobsOutput = z.infer<typeof PanelJobsOutputSchema>;

/** Schema for api error code. */
export const ApiErrorCodeSchema = z.enum([
  "invalid_argument",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
  "memory_layer_unavailable",
  "missing_idempotency_key",
  "idempotency_body_mismatch",
  "scan_not_permitted",
  "memory_recall_not_permitted",
  "skill_write_not_permitted",
  "agent_source_unavailable",
  "composio_not_configured",
  "toolkit_unsupported"
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Schema for api error body. */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    requestId: NonEmptyStringSchema
  })
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
