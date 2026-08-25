import type { DeterministicProjectFacts } from "./manifest-parsers.js";

export type ProjectEnvironmentKind = "unknown" | "code" | "folder";
export type ProjectEnvironmentScanStatus =
  | "uninitialized"
  | "queued"
  | "scanning"
  | "summarizing"
  | "clean"
  | "failed";

export type RuntimeProbe =
  | "node_version"
  | "python_version"
  | "go_version"
  | "rust_version"
  | "java_version";

export type InventoryEntry =
  | {
      relativePath: string;
      type: "directory";
      mtimeMs: number;
    }
  | {
      relativePath: string;
      type: "file";
      size: number;
      mtimeMs: number;
      sha256?: string;
    };

export interface ProjectEnvironmentTextFile {
  relativePath: string;
  sha256: string;
  text: string;
}

export interface RuntimeProbeResult {
  probe: RuntimeProbe;
  exitCode: number;
  versionText: string | null;
}

export interface ProjectEnvironmentScanResult {
  entries: InventoryEntry[];
  omittedCount: number;
  textFiles: ProjectEnvironmentTextFile[];
  runtimeProbes: RuntimeProbeResult[];
}

export interface ProjectEnvironmentDerivedEvidence {
  projectKind: Exclude<ProjectEnvironmentKind, "unknown">;
  fingerprint: string;
  compactFileTree: string;
  omittedCount: number;
  deterministicFacts: DeterministicProjectFacts;
}

export interface ProjectEnvironmentStateRecord {
  userId: string;
  projectId: string;
  projectKind: ProjectEnvironmentKind;
  status: ProjectEnvironmentScanStatus;
  currentScanId?: string;
  appliedScanId?: string;
  fingerprint?: string;
  lastError?: string;
  updatedAt: string;
}
