import type { ScanPermission } from "@memmy/local-api-contracts";

export interface SetScanPermissionInput {
  scanPermission: ScanPermission;
}

export interface CanScanAgentSourceInput {
  agentSourceId: string;
}

export interface CanWriteAgentSkillInput {
  agentSourceId: string;
}

export interface CanSearchMemoryInput {
  agentSourceId?: string;
  cwd?: string;
  workspacePath?: string;
}

export interface RevokeAgentSourceInput {
  agentSourceId: string;
}

export interface PermissionManager {
  getRuntimeToken(): Promise<string>;
  verifyRuntimeToken(token: string): Promise<boolean>;
  getScanPermission(): Promise<ScanPermission>;
  setScanPermission(input: SetScanPermissionInput): Promise<void>;
  canDetectAgentSources(): Promise<boolean>;
  canScanAgentSource(input: CanScanAgentSourceInput): Promise<boolean>;
  canWriteAgentSkill(input: CanWriteAgentSkillInput): Promise<boolean>;
  canSearchMemory(input: CanSearchMemoryInput): Promise<boolean>;
  revokeAgentSource(input: RevokeAgentSourceInput): Promise<void>;
}
