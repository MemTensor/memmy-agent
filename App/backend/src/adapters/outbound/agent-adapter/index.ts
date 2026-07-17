/** Agent adapter module. */
export {
  createAgentAdapterRegistry,
  createDefaultAgentAdapterRegistry,
  resolveBuiltinAgentAdapterPluginDirectory
} from "./registry.js";
export { createAgentAdapterDescriptor, isBuiltinAgentKind, parseAgentAdapterPluginManifest } from "./manifest.js";
export {
  AGENT_ADAPTER_PLUGIN_MANIFEST,
  createDirectoryAgentAdapterPluginSource,
  createInMemoryAgentAdapterPluginSource,
  nodePluginFileSystem,
  type AgentAdapterPluginDirectoryEntry,
  type AgentAdapterPluginFileSystem,
  type CreateDirectoryAgentAdapterPluginSourceOptions
} from "./plugin-source.js";
export {
  createAgentAdapterPluginLoader,
  createDynamicImportModuleLoader,
  type AgentAdapterPluginLoader,
  type CreateAgentAdapterPluginLoaderOptions
} from "./plugin-loader.js";
export type {
  AgentAdapter,
  AgentAdapterCapabilities,
  AgentAdapterDescriptor,
  AgentAdapterModuleLoader,
  AgentAdapterPluginContext,
  AgentAdapterPluginFactory,
  AgentAdapterPluginManifest,
  AgentAdapterPluginModule,
  AgentAdapterPluginSource,
  AgentKind,
  AgentMessage,
  AgentMessageRole,
  AgentScanRecord,
  BuiltinAgentKind,
  DetectAgentsInput,
  DetectedAgentSource,
  InstallAgentSkillInput,
  InstallAgentSkillResult,
  RemoveAgentSkillInput,
  RemoveAgentSkillResult,
  ScanAgentSourceInput,
  ValidateAgentSourceInput,
  ValidateAgentSourceResult,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue
} from "./types/index.js";
export type { AgentAdapterRegistry } from "./registry.js";
