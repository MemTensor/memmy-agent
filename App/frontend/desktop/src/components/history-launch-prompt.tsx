import { X } from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/use-translation.js";
import { HistoryLaunchCard } from "./history-launch-card.js";
import "./history-launch-prompt.css";

export function HistoryLaunchPrompt(props: { onEnable(): void; onDismiss(): void }) {
  const { t } = useTranslation();
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

  return createPortal(
    <div className="history-launch-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) props.onDismiss();
    }}>
      <section
        ref={dialogRef}
        className="history-launch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-launch-title"
        aria-describedby="history-launch-footnote"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <button className="history-launch-close" type="button" aria-label={t("common.close")} onClick={props.onDismiss}>
          <X size={18} aria-hidden="true" />
        </button>
        <p className="history-launch-eyebrow">{t("historyLaunch.eyebrow")}</p>
        <h2 id="history-launch-title">{t("historyLaunch.title")}</h2>
        <HistoryLaunchCard onEnable={props.onEnable} footnoteId="history-launch-footnote" />
      </section>
    </div>,
    document.body
  );
}

function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    first.focus();
  }
}
