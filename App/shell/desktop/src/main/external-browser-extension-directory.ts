import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isExternalBrowserExtensionDirectory(directory: string): boolean {
  try {
    if (!fs.statSync(directory).isDirectory()) return false;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    return manifest?.manifest_version === 3 && fs.statSync(path.join(directory, "background.js")).isFile();
  } catch { return false; }
}

/** Locate the load-unpacked folder in installed Mac/Windows apps and dev builds. */
export function resolveExternalBrowserExtensionDirectory(resourcesPath: string): string | null {
  const packaged = path.join(resourcesPath, "browser-extension");
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "extensions", "memmy-browser");
  for (const candidate of [packaged, source]) {
    if (isExternalBrowserExtensionDirectory(candidate)) return candidate;
  }
  return null;
}
