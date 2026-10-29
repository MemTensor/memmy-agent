/** Verification-code authentication module. */
import type { AccountChannel, AccountLoginResultView } from "@memmy/local-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnalytics } from "../analytics/use-analytics.js";
import { ApiRequestError } from "../api/http.js";
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

export interface UseVerificationCodeAuthResult {
  sending: boolean;
  countdown: number;
  loginPending: boolean;
  feedback: AuthCodeFeedback | null;
  sendCodeDisabled: boolean;
  sendCodeLabel: string;
  sendCode: (channel: AccountChannel, identifier: string) => Promise<void>;
  login: (
    channel: AccountChannel,
    identifier: string,
    verificationCode: string,
    invitationCode?: string
  ) => Promise<AccountLoginResultView | null>;
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

export function resolveAuthErrorMessage(
  error: unknown,
  channel: AccountChannel,
  t: AuthTranslate,
  fallbackKey: MessageKey
): string {
  let rawMessage = "";

  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (error !== null && error !== undefined) {
    rawMessage = String(error);
  }

  const normalized = rawMessage.trim().toLowerCase();

  if (error instanceof ApiRequestError && (error.code === "rate_limited" || error.status === 429)) {
    return t("login.error.rateLimited");
  }

  if (error instanceof ApiRequestError && [408, 504].includes(error.status)) {
    return t("login.error.requestTimeout");
  }

  if (
    channel === "email" &&
    error instanceof ApiRequestError &&
    error.code !== null &&
    error.code !== "internal" &&
    normalized
  ) {
    return rawMessage.trim();
  }

  if (invalidCodeBackendMarkers.some((marker) => normalized.includes(marker))) {
    return t("login.error.invalidCode");
  }

  return t(fallbackKey);
}

export function useVerificationCodeAuth(): UseVerificationCodeAuthResult {
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
  const sendAttemptRef = useRef<number | null>(null);
  const resendAllowedAtRef = useRef(0);
  const loginAttemptRef = useRef<number | null>(null);
  const cooldownFeedbackRef = useRef<AuthCodeFeedback | null>(null);

  const updateCountdown = useCallback(() => {
    const remaining = Math.max(0, Math.ceil((resendAllowedAtRef.current - Date.now()) / 1000));
    setCountdown(remaining);
    if (remaining === 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const expiredFeedback = cooldownFeedbackRef.current;
      cooldownFeedbackRef.current = null;
      if (expiredFeedback) setFeedback(current => current === expiredFeedback ? null : current);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("focus", updateCountdown);
    document.addEventListener("visibilitychange", updateCountdown);
    return () => {
      window.removeEventListener("focus", updateCountdown);
      document.removeEventListener("visibilitychange", updateCountdown);
      interactionVersionRef.current += 1;
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [updateCountdown]);

  function startCountdown(seconds: number) {
    resendAllowedAtRef.current = Date.now() + seconds * 1000;
    setCountdown(seconds);

    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    timerRef.current = setInterval(updateCountdown, 1000);
  }

  function isCurrentInteraction(version: number): boolean {
    return interactionVersionRef.current === version;
  }

  const clearFeedback = useCallback(() => {
    cooldownFeedbackRef.current = null;
    setFeedback(null);
  }, []);

  const resetInteractionState = useCallback(() => {
    interactionVersionRef.current += 1;
    setSending(false);
    setCountdown(0);
    setLoginPending(false);
    sendAttemptRef.current = null;
    resendAllowedAtRef.current = 0;
    loginAttemptRef.current = null;
    cooldownFeedbackRef.current = null;
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

    if (!clients || sendAttemptRef.current !== null || sending || Date.now() < resendAllowedAtRef.current) {
      return;
    }

    updateCountdown();
    setSending(true);
    setFeedback(null);
    const interactionVersion = interactionVersionRef.current;
    sendAttemptRef.current = interactionVersion;
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
      const rateLimited = error instanceof ApiRequestError && (error.code === "rate_limited" || error.status === 429);
      const timedOut = (error instanceof ApiRequestError && [408, 504].includes(error.status))
        || (error instanceof Error && error.name === "TimeoutError");
      const interrupted = error instanceof Error && error.name === "AbortError";
      const connectionFailed = error instanceof TypeError;
      const serverFailed = error instanceof ApiRequestError && error.status >= 500;
      const requestFailed = timedOut || interrupted || connectionFailed || serverFailed;
      // Failed requests still need a retry buffer to avoid duplicate sends and throttling.
      if (rateLimited || requestFailed) {
        startCountdown(error instanceof ApiRequestError ? error.retryAfterSec ?? fallbackResendSeconds : fallbackResendSeconds);
      }
      const requestFailureKey: MessageKey = timedOut ? "login.codeRequestTimeout"
        : interrupted ? "login.codeRequestInterrupted"
          : connectionFailed ? "login.codeConnectionFailed"
            : "login.codeRequestFailed";
      const failureFeedback: AuthCodeFeedback = {
        text: requestFailed && !rateLimited
          ? t(requestFailureKey)
          : resolveAuthErrorMessage(error, channel, t, "login.sendCodeFailed"),
        tone: "error"
      };
      cooldownFeedbackRef.current = rateLimited || requestFailed ? failureFeedback : null;
      setFeedback(failureFeedback);
      updateCountdown();
    } finally {
      if (isCurrentInteraction(interactionVersion)) {
        sendAttemptRef.current = null;
        setSending(false);
      }
    }
  }

  async function login(
    channel: AccountChannel,
    rawIdentifier: string,
    rawCode: string,
    rawInvitationCode?: string
  ): Promise<AccountLoginResultView | null> {
    const validation = validateAuthIdentifier(channel, rawIdentifier);
    const verificationCode = rawCode.trim();
    const invitationCode = rawInvitationCode?.trim();

    if (!validation.ok) {
      setFeedback({ text: resolveIdentifierValidationMessage(channel, validation.reason, t), tone: "error" });
      return null;
    }

    if (!verificationCode) {
      setFeedback({ text: t("login.codePlaceholder"), tone: "error" });
      return null;
    }

    if (!clients) {
      setFeedback({ text: t("login.error.serviceUnavailable"), tone: "error" });
      return null;
    }

    if (loginAttemptRef.current !== null) {
      return null;
    }

    const interactionVersion = interactionVersionRef.current;
    loginAttemptRef.current = interactionVersion;
    setLoginPending(true);
    setFeedback(null);

    try {
      const result = await clients.account.verifyCode(
        channel === "email"
          ? {
              channel: "email",
              email: validation.identifier,
              verificationCode,
              loginSource: "Memmy",
              ...(invitationCode ? { invitationCode } : {})
            }
          : {
              channel: "phone",
              phoneNumber: validation.identifier,
              verificationCode,
              loginSource: "Memmy",
              ...(invitationCode ? { invitationCode } : {})
            }
      );

      if (!isCurrentInteraction(interactionVersion)) {
        return null;
      }

      if (!result.session.authenticated) {
        setFeedback({ text: t("login.loginFailed"), tone: "error" });
        return null;
      }

      return result;
    } catch (error) {
      if (!isCurrentInteraction(interactionVersion)) {
        return null;
      }
      setFeedback({ text: resolveAuthErrorMessage(error, channel, t, "login.loginFailed"), tone: "error" });
      return null;
    } finally {
      if (isCurrentInteraction(interactionVersion)) {
        loginAttemptRef.current = null;
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
