/** Token exhausted modal module. */
import { Coins, Gift } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface TokenExhaustedModalProps {
  creditsPreview?: boolean;
  embedded?: boolean;
  showApplyMore?: boolean;
  onApplyMore?: () => void;
  onGoHandle: () => void;
  onLater: () => void;
}

export function TokenExhaustedModal(props: TokenExhaustedModalProps) {
  const { t } = useTranslation();
  const showApplyMore = Boolean((props.showApplyMore ?? true) && props.onApplyMore);

  const dialog = (
      <section
        className="token-exhausted-modal animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal={props.embedded ? undefined : true}
        aria-label={t(props.creditsPreview ? "credits.exhausted.title" : "tokenExhausted.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="token-exhausted-modal__content">
          <Memmy pose="sad" size={130} className="token-exhausted-modal__mascot" />
          <span className="token-exhausted-modal__badge">
            {t(props.creditsPreview ? "credits.exhausted.title" : "tokenExhausted.title")}
          </span>
          <p className="token-exhausted-modal__body">
            {t(props.creditsPreview ? "credits.exhausted.body" : "tokenExhausted.body")}
          </p>
        </div>

        <div className="token-exhausted-modal__actions">
          {showApplyMore && (
            <button
              type="button"
              onClick={props.onApplyMore}
              className="token-exhausted-modal__button token-exhausted-modal__button--primary"
            >
              {props.creditsPreview ? <Coins size={15} aria-hidden="true" /> : <Gift size={15} aria-hidden="true" />}
              {t(props.creditsPreview ? "credits.exhausted.upgrade" : "tokenExhausted.applyMore")}
            </button>
          )}
          <button
            type="button"
            onClick={props.onGoHandle}
            className="token-exhausted-modal__button token-exhausted-modal__button--secondary"
          >
            {t(props.creditsPreview ? "credits.exhausted.byok" : "tokenExhausted.switchApiKey")}
          </button>
          <button
            type="button"
            onClick={props.onLater}
            className="token-exhausted-modal__button token-exhausted-modal__button--later"
          >
            {t(props.creditsPreview ? "credits.exhausted.nextMonth" : "tokenExhausted.later")}
          </button>
        </div>
      </section>
  );

  if (props.embedded) {
    return <div className="flex justify-center">{dialog}</div>;
  }

  return (
    <div className="token-exhausted-modal__backdrop" role="presentation" onClick={props.onLater}>
      {dialog}
    </div>
  );
}
