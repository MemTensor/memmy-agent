/** Token detail page module. */
import type { OnboardingStateDto } from "@memmy/local-api-contracts";
import { Check, ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveDesktopAccountChannel } from "../app/account-channel.js";
import { buildInvitationSignupEvent } from "../app/invitation-analytics.js";
import { resolveInvitationToastKind } from "../app/invitation-result.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildAccountOnboardingStartPatch, resolvePostLoginRoute, shouldShowFirstEncounterReport } from "../app/routes.js";
import { setAnalyticsUserId } from "../analytics/analytics-context.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { AuthCodeForm } from "../components/auth-code-form.js";
import { LanguageToggleButton, PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { useVerificationCodeAuth } from "../components/use-verification-code-auth.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { openExternalUrl } from "../utils/open-url.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { formatTokenGiftAmount } from "./token-gift.js";

export function TokenDetailPage() {
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
  const [pendingAccountOnboarding, setPendingAccountOnboarding] = useState<Partial<OnboardingStateDto> | null>(null);
  const channel = resolveDesktopAccountChannel();
  const invitationEnabled = state.bootstrap?.promotions?.invitation?.enabled === true;
  const canContinue = Boolean(identifier.trim() && code.trim());
  const agentChatTokenTotal = state.bootstrap?.promotions?.agentChatTokenTotal;

  useEffect(() => {
    setIdentifier("");
    setCode("");
    setInviteCode("");
    setModePersistenceFeedback(null);
    setPendingAccountOnboarding(null);
    verificationCodeAuth.resetInteractionState();
  }, [channel, verificationCodeAuth.resetInteractionState]);

  function toggleLanguage() {
    const nextLanguage = language === "en-US" ? "zh-CN" : "en-US";
    verificationCodeAuth.clearFeedback();
    setModePersistenceFeedback(null);
    dispatch(appActions.settingsUpdated({ language: nextLanguage }));
    void clients?.config.updateSettings({ language: nextLanguage }).catch(() => undefined);
  }

  async function submitLogin() {
    if (verificationCodeAuth.loginPending || modePersistencePending) {
      return;
    }
    setModePersistenceFeedback(null);
    if (pendingAccountOnboarding) {
      await continueAfterRegistration(pendingAccountOnboarding);
      return;
    }
    if (!canContinue) return;

    const loginResult = await verificationCodeAuth.login(
      channel,
      identifier,
      code,
      invitationEnabled ? inviteCode : undefined
    );
    if (!loginResult || !loginResult.session.authenticated) {
      return;
    }
    const session = loginResult.session;
    // Set before the signup event so it is attributed to the cloud account.
    setAnalyticsUserId(session.profile.userId);
    const invitationToastKind = resolveInvitationToastKind(loginResult.invitationResult);
    if (invitationToastKind) {
      dispatch(appActions.showInvitationToast(invitationToastKind));
    }

    track(buildInvitationSignupEvent({
      channel,
      isNewUser: session.isNewUser,
      invitationCode: invitationEnabled ? inviteCode : undefined
    }));

    dispatch(appActions.accountUpdated({
      userId: session.profile.userId,
      email: session.profile.email ?? "",
      phoneNumber: session.profile.phoneNumber,
      nickname: session.profile.nickname,
      registeredAt: session.profile.registeredAt
    }));

    const onboardingPatch: Partial<OnboardingStateDto> =
      session.profile.hasFinishedGuide && state.bootstrap && !shouldShowFirstEncounterReport(state.bootstrap.onboarding)
      ? {
        completed: true,
        currentStep: "completed",
        completedAt: new Date().toISOString(),
        hasAcceptedTerms: true
      }
      : buildAccountOnboardingStartPatch(state.bootstrap?.onboarding);
    setPendingAccountOnboarding(onboardingPatch);
    await continueAfterRegistration(onboardingPatch);
  }

  async function continueAfterRegistration(forcedOnboarding?: Partial<OnboardingStateDto>) {
    const onboarding = state.bootstrap?.onboarding;
    const onboardingPatch = forcedOnboarding ?? buildAccountOnboardingStartPatch(onboarding);
    const nextOnboarding = {
      ...buildAccountOnboardingStartPatch(onboarding),
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
      setPendingAccountOnboarding(null);
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
            <div className="text-3xl font-extrabold tracking-tight">
              {formatTokenGiftAmount(agentChatTokenTotal)}
            </div>
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
                inviteCode={inviteCode}
                disabled={(!canContinue && !pendingAccountOnboarding) || verificationCodeAuth.loginPending || modePersistencePending}
                sendCodeDisabled={verificationCodeAuth.sendCodeDisabled}
                sendCodeLabel={verificationCodeAuth.sendCodeLabel}
                feedback={modePersistenceFeedback ?? verificationCodeAuth.feedback}
                onIdentifierChange={setIdentifier}
                onCodeChange={setCode}
                onInviteCodeChange={invitationEnabled ? setInviteCode : undefined}
                onSendCode={() => void verificationCodeAuth.sendCode(channel, identifier)}
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
