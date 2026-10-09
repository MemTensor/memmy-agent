/** Browser-based Google and GitHub authentication for the international desktop package. */
import type { AccountLoginResultView, SocialLoginProvider } from "@memmy/local-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { openExternalUrl } from "../utils/open-url.js";
import type { AuthCodeFeedback } from "./use-verification-code-auth.js";

export interface UseSocialLoginResult {
  pendingProvider: SocialLoginProvider | null;
  feedback: AuthCodeFeedback | null;
  start: (provider: SocialLoginProvider, invitationCode?: string) => Promise<AccountLoginResultView | null>;
  clearFeedback: () => void;
  reset: () => void;
}

export function useSocialLogin(): UseSocialLoginResult {
  const { clients } = useApiClients();
  const { t, language } = useTranslation();
  const locale = useMemo<"zh" | "en">(() => (language === "zh-CN" ? "zh" : "en"), [language]);
  const [pendingProvider, setPendingProvider] = useState<SocialLoginProvider | null>(null);
  const [feedback, setFeedback] = useState<AuthCodeFeedback | null>(null);
  const interactionVersionRef = useRef(0);

  const reset = useCallback(() => {
    interactionVersionRef.current += 1;
    setPendingProvider(null);
    setFeedback(null);
  }, []);

  useEffect(() => reset, [reset]);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  async function start(
    provider: SocialLoginProvider,
    rawInvitationCode?: string
  ): Promise<AccountLoginResultView | null> {
    if (!clients || pendingProvider) return null;
    const invitationCode = rawInvitationCode?.trim();
    const interactionVersion = interactionVersionRef.current + 1;
    interactionVersionRef.current = interactionVersion;
    setPendingProvider(provider);
    setFeedback(null);

    try {
      const flow = await clients.account.startSocialLogin({
        provider,
        locale,
        loginSource: "Memmy",
        ...(invitationCode ? { invitationCode } : {})
      });
      if (!isCurrent(interactionVersion)) return null;
      await openExternalUrl(flow.authorizationUrl);
      setFeedback({ text: t("login.social.waiting"), tone: "success" });
      const expiresAt = Date.now() + flow.expiresInSec * 1000;

      while (isCurrent(interactionVersion) && Date.now() < expiresAt) {
        await delay(flow.pollIntervalSec * 1000);
        if (!isCurrent(interactionVersion)) return null;
        const status = await clients.account.getSocialLoginStatus({
          flowId: flow.flowId,
          pollToken: flow.pollToken
        });
        if (status.status === "pending") continue;
        if (status.status === "completed") {
          setFeedback(null);
          return status.result;
        }
        if (status.status === "expired") {
          setFeedback({ text: t("login.social.expired"), tone: "error" });
          return null;
        }
        setFeedback({ text: status.message, tone: "error" });
        return null;
      }

      if (isCurrent(interactionVersion)) {
        setFeedback({ text: t("login.social.expired"), tone: "error" });
      }
      return null;
    } catch (error) {
      if (isCurrent(interactionVersion)) {
        setFeedback({ text: readableError(error, t("login.social.failed")), tone: "error" });
      }
      return null;
    } finally {
      if (isCurrent(interactionVersion)) setPendingProvider(null);
    }
  }

  function isCurrent(version: number): boolean {
    return interactionVersionRef.current === version;
  }

  return { pendingProvider, feedback, start, clearFeedback, reset };
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
