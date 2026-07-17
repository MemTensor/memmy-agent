/** Token detail page module. */
import type { OnboardingStateDto } from "@memmy/local-api-contracts";
import { Check, ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveDesktopAccountChannel } from "../app/account-channel.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildAccountOnboardingStartPatch, resolvePostLoginRoute } from "../app/routes.js";
import { AuthCodeForm } from "../components/auth-code-form.js";
import { LanguageToggleButton, PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { usePhoneAuth } from "../components/use-phone-auth.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { openExternalUrl } from "../utils/open-url.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";

export function TokenDetailPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t, language } = useTranslation();
  const phoneAuth = usePhoneAuth();
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [modePersistencePending, setModePersistencePending] = useState(false);
  const [modePersistenceFeedback, setModePersistenceFeedback] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const channel = resolveDesktopAccountChannel();
  const canContinue = Boolean(identifier.trim() && code.trim());

  useEffect(() => {
    setIdentifier("");
    setCode("");
    setModePersistenceFeedback(null);
    phoneAuth.resetInteractionState();
  }, [channel, phoneAuth.resetInteractionState]);

  function toggleLanguage() {
    const nextLanguage = language === "en-US" ? "zh-CN" : "en-US";
    phoneAuth.clearFeedback();
    setModePersistenceFeedback(null);
    dispatch(appActions.settingsUpdated({ language: nextLanguage }));
    void clients?.config.updateSettings({ language: nextLanguage }).catch(() => undefined);
  }

  async function submitLogin() {
    if (!canContinue || phoneAuth.loginPending || modePersistencePending) {
      return;
    }
    setModePersistenceFeedback(null);

    const session = await phoneAuth.login(channel, identifier, code);
    if (!session || !session.authenticated) {
      return;
    }

    dispatch(appActions.accountUpdated({
      email: session.profile.email ?? "",
      phoneNumber: session.profile.phoneNumber,
      nickname: session.profile.nickname,
      registeredAt: session.profile.registeredAt
    }));

    if (session.profile.hasFinishedGuide) {
      await continueAfterRegistration({
        completed: true,
        currentStep: "completed",
        completedAt: new Date().toISOString(),
        hasAcceptedTerms: true
      });
      return;
    }

    await continueAfterRegistration();
  }

  async function continueAfterRegistration(forcedOnboarding?: Partial<OnboardingStateDto>) {
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

  return (
    <main className="h-screen flex flex-col bg-canvas-oat relative overflow-hidden">
      <div className="absolute top-[-60px] left-[-40px] w-48 h-48 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-80px] right-[-60px] w-64 h-64 bg-action-sky/10 rounded-full blur-3xl" />

      <div
        className="flex items-center gap-[calc(0.5rem*2/3)]"
        style={PAGE_CORNER_ACTION_CONTAINER_STYLE}
      >
        <PageCornerActionButton
          label={t("welcome.gift.detail.backShort")}
          ariaLabel={t("welcome.gift.detail.back")}
          onClick={() => dispatch(appActions.navigate("/welcome"))}
          className="-mr-1"
          icon={<ChevronLeft aria-hidden="true" size={16} strokeWidth={2.2} className="shrink-0 -mr-0.5" />}
        />
        <LanguageToggleButton language={language} onClick={toggleLanguage} embedded />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4 relative z-10 min-h-0 overflow-y-auto py-6">
        <section className="w-full max-w-md">
          <div className="bg-gradient-to-br from-action-sky to-action-sky-hover rounded-card-lg p-7 text-white text-center mb-6 relative overflow-hidden">
            <div className="absolute top-3 right-4 w-16 h-16 bg-white/10 rounded-full" />
            <div className="absolute bottom-2 left-4 w-12 h-12 bg-white/5 rounded-full" />
            <div className="text-3xl font-extrabold tracking-tight">30,000,000</div>
            <div className="text-sm text-white/70 mt-1">{t("welcome.gift.detail.subtitle")}</div>
            <div
              className={`mt-5 space-y-2 text-left mx-auto ${language === "en-US" ? "w-full" : "max-w-xs"}`}
            >
              <TokenGiftBenefit text={t("welcome.gift.detail.bullet.conversations")} />
              <TokenGiftBenefit text={t("welcome.gift.detail.bullet.memories")} />
              <TokenGiftBenefit text={t("welcome.gift.detail.bullet.features")} />
            </div>
          </div>

          <div className="welcome-login-card shadow-lg overflow-hidden">
            <div className="welcome-login-card__body welcome-login-card__body--no-banner px-6">
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
        </section>
      </div>
    </main>
  );
}

/**
 * Renders a Token benefit row.
 *
 * @param props.text The benefit description text.
 * @returns A benefit row node with a check icon.
 */
function TokenGiftBenefit(props: { text: string }) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Check size={15} className="mt-0.5 shrink-0 text-white/60" />
      <span>{props.text}</span>
    </div>
  );
}
