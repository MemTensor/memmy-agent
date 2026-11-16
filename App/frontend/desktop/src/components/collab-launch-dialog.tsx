/**
 * The one-time project-collaboration announcement: one page with the same shell as the History announcement, holding a
 * moving stage and the caption of the scene currently on screen.
 *
 * The button only opens the new-project dialog with sharing already on. On a computer that has not authorized yet, the
 * same click also starts the authorization in the background (see `app/collab-launch-authorization.ts`): the card shows
 * no progress and reports nothing, so all it keeps is a small question mark explaining what that click authorizes.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, X } from "lucide-react";
import type { CollabClient } from "../api/collab-client.js";
import { startLaunchAuthorization } from "../app/collab-launch-authorization.js";
import { useTranslation } from "../i18n/use-translation.js";
import { COLLAB_LAUNCH_CAPTIONS, CollabLaunchStage } from "./collab-launch-motion.js";
import "./collab-launch-dialog.css";

export interface CollabLaunchDialogProps {
  onClose(): void;
  /** Close the announcement and open the new-project dialog with sharing on. */
  onCreateProject(): void;
  /**
   * The collaboration client. Absent in tests and previews without providers: the card then only opens the project,
   * without the question mark and without authorizing anything.
   */
  collab?: CollabClient | null;
}

export function CollabLaunchDialog(props: CollabLaunchDialogProps) {
  const { t, language } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const collab = props.collab ?? null;

  const [granted, setGranted] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sceneIndex, setSceneIndex] = useState(0);
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      // A capture-phase listener on the card closes it; the explanation on top of it goes first, so one Escape only
      // closes the explanation and the next one closes the card.
      if (helpOpenRef.current) {
        setHelpOpen(false);
        return;
      }
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Reads the current authorization once: it decides whether the card explains the click that is about to authorize.
  // Still reading, or unable to read, shows the question mark as well; authorizing twice does no harm.
  useEffect(() => {
    if (!collab) return;
    let cancelled = false;
    collab.getAgentAccess()
      .then((view) => {
        if (!cancelled) setGranted(view.granted);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [collab]);

  // Clicking anywhere outside the question mark and its explanation closes the explanation, the button included: the
  // button toggles itself, so it must stay out of this.
  useEffect(() => {
    if (!helpOpen) return;
    const onDown = (event: MouseEvent) => {
      if (helpRef.current?.contains(event.target as Node)) return;
      setHelpOpen(false);
    };
    document.addEventListener("click", onDown);
    return () => document.removeEventListener("click", onDown);
  }, [helpOpen]);

  if (typeof document === "undefined") return null;

  const explainAuthorization = collab !== null && !granted;
  const scene =
    COLLAB_LAUNCH_CAPTIONS[Math.min(sceneIndex, COLLAB_LAUNCH_CAPTIONS.length - 1)] ??
    ({ main: "collabLaunch.scene1Main", sub: "collabLaunch.scene1Sub" } as const);
  const mainUnits = captionUnits(t(scene.main));
  const subLine = scene.sub ? t(scene.sub) : null;

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
        // The app always runs under `lang="en"`: the card says which language it is written in, so the browser can
        // space Chinese text and break English words correctly.
        lang={language === "en-US" ? "en" : "zh-CN"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-launch-title"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <button className="collab-launch-close" type="button" aria-label={t("common.close")} onClick={props.onClose}>
          <X size={18} aria-hidden="true" />
        </button>
        <p className="collab-launch-eyebrow">{t("collabLaunch.eyebrow")}</p>
        {/* 卡面不再有可见标题，读屏仍然念得出来。 */}
        <h2 id="collab-launch-title" className="collab-launch-title-sr">
          {t("collabLaunch.title")}
        </h2>
        <div className="collab-launch-stage-slot">
          <CollabLaunchStage onSceneChange={setSceneIndex} />
        </div>
        <div className="collab-launch-caption-bar">
          {/* 换段时整块重新挂载：逐字浮出的动画跟着这段文案从头放。 */}
          <div className="collab-launch-caption" key={sceneIndex}>
            <h3 className="collab-launch-caption__main">
              {mainUnits.map((unit, index) =>
                unit.order < 0 ? (
                  " "
                ) : (
                  <span key={index} style={{ "--i": unit.order } as CSSProperties}>
                    {unit.text}
                  </span>
                )
              )}
            </h3>
            {subLine === null ? null : <p className="collab-launch-caption__sub">{subLine}</p>}
          </div>
          <div className="collab-launch-actions">
            <button
              className="collab-launch-primary"
              type="button"
              onClick={() => {
                // Started before the card closes: nobody watches the installs, and the board reports what failed.
                if (explainAuthorization) startLaunchAuthorization(collab);
                props.onCreateProject();
              }}
            >
              {t("collabLaunch.create")}
            </button>
            {explainAuthorization ? (
              <div className="collab-launch-help-wrap" ref={helpRef}>
                <button
                  className="collab-launch-help"
                  type="button"
                  aria-label={t("collabLaunch.help")}
                  aria-expanded={helpOpen}
                  onClick={() => setHelpOpen((open) => !open)}
                >
                  <CircleHelp size={16} aria-hidden="true" />
                </button>
                {helpOpen ? (
                  <div className="collab-launch-popover" role="note">
                    <b>{t("collabLaunch.helpTitle")}</b>
                    <ul>
                      <li>{t("collabLaunch.helpItem1")}</li>
                      <li>{t("collabLaunch.helpItem2")}</li>
                    </ul>
                    <p className="collab-launch-popover__note">{t("collabLaunch.helpNote")}</p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}

/**
 * Splits a caption into the pieces that float in one after another: a word in English, a character in Chinese.
 * Whitespace stays whole and does not take a slot, so words keep their own timing.
 */
function captionUnits(text: string): Array<{ text: string; order: number }> {
  const units = text.match(/[A-Za-z0-9]+|\s+|[^A-Za-z0-9\s]/g) ?? [];
  let order = 0;
  return units.map((unit) => (/^\s+$/.test(unit) ? { text: " ", order: -1 } : { text: unit, order: order++ }));
}

/** Keeps Tab and Shift+Tab inside the dialog, the same way the History announcement does. */
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
