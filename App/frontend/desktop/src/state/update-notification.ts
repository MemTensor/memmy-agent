/** Contract for update notification context. */

export interface UpdateNotificationContext {
  enabled: boolean;
  soundEnabled: boolean;
  status: string;
  latestVersion?: string;
  notificationKey?: string;
  alreadyNotifiedKey: string | null;
}

export interface UpdateNotificationPlan {
  silent: boolean;
  key: string;
  version?: string;
}

/** Handles decide update notification. */
export function decideUpdateNotification(context: UpdateNotificationContext): UpdateNotificationPlan | null {
  if (!context.enabled || context.status !== "available") {
    return null;
  }
  const key = context.latestVersion ?? context.notificationKey;
  if (!key || key === context.alreadyNotifiedKey) {
    return null;
  }
  return {
    silent: !context.soundEnabled,
    key,
    ...(context.latestVersion ? { version: context.latestVersion } : {})
  };
}
