import {PanelLogsOutputSchema,PanelLogDetailOutputSchema,type PanelLogsInput,type PanelLogsOutput,type PanelLogDetailOutput} from "@memmy/local-api-contracts";
import {PanelStatsOutputSchema,PanelOverviewStatsOutputSchema,type PanelStatsOutput,type PanelOverviewStatsOutput} from "@memmy/local-api-contracts";
import { PanelBrowseClient } from "./panel-browse-client.js";
import { PanelBrowseOutputSchema } from "@memmy/local-api-contracts";
import { PanelTaskSummariesOutputSchema, type PanelTaskSummariesOutput } from "@memmy/local-api-contracts";
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
  MemoryProcessingStatusInputSchema,
  MemoryProcessingStatusOutputSchema,
  MemoryReloadConfigInputSchema,
  MemoryReloadConfigOutputSchema,
  RecallEvidenceOutputSchema,
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
  RetryMemoryProcessingOutputSchema,
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
  type MemoryProcessingStatusOutput,
  type MemoryReloadConfigInput,
  type MemoryReloadConfigOutput,
  type RecallEvidenceOutput,
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
  type RetryMemoryProcessingOutput,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { ApiRequestError, requestJson } from "./http.js";
import { z } from "zod";
import { PanelRequestQueue } from "./panel-request-queue.js";

const ApproveObservedSkillOutputSchema = z.object({ id: z.string(), status: z.literal("activated"), serverTime: z.string() });
const UpdateObservedSkillOutputSchema = ApproveObservedSkillOutputSchema.extend({ version: z.number().int().positive() });

export const MEMORY_RUNTIME_ENDPOINTS = [
  "GET /api/v1/health",
  "POST /api/v1/admin/reload-config",
  "POST /api/v1/sessions/open",
  "POST /api/v1/sessions/:sessionId/close",
  "POST /api/v1/turns/start",
  "POST /api/v1/turns/:turnId/complete",
  "POST /api/v1/memory/search",
  "POST /api/v1/memory/add",
  "POST /api/v1/evidence/skills/:id/approve",
  "PATCH /api/v1/evidence/skills/:id",
  "POST /api/v1/memory/processing/status",
  "POST /api/v1/memory/:id/processing/retry",
  "GET /api/v1/memory/:id",
  "DELETE /api/v1/memory/:id",
  "GET /api/v1/memory/recalls/:queryId",
  "GET /api/v1/memory/logs",
  "POST /api/v1/panel/browse",
  "GET /api/v1/panel/stats",
  "GET /api/v1/panel/overview-stats",
  "POST /api/v1/panel/logs",
  "GET /api/v1/panel/logs/:id",
  "GET /api/v1/panel/memory/:id",
  "GET /api/v1/panel/overview",
  "GET /api/v1/panel/analysis",
  "GET /api/v1/panel/items",
  "GET /api/v1/panel/tasks",
  "GET /api/v1/panel/task-summaries",
  "DELETE /api/v1/panel/tasks/:id"
] as const;

export interface MemoryRuntimeClient {
  prefetchPanel?(section:string,signal:AbortSignal):Promise<boolean | void>;
  listPanelLogs?(input:PanelLogsInput):Promise<PanelLogsOutput>;
  getPanelLogDetail?(id:number):Promise<PanelLogDetailOutput>;
  getPanelStats?():Promise<PanelStatsOutput>;
  getPanelOverviewStats?():Promise<PanelOverviewStatsOutput>;
  resetPanelView?(section?:string):void;
  refreshPanelView?(section:string):void;
  checkPanelView?(section:string):Promise<{updated:boolean}>;
  health(signal?: AbortSignal): Promise<MemoryHealthSnapshot>;
  reloadConfig(input?: MemoryReloadConfigInput): Promise<MemoryReloadConfigOutput>;
  openSession(input: OpenSessionInput): Promise<OpenSessionOutput>;
  closeSession(sessionId: string, input: CloseSessionInput): Promise<CloseSessionOutput>;
  startTurn(input: StartTurnInput): Promise<StartTurnOutput>;
  completeTurn(turnId: string, input: CompleteTurnInput): Promise<CompleteTurnOutput>;
  search(input: SearchInput): Promise<SearchOutput>;
  addMemory(input: AddMemoryInput): Promise<AddMemoryOutput>;
  getMemory(id: string, signal?:AbortSignal): Promise<GetMemoryOutput>;
  getPanelMemory?(id:string, signal?:AbortSignal):Promise<GetMemoryOutput>;
  deleteMemory(id: string): Promise<DeleteMemoryOutput>;
  approveObservedSkill?(id: string): Promise<{ id: string; status: "activated"; serverTime: string }>;
  updateObservedSkill?(id: string, input: { body: string; expectedVersion: number }): Promise<{ id: string; status: "activated"; version: number; serverTime: string }>;
  recallEvidence(queryId: string): Promise<RecallEvidenceOutput>;
  getMemoryProcessingStatus(memoryIds: string[]): Promise<MemoryProcessingStatusOutput>;
  retryMemoryProcessing(id: string): Promise<RetryMemoryProcessingOutput>;
  listMemoryLogs(input: MemoryApiLogsInput): Promise<MemoryApiLogsOutput>;
  getPanelOverview(): Promise<PanelOverviewOutput>;
  getPanelAnalysis(): Promise<PanelAnalysisOutput>;
  listPanelItems(input: PanelItemsInput, signal?: AbortSignal): Promise<PanelItemsOutput>;
  listPanelTaskSummaries?(input: PanelTasksInput, signal?: AbortSignal): Promise<PanelTaskSummariesOutput | PanelTasksOutput>;
  listPanelTasks(input: PanelTasksInput, signal?: AbortSignal): Promise<PanelTasksOutput>;
  deletePanelTask(id: string): Promise<DeletePanelTaskOutput>;
}

export function createHttpMemoryRuntimeClient(config: RuntimeConfig): MemoryRuntimeClient {
  const panelQueue = new PanelRequestQueue(2);
  const browse = new PanelBrowseClient((input, signal) => panelQueue.request(
    `browse:${JSON.stringify(input)}`,
    sharedSignal => requestJson({config,path:"/api/v1/panel/browse",schema:PanelBrowseOutputSchema,body:input,init:{signal:sharedSignal}}),
    signal
  ), isUnsupportedPanelRoute);
  const invalidatePanel = () => {
    // Retire old statistics/details before new-generation listeners subscribe.
    panelQueue.clear();
    browse.reset();
    if (typeof window !== "undefined") window.dispatchEvent(new Event("memmy-panel-invalidated"));
  };
  return {
    async prefetchPanel(section,signal) {
      if (browse.hasView(section)) return true;
      if (!panelQueue.idle || !browse.idle) return false;
      const input = section === "tasks" ? {page:1} : {
        layer:section as PanelItemsInput["layer"],page:1,
        ...(section === "UserMemory" ? {userSummary:true} : {})
      };
      await browse.list(section,input,signal);
      return true;
    },
    listPanelLogs:input=>panelQueue.request(`panel:logs:${JSON.stringify(input)}`,signal=>requestJson({config,path:"/api/v1/panel/logs",schema:PanelLogsOutputSchema,body:input,init:{signal}})),
    getPanelLogDetail:id=>panelQueue.request(`panel:log:${id}`,signal=>requestJson({config,path:`/api/v1/panel/logs/${id}`,schema:PanelLogDetailOutputSchema,init:{signal}})),
    getPanelStats:()=>panelQueue.request("panel:stats",signal=>requestJson({config,path:"/api/v1/panel/stats",schema:PanelStatsOutputSchema,init:{signal}})),
    getPanelOverviewStats:()=>panelQueue.request("panel:overview-stats",signal=>requestJson({config,path:"/api/v1/panel/overview-stats",schema:PanelOverviewStatsOutputSchema,init:{signal}})),
    resetPanelView: section => { if (!section) panelQueue.clear(); browse.reset(section); },
    refreshPanelView: section => browse.refresh(section),
    checkPanelView: section => browse.check(section),
    async health(signal) {
      return requestJson({ config, path: "/api/v1/health", schema: MemoryHealthSnapshotSchema, init: { signal } });
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

    async getPanelMemory(id, signal) {
      const path = `/api/v1/panel/memory/${encodeURIComponent(id)}`;
      try{return await requestJson({config,path,schema:GetMemoryOutputSchema,init:{signal}});}
      catch(error){if(!isUnsupportedPanelRoute(error))throw error;return this.getMemory(id,signal);}
    },

    async getMemory(id,signal) {
      return requestJson({ config, path: `/api/v1/memory/${encodeURIComponent(id)}`, schema: GetMemoryOutputSchema, init:{signal} });
    },

    async deleteMemory(id) {
      const result = await requestJson({
        config,
        path: `/api/v1/memory/${encodeURIComponent(id)}`,
        schema: DeleteMemoryOutputSchema,
        init: { method: "DELETE" }
      });
      invalidatePanel();
      return result;
    },

    async approveObservedSkill(id) {
      const result = await requestJson({ config, path: `/api/v1/evidence/skills/${encodeURIComponent(id)}/approve`,
        schema: ApproveObservedSkillOutputSchema, body: {} });
      invalidatePanel();
      return result;
    },

    async updateObservedSkill(id, input) {
      const result = await requestJson({ config, path: `/api/v1/evidence/skills/${encodeURIComponent(id)}`,
        schema: UpdateObservedSkillOutputSchema, body: input, init: { method: "PATCH" } });
      invalidatePanel();
      return result;
    },

    async recallEvidence(queryId) {
      return requestJson({
        config,
        path: `/api/v1/memory/recalls/${encodeURIComponent(queryId)}`,
        schema: RecallEvidenceOutputSchema
      });
    },

    async getMemoryProcessingStatus(memoryIds) {
      return requestJson({
        config,
        path: "/api/v1/memory/processing/status",
        schema: MemoryProcessingStatusOutputSchema,
        body: MemoryProcessingStatusInputSchema.parse({ memoryIds })
      });
    },

    async retryMemoryProcessing(id) {
      return requestJson({
        config,
        path: `/api/v1/memory/${encodeURIComponent(id)}/processing/retry`,
        schema: RetryMemoryProcessingOutputSchema,
        body: {}
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

    async listPanelItems(input, signal) {
      const page=await browse.list(input.layer ?? "L1",input,signal);
      if(page) return {items:page.items??[],page:page.page,pageSize:page.pageSize,total:page.total,totalPages:page.totalPages,hasNext:page.hasNext,hasPrev:page.hasPrev,serverTime:page.serverTime};
      const path = withQuery("/api/v1/panel/items", PanelItemsInputSchema.parse(input));
      return panelQueue.request(path, (sharedSignal) => requestJson({ config, path, schema: PanelItemsOutputSchema, init: { signal: sharedSignal } }), signal);
    },

    async listPanelTaskSummaries(input, signal) {
      const page=await browse.list("tasks",input,signal);
      if(page) return {tasks:page.tasks??[],page:page.page,pageSize:page.pageSize,total:page.total,totalPages:page.totalPages,hasNext:page.hasNext,hasPrev:page.hasPrev,serverTime:page.serverTime};
      const path = withQuery("/api/v1/panel/task-summaries", PanelTasksInputSchema.parse(input));
      try {
        return await panelQueue.request(path, (sharedSignal) => requestJson({ config, path, schema: PanelTaskSummariesOutputSchema, init: {signal: sharedSignal} }), signal);
      } catch (error) {
        if (!isUnsupportedPanelRoute(error)) throw error;
        const legacyPath = withQuery("/api/v1/panel/tasks", PanelTasksInputSchema.parse(input));
        return panelQueue.request(legacyPath, (sharedSignal) => requestJson({config, path: legacyPath, schema: PanelTasksOutputSchema, init: {signal: sharedSignal}}), signal);
      }
    },
    async listPanelTasks(input, signal) {
      const path = withQuery("/api/v1/panel/tasks", PanelTasksInputSchema.parse(input));
      return panelQueue.request(path, (sharedSignal) => requestJson({ config, path, schema: PanelTasksOutputSchema, init: { signal: sharedSignal } }), signal);
    },

    async deletePanelTask(id) {
      const result = await requestJson({
        config,
        path: `/api/v1/panel/tasks/${encodeURIComponent(id)}`,
        schema: DeletePanelTaskOutputSchema,
        init: { method: "DELETE" }
      });
      invalidatePanel();
      return result;
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
        models: {
          summary: { provider: "", configured: false, remote: false, routing: null },
          evolution: { provider: "", configured: false, remote: false, routing: null },
          embedding: { provider: "local", configured: true, remote: false, mode: null }
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
    async recallEvidence() {
      throw unavailable();
    },
    async getMemoryProcessingStatus() {
      throw unavailable();
    },
    async retryMemoryProcessing() {
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

/** A missing object, authorization error or timeout never means an old service. */
export function isUnsupportedPanelRoute(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404 && error.code === "not_found"
    && (/is not registered/i.test(error.message) || /route .*not found/i.test(error.message));
}

/** Management-only detail reads; older runtimes retain their existing authorization. */
export function readMemoryPanelDetail(client:MemoryRuntimeClient,id:string,signal?:AbortSignal):Promise<GetMemoryOutput> {
  return client.getPanelMemory ? client.getPanelMemory(id,signal) : signal ? client.getMemory(id,signal) : client.getMemory(id);
}
