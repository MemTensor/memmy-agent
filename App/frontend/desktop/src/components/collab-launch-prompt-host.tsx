/**
 * Offers the 1.2.7 project-collaboration announcement once, when the person first reaches a workspace.
 *
 * One run shows at most one large prompt and this one goes first: it claims the slot in the same effect that opens
 * it, before the other hosts read their own conditions, so they wait for the next launch instead of queueing behind.
 */
import { useEffect, useRef, useState } from "react";
import {
  areOtherPromptsDeferredForHistoryLaunch,
  isHistoryLaunchPromptOpen,
} from "../app/history-launch-prompt-state.js";
import { isCampaignPromptOpen } from "../app/campaign-prompt-state.js";
import {
  claimCollabLaunchPrompt,
  isCollabLaunchSurfaceReady,
  markCollabLaunchPromptSeen,
  readCollabLaunchPromptSeen,
  setCollabLaunchPromptOpen,
  shouldOfferCollabLaunchPrompt,
} from "../app/collab-launch-prompt-state.js";
import { isDesktopPromptPreview } from "../app/desktop-prompt-preview.js";
import { useGuidanceDone } from "../app/use-guidance-progress.js";
import { requestCreateProject } from "../app/collab-projects-store.js";
import { useAppState } from "../state/app-state.js";
import { CollabLaunchDialog } from "./collab-launch-dialog.js";

function localStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function CollabLaunchPromptHost() {
  const { state } = useAppState();
  const [open, setOpen] = useState(false);
  const offeredRef = useRef(false);
  const preview = isDesktopPromptPreview("collabLaunch");
  const guidanceDone = useGuidanceDone(state.bootstrap?.onboarding?.completed === true);
  const surfaceReady = state.navigation.windowVisible !== false && isCollabLaunchSurfaceReady({
    startupStatus: state.startup.status,
    currentPath: state.navigation.currentPath,
  });
  const userMode = state.bootstrap?.app.userMode;
  const accountUserId = state.account.userId;

  useEffect(() => {
    if (open || offeredRef.current) return;

    // Dev preview: any workspace is enough, no account, and the local record is neither read nor written.
    if (preview) {
      if (!surfaceReady) return;
      offeredRef.current = true;
      claimCollabLaunchPrompt();
      setCollabLaunchPromptOpen(true);
      setOpen(true);
      return;
    }

    if (!surfaceReady) return;

    const otherPromptOpen = isCampaignPromptOpen()
      || isHistoryLaunchPromptOpen()
      || areOtherPromptsDeferredForHistoryLaunch(typeof window === "undefined" ? undefined : window.sessionStorage);
    const storage = localStorage();
    if (!shouldOfferCollabLaunchPrompt({
      userMode,
      accountUserId,
      guidanceDone,
      seen: readCollabLaunchPromptSeen(storage),
      otherPromptOpen,
    })) return;

    // Claimed and recorded together while it opens: a crash afterwards must not bring it back.
    offeredRef.current = true;
    claimCollabLaunchPrompt();
    markCollabLaunchPromptSeen(storage);
    setCollabLaunchPromptOpen(true);
    setOpen(true);
  }, [accountUserId, guidanceDone, open, preview, surfaceReady, userMode]);

  if (!open) return null;

  return (
    <CollabLaunchDialog
      onClose={() => {
        setOpen(false);
        setCollabLaunchPromptOpen(false);
      }}
      onCreateProject={() => {
        setOpen(false);
        setCollabLaunchPromptOpen(false);
        // The new-project dialog is mounted by AppFrame, so it opens over the current page; the board follows.
        requestCreateProject({ share: true });
      }}
    />
  );
}
