/** Product naming guard tests. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("product naming guard", () => {
  it("does not contain the old product name in backend src TypeScript files", async () => {
    const sourceRoot = join(import.meta.dirname, "..");
    const oldProductNamePattern = new RegExp(["mind", "dock"].join(""), "i");
    const files = await listTypeScriptFiles(sourceRoot);
    const offenders: string[] = [];

    for (const filePath of files) {
      const content = await readFile(filePath, "utf8");
      if (oldProductNamePattern.test(content)) {
        offenders.push(filePath);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/** Handles list type script files. */
async function listTypeScriptFiles(rootDirectory: string): Promise<string[]> {
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      if (fullPath.includes(`${join("tests", "__fixtures__")}`)) {
        continue;
      }

      files.push(...(await listTypeScriptFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}
