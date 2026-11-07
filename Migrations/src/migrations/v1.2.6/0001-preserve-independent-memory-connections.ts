import { repairIndependentMemoryConnections } from "../v1.0.7/0001-normalize-runtime-model-catalog.js";
import { mutateRuntimeConfig, mutateRuntimeConfigLockHeld } from "../../runtime-config-writer.js";
import type { MigrationDefinition } from "../../types.js";

export const preserveIndependentMemoryConnectionsV126: MigrationDefinition = {
  id: "v1.2.6/0001-preserve-independent-memory-connections",
  introducedIn: "1.2.6",
  scope: "runtime-config",
  description: "Preserve active edited platform Memory connections using independent catalog endpoints",
  async up(context) {
    const options = { createIfMissing: false as const };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, repairIndependentMemoryConnections, options)
      : await mutateRuntimeConfig(context.runtimeConfigFile, repairIndependentMemoryConnections, options);
    if (!result.sourceExists) return { scanned: 0, changed: 0, ignored: 0, deferred: true };
    return { scanned: 1, changed: result.changed ? 1 : 0, ignored: result.changed ? 0 : 1 };
  },
};
