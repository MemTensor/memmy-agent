import type { MemmyConfig } from "../../config/index.js";
import type { StorageBackendCapabilities } from "../../storage/backend.js";

/** The new L3 only runs on local SQLite storage, where the Memory service can see the workspace. */
export function isL3FieldCognitionActive(
  config: Pick<MemmyConfig, "algorithm">,
  capabilities: Pick<StorageBackendCapabilities, "backendId">,
  mode: "local" | "cloud" | "dev"
): boolean {
  return config.algorithm.l3FieldCognition.enabled &&
    mode !== "cloud" &&
    capabilities.backendId === "sqlite-local";
}
