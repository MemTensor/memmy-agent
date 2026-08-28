/** Plugin runtime adapter contracts. */
import type {
  CapabilityCall,
  CapabilityEvent,
  InstalledPlugin,
  PluginRuntime
} from "@memmy/local-api-contracts";

export interface PluginRuntimeRecord extends InstalledPlugin {
  artifactHash: string | null;
  rootPath: string | null;
}

export interface PluginRuntimeContext {
  plugin: PluginRuntimeRecord;
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
  respond?(session: PluginSession, callId: string, interactionId: string, response: unknown): Promise<void>;
  cancel?(session: PluginSession, callId: string): Promise<void>;
  deactivate(session: PluginSession): Promise<void>;
}

export interface PluginRuntimeHost {
  supports(adapterId: string): boolean;
  activate(plugin: PluginRuntimeRecord, secrets: Readonly<Record<string, string>>): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
  invoke(call: CapabilityCall): AsyncIterable<CapabilityEvent>;
  cancel(pluginId: string, callId: string): Promise<void>;
  respond(pluginId: string, callId: string, interactionId: string, response: unknown): Promise<void>;
}
