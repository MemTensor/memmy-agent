/** Welcome page module. */
import type { OnboardingStateDto } from "@memmy/local-api-contracts";
import { Gift, Key } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveDesktopAccountChannel } from "../app/account-channel.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildAccountOnboardingStartPatch, resolveByokEntry, resolvePostLoginRoute } from "../app/routes.js";
import { AuthCodeForm } from "../components/auth-code-form.js";
import { InviteResultToast, type InviteResultTone } from "../components/invite-result-toast.js";
import { LanguageToggleButton } from "../components/language-toggle-button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { useVerificationCodeAuth } from "../components/use-verification-code-auth.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { openExternalUrl } from "../utils/open-url.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { formatTokenGiftAmount } from "./token-gift.js";

/** Temporary review controls for registration-side invite toasts. */
const PREVIEW_INVITE_REGISTER_TOASTS = false;

/** Handles welcome page. */
export function WelcomePage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { track } = useAnalytics();
  const { t, language } = useTranslation();
  const verificationCodeAuth = useVerificationCodeAuth();
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [modePersistencePending, setModePersistencePending] = useState(false);
  const [modePersistenceFeedback, setModePersistenceFeedback] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const [inviteResultToast, setInviteResultToast] = useState<{ text: string; tone: InviteResultTone } | null>(null);
  const channel = resolveDesktopAccountChannel();
  const canContinue = Boolean(identifier.trim() && code.trim());
  const agentChatTokenTotal = state.bootstrap?.promotions?.agentChatTokenTotal;
  const showLoginBanner =
    (state.bootstrap?.promotions?.loginBanner ?? true) && (agentChatTokenTotal ?? 0) > 0;

  // Handles use effect.
  useEffect(() => {
    setIdentifier("");
    setCode("");
    setInviteCode("");
    setModePersistenceFeedback(null);
    verificationCodeAuth.resetInteractionState();
  }, [channel, verificationCodeAuth.resetInteractionState]);

  /** Handles toggle language. */
  function toggleLanguage() {
    const nextLanguage = language === "en-US" ? "zh-CN" : "en-US";
    verificationCodeAuth.clearFeedback();
    setModePersistenceFeedback(null);
    dispatch(appActions.settingsUpdated({ language: nextLanguage }));
    void clients?.config.updateSettings({ language: nextLanguage }).catch(() => undefined);
  }

  /** Handles submit login. */
  async function submitLogin() {
    if (!canContinue || verificationCodeAuth.loginPending || modePersistencePending) {
      return;
    }
    setModePersistenceFeedback(null);

    const session = await verificationCodeAuth.login(channel, identifier, code);
    if (!session || !session.authenticated) {
      return;
    }

    track({ name: "signup_completed", params: { method: channel === "phone" ? "phone" : "email", is_new_user: session.isNewUser, user_mode: "account" }, consentTier: "basic" });

    dispatch(appActions.accountUpdated({
      email: session.profile.email ?? "",
      phoneNumber: session.profile.phoneNumber,
      nickname: session.profile.nickname,
      registeredAt: session.profile.registeredAt
    }));

    if (session.profile.hasFinishedGuide) {
      await continueAfterAccountEntry({
        completed: true,
        currentStep: "completed",
        completedAt: new Date().toISOString(),
        hasAcceptedTerms: true
      });
      return;
    }

    // Welcome page module.
    // Welcome page module.
    await continueAfterAccountEntry();
  }

  /** Handles continue after account entry. */
  async function continueAfterAccountEntry(forcedOnboarding?: Partial<OnboardingStateDto>) {
    const onboarding = state.bootstrap?.onboarding;
    const onboardingPatch = forcedOnboarding ?? buildAccountOnboardingStartPatch();
    const nextOnboarding = {
      ...buildAccountOnboardingStartPatch(),
      ...onboarding,
      ...onboardingPatch
    };
    const nextRoute = resolvePostLoginRoute({ onboarding: nextOnboarding, preferredMode: state.navigation.preferredMode });

    try {
      setModePersistencePending(true);
      await persistLoginModeSelection({
        configClient: clients?.config,
        dispatch,
        userMode: "account",
        onboarding: onboardingPatch
      });
      dispatch(appActions.navigate(nextRoute));
    } catch (error) {
      console.error("persist account mode failed", error);
      setModePersistenceFeedback({ text: t("login.error.modePersistenceFailed"), tone: "error" });
    } finally {
      setModePersistencePending(false);
    }
  }

  /** Handles use own api key. */
  async function useOwnApiKey() {
    if (modePersistencePending) {
      return;
    }

    // Definition for byok entry.
    const byokEntry = resolveByokEntry({ onboarding: state.bootstrap?.onboarding });

    track({ name: "byok_started", params: { user_mode: "byok" }, consentTier: "basic" });
    setModePersistenceFeedback(null);

    try {
      setModePersistencePending(true);
      await persistLoginModeSelection({
        configClient: clients?.config,
        dispatch,
        userMode: "byok",
        onboarding: byokEntry.onboardingPatch
      });
      dispatch(appActions.navigate(byokEntry.nextRoute));
    } catch (error) {
      console.error("persist byok entry failed", error);
      setModePersistenceFeedback({ text: t("login.error.modePersistenceFailed"), tone: "error" });
    } finally {
      setModePersistencePending(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-canvas-oat relative overflow-hidden">
      <div className="absolute top-[-80px] right-[-60px] w-64 h-64 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-60px] left-[-40px] w-56 h-56 bg-action-sky/10 rounded-full blur-3xl" />
      <div className="absolute top-[40%] left-[10%] w-40 h-40 bg-action-sky/15 rounded-full blur-3xl" />

      <LanguageToggleButton language={language} onClick={toggleLanguage} />

      <div className="flex-1 flex flex-col items-center justify-center px-4 relative z-10 min-h-0">
        <div className="w-full max-w-md flex flex-col items-center">
          <div className="text-center mb-6">
            <div className="welcome-brand-mascot flex justify-center">
              <Memmy pose="wave" size={176} className="memmy-wave" />
            </div>
            <span className="text-3xl font-extrabold tracking-tight text-text-ink">{t("brand.name")}</span>
            <p className="welcome-brand-subtitle text-base text-text-ink/50">{t("brand.subtitle")}</p>
          </div>

          <div className="w-full">
            <div className="welcome-login-card shadow-lg overflow-hidden">
            {/* Welcome page module. */}
            {showLoginBanner && (
              <button
                type="button"
                onClick={() => dispatch(appActions.navigate("/token-detail"))}
                aria-label={t("welcome.gift.expand")}
                className="welcome-login-card__banner w-full flex items-center gap-2.5 text-left cursor-pointer"
              >
                <span className="w-6 h-6 rounded-full bg-action-sky/15 flex items-center justify-center text-action-sky shrink-0">
                  <Gift size={14} strokeWidth={2.2} />
                </span>
                <span className="text-sm text-text-ink/70">
                  {t("welcome.gift", { count: formatTokenGiftAmount(agentChatTokenTotal) })}
                </span>
              </button>
            )}

            <div className={`welcome-login-card__body px-6${showLoginBanner ? " welcome-login-card__body--with-banner" : " welcome-login-card__body--no-banner"}`}>
              <AuthCodeForm
                identifier={identifier}
                identifierType={channel}
                code={code}
                inviteCode={inviteCode}
                disabled={!canContinue || verificationCodeAuth.loginPending || modePersistencePending}
                sendCodeDisabled={verificationCodeAuth.sendCodeDisabled}
                sendCodeLabel={verificationCodeAuth.sendCodeLabel}
                feedback={modePersistenceFeedback ?? verificationCodeAuth.feedback}
                onIdentifierChange={setIdentifier}
                onCodeChange={setCode}
                onInviteCodeChange={setInviteCode}
                onSendCode={() => void verificationCodeAuth.sendCode(channel, identifier)}
                onSubmit={() => void submitLogin()}
                onOpenTerms={() => void openExternalUrl(getLegalLinkUrl("terms", language, state.bootstrap?.legal))}
                onOpenDataAgreement={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}
              />
              {PREVIEW_INVITE_REGISTER_TOASTS ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="px-2.5 py-1 text-[11px] text-text-ink/55 border border-border-stone/40 rounded-btn hover:bg-canvas-oat/60 cursor-pointer"
                    onClick={() => setInviteResultToast({ text: t("login.invite.successToast"), tone: "success" })}
                  >
                    {t("login.invite.previewSuccess")}
                  </button>
                  <button
                    type="button"
                    className="px-2.5 py-1 text-[11px] text-text-ink/55 border border-border-stone/40 rounded-btn hover:bg-canvas-oat/60 cursor-pointer"
                    onClick={() => setInviteResultToast({ text: t("login.invite.invalidToast"), tone: "missed" })}
                  >
                    {t("login.invite.previewInvalid")}
                  </button>
                  <button
                    type="button"
                    className="px-2.5 py-1 text-[11px] text-text-ink/55 border border-border-stone/40 rounded-btn hover:bg-canvas-oat/60 cursor-pointer"
                    onClick={() => setInviteResultToast({ text: t("login.invite.existingUserToast"), tone: "missed" })}
                  >
                    {t("login.invite.previewExistingUser")}
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {inviteResultToast ? (
            <InviteResultToast
              text={inviteResultToast.text}
              tone={inviteResultToast.tone}
              onDismiss={() => setInviteResultToast(null)}
            />
          ) : null}

          <div className="flex items-center gap-3 mt-4 mb-4">
            <div className="flex-1 h-px bg-border-stone/60" />
            <span className="text-xs text-text-ink/45">{t("welcome.or")}</span>
            <div className="flex-1 h-px bg-border-stone/60" />
          </div>

          <button
            type="button"
            disabled={modePersistencePending}
            onClick={() => void useOwnApiKey()}
            className="welcome-byok-action w-full flex items-center justify-center gap-2.5 py-3 text-sm text-text-ink/75 hover:text-action-sky transition-all cursor-pointer shadow-sm disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Key size={15} />
            {t("welcome.byok.quickAction")}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
