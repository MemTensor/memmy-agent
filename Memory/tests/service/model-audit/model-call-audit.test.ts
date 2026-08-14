import { describe, expect, it } from "vitest";
import { elapsedApiLogMs } from "../../../src/service/model-audit/model-call-audit.js";

describe("model call audit", () => {
  it("keeps positive sub-millisecond durations visible", () => {
    expect(elapsedApiLogMs(10, 10)).toBe(0);
    expect(elapsedApiLogMs(10, 10.01)).toBe(1);
    expect(elapsedApiLogMs(10, 11.01)).toBe(2);
  });
});
