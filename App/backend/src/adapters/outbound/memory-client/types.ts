import type { PanelTaskCheckOutput } from "@memmy/local-api-contracts";
import type {PanelLogsInput,PanelLogsOutput,PanelLogDetailOutput} from "@memmy/local-api-contracts";
import type {PanelStatsOutput} from "@memmy/local-api-contracts";
import type { PanelBrowseInput, PanelBrowseOutput } from "@memmy/local-api-contracts";
import type { PanelTaskSummariesOutput, PanelTaskDetailOutput, PanelTaskFieldInput, PanelTaskFieldOutput } from "@memmy/local-api-contracts";
/** Types module. */
import type {
  AddMemoryInput,
  AddMemoryOutput,
  CloseSessionInput,
  CloseSessionOutput,
  DeleteMemoryInput,
  DeleteMemoryOutput,
  DeletePanelTaskOutput,
  CompleteTurnInput,
  CompleteTurnOutput,
  SourceTurnCompleteInput,
  SourceTurnCompleteOutput,
  EnqueueImportSummariesOutput,
  GetMemoryOutput,
  MemoryApiLogsInput,
  MemoryApiLogsOutput,
  MemoryHealthSnapshot,
  MemoryTokenBudgetDto,
  MemoryProcessingStatusOutput,
  MemoryReloadConfigInput,
  MemoryReloadConfigOutput,
  RecallEvidenceOutput,
  PanelAnalysisOutput,
  PanelItemsInput,
  PanelItemsOutput,
  PanelOverviewOutput,
  PanelTasksInput,
  PanelTasksOutput,
  OpenSessionInput,
  OpenSessionOutput,
  SearchInput,
  SearchOutput,
  StartTurnInput,
  StartTurnOutput,
  RetryMemoryProcessingOutput,
  WorkerRunOutput
} from "@memmy/local-api-contracts";

/** Contract for memory client. */
export interface MemoryRequestContext {
  signal?: AbortSignal;
  timeZone?: string;
  userId?: string;
}

export interface ApproveObservedSkillOutput {
  id: string;
  status: "activated";
  serverTime: string;
}

export interface UpdateObservedSkillInput {
  body: string;
  expectedVersion: number;
}

export interface UpdateObservedSkillOutput extends ApproveObservedSkillOutput {
  version: number;
}

export interface AgentSourceScanClient {
  list(): Promise<import("@memmy/local-api-contracts").MemoryAgentSourceList>;
  start(input: import("@memmy/local-api-contracts").AgentSourceScanInput): Promise<import("@memmy/local-api-contracts").AgentSourceScanJobResponse>;
  status(): Promise<import("@memmy/local-api-contracts").MemoryAgentSourceScanState>;
  results(jobId: string, cursor?: string, limit?: number): Promise<import("@memmy/local-api-contracts").ScanResultPage>;
  pause(input?: import("@memmy/local-api-contracts").ScanControlInput): Promise<import("@memmy/local-api-contracts").MemoryScanControlResponse>;
  cancel(input?: import("@memmy/local-api-contracts").ScanControlInput): Promise<import("@memmy/local-api-contracts").MemoryScanControlResponse>;
}

export interface MemoryClient {
  agentSources?: AgentSourceScanClient;
  health(): Promise<MemoryHealthSnapshot>;
  reloadConfig(input?: MemoryReloadConfigInput): Promise<MemoryReloadConfigOutput>;
  getMemoryTokenBudget(): Promise<MemoryTokenBudgetDto>;
  exportBundle?(): Promise<Record<string, unknown>>;
  clearAllData?(): Promise<{ ok: true; clearedAt: string; cleared: Record<string, number> }>;

  openSession(input: OpenSessionInput, context?: MemoryRequestContext): Promise<OpenSessionOutput>;
  closeSession(input: CloseSessionInput & { sessionId: string }, context?: MemoryRequestContext): Promise<CloseSessionOutput>;

  startTurn(input: StartTurnInput, context?: MemoryRequestContext): Promise<StartTurnOutput>;
  completeTurn(input: CompleteTurnInput & { turnId: string }, context?: MemoryRequestContext): Promise<CompleteTurnOutput>;

  completeSourceTurn(input: SourceTurnCompleteInput, context?: MemoryRequestContext): Promise<SourceTurnCompleteOutput>;

  search(input: SearchInput, context?: MemoryRequestContext): Promise<SearchOutput>;
  addMemory(input: AddMemoryInput, context?: MemoryRequestContext): Promise<AddMemoryOutput>;
  getMemory(input: { memoryId: string }, context?: MemoryRequestContext): Promise<GetMemoryOutput>;
  deleteMemory(input: DeleteMemoryInput & { memoryId: string }, context?: MemoryRequestContext): Promise<DeleteMemoryOutput>;
  approveObservedSkill(memoryId: string, context?: MemoryRequestContext): Promise<ApproveObservedSkillOutput>;
  updateObservedSkill(memoryId: string, input: UpdateObservedSkillInput, context?: MemoryRequestContext): Promise<UpdateObservedSkillOutput>;
  recallEvidence(queryId: string, context?: MemoryRequestContext): Promise<RecallEvidenceOutput>;

  enqueueImportSummaries(memoryIds?: string[]): Promise<EnqueueImportSummariesOutput>;
  getMemoryProcessingStatus(memoryIds: string[]): Promise<MemoryProcessingStatusOutput>;
  retryMemoryProcessing(memoryId: string): Promise<RetryMemoryProcessingOutput>;
  runWorker(input: {
    limit: number;
    targetMemoryIds?: string[];
    priorityCohortOnly?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<WorkerRunOutput>;

  panelOverview(context?: MemoryRequestContext): Promise<PanelOverviewOutput>;
  panelAnalysis(context?: MemoryRequestContext): Promise<PanelAnalysisOutput>;
  panelItems(input: PanelItemsInput, context?: MemoryRequestContext): Promise<PanelItemsOutput>;
  panelLogs(input:PanelLogsInput,context?:MemoryRequestContext):Promise<PanelLogsOutput>;
  panelLogDetail(id:number,context?:MemoryRequestContext):Promise<PanelLogDetailOutput>;
  panelStats(context?:MemoryRequestContext):Promise<PanelStatsOutput>;
  panelBrowse(input:PanelBrowseInput,context?:MemoryRequestContext):Promise<PanelBrowseOutput>;
  panelTaskSummaries(input: PanelTasksInput, context?: MemoryRequestContext): Promise<PanelTaskSummariesOutput>;
  panelTaskCheck(id: string, context?: MemoryRequestContext): Promise<PanelTaskCheckOutput>;
  panelTaskDetail(id: string, cursor?: string, context?: MemoryRequestContext): Promise<PanelTaskDetailOutput>;
  panelTaskField(id: string, turnId: string, input: PanelTaskFieldInput, context?: MemoryRequestContext): Promise<PanelTaskFieldOutput>;
  panelTasks(input: PanelTasksInput, context?: MemoryRequestContext): Promise<PanelTasksOutput>;
  deletePanelTask(taskId: string, context?: MemoryRequestContext): Promise<DeletePanelTaskOutput>;
  memoryApiLogs(input: MemoryApiLogsInput, context?: MemoryRequestContext): Promise<MemoryApiLogsOutput>;
}
