import { CircleHelp } from "lucide-react";
import { useTranslation } from "../../i18n/use-translation.js";
import {
  agentSourceDisplayName,
  agentSourceLogoUrl,
  isMemmyAgentSource,
  normalizeAgentSourceId
} from "../agent-source-logos.js";

export function MemoryAgentSourceTag(props: { sourceAgent: string; label: string }) {
  const { t } = useTranslation();
  const isUnknown = normalizeAgentSourceId(props.sourceAgent) === "unknown";
  const displayName = isUnknown
    ? t("common.unknown")
    : agentSourceDisplayName(props.sourceAgent);
  const logoUrl = agentSourceLogoUrl(props.sourceAgent);
  const accessibleLabel = `${props.label}: ${displayName}`;

  return (
    <span
      className={`memory-agent-source-tag${isUnknown ? " memory-agent-source-tag--unknown" : ""}`}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      <span className="memory-agent-source-tag__avatar" aria-hidden="true">
        {logoUrl ? (
          <img
            className={`memory-agent-source-tag__logo${isMemmyAgentSource(props.sourceAgent) ? " memory-agent-source-tag__logo--memmy" : ""}`}
            src={logoUrl}
            alt=""
          />
        ) : isUnknown ? (
          <CircleHelp size={12} strokeWidth={1.9} className="memory-agent-source-tag__unknown-icon" />
        ) : (
          sourceAgentInitials(displayName)
        )}
      </span>
      <span className="memory-agent-source-tag__name">{displayName}</span>
    </span>
  );
}

function sourceAgentInitials(value: string): string {
  const words = value.split(/[\s_-]+/u).filter(Boolean);
  if (words.length > 1) {
    return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
  }
  return value.slice(0, 2).toUpperCase();
}
