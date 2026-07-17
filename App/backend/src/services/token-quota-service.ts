/** Token quota service module. */
import type { CloudClient, TokenQuotaApplyResult } from "../adapters/outbound/cloud-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";

const DEFAULT_PENDING_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface TokenQuotaService {
  requestQuota(input: { reason: string }): Promise<TokenQuotaApplyResult>;
}

export interface CreateTokenQuotaServiceOptions {
  cloudClient: Pick<CloudClient, "requestTokenQuota">;
  accountSessionRepository: Pick<AccountSessionRepository, "getCloudUuid">;
  pendingRequestTtlMs?: number;
}

interface PendingQuotaRequest {
  result: TokenQuotaApplyResult;
  createdAt: number;
}

export function createTokenQuotaService(options: CreateTokenQuotaServiceOptions): TokenQuotaService {
  const pendingByUuid = new Map<string, PendingQuotaRequest>();
  const pendingRequestTtlMs = options.pendingRequestTtlMs ?? DEFAULT_PENDING_REQUEST_TTL_MS;

  return {
    async requestQuota(input) {
      const uuid = options.accountSessionRepository.getCloudUuid();
      if (!uuid) {
        throw Object.assign(new Error("Cloud account is not authenticated"), { code: "unauthorized" as const });
      }

      const existingPending = pendingByUuid.get(uuid);
      if (existingPending?.result.status === "pending" && Date.now() - existingPending.createdAt < pendingRequestTtlMs) {
        return existingPending.result;
      }
      pendingByUuid.delete(uuid);

      const result = await options.cloudClient.requestTokenQuota({ uuid, reason: input.reason });
      if (result.status === "pending") {
        pendingByUuid.set(uuid, { result, createdAt: Date.now() });
      } else {
        pendingByUuid.delete(uuid);
      }
      return result;
    }
  };
}
