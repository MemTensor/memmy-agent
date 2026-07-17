/** Welcome page module. */
import type { OnboardingStateDto } from "@memmy/local-api-contracts";
import { Gift, Key } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveDesktopAccountChannel } from "../app/account-channel.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildAccountOnboardingStartPatch, resolveByokEntry, resolvePostLoginRoute } from "../app/routes.js";
import { AuthCodeForm } from "../components/auth-code-form.js";
import { LanguageToggleButton } from "../components/language-toggle-button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { usePhoneAuth } from "../components/use-phone-auth.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { openExternalUrl } from "../utils/open-url.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";

/** Handles welcome page. */
export function WelcomePage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { track } = useAnalytics();
  const { t, language } = useTranslation();
  const phoneAuth = usePhoneAuth();
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [modePersistencePending, setModePersistencePending] = useState(false);
  const [modePersistenceFeedback, setModePersistenceFeedback] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const channel = resolveDesktopAccountChannel();
  const canContinue = Boolean(identifier.trim() && code.trim());
  const showLoginBanner = state.bootstrap?.promotions?.loginBanner ?? true;

  // Handles use effect.
  useEffect(() => {
    setIdentifier("");
    setCode("");
    setModePersistenceFeedback(null);
    phoneAuth.resetInteractionState();
  }, [channel, phoneAuth.resetInteractionState]);

  /** Handles toggle language. */
  function toggleLanguage() {
    const nextLanguage = language === "en-US" ? "zh-CN" : "en-US";
    phoneAuth.clearFeedback();
    setModePersistenceFeedback(null);
    dispatch(appActions.settingsUpdated({ language: nextLanguage }));
    void clients?.config.updateSettings({ language: nextLanguage }).catch(() => undefined);
  }

  /** Handles submit login. */
  async function submitLogin() {
    if (!canContinue || phoneAuth.loginPending || modePersistencePending) {
      return;
    }
    setModePersistenceFeedback(null);

    const session = await phoneAuth.login(channel, identifier, code);
    if (!session || !session.authenticated) {
      return;
    }

    track({ name: "signup_completed", params: { method: channel === "phone" ? "phone" : "email", is_new_user: session.isNewUser }, consentTier: "basic" });

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

    track({ name: "byok_started", consentTier: "basic" });
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
                <span className="text-sm text-text-ink/70">{t("welcome.gift")}</span>
              </button>
            )}

            <div className={`welcome-login-card__body px-6${showLoginBanner ? " welcome-login-card__body--with-banner" : " welcome-login-card__body--no-banner"}`}>
              <AuthCodeForm
                identifier={identifier}
                identifierType={channel}
                code={code}
                disabled={!canContinue || phoneAuth.loginPending || modePersistencePending}
                sendCodeDisabled={phoneAuth.sendCodeDisabled}
                sendCodeLabel={phoneAuth.sendCodeLabel}
                feedback={modePersistenceFeedback ?? phoneAuth.feedback}
                onIdentifierChange={setIdentifier}
                onCodeChange={setCode}
                onSendCode={() => void phoneAuth.sendCode(channel, identifier)}
                onSubmit={() => void submitLogin()}
                onOpenTerms={() => void openExternalUrl(getLegalLinkUrl("terms", language, state.bootstrap?.legal))}
                onOpenDataAgreement={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}
              />
            </div>
          </div>

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
