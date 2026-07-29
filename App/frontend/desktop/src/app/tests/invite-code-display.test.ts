import { describe, expect, it } from "vitest";
import { resolveDisplayInviteCode } from "../invite-code-display.js";

describe("resolveDisplayInviteCode", () => {
  it("从邮箱生成稳定的展示用邀请码", () => {
    expect(resolveDisplayInviteCode({ email: "demo@memmy.bot" })).toBe("MEMMY-DEMOOT");
    expect(resolveDisplayInviteCode({ email: "demo@memmy.bot" })).toBe("MEMMY-DEMOOT");
  });

  it("优先使用邮箱，其次手机号", () => {
    expect(resolveDisplayInviteCode({ phoneNumber: "13800138000" })).toBe("MEMMY-138000");
    expect(resolveDisplayInviteCode({ email: "a@b.com", phoneNumber: "13800138000" })).toBe("MEMMY-ABCOOM");
  });
});
