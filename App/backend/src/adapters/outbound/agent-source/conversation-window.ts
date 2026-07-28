interface ConversationWindowMessage {
  conversationId: string;
  createdAt: string;
}

/**
 * Buffers one scan target and keeps whole conversations whose latest activity
 * reaches the incremental cursor. This prevents a cursor from cutting off the
 * user message at the beginning of a turn.
 */
export async function collectConversationWindow<T extends ConversationWindowMessage>(
  input: AsyncIterable<T>,
  since?: string,
  signal?: AbortSignal,
  maxMessages?: number
): Promise<T[]> {
  if (maxMessages !== undefined && maxMessages <= 0) return [];
  const messages: T[] = [];
  for await (const message of input) {
    signal?.throwIfAborted();
    messages.push(message);
  }
  const cursor = since ? Date.parse(since) : Number.NaN;
  const eligible = new Set<string>();
  const conversationOrder: string[] = [];
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (!counts.has(message.conversationId)) conversationOrder.push(message.conversationId);
    counts.set(message.conversationId, (counts.get(message.conversationId) ?? 0) + 1);
    const createdAt = Date.parse(message.createdAt);
    if (!since || !Number.isFinite(cursor) || !Number.isFinite(createdAt) || createdAt >= cursor) {
      eligible.add(message.conversationId);
    }
  }

  const included = new Set<string>();
  let selectedCount = 0;
  for (const conversationId of conversationOrder) {
    if (!eligible.has(conversationId)) continue;
    const conversationSize = counts.get(conversationId) ?? 0;
    if (maxMessages !== undefined && included.size > 0 && selectedCount + conversationSize > maxMessages) break;
    included.add(conversationId);
    selectedCount += conversationSize;
  }
  return messages.filter((message) => included.has(message.conversationId));
}

export function remainingMessageCapacity(limit: number | undefined, emitted: number): number | undefined {
  return limit === undefined ? undefined : Math.max(0, limit - emitted);
}
