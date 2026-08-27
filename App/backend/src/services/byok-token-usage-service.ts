import {
  ByokTokenUsageEventSchema,
  ByokTokenUsageSummarySchema,
  type ByokTokenUsageEvent,
  type ByokTokenUsageSummary
} from "@memmy/local-api-contracts";
import type { ByokTokenUsageRepository } from "../infrastructure/app-state-store/repositories/byok-token-usage-repo.js";

export interface ByokTokenUsageService {
  recordEvent(input: unknown): Promise<void>;
  getSummary(): Promise<ByokTokenUsageSummary>;
}

export interface CreateByokTokenUsageServiceOptions {
  repository: ByokTokenUsageRepository;
}

export function createByokTokenUsageService(
  options: CreateByokTokenUsageServiceOptions
): ByokTokenUsageService {
  return {
    async recordEvent(input) {
      const event: ByokTokenUsageEvent = ByokTokenUsageEventSchema.parse(input);
      options.repository.recordEvent(event);
    },

    async getSummary() {
      return ByokTokenUsageSummarySchema.parse(options.repository.getSummary());
    }
  };
}
