import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only development may override the binary. Packaged code must use the helper
// shipped beside it, on disk outside ASAR, and fail closed if it is missing.
export function resolveNativeCollector(moduleUrl: string, binary?: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const packaged = /[/\\]app\.asar(?:\.unpacked)?[/\\]/u.test(modulePath);
  const bundled = path.join(path.dirname(modulePath), "memmy-history-recorder.exe")
    .replace(/([/\\])app\.asar([/\\])/u, "$1app.asar.unpacked$2");
  const resolved = packaged ? bundled : binary ?? process.env.MEMMY_WINDOWS_HISTORY_BINARY ?? bundled;
  try { if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) throw new Error(); }
  catch { throw new Error("windows_collector_unavailable"); }
  return resolved;
}
