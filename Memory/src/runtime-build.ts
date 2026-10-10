import { readFileSync } from "node:fs";

/** Installed packages carry their build identity; development checkouts do not. */
export const MEMORY_RUNTIME_BUILD_ID = (() => {
  try {
    const metadata = JSON.parse(readFileSync(new URL("../../memory-runtime.json", import.meta.url), "utf8")) as { buildId?: unknown };
    return typeof metadata.buildId === "string" && /^[a-f0-9]{64}$/.test(metadata.buildId) ? metadata.buildId : undefined;
  } catch {
    return undefined;
  }
})();
