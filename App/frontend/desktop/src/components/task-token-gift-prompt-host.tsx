import type { TaskTokenGiftNotice } from "@memmy/local-api-contracts";
import { useEffect, useRef, useState } from "react";
import { isWorkspacePromptSurfaceReady } from "../app/workspace-prompt-readiness.js";
import { featureAnnouncementSeenKey, resolveLaunchGiftPrompt } from "../app/task-token-gift-prompt.js";
import { useGuidanceDone } from "../app/use-guidance-progress.js";
import { useOptionalApiClients } from "../app/providers.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { TaskTokenGiftDialog } from "./task-token-gift-dialog.js";

type CreditedGift = Extract<TaskTokenGiftNotice, { hasGift: true }>;
type Offer = { userId: string; gift?: CreditedGift; showFeatures: boolean; ackGrantId?: string };
let promptOpen = false;
export function isTaskTokenGiftPromptOpen(): boolean { return promptOpen; }

/** Offers a notice only after the cloud has idempotently credited the signed-in account. */
export function TaskTokenGiftPromptHost() {
  const { state, dispatch } = useAppState();
  const { clients } = useOptionalApiClients();
  const [offer, setOffer] = useState<Offer | null>(null);
  const requestRef = useRef<{ userId: string; request: Promise<void> } | null>(null);
  const offeredForRef = useRef<string | null>(null);
  const previousUserIdRef = useRef(state.account.userId);
  const accountRef = useRef(state.account.userId);
  accountRef.current = state.account.userId;
  const guidanceDone = useGuidanceDone(state.bootstrap?.onboarding?.completed === true);
  const ready = state.bootstrap?.app.userMode === "account" && Boolean(state.account.userId) && guidanceDone
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
        const seen = window.localStorage.getItem(featureAnnouncementSeenKey(userId)) === "1";
        const plan = resolveLaunchGiftPrompt(notice, seen);
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
        if (!plan.showGift && !plan.showFeatures) return;
        offeredForRef.current = userId;
        const gift = plan.showGift && notice.hasGift ? notice : undefined;
        setOffer({ userId, showFeatures: plan.showFeatures, ...(gift ? { gift } : {}), ...(notice.hasGift ? { ackGrantId: notice.grantId } : {}) });
        if (notice.hasGift) refreshBalance();
      }).catch((error: unknown) => console.warn("[task-gift] status check failed:", error))
        .finally(() => { if (requestRef.current?.request === request) requestRef.current = null; });
      requestRef.current = { userId, request };
    };
    const timer = window.setTimeout(check, 450);
    window.addEventListener("focus", check);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", check); };
  }, [clients, dispatch, offer, ready, state.account.userId]);

  if (!offer || offer.userId !== state.account.userId) return null;
  return <TaskTokenGiftDialog gift={offer.gift} showFeatures={offer.showFeatures}
    onClose={() => {
      setOffer(null);
      if (offer.showFeatures) window.localStorage.setItem(featureAnnouncementSeenKey(offer.userId), "1");
      const grantId = offer.gift?.grantId ?? offer.ackGrantId;
      if (grantId) {
        void clients?.account.ackTaskTokenGift({ grantId })
          .catch((error: unknown) => console.warn("[task-gift] acknowledgement failed:", error));
      }
    }}
    onFeaturesCompleted={() => window.localStorage.setItem(featureAnnouncementSeenKey(offer.userId), "1")} />;
}
