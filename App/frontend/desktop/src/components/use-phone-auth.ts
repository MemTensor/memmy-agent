/** Use phone auth module. */
import type { AccountChannel, AccountSessionView } from "@memmy/local-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnalytics } from "../analytics/use-analytics.js";
import { useApiClients } from "../app/providers.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";

const fallbackResendSeconds = 60;
const emailIdentifierPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneIdentifierPattern = /^1[3-9]\d{9}$/;
const invalidCodeBackendMarkers = [
  "\u9A8C\u8BC1\u7801\u9519\u8BEF",
  "verification code error",
  "invalid verification code",
  "incorrect verification code"
] as const;

type AuthTranslate = (key: MessageKey, values?: MessageValues) => string;

export type AuthIdentifierValidationReason = "required" | "invalidEmail" | "invalidPhone";

export type AuthIdentifierValidationResult =
  | {
      ok: true;
      identifier: string;
    }
  | {
      ok: false;
      reason: AuthIdentifierValidationReason;
    };

export interface AuthCodeFeedback {
  text: string;
  tone: "error" | "success";
}

export interface UsePhoneAuthResult {
  sending: boolean;
  countdown: number;
  loginPending: boolean;
  feedback: AuthCodeFeedback | null;
  sendCodeDisabled: boolean;
  sendCodeLabel: string;
  sendCode: (channel: AccountChannel, identifier: string) => Promise<void>;
  login: (channel: AccountChannel, identifier: string, verificationCode: string) => Promise<AccountSessionView | null>;
  clearFeedback: () => void;
  resetInteractionState: () => void;
}

export function validateAuthIdentifier(channel: AccountChannel, rawIdentifier: string): AuthIdentifierValidationResult {
  const identifier = rawIdentifier.trim();

  if (!identifier) {
    return { ok: false, reason: "required" };
  }

  if (channel === "email") {
    return emailIdentifierPattern.test(identifier)
      ? { ok: true, identifier }
      : { ok: false, reason: "invalidEmail" };
  }

  return phoneIdentifierPattern.test(identifier)
    ? { ok: true, identifier }
    : { ok: false, reason: "invalidPhone" };
}

function resolveIdentifierValidationMessage(channel: AccountChannel, reason: AuthIdentifierValidationReason, t: AuthTranslate): string {
  if (reason === "required") {
    return t(channel === "email" ? "login.emailRequired" : "login.phoneRequired");
  }

  return t(reason === "invalidEmail" ? "login.error.invalidEmail" : "login.error.invalidPhone");
}

function resolveAuthErrorMessage(error: unknown, t: AuthTranslate, fallbackKey: MessageKey): string {
  let rawMessage = "";

  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (error !== null && error !== undefined) {
    rawMessage = String(error);
  }

  const normalized = rawMessage.trim().toLowerCase();

  if (invalidCodeBackendMarkers.some((marker) => normalized.includes(marker))) {
    return t("login.error.invalidCode");
  }

  return t(fallbackKey);
}

export function usePhoneAuth(): UsePhoneAuthResult {
  const { t, language } = useTranslation();
  const { clients } = useApiClients();
  const { track } = useAnalytics();
  const locale = useMemo<"zh" | "en">(() => (language === "zh-CN" ? "zh" : "en"), [language]);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [loginPending, setLoginPending] = useState(false);
  const [feedback, setFeedback] = useState<AuthCodeFeedback | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interactionVersionRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  function startCountdown(seconds: number) {
    setCountdown(seconds);

    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    timerRef.current = setInterval(() => {
      setCountdown((previous) => {
        if (previous <= 1) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return 0;
        }
        return previous - 1;
      });
    }, 1000);
  }

  function isCurrentInteraction(version: number): boolean {
    return interactionVersionRef.current === version;
  }

  const clearFeedback = useCallback(() => {
    setFeedback(null);
  }, []);

  const resetInteractionState = useCallback(() => {
    interactionVersionRef.current += 1;
    setSending(false);
    setCountdown(0);
    setLoginPending(false);
    setFeedback(null);

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  async function sendCode(channel: AccountChannel, rawIdentifier: string) {
    const validation = validateAuthIdentifier(channel, rawIdentifier);

    if (!validation.ok) {
      setFeedback({ text: resolveIdentifierValidationMessage(channel, validation.reason, t), tone: "error" });
      return;
    }

    if (!clients || sending || countdown > 0) {
      return;
    }

    setSending(true);
    setFeedback(null);
    const interactionVersion = interactionVersionRef.current;
    track({ name: "send_verification_code", params: { page_path: "login_flow", channel }, consentTier: "basic" });

    try {
      const result = await clients.account.sendCode(
        channel === "email" ? { channel: "email", email: validation.identifier, locale } : { channel: "phone", phoneNumber: validation.identifier, locale }
      );
      if (!isCurrentInteraction(interactionVersion)) {
        return;
      }
      startCountdown(result.resendAfterSec > 0 ? result.resendAfterSec : fallbackResendSeconds);
    } catch (error) {
      if (!isCurrentInteraction(interactionVersion)) {
        return;
      }
      setFeedback({ text: resolveAuthErrorMessage(error, t, "login.sendCodeFailed"), tone: "error" });
    } finally {
      if (isCurrentInteraction(interactionVersion)) {
        setSending(false);
      }
    }
  }

  async function login(channel: AccountChannel, rawIdentifier: string, rawCode: string): Promise<AccountSessionView | null> {
    const validation = validateAuthIdentifier(channel, rawIdentifier);
    const verificationCode = rawCode.trim();

    if (!validation.ok) {
      setFeedback({ text: resolveIdentifierValidationMessage(channel, validation.reason, t), tone: "error" });
      return null;
    }

    if (!clients || !verificationCode || loginPending) {
      return null;
    }

    setLoginPending(true);
    setFeedback(null);
    const interactionVersion = interactionVersionRef.current;

    try {
      const session = await clients.account.verifyCode(
        channel === "email"
          ? { channel: "email", email: validation.identifier, verificationCode, loginSource: "Memmy" }
          : { channel: "phone", phoneNumber: validation.identifier, verificationCode, loginSource: "Memmy" }
      );

      if (!isCurrentInteraction(interactionVersion)) {
        return null;
      }

      if (!session.authenticated) {
        setFeedback({ text: t("login.loginFailed"), tone: "error" });
        return null;
      }

      return session;
    } catch (error) {
      if (!isCurrentInteraction(interactionVersion)) {
        return null;
      }
      setFeedback({ text: resolveAuthErrorMessage(error, t, "login.loginFailed"), tone: "error" });
      return null;
    } finally {
      if (isCurrentInteraction(interactionVersion)) {
        setLoginPending(false);
      }
    }
  }

  const sendCodeLabel = sending
    ? t("login.sendingCode")
    : countdown > 0
      ? t("login.resendIn", { seconds: countdown })
      : t("login.getCode");

  return {
    sending,
    countdown,
    loginPending,
    feedback,
    sendCodeDisabled: sending || countdown > 0,
    sendCodeLabel,
    sendCode,
    login,
    clearFeedback,
    resetInteractionState
  };
}
