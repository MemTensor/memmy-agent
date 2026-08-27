/** Language toggle button module. */
import { Globe2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { ResolvedLanguage } from "../i18n/messages.js";
import { PAGE_CORNER_ACTION_CONTAINER_STYLE } from "../theme/window-controls-overlay.js";

export { PAGE_CORNER_ACTION_CONTAINER_STYLE } from "../theme/window-controls-overlay.js";

const PAGE_CORNER_ACTION_CLASS =
  "flex items-center justify-center gap-1.5 px-2 py-1 text-sm font-normal text-text-ink/55 hover:text-text-ink/75 transition-colors cursor-pointer";

const PAGE_CORNER_ACTION_STYLE = {
  minHeight: "2.75rem",
  WebkitAppRegion: "no-drag"
} as CSSProperties;

export interface PageCornerActionButtonProps {
  label: string;
  ariaLabel?: string;
  icon: ReactNode;
  onClick: () => void;
  minWidth?: string;
  className?: string;
}

export function PageCornerActionButton(props: PageCornerActionButtonProps) {
  return (
    <button
      type="button"
      aria-label={props.ariaLabel ?? props.label}
      onClick={props.onClick}
      className={[PAGE_CORNER_ACTION_CLASS, props.className].filter(Boolean).join(" ")}
      style={{
        ...PAGE_CORNER_ACTION_STYLE,
        minWidth: props.minWidth
      }}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

export interface LanguageToggleButtonProps {
  language: ResolvedLanguage;
  onClick: () => void;
  embedded?: boolean;
}

export function LanguageToggleButton(props: LanguageToggleButtonProps) {
  const label = props.language === "en-US" ? "ZH" : "EN";
  const embeddedStyle = { minWidth: "4.5rem", minHeight: "2.75rem", WebkitAppRegion: "no-drag" } as CSSProperties;
  const cornerStyle = {
    ...PAGE_CORNER_ACTION_CONTAINER_STYLE,
    ...embeddedStyle
  } as CSSProperties;

  if (props.embedded) {
    return (
      <PageCornerActionButton
        label={label}
        ariaLabel={props.language === "en-US" ? "Switch to Chinese" : "Switch to English"}
        onClick={props.onClick}
        minWidth="4.5rem"
        icon={<Globe2 aria-hidden="true" size={16} className="shrink-0" />}
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={props.language === "en-US" ? "Switch to Chinese" : "Switch to English"}
      onClick={props.onClick}
      className={PAGE_CORNER_ACTION_CLASS}
      style={cornerStyle}
    >
      <Globe2 aria-hidden="true" size={16} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}
