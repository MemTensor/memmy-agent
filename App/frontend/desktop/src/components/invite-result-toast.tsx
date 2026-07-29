/** Lightweight toast for invite reward result after registration. */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Banner } from "./banner.js";

export type InviteResultTone = "success" | "missed";

export interface InviteResultToastProps {
  text: string;
  tone: InviteResultTone;
  onDismiss: () => void;
  durationMs?: number;
}

/** Fixed top toast using shared Banner styles; auto-dismisses after a short delay. */
export function InviteResultToast(props: InviteResultToastProps) {
  const durationMs = props.durationMs ?? 3400;
  const onDismissRef = useRef(props.onDismiss);
  onDismissRef.current = props.onDismiss;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDismissRef.current();
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, props.text, props.tone]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="invite-result-toast" role="status" aria-live="polite">
      <div className="invite-result-toast__panel animate-fade-up">
        <Banner tone={props.tone === "success" ? "success" : "warning"}>{props.text}</Banner>
      </div>
    </div>,
    document.body
  );
}
