/** Enqueues an activity-reward notification with explicitly denominated credits. */
import { useCallback, useEffect, useRef } from "react";
import { isDesktopPromptPreview } from "../app/desktop-prompt-preview.js";
import { useOptionalApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { formatTokenGiftAmount } from "../pages/token-gift.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { useNotificationCenter } from "./notification-center.js";

const PREVIEW_CREDIT_AMOUNT = 200;

/** Pushes a manual-close notice for the latest unacknowledged campaign reward. */
export function TokenCreditToastHost() {
  const { state, dispatch } = useAppState();
  const { clients } = useOptionalApiClients();
  const { t, language } = useTranslation();
  const { notify } = useNotificationCenter();
  const notifiedRef = useRef(false);
  const activeAccountUserIdRef = useRef<string | null>(null);
  const rewardRequestRef = useRef<{
    accountUserId: string;
    request: Promise<void>;
  } | null>(null);
  const shownRewardKeysRef = useRef(new Set<string>());

  /** Refreshes the token balance after the user closes the notice. */
  const refreshBalance = useCallback(() => {
    if (!clients) {
      return;
    }
    void clients.bootstrap
      .getBootstrap()
      .then((bootstrap) => dispatch(appActions.tokenUsageUpdated(bootstrap.tokenUsage)))
      .catch((error: unknown) => console.warn("[token-credit] failed to refresh token usage:", error));
  }, [clients, dispatch]);

  /** Enqueues the title + amount credit notification. */
  const showRewardCredit = useCallback((reward: { creditAmount?: number; tokenAmount?: number }, onClose: () => void = refreshBalance) => {
    const isCreditReward = reward.creditAmount !== undefined;
    notify({
      variant: "success",
      title: t(isCreditReward ? "tokenCredit.creditTitle" : "tokenCredit.title"),
      emphasis: isCreditReward
        ? t("tokenCredit.amount", { count: reward.creditAmount!.toLocaleString(language, { maximumFractionDigits: 2 }) })
        : `+${formatTokenGiftAmount(reward.tokenAmount ?? 0)}`,
      onClose
    });
  }, [notify, refreshBalance, t, language]);

  useEffect(() => {
    if (notifiedRef.current || !isDesktopPromptPreview("tokenCredit")) {
      return;
    }
    notifiedRef.current = true;
    showRewardCredit({ creditAmount: PREVIEW_CREDIT_AMOUNT });
  }, [showRewardCredit]);

  useEffect(() => {
    const accountUserId = state.account.userId;
    if (!clients || !accountUserId) {
      return;
    }
    const activeClients = clients;
    const activeAccountUserId = accountUserId;

    activeAccountUserIdRef.current = activeAccountUserId;

    function checkReward() {
      if (rewardRequestRef.current?.accountUserId === activeAccountUserId) {
        return;
      }

      const request = activeClients.account
        .getLotteryReward()
        .then((reward) => {
          if (activeAccountUserIdRef.current !== activeAccountUserId || !reward.hasReward) {
            return;
          }

          const amountKey = reward.creditAmount === undefined ? `tokens:${reward.tokenAmount}` : `credits:${reward.creditAmount}`;
          const rewardKey = reward.drawId ? `draw:${reward.drawId}` : `amount:${amountKey}`;
          if (shownRewardKeysRef.current.has(rewardKey)) {
            return;
          }
          shownRewardKeysRef.current.add(rewardKey);

          showRewardCredit(reward, () => {
            void activeClients.account
              .ackLotteryReward(reward.drawId ? { drawId: reward.drawId } : {})
              .catch((error: unknown) => console.warn("[token-credit] failed to acknowledge reward:", error))
              .finally(refreshBalance);
          });
        })
        .catch((error: unknown) => console.warn("[token-credit] failed to fetch reward:", error))
        .finally(() => {
          if (rewardRequestRef.current?.request === request) {
            rewardRequestRef.current = null;
          }
        });

      rewardRequestRef.current = { accountUserId: activeAccountUserId, request };
    }

    checkReward();
    window.addEventListener("focus", checkReward);
    return () => {
      if (activeAccountUserIdRef.current === activeAccountUserId) {
        activeAccountUserIdRef.current = null;
      }
      window.removeEventListener("focus", checkReward);
    };
  }, [clients, refreshBalance, showRewardCredit, state.account.userId]);

  return null;
}
