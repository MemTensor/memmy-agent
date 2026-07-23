export type AnalyticsAppEnv = "dev" | "prod";
export type AnalyticsAppEdition = "cn" | "intl";

export function resolveAnalyticsAppEnv(isProd = import.meta.env.PROD): AnalyticsAppEnv {
  return isProd ? "prod" : "dev";
}

/** Matches legal-links: MEMMY_APP_EDITION=intl → intl, otherwise cn. */
export function resolveAnalyticsAppEdition(
  rawEdition = import.meta.env.MEMMY_APP_EDITION as string | undefined
): AnalyticsAppEdition {
  return rawEdition?.trim().toLowerCase() === "intl" ? "intl" : "cn";
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
  appEdition?: AnalyticsAppEdition;
}): {
  send_page_view: false;
  app_env: AnalyticsAppEnv;
  app_edition: AnalyticsAppEdition;
  debug_mode?: 1;
} {
  const isProd = input?.isProd ?? import.meta.env.PROD;
  const isDev = input?.isDev ?? import.meta.env.DEV;
  const explicitDebug =
    input?.explicitDebug ?? (import.meta.env.VITE_GA4_DEBUG as string | undefined) === "true";
  const debugMode = resolveGtagDebugMode(isDev, explicitDebug);

  return {
    send_page_view: false,
    app_env: resolveAnalyticsAppEnv(isProd),
    app_edition: input?.appEdition ?? resolveAnalyticsAppEdition(),
    ...(debugMode ? { debug_mode: 1 } : {})
  };
}
