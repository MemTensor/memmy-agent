import { GithubStarPromptHost } from "./github-star-prompt-host.js";
import { HistoryLaunchPromptHost } from "./history-launch-prompt-host.js";
import { TaskTokenGiftPromptHost } from "./task-token-gift-prompt-host.js";

/** Keeps active account notices together without restoring the ended campaign. */
export function AccountNotificationHosts() {
  return (
    <>
      <TaskTokenGiftPromptHost />
      <HistoryLaunchPromptHost />
      <GithubStarPromptHost />
    </>
  );
}
