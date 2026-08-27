export function sessionExtra(metadata: Record<string, any> | null | undefined): Record<string, any> {
  const mcpPresets = metadata && Array.isArray(metadata.mcp_presets) ? metadata.mcp_presets : null;
  return mcpPresets?.length ? { mcp_presets: mcpPresets } : {};
}

export function runtimeLines(
  message: any,
  {
    availableServerNames = null,
    configuredServerNames = null,
    connectedServerNames = null,
    skip = false,
  }: {
    availableServerNames?: Set<string> | string[] | null;
    configuredServerNames?: Set<string> | string[] | null;
    connectedServerNames?: Set<string> | string[] | null;
    skip?: boolean;
  } = {},
): string[] {
  if (skip) return [];
  const available = namesSet(availableServerNames);
  const configured = namesSet(configuredServerNames) ?? available;
  const connected = namesSet(connectedServerNames) ?? available;
  const metadata = message?.metadata && typeof message.metadata === "object" ? message.metadata : null;
  const structured = metadata && Array.isArray(metadata.mcp_presets) ? metadata.mcp_presets : null;
  if (!structured) return [];

  const lines: string[] = [];
  for (const item of structured.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const rawName = String(item.name ?? "").trim().toLowerCase();
    if (!rawName) continue;
    const display = String(item.display_name ?? rawName).trim() || rawName;
    const transport = String(item.transport ?? "mcp").trim() || "mcp";
    const prefix = `mcp_${rawName}_`;
    if (configured && !configured.has(rawName)) {
      lines.push(
        `MCP Preset Attachment: @${rawName} (${display}; transport=${transport}) is configured in WebUI Settings, but this gateway has not loaded the latest MCP settings yet. Tools with prefix \`${prefix}\` may not be available yet; if they are missing, tell the user to restart memmy-agent.`,
      );
      continue;
    }
    if (connected && !connected.has(rawName)) {
      lines.push(
        `MCP Preset Attachment: @${rawName} (${display}; transport=${transport}) is configured, but its MCP connection is not currently live. Tools with prefix \`${prefix}\` may be unavailable; tell the user to open Settings, run the preset test, and restart memmy-agent only if hot reload is unavailable.`,
      );
      continue;
    }
    lines.push(
      `MCP Preset Attachment: @${rawName} (${display}; transport=${transport}; tool_prefix=${prefix}). Prefer available tools whose names start with \`${prefix}\` for this request; do not substitute shell commands for this MCP integration unless the user asks.`,
    );
  }
  return lines;
}

function namesSet(value: Set<string> | string[] | null | undefined): Set<string> | null {
  if (value == null) return null;
  if (value instanceof Set) return new Set([...value].map((name) => String(name).toLowerCase()));
  return new Set(value.map((name) => String(name).toLowerCase()));
}

export function listMcpPresets(): any[] {
  return [];
}
