import { removePlatformMemoryDuplicatesV124 } from "./0001-remove-platform-memory-duplicates.js";
import type { MigrationDefinition } from "../../types.js";

// Older Memory startup writers could recreate copies after 0001 completed.
// Use a new ID so existing installs receive the corrected conservative cleanup.
export const removeReintroducedPlatformMemoryDuplicatesV124: MigrationDefinition = {
  ...removePlatformMemoryDuplicatesV124,
  id: "v1.2.4/0002-remove-reintroduced-platform-memory-duplicates",
  description: "Remove exact platform Memory copies recreated after the original cleanup",
};
