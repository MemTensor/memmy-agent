import type { AccountInvitationView } from "@memmy/local-api-contracts";
import type { AccountClient } from "../api/account-client.js";

let activeInvitationRequest: {
  client: Pick<AccountClient, "getInvitation">;
  accountKey: string;
  promise: Promise<AccountInvitationView>;
} | null = null;

/** Coalesces remount requests while the idempotent invitation request is in flight. */
export function requestAccountInvitation(
  client: Pick<AccountClient, "getInvitation">,
  accountKey: string
): Promise<AccountInvitationView> {
  if (activeInvitationRequest?.client === client && activeInvitationRequest.accountKey === accountKey) {
    return activeInvitationRequest.promise;
  }

  const promise = client.getInvitation();
  activeInvitationRequest = { client, accountKey, promise };
  const clear = () => {
    if (activeInvitationRequest?.promise === promise) activeInvitationRequest = null;
  };
  void promise.then(clear, clear);
  return promise;
}
