import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

describe("package version", () => {
  const rootPackagePath = path.resolve(process.cwd(), "../..", "package.json");

  it("exports the root project version from source checkouts", () => {
    const packageJson = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));

    expect(version).toBe(packageJson.version);
  });

  it("keeps package.json as the only hardcoded version source", () => {
    const packageJson = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
    const duplicateSources = sourceFiles(path.join(process.cwd(), "src")).filter((file) =>
      fs.readFileSync(file, "utf8").includes(packageJson.version),
    );

    expect(duplicateSources).toEqual([]);
  });
});
