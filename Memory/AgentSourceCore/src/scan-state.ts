/** Browser-safe ordering rules shared by the executor, desktop and Viewer. */
export interface ScanVersion { generation: number; sequence: number }
export type ScanLifecycle = "idle" | "running" | "paused" | "completed" | "failed" | "cancelled";
export interface ScanStamp {
  version?: ScanVersion;
  jobId?: string | null;
  attemptId?: string;
  attemptStartedAt?: string;
  status?: ScanLifecycle;
}
export interface ScanControlInput { expectedExecution?: { jobId: string; attemptId?: string }; expectedVersion?: ScanVersion }
export function compareScanVersions(a: ScanVersion, b: ScanVersion): number {
  return a.generation - b.generation || a.sequence - b.sequence;
}
export function scanExecutionKey(scan: { jobId?: string | null; attemptId?: string }): string {
  return scan.attemptId ? JSON.stringify([scan.jobId, scan.attemptId]) : scan.jobId ?? "";
}
/** Missing versions are accepted only before a versioned service is observed. */
export function acceptsScanUpdate(current: ScanStamp | null | undefined, next: ScanStamp): boolean {
  if (current?.version) return !!next.version && compareScanVersions(next.version, current.version) > 0;
  if (next.version) return true;
  return !(current?.attemptStartedAt && next.attemptStartedAt && next.attemptStartedAt < current.attemptStartedAt);
}
export function matchesScanExecution(current: ScanStamp, expected: ScanControlInput["expectedExecution"]): boolean {
  return !expected || (current.jobId === expected.jobId && current.attemptId === expected.attemptId);
}
