/** Api key form fields module. */
import { CheckCircle2, Eye, EyeOff, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import { OverflowTooltipText } from "../components/overflow-tooltip-text.js";
import type { ModelConfigValidationState } from "./model-config-validation.js";

/** Definition for api key card class. */
export const API_KEY_CARD_CLASS = "bg-background-paper rounded-card-lg shadow-lg border border-border-stone/60 p-6";

/** Definition for api key input class. */
export const API_KEY_INPUT_CLASS =
  "auth-code-form-input w-full px-5 py-3 border rounded-input text-sm bg-canvas-oat/30 focus:outline-none placeholder:text-text-ink/45";

/** Definition for api key primary btn class. */
export const API_KEY_PRIMARY_BTN_CLASS =
  "py-3.5 text-sm text-white font-normal bg-action-sky rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer shadow-md hover:shadow-lg active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed";

/** Definition for api key secondary btn class. */
export const API_KEY_SECONDARY_BTN_CLASS =
  "welcome-byok-action flex items-center justify-center py-3.5 text-sm text-text-ink/75 font-normal hover:text-action-sky transition-all cursor-pointer shadow-sm disabled:opacity-45 disabled:cursor-not-allowed";

/** Type definition for test status. */
type TestStatus = ModelConfigValidationState["status"];

/** Contract for config field props. */
interface ConfigFieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: string;
  readOnly?: boolean;
}

/** Contract for password config field props. */
interface PasswordConfigFieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  maskedValue?: string;
  showPassword: boolean;
  onTogglePassword: () => void;
}

/** Contract for test button props. */
interface TestButtonProps {
  status: TestStatus;
  onClick: () => void;
  label: string;
}

/** Contract for validation message props. */
interface ValidationMessageProps {
  validation: ModelConfigValidationState;
  stale: boolean;
}

/** Handles config field. */
export function ConfigField(props: ConfigFieldProps) {
  return (
    <div>
      <label className="block text-xs text-text-ink/65 mb-1.5 font-normal">{props.label}</label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder={props.placeholder}
          value={props.value}
          readOnly={props.readOnly}
          onChange={(event) => props.onChange(event.target.value)}
          className={`${API_KEY_INPUT_CLASS} flex-1 read-only:cursor-default`}
        />
        {props.suffix && <span className="text-xs text-text-ink/55 shrink-0">{props.suffix}</span>}
      </div>
    </div>
  );
}

/**
 * Renders the API Key password field.
 */
export function PasswordConfigField(props: PasswordConfigFieldProps) {
  const { t } = useTranslation();
  const placeholder = !props.value.trim() && props.maskedValue ? props.maskedValue : props.placeholder;

  return (
    <div>
      <label className="block text-xs text-text-ink/65 mb-1.5 font-normal">{props.label}</label>
      <div className="relative">
        <input
          type={props.showPassword ? "text" : "password"}
          placeholder={placeholder}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          className={`${API_KEY_INPUT_CLASS} pr-10`}
        />
        <button
          type="button"
          onClick={props.onTogglePassword}
          aria-label={props.showPassword ? t("apiKey.hideKey") : t("apiKey.showKey")}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-ink/45 hover:text-text-ink/75 cursor-pointer transition-colors"
        >
          {props.showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

/**
 * Renders the connection test button.
 */
export function TestButton(props: TestButtonProps) {
  const { t } = useTranslation();
  const isTesting = props.status === "testing";
  const isSuccess = props.status === "success";
  const isError = props.status === "error";
  const label = isTesting ? t("apiKey.testing") : isSuccess ? t("apiKey.testSuccess") : isError ? t("apiKey.testRetry") : props.label;

  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={isTesting}
      className={`inline-flex w-[112px] h-10 shrink-0 items-center justify-center px-4 text-xs border rounded-btn transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
        isSuccess
          ? "text-status-success border-status-success/30 bg-status-success-soft"
          : isError
            ? "text-status-error border-status-error/30 bg-status-error-soft"
            : "text-text-ink/65 border-border-stone hover:bg-canvas-oat/50"
      }`}
    >
      <span className="inline-flex items-center justify-center gap-1.5">
        {isTesting && <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />}
        {isSuccess && <CheckCircle2 size={13} className="shrink-0" aria-hidden="true" />}
        {isError && <XCircle size={13} className="shrink-0" aria-hidden="true" />}
        <span className="leading-none">{label}</span>
      </span>
    </button>
  );
}

/**
 * Renders the connection test result.
 */
export function ValidationMessage(props: ValidationMessageProps) {
  const { t } = useTranslation();

  if (props.validation.status === "idle" && !props.stale) {
    return null;
  }

  const isSuccess = props.validation.status === "success" && !props.stale;
  const message = props.stale ? t("apiKey.testStale") : props.validation.message;

  return (
    <OverflowTooltipText
      className={`min-w-0 flex-1 truncate text-right text-xs ${isSuccess ? "text-status-success" : "text-status-error"}`}
      text={message ?? ""}
    />
  );
}
