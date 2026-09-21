import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

type TooltipPlacement = "top" | "bottom";
type TooltipVariant = "default" | "description";

type TooltipTriggerProps = {
  "aria-describedby"?: string;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
};

const tooltipId = "app-tooltip-singleton";

let tooltipElement: HTMLSpanElement | null = null;
let tooltipRoot: Root | null = null;
let activeTrigger: HTMLElement | null = null;
let listenersAttached = false;

export function Tooltip(props: { content: ReactNode; children: ReactElement<TooltipTriggerProps>; openOnClick?: boolean; variant?: TooltipVariant }) {
  const triggerRef = useRef<HTMLElement | null>(null);

  function show() {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    activeTrigger = trigger;
    renderTooltip(props.content, props.variant);
    positionTooltip(trigger, props.variant);
    attachGlobalListeners();
  }

  function hide() {
    if (activeTrigger === triggerRef.current) {
      hideActiveTooltip();
    }
  }

  useEffect(() => {
    const trigger = triggerRef.current;
    return () => {
      if (activeTrigger === trigger) {
        hideActiveTooltip();
      }
    };
  }, []);

  if (!isValidElement(props.children)) {
    return props.children;
  }

  const childProps = props.children.props;

  return cloneElement(props.children, {
    "aria-describedby": [childProps["aria-describedby"], tooltipId].filter(Boolean).join(" "),
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      if (typeof childProps.ref === "function") {
        childProps.ref(node);
      } else if (childProps.ref && "current" in childProps.ref && childProps.ref.current !== node) {
        childProps.ref.current = node;
      }
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      hide();
      childProps.onBlur?.(event);
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (props.openOnClick) {
        event.currentTarget.focus();
        show();
      } else {
        hideActiveTooltip();
      }
      childProps.onClick?.(event);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (props.openOnClick && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
      childProps.onKeyDown?.(event);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      show();
      childProps.onFocus?.(event);
    },
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      show();
      childProps.onMouseEnter?.(event);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      if (!props.openOnClick || document.activeElement !== event.currentTarget) hide();
      childProps.onMouseLeave?.(event);
    }
  });
}

function ensureTooltipElement(): HTMLSpanElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  if (tooltipElement) {
    if (!tooltipElement.isConnected) document.body.appendChild(tooltipElement);
    return tooltipElement;
  }

  tooltipElement = document.createElement("span");
  tooltipElement.id = tooltipId;
  tooltipElement.setAttribute("role", "tooltip");
  tooltipElement.setAttribute("aria-hidden", "true");
  tooltipElement.className = "app-tooltip app-tooltip--top app-tooltip--hidden";
  document.body.appendChild(tooltipElement);
  tooltipRoot = createRoot(tooltipElement);

  return tooltipElement;
}

function renderTooltip(content: ReactNode, variant: TooltipVariant = "default") {
  const element = ensureTooltipElement();
  if (!element || !tooltipRoot) {
    return;
  }

  element.classList.toggle("app-tooltip--description", variant === "description");
  flushSync(() => {
    tooltipRoot?.render(<>{content}</>);
  });
  element.classList.remove("app-tooltip--hidden", "app-tooltip--top", "app-tooltip--bottom");
  element.setAttribute("aria-hidden", "false");
}

function positionTooltip(trigger: HTMLElement, variant: TooltipVariant = "default") {
  const element = ensureTooltipElement();
  if (!element || typeof window === "undefined") {
    return;
  }

  const rect = trigger.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 8;
  const tooltipRect = element.getBoundingClientRect();
  const tooltipWidth = tooltipRect.width;
  const tooltipHeight = tooltipRect.height;
  const topSpace = rect.top - viewportPadding;
  const bottomSpace = window.innerHeight - rect.bottom - viewportPadding;
  const placement: TooltipPlacement = variant === "description" && bottomSpace >= tooltipHeight + gap
    ? "bottom" : topSpace >= tooltipHeight + gap || topSpace >= bottomSpace ? "top" : "bottom";
  const centeredLeft = rect.left + rect.width / 2;
  const preferredLeft = variant === "description" ? rect.left - 12 + tooltipWidth / 2 : centeredLeft;
  const left = Math.min(
    Math.max(preferredLeft, viewportPadding + tooltipWidth / 2),
    window.innerWidth - viewportPadding - tooltipWidth / 2
  );
  const top = placement === "top"
    ? Math.max(rect.top - gap, viewportPadding + tooltipHeight)
    : Math.min(rect.bottom + gap, window.innerHeight - viewportPadding - tooltipHeight);
  const arrowLeft = Math.min(Math.max(centeredLeft - left + tooltipWidth / 2, 10), tooltipWidth - 10);

  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.setProperty("--app-tooltip-arrow-left", `${arrowLeft}px`);
  element.classList.add(`app-tooltip--${placement}`);
}

function hideActiveTooltip() {
  activeTrigger = null;
  tooltipElement?.classList.add("app-tooltip--hidden");
  tooltipElement?.setAttribute("aria-hidden", "true");
  detachGlobalListeners();
}

function attachGlobalListeners() {
  if (typeof window === "undefined" || listenersAttached) {
    return;
  }

  listenersAttached = true;
  window.addEventListener("scroll", hideActiveTooltip, true);
  window.addEventListener("resize", hideActiveTooltip);
  window.addEventListener("pointerdown", hideTooltipOnOutsidePress, true);
  window.addEventListener("keydown", hideTooltipOnEscape);
}

function hideTooltipOnOutsidePress(event: PointerEvent) {
  if (event.target instanceof Node && !activeTrigger?.contains(event.target)) hideActiveTooltip();
}

function hideTooltipOnEscape(event: globalThis.KeyboardEvent) {
  if (event.key === "Escape") hideActiveTooltip();
}

function detachGlobalListeners() {
  if (typeof window === "undefined" || !listenersAttached) {
    return;
  }

  listenersAttached = false;
  window.removeEventListener("scroll", hideActiveTooltip, true);
  window.removeEventListener("resize", hideActiveTooltip);
  window.removeEventListener("pointerdown", hideTooltipOnOutsidePress, true);
  window.removeEventListener("keydown", hideTooltipOnEscape);
}
