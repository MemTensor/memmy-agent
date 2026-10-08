/** MCP server id registered for the bundled Memmy Computer Use helper. */
export const MEMMY_COMPUTER_USE_MCP_SERVER = "memmy_computer_use";

/** Configs written before the v1.1.9 rename. Still accepted until that migration runs. */
export const LEGACY_COMPUTER_USE_MCP_SERVER = "open_computer_use";

export function isMemmyComputerUseServer(name: string): boolean {
  return name === MEMMY_COMPUTER_USE_MCP_SERVER || name === LEGACY_COMPUTER_USE_MCP_SERVER;
}

export function memmyComputerUseToolName(action: string): string {
  return `mcp_${MEMMY_COMPUTER_USE_MCP_SERVER}_${action}`;
}

export function legacyComputerUseToolName(action: string): string {
  return `mcp_${LEGACY_COMPUTER_USE_MCP_SERVER}_${action}`;
}
