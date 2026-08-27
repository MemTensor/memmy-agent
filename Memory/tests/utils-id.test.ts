import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/utils/id.js";

describe("stableStringify", () => {
  it("bounds deep and oversized values instead of overflowing the call stack", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 1_000; index += 1) {
      value = { child: value };
    }

    const serialized = stableStringify({
      value,
      long: "x".repeat(21_000),
      wide: Array.from({ length: 1_010 }, (_, index) => index)
    });

    expect(serialized).toContain("[stable-stringify:object-depth-limit]");
    expect(serialized).toContain("[stable-stringify:string-truncated:1000]");
    expect(serialized).toContain("[stable-stringify:array-truncated:10]");
  });
});
