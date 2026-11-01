import { useLayoutEffect, useRef, type RefObject } from "react";

/** Include the gap below a fixed card so the waiting line stays above it. */
export function waitingCardOverlayHeight(panelBottom: number, cardTop: number): number {
  return Math.ceil(Math.max(0, panelBottom - cardTop) + 16);
}

export function useQuestionDockLayout(options: {
  panelRef: RefObject<HTMLElement | null>;
  composerRef: RefObject<HTMLElement | null>;
  questionDock: HTMLElement | null;
  pendingKey: string | null;
  scopeKey: string;
  followingRef: { current: boolean };
  scrollToLatest(): void;
}) {
  const previousKey = useRef<string | null>(null);
  const scroll = useRef(options.scrollToLatest);
  scroll.current = options.scrollToLatest;
  useLayoutEffect(() => {
    if (options.pendingKey && previousKey.current !== options.pendingKey) options.followingRef.current = true;
    previousKey.current = options.pendingKey;
    const panel = options.panelRef.current;
    const composer = options.composerRef.current;
    if (!panel || !composer) return;
    if (!options.pendingKey) { panel.style.removeProperty("--agent-question-overlay-height"); return; }
    const pluginDock = composer.querySelector<HTMLElement>(".agent-confirmation-dock");
    let previousHeight = -1;
    const measure = () => {
      const candidates = [options.questionDock?.firstElementChild,
        pluginDock?.querySelector(".plugin-capability-region--pinned"),
        composer.querySelector(".agent-queue-panel")];
      const tops = candidates.filter((card): card is Element => card instanceof Element)
        .map((card) => card.getBoundingClientRect()).filter((rect) => rect.height > 0).map((rect) => rect.top);
      const height = options.pendingKey && tops.length
        ? waitingCardOverlayHeight(panel.getBoundingClientRect().bottom, Math.min(...tops)) : 0;
      if (Math.abs(height - previousHeight) < 2) return;
      previousHeight = height;
      if (height) panel.style.setProperty("--agent-question-overlay-height", `${height}px`);
      else panel.style.removeProperty("--agent-question-overlay-height");
      if (options.followingRef.current) scroll.current();
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    for (const element of [panel, composer, options.questionDock, pluginDock]) if (element) observer?.observe(element);
    const mutations = typeof MutationObserver !== "undefined" ? new MutationObserver(measure) : null;
    for (const element of [options.questionDock, pluginDock]) if (element) mutations?.observe(element, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect(); mutations?.disconnect(); window.removeEventListener("resize", measure);
      panel.style.removeProperty("--agent-question-overlay-height");
    };
  }, [options.pendingKey, options.scopeKey, options.questionDock, options.panelRef, options.composerRef, options.followingRef]);
}
