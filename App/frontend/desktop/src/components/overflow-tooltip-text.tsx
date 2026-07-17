/** Overflow-aware tooltip text module. */
import { useEffect, useRef, useState } from "react";
import { Tooltip } from "./tooltip.js";

/**
 * Renders text in a single truncated line and shows the full value in a tooltip only when it
 * actually overflows. Shared by the settings page and the API key form fields so the truncation +
 * hover-to-read behavior stays consistent.
 *
 * @param props.className The span class names (should include a truncation utility).
 * @param props.text The full text to render and reveal on overflow.
 * @returns The text span, wrapped in a tooltip when truncated.
 */
export function OverflowTooltipText(props: { className: string; text: string }) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const element = textRef.current;
    if (!element) {
      return;
    }

    const updateOverflowState = () => {
      setIsOverflowing(element.scrollWidth > element.clientWidth + 1);
    };

    updateOverflowState();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflowState);
      return () => window.removeEventListener("resize", updateOverflowState);
    }

    const observer = new ResizeObserver(updateOverflowState);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.text, isOverflowing]);

  const content = (
    <span
      className={props.className}
      ref={textRef}
      tabIndex={isOverflowing ? 0 : undefined}
      aria-label={isOverflowing ? props.text : undefined}
    >
      {props.text}
    </span>
  );

  return isOverflowing ? <Tooltip content={props.text}>{content}</Tooltip> : content;
}
