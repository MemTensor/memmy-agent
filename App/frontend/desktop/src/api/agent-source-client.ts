import {
  AddManualInputSchema,
  AgentSourceMemoryPluginConflictsResponseSchema,
  AgentSourceScanJobResponseSchema,
  AgentSourceScanInputSchema,
  AgentSourceScanStatusResponseSchema,
  ScanResultPageSchema,
  AgentSourceViewSchema,
  ManagedAgentSourceImportResultSchema,
  OkResponseSchema,
  AgentSourcePluginActionInputSchema,
  type AddManualInput,
  type AgentSourceMemoryPluginConflict,
  type AgentSourcePluginActionInput,
  type AgentSourceScanJobResponse,
  type AgentSourceScanInput,
  type AgentSourceScanStatusResponse,
  type AgentSourceView,
  type ScanResultPage,
  type ManagedAgentSourceImportResult,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface AgentSourceClient {
  listSources(): Promise<AgentSourceView[]>;
  startScan(input?: AgentSourceScanInput): Promise<AgentSourceScanJobResponse>;
  getScanStatus(): Promise<AgentSourceScanStatusResponse>;
  getScanResults(jobId: string, cursor?: string, limit?: number): Promise<ScanResultPage>;
  stopScan(): Promise<void>;
  cancelScan(): Promise<void>;
  addManualSource(input: AddManualInput): Promise<AgentSourceView>;
  syncManagedSource(sourceId: string): Promise<ManagedAgentSourceImportResult>;
  removeSource(sourceId: string): Promise<void>;
  installSkill(sourceId: string): Promise<void>;
  uninstallSkill(sourceId: string): Promise<void>;
  installPlugin(sourceId: string, action?: AgentSourcePluginActionInput): Promise<void>;
  uninstallPlugin(sourceId: string, action?: AgentSourcePluginActionInput): Promise<void>;
  getMemoryPluginConflicts(): Promise<AgentSourceMemoryPluginConflict[]>;
}

export function createHttpAgentSourceClient(config: RuntimeConfig): AgentSourceClient {
  return {
    async listSources() {
      return requestJson({
        config,
        path: "/api/agent-sources",
        schema: AgentSourceViewSchema.array()
      });
    },

    async startScan(input) {
      return requestJson({
        config,
        path: "/api/agent-sources/scan",
        schema: AgentSourceScanJobResponseSchema,
        body: AgentSourceScanInputSchema.parse(input)
      });
    },

    async getScanStatus() {
      return requestJson({
        config,
        path: "/api/agent-sources/scan/status",
        schema: AgentSourceScanStatusResponseSchema
      });
    },

    async getScanResults(jobId, cursor = "0", limit = 100) {
      return requestJson({
        config,
        path: `/api/agent-sources/scan/jobs/${encodeURIComponent(jobId)}/results?cursor=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(String(limit))}`,
        schema: ScanResultPageSchema
      });
    },

    async getMemoryPluginConflicts() {
      const response = await requestJson({
        config,
        path: "/api/agent-sources/memory-plugin-conflicts",
        schema: AgentSourceMemoryPluginConflictsResponseSchema
      });
      return response.conflicts;
    },

    async stopScan() {
      await requestJson({
        config,
        path: "/api/agent-sources/scan/stop",
        schema: OkResponseSchema,
        init: { method: "POST" }
      });
    },

    async cancelScan() {
      await requestJson({
        config,
        path: "/api/agent-sources/scan/cancel",
        schema: OkResponseSchema,
        init: { method: "POST" }
      });
    },

    async addManualSource(input) {
      return requestJson({
        config,
        path: "/api/agent-sources/manual",
        schema: AgentSourceViewSchema,
        body: AddManualInputSchema.parse(input)
      });
    },

    async syncManagedSource(sourceId) {
      return requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}/managed/sync`,
        schema: ManagedAgentSourceImportResultSchema,
        init: { method: "POST" }
      });
    },

    async removeSource(sourceId) {
      await requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async installSkill(sourceId) {
      await requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}/skill`,
        schema: OkResponseSchema,
        init: { method: "POST" }
      });
    },

    async uninstallSkill(sourceId) {
      await requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}/skill`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async installPlugin(sourceId, action) {
      await requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}/plugin`,
        schema: OkResponseSchema,
        init: { method: "POST" },
        body: AgentSourcePluginActionInputSchema.parse(action ?? {})
      });
    },

    async uninstallPlugin(sourceId, action) {
      await requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}/plugin`,
        schema: OkResponseSchema,
        init: { method: "DELETE" },
        body: AgentSourcePluginActionInputSchema.parse(action ?? {})
      });
    }
  };
}
