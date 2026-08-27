/** Integration card module. */
import { deriveIntegrationState, type IntegrationConnectionState, type IntegrationConnection } from "../integrations/connection-state.js";
import { IntegrationLogoBadge, type IntegrationMeta } from "../integrations/integration-meta.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface IntegrationCardProps {
  meta: IntegrationMeta;
  connection?: IntegrationConnection;
  onClick: (meta: IntegrationMeta) => void;
}

export function IntegrationCard(props: IntegrationCardProps) {
  const { t } = useTranslation();
  const state = deriveIntegrationState(props.connection);
  const labelKey = integrationCardLabelKey(state);
  const actionKey = state === "connected" ? "tools.modal.manage" : "tools.modal.connect";
  const variantClass = props.meta.isChannel ? "integration-card-channel" : "integration-card-integration";
  const statusLabel = labelKey ? t(labelKey) : "";

  return (
    <button
      type="button"
      className={`integration-card rounded-card ${variantClass} ${integrationCardStatusClass(state)}`}
      title={props.meta.description}
      aria-label={statusLabel ? `${props.meta.name}, ${statusLabel}. ${t(actionKey)}.` : `${props.meta.name}. ${t(actionKey)}.`}
      onClick={() => props.onClick(props.meta)}
    >
      <IntegrationLogoBadge slug={props.meta.slug} name={props.meta.name} surface={props.meta.surface} sizeClassName="integration-card-logo" />
      <span className="integration-card-content">
        <span className="integration-card-name">{props.meta.name}</span>
        <span className={`integration-card-state-label ${integrationCardStatusTextClass(state)}`}>{statusLabel}</span>
      </span>
    </button>
  );
}

/**
 * Return the card's visual class based on state.
 *
 * @param state the derived connection display state.
 * @returns the status class.
 */
export function integrationCardStatusClass(state: IntegrationConnectionState): string {
  if (state === "pending") {
    return "integration-card-status-connecting";
  }

  if (state === "connected") {
    return "integration-card-status-connected";
  }

  if (state === "expired" || state === "error") {
    return "integration-card-status-error";
  }

  return "integration-card-status-default";
}

/**
 * Return the status text color based on connection state.
 *
 * @param state the derived connection display state.
 * @returns the status text color class.
 */
function integrationCardStatusTextClass(state: IntegrationConnectionState): string {
  if (state === "connected") {
    return "text-status-success";
  }

  if (state === "error" || state === "expired") {
    return "text-status-error";
  }

  if (state === "pending") {
    return "text-amber-700";
  }

  return "text-text-ink/45";
}

/**
 * Return the card's text key based on state.
 *
 * @param state the derived connection display state.
 * @returns the status text key to display.
 */
function integrationCardLabelKey(state: IntegrationConnectionState): MessageKey | null {
  if (state === "pending") {
    return "tools.card.connecting";
  }

  if (state === "connected") {
    return "tools.card.connected";
  }

  if (state === "expired") {
    return "tools.card.expired";
  }

  if (state === "error") {
    return "tools.card.failed";
  }

  return null;
}
