/**
 * Offers the one-time project-collaboration announcement, when the person first reaches a workspace.
 *
 * One run shows at most one large prompt and this one goes first: it claims the slot in the same effect that opens
 * it, before the other hosts read their own conditions, so they wait for the next launch instead of queueing behind.
 *
 * It also goes last among the existing new-user guidance: the scan permission, the improvement program, the product
 * tour and the nickname step all come first, and the workspace then has to stay quiet for a few seconds before the
 * card opens — otherwise a deferred step can land right after "onboarding completed" and stack on top of the card.
 */
import { useEffect, useRef, useState } from "react";
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
import { useOnboardingQuiet } from "../app/use-onboarding-quiet.js";
import { requestCreateProject } from "../app/collab-projects-store.js";
import { isDemoGuideActive, readDemoGuideDone } from "../app/collab-demo-guide-store.js";
import { useAppState } from "../state/app-state.js";
import { CollabLaunchDialog } from "./collab-launch-dialog.js";

function localStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function sessionStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.sessionStorage;
}

export function CollabLaunchPromptHost() {
  const { state } = useAppState();
  const [open, setOpen] = useState(false);
  const offeredRef = useRef(false);
  const preview = isDesktopPromptPreview("collabLaunch");
  const surfaceReady = state.navigation.windowVisible !== false && isCollabLaunchSurfaceReady({
    startupStatus: state.startup.status,
    currentPath: state.navigation.currentPath,
  });
  const userMode = state.bootstrap?.app.userMode;
  const accountUserId = state.account.userId;
  const demoGuideActive = isDemoGuideActive();
  // The quiet clock only runs while the card genuinely has a chance to open, so switching routes or an already-seen
  // record cannot count towards it.
  const guidance = useOnboardingQuiet({
    onboardingCompleted: state.bootstrap?.onboarding?.completed === true,
    ready: !preview && !open && !demoGuideActive && !offeredRef.current && surfaceReady
      && !readCollabLaunchPromptSeen(localStorage()),
  });

  useEffect(() => {
    if (open || offeredRef.current) return;
    if (demoGuideActive) return;

    // Dev preview: any workspace is enough, no account, and the local record is neither read nor written. It also
    // skips the quiet window, so the card can be checked without waiting for the whole new-user guidance.
    if (preview) {
      if (!surfaceReady) return;
      offeredRef.current = true;
      claimCollabLaunchPrompt();
      setCollabLaunchPromptOpen(true);
      setOpen(true);
      return;
    }

    if (!surfaceReady) return;
    // 既有新手引导还没走完，或者刚结束还没安静下来：大卡继续等，别盖在引导上面。
    if (!guidance.complete || !guidance.quiet) return;

    const otherPromptOpen = isTaskTokenGiftPromptOpen()
      || isHistoryLaunchPromptOpen()
      || areOtherPromptsDeferredForHistoryLaunch(sessionStorage());
    const storage = localStorage();
    if (!shouldOfferCollabLaunchPrompt({
      userMode,
      accountUserId,
      guidanceDone: guidance.complete,
      seen: readCollabLaunchPromptSeen(storage),
      otherPromptOpen,
    })) return;

    // Claimed and recorded together while it opens: a crash afterwards must not bring it back.
    offeredRef.current = true;
    claimCollabLaunchPrompt();
    markCollabLaunchPromptSeen(storage);
    setCollabLaunchPromptOpen(true);
    setOpen(true);
  }, [accountUserId, demoGuideActive, guidance.complete, guidance.quiet, open, preview, surfaceReady, userMode]);

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
        // 从大卡进来就带着体验走：弹窗里有预填的名称与打开的协作开关，引导先只等人点「创建项目」。
        // 本机已经退出过引导就不再演示：弹窗照开、共享照默认开，只是不带人走。
        // 既有引导还有一步排在后面（如「再等首次点侧栏」）时不带演示：小饭团不能和那张弹窗同屏。
        // 预览模式强制开引导：它不读本机记录，专门用来在已看过引导的机器上也能验证流程。
        requestCreateProject({
          share: true,
          demo: preview ? true : (!readDemoGuideDone() && guidance.complete && !guidance.stepQueued),
        });
      }}
    />
  );
}
