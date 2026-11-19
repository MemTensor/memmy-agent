import type { TaskTokenGiftNotice } from "@memmy/local-api-contracts";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, X } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import giftImage from "../assets/launch/launch-visual-token.png";
import giftImageEn from "../assets/launch/launch-visual-token.en.png";
import "./history-launch-prompt.css";
import "./task-token-gift-dialog.css";

type CreditedGift = Extract<TaskTokenGiftNotice, { hasGift: true }>;

export interface TaskTokenGiftDialogProps {
  gift: CreditedGift;
  onClose(): void;
}

/**
 * A fixed-size History-style card with a single gift page. The carousel shell stays
 * (page count, dots and paging buttons) so the one page looks the same as before.
 */
export function TaskTokenGiftDialog(props: TaskTokenGiftDialogProps) {
  const { t, language } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(<div className="history-launch-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget) props.onClose();
  }}>
    <section ref={dialogRef} className="history-launch-dialog task-gift-dialog" role="dialog" aria-modal="true"
      aria-labelledby="task-gift-title" aria-describedby="task-gift-body" tabIndex={-1} onKeyDown={trapFocus}>
      <button className="history-launch-close" type="button" aria-label={t("common.close")} onClick={props.onClose}><X size={18} /></button>
      <p className="history-launch-eyebrow">{t("launchGift.eyebrow")}</p>
      <div className="history-launch-card task-gift-dialog__stage" aria-live="polite">
        <div className="history-launch-copy task-gift-dialog__copy task-gift-dialog__enter">
          <h3 id="task-gift-title">{t("launchGift.giftReadyTitle")}</h3>
          <p id="task-gift-body">{t("launchGift.existingReadyBodyOnly")}</p>
        </div>
        <div className="history-launch-visual task-gift-dialog__visual task-gift-dialog__enter" aria-hidden="true">
          <img src={language === "en-US" ? giftImageEn : giftImage} alt="" />
        </div>
      </div>
      <nav className="task-gift-dialog__nav" aria-label={t("launchGift.announcementPages")}>
        <span className="task-gift-dialog__count">1 / 1</span>
        <div className="task-gift-dialog__dots" aria-hidden="true"><span className="active" /></div>
        <div className="task-gift-dialog__page-buttons">
          <button type="button" className="task-gift-dialog__page-button" disabled aria-label={t("launchGift.previous")}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className="task-gift-dialog__next" onClick={props.onClose}>
            {t("launchGift.done")}
          </button>
        </div>
      </nav>
    </section>
  </div>, document.body);
}

function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
  const first = items[0]; const last = items.at(-1);
  if (!first || !last) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}
