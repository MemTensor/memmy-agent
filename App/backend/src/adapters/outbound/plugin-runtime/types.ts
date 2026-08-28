/** Plugin runtime adapter contracts. */
import type {
  CapabilityCall,
  CapabilityEvent,
  PluginRuntime
} from "@memmy/local-api-contracts";
import type { PluginRecord } from "../../../infrastructure/app-state-store/repositories/plugin-repo.js";

export interface PluginRuntimeContext {
  plugin: PluginRecord;
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  rootPath: string | null;
}

export interface PluginSession {
  readonly pluginId: string;
}

export interface PluginAdapter {
  readonly id: "mcp" | "http" | "command";
  validate(runtime: PluginRuntime, rootPath: string | null): void;
  activate(context: PluginRuntimeContext): Promise<PluginSession>;
  invoke(session: PluginSession, call: CapabilityCall): AsyncIterable<CapabilityEvent>;
  cancel?(session: PluginSession, callId: string): Promise<void>;
  deactivate(session: PluginSession): Promise<void>;
}
