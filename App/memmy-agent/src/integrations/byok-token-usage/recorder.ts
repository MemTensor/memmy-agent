import { randomUUID } from "node:crypto";
import { normalizeByokTokenUsage } from "./normalizer.js";
import type { ByokTokenUsageClient, ByokTokenUsageEvent, ByokUsageActualModelContext, JsonRecord } from "./types.js";

const ACCOUNT_PROVIDER = "memmy_account";

export type ByokTokenUsageRecordInput = {
  usage: Record<string, unknown> | null | undefined;
  sessionKey: string;
  operationId?: string | null;
  chatId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  operation?: string | null;
  metadata?: JsonRecord | null;
  actualModelContext?: ByokUsageActualModelContext | null;
};

export type ByokTokenUsageRecorderOptions = {
  client: ByokTokenUsageClient;
};

export interface ByokTokenUsageRecorderLike {
  recordAgentChatUsage(input: ByokTokenUsageRecordInput): Promise<boolean>;
}

export class ByokTokenUsageRecorder implements ByokTokenUsageRecorderLike {
  private readonly options: ByokTokenUsageRecorderOptions;

  constructor(options: ByokTokenUsageRecorderOptions) {
    this.options = options;
  }

  async recordAgentChatUsage(input: ByokTokenUsageRecordInput): Promise<boolean> {
    try {
      const usage = normalizeByokTokenUsage(input.usage);
      if (!usage) return false;

      const context = input.actualModelContext;
      if (!context || context.source !== "byok") return false;
      const modelId = context.model;
      const provider = context.provider;
      if (!provider || provider === ACCOUNT_PROVIDER) return false;

      const operationId = stringOrNull(input.operationId) ?? randomUUID();
      const event: ByokTokenUsageEvent = {
        id: randomUUID(),
        kind: "agent_chat",
        source: "agent",
        operationId,
        presetId: context.presetId,
        provider,
        model: modelId,
        capability: "agent",
        ...usage,
        metadata: {
          ...(input.metadata ?? {}),
          operation: stringOrNull(input.operation) ?? null,
          sessionKey: input.sessionKey,
          chatId: stringOrNull(input.chatId),
          provider,
          modelId,
        },
        createdAt: new Date().toISOString(),
      };

      await this.options.client.recordEvent(event);
      return true;
    } catch (error) {
      console.error("BYOK token usage recorder failed:", error);
      return false;
    }
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
