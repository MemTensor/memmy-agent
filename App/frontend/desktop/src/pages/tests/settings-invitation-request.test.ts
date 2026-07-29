import { describe, expect, it, vi } from "vitest";
import { requestAccountInvitation } from "../settings-page.js";

describe("requestAccountInvitation", () => {
  it("merges duplicate in-flight requests and allows a later refresh", async () => {
    const response = {
      enabled: true,
      invitationCode: "MEMMY-A1B2C3",
      usedInviteSlotsToday: 3,
      dailySuccessLimit: 5,
      remainingInvitesToday: 2,
      dailyLimitReached: false
    };
    const getInvitation = vi.fn(async () => response);
    const client = { getInvitation };

    await Promise.all([
      requestAccountInvitation(client, "account-1"),
      requestAccountInvitation(client, "account-1")
    ]);
    expect(getInvitation).toHaveBeenCalledTimes(1);

    await requestAccountInvitation(client, "account-1");
    expect(getInvitation).toHaveBeenCalledTimes(2);
  });
});
