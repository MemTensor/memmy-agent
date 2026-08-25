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
  EnqueueImportSummariesOutput,
  GetMemoryOutput,
  MemoryApiLogsInput,
  MemoryApiLogsOutput,
  MemoryHealthSnapshot,
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
  timeZone?: string;
  userId?: string;
}

export interface MemoryClient {
  health(): Promise<MemoryHealthSnapshot>;
  reloadConfig(input?: MemoryReloadConfigInput): Promise<MemoryReloadConfigOutput>;

  openSession(input: OpenSessionInput, context?: MemoryRequestContext): Promise<OpenSessionOutput>;
  closeSession(input: CloseSessionInput & { sessionId: string }, context?: MemoryRequestContext): Promise<CloseSessionOutput>;

  startTurn(input: StartTurnInput, context?: MemoryRequestContext): Promise<StartTurnOutput>;
  completeTurn(input: CompleteTurnInput & { turnId: string }, context?: MemoryRequestContext): Promise<CompleteTurnOutput>;

  search(input: SearchInput, context?: MemoryRequestContext): Promise<SearchOutput>;
  addMemory(input: AddMemoryInput, context?: MemoryRequestContext): Promise<AddMemoryOutput>;
  getMemory(input: { memoryId: string }, context?: MemoryRequestContext): Promise<GetMemoryOutput>;
  deleteMemory(input: DeleteMemoryInput & { memoryId: string }, context?: MemoryRequestContext): Promise<DeleteMemoryOutput>;
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
  panelTasks(input: PanelTasksInput, context?: MemoryRequestContext): Promise<PanelTasksOutput>;
  deletePanelTask(taskId: string, context?: MemoryRequestContext): Promise<DeletePanelTaskOutput>;
  memoryApiLogs(input: MemoryApiLogsInput, context?: MemoryRequestContext): Promise<MemoryApiLogsOutput>;
}
