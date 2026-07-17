/** Runtime errors module. */
import type { ApiErrorCode } from "@memmy/local-api-contracts";

/** Implementation of permission denied error. */
export class PermissionDeniedError extends Error {
  constructor(public readonly code: Extract<ApiErrorCode, "scan_not_permitted" | "memory_recall_not_permitted" | "skill_write_not_permitted">) {
    super(code);
    this.name = "PermissionDeniedError";
  }
}

/** Implementation of agent source unavailable error. */
export class AgentSourceUnavailableError extends Error {
  public readonly code: Extract<ApiErrorCode, "agent_source_unavailable"> = "agent_source_unavailable";

  constructor(public readonly agentName: string) {
    super(`${agentName} is not installed or its directory is unavailable`);
    this.name = "AgentSourceUnavailableError";
  }
}
