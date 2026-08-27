import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_VERSION } from "../src/cli/project-version.js";

describe("project version", () => {
  it("reads the repository root package version", () => {
    const rootManifest = JSON.parse(readFileSync(resolve(process.cwd(), "..", "package.json"), "utf8"));

    expect(PROJECT_VERSION).toBe(rootManifest.version);
  });
});
