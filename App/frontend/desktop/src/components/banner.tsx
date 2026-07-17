/** Banner module. */
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ReactNode } from "react";

/** Contract for banner props. */
export interface BannerProps {
  tone?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
}

const BANNER_ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle
} as const;

/** Handles banner. */
export function Banner(props: BannerProps) {
  const tone = props.tone ?? "info";
  const Icon = BANNER_ICONS[tone];

  return (
    <div className={`banner banner-${tone}`} role="alert">
      <span className="banner__icon" aria-hidden="true">
        <Icon size={14} strokeWidth={2.2} />
      </span>
      <div className="banner__body">{props.children}</div>
    </div>
  );
}
