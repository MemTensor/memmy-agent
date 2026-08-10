/** Product tour module. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScanPermission } from "@memmy/local-api-contracts";
import { FileText, PlugZap, Settings2 } from "lucide-react";
import { Memmy, type MemmyPose } from "../components/mascot/memmy.js";
import { zhCNMessages, type MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { BrainCircuit, Link2 } from "../pages/memory/memory-prototype-icons.js";
import {
  createDomProductTourAnchorLookup,
  PRODUCT_TOUR_MEMORY_AGENTS_LIST_ANCHOR,
  PRODUCT_TOUR_MEMORY_LOGS_LIST_ANCHOR,
  PRODUCT_TOUR_MEMORY_LOGS_NAV_ANCHOR,
  PRODUCT_TOUR_MEMORY_OVERVIEW_COUNTS_ANCHOR,
  PRODUCT_TOUR_MEMORY_OVERVIEW_NAV_ANCHOR,
  PRODUCT_TOUR_MEMORY_SCAN_PREFERENCES_ANCHOR,
  PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR,
  PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
  PRODUCT_TOUR_TOOLS_NAV_ANCHOR,
  resolveProductTourStepLayout,
  scrollProductTourHighlightIntoView,
  type ProductTourBubblePlacement,
  type ProductTourHighlightSpec
} from "./product-tour-layout.js";
import { readProductTourStep, writeProductTourStep, type AppRoutePath } from "./routes.js";

/** Type definition for product tour tab. */
export type ProductTourTab = "logs" | "agents" | "agentsScan" | "overview" | "tools" | "chat" | "settings";

/** Handles product tour tab route. */
export function productTourTabRoute(tab: ProductTourTab): AppRoutePath {
  switch (tab) {
    case "tools":
      return "/tools";
    case "settings":
      return "/settings";
    case "agents":
    case "agentsScan":
      return "/memory-sources";
    case "logs":
    case "overview":
      return "/memory";
    case "chat":
    default:
      return "/main";
  }
}

/** Memory sub-page keyed by tour tab, when the route is /memory. */
export function productTourMemorySubPage(tab: ProductTourTab): "logs" | "overview" | "sources" | null {
  switch (tab) {
    case "logs":
      return "logs";
    case "overview":
      return "overview";
    case "agents":
    case "agentsScan":
      return "sources";
    default:
      return null;
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

export interface CreateProductTourStepsOptions {
  /** When false, skip the memory-logs step (deny-scan / 4-step tour). Defaults to true. */
  includeLogs?: boolean;
}

/** Scan permission that earned a first-encounter report → keep the logs tour step. */
export function productTourIncludesLogs(scanPermission: ScanPermission | undefined | null): boolean {
  return scanPermission === "scan_only" || scanPermission === "scan_and_write_skill";
}

/** First route when opening the deferred product tour. */
export function productTourStartRoute(includeLogs: boolean): AppRoutePath {
  return includeLogs ? "/memory" : "/memory-sources";
}

/** Memory sub-page to arm before the first tour step (null when starting on /memory-sources). */
export function productTourStartMemorySubPage(includeLogs: boolean): "logs" | "sources" {
  return includeLogs ? "logs" : "sources";
}

export const productTourSteps: ProductTourStep[] = createProductTourSteps((key) => zhCNMessages[key]);

/** Creates create product tour steps. */
export function createProductTourSteps(
  t: (key: MessageKey) => string,
  options: CreateProductTourStepsOptions = {}
): ProductTourStep[] {
  const includeLogs = options.includeLogs ?? true;
  const steps: ProductTourStep[] = [
    {
      tab: "logs",
      title: t("onboarding.featureDig.logs.title"),
      icon: <FileText size={15} className="text-action-sky" />,
      pose: "brain",
      description: t("onboarding.featureDig.logs.description"),
      arrow: "top",
      bubblePlacement: {
        // Sit just under the lit log rows and point up at them.
        anchorId: PRODUCT_TOUR_MEMORY_LOGS_LIST_ANCHOR,
        side: "below",
        align: "start",
        gap: 12
      },
      highlight: {
        anchorId: PRODUCT_TOUR_MEMORY_LOGS_LIST_ANCHOR,
        padding: { top: 4, right: 6, bottom: 4, left: 6 }
      },
      extraHighlights: [
        { anchorId: PRODUCT_TOUR_MEMORY_LOGS_NAV_ANCHOR, padding: { top: 4, right: 4, bottom: 4, left: 4 } }
      ]
    },
    {
      tab: "agents",
      title: t("onboarding.featureDig.agents.title"),
      icon: <PlugZap size={15} className="text-action-sky" />,
      pose: "chat",
      description: t("onboarding.featureDig.agents.description"),
      arrow: "left",
      bubblePlacement: {
        anchorId: PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR,
        side: "right",
        align: "center",
        gap: 12
      },
      highlight: {
        anchorId: PRODUCT_TOUR_MEMORY_AGENTS_LIST_ANCHOR,
        padding: { top: 8, right: 8, bottom: 8, left: 8 },
        viewportBottom: 24
      },
      extraHighlights: [
        { anchorId: PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR, padding: { top: 4, right: 4, bottom: 4, left: 4 } }
      ]
    },
    {
      tab: "agentsScan",
      title: t("onboarding.featureDig.agentsScan.title"),
      icon: <Settings2 size={15} className="text-action-sky" />,
      pose: "chat",
      description: t("onboarding.featureDig.agentsScan.description"),
      arrow: "left",
      // Nav-anchored right placement; layout parks near the Auto sync mask when
      // the preferred nav slot does not sit next to the spotlight.
      bubblePlacement: {
        anchorId: PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR,
        side: "right",
        align: "center",
        gap: 12
      },
      highlight: {
        anchorId: PRODUCT_TOUR_MEMORY_SCAN_PREFERENCES_ANCHOR,
        padding: { top: 8, right: 8, bottom: 8, left: 8 }
      },
      extraHighlights: [
        { anchorId: PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR, padding: { top: 4, right: 4, bottom: 4, left: 4 } }
      ]
    },
    {
      tab: "overview",
      title: t("onboarding.featureDig.memory.title"),
      icon: <BrainCircuit size={15} className="text-action-sky" />,
      pose: "brain",
      description: t("onboarding.featureDig.memory.description"),
      arrow: "left",
      bubblePlacement: {
        anchorId: PRODUCT_TOUR_MEMORY_OVERVIEW_NAV_ANCHOR,
        side: "right",
        align: "center",
        gap: 12
      },
      highlight: {
        anchorId: PRODUCT_TOUR_MEMORY_OVERVIEW_COUNTS_ANCHOR,
        padding: { top: 8, right: 8, bottom: 8, left: 8 }
      },
      extraHighlights: [
        { anchorId: PRODUCT_TOUR_MEMORY_OVERVIEW_NAV_ANCHOR, padding: { top: 4, right: 4, bottom: 4, left: 4 } }
      ]
    },
    {
      tab: "tools",
      title: t("productTour.tools.title"),
      icon: <Link2 size={15} className="text-action-sky" />,
      pose: "chat",
      description: t("productTour.tools.description"),
      arrow: "left",
      bubblePlacement: {
        anchorId: PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
        side: "inside",
        blockAlign: "start",
        inlineAlign: "end",
        offsetX: 16,
        offsetY: 16
      },
      highlight: {
        anchorId: PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
        padding: { top: 16, left: 16 },
        viewportBottom: 16
      },
      extraHighlights: [
        { anchorId: PRODUCT_TOUR_TOOLS_NAV_ANCHOR, padding: { top: 4, right: 4, bottom: 4, left: 4 } }
      ]
    }
  ];
  return includeLogs ? steps : steps.filter((step) => step.tab !== "logs");
}

export type ProductTourDismissResult = "completed" | "skipped";

export interface ProductTourStepInfo {
  tourStep: number;
  tourStepCount: number;
  tourTab: ProductTourTab;
}

/** Contract for product tour guide props. */
export interface ProductTourGuideProps {
  onDismiss: (result: ProductTourDismissResult, info: ProductTourStepInfo) => void;
  onTabChange: (tab: ProductTourTab) => void;
  /** Fired once per step when the bubble layout is ready. */
  onStepViewed?: (info: ProductTourStepInfo) => void;
  /** Deny-scan tours omit the logs step (4/4). Defaults to true (5/5). */
  includeLogs?: boolean;
}

/** Handles product tour guide. */
export function ProductTourGuide(props: ProductTourGuideProps) {
  const { onDismiss, onTabChange, onStepViewed, includeLogs = true } = props;
  const { t } = useTranslation();
  const steps = useMemo(
    () => createProductTourSteps(t, { includeLogs }) as [ProductTourStep, ...ProductTourStep[]],
    [includeLogs, t]
  );
  const [step, setStep] = useState(() =>
    readProductTourStep(typeof window === "undefined" ? undefined : window.sessionStorage) ?? 0
  );
  const current = steps[Math.min(step, steps.length - 1)]!;
  const [layout, setLayout] = useState(() => null as ReturnType<typeof resolveProductTourStepLayout>);
  const lastViewedStepKeyRef = useRef<string | null>(null);

  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;
  const onStepViewedRef = useRef(onStepViewed);
  onStepViewedRef.current = onStepViewed;

  useEffect(() => {
    onTabChangeRef.current(current.tab);
  }, [current.tab]);

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

    const highlightElement = document.querySelector<HTMLElement>(`[data-tour-anchor="${current.highlight.anchorId}"]`);
    if (highlightElement) {
      // Tall page-top anchors (agents list / overview cards / logs) must not be
      // centered — that hides the section title. Scan prefs sit near the page
      // bottom: scroll the pane to its end so Auto sync is fully on-screen before
      // spotlight/bubble measurement. Tools only needs nearest.
      const scrollMode = current.tab === "agentsScan"
        ? "page-end"
        : current.tab === "tools"
          ? "nearest"
          : "page-start";
      scrollProductTourHighlightIntoView(highlightElement, scrollMode);
    }

    setLayout(null);
    // Measure after the (instant) scroll so highlight/bubble use final geometry.
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

  useEffect(() => {
    if (!layout) {
      return;
    }
    const key = `${step}:${current.tab}:${steps.length}`;
    if (lastViewedStepKeyRef.current === key) {
      return;
    }
    lastViewedStepKeyRef.current = key;
    onStepViewedRef.current?.({
      tourStep: step + 1,
      tourStepCount: steps.length,
      tourTab: current.tab
    });
  }, [layout, step, current.tab, steps.length]);

  if (!layout) {
    return null;
  }

  const isLast = step === steps.length - 1;
  const stepInfo: ProductTourStepInfo = {
    tourStep: step + 1,
    tourStepCount: steps.length,
    tourTab: current.tab
  };

  /** Handles go next. */
  function goNext() {
    if (isLast) {
      // Dismiss owns navigation to /main; calling onTabChange("chat") first races
      // with the still-mounted tools step and can bounce back to /tools.
      onDismiss("completed", stepInfo);
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
    onDismiss("skipped", stepInfo);
  }

  const arrow = layout.arrow;
  const animationClass =
    arrow === "left" || arrow === "right"
      ? "animate-in fade-in slide-in-from-left-2"
      : arrow === "bottom"
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
              {isLast
                ? (includeLogs ? t("onboarding.featureDig.startChat") : t("productTour.start"))
                : t("productTour.next")}
            </button>
          </div>

          {arrow === "left" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-l border-b border-border-stone/30 -rotate-45"
              style={{ left: "-6px", top: "50%", marginTop: "-6px" }}
            />
          )}

          {arrow === "right" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-r border-b border-border-stone/30 rotate-45"
              style={{ right: "-6px", top: "50%", marginTop: "-6px" }}
            />
          )}

          {arrow === "top" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-l border-t border-border-stone/30 rotate-45"
              style={{ top: "-6px", left: "28px" }}
            />
          )}

          {arrow === "bottom" && (
            <div
              className="absolute w-3 h-3 bg-background-paper border-r border-b border-border-stone/30 rotate-45"
              style={{ bottom: "-6px", left: "28px" }}
            />
          )}
        </div>
      </div>
    </>
  );
}
