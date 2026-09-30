/** Hook revision tests. */
import { describe, expect, it } from "vitest";
import { hookRevision } from "./hook-revision.js";

describe("hook revision", () => {
  it("changes when the hook script or workspace bridge changes", () => {
    const current = hookRevision("hook script", "workspace bridge");

    expect(hookRevision("hook script", "workspace bridge")).toBe(current);
    expect(hookRevision("updated hook script", "workspace bridge")).not.toBe(current);
    expect(hookRevision("hook script", "updated workspace bridge")).not.toBe(current);
  });
});
