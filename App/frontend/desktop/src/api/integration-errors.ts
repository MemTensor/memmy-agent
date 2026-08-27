import { ApiRequestError } from "./http.js";

const INTEGRATION_SETUP_DIAGNOSTIC_CODES = new Set(["composio_not_configured"]);
const HIDDEN_INTEGRATION_DIAGNOSTIC_LOG = "[tools] integration setup diagnostic hidden from product UI:";

export function isIntegrationSetupDiagnosticError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code !== null && INTEGRATION_SETUP_DIAGNOSTIC_CODES.has(error.code);
}

export function logHiddenIntegrationSetupDiagnosticError(error: unknown): void {
  console.warn(HIDDEN_INTEGRATION_DIAGNOSTIC_LOG, error);
}
