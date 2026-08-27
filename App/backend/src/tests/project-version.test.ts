import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMMY_VERSION } from "../project-version.js";

describe("project version", () => {
  it("matches the root release manifest", () => {
    const rootManifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../../package.json"), "utf8"),
    );

    expect(MEMMY_VERSION).toBe(rootManifest.version);
    expect(MEMMY_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
