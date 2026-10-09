import type { MemoryTokenBudgetDto } from "@memmy/local-api-contracts";
import { AlertTriangle, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/use-translation.js";

const DISMISSED_EPISODE_STORAGE_KEY = "memmy.memory-token-budget-banner.dismissed";

let lastPublishedBudget: MemoryTokenBudgetDto | null = null;

export interface MemoryTokenBudgetBannerProps {
  budget?: MemoryTokenBudgetDto | null;
  onOpenSettings?: () => void;
}

export function memoryTokenBudgetPauseEpisode(budget: MemoryTokenBudgetDto): string | null {
  if (!budget.paused || budget.trigger == null) {
    return null;
  }
  return `${budget.trigger}:${budget.nextLocalMidnightAt}:${budget.dailyLimitM}:${budget.totalLimitM}`;
}

/** Keeps the latest budget across page remounts so a known pause does not flicker away. */
export function rememberPublishedMemoryBudget(budget: MemoryTokenBudgetDto | null): void {
  lastPublishedBudget = budget;
}

export function MemoryTokenBudgetBanner(props: MemoryTokenBudgetBannerProps) {
  const { t } = useTranslation();
  const budget = usePublishedMemoryBudget(props.budget);
  const episode = budget ? memoryTokenBudgetPauseEpisode(budget) : null;
  const [dismissedEpisode, setDismissedEpisode] = useState(readDismissedEpisode);
  const [capsuleNode, setCapsuleNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!budget || memoryTokenBudgetPauseEpisode(budget) != null) {
      return;
    }
    clearDismissedEpisode();
    setDismissedEpisode(null);
  }, [budget]);

  if (!budget?.paused || episode == null || dismissedEpisode === episode) {
    return null;
  }

  const title = t(budget.trigger === "daily" ? "memory.tokenBudget.capsuleDaily" : "memory.tokenBudget.capsuleTotal");

  const openSettings = () => {
    props.onOpenSettings?.();
  };

  const dismiss = () => {
    writeDismissedEpisode(episode);
    setDismissedEpisode(episode);
  };

  return (
    <div
      ref={setCapsuleNode}
      className="memory-token-budget-capsule"
      onClick={(event) => {
        if (isCapsuleCloseTarget(event)) {
          return;
        }
        openSettings();
      }}
    >
      {capsuleNode ? <CapsuleWindowDragExclusion anchor={capsuleNode} /> : null}
      <button
        type="button"
        className="memory-token-budget-capsule__open"
        aria-label={title}
        onClick={(event) => {
          event.stopPropagation();
          openSettings();
        }}
      >
        <AlertTriangle size={14} strokeWidth={2.2} aria-hidden="true" />
        <span className="memory-token-budget-capsule__title">{title}</span>
      </button>
      <button
        type="button"
        className="memory-token-budget-capsule__close"
        aria-label={t("common.close")}
        onClick={(event) => {
          event.stopPropagation();
          dismiss();
        }}
      >
        <X size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}

function usePublishedMemoryBudget(override?: MemoryTokenBudgetDto | null): MemoryTokenBudgetDto | null {
  const [budget, setBudget] = useState<MemoryTokenBudgetDto | null>(
    override !== undefined ? override : lastPublishedBudget
  );
  useEffect(() => {
    if (override !== undefined) {
      setBudget(override);
      return undefined;
    }
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<MemoryTokenBudgetDto>).detail;
      if (detail && typeof detail.paused === "boolean") {
        rememberPublishedMemoryBudget(detail);
        setBudget(detail);
      }
    };
    setBudget(lastPublishedBudget);
    window.addEventListener("memmy:memory-token-budget-updated", onUpdated);
    window.dispatchEvent(new CustomEvent("memmy:memory-token-budget-refresh"));
    return () => window.removeEventListener("memmy:memory-token-budget-updated", onUpdated);
  }, [override]);
  return override !== undefined ? override : budget;
}

function CapsuleWindowDragExclusion(props: { anchor: HTMLElement }) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }

    const sync = () => {
      const rect = props.anchor.getBoundingClientRect();
      setBox({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      });
    };

    sync();
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(props.anchor);
    const topbar = props.anchor.closest(".app-frame-content-topbar");
    if (topbar instanceof HTMLElement) {
      resizeObserver.observe(topbar);
      topbar.addEventListener("transitionend", sync);
    }
    const mutationObserver = new MutationObserver(sync);
    const main = props.anchor.closest(".app-frame-main");
    if (main) {
      mutationObserver.observe(main, { attributes: true, attributeFilter: ["class", "style"] });
    }
    mutationObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", sync);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", sync);
      if (topbar instanceof HTMLElement) {
        topbar.removeEventListener("transitionend", sync);
      }
    };
  }, [props.anchor]);

  if (!box || box.width <= 0 || box.height <= 0 || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      aria-hidden="true"
      className="window-drag-exclusion window-drag-exclusion--memory-budget-capsule"
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    />,
    document.body
  );
}

function isCapsuleCloseTarget(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element
    && event.target.closest(".memory-token-budget-capsule__close") != null;
}

function readDismissedEpisode(): string | null {
  try {
    return sessionStorage.getItem(DISMISSED_EPISODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissedEpisode(episode: string): void {
  try {
    sessionStorage.setItem(DISMISSED_EPISODE_STORAGE_KEY, episode);
  } catch {
    return;
  }
}

function clearDismissedEpisode(): void {
  try {
    sessionStorage.removeItem(DISMISSED_EPISODE_STORAGE_KEY);
  } catch {
    return;
  }
}
