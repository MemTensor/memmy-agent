import { describe, expect, it, vi } from "vitest";
import {
  buildInvitationSignupEvent,
  buildInvitationToastEvent,
  copyInvitationCode
} from "../invitation-analytics.js";

describe("invitation analytics", () => {
  it("marks a trimmed invitation code as provided on signup", () => {
    expect(buildInvitationSignupEvent({
      channel: "email",
      isNewUser: true,
      invitationCode: " MEMMY-A1B2C3 "
    })).toEqual({
      name: "signup_completed",
      params: {
        method: "email",
        is_new_user: true,
        user_mode: "account",
        invite_code_provided: true
      },
      consentTier: "basic"
    });

    expect(buildInvitationSignupEvent({
      channel: "phone",
      isNewUser: false,
      invitationCode: "   "
    }).params.invite_code_provided).toBe(false);
  });

  it("maps only displayable invitation results to toast events", () => {
    expect(buildInvitationToastEvent("success")).toEqual({
      name: "invite_result_toast",
      params: { result: "success" },
      consentTier: "basic"
    });
    expect(buildInvitationToastEvent("invalid")?.params.result).toBe("invalid");
    expect(buildInvitationToastEvent("not_new_user")?.params.result).toBe("not_new_user");
    expect(buildInvitationToastEvent("pending")).toBeNull();
    expect(buildInvitationToastEvent("not_provided")).toBeNull();
  });

  it("tracks invitation code copy only after the clipboard succeeds", async () => {
    const writeText = vi.fn(async () => undefined);
    const track = vi.fn();

    await copyInvitationCode({
      invitationCode: "MEMMY-A1B2C3",
      clipboard: { writeText },
      track
    });

    expect(writeText).toHaveBeenCalledWith("MEMMY-A1B2C3");
    expect(track).toHaveBeenCalledWith({
      name: "invite_code_copied",
      params: { page_path: "/settings" },
      consentTier: "basic"
    });
  });

  it("does not track invitation code copy when the clipboard rejects", async () => {
    const failure = new Error("clipboard denied");
    const track = vi.fn();

    await expect(copyInvitationCode({
      invitationCode: "MEMMY-A1B2C3",
      clipboard: { writeText: vi.fn(async () => Promise.reject(failure)) },
      track
    })).rejects.toBe(failure);
    expect(track).not.toHaveBeenCalled();
  });
});
