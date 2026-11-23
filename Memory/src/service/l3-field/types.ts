/** Shared types for L3 field cognition: machine/project units holding itemized facts. */

export type L3UnitKind = "machine" | "project";
export type L3ItemKind = "env_fact" | "project_constraint";
export type L3ItemStatus = "active" | "inactive";
export type ProjectIdentitySource = "user_selected" | "git" | "folder";
export type L3UnitBatchStatus = "queued" | "applied" | "failed";

export interface ResolvedProject {
  /** Stable identity shared by every checkout of the same project. */
  identity: string;
  /** Root directory of the checkout the evidence came from. */
  checkoutRoot: string;
  source: ProjectIdentitySource;
  displayName: string;
}

export interface EvidenceFragment {
  id: string;
  rawTurnId: string;
  l1MemoryId: string;
  toolName: string | null;
  input: unknown;
  output: string | null;
  isError: boolean;
  paths: string[];
  candidateUnitKeys: string[];
  at: string;
}

export interface L3ItemEvidence {
  fragmentIds: string[];
  l1MemoryIds: string[];
}

export interface L3UnitRecord {
  unitKey: string;
  userId: string;
  machineId: string;
  kind: L3UnitKind;
  projectIdentity?: string;
  displayName?: string;
  identitySource?: ProjectIdentitySource;
  checkoutRoot?: string;
  profileText?: string;
  profileFingerprint?: string;
  snapshotMemoryId?: string;
  deletedAt?: string;
  nextSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface L3ItemRecord {
  id: string;
  unitKey: string;
  kind: L3ItemKind;
  content: string;
  evidence: L3ItemEvidence;
  evidenceAt: string;
  lastConfirmedAt: string;
  status: L3ItemStatus;
  replacedBy?: string;
  /** When the evidence that removed it happened; only for a delete or replace op. */
  removedEvidenceAt?: string;
  inactiveAt?: string;
  batchId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface L3UserProject {
  rootPath: string;
  name: string;
}

export interface L3UnitBatchRecord {
  id: string;
  machineUnitKey: string;
  scopeSeq: number;
  userId: string;
  sessionId: string;
  trigger: string;
  startTraceSeq: number;
  endTraceSeq: number;
  l1MemoryIds: string[];
  rawTurnIds: string[];
  status: L3UnitBatchStatus;
  createdAt: string;
  updatedAt: string;
}
