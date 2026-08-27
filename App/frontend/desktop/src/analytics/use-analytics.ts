import { useCallback } from "react";
import { trackCloudAnalyticsEvent } from "./cloud-analytics.js";
import type { AnalyticsEvent } from "./analytics-events.js";
import { useAppState } from "../state/app-state.js";

export function useAnalytics() {
  const { state } = useAppState();

  const track = useCallback(
    (event: AnalyticsEvent) => {
      if (event.consentTier === "improvement") {
        const improvementProgram = state?.bootstrap?.onboarding.improvementProgram;
        if (improvementProgram !== "accepted") {
          console.log("[analytics] track skipped (improvement consent not accepted):", event.name, event.params);
          return;
        }
      }

      const { name, params } = event;
      console.log("[analytics] track → cloud:", name, params);
      trackCloudAnalyticsEvent(name, params as Record<string, string | number | boolean> | undefined);
    },
    [state]
  );

  return { track, ready: true };
}
