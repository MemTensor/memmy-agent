/** Theme tests. */
import { describe, expect, it } from "vitest";
import { resolveThemePreference } from "../theme-provider.js";

describe("desktop theme helpers", () => {
  it("keeps every configured preference rendered as light", () => {
    expect(resolveThemePreference("light", false)).toBe("light");
    expect(resolveThemePreference("dark", true)).toBe("light");
  });

  it("ignores system media query state", () => {
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("system", true)).toBe("light");
    expect(resolveThemePreference(undefined, true)).toBe("light");
  });
});
