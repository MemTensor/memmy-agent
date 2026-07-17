/** Use phone auth tests. */
import { describe, expect, it } from "vitest";
import { validateAuthIdentifier } from "../use-phone-auth.js";

describe("usePhoneAuth helpers", () => {
  it("validates phone identifiers before auth requests", () => {
    expect(validateAuthIdentifier("phone", "1538694757")).toEqual({
      ok: false,
      reason: "invalidPhone"
    });
    expect(validateAuthIdentifier("phone", "13800138000")).toEqual({
      ok: true,
      identifier: "13800138000"
    });
  });

  it("validates email identifiers before auth requests", () => {
    expect(validateAuthIdentifier("email", "grace")).toEqual({
      ok: false,
      reason: "invalidEmail"
    });
    expect(validateAuthIdentifier("email", " grace@example.com ")).toEqual({
      ok: true,
      identifier: "grace@example.com"
    });
  });
});
