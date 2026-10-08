import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Locate the load-unpacked folder in installed Mac/Windows apps and dev builds. */
export function resolveExternalBrowserExtensionDirectory(resourcesPath: string): string | null {
  const packaged = path.join(resourcesPath, "browser-extension");
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "extensions", "memmy-browser");
  for (const candidate of [packaged, source]) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "manifest.json"), "utf8"));
      if (manifest.manifest_version === 3 && fs.existsSync(path.join(candidate, "background.js"))) return candidate;
    } catch { /* Try the next packaged/dev location. */ }
  }
  return null;
}
