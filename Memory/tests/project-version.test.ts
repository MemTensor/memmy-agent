import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROJECT_VERSION } from "../src/cli/project-version.js";

describe("Memory service version", () => {
  it("reads the independently versioned Memory package", () => {
    const manifest = JSON.parse(readFileSync(resolve(fileURLToPath(import.meta.url), "../../package.json"), "utf8"));
    const cliManifest = JSON.parse(
      readFileSync(resolve(fileURLToPath(import.meta.url), "../../src/cli/npm/package.json"), "utf8")
    );

    expect(PROJECT_VERSION).toBe("2.1.0");
    expect(PROJECT_VERSION).toBe(manifest.version);
    expect(cliManifest.version).toBe(manifest.version);
  });
});
