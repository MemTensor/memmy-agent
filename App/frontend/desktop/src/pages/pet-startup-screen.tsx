import { useLayoutEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { PET_TRANSPARENT_ROOT_CLASS } from "./pet-page.js";
import type { StartupScreenProps } from "./startup-screen.js";

/** Keeps pet startup and retry feedback visible while application services initialize. */
export function PetStartupScreen({ message, onRetry }: StartupScreenProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<HTMLDivElement>(null);
  const hasError = Boolean(message) || Boolean(onRetry);

  useLayoutEffect(() => {
    document.documentElement.classList.add(PET_TRANSPARENT_ROOT_CLASS);
    document.body.classList.add(PET_TRANSPARENT_ROOT_CLASS);
    return () => {
      document.documentElement.classList.remove(PET_TRANSPARENT_ROOT_CLASS);
      document.body.classList.remove(PET_TRANSPARENT_ROOT_CLASS);
    };
  }, []);

  // The native window is hidden until a layout arrives, including before bootstrap finishes.
  useLayoutEffect(() => {
    const root = rootRef.current?.getBoundingClientRect();
    const mascot = mascotRef.current?.getBoundingClientRect();
    if (!root || !mascot || root.width <= 0 || root.height <= 0) return;
    window.memmy?.syncPetWindowLayout?.({
      width: Math.ceil(root.width),
      height: Math.ceil(root.height),
      mascotOffsetX: Math.max(0, Math.round(mascot.left - root.left)),
      mascotOffsetY: Math.max(0, Math.round(mascot.top - root.top))
    });
  });

  return (
    <div ref={rootRef} data-pet-startup aria-busy={!hasError}
      style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 24, width: 240, boxSizing: "content-box" }}>
      <div role={hasError ? "alert" : "status"}
        className="rounded-2xl border border-border-stone bg-background-paper px-4 py-3 text-center text-sm text-text-ink shadow-sm"
        style={{ maxWidth: 240 }}>
        <div className="inline-flex items-center gap-2">
          {!hasError && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          <span>{t(hasError ? "app.error.title" : "app.loading.title")}</span>
        </div>
        {hasError && onRetry && (
          <button type="button" onClick={onRetry}
            className="mt-2 block mx-auto rounded-btn bg-action-sky px-4 py-1.5 text-white hover:bg-action-sky-hover">
            {t("app.error.retry")}
          </button>
        )}
      </div>
      <div ref={mascotRef} data-pet-startup-mascot style={{ width: 120, height: 120 }}>
        <Memmy pose={hasError ? "plead" : "think"} size={120} />
      </div>
    </div>
  );
}
