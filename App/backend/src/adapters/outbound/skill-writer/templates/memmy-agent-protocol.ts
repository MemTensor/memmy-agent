/** Shared contract rendered into standalone Memmy agent adapters. */

export const MEMMY_AGENT_PROTOCOL_VERSION = "memmy.agent.v1";

export const MEMMY_AGENT_PROTOCOL_FIELDS = [
  "protocolVersion",
  "source",
  "adapterId",
  "requestId",
  "sessionId",
  "turnId",
  "episodeId",
  "workspacePath",
  "projectId",
  "sourceMemoryIds",
  "provenance"
] as const;

