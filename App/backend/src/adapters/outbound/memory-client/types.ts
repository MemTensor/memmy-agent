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
  MemoryReloadConfigInput,
  MemoryReloadConfigOutput,
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
  WorkerRunOutput
} from "@memmy/local-api-contracts";

/** Contract for memory client. */
export interface MemoryClient {
  health(): Promise<MemoryHealthSnapshot>;
  reloadConfig(input?: MemoryReloadConfigInput): Promise<MemoryReloadConfigOutput>;

  openSession(input: OpenSessionInput): Promise<OpenSessionOutput>;
  closeSession(input: CloseSessionInput & { sessionId: string }): Promise<CloseSessionOutput>;

  startTurn(input: StartTurnInput): Promise<StartTurnOutput>;
  completeTurn(input: CompleteTurnInput & { turnId: string }): Promise<CompleteTurnOutput>;

  search(input: SearchInput): Promise<SearchOutput>;
  addMemory(input: AddMemoryInput): Promise<AddMemoryOutput>;
  getMemory(input: { memoryId: string }): Promise<GetMemoryOutput>;
  deleteMemory(input: DeleteMemoryInput & { memoryId: string }): Promise<DeleteMemoryOutput>;

  enqueueImportSummaries(): Promise<EnqueueImportSummariesOutput>;
  runWorker(input: { limit: number; signal?: AbortSignal; timeoutMs?: number }): Promise<WorkerRunOutput>;

  panelOverview(): Promise<PanelOverviewOutput>;
  panelAnalysis(): Promise<PanelAnalysisOutput>;
  panelItems(input: PanelItemsInput): Promise<PanelItemsOutput>;
  panelTasks(input: PanelTasksInput): Promise<PanelTasksOutput>;
  deletePanelTask(taskId: string): Promise<DeletePanelTaskOutput>;
  memoryApiLogs(input: MemoryApiLogsInput): Promise<MemoryApiLogsOutput>;
}
