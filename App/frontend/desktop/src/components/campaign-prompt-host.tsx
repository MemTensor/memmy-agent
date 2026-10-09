/** Hosts the Mid-Autumn campaign prompt on eligible app opens. */
import { useEffect, useRef, useState } from "react";
import { getCampaignActivityUrl } from "../app/campaign-prompt-url.js";
import {
  isGuidanceDone,
  isCampaignPromptOpen,
  isCampaignPromptSessionReady,
  isCampaignPromptSurfaceReady,
  markCampaignPromptActioned,
  markCampaignPromptDismissed,
  markCampaignPromptShown,
  readCampaignPromptState,
  setCampaignPromptOpen,
  shouldOfferCampaignPrompt
} from "../app/campaign-prompt-state.js";
import { isDesktopPromptPreview } from "../app/desktop-prompt-preview.js";
import { readDeferredGuidanceStep, readGuidanceCompleted } from "../app/routes.js";
import { useTranslation } from "../i18n/use-translation.js";
import { useAppState } from "../state/app-state.js";
import { openExternalUrl } from "../utils/open-url.js";
import { CampaignPrompt } from "./campaign-prompt.js";

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Shows the campaign reminder after the user enters a workspace with guidance settled. */
export function CampaignPromptHost() {
  const { state } = useAppState();
  const { language } = useTranslation();
  const [open, setOpen] = useState(false);
  const offeredRef = useRef(false);
  const preview = isDesktopPromptPreview("campaign");
  const surfaceReady = isCampaignPromptSurfaceReady({
    startupStatus: state.startup.status,
    currentPath: state.navigation.currentPath
  });
  const sessionReady = isCampaignPromptSessionReady({
    userMode: state.bootstrap?.app.userMode,
    accountUserId: state.account.userId,
    byokConfigured: Boolean(state.modelConfig?.catalog?.modelAssignments.byok.agent.candidates.length),
    guidanceDone: isGuidanceDone({
      guidanceCompleted: readGuidanceCompleted(browserStorage()),
      onboardingCompleted: state.bootstrap?.onboarding?.completed === true,
      deferredGuidanceStep: readDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage)
    })
  });

  useEffect(() => {
    if (open === isCampaignPromptOpen()) {
      return;
    }
    setCampaignPromptOpen(open);
    return () => {
      if (isCampaignPromptOpen()) {
        setCampaignPromptOpen(false);
      }
    };
  }, [open]);

  useEffect(() => {
    if (open || offeredRef.current) {
      return;
    }

    if (preview) {
      offeredRef.current = true;
      setOpen(true);
      return;
    }

    if (!surfaceReady || !sessionReady) {
      return;
    }

    const storage = browserStorage();
    const persisted = readCampaignPromptState(storage);
    if (!shouldOfferCampaignPrompt(persisted, state.bootstrap?.lotteryStatus)) {
      offeredRef.current = true;
      return;
    }

    offeredRef.current = true;
    markCampaignPromptShown(storage);
    setOpen(true);
  }, [open, preview, sessionReady, state.bootstrap?.lotteryStatus, surfaceReady]);

  if (!open) {
    return null;
  }

  return (
    <CampaignPrompt
      onDismiss={() => {
        if (!preview) {
          markCampaignPromptDismissed(browserStorage());
        }
        setOpen(false);
      }}
      onOpenSite={() => {
        if (!preview) {
          markCampaignPromptActioned(browserStorage());
        }
        setOpen(false);
        void openExternalUrl(getCampaignActivityUrl(language));
      }}
    />
  );
}
