/** Startup module. */
import type { AppBootstrapResponse } from "@memmy/local-api-contracts";

export type StartupRoute = "onboarding" | "home";

/** Handles select startup route. */
export function selectStartupRoute(bootstrap: AppBootstrapResponse): StartupRoute {
  return bootstrap.onboarding.completed ? "home" : "onboarding";
}
