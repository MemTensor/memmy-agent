/** Token exhausted modal module. */
import { Gift } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface TokenExhaustedModalProps {
  showApplyMore?: boolean;
  onApplyMore?: () => void;
  onGoHandle: () => void;
  onLater: () => void;
}

export function TokenExhaustedModal(props: TokenExhaustedModalProps) {
  const { t } = useTranslation();
  const showApplyMore = Boolean((props.showApplyMore ?? true) && props.onApplyMore);

  return (
    <div className="token-exhausted-modal__backdrop" role="presentation" onClick={props.onLater}>
      <section
        className="token-exhausted-modal animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-label={t("tokenExhausted.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="token-exhausted-modal__content">
          <Memmy pose="sad" size={130} className="token-exhausted-modal__mascot" />
          <span className="token-exhausted-modal__badge">
            {t("tokenExhausted.title")}
          </span>
          <p className="token-exhausted-modal__body">
            {t("tokenExhausted.body")}
          </p>
        </div>

        <div className="token-exhausted-modal__actions">
          {showApplyMore && (
            <button
              type="button"
              onClick={props.onApplyMore}
              className="token-exhausted-modal__button token-exhausted-modal__button--primary"
            >
              <Gift size={15} aria-hidden="true" />
              {t("tokenExhausted.applyMore")}
            </button>
          )}
          <button
            type="button"
            onClick={props.onGoHandle}
            className="token-exhausted-modal__button token-exhausted-modal__button--secondary"
          >
            {t("tokenExhausted.switchApiKey")}
          </button>
          <button
            type="button"
            onClick={props.onLater}
            className="token-exhausted-modal__button token-exhausted-modal__button--later"
          >
            {t("tokenExhausted.later")}
          </button>
        </div>
      </section>
    </div>
  );
}
