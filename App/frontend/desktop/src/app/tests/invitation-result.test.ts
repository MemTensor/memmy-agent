import { describe, expect, it } from "vitest";
import { resolveInvitationToastKind } from "../invitation-result.js";

describe("resolveInvitationToastKind", () => {
  it("maps only user-actionable terminal invitation results", () => {
    expect(resolveInvitationToastKind({
      status: "success",
      inviteeRewardTokens: 500_000
    })).toBe("success");
    expect(resolveInvitationToastKind({ status: "invalid" })).toBe("invalid");
    expect(resolveInvitationToastKind({ status: "not_new_user" })).toBe("not_new_user");
    expect(resolveInvitationToastKind({ status: "not_provided" })).toBeNull();
    expect(resolveInvitationToastKind({ status: "pending" })).toBeNull();
  });
});
