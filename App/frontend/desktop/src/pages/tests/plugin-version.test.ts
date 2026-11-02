import { describe, expect, it } from "vitest";
import { isNewerPluginVersion } from "../plugin-version.js";

describe("plugin update ordering", () => {
  it.each([
    ["0.2.3", "0.2.0", true],
    ["1.10.0", "1.9.9", true],
    ["0.2.3", "0.2.3", false],
    ["0.2.3", "0.3.0", false],
    ["1.0.0", "1.0.0-rc.2", true],
    ["1.0.0-rc.2", "1.0.0", false],
    ["1.0.0-rc.10", "1.0.0-rc.2", true],
    ["1.0.0-beta", "1.0.0-alpha", true],
    ["1.0.0-alpha.1", "1.0.0-alpha", true],
    ["1.0.0+new", "1.0.0+old", false],
    [undefined, "0.2.0", false],
    ["preview", "0.2.0", false],
    ["0.2.3", "unknown", false]
  ])("compares %s against installed %s", (candidate, installed, expected) => {
    expect(isNewerPluginVersion(candidate, installed)).toBe(expected);
  });
});
