import { describe, expect, it } from "vitest";
import { collabEnabledFor } from "../collab-mode.js";

describe("collab availability by login mode", () => {
  it("keeps shared projects out of API Key mode", () => {
    expect(collabEnabledFor("byok")).toBe(false);
  });

  it("allows them in account mode and before a mode is chosen", () => {
    expect(collabEnabledFor("account")).toBe(true);
    expect(collabEnabledFor("unset")).toBe(true);
    expect(collabEnabledFor(undefined)).toBe(true);
  });
});
