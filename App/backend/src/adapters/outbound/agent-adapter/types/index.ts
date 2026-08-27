/** Types module. */
export type { AgentAdapter, AgentAdapterCapabilities, AgentAdapterDescriptor } from "./adapter.js";
export type {
  DetectAgentsInput,
  DetectedAgentSource,
  InstallAgentSkillInput,
  InstallAgentSkillResult,
  RemoveAgentSkillInput,
  RemoveAgentSkillResult,
  ScanAgentSourceInput,
  ValidateAgentSourceInput,
  ValidateAgentSourceResult
} from "./adapter.js";
export type { AgentKind, AgentMessage, AgentMessageRole, AgentScanRecord, BuiltinAgentKind } from "./domain.js";
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from "./json.js";
export type {
  AgentAdapterModuleLoader,
  AgentAdapterPluginContext,
  AgentAdapterPluginFactory,
  AgentAdapterPluginManifest,
  AgentAdapterPluginModule,
  AgentAdapterPluginSource
} from "./plugin.js";
