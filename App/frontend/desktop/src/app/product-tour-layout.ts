/** Product tour layout module. */
import type { CSSProperties } from "react";

/** Definition for product tour memory nav anchor. */
export const PRODUCT_TOUR_MEMORY_NAV_ANCHOR = "product-tour-memory-nav";

/** Definition for the main Agent workspace anchor. */
export const PRODUCT_TOUR_CHAT_CONTENT_ANCHOR = "product-tour-chat-content";

/** Definition for product tour tools nav anchor. */
export const PRODUCT_TOUR_TOOLS_NAV_ANCHOR = "product-tour-tools-nav";

/** Definition for product tour tools content anchor. */
export const PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR = "product-tour-tools-content";

/** Memory call-log list highlighted during onboarding feature dig. */
export const PRODUCT_TOUR_MEMORY_LOGS_LIST_ANCHOR = "product-tour-memory-logs-list";

/** Logs item in the memory sidebar. */
export const PRODUCT_TOUR_MEMORY_LOGS_NAV_ANCHOR = "product-tour-memory-logs-nav";

/** Overview item in the memory sidebar. */
export const PRODUCT_TOUR_MEMORY_OVERVIEW_NAV_ANCHOR = "product-tour-memory-overview-nav";

/** Cross-agent sources item in the memory sidebar. */
export const PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR = "product-tour-memory-sources-nav";

/** Discovered-agent list on the cross-agent sources page. */
export const PRODUCT_TOUR_MEMORY_AGENTS_LIST_ANCHOR = "product-tour-memory-agents-list";

/** Scan-behavior preferences block on the cross-agent sources page. */
export const PRODUCT_TOUR_MEMORY_SCAN_PREFERENCES_ANCHOR = "product-tour-memory-scan-preferences";

/** Four-layer memory count cards on the overview page. */
export const PRODUCT_TOUR_MEMORY_OVERVIEW_COUNTS_ANCHOR = "product-tour-memory-overview-counts";

/** Approximate bubble box used for collision checks (matches `w-72` card + mascot headroom). */
const PRODUCT_TOUR_BUBBLE_WIDTH = 288;
const PRODUCT_TOUR_BUBBLE_HEIGHT = 200;
const PRODUCT_TOUR_VIEWPORT_PADDING = 16;

/** Contract for product tour rect. */
export interface ProductTourRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Contract for product tour highlight style. */
export interface ProductTourHighlightStyle {
  top: string;
  left: string;
  width: string;
  height: string;
}

/** Contract for product tour viewport. */
export interface ProductTourViewport {
  width: number;
  height: number;
}

/** Contract for product tour highlight spec. */
export interface ProductTourHighlightSpec {
  anchorId: string;
  padding?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  viewportBottom?: number;
}

/** Contract for product tour right bubble placement. */
export interface ProductTourRightBubblePlacement {
  anchorId: string;
  side: "right";
  align: "start" | "center";
  gap: number;
}

/** Contract for product tour below bubble placement. */
export interface ProductTourBelowBubblePlacement {
  anchorId: string;
  side: "below";
  align: "start" | "center";
  gap: number;
}

/** Contract for product tour above bubble placement. */
export interface ProductTourAboveBubblePlacement {
  anchorId: string;
  side: "above";
  align: "start" | "center";
  gap: number;
}

/** Contract for product tour inside bubble placement. */
export interface ProductTourInsideBubblePlacement {
  anchorId: string;
  side: "inside";
  blockAlign: "start" | "end";
  inlineAlign: "start" | "end";
  offsetX?: number;
  offsetY?: number;
}

/** Type definition for product tour bubble placement. */
export type ProductTourBubblePlacement =
  | ProductTourRightBubblePlacement
  | ProductTourBelowBubblePlacement
  | ProductTourAboveBubblePlacement
  | ProductTourInsideBubblePlacement;

/** Arrow direction resolved with the bubble. */
export type ProductTourArrowDirection = "left" | "right" | "top" | "bottom";

/** Contract for product tour anchor lookup. */
export interface ProductTourAnchorLookup {
  getAnchorRect: (anchorId: string) => ProductTourRect | null;
  getViewport: () => ProductTourViewport;
}

/** Contract for product tour resolved layout. */
export interface ProductTourResolvedLayout {
  highlight: ProductTourHighlightStyle;
  extraHighlights: ProductTourHighlightStyle[];
  bubblePosition: CSSProperties;
  arrow: ProductTourArrowDirection;
}

/** Handles resolve product tour step layout. */
export function resolveProductTourStepLayout(
  highlight: ProductTourHighlightSpec,
  bubble: ProductTourBubblePlacement,
  lookup: ProductTourAnchorLookup,
  extraHighlights?: readonly ProductTourHighlightSpec[]
): ProductTourResolvedLayout | null {
  const highlightRect = lookup.getAnchorRect(highlight.anchorId);
  const bubbleAnchorRect = lookup.getAnchorRect(bubble.anchorId);
  if (!highlightRect || !bubbleAnchorRect) {
    return null;
  }

  const viewport = lookup.getViewport();
  const resolvedHighlight = toHighlightStyle(highlightRect, highlight, viewport);
  const avoidRect =
    highlight.anchorId === bubble.anchorId
      ? null
      : toNumericHighlightRect(highlightRect, highlight, viewport);

  const resolvedExtras: ProductTourHighlightStyle[] = [];
  for (const extra of extraHighlights ?? []) {
    const rect = lookup.getAnchorRect(extra.anchorId);
    if (rect) {
      resolvedExtras.push(toHighlightStyle(rect, extra, viewport));
    }
  }

  const placed = resolveProductTourBubblePlacement(bubble, bubbleAnchorRect, viewport, avoidRect);

  return {
    highlight: resolvedHighlight,
    extraHighlights: resolvedExtras,
    bubblePosition: placed.style,
    arrow: placed.arrow
  };
}

/** Creates create dom product tour anchor lookup. */
export function createDomProductTourAnchorLookup(ownerDocument: Document): ProductTourAnchorLookup {
  return {
    getAnchorRect(anchorId) {
      const element = ownerDocument.querySelector<HTMLElement>(`[data-tour-anchor="${anchorId}"]`);
      return element ? readProductTourRect(element) : null;
    },
    getViewport() {
      const ownerWindow = ownerDocument.defaultView;
      return {
        width: ownerWindow?.innerWidth ?? ownerDocument.documentElement.clientWidth,
        height: ownerWindow?.innerHeight ?? ownerDocument.documentElement.clientHeight
      };
    }
  };
}

export type ProductTourScrollMode = "page-start" | "nearest" | "page-end";

/**
 * Scrolls the tour highlight into a usable position without burying page titles.
 *
 * Memory tour steps use tall list/card anchors; `scrollIntoView({ block: "center" })`
 * pulls those anchors to mid-viewport and hides the section header above them.
 * Resetting the nearest scroll container to the top keeps titles and first rows visible.
 * Bottom-of-page anchors (scan preferences / Auto sync) scroll the container to its end
 * via explicit `scrollTop`, because `scrollIntoView` is unreliable inside nested
 * `overflow-y: auto` panes and races with spotlight layout measurement.
 * Tools content stays on `nearest` so we only nudge when the panel is off-screen.
 *
 * Tour scrolls use `behavior: "auto"` so layout measurement sees the final position
 * in the same frame instead of lagging behind a smooth animation.
 */
export function scrollProductTourHighlightIntoView(
  element: HTMLElement,
  mode: ProductTourScrollMode = "page-start"
): void {
  if (mode === "nearest") {
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    return;
  }

  const scroller = findClosestScrollableAncestor(element) ?? findClosestOverflowYAncestor(element);
  if (mode === "page-end") {
    if (scroller) {
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTo({ top: maxTop, behavior: "auto" });
      return;
    }
    const scrollingElement = element.ownerDocument.scrollingElement;
    if (scrollingElement instanceof HTMLElement) {
      const maxTop = Math.max(0, scrollingElement.scrollHeight - scrollingElement.clientHeight);
      scrollingElement.scrollTo({ top: maxTop, behavior: "auto" });
    }
    return;
  }

  if (scroller) {
    scroller.scrollTo({ top: 0, behavior: "auto" });
    return;
  }

  const scrollingElement = element.ownerDocument.scrollingElement;
  if (scrollingElement instanceof HTMLElement) {
    scrollingElement.scrollTo({ top: 0, behavior: "auto" });
  }
}

/** Finds the nearest ancestor that actually scrolls vertically. */
export function findClosestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element.parentElement;
  while (current) {
    if (isOverflowYScroller(current) && current.scrollHeight > current.clientHeight + 1) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/** Finds the nearest overflow-y scroller even when content does not yet overflow. */
export function findClosestOverflowYAncestor(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element.parentElement;
  while (current) {
    if (isOverflowYScroller(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isOverflowYScroller(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const overflowY = style?.overflowY ?? "";
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

/** Handles resolve product tour bubble placement. */
function resolveProductTourBubblePlacement(
  bubble: ProductTourBubblePlacement,
  anchorRect: ProductTourRect,
  viewport: ProductTourViewport,
  avoidRect: ProductTourRect | null
): { style: CSSProperties; arrow: ProductTourArrowDirection } {
  if (bubble.side === "inside") {
    const offsetX = bubble.offsetX ?? 0;
    const offsetY = bubble.offsetY ?? 0;
    return {
      // Bubble on the right edge points left into the content; on the left edge points right.
      arrow: bubble.inlineAlign === "end" ? "left" : "right",
      style: {
        [bubble.blockAlign === "start" ? "top" : "bottom"]:
          `${bubble.blockAlign === "start" ? anchorRect.top + offsetY : viewport.height - anchorRect.bottom - offsetY}px`,
        [bubble.inlineAlign === "start" ? "left" : "right"]:
          `${bubble.inlineAlign === "start" ? anchorRect.left + offsetX : viewport.width - anchorRect.right + offsetX}px`
      }
    };
  }

  if (bubble.side === "below" || bubble.side === "above") {
    const left = bubble.align === "center"
      ? clamp(
        anchorRect.left + anchorRect.width / 2 - PRODUCT_TOUR_BUBBLE_WIDTH / 2,
        PRODUCT_TOUR_VIEWPORT_PADDING,
        Math.max(PRODUCT_TOUR_VIEWPORT_PADDING, viewport.width - PRODUCT_TOUR_BUBBLE_WIDTH - PRODUCT_TOUR_VIEWPORT_PADDING)
      )
      : clamp(
        anchorRect.left,
        PRODUCT_TOUR_VIEWPORT_PADDING,
        Math.max(PRODUCT_TOUR_VIEWPORT_PADDING, viewport.width - PRODUCT_TOUR_BUBBLE_WIDTH - PRODUCT_TOUR_VIEWPORT_PADDING)
      );
    const rawTop = bubble.side === "below"
      ? anchorRect.bottom + bubble.gap
      : anchorRect.top - bubble.gap - PRODUCT_TOUR_BUBBLE_HEIGHT;
    const top = clamp(
      rawTop,
      PRODUCT_TOUR_VIEWPORT_PADDING,
      Math.max(PRODUCT_TOUR_VIEWPORT_PADDING, viewport.height - PRODUCT_TOUR_BUBBLE_HEIGHT - PRODUCT_TOUR_VIEWPORT_PADDING)
    );
    return {
      arrow: bubble.side === "below" ? "top" : "bottom",
      style: {
        top: `${top}px`,
        left: `${left}px`
      }
    };
  }

  const preferredLeft = anchorRect.right + bubble.gap;
  const preferredTop =
    bubble.align === "center"
      ? anchorRect.top + anchorRect.height / 2 - PRODUCT_TOUR_BUBBLE_HEIGHT / 2
      : anchorRect.top;
  const preferred: ProductTourRect = {
    left: preferredLeft,
    top: preferredTop,
    width: PRODUCT_TOUR_BUBBLE_WIDTH,
    height: PRODUCT_TOUR_BUBBLE_HEIGHT,
    right: preferredLeft + PRODUCT_TOUR_BUBBLE_WIDTH,
    bottom: preferredTop + PRODUCT_TOUR_BUBBLE_HEIGHT
  };

  // Same-anchor (or no spotlight to dodge): keep the simple right-side placement.
  if (!avoidRect) {
    if (bubble.align === "center") {
      return {
        arrow: "left",
        style: {
          top: `${anchorRect.top + anchorRect.height / 2}px`,
          left: `${preferredLeft}px`,
          transform: "translateY(-50%)"
        }
      };
    }
    return {
      arrow: "left",
      style: {
        top: `${anchorRect.top}px`,
        left: `${preferredLeft}px`
      }
    };
  }

  // Highlight differs from the bubble anchor: park near the spotlight so the
  // callout tracks scroll/mask position instead of sticking to the nav rect.
  const gap = bubble.gap;
  const leftNearHighlight = clamp(
    Math.max(preferredLeft, avoidRect.left),
    PRODUCT_TOUR_VIEWPORT_PADDING,
    Math.max(PRODUCT_TOUR_VIEWPORT_PADDING, viewport.width - PRODUCT_TOUR_BUBBLE_WIDTH - PRODUCT_TOUR_VIEWPORT_PADDING)
  );

  type BubbleCandidate = {
    rect: ProductTourRect;
    arrow: ProductTourArrowDirection;
    /** When set, pin the bubble edge to the spotlight instead of assuming bubble height. */
    style?: CSSProperties;
  };

  const aboveBottomInset = viewport.height - avoidRect.top + gap;
  const aboveTop = avoidRect.top - gap - PRODUCT_TOUR_BUBBLE_HEIGHT;
  const candidates: BubbleCandidate[] = [
    {
      arrow: "top",
      rect: box(leftNearHighlight, avoidRect.bottom + gap)
    },
    {
      // Pin bottom edge just above the mask so real bubble height doesn't leave a gap.
      arrow: "bottom",
      rect: box(leftNearHighlight, aboveTop),
      style: {
        bottom: `${aboveBottomInset}px`,
        left: `${leftNearHighlight}px`
      }
    },
    {
      arrow: "left",
      rect: box(
        avoidRect.right + gap,
        clamp(
          preferredTop,
          PRODUCT_TOUR_VIEWPORT_PADDING,
          Math.max(PRODUCT_TOUR_VIEWPORT_PADDING, viewport.height - PRODUCT_TOUR_BUBBLE_HEIGHT - PRODUCT_TOUR_VIEWPORT_PADDING)
        )
      )
    }
  ];

  // Prefer the nav-side slot only when it still sits next to the spotlight.
  if (!rectsOverlap(preferred, avoidRect) && fitsViewport(preferred, viewport)) {
    const nearSpotlightVertically =
      preferred.bottom >= avoidRect.top - gap
      && preferred.top <= avoidRect.bottom + gap;
    if (nearSpotlightVertically) {
      candidates.unshift({ rect: preferred, arrow: "left" });
    }
  }

  for (const candidate of candidates) {
    if (fitsViewport(candidate.rect, viewport) && !rectsOverlap(candidate.rect, avoidRect)) {
      return {
        arrow: candidate.arrow,
        style: candidate.style ?? {
          top: `${candidate.rect.top}px`,
          left: `${candidate.rect.left}px`
        }
      };
    }
  }

  // Last resort: pin above the highlight when there is room, otherwise below.
  const preferAbove = aboveTop >= PRODUCT_TOUR_VIEWPORT_PADDING;
  if (preferAbove) {
    return {
      arrow: "bottom",
      style: {
        bottom: `${aboveBottomInset}px`,
        left: `${leftNearHighlight}px`
      }
    };
  }
  const fallbackTop = clamp(
    avoidRect.bottom + gap,
    PRODUCT_TOUR_VIEWPORT_PADDING,
    Math.max(PRODUCT_TOUR_VIEWPORT_PADDING, viewport.height - PRODUCT_TOUR_BUBBLE_HEIGHT - PRODUCT_TOUR_VIEWPORT_PADDING)
  );
  return {
    arrow: "top",
    style: {
      top: `${fallbackTop}px`,
      left: `${leftNearHighlight}px`
    }
  };
}

/** Builds a bubble-sized box at a top-left origin. */
function box(left: number, top: number): ProductTourRect {
  return {
    left,
    top,
    width: PRODUCT_TOUR_BUBBLE_WIDTH,
    height: PRODUCT_TOUR_BUBBLE_HEIGHT,
    right: left + PRODUCT_TOUR_BUBBLE_WIDTH,
    bottom: top + PRODUCT_TOUR_BUBBLE_HEIGHT
  };
}

/** Checks whether two rects overlap. */
function rectsOverlap(a: ProductTourRect, b: ProductTourRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Checks whether a rect fits inside the viewport with padding. */
function fitsViewport(rect: ProductTourRect, viewport: ProductTourViewport): boolean {
  return (
    rect.left >= PRODUCT_TOUR_VIEWPORT_PADDING
    && rect.top >= PRODUCT_TOUR_VIEWPORT_PADDING
    && rect.right <= viewport.width - PRODUCT_TOUR_VIEWPORT_PADDING
    && rect.bottom <= viewport.height - PRODUCT_TOUR_VIEWPORT_PADDING
  );
}

/** Clamps a number into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Converts a numeric rectangle into CSS styles.
 *
 * @param rect The numeric rectangle.
 * @returns String styles suitable for React style.
 */
function toHighlightStyle(
  rect: ProductTourRect,
  highlight: ProductTourHighlightSpec,
  viewport: ProductTourViewport
): ProductTourHighlightStyle {
  const numeric = toNumericHighlightRect(rect, highlight, viewport);
  return {
    top: `${numeric.top}px`,
    left: `${numeric.left}px`,
    width: `${numeric.width}px`,
    height: `${numeric.height}px`
  };
}

/** Resolves a padded highlight rectangle in viewport coordinates. */
function toNumericHighlightRect(
  rect: ProductTourRect,
  highlight: ProductTourHighlightSpec,
  viewport: ProductTourViewport
): ProductTourRect {
  const padding = highlight.padding ?? {};
  const top = Math.max(0, rect.top - (padding.top ?? 0));
  const left = Math.max(0, rect.left - (padding.left ?? 0));
  const right = Math.min(viewport.width, rect.right + (padding.right ?? 0));
  const bottom = highlight.viewportBottom == null
    ? rect.bottom + (padding.bottom ?? 0)
    : viewport.height - highlight.viewportBottom;
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  return { top, left, right: left + width, bottom: top + height, width, height };
}

/**
 * Reads the rectangle of a DOM element within the viewport.
 *
 * @param element The element to measure.
 * @returns Serializable rectangle data.
 */
function readProductTourRect(element: HTMLElement): ProductTourRect {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}
