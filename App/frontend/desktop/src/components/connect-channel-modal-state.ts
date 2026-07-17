/** Connect channel modal state module. */
import type { ConnectChannelResponse } from "@memmy/local-api-contracts";
import { deriveIntegrationState, type IntegrationConnection } from "../integrations/connection-state.js";

export type ConnectChannelPhase = "idle" | "starting" | "pendingQr" | "connected" | "disconnecting" | "error" | "unsupported";

export function deriveInitialChannelPhase(
  connection?: IntegrationConnection,
  forcedPhase?: ConnectChannelPhase,
  forcedConnectResponse?: ConnectChannelResponse
): ConnectChannelPhase {
  if (forcedPhase) {
    return forcedPhase;
  }

  if (forcedConnectResponse?.status === "pendingQr") {
    return "pendingQr";
  }

  const state = deriveIntegrationState(connection);
  if (state === "connected") {
    return "connected";
  }

  if (state === "error" || state === "expired") {
    return "error";
  }

  return "idle";
}

export function deriveChannelConnectResponseAfterConnectionRefresh(
  currentResponse: ConnectChannelResponse | undefined,
  connection?: IntegrationConnection
): ConnectChannelResponse | undefined {
  const state = deriveIntegrationState(connection);
  if (state === "connected" || state === "error" || state === "expired") {
    return undefined;
  }

  return currentResponse?.status === "pendingQr" && currentResponse.qrCodeDataUrl ? currentResponse : undefined;
}

export function deriveChannelPhaseAfterConnectionRefresh(connection?: IntegrationConnection): ConnectChannelPhase | null {
  const state = deriveIntegrationState(connection);

  if (state === "connected") {
    return "connected";
  }

  if (state === "error" || state === "expired") {
    return "error";
  }

  return null;
}
