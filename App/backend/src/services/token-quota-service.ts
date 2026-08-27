/** Local token quota service that validates the session and delegates to the cloud. */
import type {
  CloudClient,
  TokenQuotaApplyResult,
  TokenQuotaEligibility
} from "../adapters/outbound/cloud-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";

/** Token quota operations used by the settings page. */
export interface TokenQuotaService {
  /** Gets eligibility for the signed-in account. */
  getEligibility(): Promise<TokenQuotaEligibility>;
  /** Submits a request; the cloud performs final validation and concurrency control. */
  requestQuota(input: { reason: string }): Promise<TokenQuotaApplyResult>;
}

/** Dependencies for the local token quota service. */
export interface CreateTokenQuotaServiceOptions {
  /** Client for cloud token quota operations. */
  cloudClient: Pick<CloudClient, "getTokenQuotaEligibility" | "requestTokenQuota">;
  /** Session repository that supplies the current cloud UUID. */
  accountSessionRepository: Pick<AccountSessionRepository, "getCloudUuid">;
}

/** Creates the service without local eligibility caching to avoid stale review state. */
export function createTokenQuotaService(options: CreateTokenQuotaServiceOptions): TokenQuotaService {
  return {
    async getEligibility() {
      const uuid = requireCloudUuid(options.accountSessionRepository);
      return options.cloudClient.getTokenQuotaEligibility({ uuid });
    },

    async requestQuota(input) {
      const uuid = requireCloudUuid(options.accountSessionRepository);
      return options.cloudClient.requestTokenQuota({ uuid, reason: input.reason });
    }
  };
}

/** Returns the current cloud UUID or throws an error understood by the local API. */
function requireCloudUuid(
  repository: Pick<AccountSessionRepository, "getCloudUuid">
): string {
  const uuid = repository.getCloudUuid();
  if (!uuid) {
    throw Object.assign(new Error("Cloud account is not authenticated"), {
      code: "unauthorized" as const
    });
  }
  return uuid;
}
