/** Hosts the GitHub star prompt across all routes after agent turn completion. */
import { useEffect, useRef, useState } from "react";
import { isTaskTokenGiftPromptOpen } from "./task-token-gift-prompt-host.js";
import { hasCollabLaunchPromptClaimedThisRun, isCollabLaunchPromptOpen } from "../app/collab-launch-prompt-state.js";
import {
  markGithubStarPromptActioned,
  markGithubStarPromptDismissed,
  markGithubStarPromptShown,
  readGithubStarPromptState,
  shouldOfferGithubStarPrompt
} from "../app/github-star-prompt-state.js";
import { isDemoGuideActive } from "../app/collab-demo-guide-store.js";
import { reportOnboardingPromptOpen } from "../app/onboarding-activity.js";
import { communityLinks } from "../community/community-links.js";
import { useAppState } from "../state/app-state.js";
import { openExternalUrl } from "../utils/open-url.js";
import { GithubStarPrompt } from "./github-star-prompt.js";

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Listens for completed agent turns and shows the star prompt when eligible. */
export function GithubStarPromptHost() {
  const { state } = useAppState();
  const [open, setOpen] = useState(false);
  const lastHandledCompletionAt = useRef<number | null>(null);

  useEffect(() => {
    // 新手引导演示期间不打断：星标提示留到下次。
    if (isDemoGuideActive()) return;
    const completion = state.agent.lastTaskCompletion;
    if (!completion || lastHandledCompletionAt.current === completion.at) {
      return;
    }
    lastHandledCompletionAt.current = completion.at;

    if (open || isTaskTokenGiftPromptOpen() || isCollabLaunchPromptOpen() || hasCollabLaunchPromptClaimedThisRun()) {
      return;
    }

    const storage = browserStorage();
    const persisted = readGithubStarPromptState(storage);
    if (!shouldOfferGithubStarPrompt(persisted)) {
      return;
    }

    markGithubStarPromptShown(storage);
    setOpen(true);
  }, [open, state.agent.lastTaskCompletion]);

  useEffect(() => {
    // 与协作项目的大卡共享「屏幕上有没有既有提示」：星标提示关掉之后大卡才重新开始计时。
    reportOnboardingPromptOpen("github-star", open);
    return () => reportOnboardingPromptOpen("github-star", false);
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <GithubStarPrompt
      onDismiss={() => {
        markGithubStarPromptDismissed(browserStorage());
        setOpen(false);
      }}
      onStar={() => {
        markGithubStarPromptActioned(browserStorage());
        setOpen(false);
        void openExternalUrl(communityLinks.githubUrl);
      }}
    />
  );
}
