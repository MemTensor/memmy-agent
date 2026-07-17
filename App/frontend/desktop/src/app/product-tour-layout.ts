/** Product tour layout module. */
import type { CSSProperties } from "react";

/** Definition for product tour memory nav anchor. */
export const PRODUCT_TOUR_MEMORY_NAV_ANCHOR = "product-tour-memory-nav";

/** Definition for product tour tools nav anchor. */
export const PRODUCT_TOUR_TOOLS_NAV_ANCHOR = "product-tour-tools-nav";

/** Definition for product tour tools content anchor. */
export const PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR = "product-tour-tools-content";

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
export type ProductTourBubblePlacement = ProductTourRightBubblePlacement | ProductTourInsideBubblePlacement;

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
}

/** Handles resolve product tour step layout. */
export function resolveProductTourStepLayout(
  highlight: ProductTourHighlightSpec,
  bubble: ProductTourBubblePlacement,
  lookup: ProductTourAnchorLookup,
  extraHighlights?: readonly ProductTourHighlightSpec[]
): ProductTourResolvedLayout | null {
  const highlightRect = lookup.getAnchorRect(highlight.anchorId);
  const bubbleRect = lookup.getAnchorRect(bubble.anchorId);
  if (!highlightRect || !bubbleRect) {
    return null;
  }

  const viewport = lookup.getViewport();
  const resolvedExtras: ProductTourHighlightStyle[] = [];
  for (const extra of extraHighlights ?? []) {
    const rect = lookup.getAnchorRect(extra.anchorId);
    if (rect) {
      resolvedExtras.push(toHighlightStyle(rect, extra, viewport));
    }
  }

  return {
    highlight: toHighlightStyle(highlightRect, highlight, viewport),
    extraHighlights: resolvedExtras,
    bubblePosition: resolveProductTourBubblePlacement(bubble, bubbleRect, viewport)
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

/** Handles resolve product tour bubble placement. */
function resolveProductTourBubblePlacement(
  bubble: ProductTourBubblePlacement,
  anchorRect: ProductTourRect,
  viewport: ProductTourViewport
): CSSProperties {
  if (bubble.side === "inside") {
    const offsetX = bubble.offsetX ?? 0;
    const offsetY = bubble.offsetY ?? 0;
    return {
      [bubble.blockAlign === "start" ? "top" : "bottom"]:
        `${bubble.blockAlign === "start" ? anchorRect.top + offsetY : viewport.height - anchorRect.bottom - offsetY}px`,
      [bubble.inlineAlign === "start" ? "left" : "right"]:
        `${bubble.inlineAlign === "start" ? anchorRect.left + offsetX : viewport.width - anchorRect.right + offsetX}px`
    };
  }

  if (bubble.align === "center") {
    const centerY = anchorRect.top + anchorRect.height / 2;
    return {
      top: `${centerY}px`,
      left: `${anchorRect.right + bubble.gap}px`,
      transform: "translateY(-50%)"
    };
  }

  return {
    top: `${anchorRect.top}px`,
    left: `${anchorRect.right + bubble.gap}px`
  };
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
  const padding = highlight.padding ?? {};
  const top = Math.max(0, rect.top - (padding.top ?? 0));
  const left = Math.max(0, rect.left - (padding.left ?? 0));
  const right = Math.min(viewport.width, rect.right + (padding.right ?? 0));
  const bottom = highlight.viewportBottom == null
    ? rect.bottom + (padding.bottom ?? 0)
    : viewport.height - highlight.viewportBottom;

  return {
    top: `${top}px`,
    left: `${left}px`,
    width: `${Math.max(0, right - left)}px`,
    height: `${Math.max(0, bottom - top)}px`
  };
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
