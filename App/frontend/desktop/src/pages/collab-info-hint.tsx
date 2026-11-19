import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./collab-page.module.css";

/**
 * 行尾的小问号：说明放在点击之后出现的小浮层里，平时不占版面。创建项目与项目设置共用。
 * 打开时用捕获阶段监听，Escape 只关这一层说明，不连带关掉整个弹窗。
 */
export function InfoHint(props: { label: string; text: string; placement?: "below" | "above" }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // 停在这一层：弹窗自己的 Escape 关掉整屏，说明应该先关、弹窗留着。
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={styles.simpleHintRoot}>
      <button
        type="button"
        className={styles.simpleHintButton}
        aria-label={props.label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {open ? (
        <span
          role="note"
          className={`${styles.simpleHintPopover}${props.placement === "above" ? ` ${styles.simpleHintPopoverAbove}` : ""}`}
        >
          {props.text}
        </span>
      ) : null}
    </span>
  );
}
