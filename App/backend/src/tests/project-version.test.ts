import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMMY_VERSION } from "../project-version.js";

describe("project version", () => {
  it("matches the release metadata consumed by Desktop and Agent", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    const rootManifest = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    );

    expect(MEMMY_VERSION).toBe(rootManifest.version);
    expect(MEMMY_VERSION).toBe("1.1.8");
    expect(MEMMY_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    expect(readFileSync(resolve(repoRoot, "App/backend/src/project-version.ts"), "utf8"))
      .toContain(`MEMMY_VERSION = ${JSON.stringify(rootManifest.version)}`);
    for (const path of ["App/shell/desktop/package.json", "App/memmy-agent/package.json"]) {
      const consumer = JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
      expect(MEMMY_VERSION, path).toBe(consumer.version);
    }
  });
});
