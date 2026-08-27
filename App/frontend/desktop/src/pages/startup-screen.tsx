/** Startup screen module. */
import { Loader2 } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE } from "../theme/window-controls-overlay.js";

/** Contract for startup screen props. */
export interface StartupScreenProps {
  message?: string | null;
  onRetry?: () => void;
  quiet?: boolean;
}

/** Starts startup screen. */
export function StartupScreen(props: StartupScreenProps) {
  const { t } = useTranslation();
  const hasError = Boolean(props.message);

  if (props.quiet && !hasError) {
    return (
      <main className="min-h-screen bg-canvas-oat relative overflow-hidden" aria-busy="true">
        <div className="fixed inset-x-0 top-0 h-1 bg-action-sky/10 overflow-hidden" aria-hidden="true">
          <div className="h-full w-1/3 bg-action-sky/80 rounded-r-full animate-pulse" />
        </div>
        <div
          className="fixed right-4 inline-flex items-center gap-2 rounded-full border border-border-stone/50 bg-background-paper/90 px-3 py-1.5 shadow-sm"
          style={WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-action-sky animate-pulse" aria-hidden="true" />
          <span className="text-xs font-medium text-text-ink/70">{t("app.loading.refreshTitle")}</span>
        </div>
        <p className="sr-only" role="status" aria-live="polite">{t("app.loading.refreshBody")}</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-canvas-oat px-4 flex items-center justify-center relative overflow-hidden" aria-busy={!hasError}>
      <div className="absolute top-[-80px] right-[-60px] w-64 h-64 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-60px] left-[-40px] w-56 h-56 bg-action-sky/10 rounded-full blur-3xl" />
      <div className="text-center relative z-10">
        <div className="startup-brand-mascot flex justify-center">
          <Memmy pose={hasError ? "plead" : "wave"} size={hasError ? 158 : 205} className={hasError ? "" : "memmy-wave"} />
        </div>
        {hasError && (
          <p className="text-sm font-semibold text-text-ink/55 mt-2">{t("app.error.eyebrow")}</p>
        )}
        <h1
          className={
            hasError
              ? "startup-screen-title startup-screen-title--error mt-1"
              : "startup-screen-title startup-screen-title--loading"
          }
        >
          <span className="startup-screen-title__brand">{t("brand.name")}</span>
          <span className="startup-screen-title__status">
            {hasError ? t("app.error.status") : t("app.loading.status")}
          </span>
        </h1>
        {hasError && props.message && (
          <p className="text-sm text-text-ink/60 mt-2 leading-relaxed max-w-sm">{props.message}</p>
        )}
        {!hasError && (
          <>
            <div className="startup-screen-spinner" aria-hidden="true">
              <Loader2 size={18} className="animate-spin" />
            </div>
            <p className="sr-only" role="status" aria-live="polite">{t("app.loading.body")}</p>
          </>
        )}
        {hasError && props.onRetry && (
          <button
            type="button"
            onClick={props.onRetry}
            className="mt-5 px-8 py-2.5 bg-action-sky text-white font-normal rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer active:scale-[0.98]"
          >
            {t("app.error.retry")}
          </button>
        )}
      </div>
    </main>
  );
}
