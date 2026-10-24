import type { WeChatMessageEvidence } from "./wechat-message-batch.js";

export interface WeChatWindowTextEvidence {
  observationId: string;
  observedAt: string;
  text: string;
  accountFingerprint?: string;
  conversationId?: string;
}

export interface CorrelatedWeChatMessage {
  message: WeChatMessageEvidence;
  windowObservationIds: string[];
}

/**
 * Preserve one database message per canonical ID. A window snapshot can verify
 * it only if exact text and a short time window identify one possible row.
 * Unmatched UI text remains ordinary window evidence, never a new chat message.
 */
export function correlateWeChatWindowEvidence(
  messages: WeChatMessageEvidence[],
  observations: WeChatWindowTextEvidence[],
  maximumSkewMs = 120_000,
): CorrelatedWeChatMessage[] {
  const unique = new Map<string, CorrelatedWeChatMessage>();
  for (const message of messages) {
    if (!unique.has(message.messageId)) {
      unique.set(message.messageId, { message, windowObservationIds: [] });
    }
  }

  for (const observation of observations) {
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt) || !observation.text.trim()) continue;
    const matches = [...unique.values()].filter(({ message }) => (
      message.kind === "text"
      && message.text?.normalize("NFC") === observation.text.normalize("NFC")
      && (!observation.accountFingerprint
        || observation.accountFingerprint === message.accountFingerprint)
      && (!observation.conversationId
        || observation.conversationId === message.conversationId)
      && Math.abs(Date.parse(message.createdAt) - observedAt) <= maximumSkewMs
    ));
    if (matches.length === 1
      && !matches[0].windowObservationIds.includes(observation.observationId)) {
      matches[0].windowObservationIds.push(observation.observationId);
    }
  }
  return [...unique.values()];
}
