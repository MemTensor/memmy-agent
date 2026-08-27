/// <reference types="node" />
/** Legacy product import tests. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blockedPattern = new RegExp(["mind", "dock"].join(""), "i");
const blockedImportPattern = new RegExp(
  [
    "from\\s+[\"'][^\"']*(?:",
    ["mind", "dock"].join(""),
    "|",
    ["prototype", "-src"].join(""),
    ")[^\"']*[\"']|import\\s*\\([^)]*(?:",
    ["mind", "dock"].join(""),
    "|",
    ["prototype", "-src"].join(""),
    ")[^)]*\\)"
  ].join(""),
  "i"
);
const sourceExtensions = new Set([".ts", ".tsx", ".css"]);

describe("frontend product naming guard", () => {
  it("does not reference the legacy product name in frontend source files", () => {
    const offenders = listSourceFiles(sourceRoot).filter((filePath) => blockedPattern.test(readFileSync(filePath, "utf8")));

    expect(offenders).toEqual([]);
  });

  it("does not import components or assets from legacy prototype folders", () => {
    const offenders = listSourceFiles(sourceRoot).filter((filePath) => blockedImportPattern.test(readFileSync(filePath, "utf8")));

    expect(offenders).toEqual([]);
  });
});

/** Handles list source files. */
function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }

    if (sourceExtensions.has(extname(entry))) {
      files.push(fullPath);
    }
  }

  return files;
}
