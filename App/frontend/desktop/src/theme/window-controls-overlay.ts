/** Shared layout values for content that must avoid native window controls. */
import type { CSSProperties } from "react";

type ElectronCSSProperties = CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

export const WINDOW_CONTROLS_OVERLAY_SAFE_TOP = "calc(1rem + env(titlebar-area-height, 0px))";

export const WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE = {
  top: WINDOW_CONTROLS_OVERLAY_SAFE_TOP
} satisfies CSSProperties;

export const PAGE_CORNER_ACTION_CONTAINER_STYLE = {
  position: "absolute",
  top: WINDOW_CONTROLS_OVERLAY_SAFE_TOP,
  right: "1.25rem",
  zIndex: 10000,
  WebkitAppRegion: "no-drag"
} satisfies ElectronCSSProperties;
