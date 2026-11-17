import type { TaskTokenGiftNotice } from "@memmy/local-api-contracts";
import { formatMessage, messageCatalogs } from "../i18n/messages.js";

export interface LaunchGiftPromptPlan {
  /** Existing users with an unread 20M grant. New users never see this page. */
  showGift: boolean;
  /** New users: consume the unread notice without a dialog. */
  ackWithoutPrompt: boolean;
}

/**
 * One appearance per account. The unread cloud notice is the latch: acknowledging it
 * on dismiss suppresses the gift page on every device. Existing users see the single
 * gift page; a new user's grant is acknowledged silently, without a dialog.
 */
export function resolveLaunchGiftPrompt(notice: TaskTokenGiftNotice): LaunchGiftPromptPlan {
  const unreadGift = notice.hasGift && notice.tokenAmount === 20_000_000;
  return {
    showGift: notice.audience === "existing" && unreadGift,
    ackWithoutPrompt: notice.audience === "new" && unreadGift
  };
}

export function formatGiftAmount(tokens: number, language: "zh-CN" | "en-US"): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return formatMessage(messageCatalogs[language]["launchGift.tokenAmountShort"], {
      amount: language === "zh-CN" ? tokens / 10_000 : tokens / 1_000_000
    });
  }
  return tokens.toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US");
}
