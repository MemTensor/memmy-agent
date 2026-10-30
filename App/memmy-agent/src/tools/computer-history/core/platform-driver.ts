import type { ChildProcessWithoutNullStreams } from "node:child_process";

// Legacy permission fields remain part of the existing API contract. Platform drivers
// supply their own checks; these fields are not authorization for Windows capture.
export type HistoryPermission = "accessibility" | "inputMonitoring";
export interface HistoryPermissions {
  supported: boolean;
  accessibility: boolean;
  inputMonitoring: boolean;
  platform?: "windows";
  ready?: boolean;
  reason?: "ready" | "collector_unavailable" | "authorization_required" | "no_running_authorized_application" | "settings_invalid" | "discovery_failed";
}

export interface RecorderLaunch {
  title: string;
  eventsFile: string;
  observationSettingsFile: string;
  weChatConsentFile?: string;
}

export interface HistoryPlatformDriver {
  launch(input: RecorderLaunch): ChildProcessWithoutNullStreams;
  readPermissions(request?: HistoryPermission): Promise<HistoryPermissions>;
  openPermission(permission: HistoryPermission, mode: "request" | "settings"): Promise<HistoryPermissions>;
  permissionError(message: string): HistoryPermission | null;
  iconFor(applicationId: string): Promise<string | null>;
  listApplications?(): Promise<Array<{ bundleId: string; name: string }>>;
  prepare?(): void;
  ready?(child: ChildProcessWithoutNullStreams): Promise<void>;
  stop?(child: ChildProcessWithoutNullStreams): Promise<void>;
  /** Change the durable output at a native fence without restarting capture. */
  rotate?(child: ChildProcessWithoutNullStreams, input: RecorderLaunch): Promise<void>;
}

export function historyPermissionsReady(status: HistoryPermissions): boolean {
  return status.supported && (status.platform === "windows" ? status.ready === true : status.accessibility && status.inputMonitoring);
}
