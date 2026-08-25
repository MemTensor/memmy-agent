export type AnalyticsUserMode = "account" | "account_byok" | "byok" | "unset";
export type AnalyticsModelSource = "platform" | "byok";

let currentUserMode: AnalyticsUserMode = "unset";
let currentUserId: string | null = null;
let currentModelSource: AnalyticsModelSource | null = null;

export function setAnalyticsUserMode(mode: AnalyticsUserMode): void {
  currentUserMode = mode;
}

export function getAnalyticsUserMode(): AnalyticsUserMode {
  return currentUserMode;
}

/** Mirrors the backend transport: the BYOK placeholder is not a cloud identity. */
export function normalizeAnalyticsUserId(userId: string | null | undefined): string | null {
  const trimmed = userId?.trim() || null;
  if (!trimmed || trimmed === "local-user") return null;
  return trimmed;
}

export function setAnalyticsUserId(userId: string | null | undefined): void {
  currentUserId = normalizeAnalyticsUserId(userId);
}

export function getAnalyticsUserId(): string | null {
  return currentUserId;
}

export function setAnalyticsModelSource(source: AnalyticsModelSource | null): void {
  currentModelSource = source;
}

export function resolveAnalyticsUserModeParams(): { user_mode: "account" | "account_byok" | "byok" } {
  if (!currentUserId) return { user_mode: "byok" };
  if (currentModelSource === "byok") return { user_mode: "account_byok" };
  if (currentModelSource === "platform") return { user_mode: "account" };
  if (currentUserMode === "byok" || currentUserMode === "account_byok") {
    return { user_mode: "account_byok" };
  }
  return { user_mode: "account" };
}

export function mergeAnalyticsEventParams(
  params?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return { ...resolveAnalyticsUserModeParams(), ...params };
}

/** Test helper to reset module state between cases. */
export function resetAnalyticsContextForTests(): void {
  currentUserMode = "unset";
  currentUserId = null;
  currentModelSource = null;
}
