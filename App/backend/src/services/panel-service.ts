import type { PanelTaskCheckOutput } from "@memmy/local-api-contracts";
import type {PanelLogsInput,PanelLogsOutput,PanelLogDetailOutput} from "@memmy/local-api-contracts";
import type {PanelStatsOutput} from "@memmy/local-api-contracts";
import type { PanelBrowseInput, PanelBrowseOutput } from "@memmy/local-api-contracts";
import type { PanelTaskSummariesOutput, PanelTaskDetailOutput, PanelTaskFieldInput, PanelTaskFieldOutput } from "@memmy/local-api-contracts";
/** Panel service module. */
import type {
  PanelAnalysisOutput,
  PanelItemsInput,
  PanelItemsOutput,
  PanelTasksInput,
  PanelTasksOutput,
  DeletePanelTaskOutput,
  MemoryApiLogsInput,
  MemoryApiLogsOutput,
  PanelOverviewOutput
} from "@memmy/local-api-contracts";
import { MemoryLayerError } from "../adapters/outbound/memory-client/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { RuntimeContext } from "./runtime-context.js";

/** Contract for panel service. */
export interface PanelService {
  overview(ctx: RuntimeContext): Promise<PanelOverviewOutput>;
  analysis(ctx: RuntimeContext): Promise<PanelAnalysisOutput>;
  items(input: PanelItemsInput, ctx: RuntimeContext): Promise<PanelItemsOutput>;
  logs(input:PanelLogsInput,ctx:RuntimeContext):Promise<PanelLogsOutput>;
  logDetail(id:number,ctx:RuntimeContext):Promise<PanelLogDetailOutput>;
  stats(ctx:RuntimeContext):Promise<PanelStatsOutput>;
  browse(input:PanelBrowseInput,ctx:RuntimeContext):Promise<PanelBrowseOutput>;
  taskSummaries(input: PanelTasksInput, ctx: RuntimeContext): Promise<PanelTaskSummariesOutput>;
  taskCheck(id: string, ctx: RuntimeContext): Promise<PanelTaskCheckOutput>;
  taskDetail(id: string, cursor: string | undefined, ctx: RuntimeContext): Promise<PanelTaskDetailOutput>;
  taskField(id: string, turnId: string, input: PanelTaskFieldInput, ctx: RuntimeContext): Promise<PanelTaskFieldOutput>;
  tasks(input: PanelTasksInput, ctx: RuntimeContext): Promise<PanelTasksOutput>;
  deleteTask(id: string, ctx: RuntimeContext): Promise<DeletePanelTaskOutput>;
  memoryApiLogs(input: MemoryApiLogsInput, ctx: RuntimeContext): Promise<MemoryApiLogsOutput>;
}

/** Creates create panel service. */
export function createPanelService(deps: { memoryClient: MemoryClient; getUserId: () => string }): PanelService {
  const context = (ctx: RuntimeContext): RuntimeContext => ({ ...ctx, userId: deps.getUserId() });
  return {
    async overview(ctx) {
      return deps.memoryClient.panelOverview(context(ctx));
    },

    async analysis(ctx) {
      return deps.memoryClient.panelAnalysis(context(ctx));
    },

    async items(input, ctx) {
      return deps.memoryClient.panelItems(input, context(ctx));
    },

    async logs(input,ctx) {return deps.memoryClient.panelLogs(input,context(ctx));},
    async logDetail(id,ctx) {return deps.memoryClient.panelLogDetail(id,context(ctx));},
    async stats(ctx) {return deps.memoryClient.panelStats(context(ctx));},
    async browse(input,ctx) {
      // Section travels on each call so task views keep the established device scope.
      return deps.memoryClient.panelBrowse(input,input.filter?.section === "tasks" ? {...ctx,userId:undefined} : context(ctx));
    },
    async taskSummaries(input, ctx) {
      return deps.memoryClient.panelTaskSummaries(input, {...ctx, userId: undefined});
    },
    async taskCheck(id, ctx) { return deps.memoryClient.panelTaskCheck(id, {...ctx, userId: undefined}); },
    async taskDetail(id, cursor, ctx) {
      return deps.memoryClient.panelTaskDetail(id, cursor, {...ctx, userId: undefined});
    },
    async taskField(id, turnId, input, ctx) {
      return deps.memoryClient.panelTaskField(id, turnId, input, {...ctx, userId: undefined});
    },
    async tasks(input, ctx) {
      // The desktop task list shows the local library, like the Web viewer.
      // Login must not hide tasks captured by hooks under a different userId.
      // Keep service-token authentication, but omit the UI account filter.
      return deps.memoryClient.panelTasks(input, { ...ctx, userId: undefined });
    },

    async deleteTask(id, ctx) {
      return deps.memoryClient.deletePanelTask(id, context(ctx));
    },

    async memoryApiLogs(input, ctx) {
      try {
        return await deps.memoryClient.memoryApiLogs(input, context(ctx));
      } catch (error) {
        if (isMissingMemoryLogsRoute(error)) {
          return {
            logs: [],
            total: 0,
            limit: input.limit ?? 50,
            offset: input.offset ?? 0,
            serverTime: new Date().toISOString()
          };
        }
        throw error;
      }
    }
  };
}

/** Checks is missing memory logs route. */
function isMissingMemoryLogsRoute(error: unknown): boolean {
  return (
    error instanceof MemoryLayerError &&
    error.status === 404 &&
    error.code === "not_found" &&
    error.message.toLowerCase().includes("logs")
  );
}
