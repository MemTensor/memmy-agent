/** Plugin module. */
import type { AgentAdapter, AgentAdapterCapabilities } from "./adapter.js";
import type { AgentKind } from "./domain.js";

export interface AgentAdapterPluginManifest {
  id: string;
  kind: AgentKind;
  displayName: string;
  version: string;
  modulePath: string;
  enabled: boolean;
  priority: number;
  capabilities: AgentAdapterCapabilities;
}

export interface AgentAdapterPluginContext {
  manifest: AgentAdapterPluginManifest;
}

export type AgentAdapterPluginFactory = (
  context: AgentAdapterPluginContext
) => AgentAdapter | Promise<AgentAdapter>;

export interface AgentAdapterPluginModule {
  createAdapter?: AgentAdapterPluginFactory;
  default?: AgentAdapterPluginFactory | { createAdapter?: AgentAdapterPluginFactory };
}

export interface AgentAdapterPluginSource {
  loadManifests(): Promise<AgentAdapterPluginManifest[]>;
}

export interface AgentAdapterModuleLoader {
  importModule(modulePath: string): Promise<unknown>;
}
