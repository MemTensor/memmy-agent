/** Modal module. */
import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from "react";
import { Button } from "./button.js";

export interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  headerIcon?: ReactNode;
  subtitle?: ReactNode;
  showHeader?: boolean;
  showCloseButton?: boolean;
  closeLabel?: string;
  closeContent?: ReactNode;
  className?: string;
  backdropClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  style?: CSSProperties;
  onClose?: () => void;
}

export function Modal(props: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const showHeader = props.showHeader ?? true;
  const showCloseButton = props.showCloseButton ?? Boolean(props.onClose);
  const labelProps = showHeader
    ? { "aria-labelledby": titleId, "aria-label": props.ariaLabel }
    : { "aria-label": props.ariaLabel ?? props.title };

  useEffect(() => {
    if (!props.open || !props.onClose) {
      return undefined;
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (shouldCloseModalByKey(event.key)) {
        props.onClose?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [props.open, props.onClose]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!shouldInitializeModalFocus(wasOpen, props.open)) {
      return;
    }

    const initialFocusElement = props.initialFocusRef?.current;
    if (initialFocusElement) {
      initialFocusElement.focus();
      return;
    }

    dialogRef.current?.focus();
  }, [props.initialFocusRef, props.open]);

  if (!props.open) {
    return null;
  }

  return (
    <div
      className={["modal-backdrop", props.backdropClassName].filter(Boolean).join(" ")}
      role="presentation"
      onClick={(event) => shouldCloseModalByBackdrop(event) && props.onClose?.()}
    >
      <section
        ref={dialogRef}
        className={["modal", props.className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-describedby={props.ariaDescribedBy}
        style={props.style}
        tabIndex={-1}
        onKeyDown={trapModalFocus}
        {...labelProps}
      >
        {showHeader && (
          <header className="modal-header">
            <div className="modal-title-row">
              {props.headerIcon && <span className="modal-header-icon">{props.headerIcon}</span>}
              <div className="modal-header-main">
                <h2 id={titleId}>{props.title}</h2>
                {props.subtitle && <p className="modal-subtitle">{props.subtitle}</p>}
              </div>
            </div>
            {props.onClose && showCloseButton && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={props.closeLabel ?? "Close"}
                onClick={props.onClose}
              >
                {props.closeContent ?? props.closeLabel ?? "Close"}
              </Button>
            )}
          </header>
        )}
        <div className={["modal-body", props.bodyClassName].filter(Boolean).join(" ")}>{props.children}</div>
        {props.footer && <footer className={["modal-footer", props.footerClassName].filter(Boolean).join(" ")}>{props.footer}</footer>}
      </section>
    </div>
  );
}

export function shouldCloseModalByBackdrop(event: MouseEvent<HTMLElement>): boolean {
  return event.target === event.currentTarget;
}

export function shouldCloseModalByKey(key: string): boolean {
  return key === "Escape";
}

export function shouldInitializeModalFocus(wasOpen: boolean, open: boolean): boolean {
  return open && !wasOpen;
}

function trapModalFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") {
    return;
  }

  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );

  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
