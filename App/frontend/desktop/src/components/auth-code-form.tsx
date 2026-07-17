/** Auth code form module. */
import { useTranslation } from "../i18n/use-translation.js";

/** Contract for auth code form props. */
export interface AuthCodeFormProps {
  identifier: string;
  identifierType?: "email" | "phone";
  code: string;
  error?: string;
  disabled?: boolean;
  sendCodeDisabled?: boolean;
  sendCodeLabel?: string;
  feedback?: { text: string; tone: "error" | "success" } | null;
  onIdentifierChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onSendCode: () => void;
  onSubmit: () => void;
  onOpenTerms?: () => void;
  onOpenDataAgreement?: () => void;
}

/** Handles auth code form. */
export function AuthCodeForm(props: AuthCodeFormProps) {
  const { t } = useTranslation();
  const hasError = Boolean(props.error);
  const errorFeedback = props.feedback?.tone === "error" ? props.feedback : null;

  return (
    <div className="space-y-3.5">
      <input
        type={props.identifierType === "email" ? "email" : "tel"}
        inputMode={props.identifierType === "email" ? "email" : "tel"}
        autoComplete={props.identifierType === "email" ? "email" : "tel"}
        placeholder={props.identifierType === "email" ? t("login.emailPlaceholder") : t("login.phonePlaceholder")}
        value={props.identifier}
        aria-invalid={hasError}
        onChange={(event) => props.onIdentifierChange(event.target.value)}
        className="auth-code-form-input w-full px-5 py-3 border rounded-input text-sm bg-canvas-oat/30 focus:outline-none"
      />
      <div className="flex gap-4">
        <input
          type="text"
          inputMode="numeric"
          placeholder={t("login.codePlaceholder")}
          value={props.code}
          aria-invalid={hasError}
          onChange={(event) => props.onCodeChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !props.disabled) {
              props.onSubmit();
            }
          }}
          className="auth-code-form-input flex-1 px-5 py-3 border rounded-input text-sm bg-canvas-oat/30 focus:outline-none"
        />
        <button
          type="button"
          disabled={props.sendCodeDisabled}
          onClick={props.onSendCode}
          className="px-5 py-3 bg-action-sky text-white text-sm font-normal rounded-btn hover:bg-action-sky-hover transition-colors whitespace-nowrap cursor-pointer shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {props.sendCodeLabel ?? t("login.getCode")}
        </button>
      </div>

      {errorFeedback ? (
        <p
          role="alert"
          aria-live="polite"
          title={errorFeedback.text}
          className="min-w-0 truncate text-left text-[12px] font-normal leading-5 text-status-error"
        >
          {errorFeedback.text}
        </p>
      ) : null}

      <p className="auth-code-form-terms text-[10px] text-text-ink/50 text-left leading-snug">
        {t("login.termsPrefix")}
        <button type="button" onClick={props.onOpenTerms} className="text-action-sky hover:underline cursor-pointer">
          {t("login.termsLink")}
        </button>
        {t("login.termsConnector")}
        <button type="button" onClick={props.onOpenDataAgreement} className="text-action-sky hover:underline cursor-pointer">
          {t("login.dataAgreementLink")}
        </button>
        {t("login.termsSuffix")}
      </p>

      {props.error && (
        <p role="alert" className="text-[11px] text-status-error text-left leading-relaxed">
          {props.error}
        </p>
      )}

      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onSubmit}
        className="w-full py-3 bg-action-sky text-white font-semibold rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer shadow-md hover:shadow-lg active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {t("login.continue")}
      </button>
    </div>
  );
}
