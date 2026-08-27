/** Hosts the GitHub star prompt across all routes after agent turn completion. */
import { useEffect, useRef, useState } from "react";
import {
  markGithubStarPromptActioned,
  markGithubStarPromptDismissed,
  markGithubStarPromptShown,
  readGithubStarPromptState,
  shouldOfferGithubStarPrompt
} from "../app/github-star-prompt-state.js";
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
    const completion = state.agent.lastTaskCompletion;
    if (!completion || lastHandledCompletionAt.current === completion.at) {
      return;
    }
    lastHandledCompletionAt.current = completion.at;

    if (open) {
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
