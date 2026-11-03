import {
  CreditsPlansSchema, CreditsApplicationSchema, type CreditsPlansQuery,
  CreditsSummarySchema, CreditsGrantsPageSchema, CreditsLedgerPageSchema,
  CreditsUsagePageSchema, CreditsUsageDetailSchema, CreditsUsageExportSchema, CreditsUsageDownloadSchema,
  type CreditsUsageQuery, type CreditsUsageExportQuery,
  type CreditsGrantsQuery, type CreditsLedgerQuery
} from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/types.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";

export function createCreditsService(cloud: CloudClient, accounts: AccountSessionRepository) {
  async function read(resource: "summary" | "grants" | "ledger" | "plans" | "plan-applications/latest" | "usage" | `usage/${string}`, query?: Record<string, string | number | undefined>) {
    const uuid = accounts.getCloudUuid();
    if (!uuid) throw Object.assign(new Error("Account session is not authenticated"), { code: "unauthorized" });
    const filtered = Object.fromEntries(Object.entries(query ?? {}).filter((entry): entry is [string, string | number] => entry[1] !== undefined));
    const result = await cloud.getCredits({ uuid, resource, query: filtered });
    // A response belonging to the previous account must not appear after account switching.
    if (accounts.getCloudUuid() !== uuid) throw Object.assign(new Error("Account session changed"), { code: "unauthorized" });
    return result;
  }
  return {
    async plans(query: CreditsPlansQuery) { return CreditsPlansSchema.parse(await read("plans", query)); },
    async latestApplication() { return CreditsApplicationSchema.parse(await read("plan-applications/latest")); },
    async usage(query: CreditsUsageQuery) { return CreditsUsagePageSchema.parse(await read("usage", query)); },
    async usageDetail(callId: string) { return CreditsUsageDetailSchema.parse(await read(`usage/${encodeURIComponent(callId)}`)); },
    async usageExport(query: CreditsUsageExportQuery) { return CreditsUsageExportSchema.parse(await read("usage/export", query)); },
    async usageDownload(query: CreditsUsageExportQuery & { token: string }) { return CreditsUsageDownloadSchema.parse(await read("usage/download", query)); },
    async summary() { return CreditsSummarySchema.parse(await read("summary")); },
    async grants(query: CreditsGrantsQuery) { return CreditsGrantsPageSchema.parse(await read("grants", query)); },
    async ledger(query: CreditsLedgerQuery) { return CreditsLedgerPageSchema.parse(await read("ledger", query)); }
  };
}
export type CreditsService = ReturnType<typeof createCreditsService>;
