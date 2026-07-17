import {
  CloseSessionInputSchema,
  CloseSessionOutputSchema,
  CompleteTurnInputSchema,
  CompleteTurnOutputSchema,
  AddMemoryInputSchema,
  AddMemoryOutputSchema,
  DeleteMemoryOutputSchema,
  DeletePanelTaskOutputSchema,
  GetMemoryOutputSchema,
  MemoryApiLogsInputSchema,
  MemoryApiLogsOutputSchema,
  MemoryHealthSnapshotSchema,
  MemoryReloadConfigInputSchema,
  MemoryReloadConfigOutputSchema,
  OpenSessionInputSchema,
  OpenSessionOutputSchema,
  PanelAnalysisOutputSchema,
  PanelItemsInputSchema,
  PanelItemsOutputSchema,
  PanelOverviewOutputSchema,
  PanelTasksInputSchema,
  PanelTasksOutputSchema,
  SearchInputSchema,
  SearchOutputSchema,
  StartTurnInputSchema,
  StartTurnOutputSchema,
  type CloseSessionInput,
  type CloseSessionOutput,
  type CompleteTurnInput,
  type CompleteTurnOutput,
  type AddMemoryInput,
  type AddMemoryOutput,
  type DeleteMemoryOutput,
  type DeletePanelTaskOutput,
  type GetMemoryOutput,
  type MemoryApiLogsInput,
  type MemoryApiLogsOutput,
  type MemoryHealthSnapshot,
  type MemoryReloadConfigInput,
  type MemoryReloadConfigOutput,
  type OpenSessionInput,
  type OpenSessionOutput,
  type PanelAnalysisOutput,
  type PanelItemsInput,
  type PanelItemsOutput,
  type PanelOverviewOutput,
  type PanelTasksInput,
  type PanelTasksOutput,
  type SearchInput,
  type SearchOutput,
  type StartTurnInput,
  type StartTurnOutput,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { ApiRequestError, requestJson } from "./http.js";

export const MEMORY_RUNTIME_ENDPOINTS = [
  "GET /api/v1/health",
  "POST /api/v1/admin/reload-config",
  "POST /api/v1/sessions/open",
  "POST /api/v1/sessions/:sessionId/close",
  "POST /api/v1/turns/start",
  "POST /api/v1/turns/:turnId/complete",
  "POST /api/v1/memory/search",
  "POST /api/v1/memory/add",
  "GET /api/v1/memory/:id",
  "DELETE /api/v1/memory/:id",
  "GET /api/v1/memory/logs",
  "GET /api/v1/panel/overview",
  "GET /api/v1/panel/analysis",
  "GET /api/v1/panel/items",
  "GET /api/v1/panel/tasks",
  "DELETE /api/v1/panel/tasks/:id"
] as const;

export interface MemoryRuntimeClient {
  health(): Promise<MemoryHealthSnapshot>;
  reloadConfig(input?: MemoryReloadConfigInput): Promise<MemoryReloadConfigOutput>;
  openSession(input: OpenSessionInput): Promise<OpenSessionOutput>;
  closeSession(sessionId: string, input: CloseSessionInput): Promise<CloseSessionOutput>;
  startTurn(input: StartTurnInput): Promise<StartTurnOutput>;
  completeTurn(turnId: string, input: CompleteTurnInput): Promise<CompleteTurnOutput>;
  search(input: SearchInput): Promise<SearchOutput>;
  addMemory(input: AddMemoryInput): Promise<AddMemoryOutput>;
  getMemory(id: string): Promise<GetMemoryOutput>;
  deleteMemory(id: string): Promise<DeleteMemoryOutput>;
  listMemoryLogs(input: MemoryApiLogsInput): Promise<MemoryApiLogsOutput>;
  getPanelOverview(): Promise<PanelOverviewOutput>;
  getPanelAnalysis(): Promise<PanelAnalysisOutput>;
  listPanelItems(input: PanelItemsInput): Promise<PanelItemsOutput>;
  listPanelTasks(input: PanelTasksInput): Promise<PanelTasksOutput>;
  deletePanelTask(id: string): Promise<DeletePanelTaskOutput>;
}

export function createHttpMemoryRuntimeClient(config: RuntimeConfig): MemoryRuntimeClient {
  return {
    async health() {
      return requestJson({ config, path: "/api/v1/health", schema: MemoryHealthSnapshotSchema });
    },

    async reloadConfig(input = {}) {
      return requestJson({
        config,
        path: "/api/v1/admin/reload-config",
        schema: MemoryReloadConfigOutputSchema,
        body: MemoryReloadConfigInputSchema.parse(input)
      });
    },

    async openSession(input) {
      return requestJson({ config, path: "/api/v1/sessions/open", schema: OpenSessionOutputSchema, body: OpenSessionInputSchema.parse(input) });
    },

    async closeSession(sessionId, input) {
      return requestJson({
        config,
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
        schema: CloseSessionOutputSchema,
        body: CloseSessionInputSchema.parse(input)
      });
    },

    async startTurn(input) {
      return requestJson({
        config,
        path: "/api/v1/turns/start",
        schema: StartTurnOutputSchema,
        body: StartTurnInputSchema.parse(input)
      });
    },

    async completeTurn(turnId, input) {
      return requestJson({
        config,
        path: `/api/v1/turns/${encodeURIComponent(turnId)}/complete`,
        schema: CompleteTurnOutputSchema,
        body: CompleteTurnInputSchema.parse(input)
      });
    },

    async search(input) {
      return requestJson({ config, path: "/api/v1/memory/search", schema: SearchOutputSchema, body: SearchInputSchema.parse(input) });
    },

    async addMemory(input) {
      return requestJson({ config, path: "/api/v1/memory/add", schema: AddMemoryOutputSchema, body: AddMemoryInputSchema.parse(input) });
    },

    async getMemory(id) {
      return requestJson({ config, path: `/api/v1/memory/${encodeURIComponent(id)}`, schema: GetMemoryOutputSchema });
    },

    async deleteMemory(id) {
      return requestJson({
        config,
        path: `/api/v1/memory/${encodeURIComponent(id)}`,
        schema: DeleteMemoryOutputSchema,
        init: { method: "DELETE" }
      });
    },

    async listMemoryLogs(input) {
      return requestJson({
        config,
        path: withQuery("/api/v1/memory/logs", MemoryApiLogsInputSchema.parse(input)),
        schema: MemoryApiLogsOutputSchema
      });
    },

    async getPanelOverview() {
      return requestJson({ config, path: "/api/v1/panel/overview", schema: PanelOverviewOutputSchema });
    },

    async getPanelAnalysis() {
      return requestJson({ config, path: "/api/v1/panel/analysis", schema: PanelAnalysisOutputSchema });
    },

    async listPanelItems(input) {
      return requestJson({ config, path: withQuery("/api/v1/panel/items", PanelItemsInputSchema.parse(input)), schema: PanelItemsOutputSchema });
    },

    async listPanelTasks(input) {
      return requestJson({ config, path: withQuery("/api/v1/panel/tasks", PanelTasksInputSchema.parse(input)), schema: PanelTasksOutputSchema });
    },

    async deletePanelTask(id) {
      return requestJson({
        config,
        path: `/api/v1/panel/tasks/${encodeURIComponent(id)}`,
        schema: DeletePanelTaskOutputSchema,
        init: { method: "DELETE" }
      });
    }
  };
}

export function createUnavailableMemoryRuntimeClient(): MemoryRuntimeClient {
  const unavailable = () => new ApiRequestError("Memory service is not connected", 503, "memory_layer_unavailable", "frontend-unavailable");

  return {
    async health() {
      return {
        ok: false,
        version: "unavailable",
        uptimeMs: 0,
        mode: "dev",
        storage: {
          backend: "sqlite",
          schemaVersion: "unavailable",
          ready: false
        },
        capabilities: {
          routes: [...MEMORY_RUNTIME_ENDPOINTS],
          tools: [],
          memoryLayers: ["L1", "L2", "L3", "Skill"],
          supportsCli: false
        },
        activeProfile: "byok",
        models: {
          summary: { provider: "", configured: false, remote: false },
          evolution: { provider: "", configured: false, remote: false },
          embedding: { provider: "local", configured: true, remote: false }
        },
        serverTime: new Date().toISOString()
      };
    },
    async reloadConfig() {
      throw unavailable();
    },
    async openSession() {
      throw unavailable();
    },
    async closeSession() {
      throw unavailable();
    },
    async startTurn() {
      throw unavailable();
    },
    async completeTurn() {
      throw unavailable();
    },
    async search() {
      throw unavailable();
    },
    async addMemory() {
      throw unavailable();
    },
    async getMemory() {
      throw unavailable();
    },
    async deleteMemory() {
      throw unavailable();
    },
    async listMemoryLogs() {
      throw unavailable();
    },
    async getPanelOverview() {
      throw unavailable();
    },
    async getPanelAnalysis() {
      throw unavailable();
    },
    async listPanelItems() {
      throw unavailable();
    },
    async listPanelTasks() {
      throw unavailable();
    },
    async deletePanelTask() {
      throw unavailable();
    }
  };
}

function withQuery(path: string, values: object): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    appendQueryValue(query, key, value);
  }

  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function appendQueryValue(query: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(query, key, item);
    }
    return;
  }

  query.append(key, String(value));
}
