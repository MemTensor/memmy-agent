import type { MemoryPanelErrorInfo } from "./memory-panel-error.js";
import { MemoryPanelErrorNotice } from "./memory-panel-error-notice.js";
import type { MemoryRestartFeedback } from "./use-memory-service-restart.js";

export interface MemoryPanelStatusProps {
  errorInfo?: MemoryPanelErrorInfo | null;
  retrying?: boolean;
  autoRetrying?: boolean;
  onRetry?: () => void;
  restarting?: boolean;
  onRestartService?: () => void;
  restartFeedback?: MemoryRestartFeedback | null;
  /** Renders the compact banner variant used above already-loaded content. */
  compact?: boolean;
}

/**
 * Renders whichever recovery surface a memory panel currently needs: the error
 * notice while a read is failing, or the restart confirmation once a reload
 * after a manual restart has succeeded and cleared the notice.
 */
export function MemoryPanelStatus(props: MemoryPanelStatusProps) {
  if (props.errorInfo) {
    return (
      <MemoryPanelErrorNotice
        info={props.errorInfo}
        retrying={props.retrying}
        autoRetrying={props.autoRetrying}
        onRetry={props.onRetry}
        restarting={props.restarting}
        onRestartService={props.onRestartService}
        feedback={props.restartFeedback}
        compact={props.compact}
      />
    );
  }

  if (!props.errorInfo && props.restartFeedback) {
    // The reload after a successful restart clears the failure notice, so the
    // confirmation needs its own surface or it vanishes instantly.
    return (
      <div
        className={`memory-panel-status memory-panel-status--${props.restartFeedback.tone}`}
        role={props.restartFeedback.tone === "error" ? "alert" : "status"}
      >
        {props.restartFeedback.message}
      </div>
    );
  }

  return null;
}
