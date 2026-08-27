import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_VERSION = readProjectVersion();

function readProjectVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  let packagedVersion: string | undefined;

  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
        workspaces?: unknown;
      };
      if (typeof manifest.version === "string") {
        packagedVersion ??= manifest.version;
        if (manifest.name === "memmy-agent" && Array.isArray(manifest.workspaces)) {
          return manifest.version;
        }
      }
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  if (packagedVersion) return packagedVersion;
  throw new Error("Unable to resolve the Memmy project version");
}
