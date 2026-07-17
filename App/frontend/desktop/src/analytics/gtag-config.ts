export type AnalyticsAppEnv = "dev" | "prod";

export function resolveAnalyticsAppEnv(isProd = import.meta.env.PROD): AnalyticsAppEnv {
  return isProd ? "prod" : "dev";
}

/** Dev builds always debug; prod can opt in via VITE_GA4_DEBUG=true. */
export function resolveGtagDebugMode(
  isDev = import.meta.env.DEV,
  explicitDebug = (import.meta.env.VITE_GA4_DEBUG as string | undefined) === "true"
): boolean {
  return isDev || explicitDebug;
}

export function resolveGtagConfigOptions(input?: {
  isProd?: boolean;
  isDev?: boolean;
  explicitDebug?: boolean;
}): {
  send_page_view: false;
  app_env: AnalyticsAppEnv;
  debug_mode?: true;
} {
  const isProd = input?.isProd ?? import.meta.env.PROD;
  const isDev = input?.isDev ?? import.meta.env.DEV;
  const explicitDebug =
    input?.explicitDebug ?? (import.meta.env.VITE_GA4_DEBUG as string | undefined) === "true";
  const debugMode = resolveGtagDebugMode(isDev, explicitDebug);

  return {
    send_page_view: false,
    app_env: resolveAnalyticsAppEnv(isProd),
    ...(debugMode ? { debug_mode: true } : {})
  };
}
