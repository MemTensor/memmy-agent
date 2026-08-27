/** Builds stable memmy:// page locations for analytics, separate from the HTTP renderer origin. */
export function resolveAnalyticsPageLocationOrigin(isProd = import.meta.env.PROD): string {
  return isProd ? "memmy://prod.app" : "memmy://app";
}

export function resolveAnalyticsPageLocation(path: string, isProd = import.meta.env.PROD): string {
  return `${resolveAnalyticsPageLocationOrigin(isProd)}${path}`;
}
