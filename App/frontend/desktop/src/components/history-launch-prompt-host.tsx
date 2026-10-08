/** Offers Computer History once, through 2026-10-31 China time. */
import { useEffect, useRef, useState } from "react";
import { requestComputerHistoryLaunchEnable } from "../app/computer-history-launch-intent.js";
import { isComputerHistorySupported } from "../app/computer-history-platform.js";
import {
  isCampaignPromptSessionReady,
  isCampaignPromptSurfaceReady,
  isGuidanceDone,
} from "../app/campaign-prompt-state.js";
import { isDesktopPromptPreview } from "../app/desktop-prompt-preview.js";
import {
  deferOtherPromptsForHistoryLaunch,
  markHistoryLaunchPromptActioned,
  markHistoryLaunchPromptDismissed,
  markHistoryLaunchPromptShown,
  readHistoryLaunchPromptState,
  setHistoryLaunchPromptOpen,
  shouldOfferHistoryLaunchPrompt,
} from "../app/history-launch-prompt-state.js";
import { readDeferredGuidanceStep, readGuidanceCompleted } from "../app/routes.js";
import { writeMemorySubPage } from "../pages/memory-page.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { HistoryLaunchPrompt } from "./history-launch-prompt.js";

function localStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function HistoryLaunchPromptHost() {
  const { state, dispatch } = useAppState();
  const [open, setOpen] = useState(false);
  const offeredRef = useRef(false);
  const preview = isDesktopPromptPreview("history");
  const surfaceReady = isCampaignPromptSurfaceReady({
    startupStatus: state.startup.status,
    currentPath: state.navigation.currentPath,
  });
  const sessionReady = isCampaignPromptSessionReady({
    userMode: state.bootstrap?.app.userMode,
    accountUserId: state.account.userId,
    byokConfigured: Boolean(state.modelConfig?.catalog?.modelAssignments.byok.agent.candidates.length),
    guidanceDone: isGuidanceDone({
      guidanceCompleted: readGuidanceCompleted(localStorage()),
      onboardingCompleted: state.bootstrap?.onboarding?.completed === true,
      deferredGuidanceStep: readDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage),
    }),
  });

  useEffect(() => {
    if (open || offeredRef.current) return;
    if (preview) {
      offeredRef.current = true;
      setHistoryLaunchPromptOpen(true);
      setOpen(true);
      return;
    }
    if (!surfaceReady || !sessionReady) return;

    offeredRef.current = true;
    const storage = localStorage();
    if (!shouldOfferHistoryLaunchPrompt({
      state: readHistoryLaunchPromptState(storage),
      supported: isComputerHistorySupported(),
    })) return;
    markHistoryLaunchPromptShown(storage);
    setHistoryLaunchPromptOpen(true);
    setOpen(true);
  }, [open, preview, sessionReady, surfaceReady]);

  if (!open) return null;

  return <HistoryLaunchPrompt
    onDismiss={() => {
      if (!preview) markHistoryLaunchPromptDismissed(localStorage());
      setOpen(false);
      setHistoryLaunchPromptOpen(false);
    }}
    onEnable={() => {
      if (!preview) markHistoryLaunchPromptActioned(localStorage());
      deferOtherPromptsForHistoryLaunch(typeof window === "undefined" ? undefined : window.sessionStorage);
      setOpen(false);
      setHistoryLaunchPromptOpen(false);
      writeMemorySubPage(typeof window === "undefined" ? undefined : window.sessionStorage, "computer-history");
      requestComputerHistoryLaunchEnable(typeof window === "undefined" ? undefined : window.sessionStorage);
      dispatch(appActions.navigate("/memory"));
    }}
  />;
}
