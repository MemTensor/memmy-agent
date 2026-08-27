import { describe, expect, it } from "vitest";
import { resolveAnalyticsPageLocation, resolveAnalyticsPageLocationOrigin } from "../page-location.js";

describe("analytics page location", () => {
  it("uses prod.app in packaged production builds", () => {
    expect(resolveAnalyticsPageLocationOrigin(true)).toBe("memmy://prod.app");
    expect(resolveAnalyticsPageLocation("/main", true)).toBe("memmy://prod.app/main");
  });

  it("uses app in development builds", () => {
    expect(resolveAnalyticsPageLocationOrigin(false)).toBe("memmy://app");
    expect(resolveAnalyticsPageLocation("/welcome", false)).toBe("memmy://app/welcome");
  });
});
