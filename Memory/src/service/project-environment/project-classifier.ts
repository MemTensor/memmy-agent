import { PROJECT_SOURCE_EXTENSIONS, extensionOf } from "./scan-policy.js";
import type { InventoryEntry } from "./types.js";

const SOURCE_EXTENSION_SET = new Set<string>(PROJECT_SOURCE_EXTENSIONS);
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const ENTRY_NAMES = new Set(["main", "index", "app", "server", "cli"]);
const ROOT_MARKERS = new Set([
  "package.json", "pyproject.toml", "cargo.toml", "go.mod", "pom.xml", "makefile"
]);

export interface ProjectInventoryClassification {
  kind: "code" | "folder";
  languageCounts: Record<string, number>;
}

export function classifyProjectInventory(entries: InventoryEntry[]): ProjectInventoryClassification {
  const files = entries.filter((entry): entry is Extract<InventoryEntry, { type: "file" }> =>
    entry.type === "file"
  );
  const directories = entries.filter((entry) => entry.type === "directory");
  const languageCounts: Record<string, number> = {};
  let sourceCount = 0;
  let hasSourceSignal = false;
  let hasMarker = false;
  let hasGitRoot = false;
  for (const entry of directories) {
    if (entry.relativePath === ".git") hasGitRoot = true;
  }
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const basename = segments.at(-1)!.toLowerCase();
    const extension = extensionOf(basename);
    if (SOURCE_EXTENSION_SET.has(extension)) {
      sourceCount += 1;
      languageCounts[extension] = (languageCounts[extension] ?? 0) + 1;
      const parentSegments = segments.slice(0, -1).map((segment) => segment.toLowerCase());
      const stem = basename.slice(0, -extension.length);
      if (parentSegments.some((segment) => TEST_DIRECTORIES.has(segment)) || ENTRY_NAMES.has(stem)) {
        hasSourceSignal = true;
      }
    }
    const depth = segments.length - 1;
    if (depth <= 2 && isBuildMarker(file.relativePath)) hasMarker = true;
  }
  return {
    kind: hasGitRoot || hasMarker || (sourceCount > 0 && hasSourceSignal) || sourceCount >= 5
      ? "code"
      : "folder",
    languageCounts
  };
}

function isBuildMarker(relativePath: string): boolean {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const lower = basename.toLowerCase();
  return ROOT_MARKERS.has(lower) || /^build\.gradle(\.kts)?$/i.test(basename) ||
    /\.(sln|csproj)$/i.test(basename);
}
