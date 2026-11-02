/** Enqueues the token-credit notification after a campaign reward is granted. */
import { useCallback, useEffect, useRef } from "react";
import { isDesktopPromptPreview } from "../app/desktop-prompt-preview.js";
import { useOptionalApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { formatTokenGiftAmount } from "../pages/token-gift.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { useNotificationCenter } from "./notification-center.js";

const PREVIEW_TOKEN_AMOUNT = 500_000;

/** Pushes a manual-close notice for the latest unacknowledged campaign reward. */
export function TokenCreditToastHost() {
  const { state, dispatch } = useAppState();
  const { clients } = useOptionalApiClients();
  const { t } = useTranslation();
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
  const showTokenCredit = useCallback((tokens: number, onClose: () => void = refreshBalance) => {
    notify({
      variant: "success",
      title: t("tokenCredit.title"),
      emphasis: `+${formatTokenGiftAmount(tokens)}`,
      onClose
    });
  }, [notify, refreshBalance, t]);

  useEffect(() => {
    if (notifiedRef.current || !isDesktopPromptPreview("tokenCredit")) {
      return;
    }
    notifiedRef.current = true;
    showTokenCredit(PREVIEW_TOKEN_AMOUNT);
  }, [showTokenCredit]);

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

          const rewardKey = reward.drawId ? `draw:${reward.drawId}` : `amount:${reward.tokenAmount}`;
          if (shownRewardKeysRef.current.has(rewardKey)) {
            return;
          }
          shownRewardKeysRef.current.add(rewardKey);

          showTokenCredit(reward.tokenAmount, () => {
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
  }, [clients, refreshBalance, showTokenCredit, state.account.userId]);

  return null;
}
