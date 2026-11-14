/**
 * Offers the one-time project-collaboration announcement, when the person first reaches a workspace.
 *
 * One run shows at most one large prompt and this one goes first: it claims the slot in the same effect that opens
 * it, before the other hosts read their own conditions, so they wait for the next launch instead of queueing behind.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createHttpCollabClient } from "../api/collab-client.js";
import { useOptionalApiClients } from "../app/providers.js";
import {
  areOtherPromptsDeferredForHistoryLaunch,
  isHistoryLaunchPromptOpen,
} from "../app/history-launch-prompt-state.js";
import { isTaskTokenGiftPromptOpen } from "./task-token-gift-prompt-host.js";
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
import { isDemoGuideActive } from "../app/collab-demo-guide-store.js";
import { useAppState } from "../state/app-state.js";
import { CollabLaunchDialog } from "./collab-launch-dialog.js";

function localStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function CollabLaunchPromptHost() {
  const { state } = useAppState();
  // Rendered inside the app shell, but also in tests and previews without providers: the card then has no client
  // and only offers the new-project button.
  const { clients } = useOptionalApiClients();
  const collab = useMemo(
    () => (clients ? createHttpCollabClient(clients.runtimeConfig) : null),
    [clients]
  );
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
    // 项目协作的新手引导正在演示：大卡让开，等演示结束后的下一次启动再说。
    if (isDemoGuideActive()) return;

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

    const otherPromptOpen = isTaskTokenGiftPromptOpen()
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
      collab={collab}
      onClose={() => {
        setOpen(false);
        setCollabLaunchPromptOpen(false);
      }}
      onCreateProject={() => {
        setOpen(false);
        setCollabLaunchPromptOpen(false);
        // The new-project dialog is mounted by AppFrame, so it opens over the current page; the board follows.
        // 从大卡进来就带着体验走：弹窗里有预填的名称与打开的协作开关，引导先只等人点「创建项目」。
        requestCreateProject({ share: true, demo: true });
      }}
    />
  );
}
