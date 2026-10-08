import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  type RuntimeConfigDocument,
} from "../../runtime-config-writer.js";
import { MigrationError, type MigrationDefinition } from "../../types.js";

const MIGRATION_ID = "v1.1.9/0001-rename-memmy-computer-use-mcp";
const LEGACY_SERVER = "open_computer_use";
const SERVER = "memmy_computer_use";
const LEGACY_TOOL_PREFIX = "mcp_open_computer_use_";
const TOOL_PREFIX = "mcp_memmy_computer_use_";
const STOCK_KEYS = new Set(["type", "command", "args"]);

function migrationError(message: string): MigrationError {
  return new MigrationError("migration_config_invalid", message, {
    migrationId: MIGRATION_ID,
    scope: "runtime-config",
  });
}

function isRecord(value: unknown): value is RuntimeConfigDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStockServer(server: unknown): boolean {
  if (!isRecord(server)) return false;
  if (Object.keys(server).some((key) => !STOCK_KEYS.has(key))) return false;
  if (server.type !== undefined && server.type !== "stdio") return false;
  return server.command === "open-computer-use" && JSON.stringify(server.args) === '["mcp"]';
}

function renamedToolId(value: string): string {
  return value.startsWith(LEGACY_TOOL_PREFIX) ? `${TOOL_PREFIX}${value.slice(LEGACY_TOOL_PREFIX.length)}` : value;
}

function rewriteToolIds(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (typeof entry === "string") value[index] = renamedToolId(entry);
      else rewriteToolIds(entry);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") value[key] = renamedToolId(entry);
    else rewriteToolIds(entry);
  }
}

function renameMemmyComputerUseMcp(config: RuntimeConfigDocument): void {
  if (!Object.prototype.hasOwnProperty.call(config, "tools")) return;
  const tools = config.tools;
  if (!isRecord(tools)) throw migrationError("tools must be an object");
  if (!Object.prototype.hasOwnProperty.call(tools, "mcpServers")) return;
  const servers = tools.mcpServers;
  if (!isRecord(servers)) throw migrationError("mcpServers must be an object");

  const legacy = servers[LEGACY_SERVER];
  const current = servers[SERVER];
  if (current !== undefined) rewriteToolIds(current);
  if (legacy === undefined) return;

  if (current === undefined) {
    servers[SERVER] = legacy;
    delete servers[LEGACY_SERVER];
    rewriteToolIds(servers[SERVER]);
    return;
  }

  if (isStockServer(legacy)) {
    delete servers[LEGACY_SERVER];
    return;
  }
  if (isStockServer(current)) {
    servers[SERVER] = legacy;
    delete servers[LEGACY_SERVER];
    rewriteToolIds(servers[SERVER]);
  }
}

export const renameMemmyComputerUseMcpV119: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.1.9",
  scope: "runtime-config",
  description: "Rename the Computer Use MCP server id from open_computer_use to memmy_computer_use",
  async up(context) {
    const options = { createIfMissing: false as const };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, renameMemmyComputerUseMcp, options)
      : await mutateRuntimeConfig(context.runtimeConfigFile, renameMemmyComputerUseMcp, options);
    if (!result.sourceExists) {
      return { scanned: 0, changed: 0, ignored: 0, deferred: true };
    }
    return result.changed
      ? { scanned: 1, changed: 1, ignored: 0 }
      : { scanned: 1, changed: 0, ignored: 1 };
  },
};
