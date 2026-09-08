import { readFile } from "node:fs/promises";

let runtimeAssetPromise: Promise<string> | null = null;

export function loadMemmyWorkspaceBridgeRuntimeAsset(): Promise<string> {
  runtimeAssetPromise ??= readFile(
    new URL("./memmy-workspace-bridge.mjs", import.meta.url),
    "utf8",
  ).then((content) => {
    if (!content.trim()) throw new Error("Memmy lifecycle sidecar asset is empty");
    return content;
  }).catch((error) => {
    runtimeAssetPromise = null;
    throw new Error(
      `Memmy lifecycle sidecar asset is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return runtimeAssetPromise;
}
