/** Independent Memory/Local Plugin release identity. */
export const MEMORY_SERVICE_VERSION = "2.1.1";
export const MEMORY_VIEWER_VERSION = MEMORY_SERVICE_VERSION;
export const MEMORY_PROTOCOL_VERSION = 1;

export const MEMORY_CAPABILITIES = [
  "agent-api",
  "viewer-api",
  "viewer-sse",
  "config-hot-reload",
  "import-export",
  "local-plugin-adapters",
  "agent-source-scan",
  "agent-source-integration"
] as const;
