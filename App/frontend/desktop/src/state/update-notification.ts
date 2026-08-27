/** Contract for update notification context. */

export interface UpdateNotificationContext {
  enabled: boolean;
  soundEnabled: boolean;
  status: string;
  latestVersion?: string;
  alreadyNotifiedVersion: string | null;
}

export interface UpdateNotificationPlan {
  silent: boolean;
  version: string;
}

/** Handles decide update notification. */
export function decideUpdateNotification(context: UpdateNotificationContext): UpdateNotificationPlan | null {
  if (!context.enabled || context.status !== "available") {
    return null;
  }
  const version = context.latestVersion;
  if (!version || version === context.alreadyNotifiedVersion) {
    return null;
  }
  return { silent: !context.soundEnabled, version };
}
