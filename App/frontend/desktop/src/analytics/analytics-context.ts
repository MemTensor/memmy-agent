export type AnalyticsUserMode = "account" | "byok" | "unset";

let currentUserMode: AnalyticsUserMode = "unset";

export function setAnalyticsUserMode(mode: AnalyticsUserMode): void {
  currentUserMode = mode;
}

export function getAnalyticsUserMode(): AnalyticsUserMode {
  return currentUserMode;
}

export function resolveAnalyticsUserModeParams(): { user_mode?: "account" | "byok" } {
  if (currentUserMode === "account" || currentUserMode === "byok") {
    return { user_mode: currentUserMode };
  }
  return {};
}

export function mergeAnalyticsEventParams(
  params?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return { ...resolveAnalyticsUserModeParams(), ...params };
}

/** Test helper to reset module state between cases. */
export function resetAnalyticsContextForTests(): void {
  currentUserMode = "unset";
}
