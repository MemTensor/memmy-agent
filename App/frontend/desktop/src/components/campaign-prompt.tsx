/** Large campaign reminder, matching the computer-history feature-update dialog. */
import { X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import campaignArtUrl from "../assets/campaign/mid-autumn-riceball.jpg";
import { useTranslation } from "../i18n/use-translation.js";
import "./campaign-prompt.css";

export interface CampaignPromptProps {
  onOpenSite: () => void;
  onDismiss: () => void;
}

const CN_COPY = {
  eyebrow: "campaignPrompt.eyebrow",
  title: "campaignPrompt.title",
  poem: ["campaignPrompt.poemLine1", "campaignPrompt.poemLine2", "campaignPrompt.poemLine3"],
  cta: "campaignPrompt.cta"
} as const;

const INTL_COPY = {
  eyebrow: "campaignPromptIntl.eyebrow",
  title: "campaignPromptIntl.title",
  poem: ["campaignPromptIntl.poemLine1", "campaignPromptIntl.poemLine2", "campaignPromptIntl.poemLine3"],
  cta: "campaignPromptIntl.cta"
} as const;

/** Overseas builds show the intl copy set; the mainland build keeps the CN set. */
function campaignCopy() {
  return import.meta.env.MEMMY_APP_EDITION === "intl" ? INTL_COPY : CN_COPY;
}

/** Centered feature-update dialog inviting the user to the activity site. */
export function CampaignPrompt(props: CampaignPromptProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const onDismiss = props.onDismiss;
  const copy = campaignCopy();

  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onDismiss]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="campaign-intro-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="campaign-intro-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-intro-title"
        aria-describedby="campaign-intro-description"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <button
          className="campaign-intro-close"
          type="button"
          aria-label={t("common.close")}
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
        <div className="campaign-intro-copy">
          <p className="campaign-intro-eyebrow">{t(copy.eyebrow)}</p>
          <h2 id="campaign-intro-title">{t(copy.title)}</h2>
          <div id="campaign-intro-description" className="campaign-intro-poem">
            {copy.poem.map((key) => (
              <p key={key}>{t(key)}</p>
            ))}
          </div>
          <div className="campaign-intro-actions">
            <button className="campaign-intro-primary" type="button" onClick={props.onOpenSite}>
              {t(copy.cta)}
            </button>
          </div>
        </div>
        <div className="campaign-intro-visual" aria-hidden="true">
          <img
            className="campaign-intro-art"
            src={campaignArtUrl}
            alt=""
          />
        </div>
      </section>
    </div>,
    document.body
  );
}

function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") {
    return;
  }
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')
  );
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    first.focus();
  }
}
