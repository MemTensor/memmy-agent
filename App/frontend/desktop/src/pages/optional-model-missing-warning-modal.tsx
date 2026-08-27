/** Optional model missing warning modal module. */
import { AlertTriangle } from "lucide-react";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";

export type OptionalModelMissingWarningKind = "asr" | "imageGen" | "both";

/** Contract for optional model missing warning state. */
export interface OptionalModelMissingWarningState {
  asrMissing: boolean;
  imageGenMissing: boolean;
}

/** Contract for optional model missing warning modal props. */
export interface OptionalModelMissingWarningModalProps {
  kind: OptionalModelMissingWarningKind;
  onClose: () => void;
}

interface OptionalModelMissingWarningCopy {
  title: MessageKey;
  impacts: MessageKey[];
}

const WARNING_COPY: Record<OptionalModelMissingWarningKind, OptionalModelMissingWarningCopy> = {
  asr: {
    title: "apiKey.asrMissingTitle",
    impacts: ["apiKey.optionalModelMissingImpactAsr"]
  },
  imageGen: {
    title: "apiKey.imageGenMissingTitle",
    impacts: ["apiKey.optionalModelMissingImpactImageGen"]
  },
  both: {
    title: "apiKey.optionalModelsMissingTitle",
    impacts: ["apiKey.optionalModelMissingImpactAsr", "apiKey.optionalModelMissingImpactImageGen"]
  }
};

/** Handles resolve optional model missing warning. */
export function resolveOptionalModelMissingWarning(state: OptionalModelMissingWarningState): OptionalModelMissingWarningKind | null {
  if (state.asrMissing && state.imageGenMissing) {
    return "both";
  }

  if (state.asrMissing) {
    return "asr";
  }

  if (state.imageGenMissing) {
    return "imageGen";
  }

  return null;
}

/** Handles optional model missing warning modal. */
export function OptionalModelMissingWarningModal(props: OptionalModelMissingWarningModalProps) {
  const { t } = useTranslation();
  const copy = WARNING_COPY[props.kind];

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4" role="presentation" onClick={props.onClose}>
      <div
        className="bg-background-paper rounded-card-lg shadow-xl border border-border-stone/30 p-6 w-full max-w-md"
        role="dialog"
        aria-modal="true"
        aria-label={t(copy.title)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-icon-ember/10">
            <AlertTriangle size={18} className="text-icon-ember" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-text-ink mb-6">{t(copy.title)}</h3>
            <p className="text-sm text-text-ink/70 leading-relaxed">
              <span className="rounded-sm bg-action-sky/10 px-1 py-0.5 text-action-sky">{t("apiKey.optionalModelMissingBodyStrong")}</span>
              {t("apiKey.optionalModelMissingBodySuffix")}
            </p>
            <ul className="mt-3 space-y-2">
              {copy.impacts.map((impact) => (
                <li key={impact} className="flex items-start gap-2 text-sm text-text-ink leading-relaxed">
                  <span className="mt-2 h-1.5 w-1.5 rounded-full bg-icon-ember shrink-0" aria-hidden="true" />
                  <span>{t(impact)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-text-ink/55 leading-relaxed">{t("apiKey.optionalModelMissingNext")}</p>
          </div>
        </div>
        <div className="flex justify-end mt-5">
          <button type="button" onClick={props.onClose} className="px-4 py-2 text-sm text-white rounded-btn transition-all cursor-pointer shadow-sm bg-action-sky hover:bg-action-sky-hover">
            {t("apiKey.optionalModelMissingAction")}
          </button>
        </div>
      </div>
    </div>
  );
}
