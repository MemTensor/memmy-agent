/** Login page module. */
import type { OnboardingStateDto } from "@memmy/local-api-contracts";
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
import { LanguageToggleButton } from "../components/language-toggle-button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { useVerificationCodeAuth } from "../components/use-verification-code-auth.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { openExternalUrl } from "../utils/open-url.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";

/** Handles login page. */
export function LoginPage() {
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
    <main className="min-h-screen bg-canvas-oat px-4 py-8 flex items-center justify-center relative overflow-hidden">
      <div className="absolute top-[-80px] right-[-60px] w-64 h-64 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-60px] left-[-40px] w-56 h-56 bg-action-sky/10 rounded-full blur-3xl" />

      <LanguageToggleButton language={language} onClick={toggleLanguage} />

      <section className="w-full max-w-md bg-background-paper rounded-card-lg shadow-lg border border-border-stone/60 overflow-hidden relative z-10">
        <div className="px-6 pt-6 pb-3 text-center">
          <div className="flex justify-center mb-1">
            <Memmy pose="wave" size={118} className="memmy-wave" />
          </div>
          <p className="text-sm font-semibold text-text-ink/60">{t("nav.login")}</p>
          <h1 className="text-2xl font-extrabold text-text-ink mt-1">{t("login.title")}</h1>
        </div>
        <div className="px-6 pb-6 space-y-3.5">
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
      </section>
    </main>
  );
}
