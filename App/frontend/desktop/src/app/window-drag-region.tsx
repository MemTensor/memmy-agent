import { useLayoutEffect, useState, type CSSProperties } from "react";

export const KNOWLEDGE_CREATE_DRAG_EXCLUSION_SELECTOR =
  '[data-window-drag-exclusion="knowledge-create"]';
export const KNOWLEDGE_DRAG_EXCLUSION_SELECTOR =
  '[data-window-drag-exclusion^="knowledge-"]';
export const THREAD_DRAG_EXCLUSION_SELECTOR =
  '[data-window-drag-exclusion^="thread-"]';
export const WINDOWS_TITLEBAR_DRAG_EXCLUSION_SELECTOR =
  '[data-window-drag-exclusion="windows-titlebar"]';

/** Keeps the Windows titlebar controls clickable on every route. */
export function resolveObservedWindowDragExclusionSelector(dynamicSelector: string | undefined): string {
  return dynamicSelector
    ? `${dynamicSelector}, ${WINDOWS_TITLEBAR_DRAG_EXCLUSION_SELECTOR}`
    : WINDOWS_TITLEBAR_DRAG_EXCLUSION_SELECTOR;
}

export interface WindowDragRegionProps {
  dynamicExclusionSelector?: string;
}

interface WindowDragExclusionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function sameRects(
  current: WindowDragExclusionRect[],
  next: WindowDragExclusionRect[]
): boolean {
  return current.length === next.length
    && current.every((rect, index) => {
      const nextRect = next[index];
      return Boolean(
        nextRect
        && rect.left === nextRect.left
        && rect.top === nextRect.top
        && rect.width === nextRect.width
        && rect.height === nextRect.height
      );
    });
}

export function resolveWindowDragExclusionSelector(path: string): string | undefined {
  if (path === "/knowledge") return KNOWLEDGE_DRAG_EXCLUSION_SELECTOR;
  if (path === "/main") return THREAD_DRAG_EXCLUSION_SELECTOR;
  return undefined;
}

/**
 * Renders the native window drag strip and any root-level no-drag exclusions.
 *
 * Electron does not use normal CSS stacking to resolve overlapping app regions.
 * Interactive controls beneath this root drag strip therefore need a matching
 * root-level exclusion, rather than only `app-region: no-drag` on the control.
 */
export function WindowDragRegion(props: WindowDragRegionProps) {
  const [dynamicExclusions, setDynamicExclusions] = useState<WindowDragExclusionRect[]>([]);

  useLayoutEffect(() => {
    const selector = resolveObservedWindowDragExclusionSelector(props.dynamicExclusionSelector);

    let animationFrame = 0;
    let observedTargets: Element[] = [];
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => scheduleSync());

    const observeTargets = (targets: Element[]) => {
      if (
        targets.length === observedTargets.length
        && targets.every((target, index) => target === observedTargets[index])
      ) return;
      observedTargets = targets;
      resizeObserver?.disconnect();
      const elements = new Set<Element>();
      targets.forEach((target) => {
        let current: Element | null = target;
        while (current && current !== document.body) {
          elements.add(current);
          current = current.parentElement;
        }
      });
      for (const element of elements) {
        resizeObserver?.observe(element);
      }
    };

    const sync = () => {
      animationFrame = 0;
      const targets = Array.from(document.querySelectorAll<HTMLElement>(selector));
      observeTargets(targets);
      const next = targets.flatMap((target) => {
        const rect = target.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          ? [{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height
            }]
          : [];
      });
      setDynamicExclusions((current) => (sameRects(current, next) ? current : next));
    };

    function scheduleSync() {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(sync);
    }

    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(scheduleSync);
    mutationObserver?.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", scheduleSync);
    sync();

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
    };
  }, [props.dynamicExclusionSelector]);

  return (
    <>
      <div aria-hidden="true" className="window-drag-region" />
      <div aria-hidden="true" className="window-drag-exclusion window-drag-exclusion--sidebar-toggle" />
      <div aria-hidden="true" className="window-drag-exclusion window-drag-exclusion--lang-toggle" />
      {dynamicExclusions.map((rect, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="window-drag-exclusion window-drag-exclusion--dynamic"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          } satisfies CSSProperties}
        />
      ))}
    </>
  );
}
