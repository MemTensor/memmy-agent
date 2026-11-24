import type { TaskTokenGiftNotice } from "@memmy/local-api-contracts";
import { useEffect, useRef, useState } from "react";
import { isWorkspacePromptSurfaceReady } from "../app/workspace-prompt-readiness.js";
import { hasCollabLaunchPromptClaimedThisRun, isCollabLaunchPromptOpen } from "../app/collab-launch-prompt-state.js";
import { isDemoGuideActive } from "../app/collab-demo-guide-store.js";
import { reportOnboardingPromptOpen } from "../app/onboarding-activity.js";
import { resolveLaunchGiftPrompt } from "../app/task-token-gift-prompt.js";
import { useGuidanceDone } from "../app/use-guidance-progress.js";
import { useOptionalApiClients } from "../app/providers.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { TaskTokenGiftDialog } from "./task-token-gift-dialog.js";

type CreditedGift = Extract<TaskTokenGiftNotice, { hasGift: true }>;
type Offer = { userId: string; gift: CreditedGift };
let promptOpen = false;
export function isTaskTokenGiftPromptOpen(): boolean { return promptOpen; }

/** Offers a notice only after the cloud has idempotently credited the signed-in account. */
export function TaskTokenGiftPromptHost() {
  const { state, dispatch } = useAppState();
  // 新手引导演示期间不弹任何赠送提示：蒙版下只走一条关键路径。
  const demoGuideActive = isDemoGuideActive();
  const { clients } = useOptionalApiClients();
  const [offer, setOffer] = useState<Offer | null>(null);
  const requestRef = useRef<{ userId: string; request: Promise<void> } | null>(null);
  const offeredForRef = useRef<string | null>(null);
  const previousUserIdRef = useRef(state.account.userId);
  const accountRef = useRef(state.account.userId);
  accountRef.current = state.account.userId;
  const guidanceDone = useGuidanceDone(state.bootstrap?.onboarding?.completed === true);
  const ready = !demoGuideActive && state.bootstrap?.app.userMode === "account" && Boolean(state.account.userId) && guidanceDone
    && state.navigation.windowVisible !== false && isWorkspacePromptSurfaceReady({
      startupStatus: state.startup.status, currentPath: state.navigation.currentPath
    });

  useEffect(() => {
    if (previousUserIdRef.current !== state.account.userId) {
      previousUserIdRef.current = state.account.userId;
      offeredForRef.current = null;
      setOffer(null);
    } else if (offer && !ready) {
      setOffer(null);
    }
  }, [offer, ready, state.account.userId]);
  useEffect(() => {
    // 与协作项目的大卡共享「屏幕上有没有既有提示」：赠送提示关掉之后大卡才重新开始计时。
    reportOnboardingPromptOpen("task-token-gift", offer !== null);
    return () => reportOnboardingPromptOpen("task-token-gift", false);
  }, [offer]);

  useEffect(() => {
    promptOpen = offer !== null;
    return () => { promptOpen = false; };
  }, [offer]);

  useEffect(() => {
    if (!ready || !clients || !state.account.userId || offer) return;
    const userId = state.account.userId;
    if (offeredForRef.current === userId) return;
    const check = () => {
      if (requestRef.current?.userId === userId) return;
      const request = clients.account.ensureTaskTokenGift().then((notice) => {
        if (accountRef.current !== userId) return;
        const plan = resolveLaunchGiftPrompt(notice);
        if (notice.hasGift && notice.tokenAmount !== 20_000_000) console.warn("[task-gift] unexpected grant amount:", notice.tokenAmount);
        const refreshBalance = () => {
          void clients.bootstrap.getBootstrap().then((bootstrap) => {
            if (accountRef.current === userId) dispatch(appActions.tokenUsageUpdated(bootstrap.tokenUsage));
          }).catch((error: unknown) => console.warn("[task-gift] balance refresh failed:", error));
        };
        if (plan.ackWithoutPrompt && notice.hasGift) {
          offeredForRef.current = userId;
          refreshBalance();
          void clients.account.ackTaskTokenGift({ grantId: notice.grantId })
            .catch((error: unknown) => console.warn("[task-gift] acknowledgement failed:", error));
          return;
        }
        // A grant may finish after the announcement claims this run. Keep the
        // credited balance current, but leave its unseen notice unacknowledged.
        if (isCollabLaunchPromptOpen() || hasCollabLaunchPromptClaimedThisRun()) {
          if (notice.hasGift) refreshBalance();
          return;
        }
        if (!plan.showGift || !notice.hasGift) return;
        offeredForRef.current = userId;
        setOffer({ userId, gift: notice });
        refreshBalance();
      }).catch((error: unknown) => console.warn("[task-gift] status check failed:", error))
        .finally(() => { if (requestRef.current?.request === request) requestRef.current = null; });
      requestRef.current = { userId, request };
    };
    const timer = window.setTimeout(check, 450);
    window.addEventListener("focus", check);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", check); };
  }, [clients, dispatch, offer, ready, state.account.userId]);

  if (!offer || offer.userId !== state.account.userId) return null;
  return <TaskTokenGiftDialog gift={offer.gift}
    onClose={() => {
      setOffer(null);
      void clients?.account.ackTaskTokenGift({ grantId: offer.gift.grantId })
        .catch((error: unknown) => console.warn("[task-gift] acknowledgement failed:", error));
    }} />;
}
