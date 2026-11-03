import {
  CreditsCheckinSchema, CreditsRedemptionSchema, CreditsInvitationSummarySchema, CreditsInvitationsPageSchema, type CreditsInvitationsQuery,
  CreditsSummarySchema, CreditsGrantsPageSchema, CreditsLedgerPageSchema,
  type RuntimeConfig, type CreditsGrantsQuery, type CreditsLedgerQuery
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export function createHttpCreditsClient(config: RuntimeConfig) {
  function path(resource: string, query: Record<string, string | number | undefined> = {}) {
    const search = new URLSearchParams(Object.entries(query)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]));
    return `/api/credits/${resource}${search.size ? `?${search}` : ""}`;
  }
  return {
    checkin: (requestId: string) => requestJson({ config, path: path("check-ins"), body: { requestId }, schema: CreditsCheckinSchema }),
    redeem: (requestId: string, code: string) => requestJson({ config, path: path("redemptions"), body: { requestId, code }, schema: CreditsRedemptionSchema }),
    invitationSummary: () => requestJson({ config, path: path("invitations/summary"), schema: CreditsInvitationSummarySchema }),
    invitations: (query: CreditsInvitationsQuery = {}) => requestJson({ config, path: path("invitations", query), schema: CreditsInvitationsPageSchema }),
    summary: () => requestJson({ config, path: path("summary"), schema: CreditsSummarySchema }),
    grants: (query: CreditsGrantsQuery = {}) => requestJson({ config, path: path("grants", query), schema: CreditsGrantsPageSchema }),
    ledger: (query: CreditsLedgerQuery = {}) => requestJson({ config, path: path("ledger", query), schema: CreditsLedgerPageSchema })
  };
}
export type CreditsClient = ReturnType<typeof createHttpCreditsClient>;
