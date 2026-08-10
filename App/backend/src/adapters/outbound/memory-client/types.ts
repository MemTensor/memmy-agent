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
  MemoryHistoryOutput,
  MemoryProcessingStatusOutput,
  MemoryReloadConfigInput,
  MemoryReloadConfigOutput,
  PanelAnalysisOutput,
  PanelItemsInput,
  PanelItemsOutput,
  PanelOverviewOutput,
  ProjectContextPackOutput,
  ProjectContextFocusInput,
  ProjectContextGoalDecisionInput,
  ProjectContextProposeGoalInput,
  ProjectContextReadState,
  ProjectContextWorkItemCreateInput,
  ProjectContextWorkItemUpdateInput,
  ProjectGoalRecord,
  ProjectWorkItemRecord,
  RuntimeNamespace,
  PanelTasksInput,
  PanelTasksOutput,
  OpenSessionInput,
  OpenSessionOutput,
  SearchInput,
  SearchOutput,
  StartTurnInput,
  StartTurnOutput,
  RetryMemoryProcessingOutput,
  RestoreMemoryInput,
  RestoreMemoryOutput,
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
  memoryHistory(memoryId: string): Promise<MemoryHistoryOutput>;
  restoreMemory(input: RestoreMemoryInput & { memoryId: string; targetVersion: number }): Promise<RestoreMemoryOutput>;
  deleteMemory(input: DeleteMemoryInput & { memoryId: string }): Promise<DeleteMemoryOutput>;

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

  panelOverview(): Promise<PanelOverviewOutput>;
  panelAnalysis(): Promise<PanelAnalysisOutput>;
  projectContextPack(projectId: string): Promise<ProjectContextPackOutput>;
  projectContextState(namespace: RuntimeNamespace): Promise<ProjectContextReadState>;
  proposeProjectGoal(input: ProjectContextProposeGoalInput): Promise<ProjectGoalRecord>;
  approveProjectGoal(goalId: string, input: ProjectContextGoalDecisionInput): Promise<ProjectGoalRecord>;
  rejectProjectGoal(goalId: string, input: ProjectContextGoalDecisionInput): Promise<ProjectGoalRecord>;
  createProjectWorkItem(input: ProjectContextWorkItemCreateInput): Promise<ProjectWorkItemRecord>;
  updateProjectWorkItem(workItemId: string, input: ProjectContextWorkItemUpdateInput): Promise<ProjectWorkItemRecord>;
  setProjectFocus(input: ProjectContextFocusInput): Promise<ProjectWorkItemRecord | null>;
  panelItems(input: PanelItemsInput): Promise<PanelItemsOutput>;
  panelTasks(input: PanelTasksInput): Promise<PanelTasksOutput>;
  deletePanelTask(taskId: string): Promise<DeletePanelTaskOutput>;
  memoryApiLogs(input: MemoryApiLogsInput): Promise<MemoryApiLogsOutput>;
}
