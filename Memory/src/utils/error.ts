import type { ApiErrorBody } from "../types.js";

export class MemoryServiceError extends Error {
  readonly code: ApiErrorBody["error"]["code"];
  readonly status: number;
  readonly requestId?: string;

  constructor(
    code: ApiErrorBody["error"]["code"],
    message: string,
    status = statusForCode(code),
    requestId?: string,
  ) {
    super(message);
    this.name = "MemoryServiceError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, requestId: this.requestId } };
  }
}

export function statusForCode(code: ApiErrorBody["error"]["code"]): number {
  switch (code) {
    case "invalid_argument":
    case "missing_idempotency_key":
    case "composio_not_configured":
    case "toolkit_unsupported":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
    case "scan_not_permitted":
    case "memory_recall_not_permitted":
    case "skill_write_not_permitted":
    case "plugin_entitlement_required":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "idempotency_body_mismatch":
    case "agent_source_unavailable":
    case "model_config_changed":
    case "config_write_busy":
    case "account_model_preset_conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "memory_starting":
    case "memory_upgrading":
    case "memory_layer_unavailable":
    case "memory_scan_upgrade_required":
      return 503;
    default:
      return 500;
  }
}
