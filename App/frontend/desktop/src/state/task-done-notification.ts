/** Contract for task done notification context. */

export interface TaskDoneNotificationContext {
  // Enabled.
  enabled: boolean;
  // Sound enabled.
  soundEnabled: boolean;
  // Window focused.
  windowFocused: boolean;
}

export interface TaskDoneNotificationPlan {
  // Silent.
  silent: boolean;
}

/** Handles decide task done notification. */
export function decideTaskDoneNotification(context: TaskDoneNotificationContext): TaskDoneNotificationPlan | null {
  if (!context.enabled || context.windowFocused) {
    return null;
  }
  return { silent: !context.soundEnabled };
}
