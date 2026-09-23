/** Generic top-right notification card. Compact base for all in-app notices. */
import { ChevronRight, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";

export type NotificationVariant = "success" | "info" | "warning";

export interface NotificationToastProps {
  variant?: NotificationVariant;
  title: string;
  body?: string;
  /** Optional emphasized value shown under the title, e.g. a credited token amount. */
  emphasis?: string;
  /** Optional leading icon. Omit for a text-only card. */
  icon?: LucideIcon;
  /** Optional action link. */
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}

/** Notification card aligned with the GitHub-star floating card. */
export function NotificationToast(props: NotificationToastProps) {
  const { t } = useTranslation();
  const variant = props.variant ?? "info";
  const Icon = props.icon;

  return (
    <div
      className={`memmy-notification memmy-notification--${variant}`}
      role="status"
      aria-live="polite"
    >
      {Icon ? (
        <span className="memmy-notification__badge" aria-hidden="true">
          <Icon size={16} strokeWidth={2} />
        </span>
      ) : null}
      <div className="memmy-notification__content">
        <div className="memmy-notification__header">
          <p className="memmy-notification__title">{props.title}</p>
          <button
            type="button"
            className="memmy-notification__close"
            aria-label={t("common.close")}
            onClick={props.onDismiss}
          >
            <X size={14} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
        {props.emphasis ? <p className="memmy-notification__emphasis">{props.emphasis}</p> : null}
        {props.body ? <p className="memmy-notification__body">{props.body}</p> : null}
        {props.actionLabel && props.onAction ? (
          <button type="button" className="memmy-notification__action" onClick={props.onAction}>
            <span>{props.actionLabel}</span>
            <ChevronRight size={13} strokeWidth={2.4} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
