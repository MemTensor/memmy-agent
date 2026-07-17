/** App boot launch mode tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSourcePath = fileURLToPath(new URL("../../app.tsx", import.meta.url));

describe("app boot launch mode wiring", () => {
  it("derives the preferred mode from persisted settings instead of localStorage", () => {
    const source = readFileSync(appSourcePath, "utf8");

    expect(source).toContain("resolvePreferredLaunchMode({");
    expect(source).toContain("preferredMode: launchModeOverride ?? persistedPreferredMode");
    expect(source).toContain("appActions.preferredModeUpdated(persistedPreferredMode)");
    expect(source).not.toContain("readPreferredMode(");
  });
});
