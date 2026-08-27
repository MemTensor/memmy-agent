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

    async tasks(input, ctx) {
      return deps.memoryClient.panelTasks(input, context(ctx));
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
