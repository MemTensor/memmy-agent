import {
  AddManualInputSchema,
  AgentSourceMemoryPluginConflictsResponseSchema,
  AgentSourceScanJobResponseSchema,
  AgentSourceScanInputSchema,
  AgentSourceScanStatusResponseSchema,
  AgentSourceViewSchema,
  OkResponseSchema,
  type AddManualInput,
  type AgentSourceMemoryPluginConflict,
  type AgentSourceScanJobResponse,
  type AgentSourceScanInput,
  type AgentSourceScanStatusResponse,
  type AgentSourceView,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface AgentSourceClient {
  listSources(): Promise<AgentSourceView[]>;
  startScan(input?: AgentSourceScanInput): Promise<AgentSourceScanJobResponse>;
  getScanStatus(): Promise<AgentSourceScanStatusResponse>;
  stopScan(): Promise<void>;
  cancelScan(): Promise<void>;
  addManualSource(input: AddManualInput): Promise<AgentSourceView>;
  removeSource(sourceId: string): Promise<void>;
  installSkill(sourceId: string): Promise<void>;
  uninstallSkill(sourceId: string): Promise<void>;
  installPlugin(sourceId: string): Promise<void>;
  uninstallPlugin(sourceId: string): Promise<void>;
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

    async installPlugin(sourceId) {
      await requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}/plugin`,
        schema: OkResponseSchema,
        init: { method: "POST" }
      });
    },

    async uninstallPlugin(sourceId) {
      await requestJson({
        config,
        path: `/api/agent-sources/${encodeURIComponent(sourceId)}/plugin`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    }
  };
}
