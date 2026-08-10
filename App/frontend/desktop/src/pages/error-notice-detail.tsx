import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function ErrorNoticeDetail(props: {
  children: ReactNode;
  showLabel: string;
  hideLabel: string;
}) {
  const detailId = useId();
  const [expanded, setExpanded] = useState(true);
  const shellRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const heightAnimationRef = useRef<Animation | null>(null);
  const contentAnimationRef = useRef<Animation | null>(null);

  useEffect(() => () => {
    heightAnimationRef.current?.cancel();
    contentAnimationRef.current?.cancel();
  }, []);

  const toggle = async () => {
    const shell = shellRef.current;
    const panel = panelRef.current;
    if (!shell || !panel) return;

    const collapsing = expanded;
    const currentHeight = shell.hidden ? 0 : shell.getBoundingClientRect().height;
    const currentOpacity = Number.parseFloat(getComputedStyle(panel).opacity) || 0;
    heightAnimationRef.current?.cancel();
    contentAnimationRef.current?.cancel();
    if (!collapsing) shell.hidden = false;
    setExpanded(!collapsing);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof shell.animate !== "function") {
      shell.hidden = collapsing;
      return;
    }

    const animation = shell.animate([
      { height: `${currentHeight}px` },
      { height: `${collapsing ? 0 : shell.scrollHeight}px` }
    ], {
      duration: collapsing ? 200 : 240,
      easing: collapsing ? "cubic-bezier(0.4, 0, 1, 1)" : "cubic-bezier(0, 0, 0.2, 1)",
      fill: "both"
    });
    const fade = panel.animate([
      { opacity: currentOpacity },
      { opacity: collapsing ? 0 : 1 }
    ], {
      duration: collapsing ? 110 : 160,
      easing: "linear",
      fill: "both"
    });
    heightAnimationRef.current = animation;
    contentAnimationRef.current = fade;

    try {
      await animation.finished;
    } catch {
      return;
    }
    if (heightAnimationRef.current !== animation) return;
    shell.hidden = collapsing;
    animation.cancel();
    fade.cancel();
    heightAnimationRef.current = null;
    contentAnimationRef.current = null;
  };

  return (
    <>
      <div
        id={detailId}
        ref={shellRef}
        className="error-notice-detail__shell"
        aria-hidden={!expanded}
      >
        <div className="error-notice-detail__gap">
          <div ref={panelRef} className="error-notice-detail__panel">
            {props.children}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="error-notice-detail__toggle"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => void toggle()}
      >
        <span>{expanded ? props.hideLabel : props.showLabel}</span>
        <ChevronDown className="error-notice-detail__chevron" size={16} aria-hidden="true" />
      </button>
    </>
  );
}
