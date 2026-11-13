import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import memmySad from "../assets/mascot/memmy-sad.png";
import type { CreditPlan } from "../app/credits-preview-quota.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./credits-exhausted-modal.module.css";

export interface CreditsExhaustedModalProps {
  plan: CreditPlan | null;
  nextReset: Date | null;
  onApplyMore(): void;
  onUseOwnModel(): void;
  onViewDetails(): void;
  onDismiss(): void;
}

export function CreditsExhaustedModal(props: CreditsExhaustedModalProps) {
  const { t, language } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const dismissRef = useRef(props.onDismiss);
  dismissRef.current = props.onDismiss;

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
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
  }, []);

  if (typeof document === "undefined") return null;

  const resetTime = props.nextReset?.toLocaleString(language, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }) ?? "—";
  const planName = props.plan ? t(props.plan === "pro" ? "plan.pro.name" : "plan.free.name") : "—";

  return createPortal(
    <div className={styles.backdrop} onClick={(event) => {
      if (event.target === event.currentTarget) props.onDismiss();
    }}>
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="credits-exhausted-title"
        aria-describedby="credits-exhausted-description"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <button className={styles.close} type="button" aria-label={t("common.close")} onClick={props.onDismiss}>
          <X size={18} aria-hidden="true" />
        </button>
        <div className={styles.mascot}><img src={memmySad} alt="" /></div>
        <h2 id="credits-exhausted-title">{t("credits.exhausted.title")}</h2>
        <p id="credits-exhausted-description" className={styles.description}>{t("credits.modal.description")}</p>
        <p className={styles.meta}>{t("credits.modal.reset", { plan: planName, time: "" })}<strong>{resetTime}</strong></p>
        <div className={styles.actions}>
          {props.plan === "free" ? (
            <>
              <button className={[styles.action, styles.primary].join(" ")} type="button" onClick={props.onApplyMore}>
                {t("credits.exhausted.upgrade")}
              </button>
              <button className={[styles.action, styles.secondary].join(" ")} type="button" onClick={props.onUseOwnModel}>
                {t("credits.modal.useOwnModel")}
              </button>
            </>
          ) : (
            <>
              <button className={[styles.action, styles.primary].join(" ")} type="button" onClick={props.onUseOwnModel}>
                {t("credits.modal.useOwnModel")}
              </button>
              <button className={[styles.action, styles.secondary].join(" ")} type="button" onClick={props.onViewDetails}>
                {t("credits.modal.viewDetails")}
              </button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
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
