import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

type RefreshState = "idle" | "pending" | "success" | "error";

interface RefreshButtonProps {
  onRefresh: () => void | Promise<void>;
}

export function RefreshButton({ onRefresh }: RefreshButtonProps) {
  const [state, setState] = useState<RefreshState>("idle");
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const finish = (next: "success" | "error") => {
    clearTimer();
    setState(next);
    timerRef.current = window.setTimeout(() => {
      setState("idle");
      timerRef.current = null;
    }, next === "success" ? 1_400 : 2_200);
  };

  const refresh = async () => {
    if (state === "pending") return;
    clearTimer();
    setState("pending");
    try {
      await onRefresh();
      finish("success");
    } catch {
      finish("error");
    }
  };

  useEffect(() => clearTimer, []);

  const label = t(
    state === "pending"
      ? "common.refreshing"
      : state === "success"
        ? "common.refreshed"
        : state === "error"
          ? "common.refreshFailed"
          : "common.refresh",
  );

  return (
    <button
      type="button"
      class={`btn btn--ghost btn--sm refresh-feedback refresh-feedback--${state}`}
      disabled={state === "pending"}
      aria-busy={state === "pending"}
      aria-label={label}
      title={label}
      onClick={() => void refresh()}
    >
      <Icon
        name={state === "success" ? "check" : state === "error" ? "circle-alert" : "refresh-cw"}
        size={14}
        class={state === "pending" ? "spin" : ""}
      />
      {label}
    </button>
  );
}
