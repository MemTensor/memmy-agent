import type { TaskTokenGiftNotice } from "@memmy/local-api-contracts";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import type { MessageKey } from "../i18n/messages.js";
import giftExistingImage from "../assets/launch/launch-visual-token.png";
import giftExistingImageEn from "../assets/launch/launch-visual-token.en.png";
import giftNewImage from "../assets/launch/launch-visual-token-new.png";
import giftNewImageEn from "../assets/launch/launch-visual-token-new.en.png";
import recordingImage from "../assets/launch/launch-visual-recording.png";
import recordingImageEn from "../assets/launch/launch-visual-recording.en.png";
import marketplaceImage from "../assets/launch/launch-visual-marketplace.png";
import marketplaceImageEn from "../assets/launch/launch-visual-marketplace.en.png";
import literatureImage from "../assets/launch/launch-visual-literature.png";
import literatureImageEn from "../assets/launch/launch-visual-literature.en.png";
import officeImage from "../assets/launch/launch-visual-office.png";
import officeImageEn from "../assets/launch/launch-visual-office.en.png";
import "./history-launch-prompt.css";
import "./task-token-gift-dialog.css";

type CreditedGift = Extract<TaskTokenGiftNotice, { hasGift: true }>;
type Slide = "gift" | "recording" | "marketplace" | "literature" | "office";
const FEATURE_SLIDES: Slide[] = ["recording", "marketplace", "literature", "office"];
const FEATURE_COPY: Record<Exclude<Slide, "gift">, { subtitle: MessageKey; body: MessageKey; imageZh: string; imageEn: string }> = {
  recording: { subtitle: "launchGift.recordingSubtitle", body: "launchGift.recordingBody", imageZh: recordingImage, imageEn: recordingImageEn },
  marketplace: { subtitle: "launchGift.marketplaceSubtitle", body: "launchGift.marketplaceBody", imageZh: marketplaceImage, imageEn: marketplaceImageEn },
  literature: { subtitle: "launchGift.literatureSubtitle", body: "launchGift.literatureBody", imageZh: literatureImage, imageEn: literatureImageEn },
  office: { subtitle: "launchGift.officeSubtitle", body: "launchGift.officeBody", imageZh: officeImage, imageEn: officeImageEn }
};

export interface TaskTokenGiftDialogProps {
  gift?: CreditedGift;
  showFeatures: boolean;
  onClose(): void;
  onFeaturesCompleted(): void;
}

/** A fixed-size History-style carousel. Navigation never changes the grant. */
export function TaskTokenGiftDialog(props: TaskTokenGiftDialogProps) {
  const { t, language } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const [index, setIndex] = useState(0);
  const slides: Slide[] = [...(props.gift ? ["gift" as const] : []), ...(props.showFeatures ? FEATURE_SLIDES : [])];
  const slide = slides[index] ?? slides[0] ?? "gift";
  const giftSlide = slide === "gift";
  const copy = !giftSlide ? FEATURE_COPY[slide] : null;
  const heading = giftSlide ? t("launchGift.giftReadyTitle") : t(copy!.subtitle);
  const body = giftSlide
    ? t(props.gift?.audience === "new" ? "launchGift.newReadyBody"
      : props.showFeatures ? "launchGift.existingReadyBody" : "launchGift.existingReadyBodyOnly")
    : t(copy!.body);
  const image = giftSlide
    ? props.gift?.audience === "new" ? language === "en-US" ? giftNewImageEn : giftNewImage
      : language === "en-US" ? giftExistingImageEn : giftExistingImage
    : language === "en-US" ? copy!.imageEn : copy!.imageZh;
  const last = index === slides.length - 1;

  function next() {
    if (!last) { setIndex((current) => current + 1); return; }
    if (props.showFeatures) props.onFeaturesCompleted();
    props.onClose();
  }

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
      <p className="history-launch-eyebrow">{t(giftSlide ? "launchGift.eyebrow" : "launchGift.featureEyebrow")}</p>
      <div className="history-launch-card task-gift-dialog__stage" aria-live="polite">
        <div key={`copy-${slide}`} className="history-launch-copy task-gift-dialog__copy task-gift-dialog__enter">
          <h3 id="task-gift-title">{heading}</h3>
          <p id="task-gift-body">{body}</p>
        </div>
        <div key={`image-${slide}`} className="history-launch-visual task-gift-dialog__visual task-gift-dialog__enter" aria-hidden="true">
          <img src={image} alt="" />
        </div>
      </div>
      <nav className="task-gift-dialog__nav" aria-label={t("launchGift.announcementPages")}>
        <span className="task-gift-dialog__count">{index + 1} / {slides.length}</span>
        <div className="task-gift-dialog__dots" aria-hidden="true">{slides.map((item, step) => <span key={item} className={step === index ? "active" : ""} />)}</div>
        <div className="task-gift-dialog__page-buttons">
          <button type="button" className="task-gift-dialog__page-button" disabled={index === 0}
            onClick={() => setIndex((current) => current - 1)} aria-label={t("launchGift.previous")}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className="task-gift-dialog__next" onClick={next}>
            {t(last ? "launchGift.done" : "launchGift.next")}
            {!last ? <ChevronRight size={17} aria-hidden="true" /> : null}
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
