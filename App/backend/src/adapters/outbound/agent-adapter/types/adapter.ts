/** Adapter module. */
import type { AgentKind, AgentScanRecord } from "./domain.js";
import type { JsonObject, JsonValue } from "./json.js";

export interface AgentAdapterCapabilities {
  detect: boolean;
  scan: boolean;
  installSkill: boolean;
  removeSkill: boolean;
}

export interface AgentAdapterDescriptor {
  id: string;
  kind: AgentKind;
  displayName: string;
  version: string;
  capabilities: AgentAdapterCapabilities;
}

export interface DetectAgentsInput {
  homeDir: string;
}

export interface DetectedAgentSource {
  kind: AgentKind;
  displayName: string;
  rootPath: string;
  metadata?: JsonObject;
}

export interface ValidateAgentSourceInput {
  kind: AgentKind;
  rootPath: string;
}

export type ValidateAgentSourceResult =
  | { valid: true }
  | { valid: false; reason: string };

export interface ScanAgentSourceInput {
  sourceId: string;
  kind: AgentKind;
  rootPath: string;
  cursor?: JsonValue;
}

export interface InstallAgentSkillInput {
  sourceId: string;
  kind: AgentKind;
  rootPath: string;
}

export interface InstallAgentSkillResult {
  installed: boolean;
  targetPath?: string;
}

export interface RemoveAgentSkillInput {
  sourceId: string;
  kind: AgentKind;
  rootPath: string;
}

export interface RemoveAgentSkillResult {
  removed: boolean;
  targetPath?: string;
}

export interface AgentAdapter {
  kind: AgentKind;
  descriptor: AgentAdapterDescriptor;
  detect(input: DetectAgentsInput): Promise<DetectedAgentSource[]>;
  validateSource(input: ValidateAgentSourceInput): Promise<ValidateAgentSourceResult>;
  scan(input: ScanAgentSourceInput): AsyncIterable<AgentScanRecord>;
  installSkill(input: InstallAgentSkillInput): Promise<InstallAgentSkillResult>;
  removeSkill(input: RemoveAgentSkillInput): Promise<RemoveAgentSkillResult>;
}
