/** Domain module. */
import type { JsonObject, JsonValue } from "./json.js";

export type BuiltinAgentKind = "cursor" | "codex" | "claude_code" | "opencode" | "openclaw" | "hermes" | "workbuddy";
export type AgentKind = BuiltinAgentKind | (string & {});

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  createdAt?: string;
  metadata?: JsonObject;
}

export interface AgentScanRecord {
  sourceExternalId: string;
  sourceHash: string;
  agentKind: AgentKind;
  workspacePath?: string;
  gitRoot?: string;
  startedAt?: string;
  updatedAt?: string;
  messages: AgentMessage[];
  nextCursor?: JsonValue;
}
