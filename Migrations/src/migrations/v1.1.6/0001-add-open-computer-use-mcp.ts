import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  type RuntimeConfigDocument,
} from "../../runtime-config-writer.js";
import { MigrationError, type MigrationDefinition } from "../../types.js";

const MIGRATION_ID = "v1.1.6/0001-add-open-computer-use-mcp";

function addOpenComputerUseMcp(config: RuntimeConfigDocument): void {
  let parent = config;
  for (const key of ["tools", "mcpServers"]) {
    if (!Object.prototype.hasOwnProperty.call(parent, key)) parent[key] = {};
    const value = parent[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new MigrationError("migration_config_invalid", `${key} must be an object`, {
        migrationId: MIGRATION_ID,
        scope: "runtime-config",
      });
    }
    parent = value as RuntimeConfigDocument;
  }
  if (!Object.prototype.hasOwnProperty.call(parent, "open_computer_use")) {
    parent.open_computer_use = {
      type: "stdio",
      command: "open-computer-use",
      args: ["mcp"],
    };
  }
}

export const addOpenComputerUseMcpV116: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.1.6",
  scope: "runtime-config",
  description: "Add the Open Computer Use MCP server to existing runtime configs",
  async up(context) {
    const options = { createIfMissing: false as const };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, addOpenComputerUseMcp, options)
      : await mutateRuntimeConfig(context.runtimeConfigFile, addOpenComputerUseMcp, options);
    if (!result.sourceExists) {
      return { scanned: 0, changed: 0, ignored: 0, deferred: true };
    }
    return result.changed
      ? { scanned: 1, changed: 1, ignored: 0 }
      : { scanned: 1, changed: 0, ignored: 1 };
  },
};
