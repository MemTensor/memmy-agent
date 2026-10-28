import type { ReactNode } from "react";
import { useTranslation } from "../../i18n/use-translation.js";
import { Button } from "../../components/button.js";
import { AlertCircle, RefreshCw, Server } from "./memory-prototype-icons.js";
import {
  memoryPanelErrorTitleKey,
  type MemoryPanelErrorInfo
} from "./memory-panel-error.js";

export interface MemoryPanelErrorNoticeProps {
  info: MemoryPanelErrorInfo;
  /** True while a retry is in flight, so the action button cannot double-fire. */
  retrying?: boolean;
  /** True when another automatic attempt is scheduled. */
  autoRetrying?: boolean;
  onRetry?: () => void;
  restarting?: boolean;
  onRestartService?: () => void;
  /** Optional result of a manual restart, shown below the actions. */
  feedback?: { tone: "success" | "error"; message: string } | null;
  /** Renders the banner variant used when earlier data is still on screen. */
  compact?: boolean;
  children?: ReactNode;
}

/**
 * Explains a failed memory panel read and offers the actions that can fix it.
 *
 * The backend forwards the raw Memory-layer text ("memory layer network
 * error"), which is meaningful to a developer but tells a user nothing about
 * what to do. The headline here is actionable copy; the raw text and request
 * id are kept as diagnostics.
 */
export function MemoryPanelErrorNotice(props: MemoryPanelErrorNoticeProps) {
  const { t } = useTranslation();
  const { info } = props;
  const showDiagnostics = info.detail.length > 0 && info.kind !== "not-ready";
  const showRestart = Boolean(props.onRestartService);
  const showRetry = Boolean(props.onRetry) && info.kind !== "not-ready";

  return (
    <div
      className={`memory-panel-error${props.compact ? " memory-panel-error--compact" : ""}`}
      role="alert"
      data-memory-panel-error={info.kind}
    >
      <div className="memory-panel-error__icon" aria-hidden="true">
        <AlertCircle size={16} />
      </div>
      <div className="memory-panel-error__body">
        <div className="memory-panel-error__title">{t(memoryPanelErrorTitleKey(info))}</div>
        {props.compact && (
          <div className="memory-panel-error__status">{t("memory.panelError.staleNotice")}</div>
        )}
        {props.retrying && (
          <div className="memory-panel-error__status" role="status" aria-live="polite">
            {t("memory.panelError.retrying")}
          </div>
        )}
        {!props.retrying && info.retryable && props.autoRetrying && (
          <div className="memory-panel-error__status" role="status" aria-live="polite">
            {t("memory.panelError.autoRetry")}
          </div>
        )}
        {showDiagnostics && (
          <div className="memory-panel-error__detail">
            {t("memory.panelError.detail", { detail: info.detail })}
          </div>
        )}
        {showDiagnostics && info.requestId && (
          <div className="memory-panel-error__detail">
            {t("memory.panelError.requestId", { requestId: info.requestId })}
          </div>
        )}
        {(showRetry || showRestart) && (
          <div className="memory-panel-error__actions">
            {showRetry && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={props.onRetry}
                disabled={props.retrying || props.restarting}
              >
                <RefreshCw size={13} className={props.retrying ? "animate-spin" : undefined} />
                {t("memory.panelError.retryNow")}
              </Button>
            )}
            {showRestart && (
              <Button
                type="button"
                variant="soft"
                size="sm"
                onClick={props.onRestartService}
                disabled={props.restarting || props.retrying}
              >
                <Server size={13} />
                {props.restarting ? t("memory.restartServiceBusy") : t("memory.restartService")}
              </Button>
            )}
          </div>
        )}
        {props.feedback && (
          <div
            className={`memory-panel-error__feedback memory-panel-error__feedback--${props.feedback.tone}`}
            role={props.feedback.tone === "error" ? "alert" : "status"}
          >
            {props.feedback.message}
          </div>
        )}
        {props.children}
      </div>
    </div>
  );
}
