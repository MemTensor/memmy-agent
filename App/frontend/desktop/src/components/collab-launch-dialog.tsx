/**
 * The 1.2.7 project-collaboration announcement: a four-page carousel with the same shell as the 1.2.5 feature
 * carousel (focus handling, Esc, backdrop click, Tab trap, sizes). The last page leads into the new-project dialog
 * with sharing already switched on.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import boardImage from "../assets/launch/collab-launch-visual-1.png";
import boardImageEn from "../assets/launch/collab-launch-visual-1.en.png";
import agentsImage from "../assets/launch/collab-launch-visual-2.png";
import agentsImageEn from "../assets/launch/collab-launch-visual-2.en.png";
import continueImage from "../assets/launch/collab-launch-visual-3.png";
import continueImageEn from "../assets/launch/collab-launch-visual-3.en.png";
import assistImage from "../assets/launch/collab-launch-visual-4.png";
import assistImageEn from "../assets/launch/collab-launch-visual-4.en.png";
import "./collab-launch-dialog.css";

interface SlideCopy {
  title: MessageKey;
  body: MessageKey;
  imageZh: string;
  imageEn: string;
}

const SLIDES: SlideCopy[] = [
  { title: "collabLaunch.board.title", body: "collabLaunch.board.body", imageZh: boardImage, imageEn: boardImageEn },
  { title: "collabLaunch.agents.title", body: "collabLaunch.agents.body", imageZh: agentsImage, imageEn: agentsImageEn },
  { title: "collabLaunch.continue.title", body: "collabLaunch.continue.body", imageZh: continueImage, imageEn: continueImageEn },
  { title: "collabLaunch.assist.title", body: "collabLaunch.assist.body", imageZh: assistImage, imageEn: assistImageEn }
];

export interface CollabLaunchDialogProps {
  onClose(): void;
  /** The last page's primary button: close the carousel and open the new-project dialog with sharing on. */
  onCreateProject(): void;
}

export function CollabLaunchDialog(props: CollabLaunchDialogProps) {
  const { t, language } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const [index, setIndex] = useState(0);
  const slide = SLIDES[index] ?? SLIDES[0]!;
  const image = language === "en-US" ? slide.imageEn : slide.imageZh;
  const last = index === SLIDES.length - 1;

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
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
    <div
      className="collab-launch-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="collab-launch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-launch-title"
        aria-describedby="collab-launch-body"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <button className="collab-launch-close" type="button" aria-label={t("common.close")} onClick={props.onClose}>
          <X size={18} aria-hidden="true" />
        </button>
        <p className="collab-launch-eyebrow">{t("collabLaunch.eyebrow")}</p>
        <div className="collab-launch-stage" aria-live="polite">
          {/* A new key remounts the page, which is what replays the enter animation. */}
          <div key={`copy-${index}`} className="collab-launch-copy collab-launch-enter">
            <h3 id="collab-launch-title">{t(slide.title)}</h3>
            <p id="collab-launch-body">{t(slide.body)}</p>
          </div>
          <div key={`visual-${index}`} className="collab-launch-visual collab-launch-enter" aria-hidden="true">
            <img src={image} alt="" />
          </div>
        </div>
        <nav className="collab-launch-nav" aria-label={t("collabLaunch.pages")}>
          <span className="collab-launch-count">{index + 1} / {SLIDES.length}</span>
          <div className="collab-launch-dots" aria-hidden="true">
            {SLIDES.map((_, step) => <span key={step} className={step === index ? "active" : undefined} />)}
          </div>
          <div className="collab-launch-page-buttons">
            <button
              type="button"
              className="collab-launch-prev"
              disabled={index === 0}
              aria-label={t("collabLaunch.previous")}
              onClick={() => setIndex((current) => Math.max(current - 1, 0))}
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="collab-launch-primary"
              onClick={() => {
                if (!last) {
                  setIndex((current) => current + 1);
                  return;
                }
                props.onCreateProject();
              }}
            >
              {t(last ? "collabLaunch.create" : "collabLaunch.next")}
              {last ? null : <ChevronRight size={17} aria-hidden="true" />}
            </button>
          </div>
        </nav>
      </section>
    </div>,
    document.body
  );
}

/** Keeps Tab and Shift+Tab inside the dialog, the same way the 1.2.5 carousel does. */
function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
