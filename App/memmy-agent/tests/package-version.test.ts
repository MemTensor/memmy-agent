import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

describe("package version", () => {
  it("exports the package version from source checkouts", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

    expect(version).toBe(packageJson.version);
  });
});
