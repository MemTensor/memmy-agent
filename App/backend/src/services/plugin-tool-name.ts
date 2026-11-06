import { createHash } from "node:crypto";

/** Stable capability name, including room for the Agent's MCP prefix. */
export function capabilityToolName(pluginId: string, capabilityId: string): string {
  const digest = createHash("sha256").update(`${pluginId}\0${capabilityId}`).digest("hex").slice(0, 8);
  const readable = capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  const maxReadableLength = 52 - "plugin__".length - digest.length;
  return `plugin_${readable.slice(0, maxReadableLength)}_${digest}`;
}
