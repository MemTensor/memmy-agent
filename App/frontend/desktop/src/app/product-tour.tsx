/** Product tour module. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Memmy, type MemmyPose } from "../components/mascot/memmy.js";
import { zhCNMessages, type MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { BrainCircuit, Link2 } from "../pages/memory/memory-prototype-icons.js";
import {
  createDomProductTourAnchorLookup,
  PRODUCT_TOUR_MEMORY_NAV_ANCHOR,
  PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
  PRODUCT_TOUR_TOOLS_NAV_ANCHOR,
  resolveProductTourStepLayout,
  type ProductTourBubblePlacement,
  type ProductTourHighlightSpec
} from "./product-tour-layout.js";
import { readProductTourStep, writeProductTourStep, type AppRoutePath } from "./routes.js";

/** Type definition for product tour tab. */
export type ProductTourTab = "chat" | "tools" | "memory" | "settings";

/** Handles product tour tab route. */
export function productTourTabRoute(tab: ProductTourTab): AppRoutePath {
  switch (tab) {
    case "tools":
      return "/tools";
    case "settings":
      return "/settings";
    case "memory":
    case "chat":
    default:
      return "/main";
  }
}

type ArrowDirection = "left" | "right" | "top" | "bottom";

/** Contract for product tour step. */
export interface ProductTourStep {
  tab: ProductTourTab;
  title: string;
  icon: ReactNode;
  pose: MemmyPose;
  description: string;
  arrow: ArrowDirection;
  bubblePlacement: ProductTourBubblePlacement;
  highlight: ProductTourHighlightSpec;
  extraHighlights?: ProductTourHighlightSpec[];
}

const PRODUCT_TOUR_BUBBLE_GAP_PX = 16;

export const productTourSteps: ProductTourStep[] = createProductTourSteps((key) => zhCNMessages[key]);

/** Creates create product tour steps. */
export function createProductTourSteps(t: (key: MessageKey) => string): ProductTourStep[] {
  return [
    {
      tab: "memory",
      title: t("productTour.memory.title"),
      icon: <BrainCircuit size={15} className="text-action-sky" />,
      pose: "brain",
      description: t("productTour.memory.description"),
      arrow: "left",
      bubblePlacement: {
        anchorId: PRODUCT_TOUR_MEMORY_NAV_ANCHOR,
        side: "right",
        align: "center",
        gap: PRODUCT_TOUR_BUBBLE_GAP_PX
      },
      highlight: {
        anchorId: PRODUCT_TOUR_MEMORY_NAV_ANCHOR
      }
    },
    {
      tab: "tools",
      title: t("productTour.tools.title"),
      icon: <Link2 size={15} className="text-action-sky" />,
      pose: "chat",
      description: t("productTour.tools.description"),
      arrow: "bottom",
      bubblePlacement: {
        anchorId: PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
        side: "inside",
        blockAlign: "start",
        inlineAlign: "end",
        offsetX: 4,
        offsetY: 4
      },
      highlight: {
        anchorId: PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
        padding: { top: 16, left: 16 },
        viewportBottom: 16
      },
      extraHighlights: [
        { anchorId: PRODUCT_TOUR_TOOLS_NAV_ANCHOR }
      ]
    }
  ];
}

/** Contract for product tour guide props. */
export interface ProductTourGuideProps {
  onDismiss: () => void;
  onTabChange: (tab: ProductTourTab) => void;
}

/** Handles product tour guide. */
export function ProductTourGuide(props: ProductTourGuideProps) {
  const { onDismiss, onTabChange } = props;
  const { t } = useTranslation();
  const steps = useMemo(() => createProductTourSteps(t) as [ProductTourStep, ...ProductTourStep[]], [t]);
  const [step, setStep] = useState(() =>
    readProductTourStep(typeof window === "undefined" ? undefined : window.sessionStorage) ?? 0
  );
  const current = steps[Math.min(step, steps.length - 1)]!;
  const [layout, setLayout] = useState(() => null as ReturnType<typeof resolveProductTourStepLayout>);

  useEffect(() => {
    onTabChange(current.tab);
  }, [current, onTabChange]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      setLayout(null);
      return undefined;
    }

    const lookup = createDomProductTourAnchorLookup(document);
    const extraIds = (current.extraHighlights ?? []).map((h) => h.anchorId);
    const anchorIds = [...new Set([current.highlight.anchorId, ...extraIds, current.bubblePlacement.anchorId])];
    let frame = 0;
    let resizeObserver: ResizeObserver | undefined;

    /** Definition for measure layout. */
    const measureLayout = () => {
      setLayout(resolveProductTourStepLayout(current.highlight, current.bubblePlacement, lookup, current.extraHighlights));
      if (typeof ResizeObserver === "undefined") {
        return;
      }

      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(scheduleMeasurement);
      anchorIds.forEach((anchorId) => {
        const element = document.querySelector<HTMLElement>(`[data-tour-anchor="${anchorId}"]`);
        if (element) {
          resizeObserver?.observe(element);
        }
      });
    };

    /** Definition for schedule measurement. */
    const scheduleMeasurement = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measureLayout);
    };

    const mutationObserver = new MutationObserver(scheduleMeasurement);
    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-tour-anchor", "style"],
      childList: true,
      subtree: true
    });

    setLayout(null);
    scheduleMeasurement();
    window.addEventListener("resize", scheduleMeasurement);
    window.addEventListener("scroll", scheduleMeasurement, true);

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasurement);
      window.removeEventListener("scroll", scheduleMeasurement, true);
      window.cancelAnimationFrame(frame);
    };
  }, [current]);

  if (!layout) {
    return null;
  }

  const isLast = step === steps.length - 1;

  /** Handles go next. */
  function goNext() {
    if (isLast) {
      onTabChange("chat");
      onDismiss();
      return;
    }

    setStep((value) => {
      const next = value + 1;
      writeProductTourStep(typeof window === "undefined" ? undefined : window.sessionStorage, next);
      return next;
    });
  }

  /** Handles handle dismiss. */
  function handleDismiss() {
    onTabChange("chat");
    onDismiss();
  }

  const animationClass =
    current.arrow === "left" || current.arrow === "right"
      ? "animate-in fade-in slide-in-from-left-2"
      : current.arrow === "bottom"
        ? "animate-in fade-in slide-in-from-bottom-2"
        : "animate-in fade-in slide-in-from-top-2";

  const allHighlights = [layout.highlight, ...layout.extraHighlights];
  const maskId = `tour-mask-${step}`;

  return (
    <>
      <svg
        key={`spot-${step}`}
        className="fixed inset-0 z-40 pointer-events-none"
        width="100%"
        height="100%"
        style={{ width: "100vw", height: "100vh" }}
      >
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {allHighlights.map((h, i) => (
              <rect
                key={i}
                x={h.left}
                y={h.top}
                width={h.width}
                height={h.height}
                rx="12"
                ry="12"
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.5)" mask={`url(#${maskId})`} />
      </svg>

      <div className={`fixed z-50 ${animationClass}`} key={step} style={layout.bubblePosition}>
        <div className="bg-background-paper rounded-card shadow-xl border border-border-stone/30 p-5 w-72 relative">
          <div className="absolute -top-8 -right-2 pointer-events-none">
            <Memmy pose={current.pose} size={60} />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold text-action-sky bg-action-sky/10 px-2 py-0.5 rounded-tag">
                {step + 1}/{steps.length}
              </span>
              {current.icon}
              <span className="text-sm font-semibold text-text-ink">{current.title}</span>
            </div>
            <p className="text-xs text-text-ink/70 leading-relaxed">{current.description}</p>
          </div>

          <div className="flex items-center justify-between mt-4 pt-3 border-t border-border-stone/20">
            <button
              type="button"
              onClick={handleDismiss}
              className="text-xs text-text-ink/45 hover:text-text-ink/65 cursor-pointer transition-colors"
            >
              {t("productTour.skip")}
            </button>
            <button
              type="button"
              onClick={goNext}
              className="px-4 py-1.5 text-xs font-normal text-white bg-action-sky rounded-btn hover:bg-action-sky-hover cursor-pointer transition-all shadow-sm"
            >
              {isLast ? t("productTour.start") : t("productTour.next")}
            </button>
          </div>

          {current.arrow === "left" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-l border-b border-border-stone/30 transform -rotate-45"
              style={{ left: "-6px", top: "22px" }}
            />
          )}

          {current.arrow === "right" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-r border-b border-border-stone/30 transform rotate-45"
              style={{ right: "-6px", top: "22px" }}
            />
          )}

          {current.arrow === "top" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-l border-t border-border-stone/30 transform rotate-45"
              style={{ top: "-6px", left: "28px" }}
            />
          )}

          {current.arrow === "bottom" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-r border-b border-border-stone/30 transform rotate-45"
              style={{ bottom: "-6px", left: "28px" }}
            />
          )}
        </div>
      </div>
    </>
  );
}
