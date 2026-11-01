/** Offers Computer History once after the user actively enters Memory. */
import { useEffect, useRef, useState } from "react";
import { requestComputerHistoryLaunchEnable } from "../app/computer-history-launch-intent.js";
import { isComputerHistorySupported } from "../app/computer-history-platform.js";
import { isWorkspacePromptSessionReady, isWorkspacePromptSurfaceReady } from "../app/workspace-prompt-readiness.js";
import {
  deferOtherPromptsForHistoryLaunch,
  markHistoryLaunchPromptActioned,
  markHistoryLaunchPromptDismissed,
  markHistoryLaunchPromptShown,
  readHistoryLaunchPromptState,
  setHistoryLaunchPromptOpen,
  shouldOfferHistoryLaunchPrompt,
} from "../app/history-launch-prompt-state.js";
import { useGuidanceDone } from "../app/use-guidance-progress.js";
import { writeMemorySubPage } from "../pages/memory-sub-page-storage.js";
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
  const previousPathRef = useRef<string | null>(null);
  const triggerTimerRef = useRef<number | null>(null);
  const guidanceDone = useGuidanceDone(state.bootstrap?.onboarding?.completed === true);
  const surfaceReady = state.navigation.windowVisible !== false && isWorkspacePromptSurfaceReady({
    startupStatus: state.startup.status,
    currentPath: state.navigation.currentPath,
  });
  const sessionReady = isWorkspacePromptSessionReady({
    userMode: state.bootstrap?.app.userMode,
    accountUserId: state.account.userId,
    byokConfigured: Boolean(state.modelConfig?.catalog?.modelAssignments.byok.agent.candidates.length),
    guidanceDone,
  });

  useEffect(() => {
    const currentPath = state.navigation.currentPath;
    const previousPath = previousPathRef.current;
    previousPathRef.current = currentPath;

    if (triggerTimerRef.current !== null) {
      window.clearTimeout(triggerTimerRef.current);
      triggerTimerRef.current = null;
    }
    if (open || offeredRef.current) return;
    // Do not interrupt startup. The opportunity is a deliberate transition into
    // Memory from another workspace page, after the page has settled briefly.
    if (!surfaceReady || !sessionReady || !isComputerHistorySupported()
      || currentPath !== "/memory" || previousPath === null || previousPath === "/memory") return;

    const storage = localStorage();
    if (!shouldOfferHistoryLaunchPrompt({
      state: readHistoryLaunchPromptState(storage),
      supported: true,
    })) {
      offeredRef.current = true;
      return;
    }

    triggerTimerRef.current = window.setTimeout(() => {
      triggerTimerRef.current = null;
      offeredRef.current = true;
      markHistoryLaunchPromptShown(storage);
      setHistoryLaunchPromptOpen(true);
      setOpen(true);
    }, 900);
    return () => {
      if (triggerTimerRef.current !== null) {
        window.clearTimeout(triggerTimerRef.current);
        triggerTimerRef.current = null;
      }
    };
  }, [open, sessionReady, state.navigation.currentPath, surfaceReady]);

  if (!open) return null;

  return <HistoryLaunchPrompt
    onDismiss={() => {
      markHistoryLaunchPromptDismissed(localStorage());
      setOpen(false);
      setHistoryLaunchPromptOpen(false);
    }}
    onEnable={() => {
      markHistoryLaunchPromptActioned(localStorage());
      deferOtherPromptsForHistoryLaunch(typeof window === "undefined" ? undefined : window.sessionStorage);
      setOpen(false);
      setHistoryLaunchPromptOpen(false);
      writeMemorySubPage(typeof window === "undefined" ? undefined : window.sessionStorage, "computer-history");
      requestComputerHistoryLaunchEnable(typeof window === "undefined" ? undefined : window.sessionStorage);
      dispatch(appActions.navigate("/memory"));
    }}
  />;
}
