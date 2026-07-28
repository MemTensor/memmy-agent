/** Use phone auth tests. */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/http.js";
import type { MessageKey, MessageValues } from "../../i18n/messages.js";
import { resolveAuthErrorMessage, validateAuthIdentifier } from "../use-phone-auth.js";

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

  it("shows structured cloud business messages for email verification", () => {
    const error = new ApiRequestError("请求过于频繁，请60秒后再试", 429, "rate_limited");

    expect(resolveAuthErrorMessage(error, "email", (key) => `translated:${key}`, "login.sendCodeFailed"))
      .toBe("请求过于频繁，请60秒后再试");
  });

  it("keeps generic messages for phone and internal errors", () => {
    const rateLimitedError = new ApiRequestError("请求过于频繁，请60秒后再试", 429, "rate_limited");
    const internalError = new ApiRequestError("database connection failed", 500, "internal");
    const translate = (key: MessageKey, _values?: MessageValues) => `translated:${key}`;

    expect(resolveAuthErrorMessage(rateLimitedError, "phone", translate, "login.sendCodeFailed"))
      .toBe("translated:login.sendCodeFailed");
    expect(resolveAuthErrorMessage(internalError, "email", translate, "login.sendCodeFailed"))
      .toBe("translated:login.sendCodeFailed");
  });
});
