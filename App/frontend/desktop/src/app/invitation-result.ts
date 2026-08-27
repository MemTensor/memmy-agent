import type { InvitationResult } from "@memmy/local-api-contracts";

export type InvitationToastKind = "success" | "invalid" | "not_new_user";

/** Maps cloud invitation outcomes to the only three user-actionable toast kinds. */
export function resolveInvitationToastKind(
  result: InvitationResult
): InvitationToastKind | null {
  switch (result.status) {
    case "success":
      return "success";
    case "invalid":
      return "invalid";
    case "not_new_user":
      return "not_new_user";
    case "not_provided":
    case "pending":
      return null;
  }
}
