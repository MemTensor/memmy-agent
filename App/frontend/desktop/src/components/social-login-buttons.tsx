/** Google and GitHub sign-in actions shown only by international desktop packages. */
import type { SocialLoginProvider } from "@memmy/local-api-contracts";
import type { ReactNode } from "react";
import { useTranslation } from "../i18n/use-translation.js";

// Keep the integration code available, but do not render social login until the
// production providers are ready to be exposed again.
const SOCIAL_LOGIN_BUTTONS_ENABLED = false;

export interface SocialLoginButtonsProps {
  pendingProvider: SocialLoginProvider | null;
  disabled?: boolean;
  feedback?: { text: string; tone: "error" | "success" } | null;
  onLogin: (provider: SocialLoginProvider) => void;
}

export function SocialLoginButtons(props: SocialLoginButtonsProps) {
  const { t } = useTranslation();
  if (!SOCIAL_LOGIN_BUTTONS_ENABLED) return null;

  return (
    <div className="mt-4 space-y-2.5">
      <div className="flex flex-col gap-3">
        <SocialLoginButton
          label={props.pendingProvider === "google" ? t("login.social.opening") : t("login.social.google")}
          icon={<GoogleMark />}
          disabled={props.disabled || Boolean(props.pendingProvider)}
          onClick={() => props.onLogin("google")}
        />
        <SocialLoginButton
          label={props.pendingProvider === "github" ? t("login.social.opening") : t("login.social.github")}
          icon={<GitHubMark />}
          disabled={props.disabled || Boolean(props.pendingProvider)}
          onClick={() => props.onLogin("github")}
        />
      </div>
      {props.feedback ? (
        <p
          role={props.feedback.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          className={`text-center text-[11px] leading-5 ${props.feedback.tone === "error" ? "text-status-error" : "text-text-ink/55"}`}
        >
          {props.feedback.text}
        </p>
      ) : null}
    </div>
  );
}

function SocialLoginButton(props: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex min-w-0 items-center justify-center gap-2 rounded-btn border border-border-stone/80 bg-white px-3 py-3 text-sm font-semibold text-text-ink shadow-sm transition-colors hover:bg-canvas-oat/60 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {props.icon}
      <span className="truncate">{props.label}</span>
    </button>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" className="shrink-0">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.9h5.38a4.6 4.6 0 0 1-2 3.02v2.53h3.24c1.9-1.75 2.98-4.33 2.98-7.39Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.64-2.42l-3.24-2.53c-.9.6-2.05.96-3.4.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.61A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.39 13.88A6.01 6.01 0 0 1 6.08 12c0-.65.11-1.28.31-1.88V7.51H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.49l3.35-2.61Z" />
      <path fill="#EA4335" d="M12 5.99c1.47 0 2.79.5 3.83 1.5l2.88-2.88A9.67 9.67 0 0 0 12 2a10 10 0 0 0-8.96 5.51l3.35 2.61C7.18 7.75 9.39 5.99 12 5.99Z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" className="shrink-0">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.96 10.96 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}
