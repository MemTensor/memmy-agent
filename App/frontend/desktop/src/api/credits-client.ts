import {
  CreditsPlansSchema, CreditsApplicationSchema, type CreditsPlansQuery,
  CreditsSummarySchema, CreditsGrantsPageSchema, CreditsLedgerPageSchema,
  CreditsUsagePageSchema, CreditsUsageDetailSchema, CreditsUsageExportSchema, CreditsUsageDownloadSchema,
  type CreditsUsageQuery, type CreditsUsageExportQuery,
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
    plans: (query: CreditsPlansQuery = {}) => requestJson({ config, path: path("plans", query), schema: CreditsPlansSchema }),
    latestApplication: () => requestJson({ config, path: path("plan-applications/latest"), schema: CreditsApplicationSchema }),
    usage: (query: CreditsUsageQuery = {}, signal?: AbortSignal) => requestJson({ config, init: { signal }, path: path("usage", query), schema: CreditsUsagePageSchema }),
    usageDetail: (callId: string, signal?: AbortSignal) => requestJson({ config, init: { signal }, path: path(`usage/${encodeURIComponent(callId)}`), schema: CreditsUsageDetailSchema }),
    usageExport: (query: CreditsUsageExportQuery, signal?: AbortSignal) => requestJson({ config, init: { signal }, path: path("usage/export", query), schema: CreditsUsageExportSchema }),
    usageDownload: (downloadUrl: string, signal?: AbortSignal) => {
      // Only proxy our signed export route; never fetch a URL supplied by cloud data.
      const url = new URL(downloadUrl, "https://credits.invalid");
      if (url.origin !== "https://credits.invalid" || url.pathname !== "/api/credits/v1/usage/download") throw new Error("Invalid export URL");
      return requestJson({ config, init: { signal }, path: `/api/credits/usage/download${url.search}`, schema: CreditsUsageDownloadSchema });
    },
    summary: (signal?: AbortSignal) => requestJson({ config, init: { signal }, path: path("summary"), schema: CreditsSummarySchema }),
    grants: (query: CreditsGrantsQuery = {}, signal?: AbortSignal) => requestJson({ config, init: { signal }, path: path("grants", query), schema: CreditsGrantsPageSchema }),
    ledger: (query: CreditsLedgerQuery = {}, signal?: AbortSignal) => requestJson({ config, init: { signal }, path: path("ledger", query), schema: CreditsLedgerPageSchema })
  };
}
export type CreditsClient = ReturnType<typeof createHttpCreditsClient>;
