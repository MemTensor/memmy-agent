import type { InboundMessage } from "../runtime-messages/events.js";
import type { GoalRuntime } from "./goal-runtime.js";

export function computerUseRequestContext(message: InboundMessage, turnId?: string | null,
  runtime?: GoalRuntime, sessionKey = message.sessionKey): {
  messageId: string | null; metadata: Record<string, any>;
} {
  const internal = message.internal;
  const goal = internal && runtime?.get(sessionKey);
  const route = internal && runtime?.route(sessionKey);
  // Only a reserved continuation of this active Goal may inherit its accepted user's identity.
  if (internal?.kind === 'goal_continuation' && message.senderId === 'goal-runtime'
    && message.role === 'user' && turnId && runtime?.ownsWorkReservation(sessionKey, turnId)
    && goal?.status === 'active' && goal.goalId === internal.goalId
    && goal.updatedAt === internal.goalUpdatedAt && route?.computerUseMessageId
    && route.channel === message.channel && route.chatId === message.chatId
    && route.source?.kind === message.turnSource?.kind && route.source?.channel === message.turnSource?.channel
    && message.metadata.computerUseInteractive !== false) {
    // A one-time app approval must not carry over to the next automatic turn.
    const messageId = `goal:${goal.goalId}:${turnId}`;
    return { messageId, metadata: { ...message.metadata,
      turnId, turn_id: turnId, message_id: messageId,
      computerUseInteractive: true, computerUseInteractiveReason: 'interactive-user-message',
    } };
  }
  const rawId = message.metadata?.message_id ?? message.metadata?.messageId;
  const nativeId = typeof rawId === 'string' && rawId.trim() && rawId.length <= 512
    ? rawId.trim() : typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : null;
  // GUI source is supplied by the accepted channel boundary, not envelope
  // metadata. Recover an older durable GUI request's validated UUID, retaining
  // its original identity rather than substituting a generated execution turn.
  const source = message.turnSource;
  const guiSource = message.channel === 'websocket' && source?.channel === 'websocket'
    && (source.kind === 'gui' || source.kind === 'tui');
  const requestId = message.metadata?.client_request_id;
  const messageId = nativeId ?? (guiSource && typeof requestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ? requestId : null);
  let reason = 'interactive-user-message';
  if (message.internal || message.role !== 'user') reason = 'internal-message';
  else if (['system', 'cron'].includes(message.channel)
    || ['subagent', 'goal-runtime', 'system', 'cron'].includes(message.senderId.toLowerCase())) reason = 'background-source';
  else if (message.channel === 'websocket' && !guiSource) reason = 'gui-source-unverified';
  else if (message.metadata?.computerUseInteractive === false) reason = 'background-context';
  else if (!messageId) reason = 'user-message-id-missing';
  return { messageId, metadata: { ...message.metadata,
    ...(source ? { turn_source: source } : {}), ...(turnId ? { turnId, turn_id: turnId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    computerUseInteractive: reason === 'interactive-user-message',
    computerUseInteractiveReason: reason,
  } };
}
