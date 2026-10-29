import type { TaskTokenGiftNotice } from "@memmy/local-api-contracts";
import { formatMessage, messageCatalogs } from "../i18n/messages.js";

/** The feature introduction remains visible through November 20, Beijing time. */
export const TASK_GIFT_FEATURE_PROMO_END = "2026-11-21T00:00:00+08:00";
const FEATURE_ANNOUNCEMENT_ID = "v125-marketplace-recording";

export function isLaunchFeatureAnnouncementActive(nowMs = Date.now()): boolean {
  return nowMs < Date.parse(TASK_GIFT_FEATURE_PROMO_END);
}

export function featureAnnouncementSeenKey(userId: string): string {
  return `memmy.featureAnnouncement.${FEATURE_ANNOUNCEMENT_ID}.${userId}`;
}

export interface LaunchGiftPromptPlan {
  /** Existing users with an unread 20M grant. New users never see this page. */
  showGift: boolean;
  /** Both audiences, only while the promo is active and this notice is still unread. */
  showFeatures: boolean;
  /** New users outside the feature window: consume the unread notice without a dialog. */
  ackWithoutPrompt: boolean;
}

/**
 * One appearance per account. The unread cloud notice is the latch: acknowledging it
 * on dismiss suppresses both the gift page and the feature pages on every device.
 * Through 2026-11-20 24:00 Beijing, existing users see gift + features, and new users
 * see features only. After that, existing users see the gift page alone.
 */
export function resolveLaunchGiftPrompt(notice: TaskTokenGiftNotice, featuresSeen: boolean, nowMs = Date.now()): LaunchGiftPromptPlan {
  const audience = notice.audience;
  const unreadGift = notice.hasGift && notice.tokenAmount === 20_000_000;
  const showGift = audience === "existing" && unreadGift;
  const showFeatures = !featuresSeen && unreadGift && isLaunchFeatureAnnouncementActive(nowMs)
    && (audience === "new" || audience === "existing");
  return {
    showGift,
    showFeatures,
    ackWithoutPrompt: audience === "new" && unreadGift && !showFeatures
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
