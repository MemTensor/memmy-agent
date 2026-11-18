/** Token exhausted modal module. */
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
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

  const dialogRef = useRef<HTMLElement>(null);
  const dismissRef = useRef(props.onLater);
  dismissRef.current = props.onLater;

  useLayoutEffect(() => {
    if (props.embedded) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [props.embedded]);


  const dialog = (
      <section
        ref={dialogRef}
        onKeyDown={props.embedded ? undefined : trapFocus}
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

function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
