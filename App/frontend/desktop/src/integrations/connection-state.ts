import type { IntegrationConnection as ContractIntegrationConnection } from "@memmy/local-api-contracts";
import type { IntegrationSurface } from "./integration-meta.js";

export type IntegrationConnection = ContractIntegrationConnection & {
  surface?: IntegrationSurface;
  lastError?: string | null;
};

export type IntegrationConnectionState = "connected" | "pending" | "expired" | "error" | "disconnected";

export function deriveIntegrationState(connection?: IntegrationConnection | null): IntegrationConnectionState {
  if (!connection) {
    return "disconnected";
  }

  const status = connection.status.trim().toLowerCase();

  if (status === "active" || status === "connected") {
    return "connected";
  }

  if (status === "initiated" || status === "pending" || status === "initializing") {
    return "pending";
  }

  if (status === "expired") {
    return "expired";
  }

  if (status === "failed" || status === "error") {
    return "error";
  }

  return "disconnected";
}
