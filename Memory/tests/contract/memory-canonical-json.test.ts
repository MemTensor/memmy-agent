import { describe, expect, it } from "vitest";
import {
  MEMORY_CANONICAL_JSON_FIXTURES,
  canonicalJson,
  compareUnicodeCodePoints,
  sha256Hex
} from "../../src/contracts/index.js";

describe("canonical Memory JSON", () => {
  it("sorts object keys by code point while preserving array order", () => {
    for (const fixture of MEMORY_CANONICAL_JSON_FIXTURES) {
      expect(canonicalJson(fixture.input)).toBe(fixture.canonical);
    }
    expect(["😀", "界"].sort(compareUnicodeCodePoints)).toEqual(["界", "😀"]);
    expect(canonicalJson({ nested: { z: 1, a: 2 }, values: [3, 2, 1] })).toBe(
      '{"nested":{"a":2,"z":1},"values":[3,2,1]}'
    );
  });

  it("rejects values that JSON would coerce, omit, or stringify ambiguously", () => {
    expect(() => canonicalJson({ value: Number.NaN } as never)).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: undefined } as never)).toThrow(/non-JSON/);
    expect(() => canonicalJson({ value: 1n } as never)).toThrow(/non-JSON/);
    expect(() => canonicalJson({ value: new Date() } as never)).toThrow(/non-plain/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic as never)).toThrow(/circular/);
  });

  it("provides portable SHA-256 for contract identities", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
