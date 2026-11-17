import { readFile } from "node:fs/promises";

let runtimeAssetPromise: Promise<string> | null = null;

/** 项目钩子用的运行时：与记忆钩子的 bridge 分开打包，互不影响版本指纹。 */
export function loadMemmyProjectHookRuntimeAsset(): Promise<string> {
  runtimeAssetPromise ??= readFile(
    new URL("./memmy-project-runtime.mjs", import.meta.url),
    "utf8",
  ).then((content) => {
    if (!content.trim()) throw new Error("Memmy project hook runtime asset is empty");
    return content;
  }).catch((error) => {
    runtimeAssetPromise = null;
    throw new Error(
      `Memmy project hook runtime asset is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return runtimeAssetPromise;
}
