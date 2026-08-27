import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { createPortal } from "react-dom";

export interface MemoryPluginConflictModalProps {
  onChoice: (replace: boolean) => void;
  onBack?: () => void;
  resolving?: boolean;
}

export function MemoryPluginConflictModal(props: MemoryPluginConflictModalProps) {
  const { t } = useTranslation();

  const body = (
    <div className="memory-plugin-conflict-modal__backdrop" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-plugin-conflict-title"
        className="memory-plugin-conflict-modal"
      >
        <div className="memory-plugin-conflict-modal__mascot">
          <Memmy pose="shield" size={112} className="memmy-bob" />
        </div>

        <h2 id="memory-plugin-conflict-title" className="memory-plugin-conflict-modal__title">
          {t("onboarding.pluginConflict.title")}
        </h2>

        <p className="memory-plugin-conflict-modal__body">
          {t("onboarding.pluginConflict.body")}
        </p>

        <div className="memory-plugin-conflict-modal__divider" />

        <p className="memory-plugin-conflict-modal__hint">
          {t("onboarding.pluginConflict.replaceHint")}
        </p>

        <div className="memory-plugin-conflict-modal__actions">
          <button
            type="button"
            disabled={props.resolving}
            onClick={props.onBack}
            className="memory-plugin-conflict-modal__button memory-plugin-conflict-modal__button--muted"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={props.resolving}
            onClick={() => props.onChoice(false)}
            className="memory-plugin-conflict-modal__button memory-plugin-conflict-modal__button--secondary"
          >
            {t("onboarding.pluginConflict.skillOnly")}
          </button>
          <button
            type="button"
            disabled={props.resolving}
            onClick={() => props.onChoice(true)}
            className="memory-plugin-conflict-modal__button memory-plugin-conflict-modal__button--primary"
          >
            {t("onboarding.pluginConflict.replace")}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? body : createPortal(body, document.body);
}
