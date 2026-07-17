import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/use-translation.js";
import { RefreshCw } from "./memory-prototype-icons.js";

type RefreshFeedbackState = "idle" | "pending" | "success" | "error";

export interface MemoryRefreshButtonProps {
  onClick: () => void | Promise<void>;
}

export function MemoryRefreshButton(props: MemoryRefreshButtonProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<RefreshFeedbackState>("idle");
  const feedbackTimerRef = useRef<number | null>(null);

  function clearFeedbackTimer() {
    if (feedbackTimerRef.current === null) {
      return;
    }

    window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = null;
  }

  function finishFeedback(next: Exclude<RefreshFeedbackState, "idle" | "pending">) {
    clearFeedbackTimer();
    setFeedback(next);
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback("idle");
      feedbackTimerRef.current = null;
    }, next === "success" ? 1400 : 2200);
  }

  async function handleClick() {
    if (feedback === "pending") {
      return;
    }

    clearFeedbackTimer();
    setFeedback("pending");
    try {
      await props.onClick();
      finishFeedback("success");
    } catch {
      finishFeedback("error");
    }
  }

  useEffect(() => clearFeedbackTimer, []);

  const labelByFeedback = {
    idle: t("memory.refresh"),
    pending: t("memory.refresh.loading"),
    success: t("memory.refresh.success"),
    error: t("memory.refresh.error")
  } satisfies Record<RefreshFeedbackState, string>;
  const label = labelByFeedback[feedback];

  return (
    <button
      type="button"
      className={`memory-refresh-button memory-refresh-button--${feedback}`}
      onClick={() => void handleClick()}
      aria-busy={feedback === "pending"}
      aria-label={label}
      title={label}
      disabled={feedback === "pending"}
    >
      <RefreshCw size={15} className="memory-refresh-button__icon" />
    </button>
  );
}
